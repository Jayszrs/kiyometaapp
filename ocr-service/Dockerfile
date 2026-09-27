FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY prepare_models.py .
RUN python prepare_models.py
COPY main.py recognition.py ./

ENV CORS_ORIGINS=*
ENV MAX_PDF_PAGES=3

EXPOSE 8787
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8787"]
