import asyncio
import io
import logging
import queue
import threading
import time
import wave
from typing import Callable, List, Optional

import numpy as np

from app.core.config import settings
from app.services.speech import transcribe_audio_sync

logger = logging.getLogger(__name__)


try:
    import pyaudio

    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False
    logger.warning("[MIC] PyAudio not available - microphone service will run in demo mode only")


#------This Function converts PCM bytes to WAV bytes----------
def _pcm_to_wav(pcm_bytes: bytes, rate: int, channels: int = 1) -> bytes:
    if not pcm_bytes:
        return b""

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


#------This Class handles the Microphone Service----------
class MicrophoneService:
    RATE = 16000
    CHUNK = 2048
    FORMAT = None
    SILENCE_DURATION = 1.2
    MIN_SPEECH_SECONDS = 0.8
    MAX_SPEECH_SECONDS = 20.0
    MAX_BUFFER_SIZE = 120

    def __init__(self):
        self._audio = None
        self._stream = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._buffer: List[bytes] = []
        self._lock = threading.Lock()
        self._on_chunk: Optional[Callable[[bytes], None]] = None
        self._error_count = 0
        self._max_consecutive_errors = 12
        self._noise_floor = 0.0

        self.CHANNELS = 2 if settings.audio_capture_channels > 1 else 1

        if PYAUDIO_AVAILABLE:
            self.FORMAT = pyaudio.paInt16

    def start(self, on_chunk: Optional[Callable[[bytes], None]] = None):
        if self._running:
            logger.warning("[MIC] Service already running")
            return

        self._on_chunk = on_chunk
        self._error_count = 0
        self._noise_floor = 0.0

        if settings.demo_mode or not PYAUDIO_AVAILABLE:
            mode = "demo mode" if settings.demo_mode else "pyaudio unavailable"
            logger.info("[MIC] Running in %s - simulating microphone", mode)
            self._running = True
            self._thread = threading.Thread(target=self._demo_capture_loop, daemon=True)
            self._thread.start()
            return

        try:
            self._audio = pyaudio.PyAudio()
            self._stream = self._audio.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.CHUNK,
            )
            logger.info(
                "[MIC] Audio stream opened: %sHz, %s channel(s), chunk=%s",
                self.RATE,
                self.CHANNELS,
                self.CHUNK,
            )
        except OSError as exc:
            logger.error("[MIC] Failed to open audio stream: %s", exc)
            self._cleanup_audio()
            return
        except Exception as exc:
            logger.error("[MIC] Unexpected error opening audio: %s: %s", type(exc).__name__, exc)
            self._cleanup_audio()
            return

        self._running = True
        self._thread = threading.Thread(target=self._record_loop, daemon=True)
        self._thread.start()
        logger.info("[MIC] Capture thread started")

    def _cleanup_audio(self):
        if self._stream:
            try:
                if self._stream.is_active():
                    self._stream.stop_stream()
                self._stream.close()
            except Exception as exc:
                logger.warning("[MIC] Error closing stream: %s", exc)
            self._stream = None

        if self._audio:
            try:
                self._audio.terminate()
            except Exception as exc:
                logger.warning("[MIC] Error terminating audio: %s", exc)
            self._audio = None

    @property
    def is_running(self) -> bool:
        return self._running

    #------This Function decodes interleaved PCM and downmixes to mono----------
    def _pcm_to_mono(self, data: bytes) -> np.ndarray:
        pcm = np.frombuffer(data, dtype=np.int16)
        if pcm.size == 0:
            return np.array([], dtype=np.int16)
        if self.CHANNELS > 1:
            pcm = pcm.reshape(-1, self.CHANNELS).mean(axis=1).astype(np.int16)
        return pcm

    def _record_loop(self):
        logger.info("[MIC] Recording loop started")
        silence_start: Optional[float] = None
        speech_start: Optional[float] = None
        active_frames: List[bytes] = []

        while self._running:
            try:
                data = self._stream.read(self.CHUNK, exception_on_overflow=False)
            except OSError as exc:
                self._error_count += 1
                logger.warning("[MIC] Error reading audio stream: %s", exc)
                if self._error_count >= self._max_consecutive_errors:
                    logger.error("[MIC] Too many consecutive read errors (%s), stopping", self._error_count)
                    break
                continue
            except Exception as exc:
                self._error_count += 1
                logger.error("[MIC] Unexpected read error: %s: %s", type(exc).__name__, exc)
                if self._error_count >= self._max_consecutive_errors:
                    break
                continue

            self._error_count = 0

            mono_pcm = self._pcm_to_mono(data)
            if mono_pcm.size == 0:
                continue

            mono_float = mono_pcm.astype(np.float32)
            rms = float(np.sqrt(np.mean(np.square(mono_float))))

            if self._noise_floor <= 0.0:
                self._noise_floor = rms
            elif not active_frames:
                self._noise_floor = (self._noise_floor * 0.98) + (rms * 0.02)

            dynamic_threshold = max(260.0, self._noise_floor * 2.2)
            speaking = rms > dynamic_threshold

            if speaking:
                if speech_start is None:
                    speech_start = time.time()
                silence_start = None
                active_frames.append(mono_pcm.tobytes())
            else:
                if active_frames:
                    active_frames.append(mono_pcm.tobytes())
                    if silence_start is None:
                        silence_start = time.time()

                    speech_seconds = len(active_frames) * (self.CHUNK / self.RATE)
                    silence_elapsed = time.time() - silence_start
                    if (
                        silence_elapsed >= self.SILENCE_DURATION
                        or speech_seconds >= self.MAX_SPEECH_SECONDS
                    ):
                        if speech_seconds >= self.MIN_SPEECH_SECONDS:
                            audio_bytes = _pcm_to_wav(b"".join(active_frames), self.RATE, channels=1)
                            if audio_bytes:
                                self._handle_audio_chunk(audio_bytes)
                        active_frames = []
                        speech_start = None
                        silence_start = None

        logger.info("[MIC] Recording loop ended")
        self._cleanup_audio()

    def _demo_capture_loop(self):
        logger.info("[MIC] Demo capture loop started")
        while self._running:
            time.sleep(1.0)
        logger.info("[MIC] Demo capture loop ended")

    def _handle_audio_chunk(self, audio_bytes: bytes):
        if self._on_chunk:
            try:
                self._on_chunk(audio_bytes)
            except Exception as exc:
                logger.warning("[MIC] Error in callback: %s", exc)

        with self._lock:
            self._buffer.append(audio_bytes)
            if len(self._buffer) > self.MAX_BUFFER_SIZE:
                self._buffer.pop(0)

    def get_latest_chunk(self) -> Optional[bytes]:
        with self._lock:
            if self._buffer:
                return self._buffer.pop(0)
        return None

    def get_buffer_size(self) -> int:
        with self._lock:
            return len(self._buffer)

    def clear_buffer(self):
        with self._lock:
            self._buffer.clear()

    def stop(self):
        logger.info("[MIC] Stopping microphone service...")
        self._running = False

        if self._thread:
            self._thread.join(timeout=3)
            if self._thread.is_alive():
                logger.warning("[MIC] Capture thread did not stop gracefully")

        self._cleanup_audio()
        self.clear_buffer()
        logger.info("[MIC] Microphone stopped")


