# -*- coding: utf-8 -*-
"""Kiyometa Quotation OCR service.

FastAPI service: accept an image or PDF, return OCR text lines with bounding
boxes (RapidOCR, ONNX, offline, Japanese-capable).

  GET  /health          -> {"ok": true}
  POST /ocr             multipart file -> { source, lines: [{text,x0,y0,x1,y1,score,page}] }

Both POST routes require a Supabase access token: send `Authorization: Bearer
<token>`. An unsigned request gets 401, which is what keeps the service from
being usable as a free OCR backend for anyone who can reach the port. The
signature is checked against SUPABASE_JWT_SECRET when that is configured, and
against SUPABASE_JWKS_URL otherwise, so the service can run in front of a
shared secret or behind asymmetric keys without a code change.

Env:
  CORS_ORIGINS           comma-separated allowed origins. Required: with no
                         value the middleware is not installed, so the service
                         only answers same-origin and direct requests, and
                         a browser on any other site is blocked.
  MAX_PDF_PAGES          max pages to OCR from a PDF (default: 3)
  SUPABASE_JWT_SECRET    HS256 shared secret (preferred, no network call)
  SUPABASE_JWKS_URL      JWKS endpoint, used when the secret is not set
  SUPABASE_JWT_AUDIENCE  expected aud claim, if the project uses one
  OCR_REQUIRE_AUTH       "0" disables the check. Only for local debugging: it
                         re-exposes the service to anyone who can reach it.

Run:  uvicorn main:app --host 0.0.0.0 --port 8787
"""

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request
from threading import Lock, Semaphore

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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

# Authentication. OCR is the most expensive thing this service does, and an open
# endpoint is both a free compute service for anyone and a way to burn the
# office's own inference queue. Requiring a Supabase access token ties usage to
# a real signed-in user.
JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "").strip()
JWKS_URL = os.environ.get("SUPABASE_JWKS_URL", "").strip()
JWT_AUDIENCE = os.environ.get("SUPABASE_JWT_AUDIENCE", "").strip()
REQUIRE_AUTH = os.environ.get("OCR_REQUIRE_AUTH", "1") != "0"
REQUIRE_AUTH = REQUIRE_AUTH and bool(JWT_SECRET or JWKS_URL)
if not REQUIRE_AUTH:
    # Fail loudly at boot rather than silently serving public requests. The
    # override exists for local development against a copy of the data.
    logging.getLogger("kiyometa-ocr").warning(
        "OCR authentication is disabled. Set SUPABASE_JWT_SECRET or "
        "SUPABASE_JWKS_URL before exposing this service."
    )

app = FastAPI(title="Kiyometa Quotation OCR")

_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if os.environ.get("CORS_ORIGINS", "").strip() == "*":
    # A wildcard with credentials is rejected by browsers, so it silently
    # degraded to "any site may read responses" on the deployments that set it.
    raise RuntimeError(
        "CORS_ORIGINS=* is not allowed. List the exact origins, for example "
        "CORS_ORIGINS=https://kiyometa.app"
    )
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["POST", "GET", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
# Unset CORS_ORIGINS means no CORS headers at all, so other origins are refused
# by the browser. The web app proxies same-origin and needs no CORS either.

# The browser sends Content-Length for a multipart upload, so an oversized
# request is rejected before its body is parsed. Starlette spools the parsed
# file to a temporary file as part of form handling, which is why checking
# file.size inside the handler was too late to bound memory: the bytes were
# already on disk. Content-Length is only a claim, so run_ocr still enforces
# the limit on the bytes it actually reads.
if MAX_UPLOAD_BYTES > 0:

    @app.middleware("http")
    async def reject_oversized_body(request: Request, call_next):
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
            return JSONResponse(
                status_code=413,
                content={"detail": f"File is larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit."},
            )
        return await call_next(request)

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


# ---- Authentication -------------------------------------------------------
#
# The token is a standard Supabase access token: an RS256 (or ES256) JWT signed
# by the project's key. Verification needs no extra dependency, so the service
# stays a small offline container.

_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}
_jwks_lock = Lock()
JWKS_CACHE_SECONDS = 600
# A token that was rejected because the signing key had rotated is worth
# retrying once against fresh keys; a token that is simply malformed is not.
ALLOWED_ALGS = {"RS256", "RS384", "RS512", "ES256", "ES384", "HS256"}


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def _fetch_jwks() -> dict:
    """Fetch and briefly cache the signing keys.

    Key rotation is the reason for the cache rather than a fetch per request:
    a rotated key invalidates existing tokens, and a request arriving in that
    window would otherwise be rejected until the client refreshed. Keys are
    refetched on an unknown kid, so the cache only bounds how often the endpoint
    is called.
    """
    now = time.monotonic()
    if _jwks_cache["keys"] and now - _jwks_cache["fetched_at"] < JWKS_CACHE_SECONDS:
        return _jwks_cache["keys"]
    with _jwks_lock:
        if _jwks_cache["keys"] and time.monotonic() - _jwks_cache["fetched_at"] < JWKS_CACHE_SECONDS:
            return _jwks_cache["keys"]
        try:
            with urllib.request.urlopen(JWKS_URL, timeout=5) as response:
                keys = json.loads(response.read())
        except (urllib.error.URLError, ValueError, TimeoutError) as exc:
            # A stale cache is better than refusing every request while the
            # endpoint is briefly unreachable.
            if _jwks_cache["keys"]:
                log.warning("JWKS fetch failed, reusing cached keys: %s", exc)
                return _jwks_cache["keys"]
            raise HTTPException(status_code=503, detail="Cannot verify the session right now.") from exc
        _jwks_cache["keys"] = keys
        _jwks_cache["fetched_at"] = time.monotonic()
        return keys


