"""Download the ONNX models from the OpenCV model zoo and verify their checksums.

    python scripts/download_models.py [target_dir]

The files are not committed (38 MB). A checksum mismatch deletes the file and
exits non-zero: a silently swapped model would change every embedding.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

ZOO = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"

MODELS = {
    "face_detection_yunet_2023mar.onnx": (
        f"{ZOO}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "face_recognition_sface_2021dec.onnx": (
        f"{ZOO}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "models")
    target.mkdir(parents=True, exist_ok=True)

    for name, (url, expected) in MODELS.items():
        path = target / name
        if path.exists() and sha256(path) == expected:
            print(f"ok       {name}")
            continue
        print(f"download {name}")
        urllib.request.urlretrieve(url, path)
        actual = sha256(path)
        if actual != expected:
            path.unlink()
            print(f"checksum mismatch for {name}: got {actual}", file=sys.stderr)
            return 1
        print(f"ok       {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
