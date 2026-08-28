# A-25, A-26, A-32〜A-37, A-49, A-50 権限・役割管理（S-08）。詳細設計書3.8節
from datetime import date as Date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import get_pool
from slack import SLACK_WEBHOOK_SETTING_KEY

router = APIRouter(prefix="/api", tags=["roles"])

# 通知設定タブで編集可能なapp_settingsのキーはこの1つのみ（詳細設計書2.17節・A-49・A-50）
EDITABLE_SETTING_KEY = SLACK_WEBHOOK_SETTING_KEY


@router.get("/users")
async def list_users(
    role: Literal["all", "general", "admin"] = "all",
    employment_status: Literal["all", "active", "leave", "retired"] = "all",
    show_retired: bool = False,
    q: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-25: 利用者一覧（利用者ロール管理タブ）。show_retired=false（既定）ではdeleted_atが
    設定された利用者を除外する。各行にcustom_role_ids（T-15、編集モーダルのチェックボックスの
    初期状態に使う）を含める（2026-08-28追加、A-25の元の定義にはなかったが編集フォームに
    必要なため）。qは氏名・メールでの部分一致検索（2026-08-28追加、4.7節の絞り込み欄の裏付け）。"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT u.id, u.last_name, u.first_name, u.email, u.employment_type, u.role,
                  u.area_manager_role, u.employment_status, u.deleted_at,
                  COALESCE(array_agg(ucr.role_master_id) FILTER (WHERE ucr.role_master_id IS NOT NULL), '{}'::bigint[]) AS custom_role_ids
           FROM users u
           LEFT JOIN user_custom_roles ucr ON ucr.user_id = u.id
           WHERE ($1 = 'all' OR u.role = $1)
             AND ($2 = 'all' OR u.employment_status = $2)
             AND ($3 OR u.deleted_at IS NULL)
             AND ($4 = '' OR (u.last_name || u.first_name) ILIKE '%' || $4 || '%' OR u.email ILIKE '%' || $4 || '%')
           GROUP BY u.id
           ORDER BY u.last_name, u.first_name""",
        role, employment_status, show_retired, q,
    )
    return {
        "items": [
            {
                "id": r["id"], "last_name": r["last_name"], "first_name": r["first_name"],
                "email": r["email"], "employment_type": r["employment_type"], "role": r["role"],
                "area_manager_role": r["area_manager_role"], "employment_status": r["employment_status"],
                "retired": r["deleted_at"] is not None,
                "custom_role_ids": list(r["custom_role_ids"]),
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


@router.put("/users/{id}")
async def update_user(id: int, body: UserUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-26: 利用者の編集（氏名訂正、雇用形態、role、エリア責任者・副責任者の指定、在籍状況）。
    area_manager_roleはrole='admin'の利用者のみ設定可（2026-08-27追加）。employment_status='retired'
    への変更でRULE-06を実行：deleted_at設定、固定座席解除、今後の予約取消。"""
    last_name = body.last_name.strip()
    first_name = body.first_name.strip()
    if not last_name or not first_name:
        raise HTTPException(400, detail="氏名を入力してください")
    if body.area_manager_role is not None and body.role != "admin":
        raise HTTPException(400, detail="エリア担当は管理部ロールの利用者のみ設定できます")

    pool = get_pool()
    existing = await pool.fetchrow("SELECT id, employment_status FROM users WHERE id = $1", id)
    if existing is None:
        raise HTTPException(404, detail="対象が見つかりません")

    async with pool.acquire() as conn:
        async with conn.transaction():
            newly_retired = body.employment_status == "retired" and existing["employment_status"] != "retired"
            un_retired = body.employment_status != "retired" and existing["employment_status"] == "retired"
            await conn.execute(
                """UPDATE users SET last_name = $1, first_name = $2, employment_type = $3, role = $4,
                                     area_manager_role = $5, employment_status = $6,
                                     deleted_at = CASE WHEN $7 THEN now() WHEN $8 THEN NULL ELSE deleted_at END,
                                     updated_at = now()
                   WHERE id = $9""",
                last_name, first_name, body.employment_type, body.role,
                body.area_manager_role, body.employment_status, newly_retired, un_retired, id,
            )
            if newly_retired:
                # RULE-06: 固定座席の割当を解除し、座席をフリー座席に戻す
                old_seat_id = await conn.fetchval(
                    "SELECT seat_id FROM fixed_seat_assignments WHERE user_id = $1", id
                )
                await conn.execute("DELETE FROM fixed_seat_assignments WHERE user_id = $1", id)
                if old_seat_id is not None:
                    await conn.execute("UPDATE seats SET seat_type = 'free' WHERE id = $1", old_seat_id)
                # RULE-06: 今後の予約（フリー座席・プロジェクト座席）をすべて取消扱いにする
                await conn.execute(
                    """UPDATE reservations SET status = 'cancelled', updated_at = now()
                       WHERE user_id = $1 AND status = 'active' AND date >= CURRENT_DATE""",
                    id,
                )
    return {"detail": "利用者情報を更新しました"}


@router.get("/role-master")
async def list_role_master(_: CurrentUser = Depends(require_roles("admin"))):
    """A-32: 役割マスタ一覧。付与済み利用者数を含める（役割マスタ管理タブの一覧列）。"""
    rows = await get_pool().fetch(
        """SELECT rm.id, rm.name, rm.description, COUNT(ucr.id) AS assigned_count
           FROM role_master rm
           LEFT JOIN user_custom_roles ucr ON ucr.role_master_id = rm.id
           GROUP BY rm.id
           ORDER BY rm.name"""
    )
    return {
        "items": [
            {"id": r["id"], "name": r["name"], "description": r["description"], "assigned_count": r["assigned_count"]}
            for r in rows
        ]
    }


class RoleMasterCreate(BaseModel):
    name: str
    description: str | None = None


@router.post("/role-master")
async def create_role_master(body: RoleMasterCreate, user: CurrentUser = Depends(require_roles("admin"))):
    """A-33: 役割マスタの追加。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="役割名を入力してください")
    pool = get_pool()
    duplicate = await pool.fetchval("SELECT 1 FROM role_master WHERE name = $1", name)
    if duplicate:
        raise HTTPException(409, detail="この役割名は既に使用されています")
    row = await pool.fetchrow(
        "INSERT INTO role_master (name, description, created_by) VALUES ($1, $2, $3) RETURNING id",
        name, body.description, user.id,
    )
    return {"id": row["id"], "detail": "役割を追加しました"}


@router.put("/role-master/{id}")
async def update_role_master(id: int, body: RoleMasterCreate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-34: 役割マスタの編集。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="役割名を入力してください")
    pool = get_pool()
    existing = await pool.fetchrow("SELECT id FROM role_master WHERE id = $1", id)
    if existing is None:
        raise HTTPException(404, detail="対象が見つかりません")
    duplicate = await pool.fetchval("SELECT 1 FROM role_master WHERE name = $1 AND id != $2", name, id)
    if duplicate:
        raise HTTPException(409, detail="この役割名は既に使用されています")
    await pool.execute(
        "UPDATE role_master SET name = $1, description = $2 WHERE id = $3", name, body.description, id
    )
    return {"detail": "役割を更新しました"}


@router.delete("/role-master/{id}")
async def delete_role_master(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-35: 役割マスタの削除。付与済みの利用者からもラベルが外れる（T-15を連鎖削除、
    S-08モックアップの削除確認文言のとおり）。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM user_custom_roles WHERE role_master_id = $1", id)
            result = await conn.execute("DELETE FROM role_master WHERE id = $1", id)
    if result == "DELETE 0":
        raise HTTPException(404, detail="対象が見つかりません")
    return {"detail": "役割を削除しました"}


class CustomRoleAssign(BaseModel):
    role_master_id: int


@router.post("/users/{id}/custom-roles")
async def assign_custom_role(id: int, body: CustomRoleAssign, user: CurrentUser = Depends(require_roles("admin"))):
    """A-36: 利用者への役割マスタ付与（FR-07-2）。権限判定には一切使用しない。"""
    pool = get_pool()
    target = await pool.fetchrow("SELECT id FROM users WHERE id = $1", id)
    if target is None:
        raise HTTPException(404, detail="対象が見つかりません")
    role = await pool.fetchrow("SELECT id FROM role_master WHERE id = $1", body.role_master_id)
    if role is None:
        raise HTTPException(404, detail="対象が見つかりません")
    already = await pool.fetchval(
        "SELECT 1 FROM user_custom_roles WHERE user_id = $1 AND role_master_id = $2", id, body.role_master_id
    )
    if not already:
        await pool.execute(
            "INSERT INTO user_custom_roles (user_id, role_master_id, assigned_by) VALUES ($1, $2, $3)",
            id, body.role_master_id, user.id,
        )
    return {"detail": "役割を付与しました"}


@router.delete("/users/{id}/custom-roles/{role_master_id}")
async def unassign_custom_role(id: int, role_master_id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-37: 付与の取消。"""
    result = await get_pool().execute(
        "DELETE FROM user_custom_roles WHERE user_id = $1 AND role_master_id = $2", id, role_master_id
    )
    if result == "DELETE 0":
        raise HTTPException(404, detail="対象が見つかりません")
    return {"detail": "役割の付与を取り消しました"}


@router.get("/app-settings")
async def get_app_settings(_: CurrentUser = Depends(require_roles("admin"))):
    """A-49: UIから編集可能な設定値の取得（通知設定タブ）。本フェーズで対象とするのは
    project_seat_slack_webhook_urlのみ（詳細設計書2.17節）。"""
    row = await get_pool().fetchrow(
        "SELECT key, value, description FROM app_settings WHERE key = $1", EDITABLE_SETTING_KEY
    )
    return {
        "items": [
            {
                "key": EDITABLE_SETTING_KEY,
                "value": row["value"] if row else None,
                "description": row["description"] if row else None,
            }
        ]
    }


class AppSettingUpdate(BaseModel):
    value: str


@router.put("/app-settings/{key}")
async def update_app_setting(key: str, body: AppSettingUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-50: UIから編集可能な設定値の更新。keyはproject_seat_slack_webhook_urlのみ受け付ける。
    入力する場合はhttps://hooks.slack.com/services/で始まるURL形式であることを検証する（4.6節、
    2026-08-28実装。未入力〔空文字〕は通知を送信しない設定として許可する）。"""
    if key != EDITABLE_SETTING_KEY:
        raise HTTPException(404, detail="対象が見つかりません")
    value = body.value.strip()
    if value and not value.startswith("https://hooks.slack.com/services/"):
        raise HTTPException(400, detail="Slack通知先URLはhttps://hooks.slack.com/services/で始まる形式で入力してください")
    await get_pool().execute(
        """INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()""",
        key, value,
    )
    return {"detail": "設定を更新しました"}
