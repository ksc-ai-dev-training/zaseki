# asyncpg接続プール管理、SCHEMA定義（詳細設計書 2章 T-01〜）
import calendar
import json
import os
from datetime import date as Date, timedelta
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
    -- フロアマップ上の自由配置座標（エリアパネルに対する%、0〜100）。既存の固定レイアウト
    -- 83席はNULLのまま（FloorAreas.tsxの手作業配置を使う）。S-02の「座席配置モード」で
    -- 追加した座席のみ設定される。
    pos_x       DOUBLE PRECISION,
    pos_y       DOUBLE PRECISION,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 2026-08-27追加時点で既にseatsテーブルが存在する環境向け（CREATE TABLE IF NOT EXISTSは列追加をしないため）
ALTER TABLE seats ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION;
ALTER TABLE seats ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION;

-- T-04 fixed_seat_assignments。日次のreservation行は作らず、解除（A-21）は物理DELETEで表現する
CREATE TABLE IF NOT EXISTS fixed_seat_assignments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id     BIGINT NOT NULL UNIQUE REFERENCES seats(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    assigned_by BIGINT NOT NULL REFERENCES users(id),
    -- 任意の有効期限（FR-01-5、2026-08-28追加）。NULLは従来どおり無期限（変更するまで恒久的な割当）。
    -- 期限到来後の自動解除はrelease_expired_fixed_seats()が担う。
    valid_until DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE fixed_seat_assignments ADD COLUMN IF NOT EXISTS valid_until DATE;

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

-- T-09 recurring_rules（周期予約ルール。個別日の予約〔T-08〕はここから生成される）
CREATE TABLE IF NOT EXISTS recurring_rules (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id     BIGINT NOT NULL REFERENCES seats(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    -- 毎日は{"type":"daily"}、毎週・曜日複数選択は{"type":"weekly","weekdays":["tue","thu"]}
    pattern     JSONB NOT NULL,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    created_by  BIGINT NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- reservationsはrecurring_rulesより前に定義されているため、FK列は生成後にALTERで追加する
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS recurring_rule_id BIGINT REFERENCES recurring_rules(id);

-- T-05 projects
CREATE TABLE IF NOT EXISTS projects (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           VARCHAR(100) NOT NULL,
    proxy_user_id  BIGINT REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-06 project_members
CREATE TABLE IF NOT EXISTS project_members (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id             BIGINT NOT NULL REFERENCES projects(id),
    user_id                BIGINT NOT NULL REFERENCES users(id),
    project_title          VARCHAR(10) CHECK (project_title IN ('PM', 'PL', 'SL')),
    can_assign_seats       BOOLEAN NOT NULL DEFAULT false,
    seat_assign_granted_by BIGINT REFERENCES users(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);

-- T-07 project_quarter_plans。2026-08-27にarea_id/area_assigned_byを廃止した設計を反映（座席の島の
-- 割当で選んだ座席のarea_idから自明に決まるため、四半期計画自体にエリアを持たせる必要がない）
CREATE TABLE IF NOT EXISTS project_quarter_plans (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id         BIGINT NOT NULL REFERENCES projects(id),
    period_start       DATE NOT NULL,
    period_end         DATE NOT NULL,
    required_seats     INTEGER NOT NULL,
    weekdays_finalized JSONB,
    allocated_seats    JSONB,
    status             VARCHAR(20) NOT NULL DEFAULT 'seats_confirmed'
                       CHECK (status IN ('seats_confirmed', 'survey_open', 'weekdays_finalized', 'seats_allocated')),
    decided_by         BIGINT REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, period_start)
);

-- T-11 project_weekday_responses。1計画につき1回答（再送信はUPSERT、共通created_at/updated_atは持たない）
CREATE TABLE IF NOT EXISTS project_weekday_responses (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plan_id          BIGINT NOT NULL UNIQUE REFERENCES project_quarter_plans(id),
    responded_by     BIGINT NOT NULL REFERENCES users(id),
    choice1_weekdays JSONB NOT NULL,
    choice2_weekdays JSONB NOT NULL,
    note             TEXT,
    requested_seats  INTEGER,
    responded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-14 role_master。権限判定には一切使用しない（基本設計書4.2節）ラベルのみのマスタ
CREATE TABLE IF NOT EXISTS role_master (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    created_by  BIGINT NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-15 user_custom_roles。剥奪は物理DELETEで表現する（履歴性を求められていないため）
CREATE TABLE IF NOT EXISTS user_custom_roles (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id),
    role_master_id BIGINT NOT NULL REFERENCES role_master(id),
    assigned_by    BIGINT NOT NULL REFERENCES users(id),
    assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, role_master_id)
);

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


async def release_expired_fixed_seats() -> None:
    """有効期限（valid_until）を過ぎた固定座席の割当を自動解除し、座席をフリー座席に戻す（FR-01-5）。

    詳細設計書3.12節の「バッチ処理」は本来夜間バッチとして定義しているが、本プロジェクトの
    スコープでは実際のスケジューラ基盤の実装は対象外（同節参照）。そのため、固定座席の状態が
    実際に参照される主要な箇所（A-06空き状況取得・A-19固定座席一覧・A-09予約登録のRULE-07判定）
    の先頭でこの関数を呼び、遅延評価で同等の結果（期限切れ翌日には必ずフリー座席として扱われる）
    を得る。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            expired = await conn.fetch(
                "SELECT seat_id FROM fixed_seat_assignments WHERE valid_until IS NOT NULL AND valid_until < CURRENT_DATE"
            )
            if not expired:
                return
            seat_ids = [r["seat_id"] for r in expired]
            await conn.execute("UPDATE seats SET seat_type = 'free' WHERE id = ANY($1::bigint[])", seat_ids)
            await conn.execute("DELETE FROM fixed_seat_assignments WHERE seat_id = ANY($1::bigint[])", seat_ids)


async def project_blocked_seats(target_date: Date) -> dict[int, str]:
    """指定日時点でプロジェクト座席として専有されている座席（seat_id→プロジェクト名）。

    四半期の座席の島の割当（A-44）は前月25日までに決定するが、専有されるのはあくまで
    その四半期のperiod_start〜period_end期間中のみで、割当が決定した時点（それより前）は
    通常のフリー座席として予約できる（2026-08-28訂正。座席自体のseat_typeを恒久的に
    'project'へ変更する実装は誤りだったため撤回し、都度この関数で期間を判定する方式に変更）。"""
    rows = await get_pool().fetch(
        """SELECT pqp.allocated_seats, p.name
           FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.status = 'seats_allocated' AND $1 BETWEEN pqp.period_start AND pqp.period_end""",
        target_date,
    )
    result: dict[int, str] = {}
    for r in rows:
        if r["allocated_seats"]:
            for seat_id in json.loads(r["allocated_seats"]):
                result[seat_id] = r["name"]
    return result


_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def generate_recurring_reservations(
    seat_id: int, target_user_id: int, pattern: dict, start_date: Date, end_date: Date, created_by: int,
    *, enforce_rule05: bool, check_project_block: bool,
) -> dict:
    """A-10・A-18共通: T-09 recurring_rulesを1件作成し、該当する各日についてT-08予約を生成する
    （3.2節「周期予約の基本フロー」）。RULE-02（同一日複数のフリー座席予約禁止）・RULE-03（同一座席
    同一日の二重予約禁止）・RULE-07（固定座席保有者はフリー座席を予約不可）を各日について検証し、
    違反する日のみ除外する（違反しない日は登録する）。

    enforce_rule05: RULE-05（予約可能期間）を検証するか。A-10（一般利用者の自分自身の予約）はTrue、
    A-18（プロジェクト座席への確保）はプロジェクト座席専用の別サイクル・締切（3.4節）で運用されるため
    False（2026-08-28追加）。
    check_project_block: 対象日がT-07の座席の島の割当期間中であれば除外するか。A-10はTrue（他プロジェクトの
    専有座席を誤って予約できないように）、A-18はFalse（自分自身がその専有を作り出す側のため対象外）。

    戻り値: {"rule_id": ..., "results": [{"date": "YYYY-MM-DD", "status": "created"|"excluded", "reason": str|None}]}
    """
    pool = get_pool()
    weekdays = pattern.get("weekdays") if pattern.get("type") == "weekly" else None

    has_fixed_seat = await pool.fetchval(
        "SELECT 1 FROM fixed_seat_assignments WHERE user_id = $1", target_user_id
    )

    rule_id = await pool.fetchval(
        """INSERT INTO recurring_rules (seat_id, user_id, pattern, start_date, end_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id""",
        seat_id, target_user_id, json.dumps(pattern), start_date, end_date, created_by,
    )

    results: list[dict] = []
    d = start_date
    while d <= end_date:
        if weekdays is not None and _WEEKDAY_CODES[d.weekday()] not in weekdays:
            d += timedelta(days=1)
            continue

        reason = None
        if has_fixed_seat:
            reason = "固定座席が割り当てられているため、フリー座席は予約できません"
        elif enforce_rule05:
            if d < Date.today():
                reason = "過去の日付は予約できません"
            else:
                open_date = await free_seat_open_date(d)
                if Date.today() < open_date:
                    reason = f"この座席は{open_date.month}月{open_date.day}日から予約できます"
        if reason is None and check_project_block:
            blocked = await project_blocked_seats(d)
            if seat_id in blocked:
                reason = f"この座席は{blocked[seat_id]}のプロジェクト座席として確保されているため予約できません"
        if reason is None:
            duplicate = await pool.fetchval(
                """SELECT 1 FROM reservations r JOIN seats s ON s.id = r.seat_id
                   WHERE r.user_id = $1 AND r.date = $2 AND r.status = 'active' AND s.seat_type = 'free'""",
                target_user_id, d,
            )
            if duplicate:
                reason = "同じ日に複数の座席は予約できません"

        if reason is not None:
            results.append({"date": d.isoformat(), "status": "excluded", "reason": reason})
            d += timedelta(days=1)
            continue
        try:
            await pool.execute(
                """INSERT INTO reservations (seat_id, user_id, date, created_by, recurring_rule_id)
                   VALUES ($1, $2, $3, $4, $5)""",
                seat_id, target_user_id, d, created_by, rule_id,
            )
            results.append({"date": d.isoformat(), "status": "created", "reason": None})
        except asyncpg.UniqueViolationError:
            results.append({"date": d.isoformat(), "status": "excluded", "reason": "この座席はすでに予約されています"})
        d += timedelta(days=1)

    return {"rule_id": rule_id, "results": results}


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
