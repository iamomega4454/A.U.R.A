
import json
import logging
import httpx
import asyncio
from datetime import datetime
from typing import Optional, List, Dict, Any, AsyncGenerator, Callable
from app.core.config import settings

logger = logging.getLogger(__name__)


OLLAMA_TIMEOUT = 120.0
STREAM_TIMEOUT = 180.0
BACKEND_TIMEOUT = 15.0

MAX_RETRIES = 3
INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 16.0


SUMMARIZATION_PROMPT = """You are a helpful AI that creates concise journal summaries from conversation transcripts. 
Create a coherent paragraph (2-4 sentences) that captures:
1. Key topics discussed
2. Important information shared
3. Any emotions or notable moments
4. Overall tone of the conversation

Keep it natural and readable, like a personal journal entry. Do not use bullet points or lists."""

EXTRACTION_PROMPT = """You are an event extraction engine for an Alzheimer's patient assistive app called AURA. Analyze this conversation transcript and extract structured information.

Current system time: {system_time}

Return ONLY a valid JSON object with these fields:
- events: list of objects with {{description, datetime (natural language like "tomorrow at 3pm"), person (if known, else null), type}} — any appointments, events, or plans mentioned
- key_info: list of objects with {{fact, person (if known, else null)}} — important information shared (names, places, facts)
- reminders: list of objects with {{description, datetime (natural language if time-bound, else null)}} — action items or reminders
- mood: string — overall mood of the conversation (e.g. "happy", "confused", "anxious", "neutral", "sad", "angry")
- summary: string — one-line summary of the conversation

Important: For datetime fields, use natural language expressions like "tomorrow at 3pm", "next Monday", "in 2 hours", etc. The system will parse these automatically.

If no items exist for a field, use an empty list. Always return valid JSON."""


def parse_datetime_from_text(text: str) -> Optional[datetime]:
    if not text:
        return None

    try:
        import dateparser
        settings_dict = {
            "PREFER_DATES_FROM": "future",
            "RELATIVE_BASE": datetime.utcnow(),
            "RETURN_AS_TIMEZONE_AWARE": False,
        }
        return dateparser.parse(text, settings=settings_dict)
    except ImportError:
        logger.warning("[CONV] dateparser not installed, datetime parsing disabled")
        return None
    except Exception as e:
        logger.debug(f"[CONV] Failed to parse datetime '{text}': {e}")
        return None


def validate_transcript(transcript: str) -> tuple[bool, Optional[str]]:
    if not transcript:
        return False, "Transcript is empty"
    
    if not isinstance(transcript, str):
        return False, f"Transcript must be a string, got {type(transcript).__name__}"
    
    
    if len(transcript.strip()) < 3:
        return False, "Transcript is too short"
    
    
    max_length = 100000  
    if len(transcript) > max_length:
        return False, f"Transcript too long ({len(transcript)} chars, max {max_length})"
    
    return True, None


async def call_ollama(
    prompt: str,
    content: str,
    timeout: float = OLLAMA_TIMEOUT,
    max_retries: int = 2,
) -> tuple[Optional[Dict], Optional[str]]:
    for attempt in range(max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{settings.ollama_url}/api/chat",
                    json={
                        "model": settings.ollama_model,
                        "messages": [
                            {"role": "system", "content": prompt},
                            {"role": "user", "content": content},
                        ],
                        "format": "json",
                        "stream": False,
                        "options": {
                            "temperature": 0.3,
                            "num_predict": 1024,
                        },
                    },
                )

                if resp.status_code == 200:
                    data = resp.json()
                    return data, None
                elif resp.status_code == 404:
                    return None, f"Model '{settings.ollama_model}' not found in Ollama"
                else:
                    return None, f"Ollama returned status {resp.status_code}"

        except httpx.ConnectError:
            error_msg = f"Cannot connect to Ollama at {settings.ollama_url}"
            if attempt < max_retries:
                logger.warning(f"[CONV] {error_msg}, retrying...")
                continue
            return None, error_msg
            
        except httpx.TimeoutException:
            error_msg = f"Ollama request timed out after {timeout}s"
            if attempt < max_retries:
                logger.warning(f"[CONV] {error_msg}, retrying...")
                continue
            return None, error_msg
            
        except json.JSONDecodeError as e:
            return None, f"Invalid JSON from Ollama: {e}"
            
        except Exception as e:
            return None, f"Ollama error: {type(e).__name__}: {e}"
    
    return None, "Max retries exceeded"


#------This Function handles the Exponential Backoff for retries---------
async def _exponential_backoff(attempt: int, base_delay: float = INITIAL_BACKOFF) -> None:
    delay = min(base_delay * (2 ** attempt), MAX_BACKOFF)
    jitter = delay * 0.1
    await asyncio.sleep(delay + jitter)


