# face-service

Turns a face photo into an embedding (a 128-number vector) for face check-in.
Plan and decisions: [`docs/face-recognition.md`](../docs/face-recognition.md).

It is **stateless** and does one thing. It stores no images, templates or
students. Comparing embeddings, thresholds and rosters all live in the Node
API, which is the only caller.

## Models

OpenCV model zoo, run on CPU with `opencv-python-headless`:

| Step | Model | File |
|---|---|---|
| Detection + landmarks | YuNet (2023mar) | `face_detection_yunet_2023mar.onnx` |
| Recognition | SFace (2021dec) | `face_recognition_sface_2021dec.onnx` |

Both are permissively licensed. They are not committed:
`scripts/download_models.py` fetches them and checks their SHA-256.

Embeddings are L2-normalised, so cosine similarity is a dot product. OpenCV's
published threshold for SFace is **0.363**; on the test fixtures the same face
scores 0.91–0.97 and a different person 0.13. The threshold the API uses is
tuned with real photos from lecturers' phones by `scripts/calibrate.py`: see
[`docs/face-recognition.md`](../docs/face-recognition.md), phase 4.

## Run locally

```bash
cd face-service
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python scripts/download_models.py
export FACE_SERVICE_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
.venv/bin/uvicorn --factory app.main:create_app --port 8001
```

Or with Docker, from the repository root (needs `FACE_SERVICE_KEY` in `.env`):

```bash
docker compose up -d face-service
```

Tests: `.venv/bin/python -m pytest`. The tests that use the real models are
skipped when the models have not been downloaded.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FACE_SERVICE_KEY` | required | Shared with the Node API; at least 32 characters |
| `FACE_MODEL_DIR` | `models` | Where the ONNX files are |
| `FACE_MAX_IMAGE_BYTES` | `2000000` | Decoded image size limit |
| `FACE_MAX_SIDE_PX` | `1280` | Larger frames are scaled down before detection |
| `FACE_DETECTION_THRESHOLD` | `0.8` | YuNet confidence floor |

## API

### `GET /health`

No key. `{ "status": "ok", "model": "sface-2021dec" }`

### `POST /embed`

Header `X-Face-Service-Key: <key>`. Body:

```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ..." }
```

A plain base64 string works too. JPEG, PNG and WebP are accepted.

`200`:

```json
{
  "model": "sface-2021dec",
  "faceCount": 1,
  "face": {
    "box": { "x": 208, "y": 183, "width": 146, "height": 207 },
    "detectionScore": 0.909,
    "sharpness": 1247.1,
    "embedding": [0.000873, -0.137644, "... 128 numbers"]
  }
}
```

- `face` is the **largest** face in the frame: the person at the terminal.
  `faceCount` includes anyone behind them, so the API can decide whether a
  crowded frame is acceptable. With no face, `faceCount` is `0` and `face` is
  `null`. That is a result, not an error.
- `sharpness` is the Laplacian variance of the aligned face crop. Low values
  mean motion blur or poor focus.
- `model` is stored with every template, so a future model change can tell
  old templates apart.

Errors use the API's envelope, `{ "success": false, "error": { "code", "message" } }`:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body is not `{ "image": "..." }` |
| 400 | `INVALID_IMAGE` | Not base64, or not a readable image |
| 401 | `UNAUTHORIZED` | Missing or wrong key |
| 413 | `IMAGE_TOO_LARGE` | Over `FACE_MAX_IMAGE_BYTES` |
