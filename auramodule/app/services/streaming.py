
import asyncio
import json
import logging
import time
from typing import Optional, List, Dict, Any, Callable, AsyncGenerator
from collections import deque
from app.core.config import settings

logger = logging.getLogger(__name__)


#------This Class handles Voice Activity Detection---------
class VoiceActivityDetector:
    def __init__(self, energy_threshold: float = 0.02, min_speech_duration: float = 0.3):
        self.energy_threshold = energy_threshold
        self.min_speech_duration = min_speech_duration
        self.is_speaking = False
        self.speech_start_time: Optional[float] = None
        self.silence_duration = 0.0
        self.speech_buffer: List[float] = []
    
    #------This Function checks if audio chunk contains speech---------
    def detect_speech(self, audio_chunk: bytes) -> bool:
        import numpy as np
        
        try:
            audio_data = np.frombuffer(audio_chunk, dtype=np.int16)
            audio_float = audio_data.astype(np.float32) / 32768.0
            
            energy = np.sqrt(np.mean(audio_float ** 2))
            
            if energy > self.energy_threshold:
                if not self.is_speaking:
                    self.is_speaking = True
                    self.speech_start_time = time.time()
                self.speech_buffer.append(energy)
                self.silence_duration = 0.0
                return True
            else:
                if self.is_speaking:
                    self.silence_duration += len(audio_chunk) / 16000.0
                    
                    if self.silence_duration > 0.5:
                        speech_duration = time.time() - self.speech_start_time if self.speech_start_time else 0
                        if speech_duration >= self.min_speech_duration:
                            self.is_speaking = False
                            self.speech_start_time = None
                            return False
                return False
        except Exception as e:
            logger.warning(f"[VAD] Detection error: {e}")
            return True
    
    #------This Function resets the VAD state---------
    def reset(self):
        self.is_speaking = False
        self.speech_start_time = None
        self.silence_duration = 0.0
        self.speech_buffer = []


#------This Class handles the Audio Buffer for Streaming---------
class AudioBuffer:
    def __init__(self, max_seconds: int = 30):
        self.max_seconds = max_seconds
        self.max_samples = max_seconds * 16000
        self.buffer: deque = deque(maxlen=self.max_samples)
        self.timestamps: deque = deque(maxlen=100)
    
    #------This Function adds audio data to buffer---------
    def append(self, audio_data: bytes, timestamp: Optional[float] = None):
        self.buffer.extend(audio_data)
        
        if timestamp:
            self.timestamps.append({
                "timestamp": timestamp,
                "position": len(self.buffer)
            })
    
    #------This Function gets audio data from buffer---------
    def get_audio(self, start_seconds: float = 0) -> Optional[bytes]:
        if not self.buffer:
            return None
        
        start_sample = int(start_seconds * 16000)
        if start_sample >= len(self.buffer):
            return None
        
        audio_slice = list(self.buffer)[start_sample:]
        return bytes(audio_slice)
    
    #------This Function clears the buffer---------
    def clear(self):
        self.buffer.clear()
        self.timestamps.clear()
    
    #------This Function gets buffer duration in seconds---------
    def duration(self) -> float:
        return len(self.buffer) / 16000.0


