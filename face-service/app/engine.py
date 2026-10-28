"""Face detection and embedding: OpenCV YuNet + SFace.

The engine only turns an image into a vector. Comparing vectors, thresholds,
rosters and stored templates all belong to the Node API, so this service can
be swapped for another model without touching any data.
"""

import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

MODEL_ID = "sface-2021dec"
DETECTOR_FILE = "face_detection_yunet_2023mar.onnx"
RECOGNIZER_FILE = "face_recognition_sface_2021dec.onnx"


@dataclass(frozen=True)
class Face:
    x: int
    y: int
    width: int
    height: int
    detection_score: float


@dataclass(frozen=True)
class Embedding:
    face: Face
    # Laplacian variance of the aligned 112x112 crop. Low means blurred.
    sharpness: float
    # L2-normalised, so cosine similarity is a dot product.
    vector: list[float]


class FaceEngine:
    def __init__(self, model_dir: Path, detection_threshold: float):
        for name in (DETECTOR_FILE, RECOGNIZER_FILE):
            if not (model_dir / name).is_file():
                raise RuntimeError(f"Missing model {model_dir / name}. Run scripts/download_models.py.")
        self._detector = cv2.FaceDetectorYN.create(
            str(model_dir / DETECTOR_FILE), "", (320, 320), detection_threshold, 0.3, 5000
        )
        self._recognizer = cv2.FaceRecognizerSF.create(str(model_dir / RECOGNIZER_FILE), "")
        # OpenCV's dnn nets are not safe to call from several threads at once,
        # and FastAPI runs sync endpoints on a thread pool.
        self._lock = threading.Lock()

    def embed(self, image: np.ndarray) -> tuple[int, Embedding | None]:
        """The number of faces found, and the embedding of the largest one (None when there is none).

        The largest face is the person standing at the terminal; others are
        the queue behind them. The caller decides whether a crowded frame is
        acceptable from the count.
        """
        height, width = image.shape[:2]
        with self._lock:
            self._detector.setInputSize((width, height))
            _, rows = self._detector.detect(image)
            if rows is None or len(rows) == 0:
                return 0, None
            # A row is x, y, w, h, five landmark points, score.
            largest = max(rows, key=lambda r: r[2] * r[3])
            aligned = self._recognizer.alignCrop(image, largest)
            feature = self._recognizer.feature(aligned).flatten().astype(np.float64)

        norm = np.linalg.norm(feature)
        vector = (feature / norm) if norm > 0 else feature
        gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        x, y, w, h = (int(round(v)) for v in largest[:4])
        face = Face(x=x, y=y, width=w, height=h, detection_score=float(largest[-1]))
        return len(rows), Embedding(
            face=face,
            sharpness=sharpness,
            vector=[round(float(v), 6) for v in vector],
        )
