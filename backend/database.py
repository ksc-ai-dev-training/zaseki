# asyncpg接続プール管理、SCHEMA定義（詳細設計書 2章 T-01〜）
import calendar
import os
from datetime import date as Date
from pathlib import Path

import asyncpg


def load_root_env() -> dict[str, str]:
    """リポジトリルートの .env（DB_PORT / BACKEND_PORT 等）を読む。環境変数が優先"""
    env: dict[str, str] = {}
    path = Path(__file__).resolve().parent.parent / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


ROOT_ENV = load_root_env()

_db_port = os.environ.get("DB_PORT") or ROOT_ENV.get("DB_PORT", "55432")
DATABASE_URL = (
    os.environ.get("DATABASE_URL")
    or ROOT_ENV.get("DATABASE_URL")
    or f"postgresql://zaseki:zaseki@localhost:{_db_port}/zaseki"
)

# 本番（マネージドPostgreSQL）は自動マイグレーションを行わず、SCHEMA は手動適用する。
# 起動のたびに CREATE TABLE を流さないよう APP_ENV=production では抑止する
APP_ENV = os.environ.get("APP_ENV") or ROOT_ENV.get("APP_ENV", "development")
AUTO_MIGRATE = (
    os.environ.get("AUTO_MIGRATE") or ROOT_ENV.get("AUTO_MIGRATE") or ("0" if APP_ENV == "production" else "1")
) == "1"

_pool: asyncpg.Pool | None = None

# T-01・T-02・T-03・T-08・T-16（S-01ログイン、S-02空き状況・予約のコア部分に必要な範囲）。
# 以降の画面を実装するたびにテーブルを追加する。
SCHEMA = """
-- T-01 users
CREATE TABLE IF NOT EXISTS users (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email              VARCHAR(255) NOT NULL UNIQUE,
    last_name          VARCHAR(50) NOT NULL,
    first_name         VARCHAR(50) NOT NULL,
    employee_code      VARCHAR(20),
    employment_type    VARCHAR(10) NOT NULL DEFAULT 'employee'
                       CHECK (employment_type IN ('employee', 'contract', 'bp')),
    role               VARCHAR(10) NOT NULL DEFAULT 'general'
                       CHECK (role IN ('general', 'admin')),
    area_manager_role  VARCHAR(10)
                       CHECK (area_manager_role IN ('manager', 'deputy')),
    employment_status  VARCHAR(10) NOT NULL DEFAULT 'active'
                       CHECK (employment_status IN ('active', 'leave', 'retired')),
    deleted_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-02 areas
CREATE TABLE IF NOT EXISTS areas (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(10) NOT NULL UNIQUE
                CHECK (name IN ('NORTH', 'EAST', 'WEST')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-03 seats
CREATE TABLE IF NOT EXISTS seats (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_no     VARCHAR(10) NOT NULL UNIQUE,
    area_id     BIGINT NOT NULL REFERENCES areas(id),
    seat_type   VARCHAR(10) NOT NULL DEFAULT 'free'
                CHECK (seat_type IN ('free', 'fixed', 'project')),
    status      VARCHAR(10) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'retired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-08 reservations
CREATE TABLE IF NOT EXISTS reservations (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id     BIGINT NOT NULL REFERENCES seats(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    date        DATE NOT NULL,
    created_by  BIGINT NOT NULL REFERENCES users(id),
    status      VARCHAR(10) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'cancelled')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_seat_date_active
    ON reservations (seat_id, date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_reservations_user_id ON reservations (user_id);

-- T-16 app_settings
CREATE TABLE IF NOT EXISTS app_settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def _pool_kwargs() -> dict:
    """接続先に応じた asyncpg のオプションを組み立てる（Keireki踏襲。トランザクションプーラー対策）"""
    kwargs: dict = {"min_size": 1, "max_size": int(os.environ.get("DB_POOL_MAX", "10"))}
    is_transaction_pooler = ":6543" in DATABASE_URL or "pgbouncer=true" in DATABASE_URL
    if os.environ.get("DB_DISABLE_STATEMENT_CACHE", "1" if is_transaction_pooler else "0") == "1":
        kwargs["statement_cache_size"] = 0
    return kwargs


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, **_pool_kwargs())
        if AUTO_MIGRATE:
            async with _pool.acquire() as conn:
                await conn.execute(SCHEMA)
    return _pool


def get_pool() -> asyncpg.Pool:
    assert _pool is not None, "init_pool() が呼ばれていません"
    return _pool


async def get_setting(key: str) -> str | None:
    """T-16 app_settingsから設定値を取得する"""
    return await get_pool().fetchval("SELECT value FROM app_settings WHERE key = $1", key)


async def free_seat_open_date(target: Date) -> Date:
    """RULE-05: フリー座席は対象日が属する月の前月26日以降でなければ予約できない。
    A-09（単発予約登録）・A-07（期間ビュー）の両方が使う共通ルールのためここに置く。"""
    open_day = int(await get_setting("free_seat_open_day") or "26")
    prior_year, prior_month = (target.year, target.month - 1) if target.month > 1 else (target.year - 1, 12)
    return Date(prior_year, prior_month, open_day)


async def free_seat_bookable_period() -> tuple[Date, Date]:
    """RULE-05に基づく「現時点で予約可能な期間全体」（期間ビューの既定表示範囲、FR-04-4）。
    当月分は前月26日時点で常に開放済みのため必ず含まれ、当日が当月の確保開始日（既定26日）
    以降であれば翌月分も開放されるためそこまで延長する。"""
    today = Date.today()
    open_day = int(await get_setting("free_seat_open_day") or "26")
    start = await free_seat_open_date(today)
    end_month_date = today
    if today.day >= open_day:
        end_month_date = Date(today.year + 1, 1, 1) if today.month == 12 else Date(today.year, today.month + 1, 1)
    last_day = calendar.monthrange(end_month_date.year, end_month_date.month)[1]
    end = Date(end_month_date.year, end_month_date.month, last_day)
    return start, end


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