#------This Class handles the Streaming Service---------
class StreamingService:
    def __init__(
        self,
        backend_url: str,
        patient_uid: str,
        auth_token: str = "",
        on_transcription: Optional[Callable[[str], None]] = None,
    ):
        self.backend_url = backend_url
        self.patient_uid = patient_uid
        self.auth_token = auth_token
        self.on_transcription = on_transcription
        
        self.vad = VoiceActivityDetector() if settings.enable_vad else None
        self.audio_buffer = AudioBuffer(max_seconds=settings.audio_buffer_seconds)
        
        self.is_streaming = False
        self.is_recording = False
        self._stream_task: Optional[asyncio.Task] = None
        self._connection_ok = False
    
    #------This Function starts the streaming service---------
    async def start_streaming(self):
        if self.is_streaming:
            logger.warning("[STREAM] Already streaming")
            return
        
        self.is_streaming = True
        self._stream_task = asyncio.create_task(self._stream_loop())
        logger.info("[STREAM] Streaming service started")
    
    #------This Function stops the streaming service---------
    async def stop_streaming(self):
        self.is_streaming = False
        
        if self._stream_task and not self._stream_task.done():
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
        
        logger.info("[STREAM] Streaming service stopped")
    
    #------This Function checks backend connection---------
    async def _check_connection(self) -> bool:
        import httpx
        
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.backend_url}/health")
                self._connection_ok = response.status_code == 200
                return self._connection_ok
        except Exception as e:
            logger.debug(f"[STREAM] Connection check failed: {e}")
            self._connection_ok = False
            return False
    
    #------This Function sends audio stream to backend---------
    async def _send_audio_stream(self, audio_data: bytes) -> bool:
        import httpx
        
        try:
            headers = {"Content-Type": "application/octet-stream"}
            if self.auth_token:
                headers["Authorization"] = f"Bearer {self.auth_token}"
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.backend_url}/aura/stream/audio",
                    headers=headers,
                    content=audio_data,
                    params={
                        "patient_uid": self.patient_uid,
                        "timestamp": time.time(),
                    }
                )
                return response.status_code == 200
        except Exception as e:
            logger.debug(f"[STREAM] Send failed: {e}")
            return False
    
    #------This Function receives transcription from backend---------
    async def _receive_transcription(self) -> AsyncGenerator[Dict[str, Any], None]:
        import httpx
        
        try:
            headers = {}
            if self.auth_token:
                headers["Authorization"] = f"Bearer {self.auth_token}"
            
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream(
                    "GET",
                    f"{self.backend_url}/aura/stream/transcribe",
                    headers=headers,
                    params={"patient_uid": self.patient_uid},
                ) as response:
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            data = json.loads(line)
                            yield data
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            logger.error(f"[STREAM] Transcription stream error: {e}")
            yield {"type": "error", "message": str(e)}
    
    #------This Function handles the main streaming loop---------
    async def _stream_loop(self):
        logger.info("[STREAM] Stream loop started")
        
        while self.is_streaming:
            if not await self._check_connection():
                logger.debug("[STREAM] Backend not available, waiting...")
                await asyncio.sleep(5)
                continue
            
            if self.is_recording and self.audio_buffer:
                audio_data = self.audio_buffer.get_audio()
                if audio_data:
                    await self._send_audio_stream(audio_data)
            
            await asyncio.sleep(0.1)
        
        logger.info("[STREAM] Stream loop ended")
    
    #------This Function processes incoming audio---------
    async def process_audio(self, audio_chunk: bytes) -> bool:
        if not self.is_streaming:
            return False
        
        if self.vad:
            has_speech = self.vad.detect_speech(audio_chunk)
            if not has_speech:
                return False
        
        self.audio_buffer.append(audio_chunk, timestamp=time.time())
        self.is_recording = True
        
        return True
    
    #------This Function gets streaming status---------
    def get_status(self) -> Dict[str, Any]:
        return {
            "streaming": self.is_streaming,
            "recording": self.is_recording,
            "connected": self._connection_ok,
            "buffer_duration": self.audio_buffer.duration(),
            "vad_enabled": self.vad is not None,
            "vad_speaking": self.vad.is_speaking if self.vad else False,
        }


#------This Function creates a streaming service instance---------
def create_streaming_service(
    backend_url: str,
    patient_uid: str,
    auth_token: str = "",
    on_transcription: Optional[Callable[[str], None]] = None,
) -> StreamingService:
    return StreamingService(
        backend_url=backend_url,
        patient_uid=patient_uid,
        auth_token=auth_token,
        on_transcription=on_transcription,
    )
