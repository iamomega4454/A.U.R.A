import os
import logging
from pydantic_settings import BaseSettings
from pydantic import field_validator

logger = logging.getLogger(__name__)


#------This Class handles the Settings Configuration---------
class Settings(BaseSettings):
    backend_url: str = "http://localhost:8001"
    patient_uid: str = ""
    backend_auth_token: str = ""
    hf_token: str = ""
    camera_index: int = 0
    ws_port: int = 8001
    http_port: int = 8001
    discovery_port: int = 5353
    whisper_model: str = "base"
    whisper_model_size: str = "medium"
    stt_beam_size: int = 3
    stt_min_silence_ms: int = 400
    stt_speech_pad_ms: int = 250
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3:8b"
    ollama_streaming: bool = True
    auto_update_models: bool = True
    enable_vad: bool = True
    audio_capture_channels: int = 2
    audio_buffer_seconds: int = 30
    continuous_summary_interval_minutes: int = 10
    continuous_transcription_segment_seconds: int = 12
    continuous_min_transcript_chars: int = 12
    face_confidence_threshold: float = 0.4
    face_match_margin: float = 0.04
    face_min_bbox_size: int = 60
    face_min_blur_variance: float = 25.0
    heartbeat_interval: int = 40
    backend_timeout: float = 10.0
    backend_retry_delay: float = 5.0
    backend_max_retries: int = 10
    websocket_timeout: float = 300.0
    demo_mode: bool = False
    auto_face_recognition_enabled: bool = False
    auto_face_recognition_interval: int = 30
    auto_face_confirmation_count: int = 2
    auto_face_broadcast_cooldown_seconds: int = 45
    auto_face_presence_ttl_seconds: int = 300

#------This Function validates the patient UID---------
    @field_validator("patient_uid")
    @classmethod
    def validate_patient_uid(cls, v: str) -> str:
        if not v or v.strip() == "":
            logger.warning(
                "PATIENT_UID is not set. Using empty string - "
                "registration with backend may fail."
            )
        return v

#------This Function validates the backend URL---------
    @field_validator("backend_url")
    @classmethod
    def validate_backend_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("backend_url must start with http:// or https://")
        return v.rstrip("/")

