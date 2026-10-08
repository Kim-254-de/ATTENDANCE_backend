FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Models are fetched and checksum-verified at build time, so a running
# container never depends on GitHub being reachable.
COPY scripts ./scripts
RUN python scripts/download_models.py /app/models

COPY app ./app

RUN useradd --system --uid 10001 face
USER face

ENV FACE_MODEL_DIR=/app/models
EXPOSE 8000
# One worker: the engine serialises model calls anyway, and each worker loads its own 38 MB model.
CMD ["uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "8000"]
