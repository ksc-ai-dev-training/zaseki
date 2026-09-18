# A-25, A-26, A-49, A-50 権限・役割管理（S-08）。詳細設計書3.8節
# A-32〜A-37（役割マスタ管理）は2026-09-09に機能自体を廃止した（「必要ないと感じたので削除」との指示）。
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import close_fixed_seat_assignment, get_pool
from slack import (
    DEFAULT_MESSAGE_FINALIZE_HEADER,
    DEFAULT_MESSAGE_REMINDER,
    DEFAULT_MESSAGE_SEAT_BLOCK_HEADER,
    SLACK_MESSAGE_FINALIZE_HEADER_KEY,
    SLACK_MESSAGE_REMINDER_KEY,
    SLACK_MESSAGE_SEAT_BLOCK_HEADER_KEY,
    SLACK_NOTIFY_FINALIZE_KEY,
    SLACK_NOTIFY_SEAT_BLOCK_KEY,
    SLACK_WEBHOOK_SETTING_KEY,
)

router = APIRouter(prefix="/api", tags=["roles"])

# 通知設定タブで編集可能なapp_settingsのキー（詳細設計書2.17節・A-49・A-50）。当初はWebhook URLの
# 1つのみだったが、「実際の通知の文言を編集できる機能を追加してほしい」との要望を受け、通知文言
# 3種（アンケート送信・リマインド・曜日確定の見出し）を追加した（2026-09-02追加）。未設定時に画面へ
# 表示する初期文言（デフォルト値）も、実際に送信される文言と一致させるためここに持つ。
# アンケート送信時の文言（旧SLACK_MESSAGE_SURVEY_KEY）は、2026-09-03の変更B（検討資料「プロジェクト
# 座席・曜日調整フロー改善案」）でA-41・A-63〔システムによるアンケート送信通知〕自体を廃止し、
# エリア責任者が自分でSlackへ連絡する運用に変えたことに伴い、編集対象から削除した。
# 2026-09-16追加: 「座席の割り当て、曜日確定が決まったときスラックに通知されるのをオン/オフ切り替え
# てほしい」との要望を受け、種類ごとのオン/オフスイッチ（SLACK_NOTIFY_*、値は'true'/'false'）を
# 追加した。あわせて、従来は自動通知していなかった座席の島の割当（A-44・A-80）にも新規に自動通知を
# 追加し、その文言・スイッチもここに含めた。
EDITABLE_SETTINGS: list[tuple[str, str | None]] = [
    (SLACK_WEBHOOK_SETTING_KEY, None),
    (SLACK_NOTIFY_FINALIZE_KEY, "true"),
    (SLACK_MESSAGE_REMINDER_KEY, DEFAULT_MESSAGE_REMINDER),
    (SLACK_MESSAGE_FINALIZE_HEADER_KEY, DEFAULT_MESSAGE_FINALIZE_HEADER),
    (SLACK_NOTIFY_SEAT_BLOCK_KEY, "true"),
    (SLACK_MESSAGE_SEAT_BLOCK_HEADER_KEY, DEFAULT_MESSAGE_SEAT_BLOCK_HEADER),
]
EDITABLE_SETTING_KEYS = {key for key, _ in EDITABLE_SETTINGS}
BOOLEAN_SETTING_KEYS = {SLACK_NOTIFY_FINALIZE_KEY, SLACK_NOTIFY_SEAT_BLOCK_KEY}