#------This Function validates the face threshold---------
    @field_validator("face_confidence_threshold")
    @classmethod
    def validate_face_threshold(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("face_confidence_threshold must be between 0.0 and 1.0")
        return v

#------This Function validates whisper model size---------
    @field_validator("whisper_model_size")
    @classmethod
    def validate_whisper_size(cls, v: str) -> str:
        valid_sizes = ["small", "medium", "large-v3", "large"]
        if v not in valid_sizes:
            raise ValueError(f"whisper_model_size must be one of {valid_sizes}")
        return v

#------This Function validates audio buffer---------
    @field_validator("audio_buffer_seconds")
    @classmethod
    def validate_audio_buffer(cls, v: int) -> int:
        if v < 5 or v > 300:
            raise ValueError("audio_buffer_seconds must be between 5 and 300")
        return v

    #------This Function validates STT beam size---------
    @field_validator("stt_beam_size")
    @classmethod
    def validate_stt_beam_size(cls, v: int) -> int:
        if v < 1 or v > 10:
            raise ValueError("stt_beam_size must be between 1 and 10")
        return v

    #------This Function validates STT silence duration---------
    @field_validator("stt_min_silence_ms")
    @classmethod
    def validate_stt_min_silence_ms(cls, v: int) -> int:
        if v < 100 or v > 3000:
            raise ValueError("stt_min_silence_ms must be between 100 and 3000")
        return v

    #------This Function validates STT speech padding---------
    @field_validator("stt_speech_pad_ms")
    @classmethod
    def validate_stt_speech_pad_ms(cls, v: int) -> int:
        if v < 0 or v > 1000:
            raise ValueError("stt_speech_pad_ms must be between 0 and 1000")
        return v

    #------This Function validates audio capture channels---------
    @field_validator("audio_capture_channels")
    @classmethod
    def validate_audio_capture_channels(cls, v: int) -> int:
        if v < 1 or v > 2:
            raise ValueError("audio_capture_channels must be 1 or 2")
        return v

    #------This Function validates summarization interval---------
    @field_validator("continuous_summary_interval_minutes")
    @classmethod
    def validate_summary_interval(cls, v: int) -> int:
        if v < 1 or v > 120:
            raise ValueError("continuous_summary_interval_minutes must be between 1 and 120")
        return v

    #------This Function validates transcription segment seconds---------
    @field_validator("continuous_transcription_segment_seconds")
    @classmethod
    def validate_segment_seconds(cls, v: int) -> int:
        if v < 5 or v > 60:
            raise ValueError("continuous_transcription_segment_seconds must be between 5 and 60")
        return v

    #------This Function validates minimum transcript chars---------
    @field_validator("continuous_min_transcript_chars")
    @classmethod
    def validate_min_transcript_chars(cls, v: int) -> int:
        if v < 1 or v > 500:
            raise ValueError("continuous_min_transcript_chars must be between 1 and 500")
        return v

    #------This Function validates face match margin---------
    @field_validator("face_match_margin")
    @classmethod
    def validate_face_match_margin(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("face_match_margin must be between 0.0 and 1.0")
        return v

    #------This Function validates minimum face bounding box size---------
    @field_validator("face_min_bbox_size")
    @classmethod
    def validate_face_min_bbox_size(cls, v: int) -> int:
        if v < 20 or v > 512:
            raise ValueError("face_min_bbox_size must be between 20 and 512")
        return v

    #------This Function validates blur variance threshold---------
    @field_validator("face_min_blur_variance")
    @classmethod
    def validate_face_min_blur_variance(cls, v: float) -> float:
        if v < 0.0 or v > 1000.0:
            raise ValueError("face_min_blur_variance must be between 0.0 and 1000.0")
        return v

    #------This Function validates auto face confirmation count---------
    @field_validator("auto_face_confirmation_count")
    @classmethod
    def validate_auto_face_confirmation_count(cls, v: int) -> int:
        if v < 1 or v > 10:
            raise ValueError("auto_face_confirmation_count must be between 1 and 10")
        return v

    #------This Function validates auto face broadcast cooldown---------
    @field_validator("auto_face_broadcast_cooldown_seconds")
    @classmethod
    def validate_auto_face_broadcast_cooldown(cls, v: int) -> int:
        if v < 5 or v > 3600:
            raise ValueError("auto_face_broadcast_cooldown_seconds must be between 5 and 3600")
        return v

    #------This Function validates auto face presence ttl---------
    @field_validator("auto_face_presence_ttl_seconds")
    @classmethod
    def validate_auto_face_presence_ttl(cls, v: int) -> int:
        if v < 10 or v > 86400:
            raise ValueError("auto_face_presence_ttl_seconds must be between 10 and 86400")
        return v

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

#------This Function validates required settings---------
    def validate_required_settings(self) -> bool:
        errors = []
        
        if not self.patient_uid:
            errors.append("PATIENT_UID is required but not set")
        
        if not self.backend_url:
            errors.append("BACKEND_URL is required but not set")
        
        if errors:
            for error in errors:
                logger.error(f"Configuration error: {error}")
            return False
        
        return True



settings = Settings()


logger.info(f"Configuration loaded:")
logger.info(f"  backend_url: {settings.backend_url}")
logger.info(f"  patient_uid: {settings.patient_uid[:8] + '...' if settings.patient_uid else 'NOT SET'}")
logger.info(f"  http_port: {settings.http_port}")
logger.info(f"  demo_mode: {settings.demo_mode}")
logger.info(f"  whisper_model: {settings.whisper_model} ({settings.whisper_model_size})")
logger.info(f"  stt_beam_size: {settings.stt_beam_size}")
logger.info(f"  ollama_model: {settings.ollama_model} (streaming: {settings.ollama_streaming})")
logger.info(f"  auto_update_models: {settings.auto_update_models}")
logger.info(f"  enable_vad: {settings.enable_vad}")
logger.info(f"  audio_capture_channels: {settings.audio_capture_channels}")
logger.info(f"  audio_buffer_seconds: {settings.audio_buffer_seconds}")
logger.info(
    f"  summary_interval: {settings.continuous_summary_interval_minutes}m "
    f"(segment={settings.continuous_transcription_segment_seconds}s)"
)
