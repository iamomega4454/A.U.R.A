import asyncio
import io
import logging
import re
import time
import wave
from typing import Dict, Optional, Tuple

import numpy as np

from app.core.config import settings

logger = logging.getLogger(__name__)

_whisper_model = None
_model_load_error: Optional[str] = None


#------This Function resolves Whisper runtime configuration----------
def _resolve_runtime() -> Tuple[str, str]:
    device = "cpu"
    compute_type = "int8"

    try:
        import torch

        if torch.cuda.is_available():
            device = "cuda"
            compute_type = "float16"
            logger.info("[STT] CUDA available: %s", torch.cuda.get_device_name(0))
    except Exception as exc:
        logger.debug("[STT] torch runtime probe skipped: %s", exc)

    return device, compute_type


#------This Function returns the Whisper Model----------
def get_whisper_model():
    global _whisper_model, _model_load_error

    if _model_load_error:
        raise RuntimeError(f"Whisper model failed to load: {_model_load_error}")

    if _whisper_model is not None:
        return _whisper_model

    try:
        from faster_whisper import WhisperModel

        logger.info("[STT] Loading faster-whisper model: %s", settings.whisper_model)
        start_time = time.time()
        device, compute_type = _resolve_runtime()

        _whisper_model = WhisperModel(
            settings.whisper_model,
            device=device,
            compute_type=compute_type,
        )

        load_time = time.time() - start_time
        logger.info(
            "[STT] Loaded faster-whisper model: %s (%s, %s) in %.2fs",
            settings.whisper_model,
            device,
            compute_type,
            load_time,
        )
        return _whisper_model

    except ImportError as exc:
        _model_load_error = f"faster-whisper not installed: {exc}"
        logger.error("[STT] %s", _model_load_error)
        raise RuntimeError(_model_load_error)

    except Exception as exc:
        _model_load_error = f"{type(exc).__name__}: {exc}"
        logger.error("[STT] Failed to load Whisper model: %s", _model_load_error)
        raise RuntimeError(_model_load_error)


#------This Function validates audio bytes----------
def validate_audio(audio_bytes: bytes) -> Tuple[bool, Optional[str]]:
    if audio_bytes is None:
        return False, "Audio bytes is None"

    if not isinstance(audio_bytes, bytes):
        return False, f"Expected bytes, got {type(audio_bytes).__name__}"

    if len(audio_bytes) == 0:
        return False, "Audio bytes is empty"

    if len(audio_bytes) < 512:
        return False, f"Audio too small: {len(audio_bytes)} bytes"

    max_size = 50 * 1024 * 1024
    if len(audio_bytes) > max_size:
        return False, f"Audio too large: {len(audio_bytes)} bytes (max {max_size})"

    return True, None


#------This Function decodes WAV bytes and normalizes waveform----------
def _decode_wav_bytes(audio_bytes: bytes) -> Tuple[Optional[np.ndarray], Optional[str]]:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
            sample_width = wf.getsampwidth()
            channels = wf.getnchannels()
            frame_count = wf.getnframes()
            raw_pcm = wf.readframes(frame_count)
    except Exception as exc:
        return None, f"invalid_wav: {type(exc).__name__}: {exc}"

    if sample_width != 2:
        return None, f"unsupported_sample_width: {sample_width}"

    if channels < 1:
        return None, "invalid_channel_count"

    pcm = np.frombuffer(raw_pcm, dtype=np.int16)
    if pcm.size == 0:
        return None, "empty_pcm"

    if channels > 1:
        try:
            pcm = pcm.reshape(-1, channels)
            pcm = pcm.mean(axis=1).astype(np.int16)
        except Exception as exc:
            return None, f"downmix_failed: {exc}"

    waveform = pcm.astype(np.float32) / 32768.0
    if waveform.size == 0:
        return None, "empty_waveform"

    peak = float(np.max(np.abs(waveform)))
    if peak < 0.003:
        return None, "audio_too_quiet"

    if peak > 0:
        target_peak = 0.9
        gain = min(target_peak / peak, 5.0)
        waveform = np.clip(waveform * gain, -1.0, 1.0)

    return waveform, None


#------This Function compacts repeated whitespace and punctuation----------
def _clean_transcript(text: str) -> str:
    compact = re.sub(r"\s+", " ", text.strip())
    compact = re.sub(r"([.!?])\1{2,}", r"\1", compact)
    return compact


#------This Function transcribes normalized waveform with Whisper----------
def _transcribe_waveform(model, waveform: np.ndarray) -> str:
    duration_seconds = len(waveform) / 16000.0
    beam_size = settings.stt_beam_size if duration_seconds >= 4.0 else 1

    segments, info = model.transcribe(
        waveform,
        language="en",
        beam_size=beam_size,
        best_of=max(beam_size, 2),
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=settings.stt_min_silence_ms,
            speech_pad_ms=settings.stt_speech_pad_ms,
        ),
        condition_on_previous_text=False,
        word_timestamps=False,
        temperature=0.0,
    )

    transcript_parts = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            transcript_parts.append(text)

    transcript = _clean_transcript(" ".join(transcript_parts))
    logger.debug(
        "[STT] decode meta: duration=%.2fs language=%s prob=%.3f",
        getattr(info, "duration", 0.0),
        getattr(info, "language", "unknown"),
        getattr(info, "language_probability", 0.0),
    )
    return transcript


#------This Function handles synchronous audio transcription----------
def transcribe_audio_sync(audio_bytes: bytes) -> str:
    is_valid, error = validate_audio(audio_bytes)
    if not is_valid:
        logger.debug("[STT] Invalid audio: %s", error)
        return ""

    try:
        model = get_whisper_model()
    except RuntimeError as exc:
        logger.error("[STT] Model not available: %s", exc)
        return ""

    waveform, decode_error = _decode_wav_bytes(audio_bytes)
    if waveform is None:
        logger.debug("[STT] Skipping decode: %s", decode_error)
        return ""

    try:
        start_time = time.time()
        transcript = _transcribe_waveform(model, waveform)
        transcribe_time = time.time() - start_time

        if transcript:
            logger.info(
                "[STT] Transcribed %.2fs audio in %.2fs: '%s%s'",
                len(waveform) / 16000.0,
                transcribe_time,
                transcript[:60],
                "..." if len(transcript) > 60 else "",
            )
        else:
            logger.debug(
                "[STT] No speech decoded from %.2fs audio (%.2fs decode)",
                len(waveform) / 16000.0,
                transcribe_time,
            )

        return transcript

    except Exception as exc:
        logger.error("[STT] Transcription error: %s: %s", type(exc).__name__, exc)
        return ""


#------This Function handles asynchronous audio transcription----------
async def transcribe_audio(audio_bytes: bytes) -> str:
    return await asyncio.to_thread(transcribe_audio_sync, audio_bytes)


#------This Function checks if model is loaded----------
def is_model_loaded() -> bool:
    return _whisper_model is not None


#------This Function gets model status----------
def get_model_status() -> Dict[str, object]:
    return {
        "model": settings.whisper_model,
        "loaded": _whisper_model is not None,
        "error": _model_load_error,
    }
