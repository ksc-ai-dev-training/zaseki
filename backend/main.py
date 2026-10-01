# FastAPIアプリ生成、ルーター登録、SPA配信設定（基本設計書1.3節・1.5節）
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import database
import sheets_export
from routers import admin, auth, feedback, fixed_seats, profile, project_pm, project_seats, proxy, reservations, roles, seat_master, seats
from ws_manager import manager as ws_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    await database.init_pool()
    # 障害時バックアップ用のスプレッドシート自動反映（詳細設計書3.14節、2026-10-01追加）。
    # GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON等が未設定の環境（ローカル開発等）ではタスク内部で
    # 即座に終了するだけで、アプリ本体の起動は妨げない（sheets_export.daily_export_loop参照）
    export_task = asyncio.create_task(sheets_export.daily_export_loop())
    yield
    export_task.cancel()
    await database.close_pool()


app = FastAPI(title="Zaseki API", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(seats.router)
app.include_router(reservations.router)
app.include_router(admin.router)
app.include_router(fixed_seats.router)
app.include_router(seat_master.router)
app.include_router(seat_master.areas_router)
app.include_router(proxy.router)
app.include_router(roles.router)
app.include_router(project_seats.router)
app.include_router(project_pm.router)
app.include_router(profile.router)
app.include_router(profile.public_router)
app.include_router(feedback.router)


# A-89: 座席の空き状況に影響しうる書き込み系APIが成功した直後、接続中のクライアントへ
# WebSocketで「空き状況を取り直してください」と合図する（2026-09-28追加。ws_manager.py参照）。
# エンドポイントごとに個別にブロードキャスト呼び出しを埋め込むのではなく、対象パスへの
# 書き込み系リクエスト（POST/PUT/PATCH/DELETE）が2xx/3xxで成功した場合に一律で発火させる
# ミドルウェア方式にした。エンドポイントを追加・変更するたびにブロードキャスト呼び出しを
# 個別に足し忘れる不具合を防ぐのが狙い（新しく増える座席関連のAPIも、このいずれかのパス配下に
# 置く限り自動的に対象になる）。多少発火対象が広め（例: 曜日確定・備考欄の変更等、実際には
# フロアマップの表示に影響しない更新も含む）だが、クライアント側は単に無害な再取得を行うだけの
# ため実害はない。
_AVAILABILITY_AFFECTING_PATH_PREFIXES = (
    "/api/reservations",
    "/api/seats",
    "/api/fixed-seat-assignments",
    "/api/project-quarter-plans",
)


@app.middleware("http")
async def broadcast_availability_changes(request: Request, call_next):
    response = await call_next(request)
    if (
        request.method in ("POST", "PUT", "PATCH", "DELETE")
        and response.status_code < 400
        and request.url.path.startswith(_AVAILABILITY_AFFECTING_PATH_PREFIXES)
    ):
        await ws_manager.broadcast_availability_changed()
    return response


@app.websocket("/ws/availability")
async def availability_ws(websocket: WebSocket):
    """A-89: 座席の空き状況の変更通知専用WebSocket。認証は行わず（送るのは「変わった」という
    合図のみで実データを含まないため）、接続を維持するだけでよい。クライアントからのメッセージは
    無視し、切断を検知したら登録を解除する。"""
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """デプロイ先のヘルスチェック用。DBまで疎通しているかを確認する"""
    try:
        await database.get_pool().fetchval("SELECT 1")
    except Exception:
        return JSONResponse(status_code=503, content={"status": "unhealthy"})
    return {"status": "ok", "env": database.APP_ENV}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": "サーバーエラーが発生しました"})


# --- フロントエンドの静的配信（基本設計書1.3節。本番はSPAをFastAPIが配信する） ---
# frontend/dist があるときだけ有効。ローカル開発では Vite が配信するため通常は存在しない。
BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIST = Path(
    database.ROOT_ENV.get("FRONTEND_DIST", "")
    or BACKEND_DIR.parent / "frontend" / "dist"
)

if FRONTEND_DIST.is_dir():
    _INDEX_HTML = FRONTEND_DIST / "index.html"
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPAフォールバック。/api 配下以外はビルド済みの index.html を返し、
        クライアントサイドルーティング（react-router）に委ねる。"""
        if full_path.startswith("api/"):
            raise HTTPException(404, detail="Not Found")
        candidate = (FRONTEND_DIST / full_path).resolve()
        # ディレクトリトラバーサル対策: dist配下に収まる実在ファイルのみ直接返す
        if full_path and candidate.is_file() and candidate.is_relative_to(FRONTEND_DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(_INDEX_HTML)


if __name__ == "__main__":
    # `python main.py` で起動する場合もルートの .env の BACKEND_PORT を反映する
    import os

    import uvicorn

    port = int(database.ROOT_ENV.get("BACKEND_PORT") or os.environ.get("BACKEND_PORT", "8020"))
    uvicorn.run("main:app", port=port, reload=True)
