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


# RULE-02（同一日複数予約禁止）の拒否メッセージ。reservations.py（A-09）・proxy.py（A-47）が
# HTTPExceptionのdetailとして、本ファイルの_check_and_book_day・generate_recurring_reservationsが
# 除外理由（reason）として、それぞれこの文字列を使う。従来は4箇所に同じ文字列がハードコードされて
# おり、Availability.tsxの「変更する」ボタンはこの文言と完全一致するかどうかでのみ表示可否を
# 判定していたため、どこか1箇所でも文言を変えると気づかれないままボタンが出なくなる不具合の
# 原因になっていた。定数化して4箇所を集約し、フロント側の一致対象も1箇所のコメントで明示する
# （2026-09-09追加）。
DUPLICATE_SEAT_MESSAGE = "同じ日に複数の座席は予約できません"

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
    -- マイプロフィール（S-12、FR-08-1〜2、2026-08-31追加）。いずれも任意項目で、本人のみが
    -- 自分の行を更新できる（A-57）。avatar_imageは外部ストレージを使わず、アップロードされた
    -- 画像をBase64エンコードしたdata URLとしてそのまま保持する簡易実装。誕生日は月日のみ保存し
    -- 年は保存しない（誕生日判定に年は不要、他利用者にも見える情報のためプライバシーに配慮）。
    avatar_image       TEXT,
    birth_month        SMALLINT CHECK (birth_month BETWEEN 1 AND 12),
    birth_day          SMALLINT CHECK (birth_day BETWEEN 1 AND 31),
    -- システム運用担当（FR-09-3、2026-09-01追加）。「フィードバック一覧は管理部ではなくシステムを
    -- 運用している人に見せたい」との要望を受けた。role='admin'（管理部、業務上の役割）とは独立した
    -- 属性とし、area_manager_role同様、S-08「利用者ロール管理」で管理部が任意の利用者に付与する
    is_system_operator BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_month SMALLINT CHECK (birth_month BETWEEN 1 AND 12);
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_day SMALLINT CHECK (birth_day BETWEEN 1 AND 31);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system_operator BOOLEAN NOT NULL DEFAULT false;

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

