# -*- coding: utf-8 -*-
"""Kiyometa Quotation OCR service.

FastAPI service: accept an image or PDF, return OCR text lines with bounding
boxes (RapidOCR, ONNX, offline, Japanese-capable).

  GET  /health          -> {"ok": true}
  POST /ocr             multipart file -> { source, lines: [{text,x0,y0,x1,y1,score,page}] }

Env:
  CORS_ORIGINS  comma-separated allowed origins (default: *)
  MAX_PDF_PAGES max pages to OCR from a PDF (default: 3)

Run:  uvicorn main:app --host 0.0.0.0 --port 8787
"""

import logging
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from rapidocr_onnxruntime import RapidOCR

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s %(message)s",
)
log = logging.getLogger("kiyometa-ocr")

MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "3"))

app = FastAPI(title="Kiyometa Quotation OCR")

_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

_ocr: RapidOCR | None = None


def get_ocr() -> RapidOCR:
    global _ocr
    if _ocr is None:
        _ocr = RapidOCR()
    return _ocr


class LineOut(BaseModel):
    text: str
    x0: int
    y0: int
    x1: int
    y1: int
    score: float
    page: int


class OcrResponse(BaseModel):
    source: str
    lines: list[LineOut]


class LogIn(BaseModel):
    message: str = ""


def rasterize_pdf(data: bytes, dpi: int = 300) -> list[np.ndarray]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    out: list[np.ndarray] = []
    for i, page in enumerate(doc):
        if i >= MAX_PDF_PAGES:
            break
        pix = page.get_pixmap(dpi=max(72, min(dpi, 400)))
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if arr.ndim == 3 and arr.shape[2] == 4:
            arr = arr[:, :, :3]
        out.append(arr)
    return out


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unrecognized image format.")
    return img


def preprocess_for_ocr(img: np.ndarray) -> np.ndarray:
    """CLAHE + mild unsharp-mask so faint, low-contrast form text is detected."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img.copy()
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (0, 0), sigmaX=1.0)
    sharpened = cv2.addWeighted(enhanced, 1.5, blurred, -0.5, 0)
    return cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/log")
def log_message(payload: LogIn) -> dict:
    """Sink for the webapp's parse trace so the OCR -> parse flow shows here."""
    for line in payload.message.splitlines():
        log.info("[webapp] %s", line)
    return {"ok": True}


@app.post("/ocr", response_model=OcrResponse)
async def ocr(file: UploadFile = File(...), dpi: int = 300) -> OcrResponse:
    raw = await file.read() if file.file else None
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    name = (file.filename or "upload").lower()
    is_pdf = name.endswith(".pdf")
    log.info("OCR request: %s (%d bytes, %s)", file.filename, len(raw), "pdf" if is_pdf else "image")
    try:
        if is_pdf:
            images = rasterize_pdf(raw, dpi)
            if not images:
                raise HTTPException(status_code=400, detail="PDF has no pages.")
            log.info("Rasterized %d page(s) at %ddpi", len(images), dpi)
        else:
            images = [decode_image(raw)]
            log.info("Decoded image %dx%d", images[0].shape[1], images[0].shape[0])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    engine = get_ocr()
    lines: list[LineOut] = []
    for pi, img in enumerate(images):
        img_proc = preprocess_for_ocr(img)
        result, _ = engine(img_proc)
        if not result:
            log.info("[ocr] page %d: no text", pi)
            continue
        for box, text, score in result:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            x0, y0, x1, y1 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
            lines.append(
                LineOut(
                    text=text,
                    x0=x0,
                    y0=y0,
                    x1=x1,
                    y1=y1,
                    score=float(score),
                    page=pi,
                )
            )
            log.info(
                "[ocr] p%d x0=%-4d y0=%-4d x1=%-4d y1=%-4d conf=%.2f  %s",
                pi, x0, y0, x1, y1, float(score), text,
            )
    if not lines:
        raise HTTPException(status_code=422, detail="No recognizable text in the uploaded file.")
    lines.sort(key=lambda l: (l.y0, l.x0))
    log.info("OCR done: %d line(s) -> %s", len(lines), file.filename)
    return OcrResponse(source=name, lines=lines)