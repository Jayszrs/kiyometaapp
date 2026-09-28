FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY prepare_models.py .
RUN python prepare_models.py
COPY main.py recognition.py ./

# CORS_ORIGINS is deliberately not set here: unset means no CORS headers, so
# only same-origin callers work. Set it at run time to the exact web origins,
# for example -e CORS_ORIGINS=https://kiyometa.app. The service refuses to boot
# on "*".
#
# The OCR routes verify a Supabase access token, so one of these must be set at
# run time or the service starts with authentication disabled and logs a
# warning: -e SUPABASE_JWT_SECRET=... or -e SUPABASE_JWKS_URL=...
ENV MAX_PDF_PAGES=3

EXPOSE 8787
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8787"]