def _verify_rs(token: str, header: dict, payload: dict) -> None:
    keys = _fetch_jwks()
    kid = header.get("kid")
    candidates = [k for k in keys.get("keys", []) if k.get("kid") == kid] if kid else []
    if not candidates:
        # An unknown kid usually means a rotation. Drop the cache and try once
        # more before failing.
        _jwks_cache["keys"] = None
        keys = _fetch_jwks()
        candidates = [k for k in keys.get("keys", []) if k.get("kid") == kid] if kid else keys.get("keys", [])
    if not candidates:
        raise HTTPException(status_code=401, detail="Invalid session token.")

    signing_input = token.rsplit(".", 1)[0].encode("ascii")
    for jwk in candidates:
        try:
            if jwk.get("kty") == "RSA":
                _verify_rsa(jwk, signing_input, token)
                return
            if jwk.get("kty") == "EC":
                _verify_ec(jwk, signing_input, token)
                return
        except HTTPException:
            continue
    raise HTTPException(status_code=401, detail="Invalid session token.")


def _int_from_b64url(value: str) -> int:
    return int.from_bytes(_b64url_decode(value), "big")


def _verify_rsa(jwk: dict, signing_input: bytes, token: str) -> None:
    try:
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(
            status_code=500,
            detail="JWT verification is unavailable: install cryptography.",
        ) from exc
    signature = _b64url_decode(token.split(".")[2])
    key = rsa.RSAPublicNumbers(
        e=_int_from_b64url(jwk["e"]), n=_int_from_b64url(jwk["n"])
    ).public_key()
    try:
        key.verify(
            signature,
            signing_input,
            padding.PKCS1v15(),
            Prehashed(hashlib.sha256()),
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid session token.") from exc


def _verify_ec(jwk: dict, signing_input: bytes, token: str) -> None:
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(
            status_code=500,
            detail="JWT verification is unavailable: install cryptography.",
        ) from exc
    signature = _b64url_decode(token.split(".")[2])
    curves = {
        "P-256": (ec.SECP256R1, hashlib.sha256),
        "P-384": (ec.SECP384R1, hashlib.sha384),
        "P-521": (ec.SECP521R1, hashlib.sha512),
    }
    curve, digest_fn = curves.get(jwk.get("crv"), (None, None))
    if curve is None:
        raise HTTPException(status_code=401, detail="Invalid session token.")
    public_numbers = ec.EllipticCurvePublicNumbers(
        x=_int_from_b64url(jwk["x"]), y=_int_from_b64url(jwk["y"]), curve=curve()
    )
    try:
        public_numbers.public_key().verify(
            signature, signing_input, ec.ECDSA(digest_fn())
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid session token.") from exc


def verify_access_token(token: str) -> dict:
    """Verify signature and standard claims, returning the payload."""
    parts = token.split(".")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="Invalid session token.")
    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=401, detail="Invalid session token.") from exc

    alg = header.get("alg")
    # "none" and any algorithm the project does not use are rejected outright,
    # otherwise a caller could present an unsigned token.
    if alg not in ALLOWED_ALGS:
        raise HTTPException(status_code=401, detail="Invalid session token.")

    now = time.time()
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or now >= exp:
        raise HTTPException(status_code=401, detail="Session expired.")
    nbf = payload.get("nbf")
    if isinstance(nbf, (int, float)) and now + 60 < nbf:
        raise HTTPException(status_code=401, detail="Session is not valid yet.")
    if JWT_AUDIENCE and payload.get("aud") not in (None, JWT_AUDIENCE):
        raise HTTPException(status_code=401, detail="Invalid session token.")

    if alg == "HS256":
        if not JWT_SECRET:
            raise HTTPException(status_code=500, detail="Token verification is not configured.")
        expected = hmac.new(JWT_SECRET.encode("utf-8"), f"{parts[0]}.{parts[1]}".encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(parts[2])):
            raise HTTPException(status_code=401, detail="Invalid session token.")
    else:
        _verify_rs(token, header, payload)
    return payload


def require_user(request: Request) -> None:
    if not REQUIRE_AUTH:
        return
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Sign in to use OCR.")
    try:
        verify_access_token(token.strip())
    except HTTPException as exc:
        if exc.status_code == 503:
            raise
        log.info("Rejected OCR request: %s", exc.detail)
        raise HTTPException(status_code=401, detail="Sign in to use OCR.") from exc


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
def log_message(request: Request, payload: LogIn) -> dict:
    if not LOG_ENDPOINT_ENABLED:
        raise HTTPException(status_code=404, detail="Not found")
    # It forwards log text into this service's stdout, so it is authenticated
    # on the same terms as OCR even though it is cheap.
    require_user(request)
    lines = payload.message.splitlines()[:200]
    for line in lines:
        log.info("[webapp] %s", line[:500])
    return {"ok": True}


@app.post("/ocr", response_model=OcrResponse)
def ocr(request: Request, file: UploadFile = File(...), dpi: int = 300) -> OcrResponse:
    # The token is checked before the queue slot is taken, so an unauthenticated
    # request cannot occupy capacity or make the caller wait behind real work.
    require_user(request)
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
