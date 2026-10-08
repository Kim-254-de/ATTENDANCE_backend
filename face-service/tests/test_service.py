"""HTTP contract, image handling, and the real models on two sample faces.

The model tests are skipped when the ONNX files have not been downloaded
(python scripts/download_models.py).
"""

import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import SERVICE_DIR, Settings
from app.engine import DETECTOR_FILE, RECOGNIZER_FILE, Embedding, Face, FaceEngine
from app.images import ImageError, decode_image
from app.main import create_app

KEY = "k" * 32
FIXTURES = Path(__file__).parent / "fixtures"
MODEL_DIR = SERVICE_DIR / "models"
HAVE_MODELS = (MODEL_DIR / DETECTOR_FILE).is_file() and (MODEL_DIR / RECOGNIZER_FILE).is_file()
needs_models = pytest.mark.skipif(not HAVE_MODELS, reason="models not downloaded")


def settings(**overrides) -> Settings:
    return Settings(service_key=KEY, model_dir=MODEL_DIR, **overrides)


def jpeg_b64(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def fixture(name: str) -> np.ndarray:
    return cv2.imread(str(FIXTURES / name))


class FakeEngine:
    """Records what it was given; finds one face unless told otherwise."""

    def __init__(self, count: int = 1):
        self.count = count
        self.calls: list[np.ndarray] = []

    def embed(self, image):
        self.calls.append(image)
        if self.count == 0:
            return 0, None
        face = Face(x=1, y=2, width=30, height=40, detection_score=0.91234)
        return self.count, Embedding(face=face, sharpness=123.456, vector=[0.6, 0.8])


@pytest.fixture
def fake():
    return FakeEngine()


@pytest.fixture
def client(fake):
    return TestClient(create_app(settings(), fake))


def post(client, body, key=KEY):
    return client.post("/embed", json=body, headers={"X-Face-Service-Key": key} if key else {})


# --- HTTP contract ------------------------------------------------------------


def test_health_needs_no_key(client):
    assert client.get("/health").json() == {"status": "ok", "model": "sface-2021dec"}


@pytest.mark.parametrize("key", [None, "wrong", KEY + "x"])
def test_embed_refuses_a_missing_or_wrong_key(client, fake, key):
    res = post(client, {"image": jpeg_b64(np.zeros((10, 10, 3), np.uint8))}, key=key)
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"
    assert fake.calls == []


def test_embed_returns_the_largest_face(client):
    res = post(client, {"image": jpeg_b64(np.zeros((10, 10, 3), np.uint8))})
    assert res.status_code == 200
    assert res.json() == {
        "model": "sface-2021dec",
        "faceCount": 1,
        "face": {
            "box": {"x": 1, "y": 2, "width": 30, "height": 40},
            "detectionScore": 0.9123,
            "sharpness": 123.5,
            "embedding": [0.6, 0.8],
        },
    }


def test_embed_with_no_face_is_not_an_error(fake):
    client = TestClient(create_app(settings(), FakeEngine(count=0)))
    res = post(client, {"image": jpeg_b64(np.zeros((10, 10, 3), np.uint8))})
    assert res.status_code == 200
    assert res.json() == {"model": "sface-2021dec", "faceCount": 0, "face": None}


@pytest.mark.parametrize("body", [{}, {"image": 5}, {"image": "short"}, {"image": "x" * 20, "extra": 1}])
def test_embed_refuses_a_malformed_body(client, body):
    res = post(client, body)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_embed_refuses_something_that_is_not_an_image(client):
    res = post(client, {"image": base64.b64encode(b"definitely not a jpeg").decode()})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_IMAGE"


def test_embed_refuses_an_oversized_image(fake):
    client = TestClient(create_app(settings(max_image_bytes=1000), fake))
    res = post(client, {"image": "A" * 4000})
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "IMAGE_TOO_LARGE"
    assert fake.calls == []


# --- Image decoding -----------------------------------------------------------


def test_decode_accepts_a_data_url_and_downscales():
    image = np.zeros((400, 2000, 3), np.uint8)
    decoded = decode_image("data:image/jpeg;base64," + jpeg_b64(image), 10_000_000, 1000)
    assert decoded.shape == (200, 1000, 3)


def test_decode_refuses_invalid_base64():
    with pytest.raises(ImageError) as caught:
        decode_image("not base64 at all!!", 10_000_000, 1000)
    assert caught.value.code == "INVALID_IMAGE"


# --- Real models --------------------------------------------------------------


@pytest.fixture(scope="module")
def engine():
    return FaceEngine(MODEL_DIR, 0.8)


def similarity(a: Embedding, b: Embedding) -> float:
    return float(np.dot(a.vector, b.vector))


@needs_models
def test_embedding_is_normalised(engine):
    count, result = engine.embed(fixture("lena.jpg"))
    assert count == 1
    assert len(result.vector) == 128
    assert np.linalg.norm(result.vector) == pytest.approx(1.0, abs=1e-4)


@needs_models
def test_same_face_matches_and_different_faces_do_not(engine):
    lena = engine.embed(fixture("lena.jpg"))[1]
    lena_variants = [
        engine.embed(cv2.flip(fixture("lena.jpg"), 1))[1],
        engine.embed(cv2.convertScaleAbs(fixture("lena.jpg"), alpha=0.7, beta=-20))[1],
        engine.embed(cv2.resize(fixture("lena.jpg"), None, fx=0.5, fy=0.5))[1],
    ]
    messi = engine.embed(fixture("messi5.jpg"))[1]

    # OpenCV's published cosine threshold for SFace is 0.363.
    for variant in lena_variants:
        assert similarity(lena, variant) > 0.8
    assert similarity(lena, messi) < 0.363


@needs_models
def test_no_face_found(engine):
    assert engine.embed(np.full((300, 300, 3), 128, np.uint8)) == (0, None)


@needs_models
def test_counts_every_face_and_embeds_the_largest(engine):
    lena = fixture("lena.jpg")
    small = cv2.resize(lena, None, fx=0.5, fy=0.5)
    canvas = np.zeros((lena.shape[0], lena.shape[1] + small.shape[1], 3), np.uint8)
    canvas[:, : lena.shape[1]] = lena
    canvas[: small.shape[0], lena.shape[1] :] = small

    count, result = engine.embed(canvas)
    assert count == 2
    assert result.face.x < lena.shape[1]  # the full-size face, not the small one
