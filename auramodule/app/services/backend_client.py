
import asyncio
import logging
import httpx
import platform
import time
from typing import Optional, Callable, Any, Dict, List
from app.core.config import settings

logger = logging.getLogger(__name__)


#------This Class handles the Backend Client----------
class BackendClient:

    def __init__(self, patient_uid: str):
        self.patient_uid = patient_uid
        self.registered = False
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._http_client: Optional[httpx.AsyncClient] = None
        self._last_heartbeat_time: Optional[float] = None
        self._heartbeat_failures: int = 0
        self._max_heartbeat_failures: int = 3
        self._retry_count: int = 3
        self._on_reconnect_callback: Optional[Callable[[], Any]] = None
        self._is_reconnecting: bool = False

    def _auth_headers(self) -> dict:
        token = (settings.backend_auth_token or "").strip()
        if not token:
            return {}
        return {"Authorization": f"Bearer {token}"}

    def _endpoint(self, authed_path: str, module_path: str) -> str:
        if (settings.backend_auth_token or "").strip():
            return f"{settings.backend_url}{authed_path}"
        return f"{settings.backend_url}{module_path}"

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    connect=settings.backend_timeout,
                    read=settings.backend_timeout,
                    write=settings.backend_timeout,
                    pool=5.0,
                ),
                limits=httpx.Limits(
                    max_keepalive_connections=5,
                    max_connections=10,
                    keepalive_expiry=30.0,
                ),
            )
        return self._http_client

    async def close(self):
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()
            self._http_client = None

    def set_reconnect_callback(self, callback: Callable[[], Any]):
        self._on_reconnect_callback = callback

    async def register(self, ip: str, port: int) -> bool:
        hardware_info = {
            "platform": platform.system(),
            "processor": platform.processor(),
            "python_version": platform.python_version(),
        }

        max_retries = settings.backend_max_retries
        base_delay = settings.backend_retry_delay
        max_delay = 60.0  

        for attempt in range(max_retries):
            try:
                client = await self._get_client()
                response = await client.post(
                    self._endpoint("/aura/register", "/aura/device/register"),
                    json={
                        "patient_uid": self.patient_uid,
                        "ip": ip,
                        "port": port,
                        "hardware_info": hardware_info,
                    },
                    headers=self._auth_headers(),
                )

                if response.status_code == 200:
                    logger.info(
                        f"Successfully registered with backend: {response.json()}"
                    )
                    self.registered = True
                    self._heartbeat_failures = 0
                    return True
                elif response.status_code == 401:
                    logger.error(
                        f"Authentication failed during registration. Check patient_uid."
                    )
                    
                    return False
                elif response.status_code == 404:
                    logger.error(
                        f"Registration endpoint not found. Check backend_url."
                    )
                    return False
                else:
                    logger.warning(
                        f"Backend returned {response.status_code}: {response.text}"
                    )

            except httpx.ConnectError:
                logger.warning(
                    f"Cannot reach backend at {settings.backend_url} "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
            except httpx.TimeoutException:
                logger.warning(
                    f"Timeout connecting to backend "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
            except Exception as e:
                logger.error(f"Registration error: {type(e).__name__}: {e}")

            if attempt < max_retries - 1:
                
                delay = min(base_delay * (2 ** attempt), max_delay)
                logger.info(f"Retrying in {delay:.1f}s...")
                await asyncio.sleep(delay)

        logger.error("Failed to register with backend after multiple attempts")
        return False

    async def start_heartbeat(self):
        if self._heartbeat_task:
            return

        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("Heartbeat task started")

    async def stop_heartbeat(self):
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None
            logger.info("Heartbeat task stopped")
        
        
        await self.close()

    async def _heartbeat_loop(self):
        while True:
            try:
                await asyncio.sleep(settings.heartbeat_interval)

                success = await self._send_heartbeat()
                
                if success:
                    self._heartbeat_failures = 0
                    self._last_heartbeat_time = time.time()
                    
                    
                    if self._is_reconnecting:
                        self._is_reconnecting = False
                        logger.info("[HEARTBEAT] Backend connection recovered")
                        if self._on_reconnect_callback:
                            try:
                                await self._on_reconnect_callback()
                            except Exception as e:
                                logger.error(f"Reconnect callback error: {e}")
                else:
                    self._heartbeat_failures += 1
                    logger.warning(
                        f"[HEARTBEAT] Failure count: {self._heartbeat_failures}/"
                        f"{self._max_heartbeat_failures}"
                    )
                    
                    
                    if self._heartbeat_failures >= self._max_heartbeat_failures:
                        await self._handle_backend_disconnect()

            except asyncio.CancelledError:
                logger.info("Heartbeat loop cancelled")
                break
            except Exception as e:
                logger.error(f"Heartbeat loop error: {e}")
                

    async def _send_heartbeat(self) -> bool:
        try:
            client = await self._get_client()
            response = await client.post(
                self._endpoint("/aura/heartbeat", "/aura/device/heartbeat"),
                json={"patient_uid": self.patient_uid},
                headers=self._auth_headers(),
            )

            if response.status_code == 200:
                logger.debug("Heartbeat sent successfully")
                return True
            elif response.status_code == 401:
                logger.warning("Heartbeat auth failed - patient may need to re-authenticate")
                return False
            elif response.status_code == 404:
                logger.warning("Heartbeat endpoint not found - module may need to re-register")
                self.registered = False
                return False
            else:
                logger.warning(f"Heartbeat failed: {response.status_code}")
                return False

        except httpx.ConnectError:
            logger.warning(f"Cannot connect to backend at {settings.backend_url}")
            return False
        except httpx.TimeoutException:
            logger.warning("Heartbeat timeout")
            return False
        except Exception as e:
            logger.error(f"Heartbeat error: {type(e).__name__}: {e}")
            return False

    async def _handle_backend_disconnect(self):
        if self._is_reconnecting:
            return  
            
        self._is_reconnecting = True
        self.registered = False
        logger.warning("[HEARTBEAT] Backend appears disconnected, attempting re-registration...")
        
        
        from app.services.discovery import _get_local_ip
        local_ip = _get_local_ip()
        
        
        success = await self.register(local_ip, settings.http_port)
        
        if success:
            logger.info("[HEARTBEAT] Re-registration successful")
        else:
            logger.error("[HEARTBEAT] Re-registration failed, will retry on next heartbeat")

    async def log_event(self, event_type: str, data: dict) -> bool:
        """Log an event to the backend with retry and exponential backoff."""
        max_retries = 3
        base_delay = 1.0
        max_delay = 10.0
        
        for attempt in range(max_retries):
            try:
                client = await self._get_client()
                response = await client.post(
                    self._endpoint("/aura/log_event", "/aura/device/log_event"),
                    json={
                        "patient_uid": self.patient_uid,
                        "event_type": event_type,
                        "data": data,
                    },
                    headers=self._auth_headers(),
                )

                if response.status_code == 200:
                    logger.debug(f"Event logged: {event_type}")
                    return True
                elif response.status_code in (401, 403):
                    logger.warning(f"Auth error logging event: {response.status_code}")
                    return False
                elif response.status_code >= 500:
                    logger.warning(f"Server error logging event: {response.status_code}")
                else:
                    logger.warning(f"Failed to log event: {response.status_code}")
                    return False

            except httpx.ConnectError as e:
                logger.warning(f"Cannot connect to backend for event logging (attempt {attempt + 1}/{max_retries}): {e}")
            except httpx.TimeoutException as e:
                logger.warning(f"Timeout logging event (attempt {attempt + 1}/{max_retries}): {e}")
            except Exception as e:
                logger.error(f"Error logging event: {type(e).__name__}: {e}")
                return False
            
            if attempt < max_retries - 1:
                delay = min(base_delay * (2 ** attempt), max_delay)
                logger.info(f"Retrying log_event in {delay:.1f}s (attempt {attempt + 2}/{max_retries})...")
                await asyncio.sleep(delay)
        
        logger.error(f"Failed to log event after {max_retries} attempts: {event_type}")
        return False

    def get_status(self) -> dict:
        return {
            "patient_uid": self.patient_uid[:8] + "..." if self.patient_uid else None,
            "registered": self.registered,
            "last_heartbeat": self._last_heartbeat_time,
            "heartbeat_failures": self._heartbeat_failures,
            "is_reconnecting": self._is_reconnecting,
        }

    #------This Function chats with Orito via the backend NVIDIA AI endpoint---------
    async def chat_with_orito(
        self,
        user_message: str,
        conversation_history: Optional[List[Dict]] = None,
        on_token: Optional[Callable[[str], None]] = None,
        stream: bool = True,
    ) -> Dict:
        """Send a message to the backend Orito AI and return the response.
        If on_token is provided and stream=True, tokens are streamed via callback."""
        import json as _json

        token = (settings.backend_auth_token or "").strip()
        if not token:
            logger.warning("[ORITO] No auth token configured, cannot call backend AI")
            return {"success": False, "error": "No auth token configured", "content": ""}

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        payload: Dict = {"user_message": user_message}
        if conversation_history:
            payload["messages"] = conversation_history

        full_response = ""

        try:
            client = await self._get_client()

            if stream and on_token is not None:
                headers["Accept"] = "text/event-stream"
                async with client.stream(
                    "POST",
                    f"{settings.backend_url}/orito/chat/stream",
                    json=payload,
                    headers=headers,
                    timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
                ) as resp:
                    if resp.status_code != 200:
                        error_text = await resp.aread()
                        logger.warning(f"[ORITO] Stream failed: {resp.status_code} {error_text[:200]}")
                        return {"success": False, "error": f"HTTP {resp.status_code}", "content": ""}

                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if not raw:
                            continue
                        try:
                            chunk = _json.loads(raw)
                        except _json.JSONDecodeError:
                            continue

                        if "token" in chunk:
                            token_text = chunk["token"]
                            full_response += token_text
                            on_token(token_text)
                        elif chunk.get("done"):
                            break
            else:
                resp = await client.post(
                    f"{settings.backend_url}/orito/chat",
                    json=payload,
                    headers=headers,
                    timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=5.0),
                )
                if resp.status_code != 200:
                    logger.warning(f"[ORITO] Chat failed: {resp.status_code}")
                    return {"success": False, "error": f"HTTP {resp.status_code}", "content": ""}
                data = resp.json()
                full_response = data.get("message", {}).get("content", "")

            return {"success": True, "content": full_response}

        except httpx.ConnectError:
            logger.warning(f"[ORITO] Cannot connect to backend at {settings.backend_url}")
            return {"success": False, "error": "Cannot connect to backend", "content": ""}
        except httpx.TimeoutException:
            logger.warning("[ORITO] Chat request timed out")
            return {"success": False, "error": "Request timed out", "content": ""}
        except Exception as e:
            logger.error(f"[ORITO] Chat error: {type(e).__name__}: {e}")
            return {"success": False, "error": str(e), "content": ""}



_backend_client: Optional[BackendClient] = None


def get_backend_client() -> BackendClient:
    if _backend_client is None:
        raise RuntimeError("Backend client not initialized. Call init_backend_client first.")
    return _backend_client


def init_backend_client(patient_uid: str) -> BackendClient:
    global _backend_client
    _backend_client = BackendClient(patient_uid)
    return _backend_client
