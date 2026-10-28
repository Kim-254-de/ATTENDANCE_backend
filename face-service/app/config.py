"""Settings, read once from the environment. A missing or weak key stops startup."""

import os
from dataclasses import dataclass
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    service_key: str
    model_dir: Path
    # Decoded bytes, not base64 characters. A phone photo re-encoded by the
    # portal is ~100-300 KB; anything near this is not a terminal frame.
    max_image_bytes: int = 2_000_000
    # Frames are scaled down to this before detection. Larger costs CPU and
    # finds nothing a terminal held at arm's length would miss.
    max_side_px: int = 1280
    # YuNet's confidence floor. Lower finds more faces and more false ones.
    detection_threshold: float = 0.8


def load_settings() -> Settings:
    key = os.environ.get("FACE_SERVICE_KEY", "")
    if len(key) < 32:
        raise RuntimeError("FACE_SERVICE_KEY must be set to at least 32 characters.")
    model_dir = Path(os.environ.get("FACE_MODEL_DIR", "models"))
    if not model_dir.is_absolute():
        model_dir = SERVICE_DIR / model_dir
    return Settings(
        service_key=key,
        model_dir=model_dir,
        max_image_bytes=int(os.environ.get("FACE_MAX_IMAGE_BYTES", Settings.max_image_bytes)),
        max_side_px=int(os.environ.get("FACE_MAX_SIDE_PX", Settings.max_side_px)),
        detection_threshold=float(os.environ.get("FACE_DETECTION_THRESHOLD", Settings.detection_threshold)),
    )
