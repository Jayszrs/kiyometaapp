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
from threading import Lock, Semaphore

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from rapidocr_onnxruntime import RapidOCR
from prepare_models import model_path
from recognition import recognize_page

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s %(message)s",
)
log = logging.getLogger("kiyometa-ocr")

MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "3"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024
MAX_PAGE_PIXELS = int(os.environ.get("MAX_PAGE_PIXELS", "20000000"))
LOG_ENDPOINT_ENABLED = os.environ.get("OCR_LOG_ENDPOINT", "0") == "1"

app = FastAPI(title="Kiyometa Quotation OCR")

_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["POST", "GET", "OPTIONS"],
        allow_headers=["*"],
    )
# Unset CORS_ORIGINS means no CORS headers at all, so other origins are refused
# by the browser. The web app proxies same-origin and needs no CORS either.

_ocr: RapidOCR | None = None
_preview_ocr: RapidOCR | None = None
_japanese_ocr: RapidOCR | None = None
_inference_lock = Lock()
# Decoding happens before the inference lock, so queued requests would each hold
# a full rasterized document in memory. Admission control has to happen before
# the body is read, otherwise the queue is what exhausts RAM.
_slots = Semaphore(int(os.environ.get("OCR_MAX_CONCURRENT", "2")))


def get_ocr() -> RapidOCR:
    global _ocr
    if _ocr is None:
        path = model_path()
        if not path.is_file():
            raise RuntimeError("Japanese OCR model is missing. Run python prepare_models.py in ocr-service, then restart the service.")
        _ocr = RapidOCR(
            rec_model_path=str(path), rec_img_shape=[3, 48, 320],
            det_limit_side_len=1600, det_limit_type="max", max_side_len=4000,
            text_score=0.3, intra_op_num_threads=4, inter_op_num_threads=2,
        )
    return _ocr


def get_preview_ocr() -> RapidOCR:
    global _preview_ocr
    if _preview_ocr is None:
        # The bundled lightweight model only selects the page orientation.
        _preview_ocr = RapidOCR(det_limit_side_len=960, det_limit_type="max",
                               intra_op_num_threads=4, inter_op_num_threads=2)
    return _preview_ocr


def get_japanese_ocr() -> RapidOCR:
    global _japanese_ocr
    if _japanese_ocr is None:
        path = model_path("japan_PP-OCRv4_rec_mobile.onnx")
        if not path.is_file():
            raise RuntimeError("Japanese OCR model is missing. Run python prepare_models.py, then restart the service.")
        _japanese_ocr = RapidOCR(
            rec_model_path=str(path), rec_img_shape=[3, 48, 320],
            det_limit_side_len=1600, det_limit_type="max", max_side_len=4000,
            text_score=0.3, intra_op_num_threads=4, inter_op_num_threads=2,
        )
    return _japanese_ocr


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


def check_pixels(width: int, height: int, label: str) -> None:
    pixels = width * height
    if pixels > MAX_PAGE_PIXELS:
        raise ValueError(
            f"{label} is {width}x{height} pixels; the limit is {MAX_PAGE_PIXELS}. "
            "Scan at a lower resolution or split the document."
        )


def rasterize_pdf(data: bytes, dpi: int = 300) -> list[np.ndarray]:
    import pymupdf

    out: list[np.ndarray] = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        if len(doc) > MAX_PDF_PAGES:
            raise ValueError(f"PDF has {len(doc)} pages; the limit is {MAX_PDF_PAGES}. Split the file before scanning.")
        scale = max(72, min(dpi, 400))
        for page in doc:
            width_pt, height_pt = page.rect.width, page.rect.height
            check_pixels(int(width_pt * scale / 72), int(height_pt * scale / 72), f"PDF page at {scale}dpi")
            pix = page.get_pixmap(dpi=scale, colorspace=pymupdf.csRGB, alpha=False)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
            out.append(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    return out


def decode_image(data: bytes) -> np.ndarray:
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("Image exceeds the upload size limit.")
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unrecognized image format.")
    check_pixels(img.shape[1], img.shape[0], "Image")
    return img


def safe_name(raw: str) -> str:
    """Filenames come from the client and end up in logs and in the response.

    Truncating the whole string would drop the extension, which is what decides
    whether the upload is treated as a PDF, so the suffix is preserved.
    """
    cleaned = "".join(c if c.isprintable() else "_" for c in raw).strip() or "upload"
    if len(cleaned) <= 120:
        return cleaned
    stem, dot, suffix = cleaned.rpartition(".")
    if dot and len(suffix) <= 5:
        return stem[: 120 - len(suffix) - 1] + "." + suffix
    return cleaned[:120]


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/log")
def log_message(payload: LogIn) -> dict:
    if not LOG_ENDPOINT_ENABLED:
        raise HTTPException(status_code=404, detail="Not found")
    lines = payload.message.splitlines()[:200]
    for line in lines:
        log.info("[webapp] %s", line[:500])
    return {"ok": True}


@app.post("/ocr", response_model=OcrResponse)
def ocr(file: UploadFile = File(...), dpi: int = 300) -> OcrResponse:
    if not _slots.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="The OCR service is busy. Try again shortly.")
    try:
        return run_ocr(file, dpi)
    finally:
        _slots.release()


def run_ocr(file: UploadFile, dpi: int) -> OcrResponse:
    # Read one byte past the limit so an oversized body is detected without
    # buffering the whole thing.
    raw = file.file.read(MAX_UPLOAD_BYTES + 1) if file.file else None
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )

    name = safe_name(file.filename or "upload")
    is_pdf = name.lower().endswith(".pdf")
    log.info("OCR request: %s (%d bytes, %s)", name, len(raw), "pdf" if is_pdf else "image")
    try:
        if is_pdf:
            images = rasterize_pdf(raw, dpi)
            if not images:
                raise HTTPException(status_code=400, detail="PDF has no pages.")
            log.info("Rasterized %d page(s) at %ddpi", len(images), dpi)
        else:
            images = [decode_image(raw)]
            log.info("Decoded image %dx%d", images[0].shape[1], images[0].shape[0])
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        # A malformed PDF or image reaches the parsers as their own exception
        # types, which must not surface as a 500 with a traceback.
        log.warning("OCR decode failed for %s: %s: %s", name, type(exc).__name__, exc)
        raise HTTPException(status_code=400, detail="The file could not be read as a PDF or image.") from exc
    del raw

    lines: list[LineOut] = []
    for pi, img in enumerate(images):
        try:
            with _inference_lock:
                result, rotation = recognize_page(img, get_ocr(), get_japanese_ocr(), get_preview_ocr())
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        log.info("[ocr] page %d: rotated %d degrees counterclockwise", pi, rotation)
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
    lines.sort(key=lambda l: (l.page, l.y0, l.x0))
    log.info("OCR done: %d line(s) -> %s", len(lines), name)
    return OcrResponse(source=name, lines=lines)