-- T-04 fixed_seat_assignments。日次のreservation行は作らず、変更・解除（A-20・A-21）も
-- 物理DELETEはしない（2026-09-04変更。以前は物理DELETEで表現していたが、過去日の空き状況
-- 照会〔A-06・A-07・A-45〕が常に「今の」割当を参照する作りと組み合わさり、固定座席を変更・解除
-- すると過去の表示まで書き換わってしまう不具合があったため、割当の履歴を残す方式に改めた）。
-- 1つの座席には割当の履歴が複数残り得るため、seat_id単体のUNIQUEではなく、
-- 「現在有効な割当（ended_on IS NULL）は座席1つにつき1件まで」という部分ユニーク索引で表現する。
CREATE TABLE IF NOT EXISTS fixed_seat_assignments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id     BIGINT NOT NULL REFERENCES seats(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    assigned_by BIGINT NOT NULL REFERENCES users(id),
    -- この割当が有効になった日（2026-09-04追加。過去日照会でこの日より前は対象外にする）
    valid_from  DATE NOT NULL DEFAULT CURRENT_DATE,
    -- 任意の有効期限（FR-01-5、2026-08-28追加）。NULLは変更・解除されるまで無期限。
    -- 期限到来後の自動解除はrelease_expired_fixed_seats()が担う（ended_onに反映される）。
    valid_until DATE,
    -- この割当が実際に終了した日（2026-09-04追加）。NULLはまだ有効中。変更・解除（A-20・A-21）で
    -- 「昨日まで」に設定するほか、release_expired_fixed_seats()がvalid_until到来を検知した時点で
    -- valid_untilと同じ値を設定する。「現在有効な割当」はended_on IS NULLで判定する。
    ended_on    DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE fixed_seat_assignments ADD COLUMN IF NOT EXISTS valid_until DATE;
ALTER TABLE fixed_seat_assignments ADD COLUMN IF NOT EXISTS valid_from DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE fixed_seat_assignments ADD COLUMN IF NOT EXISTS ended_on DATE;
-- 2026-09-04より前に作られた環境ではseat_id列にUNIQUE制約が付いているため、履歴を複数持てるよう外す
ALTER TABLE fixed_seat_assignments DROP CONSTRAINT IF EXISTS fixed_seat_assignments_seat_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS fixed_seat_assignments_active_seat
    ON fixed_seat_assignments (seat_id) WHERE ended_on IS NULL;

-- T-18 fixed_seat_absences（2026-09-08追加）。固定座席の割当（T-04）自体は解除せず、特定の1日だけ
-- その座席を空ける（「S-11の取消が割当ごと削除されてしまう、1日分だけ取り消したい」との要望を
-- 受けた。A-21のDELETE /fixed-seat-assignments/{seat_id}にdateを指定すると、この行が1件追加される
-- だけでfixed_seat_assignments行には触れない。指定日以外は従来どおり固定座席として表示される）。
CREATE TABLE IF NOT EXISTS fixed_seat_absences (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id     BIGINT NOT NULL REFERENCES seats(id),
    date        DATE NOT NULL,
    created_by  BIGINT NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (seat_id, date)
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
-- created_by（作成者）: 2026-09-09追加。千田さんの案によるPJ座席運用フローの変更
-- （「プロジェクト作成は誰でも、アンケート回答・席決めはプロジェクトを作成した人が行う」）に伴い、
-- アンケート回答（A-16）・席決め関連（A-14・A-17・A-18・A-58・A-64・A-70・A-71・A-72・A-75）の
-- 権限判定を、project_title（PM/PL）・proxy_user_id（PJ席決担当）からこの列へ切り替えた。
-- proxy_user_id・project_title自体は表示・A-29のバリデーション用途で引き続き残す。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id);
-- 既存プロジェクトのバックフィル（冪等、created_by未設定の行のみ対象）。
-- 優先順位: (1) proxy_user_id（PM/PLであることが既に保証されている） (2) 最初のPMメンバー
-- (3) 最初のPLメンバー (4) 役職を問わず最初のメンバー。メンバーが1人もいないプロジェクトのみ
-- created_byがNULLのまま残り得る（管理部がS-08の「作成者」欄から手動で設定する想定）。
UPDATE projects SET created_by = proxy_user_id WHERE created_by IS NULL AND proxy_user_id IS NOT NULL;
UPDATE projects p SET created_by = (
    SELECT pm.user_id FROM project_members pm WHERE pm.project_id = p.id AND pm.project_title = 'PM'
    ORDER BY pm.id LIMIT 1
) WHERE p.created_by IS NULL;
UPDATE projects p SET created_by = (
    SELECT pm.user_id FROM project_members pm WHERE pm.project_id = p.id AND pm.project_title = 'PL'
    ORDER BY pm.id LIMIT 1
) WHERE p.created_by IS NULL;
UPDATE projects p SET created_by = (
    SELECT pm.user_id FROM project_members pm WHERE pm.project_id = p.id ORDER BY pm.id LIMIT 1
) WHERE p.created_by IS NULL;

-- T-06 project_members
CREATE TABLE IF NOT EXISTS project_members (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id             BIGINT NOT NULL REFERENCES projects(id),
    user_id                BIGINT NOT NULL REFERENCES users(id),
    project_title          VARCHAR(10) CHECK (project_title IN ('PM', 'PL', 'SL')),
    can_assign_seats       BOOLEAN NOT NULL DEFAULT false,
    seat_assign_granted_by BIGINT REFERENCES users(id),
    -- ずっと在宅勤務でプロジェクト座席が不要なメンバー用のフラグ（FR-03-10、2026-09-01追加）。
    -- has_fixed_seatと同様、座席確保操作（FR-03-7）の対象・必要人数から除外する
    seat_not_required      BOOLEAN NOT NULL DEFAULT false,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);
ALTER TABLE project_members ADD COLUMN IF NOT EXISTS seat_not_required BOOLEAN NOT NULL DEFAULT false;

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

-- T-14 role_master・T-15 user_custom_roles（役割マスタ管理）は2026-09-09に機能自体を廃止した
-- （「必要ないと感じたので削除」との指示。詳細設計書2.15・2.16節参照）。CREATE TABLE文は削除した。
-- 既存環境（本番含む）にテーブル自体が残っていても実害はないため、DROP TABLEは行っていない。

-- T-16 app_settings
CREATE TABLE IF NOT EXISTS app_settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- T-17 feedback（ヘルプ画面からのフィードバック。FR-09-2・FR-09-3、2026-09-01追加）
CREATE TABLE IF NOT EXISTS feedback (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    category    VARCHAR(10) NOT NULL
                CHECK (category IN ('bug', 'request', 'other')),
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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


async def fixed_seat_absences_in_range(start: Date, end: Date) -> set[tuple[int, Date]]:
    """T-18 fixed_seat_absences: 指定期間内に1日だけ解除されている(seat_id, date)の組の集合。
    A-06・A-07・A-69が固定座席の占有日を組み立てる際、この集合に含まれる日だけ「固定」表示を外す
    （2026-09-08追加）。"""
    rows = await get_pool().fetch(
        "SELECT seat_id, date FROM fixed_seat_absences WHERE date BETWEEN $1 AND $2", start, end
    )
    return {(r["seat_id"], r["date"]) for r in rows}


async def fixed_seat_absent_on(seat_id: int, date: Date) -> bool:
    """T-18 fixed_seat_absences: 指定した固定座席がその日だけ解除（絶対欠席）指定されているか。
    A-09・A-47が、その日に限りフリー座席同様に予約を受け付けてよいかを判定するのに使う
    （2026-09-08追加。従来はseats.seat_typeが'fixed'のままのため、フロアマップ上は空席に
    見えても実際には誰も予約できない不具合があった）。"""
    return await get_pool().fetchval(
        "SELECT 1 FROM fixed_seat_absences WHERE seat_id = $1 AND date = $2", seat_id, date
    ) is not None


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
    あわせて、開始日（valid_from）を本日以降に指定して事前登録しておいた割当（2026-09-07追加、
    「何日から固定座席の指定ができるようにしたい」との要望を受けた）のうち、開始日を迎えたものを
    実際にseat_type='fixed'へ切り替える（有効化）。行自体はassign()の時点で挿入済みで、
    ended_on IS NULLのまま開始日を待っている状態のため、ここでは座席側のフラグを追従させるだけでよい。

    詳細設計書3.12節の「バッチ処理」は本来夜間バッチとして定義しているが、本プロジェクトの
    スコープでは実際のスケジューラ基盤の実装は対象外（同節参照）。そのため、固定座席の状態が
    実際に参照される主要な箇所（A-06空き状況取得・A-19固定座席一覧・A-09予約登録のmulti_seat_warning
    判定〔2026-09-09、RULE-07廃止に伴い判定内容は「拒否」から「警告」に変更〕）の先頭でこの関数を呼び、
    遅延評価で同等の結果（期限切れ翌日・開始日当日には必ず正しい状態になる）を得る。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            expired = await conn.fetch(
                """SELECT seat_id FROM fixed_seat_assignments
                   WHERE ended_on IS NULL AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE"""
            )
            if expired:
                seat_ids = [r["seat_id"] for r in expired]
                await conn.execute("UPDATE seats SET seat_type = 'free' WHERE id = ANY($1::bigint[])", seat_ids)
                # 過去日照会（A-06・A-07・A-45）から参照できるよう、行は消さずvalid_untilの日で終了させる
                await conn.execute(
                    """UPDATE fixed_seat_assignments SET ended_on = valid_until
                       WHERE ended_on IS NULL AND seat_id = ANY($1::bigint[])""",
                    seat_ids,
                )

            to_activate = await conn.fetch(
                """SELECT fsa.seat_id FROM fixed_seat_assignments fsa JOIN seats s ON s.id = fsa.seat_id
                   WHERE fsa.ended_on IS NULL AND fsa.valid_from <= CURRENT_DATE AND s.seat_type != 'fixed'"""
            )
            if to_activate:
                await conn.execute(
                    "UPDATE seats SET seat_type = 'fixed' WHERE id = ANY($1::bigint[])",
                    [r["seat_id"] for r in to_activate],
                )


async def close_fixed_seat_assignment(conn, *, user_id: int | None = None, seat_id: int | None = None) -> int | None:
    """現在有効な固定座席割当（ended_on IS NULL）を1件、履歴を残したまま終了させる
    （A-20の座席変更・A-21の解除・RULE-06の退職処理が共通で使う、2026-09-04追加）。
    user_id・seat_idのどちらか一方を指定する。当日中に開始した割当（valid_from = 今日）を
    同日中に終了する場合は、終了日が開始日を下回ってしまうため履歴を残す意味もなく物理削除する。
    それ以外は「昨日まで有効だった」として残し、今日以降は新しい割当（あれば）に委ねる。
    戻り値: フリー座席に戻すべき座席のid（該当する割当が無ければNone）。"""
    assert (user_id is None) != (seat_id is None), "user_idかseat_idのどちらか一方を指定する"
    condition = "user_id = $1" if user_id is not None else "seat_id = $1"
    key = user_id if user_id is not None else seat_id
    row = await conn.fetchrow(
        f"SELECT seat_id, valid_from FROM fixed_seat_assignments WHERE {condition} AND ended_on IS NULL", key
    )
    if row is None:
        return None
    today = Date.today()
    if row["valid_from"] >= today:
        await conn.execute("DELETE FROM fixed_seat_assignments WHERE seat_id = $1 AND ended_on IS NULL", row["seat_id"])
    else:
        await conn.execute(
            "UPDATE fixed_seat_assignments SET ended_on = $2 WHERE seat_id = $1 AND ended_on IS NULL",
            row["seat_id"], today - timedelta(days=1),
        )
    # 割当終了後、今後の日付分のT-18（1日だけの解除指定）が残っていても意味を持たない
    # （割当が終わればその座席は毎日フリー座席として扱われるため）だけでなく、この座席が
    # 別の利用者に再割当された場合に、旧割当時代の解除指定が新しい割当に誤って適用されて
    # しまう不具合の原因になっていた。割当終了と同時に掃除する（2026-09-08追加）。
    await conn.execute("DELETE FROM fixed_seat_absences WHERE seat_id = $1 AND date >= $2", row["seat_id"], today)
    return row["seat_id"]


async def project_blocked_seats(target_date: Date) -> dict[int, str]:
    """指定日時点でプロジェクト座席として専有されている座席（seat_id→プロジェクト名）。

    四半期の座席の島の割当（A-44）は前月25日までに決定するが、専有されるのはあくまで
    その四半期のperiod_start〜period_end期間中のみで、割当が決定した時点（それより前）は
    通常のフリー座席として予約できる（2026-08-28訂正。座席自体のseat_typeを恒久的に
    'project'へ変更する実装は誤りだったため撤回し、都度この関数で期間を判定する方式に変更）。
    期間中であっても、指定日の曜日がそのプロジェクトの確定した出社曜日（weekdays_finalized）に
    含まれない日は対象外とする（2026-09-02修正。「10/1が初日のプロジェクト席でフロアマップを見ると
    未確定（プロジェクト座席）で埋まっている」との報告を受けた。従来は期間中の曜日を問わず毎日
    専有扱いにしていたため、例えば火・水のみ出社が確定しているプロジェクトの座席が、月・木・金にも
    「未確定」表示で埋まり、他の利用者が実際には誰も使わないその座席をフリー座席として予約できない
    不具合があった）。"""
    rows = await get_pool().fetch(
        """SELECT pqp.allocated_seats, pqp.weekdays_finalized, p.name
           FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.status = 'seats_allocated' AND $1 BETWEEN pqp.period_start AND pqp.period_end""",
        target_date,
    )
    target_weekday = _WEEKDAY_CODES[target_date.weekday()]
    result: dict[int, str] = {}
    for r in rows:
        weekdays = json.loads(r["weekdays_finalized"]) if r["weekdays_finalized"] else []
        if target_weekday not in weekdays:
            continue
        if r["allocated_seats"]:
            for seat_id in json.loads(r["allocated_seats"]):
                result[seat_id] = r["name"]
    return result


async def users_with_current_project_seat() -> set[int]:
    """本日時点でプロジェクト座席（座席の島の割当期間中の座席）に実際に予約を持つ利用者のuser_id集合。
    S-05・S-11の対象者検索（A-52・A-54）が「座席利用状況」をフリー／固定／PJの3区分で表示するために
    使う（2026-08-28追加。従来はプロジェクト座席の利用状況を区別せず一律の文言を返していたが、
    T-05〜T-07の実装により区別できるようになったため）。"""
    today = Date.today()
    blocked = await project_blocked_seats(today)
    if not blocked:
        return set()
    rows = await get_pool().fetch(
        "SELECT DISTINCT user_id, seat_id FROM reservations WHERE status = 'active' AND date = $1", today
    )
    return {r["user_id"] for r in rows if r["seat_id"] in blocked}


_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def _check_and_book_day(
    seat_id: int, target_user_id: int, d: Date, created_by: int, *,
    enforce_rule05: bool, check_project_block: bool, rule_id: int | None,
) -> dict:
    """1日分のRULE-02・RULE-05・座席専有チェック→問題なければreservationsへ1件挿入する
    （generate_recurring_reservationsとretry_excluded_datesが共通で使う下請け、2026-09-07切り出し。
    「除外部分だけ別の座席に変更したい」との要望を受け、パターン・連続期間ではなく明示的な日付ずつの
    予約〔retry_excluded_dates〕にも同じ判定ロジックを使い回せるようにした）。rule_idはT-09
    recurring_rulesの行を持つ場合のみ（振替時は単発予約としてNULLのまま登録する）。
    RULE-07（固定座席保有者はフリー座席を予約不可）は2026-09-09に廃止したため、ここでは検証しない
    （固定座席保有者かどうかを呼び出し元がここに伝える必要もなくなった）。"""
    pool = get_pool()
    reason = None
    if enforce_rule05:
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
            reason = DUPLICATE_SEAT_MESSAGE

    if reason is not None:
        return {"date": d.isoformat(), "status": "excluded", "reason": reason}
    try:
        await pool.execute(
            """INSERT INTO reservations (seat_id, user_id, date, created_by, recurring_rule_id)
               VALUES ($1, $2, $3, $4, $5)""",
            seat_id, target_user_id, d, created_by, rule_id,
        )
        return {"date": d.isoformat(), "status": "created", "reason": None}
    except asyncpg.UniqueViolationError:
        return {"date": d.isoformat(), "status": "excluded", "reason": "この座席はすでに予約されています"}


async def generate_recurring_reservations(
    seat_id: int, target_user_id: int, pattern: dict, start_date: Date, end_date: Date, created_by: int,
    *, enforce_rule05: bool, check_project_block: bool,
) -> dict:
    """A-10・A-18共通: T-09 recurring_rulesを1件作成し、該当する各日についてT-08予約を生成する
    （3.2節「周期予約の基本フロー」）。RULE-02（同一日複数のフリー座席予約禁止）・RULE-03（同一座席
    同一日の二重予約禁止）を各日について検証し、違反する日のみ除外する（違反しない日は登録する）。
    RULE-07（固定座席保有者はフリー座席を予約不可）は2026-09-09に廃止した。

    enforce_rule05: RULE-05（予約可能期間）を検証するか。A-10（一般利用者の自分自身の予約）はTrue、
    A-18（プロジェクト座席への確保）はプロジェクト座席専用の別サイクル・締切（3.4節）で運用されるため
    False（2026-08-28追加）。
    check_project_block: 対象日がT-07の座席の島の割当期間中であれば除外するか。A-10はTrue（他プロジェクトの
    専有座席を誤って予約できないように）、A-18はFalse（自分自身がその専有を作り出す側のため対象外）。

    戻り値: {"rule_id": ..., "results": [{"date": "YYYY-MM-DD", "status": "created"|"excluded", "reason": str|None}]}
    """
    pool = get_pool()
    weekdays = pattern.get("weekdays") if pattern.get("type") == "weekly" else None

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
        results.append(await _check_and_book_day(
            seat_id, target_user_id, d, created_by,
            enforce_rule05=enforce_rule05, check_project_block=check_project_block, rule_id=rule_id,
        ))
        d += timedelta(days=1)

    return {"rule_id": rule_id, "results": results}


async def retry_excluded_dates(
    seat_id: int, target_user_id: int, dates: list[Date], created_by: int,
    *, enforce_rule05: bool, check_project_block: bool,
) -> list[dict]:
    """一括予約の結果で「除外」となった日だけを、指定した別の座席で振り替える（2026-09-07追加。
    「席を取って結果で除外が出てきたとき、除外部分だけ別の席に変更できる機能が欲しい」との要望を
    受けた）。generate_recurring_reservationsと異なり、連続した期間・パターンではなく明示的な
    日付のリストを対象にする（元の予約で成功していた日はそのまま、除外された日だけをやり直すため）。
    振替分はrecurring_rulesを持たない単発予約として登録する（A-09と同じ形）。"""
    return [
        await _check_and_book_day(
            seat_id, target_user_id, d, created_by,
            enforce_rule05=enforce_rule05, check_project_block=check_project_block, rule_id=None,
        )
        for d in sorted(dates)
    ]


async def _available_free_seats(pool, area: str, target_date: Date) -> list:
    """指定日・指定エリアで、まだ誰にも割り当たっていないフリー座席（座席番号順）"""
    blocked = await project_blocked_seats(target_date)
    rows = await pool.fetch(
        """SELECT s.id, s.seat_no FROM seats s JOIN areas a ON a.id = s.area_id
           WHERE s.status = 'active' AND s.seat_type = 'free'
             AND ($1 = 'all' OR lower(a.name) = $1)
             AND NOT EXISTS (
                 SELECT 1 FROM reservations r WHERE r.seat_id = s.id AND r.date = $2 AND r.status = 'active'
             )
           ORDER BY s.seat_no""",
        area, target_date,
    )
    return [r for r in rows if r["id"] not in blocked]


async def generate_bulk_free_seat_reservations(
    member_user_ids: list[int], area: str, pattern: dict, start_date: Date, end_date: Date, created_by: int,
    *, enforce_rule05: bool,
) -> dict:
    """複数メンバーへ、指定エリアの空き座席（フリー座席）を日付ごとに自動で割り振って一括予約する
    （2026-09-04追加。「代理予約を複数名まとめて、PJのメンバーに対して行いたい。座席はプロジェクト
    座席ではなく通常のフリー座席として扱ってほしい」との要望を受けた）。1人1席・同一座席の重複割当
    はしない。日によって空き状況が変わるため割り当たる座席がメンバーごと・日ごとに変わり得る。
    生成される予約（T-08）はプロジェクト座席の座席の島の割当（allocated_seats）とは無関係の、
    通常のフリー座席予約として記録する。同一座席1件のrecurring_rulesに複数メンバーを紐付けられない
    （日によって座席が変わるため）ため、generate_recurring_reservationsと異なりrecurring_rule_idは
    付与しない（取消は各予約を個別に行う）。

    RULE-02（同一日複数のフリー座席予約禁止）・T-07の専有チェックは各メンバー・各日について検証する。
    RULE-07（固定座席保有者はフリー座席を予約不可）は2026-09-09に廃止した。enforce_rule05は
    RULE-05（予約可能期間）を検証するか（呼び出し元がadminならFalse、FR-01-7と同じ考え方。
    それ以外はTrue）。

    戻り値: {"results": [{"user_id":..., "date": "YYYY-MM-DD", "status": "created"|"excluded",
                           "reason": str|None, "seat_no": str|None}]}
    """
    pool = get_pool()
    weekdays = pattern.get("weekdays") if pattern.get("type") == "weekly" else None

    results: list[dict] = []
    d = start_date
    while d <= end_date:
        if weekdays is not None and _WEEKDAY_CODES[d.weekday()] not in weekdays:
            d += timedelta(days=1)
            continue

        available_seats = None
        taken_seat_ids: set[int] = set()
        for member_user_id in member_user_ids:
            reason = None
            if enforce_rule05:
                if d < Date.today():
                    reason = "過去の日付は予約できません"
                else:
                    open_date = await free_seat_open_date(d)
                    if Date.today() < open_date:
                        reason = f"この座席は{open_date.month}月{open_date.day}日から予約できます"
            if reason is None:
                duplicate = await pool.fetchval(
                    """SELECT 1 FROM reservations r JOIN seats s ON s.id = r.seat_id
                       WHERE r.user_id = $1 AND r.date = $2 AND r.status = 'active' AND s.seat_type = 'free'""",
                    member_user_id, d,
                )
                if duplicate:
                    reason = DUPLICATE_SEAT_MESSAGE

            seat = None
            if reason is None:
                if available_seats is None:
                    available_seats = await _available_free_seats(pool, area, d)
                seat = next((s for s in available_seats if s["id"] not in taken_seat_ids), None)
                if seat is None:
                    reason = "割り当てられる空き座席がありません"

            if reason is not None:
                results.append({
                    "user_id": member_user_id, "date": d.isoformat(),
                    "status": "excluded", "reason": reason, "seat_no": None,
                })
                continue
            try:
                await pool.execute(
                    "INSERT INTO reservations (seat_id, user_id, date, created_by) VALUES ($1, $2, $3, $4)",
                    seat["id"], member_user_id, d, created_by,
                )
                taken_seat_ids.add(seat["id"])
                results.append({
                    "user_id": member_user_id, "date": d.isoformat(),
                    "status": "created", "reason": None, "seat_no": seat["seat_no"],
                })
            except asyncpg.UniqueViolationError:
                taken_seat_ids.add(seat["id"])
                results.append({
                    "user_id": member_user_id, "date": d.isoformat(),
                    "status": "excluded", "reason": "この座席はすでに予約されています", "seat_no": None,
                })
        d += timedelta(days=1)

    return {"results": results}


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
