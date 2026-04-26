#!/usr/bin/env bash
# Render Node 환경에서 Python 의존성을 함께 설치하는 빌드 스크립트.
# Render 대시보드 Build Command를 `bash build.sh`로 설정해 사용한다.
set -euo pipefail

echo "==> Node deps (server.js는 표준 라이브러리만 사용, package.json deps 비어있음)"
# npm install은 deps 없으므로 사실상 no-op이지만 호환성을 위해 호출
npm install --omit=dev || true

echo "==> Python 버전 확인"
python3 --version || { echo "python3 not found on Render Node image"; exit 1; }

echo "==> pip 업그레이드"
python3 -m pip install --upgrade pip --break-system-packages 2>/dev/null \
  || python3 -m pip install --upgrade pip --user 2>/dev/null \
  || python3 -m pip install --upgrade pip

echo "==> Python 의존성 설치 (trading-system/requirements.txt)"
# PEP 668(Externally-managed) 환경에서도 동작하도록 폴백 체인
python3 -m pip install --no-cache-dir --break-system-packages -r trading-system/requirements.txt 2>/dev/null \
  || python3 -m pip install --no-cache-dir --user -r trading-system/requirements.txt 2>/dev/null \
  || python3 -m pip install --no-cache-dir -r trading-system/requirements.txt

echo "==> 설치 검증"
python3 -c "import numpy, pandas, scipy, matplotlib, yfinance; print('OK', numpy.__version__, pandas.__version__)"

echo "==> 빌드 완료"