#------This Function streams Ollama response with real-time token-by-token output---------
async def stream_ollama_response(
    prompt: str,
    content: str,
    context: Optional[Dict[str, Any]] = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
) -> AsyncGenerator[Dict[str, Any], None]:
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": content},
    ]
    
    if context and context.get("conversation_history"):
        for msg in context["conversation_history"][-10:]:
            messages.insert(1, msg)
    
    tools = None
    if context and context.get("enable_tools"):
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get current weather for a location",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string", "description": "City name"},
                        },
                        "required": ["location"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_time",
                    "description": "Get current time for a timezone",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "timezone": {"type": "string", "description": " timezone (e.g., UTC, America/New_York)"},
                        },
                        "required": ["timezone"],
                    },
                },
            },
        ]
    
    for attempt in range(MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=STREAM_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    f"{settings.ollama_url}/api/chat",
                    json={
                        "model": settings.ollama_model,
                        "messages": messages,
                        "stream": True,
                        "options": {
                            "temperature": temperature,
                            "num_predict": max_tokens,
                        },
                        "tools": tools,
                    },
                ) as resp:
                    if resp.status_code != 200:
                        error_msg = f"Ollama returned status {resp.status_code}"
                        if resp.status_code == 404:
                            error_msg = f"Model '{settings.ollama_model}' not found in Ollama"
                        yield {"type": "error", "message": error_msg}
                        return
                    
                    full_content = ""
                    tool_calls = []
                    
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        
                        msg_type = data.get("done", False)
                        
                        if msg_type:
                            yield {
                                "type": "done",
                                "content": full_content,
                                "tool_calls": tool_calls if tool_calls else None,
                            }
                            return
                        
                        message = data.get("message", {})
                        role = message.get("role", "")
                        
                        if role == "assistant":
                            token = message.get("content", "")
                            if token:
                                full_content += token
                                yield {"type": "token", "content": token}
                            
                            tc = message.get("tool_calls", [])
                            if tc:
                                for call in tc:
                                    tool_calls.append(call)
                                    yield {
                                        "type": "tool_call",
                                        "function": call.get("function", {}).get("name", ""),
                                        "arguments": call.get("function", {}).get("arguments", {}),
                                    }

        except httpx.ConnectError as e:
            error_msg = f"Cannot connect to Ollama at {settings.ollama_url}"
            logger.warning(f"[CONV-STREAM] {error_msg}, attempt {attempt + 1}/{MAX_RETRIES + 1}")
            if attempt < MAX_RETRIES:
                await _exponential_backoff(attempt)
                continue
            yield {"type": "error", "message": error_msg}
            return
            
        except httpx.TimeoutException as e:
            error_msg = f"Ollama streaming request timed out after {STREAM_TIMEOUT}s"
            logger.warning(f"[CONV-STREAM] {error_msg}, attempt {attempt + 1}/{MAX_RETRIES + 1}")
            if attempt < MAX_RETRIES:
                await _exponential_backoff(attempt)
                continue
            yield {"type": "error", "message": error_msg}
            return
            
        except Exception as e:
            error_msg = f"Ollama streaming error: {type(e).__name__}: {e}"
            logger.error(f"[CONV-STREAM] {error_msg}")
            yield {"type": "error", "message": error_msg}
            return
    
    yield {"type": "error", "message": "Max retries exceeded"}