@router.get("/users")
async def list_users(
    role: Literal["all", "general", "admin"] = "all",
    employment_status: Literal["all", "active", "leave", "retired"] = "all",
    show_retired: bool = False,
    q: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-25: 利用者一覧（利用者ロール管理タブ）。show_retired=false（既定）ではdeleted_atが
    設定された利用者を除外する。qは氏名・メールでの部分一致検索（2026-08-28追加、4.7節の絞り込み欄の裏付け）。"""
    pool = get_pool()
    # 2026-09-16修正: 画面表示「姓 名」のスペースを除去してから比較する（last_name||first_nameは
    # スペース無し結合のため、表示通りに入力すると常に0件になっていた）
    rows = await pool.fetch(
        """SELECT u.id, u.last_name, u.first_name, u.email, u.employment_type, u.role,
                  u.area_manager_role, u.employment_status, u.is_system_operator, u.deleted_at
           FROM users u
           WHERE ($1 = 'all' OR u.role = $1)
             AND ($2 = 'all' OR u.employment_status = $2)
             AND ($3 OR u.deleted_at IS NULL)
             AND ($4 = '' OR (u.last_name || u.first_name) ILIKE '%' || replace(replace($4, ' ', ''), '　', '') || '%' OR u.email ILIKE '%' || $4 || '%')
           ORDER BY u.last_name, u.first_name""",
        role, employment_status, show_retired, q,
    )
    return {
        "items": [
            {
                "id": r["id"], "last_name": r["last_name"], "first_name": r["first_name"],
                "email": r["email"], "employment_type": r["employment_type"], "role": r["role"],
                "area_manager_role": r["area_manager_role"], "employment_status": r["employment_status"],
                "is_system_operator": r["is_system_operator"],
                "retired": r["deleted_at"] is not None,
            }
            for r in rows
        ]
    }


class UserUpdate(BaseModel):
    last_name: str
    first_name: str
    employment_type: Literal["employee", "contract", "bp"]
    role: Literal["general", "admin"]
    area_manager_role: Literal["manager", "deputy"] | None = None
    employment_status: Literal["active", "leave", "retired"]
    is_system_operator: bool = False


@router.put("/users/{id}")
async def update_user(id: int, body: UserUpdate, user: CurrentUser = Depends(require_roles("admin"))):
    """A-26: 利用者の編集（氏名訂正、雇用形態、role、エリア責任者・副責任者の指定、在籍状況、
    システム運用担当）。area_manager_roleはrole='admin'の利用者のみ設定可（2026-08-27追加）。
    is_system_operatorはroleを問わず設定可（P-SYSOP、FR-09-3、2026-09-01追加。フィードバック
    一覧〔A-60〕へのアクセスに使う、role='admin'とは独立した属性）。employment_status='retired'
    への変更でRULE-06を実行：deleted_at設定、固定座席解除、今後の予約取消。
    自分自身が最後の管理部ユーザーである場合、自分のroleを'admin'から外す・自分を退職済みにする
    操作は拒否する（誰も管理画面に入れなくなりDB操作でしか復旧できなくなるのを防ぐ、2026-09-08追加）。"""
    last_name = body.last_name.strip()
    first_name = body.first_name.strip()
    if not last_name or not first_name:
        raise HTTPException(400, detail="氏名を入力してください")
    if body.area_manager_role is not None and body.role != "admin":
        raise HTTPException(400, detail="エリア担当は管理部ロールの利用者のみ設定できます")

    pool = get_pool()
    existing = await pool.fetchrow("SELECT id, role, employment_status FROM users WHERE id = $1", id)
    if existing is None:
        raise HTTPException(404, detail="対象が見つかりません")

    if id == user.id and existing["role"] == "admin":
        losing_admin = body.role != "admin" or body.employment_status == "retired"
        if losing_admin:
            other_admins = await pool.fetchval(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND deleted_at IS NULL AND id != $1", id
            )
            if other_admins == 0:
                raise HTTPException(400, detail="自分が最後の管理部ユーザーです。自分自身の管理部権限を外したり退職済みにしたりすることはできません")

    async with pool.acquire() as conn:
        async with conn.transaction():
            newly_retired = body.employment_status == "retired" and existing["employment_status"] != "retired"
            un_retired = body.employment_status != "retired" and existing["employment_status"] == "retired"
            await conn.execute(
                """UPDATE users SET last_name = $1, first_name = $2, employment_type = $3, role = $4,
                                     area_manager_role = $5, employment_status = $6,
                                     deleted_at = CASE WHEN $7 THEN now() WHEN $8 THEN NULL ELSE deleted_at END,
                                     is_system_operator = $9, updated_at = now()
                   WHERE id = $10""",
                last_name, first_name, body.employment_type, body.role,
                body.area_manager_role, body.employment_status, newly_retired, un_retired,
                body.is_system_operator, id,
            )
            if newly_retired:
                # RULE-06: 固定座席の割当を終了させ、座席をフリー座席に戻す（履歴は残す）
                old_seat_id = await close_fixed_seat_assignment(conn, user_id=id)
                if old_seat_id is not None:
                    await conn.execute("UPDATE seats SET seat_type = 'free' WHERE id = $1", old_seat_id)
                # RULE-06: 今後の予約（フリー座席・プロジェクト座席）をすべて取消扱いにする
                await conn.execute(
                    """UPDATE reservations SET status = 'cancelled', updated_at = now()
                       WHERE user_id = $1 AND status = 'active' AND date >= CURRENT_DATE""",
                    id,
                )
    return {"detail": "利用者情報を更新しました"}


@router.get("/app-settings")
async def get_app_settings(_: CurrentUser = Depends(require_roles("admin"))):
    """A-49: UIから編集可能な設定値の取得（通知設定タブ）。対象はWebhook URL・通知文言3種
    （詳細設計書2.17節、2026-09-02追加で文言3種を拡張）。文言系は未設定（初回）の場合、実際に
    送信時使われる初期文言（EDITABLE_SETTINGSのデフォルト値）をvalueとして返す（画面に空欄では
    なく実際の初期文言を表示し、そのまま編集を始められるようにするため）。"""
    rows = await get_pool().fetch(
        "SELECT key, value, description FROM app_settings WHERE key = ANY($1::text[])",
        list(EDITABLE_SETTING_KEYS),
    )
    row_by_key = {r["key"]: r for r in rows}
    return {
        "items": [
            {
                "key": key,
                "value": (row_by_key[key]["value"] if key in row_by_key else None) or default,
                "description": row_by_key[key]["description"] if key in row_by_key else None,
            }
            for key, default in EDITABLE_SETTINGS
        ]
    }


class AppSettingUpdate(BaseModel):
    value: str


def _validate_setting_value(key: str, raw_value: str) -> str:
    """A-49/A-50/A-85共通の値検証（2026-09-18、A-85新設に伴いupdate_app_settingから切り出し）。
    正規化済みの値を返す。不正な場合はHTTPExceptionを送出する。"""
    if key not in EDITABLE_SETTING_KEYS:
        raise HTTPException(404, detail="対象が見つかりません")
    value = raw_value.strip()
    if key == SLACK_WEBHOOK_SETTING_KEY:
        if value and not value.startswith("https://hooks.slack.com/services/"):
            raise HTTPException(400, detail="Slack通知先URLはhttps://hooks.slack.com/services/で始まる形式で入力してください")
    elif key in BOOLEAN_SETTING_KEYS:
        if value not in ("true", "false"):
            raise HTTPException(400, detail="不正な値です")
    elif len(value) > 500:
        raise HTTPException(400, detail="通知文言は500文字以内で入力してください")
    return value


@router.put("/app-settings/{key}")
async def update_app_setting(key: str, body: AppSettingUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-50: UIから編集可能な設定値の更新（1件のみ）。keyはEDITABLE_SETTING_KEYSのいずれかのみ受け
    付ける（2026-09-02拡張、当初はproject_seat_slack_webhook_urlのみだった）。値の検証内容は
    _validate_setting_value参照。S-08通知設定タブの「保存する」は2026-09-18よりA-85（一括保存、
    全項目をトランザクションでまとめて保存）を使うようになったため、このAPIは主に他クライアント・
    単体テスト用の単発更新口として残す。"""
    value = _validate_setting_value(key, body.value)
    await get_pool().execute(
        """INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()""",
        key, value,
    )
    return {"detail": "設定を更新しました"}


class AppSettingsBulkUpdate(BaseModel):
    settings: dict[str, str]


@router.put("/app-settings")
async def update_app_settings_bulk(body: AppSettingsBulkUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-85: 通知設定タブ（S-08）の一括保存（2026-09-18新設、QA報告の修正）。従来フロントは
    項目ごとに独立したA-50呼び出しをPromise.allで並列実行しており、「全部成功か全部失敗か」に
    なっておらず（A-66・A-68・A-80等、他の一括系APIと同じ設計方針から外れていた）、例えば
    Webhook URLの形式エラーが1件あると、他の項目（通知文言・オン/オフ設定）だけが先に保存されて
    しまい、管理部にはどの項目が保存されなかったのか分からない不具合があった。全項目をまず検証し、
    1件でも不正な値があれば何も保存せずに400で拒否する（＝検証はループの外で全項目に対して先に
    行い、1件も実DBに書き込まない）。全項目が有効な場合のみ、1つのトランザクションでまとめて
    保存する。"""
    cleaned: dict[str, str] = {key: _validate_setting_value(key, value) for key, value in body.settings.items()}
    async with get_pool().acquire() as conn:
        async with conn.transaction():
            for key, value in cleaned.items():
                await conn.execute(
                    """INSERT INTO app_settings (key, value) VALUES ($1, $2)
                       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()""",
                    key, value,
                )
    return {"detail": "設定を更新しました"}
