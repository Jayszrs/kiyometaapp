FROM kiyometa-ocr:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      libxcb1 libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*