mic_service = MicrophoneService()


#------This Class handles continuous surround capture + periodic summarization----------
class ContinuousMicrophone:
    RATE = 16000
    CHUNK = 4096
    FORMAT = None

    def __init__(
        self,
        on_summarize: Optional[Callable[[List[str]], None]] = None,
        event_loop: Optional[asyncio.AbstractEventLoop] = None,
    ):
        self._audio = None
        self._stream = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._transcription_thread: Optional[threading.Thread] = None
        self._on_summarize = on_summarize
        self._event_loop = event_loop

        self._transcripts: List[str] = []
        self._transcripts_lock = threading.Lock()

        self._last_summarize_time = time.time()
        self._total_recorded_seconds = 0.0
        self._error_count = 0
        self._max_consecutive_errors = 15
        self._noise_floor = 0.0

        self._summary_lock = threading.Lock()
        self._summary_in_progress = False

        self._audio_queue: queue.Queue = queue.Queue(maxsize=256)
        self._segment_buffer = bytearray()

        self.CHANNELS = 2 if settings.audio_capture_channels > 1 else 1
        self.SUMMARIZATION_INTERVAL = max(60, settings.continuous_summary_interval_minutes * 60)
        self.SEGMENT_SECONDS = settings.continuous_transcription_segment_seconds
        self.MIN_TRANSCRIPT_CHARS = settings.continuous_min_transcript_chars

        if PYAUDIO_AVAILABLE:
            self.FORMAT = pyaudio.paInt16

    @property
    def is_running(self) -> bool:
        return self._running

    def _pcm_to_mono(self, data: bytes) -> np.ndarray:
        pcm = np.frombuffer(data, dtype=np.int16)
        if pcm.size == 0:
            return np.array([], dtype=np.int16)
        if self.CHANNELS > 1:
            pcm = pcm.reshape(-1, self.CHANNELS).mean(axis=1).astype(np.int16)
        return pcm

    def start(self):
        if self._running:
            logger.warning("[CONTINUOUS_MIC] Service already running")
            return

        self._error_count = 0
        self._noise_floor = 0.0
        self._last_summarize_time = time.time()
        self._total_recorded_seconds = 0.0
        self._segment_buffer = bytearray()
        with self._transcripts_lock:
            self._transcripts.clear()

        if settings.demo_mode or not PYAUDIO_AVAILABLE:
            mode = "demo mode" if settings.demo_mode else "pyaudio unavailable"
            logger.info("[CONTINUOUS_MIC] Running in %s", mode)
            self._running = True
            self._thread = threading.Thread(target=self._demo_recording_loop, daemon=True)
            self._thread.start()
            return

        try:
            self._audio = pyaudio.PyAudio()
            self._stream = self._audio.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.CHUNK,
            )
            logger.info(
                "[CONTINUOUS_MIC] Audio stream opened: %sHz, %s channel(s), chunk=%s",
                self.RATE,
                self.CHANNELS,
                self.CHUNK,
            )
        except OSError as exc:
            logger.error("[CONTINUOUS_MIC] Failed to open audio stream: %s", exc)
            self._cleanup_audio()
            return
        except Exception as exc:
            logger.error("[CONTINUOUS_MIC] Unexpected open error: %s: %s", type(exc).__name__, exc)
            self._cleanup_audio()
            return

        self._running = True
        self._thread = threading.Thread(target=self._recording_loop, daemon=True)
        self._thread.start()
        self._transcription_thread = threading.Thread(target=self._transcription_loop, daemon=True)
        self._transcription_thread.start()
        logger.info("[CONTINUOUS_MIC] Continuous recording started")

    def _cleanup_audio(self):
        if self._stream:
            try:
                if self._stream.is_active():
                    self._stream.stop_stream()
                self._stream.close()
            except Exception as exc:
                logger.warning("[CONTINUOUS_MIC] Error closing stream: %s", exc)
            self._stream = None

        if self._audio:
            try:
                self._audio.terminate()
            except Exception as exc:
                logger.warning("[CONTINUOUS_MIC] Error terminating audio: %s", exc)
            self._audio = None

    def _recording_loop(self):
        logger.info("[CONTINUOUS_MIC] Recording loop started")
        chunk_duration = self.CHUNK / self.RATE

        while self._running:
            try:
                data = self._stream.read(self.CHUNK, exception_on_overflow=False)
            except OSError as exc:
                self._error_count += 1
                logger.warning("[CONTINUOUS_MIC] Stream read error: %s", exc)
                if self._error_count >= self._max_consecutive_errors:
                    logger.error("[CONTINUOUS_MIC] Too many errors (%s), stopping", self._error_count)
                    break
                time.sleep(0.05)
                continue
            except Exception as exc:
                self._error_count += 1
                logger.error("[CONTINUOUS_MIC] Unexpected read error: %s: %s", type(exc).__name__, exc)
                if self._error_count >= self._max_consecutive_errors:
                    break
                continue

            self._error_count = 0

            mono_pcm = self._pcm_to_mono(data)
            if mono_pcm.size == 0:
                continue

            mono_float = mono_pcm.astype(np.float32)
            rms = float(np.sqrt(np.mean(np.square(mono_float))))

            if self._noise_floor <= 0.0:
                self._noise_floor = rms
            else:
                self._noise_floor = (self._noise_floor * 0.995) + (rms * 0.005)

            dynamic_threshold = max(220.0, self._noise_floor * 2.0)
            if rms > dynamic_threshold or rms > 450.0:
                try:
                    self._audio_queue.put_nowait(mono_pcm.tobytes())
                except queue.Full:
                    try:
                        _ = self._audio_queue.get_nowait()
                        self._audio_queue.put_nowait(mono_pcm.tobytes())
                    except Exception:
                        pass

            self._total_recorded_seconds += chunk_duration

            if time.time() - self._last_summarize_time >= self.SUMMARIZATION_INTERVAL:
                self._trigger_summarization()

        logger.info("[CONTINUOUS_MIC] Recording loop ended")
        self._cleanup_audio()

    def _demo_recording_loop(self):
        logger.info("[CONTINUOUS_MIC] Demo recording loop started")
        while self._running:
            time.sleep(1.0)
            if time.time() - self._last_summarize_time >= self.SUMMARIZATION_INTERVAL:
                self._trigger_summarization()
        logger.info("[CONTINUOUS_MIC] Demo recording loop ended")

    def _transcription_loop(self):
        logger.info("[CONTINUOUS_MIC] Transcription loop started")
        target_samples = self.RATE * self.SEGMENT_SECONDS
        target_bytes = target_samples * 2
        min_bytes = self.RATE * 2 * 3

        while self._running:
            try:
                try:
                    data = self._audio_queue.get(timeout=1.0)
                    self._segment_buffer.extend(data)
                except queue.Empty:
                    if len(self._segment_buffer) < min_bytes:
                        continue

                if len(self._segment_buffer) < target_bytes:
                    continue

                segment_pcm = bytes(self._segment_buffer[:target_bytes])
                self._segment_buffer = self._segment_buffer[target_bytes:]

                wav_bytes = _pcm_to_wav(segment_pcm, self.RATE, channels=1)
                transcript_text = transcribe_audio_sync(wav_bytes)
                if transcript_text and len(transcript_text) >= self.MIN_TRANSCRIPT_CHARS:
                    with self._transcripts_lock:
                        self._transcripts.append(transcript_text)
                        if len(self._transcripts) > 120:
                            self._transcripts = self._transcripts[-80:]
                    logger.debug("[CONTINUOUS_MIC] Transcript chunk: %s...", transcript_text[:70])

            except Exception as exc:
                logger.warning("[CONTINUOUS_MIC] Transcription loop error: %s", exc)
                time.sleep(0.2)

        logger.info("[CONTINUOUS_MIC] Transcription loop ended")

    def _trigger_summarization(self):
        with self._summary_lock:
            if self._summary_in_progress:
                return
            self._summary_in_progress = True

        try:
            with self._transcripts_lock:
                transcripts_to_summarize = [t for t in self._transcripts if t and t.strip()]
                self._transcripts.clear()

            if not transcripts_to_summarize:
                self._last_summarize_time = time.time()
                logger.debug("[CONTINUOUS_MIC] No transcripts available for summary window")
                return

            if self._on_summarize:
                try:
                    callback_result = self._on_summarize(transcripts_to_summarize)
                    if asyncio.iscoroutine(callback_result):
                        if self._event_loop and self._event_loop.is_running():
                            asyncio.run_coroutine_threadsafe(callback_result, self._event_loop)
                        else:
                            asyncio.run(callback_result)
                except Exception as exc:
                    logger.error("[CONTINUOUS_MIC] Summarization callback error: %s", exc)

            logger.info(
                "[CONTINUOUS_MIC] Summary window closed (%s transcripts, ~%.1fs audio)",
                len(transcripts_to_summarize),
                self.SUMMARIZATION_INTERVAL,
            )
            self._last_summarize_time = time.time()

        finally:
            with self._summary_lock:
                self._summary_in_progress = False

    def get_transcripts(self) -> List[str]:
        with self._transcripts_lock:
            return self._transcripts.copy()

    def get_stats(self) -> dict:
        with self._transcripts_lock:
            transcript_count = len(self._transcripts)

        return {
            "is_running": self._running,
            "total_recorded_seconds": self._total_recorded_seconds,
            "transcript_count": transcript_count,
            "queue_size": self._audio_queue.qsize(),
            "time_since_last_summary": time.time() - self._last_summarize_time,
            "channels": self.CHANNELS,
            "summary_interval_seconds": self.SUMMARIZATION_INTERVAL,
        }

    def stop(self):
        logger.info("[CONTINUOUS_MIC] Stopping continuous microphone...")
        self._running = False

        if self._thread:
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                logger.warning("[CONTINUOUS_MIC] Recording thread did not stop gracefully")

        if self._transcription_thread:
            self._transcription_thread.join(timeout=5)
            if self._transcription_thread.is_alive():
                logger.warning("[CONTINUOUS_MIC] Transcription thread did not stop gracefully")

        self._cleanup_audio()
        logger.info("[CONTINUOUS_MIC] Continuous microphone stopped")


continuous_mic = ContinuousMicrophone()
