# Kiyometa OCR service

FastAPI service running RapidOCR (ONNX, CPU-only) that turns an uploaded
quotation/order image or PDF into text boxes for the web app's parser.

## API

- `GET /health` -> `{ ok: true }`
- `POST /ocr` (multipart `file`) -> `{ source, lines: OcrLine[] }`

OcrLine: `text`, `x0/y0`, `x1/y1` (px), `score` (0..1), `page` (PDF input only).

PDFs are rasterized with PyMuPDF at 300 DPI, max `MAX_PDF_PAGES` pages (default 3).

## Run

    cd ocr-service
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8787

Smoke test:

    curl.exe -F "file=@C:/Users/adel/Downloads/code/project/Kiyometa/record/quotation/⓪注文書-1.pdf" http://127.0.0.1:8787/ocr

## Docker

    docker build -t kiyometa-ocr ocr-service
    docker run -d --name kiyometa-ocr -p 8787:8787 \
      -e CORS_ORIGINS=https://app.example.com kiyometa-ocr

## Deployment

Plain FastAPI/uvicorn, runs anywhere. Point the web app at it with the
`VITE_OCR_URL` build-time env var, or reverse-proxy `/ocr` to this service so
the web app uses same-origin (then `CORS_ORIGINS` is only needed when the two
are on different origins; it defaults to `*`).

## Files

- `main.py` — FastAPI app: /health, /ocr
- `requirements.txt`
- `Dockerfile` — python:3.11-slim, port 8787