#------This Function handles the Streaming Chat with context---------
async def streaming_chat(
    user_message: str,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    enable_tools: bool = False,
    on_token: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    system_prompt = """You are AURA, a helpful AI assistant designed to help patients with daily tasks and reminders.
Be concise, friendly, and empathetic. Always prioritize patient safety and wellbeing.
If you don't know something, admit it honestly rather than making up information."""
    
    context = {
        "conversation_history": conversation_history or [],
        "enable_tools": enable_tools,
    }
    
    full_response = ""
    tool_calls = []
    
    try:
        async for chunk in stream_ollama_response(
            prompt=system_prompt,
            content=user_message,
            context=context,
            temperature=0.7,
            max_tokens=1024,
        ):
            chunk_type = chunk.get("type")
            
            if chunk_type == "token":
                token = chunk.get("content", "")
                full_response += token
                if on_token:
                    on_token(token)
                    
            elif chunk_type == "tool_call":
                tool_calls.append({
                    "function": chunk.get("function", ""),
                    "arguments": chunk.get("arguments", {}),
                })
                
            elif chunk_type == "done":
                return {
                    "success": True,
                    "content": full_response,
                    "tool_calls": tool_calls if tool_calls else None,
                    "finish_reason": "stop",
                }
                
            elif chunk_type == "error":
                return {
                    "success": False,
                    "error": chunk.get("message", "Unknown error"),
                    "content": full_response,
                }
    
    except Exception as e:
        logger.error(f"[CONV] Streaming chat error: {e}")
        return {
            "success": False,
            "error": str(e),
            "content": full_response,
        }
    
    return {
        "success": True,
        "content": full_response,
        "tool_calls": tool_calls if tool_calls else None,
    }


async def analyze_conversation(
    transcript: str,
    speakers: List[Dict[str, Any]],
    patient_uid: str,
    auth_token: str = "",
) -> Dict[str, Any]:
    
    is_valid, error = validate_transcript(transcript)
    if not is_valid:
        logger.warning(f"[CONV] Invalid transcript: {error}")
        return _empty_result()

    
    speaker_text = ""
    if speakers:
        for seg in speakers:
            speaker_text += f"[{seg.get('speaker', 'Unknown')}] "
    full_input = speaker_text + transcript if speaker_text else transcript

    
    system_time = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    prompt_with_time = EXTRACTION_PROMPT.format(system_time=system_time)

    logger.info(f"[CONV] Analyzing transcript ({len(transcript)} chars)...")
    
    
    data, error = await call_ollama(prompt_with_time, full_input)
    
    if error:
        logger.warning(f"[CONV] Ollama error: {error}")
        return _empty_result()
    
    if not data:
        logger.warning("[CONV] No response from Ollama")
        return _empty_result()

    
    try:
        content = data.get("message", {}).get("content", "")
        if not content:
            logger.warning("[CONV] Empty content from Ollama")
            return _empty_result()
            
        extracted = json.loads(content)
        
    except json.JSONDecodeError as e:
        logger.warning(f"[CONV] Failed to parse Ollama response as JSON: {e}")
        
        content = data.get("message", {}).get("content", "")
        return {
            **_empty_result(),
            "summary": content[:200] if content else "Failed to analyze",
        }
    
    
    extracted = {
        "events": extracted.get("events", []),
        "key_info": extracted.get("key_info", []),
        "reminders": extracted.get("reminders", []),
        "mood": extracted.get("mood", ""),
        "summary": extracted.get("summary", ""),
    }

    
    for event in extracted.get("events", []):
        if "datetime" in event and event["datetime"]:
            parsed_dt = parse_datetime_from_text(event["datetime"])
            if parsed_dt:
                event["datetime_parsed"] = parsed_dt.isoformat()

    for reminder in extracted.get("reminders", []):
        if "datetime" in reminder and reminder["datetime"]:
            parsed_dt = parse_datetime_from_text(reminder["datetime"])
            if parsed_dt:
                reminder["datetime_parsed"] = parsed_dt.isoformat()

    logger.info(
        f"[CONV] Analysis complete: {len(extracted['events'])} events, "
        f"{len(extracted['key_info'])} key info, "
        f"{len(extracted['reminders'])} reminders, mood={extracted['mood']}"
    )

    
    if patient_uid:
        try:
            await _store_journal(transcript, speakers, extracted, patient_uid, auth_token)
        except Exception as e:
            logger.warning(f"[CONV] Failed to store journal: {e}")
    
    return extracted


def _empty_result() -> Dict[str, Any]:
    return {
        "events": [],
        "key_info": [],
        "reminders": [],
        "mood": "",
        "summary": "",
    }


async def _store_journal(
    transcript: str,
    speakers: List[Dict[str, Any]],
    extracted: Dict[str, Any],
    patient_uid: str,
    auth_token: str,
) -> bool:
    if not patient_uid:
        logger.warning("[CONV] Cannot store journal: missing patient_uid")
        return False
    
    
    event_datetime_text = None
    for event in extracted.get("events", []):
        if event.get("datetime"):
            event_datetime_text = event["datetime"]
            break

    if not event_datetime_text:
        for reminder in extracted.get("reminders", []):
            if reminder.get("datetime"):
                event_datetime_text = reminder["datetime"]
                break

    try:
        async with httpx.AsyncClient(timeout=BACKEND_TIMEOUT) as client:
            headers = {"Content-Type": "application/json"}
            if auth_token:
                headers["Authorization"] = f"Bearer {auth_token}"

            response = await client.post(
                f"{settings.backend_url}/journal/",
                headers=headers,
                json={
                    "content": transcript,
                    "source": "aura_module",
                    "speaker_tags": speakers,
                    "extracted_events": extracted.get("events", [])
                    + extracted.get("reminders", []),
                    "mood": extracted.get("mood", ""),
                    "event_datetime_text": event_datetime_text,
                },
            )

            if response.status_code == 200:
                logger.debug("[CONV] Journal stored successfully")
                return True
            elif response.status_code == 401:
                logger.warning("[CONV] Auth failed when storing journal")
                return False
            else:
                logger.warning(f"[CONV] Failed to store journal: {response.status_code}")
                return False

    except httpx.ConnectError:
        logger.warning(f"[CONV] Cannot connect to backend at {settings.backend_url}")
        return False
    except httpx.TimeoutException:
        logger.warning("[CONV] Timeout storing journal")
        return False
    except Exception as e:
        logger.error(f"[CONV] Error storing journal: {type(e).__name__}: {e}")
        return False


async def summarize_conversation(
    transcripts: List[str],
    patient_uid: str,
    auth_token: str = "",
) -> Optional[str]:
    if not transcripts:
        logger.warning("[CONV] No transcripts to summarize")
        return None
    
    
    full_text = " ".join(transcripts)
    
    
    if len(full_text.strip()) < 20:
        logger.debug("[CONV] Transcript too short to summarize")
        return None
    
    logger.info(f"[CONV] Summarizing {len(transcripts)} transcripts ({len(full_text)} chars)...")
    
    
    summary, error = await _call_summarization_ollama(full_text)
    
    if error:
        logger.warning(f"[CONV] Summarization failed: {error}")
        return None
    
    if not summary:
        logger.warning("[CONV] No summary generated")
        return None
    
    logger.info(f"[CONV] Generated summary: {summary[:100]}...")
    
    
    await _send_summary_to_backend(
        summary=summary,
        transcript_count=len(transcripts),
        patient_uid=patient_uid,
        auth_token=auth_token,
    )
    
    return summary


async def _call_summarization_ollama(
    text: str,
    timeout: float = 60.0,  
    max_retries: int = 2,
) -> tuple[Optional[str], Optional[str]]:
    for attempt in range(max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{settings.ollama_url}/api/chat",
                    json={
                        "model": settings.ollama_model,
                        "messages": [
                            {"role": "system", "content": SUMMARIZATION_PROMPT},
                            {"role": "user", "content": f"Please summarize this conversation:\n\n{text}"},
                        ],
                        "stream": False,
                        "options": {
                            "temperature": 0.3,
                            "num_predict": 512,  
                        },
                    },
                )

                if resp.status_code == 200:
                    data = resp.json()
                    content = data.get("message", {}).get("content", "")
                    return content.strip(), None
                elif resp.status_code == 404:
                    return None, f"Model '{settings.ollama_model}' not found in Ollama"
                else:
                    return None, f"Ollama returned status {resp.status_code}"

        except httpx.ConnectError:
            error_msg = f"Cannot connect to Ollama at {settings.ollama_url}"
            if attempt < max_retries:
                logger.warning(f"[CONV] {error_msg}, retrying...")
                continue
            return None, error_msg
            
        except httpx.TimeoutException:
            error_msg = f"Ollama summarization timed out after {timeout}s"
            if attempt < max_retries:
                logger.warning(f"[CONV] {error_msg}, retrying...")
                continue
            return None, error_msg
            
        except json.JSONDecodeError as e:
            return None, f"Invalid JSON from Ollama: {e}"
            
        except Exception as e:
            return None, f"Ollama error: {type(e).__name__}: {e}"
    
    return None, "Max retries exceeded"


async def _send_summary_to_backend(
    summary: str,
    transcript_count: int,
    patient_uid: str,
    auth_token: str,
) -> bool:
    try:
        token = auth_token.strip() if auth_token else (settings.backend_auth_token or "").strip()
        endpoint = "/aura/log_event" if token else "/aura/device/log_event"
        async with httpx.AsyncClient(timeout=BACKEND_TIMEOUT) as client:
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"

            response = await client.post(
                f"{settings.backend_url}{endpoint}",
                headers=headers,
                json={
                    "patient_uid": patient_uid,
                    "event_type": "conversation_summary",
                    "data": {
                        "summary": summary,
                        "transcript_count": transcript_count,
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    },
                },
            )

            if response.status_code == 200:
                logger.info("[CONV] Summary sent to backend successfully")
                return True
            elif response.status_code == 401:
                logger.warning("[CONV] Auth failed when sending summary")
                return False
            else:
                logger.warning(f"[CONV] Failed to send summary: {response.status_code}")
                return False

    except httpx.ConnectError:
        logger.warning(f"[CONV] Cannot connect to backend at {settings.backend_url}")
        return False
    except httpx.TimeoutException:
        logger.warning("[CONV] Timeout sending summary to backend")
        return False
    except Exception as e:
        logger.error(f"[CONV] Error sending summary: {type(e).__name__}: {e}")
        return False
