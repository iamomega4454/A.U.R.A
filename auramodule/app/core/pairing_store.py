import json
import logging
import os
import time
from pathlib import Path
from typing import Dict, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

PAIRING_CONFIG_PATH = Path(
    os.getenv("AURAMODULE_PAIRING_CONFIG_PATH", "~/.aura/paired_device.json")
).expanduser()


#------This Function normalizes backend URL---------
def normalize_backend_url(backend_url: str) -> Optional[str]:
    url = (backend_url or "").strip().rstrip("/")
    if not url:
        return None
    if not url.startswith(("http://", "https://")):
        return None
    return url


#------This Function loads pairing config from disk---------
def load_pairing_config() -> Dict[str, str]:
    if not PAIRING_CONFIG_PATH.exists():
        return {}

    try:
        raw_data = json.loads(PAIRING_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("[PAIRING] Failed to read pairing config: %s", exc)
        return {}

    patient_uid = str(raw_data.get("patient_uid", "")).strip()
    backend_url = normalize_backend_url(str(raw_data.get("backend_url", "")))
    if not patient_uid or not backend_url:
        return {}

    return {
        "patient_uid": patient_uid,
        "backend_url": backend_url,
    }


#------This Function saves pairing config to disk---------
def save_pairing_config(patient_uid: str, backend_url: str) -> bool:
    normalized_backend_url = normalize_backend_url(backend_url)
    normalized_patient_uid = (patient_uid or "").strip()
    if not normalized_patient_uid or not normalized_backend_url:
        return False

    payload = {
        "patient_uid": normalized_patient_uid,
        "backend_url": normalized_backend_url,
        "updated_at": int(time.time()),
    }

    try:
        PAIRING_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        PAIRING_CONFIG_PATH.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return True
    except Exception as exc:
        logger.warning("[PAIRING] Failed to save pairing config: %s", exc)
        return False


#------This Function applies pairing config to runtime settings---------
def apply_pairing_config_to_settings(overwrite_existing: bool = False) -> bool:
    paired_config = load_pairing_config()
    if not paired_config:
        return False

    current_patient_uid = (settings.patient_uid or "").strip()
    current_backend_url = normalize_backend_url(settings.backend_url or "")

    should_apply_patient_uid = overwrite_existing or not current_patient_uid
    should_apply_backend_url = overwrite_existing or not current_backend_url

    if current_backend_url in ("http://localhost:8000", "http://localhost:8001"):
        should_apply_backend_url = True

    changed = False
    if should_apply_patient_uid and paired_config["patient_uid"] != current_patient_uid:
        settings.patient_uid = paired_config["patient_uid"]
        changed = True

    if should_apply_backend_url:
        runtime_backend_url = (settings.backend_url or "").rstrip("/")
        if paired_config["backend_url"] != runtime_backend_url:
            settings.backend_url = paired_config["backend_url"]
            changed = True

    if changed:
        logger.info(
            "[PAIRING] Applied stored pairing config "
            "(patient_uid=%s, backend_url=%s)",
            settings.patient_uid[:8] + "...",
            settings.backend_url,
        )

    return changed
