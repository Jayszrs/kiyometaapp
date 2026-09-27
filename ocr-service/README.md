# Kiyometa OCR service

CPU OCR for Japanese quotations and purchase orders. Returns text plus page-local
bounding boxes; `webapp/src/lib/parseQuotation.ts` maps Japanese field labels to
the application fields.

## Install and run

```sh
cd ocr-service
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python prepare_models.py
./.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

`prepare_models.py` fetches two pinned, SHA256-verified recognizers (~27 MB) from
RapidAI's ModelScope repo. Run it before first start. Recognition is local at
runtime and never downloads models or sends documents anywhere.

- PP-OCRv5 multilingual: dates, prices, postcodes, Latin order/drawing numbers.
- PP-OCRv4 Japanese: kana, company names, process names.
- Disagreement between the two readings caps confidence so the web app flags the
  field for review.

## API

| Route | Purpose |
| --- | --- |
| `GET /health` | `{"ok": true}` |
| `POST /ocr` | multipart `file` -> `{ source, lines }` |
| `POST /log` | parser trace from the web app (diagnostics) |

Each line: `text`, `x0`, `y0`, `x1`, `y1`, `score`, zero-based `page`. Coordinates
refer to the upright page; whole-page rotation is detected before extraction.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `OCR_MODEL_DIR` | `ocr-service/models` | Model directory |
| `MAX_PDF_PAGES` | `3` | PDFs above this are rejected, not truncated |
| `CORS_ORIGINS` | `*` | Restrict to the web app origin in production |

## Deployment (BSD / Linux VPS)

The web app is static; this service is a separate long-running process. The web
app's `ocrClient.ts` falls back to `window.location.origin`, so when the proxy
below is in place no frontend configuration is needed and there is no CORS.

Run it as a supervised service, bound to localhost:

```sh
./.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

`127.0.0.1` only. Do not bind `0.0.0.0`; the port must not be reachable directly.

nginx:

```nginx
client_max_body_size 25m;

location /ocr {
    proxy_pass http://127.0.0.1:8787;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
}
```

`client_max_body_size` must be raised: the default is 1 MB and scanned PDFs
exceed it. `proxy_read_timeout` must cover a 3-page CPU run (~30-90 s).

Autodeploy needs one extra step after `git pull`:

```sh
cd ocr-service && ./.venv/bin/pip install -q -r requirements.txt
```

Requirements: ~2 GB free RAM for the two recognizers plus page buffers, and a
single worker process. Multiple workers each load their own copy of the models.

## Docker

```sh
docker build -t kiyometa-ocr ocr-service
docker run --rm -p 127.0.0.1:8787:8787 -e CORS_ORIGINS=https://app.example.com kiyometa-ocr
```

Models are downloaded and checksum-verified during the build.

## Verification

```sh
cd webapp && npm test && npx tsc --noEmit && npm run build
cd ocr-service && python -m unittest discover -s tests
```

`webapp/tests/fixtures` holds real OCR output from the two reference PDFs. The
Python tests cover rotation, merged readings, upload failures and page limits
without model downloads.
