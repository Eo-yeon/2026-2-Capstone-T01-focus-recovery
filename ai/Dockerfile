# syntax=docker/dockerfile:1
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf-cache \
    EMBEDDING_MODEL_DIR=/models/qwen3-embedding \
    CONTEXT_MODEL_DIR=/models/qwen3-4b

WORKDIR /app

COPY requirements.txt .
# requirements.txt에 없는 API 서버 의존성(fastapi, uvicorn)을 함께 설치한다
RUN pip install -r requirements.txt fastapi "uvicorn[standard]"

COPY . .

# 모델 파일은 최초 실행 시 /models에 내려받으므로 볼륨으로 유지한다
VOLUME ["/models"]
EXPOSE 8000

# main.py의 reload=True는 개발용이므로 uvicorn을 직접 실행한다
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
