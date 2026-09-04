# Fly.io デプロイ用イメージ。フロントエンドを vite build し、FastAPI が単一プロセスで
# 静的配信するSPA構成の単一コンテナ（Dockerfileクイックスタート2章「フロントとバックを
# 1つのコンテナにまとめる」方針。手本のKeirekiと同じ構成）。

# --- ステージ1: フロントエンドのビルド ---
FROM node:22-slim AS frontend
WORKDIR /app/frontend
# 依存関係だけ先にコピーしてインストールする。ソースコードだけを直した場合は
# このレイヤがキャッシュされ、npm ci をやり直さずに済む（ビルドが速くなる）
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- ステージ2: バックエンド（最終的にこのステージだけがコンテナとして実行される） ---
FROM python:3.12-slim AS runtime
WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
# ステージ1でビルドしたReactの静的ファイル（frontend/dist）をコピーする。
# backend/main.py はここが存在するときだけ静的配信を有効にする
COPY --from=frontend /app/frontend/dist ./frontend/dist

ENV APP_ENV=production \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend
EXPOSE 8000
# PORTはデプロイ先（Fly.io）が起動時に渡す環境変数。固定値は書かず、必ずここで読む
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
