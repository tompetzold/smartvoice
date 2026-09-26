FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        libsndfile1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
COPY backend/requirements-docker.txt /app/backend/requirements-docker.txt

# Docker Desktop on Apple Silicon runs a Linux/aarch64 container.
# Install the official CPU-only PyTorch wheel explicitly so pip does not pull
# the CUDA/cuDNN Linux packages, which are useless inside this Mac container
# and add well over 1 GB to the download.
RUN python -m pip install --upgrade pip \
    && python -m pip install \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch==2.14.0" \
    && python -m pip install -r /app/backend/requirements-docker.txt

COPY backend /app/backend

WORKDIR /app/backend

EXPOSE 8001

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
