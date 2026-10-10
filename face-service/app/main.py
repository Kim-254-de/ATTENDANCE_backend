"""HTTP surface of the face service. Called by the Node API only, never by browsers.

Run with:  uvicorn --factory app.main:create_app
"""

import hmac
from typing import Annotated, Protocol

import numpy as np
from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, load_settings
from .engine import MODEL_ID, Embedding, FaceEngine
from .images import ImageError, decode_image


class Engine(Protocol):
    def embed(self, image: np.ndarray) -> tuple[int, Embedding | None]: ...


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Base64 or a data URL. Capped as characters here so an oversized body is
    # refused before any decoding; decode_image applies the byte limit.
    image: str = Field(min_length=16, max_length=3_000_000)


class Box(BaseModel):
    x: int
    y: int
    width: int
    height: int


class EmbeddedFace(BaseModel):
    box: Box
    detectionScore: float
    sharpness: float
    embedding: list[float]


class EmbedResponse(BaseModel):
    model: str
    faceCount: int
    # The largest face, or null when none was found.
    face: EmbeddedFace | None


def _error(status: int, code: str, message: str) -> JSONResponse:
    # The same envelope shape as the Node API's errors.
    return JSONResponse(status_code=status, content={"success": False, "error": {"code": code, "message": message}})


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    settings = settings or load_settings()
    engine = engine or FaceEngine(settings.model_dir, settings.detection_threshold)

    app = FastAPI(title="Attendance face service", docs_url=None, redoc_url=None, openapi_url=None)

    class Unauthorized(Exception):
        pass

    def require_key(x_face_service_key: Annotated[str | None, Header()] = None) -> None:
        if not x_face_service_key or not hmac.compare_digest(x_face_service_key, settings.service_key):
            raise Unauthorized()

    @app.exception_handler(Unauthorized)
    async def unauthorized(_: Request, __: Unauthorized) -> JSONResponse:
        return _error(401, "UNAUTHORIZED", "Missing or wrong service key.")

    @app.exception_handler(ImageError)
    async def bad_image(_: Request, error: ImageError) -> JSONResponse:
        return _error(413 if error.code == "IMAGE_TOO_LARGE" else 400, error.code, str(error))

    @app.exception_handler(RequestValidationError)
    async def invalid_body(_: Request, __: RequestValidationError) -> JSONResponse:
        return _error(400, "VALIDATION_ERROR", "The body must be { \"image\": \"<base64 or data URL>\" }.")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "model": MODEL_ID}

    # Sync on purpose: detection is CPU-bound, so FastAPI runs it on its thread pool.
    @app.post("/embed", dependencies=[Depends(require_key)])
    def embed(body: EmbedRequest) -> EmbedResponse:
        image = decode_image(body.image, settings.max_image_bytes, settings.max_side_px)
        count, result = engine.embed(image)
        face = None
        if result is not None:
            face = EmbeddedFace(
                box=Box(x=result.face.x, y=result.face.y, width=result.face.width, height=result.face.height),
                detectionScore=round(result.face.detection_score, 4),
                sharpness=round(result.sharpness, 1),
                embedding=result.vector,
            )
        return EmbedResponse(model=MODEL_ID, faceCount=count, face=face)

    return app
