# syntax=docker/dockerfile:1
# Node.js + Python 3 통합 이미지 (Render Docker 환경에서 사용)
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    MPLBACKEND=Agg \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 가상환경 + 의존성 (캐시 레이어)
COPY trading-system/requirements.txt /app/trading-system/requirements.txt
RUN python3 -m venv /app/trading-system/venv \
 && /app/trading-system/venv/bin/pip install --upgrade pip \
 && /app/trading-system/venv/bin/pip install -r /app/trading-system/requirements.txt

# 애플리케이션 소스 (server.js는 Node 표준 라이브러리만 사용 → npm install 불필요)
COPY . /app

ENV TRADING_PYTHON=/app/trading-system/venv/bin/python3 \
    TRADING_SCRIPT=/app/trading-system/trading_system.py \
    PORT=10000

EXPOSE 10000
CMD ["node", "server.js"]
