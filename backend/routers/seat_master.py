# A-22, A-23, A-24, A-30 座席マスタ管理（S-07）。詳細設計書3.7節
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import get_pool, release_expired_fixed_seats

router = APIRouter(prefix="/api/seats", tags=["seat-master"])
areas_router = APIRouter(prefix="/api/areas", tags=["seat-master"])


@areas_router.get("")
async def list_areas(_: CurrentUser = Depends(require_roles("admin"))):
    """A-30: エリア一覧（NORTH/EAST/WEST。座席マスタ管理・空き状況の絞り込み等で使う静的なマスタ参照）"""
    rows = await get_pool().fetch(
        "SELECT id, name FROM areas ORDER BY CASE name WHEN 'NORTH' THEN 1 WHEN 'EAST' THEN 2 WHEN 'WEST' THEN 3 END"
    )
    return {"items": [{"id": r["id"], "name": r["name"]} for r in rows]}


@router.get("")
async def list_seat_master(
    area: Literal["all", "north", "east", "west"] = "all",
    status: Literal["all", "active", "retired"] = "all",
    q: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-22: 座席一覧（座席マスタ管理）。areaは既存のA-06/A-07と同じ規約、statusとqは
    画面モックアップの絞り込み（状態、座席番号検索）の裏付けとして2026-08-27追加。"""
    await release_expired_fixed_seats()
    rows = await get_pool().fetch(
        """SELECT s.id, s.seat_no, s.area_id, a.name AS area_name, s.seat_type, s.status,
                  s.pos_x, s.pos_y,
                  EXISTS(SELECT 1 FROM fixed_seat_assignments fsa WHERE fsa.seat_id = s.id AND fsa.ended_on IS NULL) AS has_fixed_assignment
           FROM seats s
           JOIN areas a ON a.id = s.area_id
           WHERE ($1 = 'all' OR lower(a.name) = $1)
             AND ($2 = 'all' OR s.status = $2)
             AND ($3 = '' OR s.seat_no ILIKE '%' || $3 || '%')
           ORDER BY CASE a.name WHEN 'NORTH' THEN 1 WHEN 'EAST' THEN 2 WHEN 'WEST' THEN 3 END, s.seat_no""",
        area, status, q,
    )
    return {
        "items": [
            {
                "id": r["id"], "seat_no": r["seat_no"], "area_id": r["area_id"], "area": r["area_name"],
                "seat_type": r["seat_type"], "status": r["status"],
                "has_fixed_assignment": r["has_fixed_assignment"],
                "pos_x": r["pos_x"], "pos_y": r["pos_y"],
            }
            for r in rows
        ]
    }


class SeatCreate(BaseModel):
    seat_no: str
    area_id: int
    seat_type: Literal["free", "fixed", "project"]
    # S-02「座席配置モード」でのクリック位置（所属エリアパネルに対する%、0〜100）。
    # 両方指定するか両方省略する（2026-08-27追加）
    pos_x: float | None = None
    pos_y: float | None = None


@router.post("")
async def create_seat(body: SeatCreate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-23: 座席の新規追加"""
    pool = get_pool()
    seat_no = body.seat_no.strip()
    if not seat_no:
        raise HTTPException(400, detail="座席番号を入力してください")
    area = await pool.fetchrow("SELECT id FROM areas WHERE id = $1", body.area_id)
    if area is None:
        raise HTTPException(404, detail="対象が見つかりません")
    duplicate = await pool.fetchval("SELECT 1 FROM seats WHERE seat_no = $1", seat_no)
    if duplicate:
        raise HTTPException(409, detail="この座席番号は既に使用されています")
    row = await pool.fetchrow(
        "INSERT INTO seats (seat_no, area_id, seat_type, pos_x, pos_y) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        seat_no, body.area_id, body.seat_type, body.pos_x, body.pos_y,
    )
    return {"id": row["id"], "detail": "座席を追加しました"}


class SeatUpdate(BaseModel):
    seat_no: str
    area_id: int
    seat_type: Literal["free", "fixed", "project"]
    status: Literal["active", "retired"]
    pos_x: float | None = None
    pos_y: float | None = None


@router.put("/{id}")
async def update_seat(id: int, body: SeatUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-24: 座席の編集（座席番号・エリア・座席タイプ・有効／廃止）。status='retired'への変更で
    廃止扱いになる（RULE-01）。座席タイプ変更・廃止と既存の固定座席割当（T-04）等との整合性は、
    4.5節のとおり本フェーズでは強制チェックせずフロントエンドの警告表示のみとする。"""
    pool = get_pool()
    seat_no = body.seat_no.strip()
    if not seat_no:
        raise HTTPException(400, detail="座席番号を入力してください")
    existing = await pool.fetchrow("SELECT id FROM seats WHERE id = $1", id)
    if existing is None:
        raise HTTPException(404, detail="対象が見つかりません")
    area = await pool.fetchrow("SELECT id FROM areas WHERE id = $1", body.area_id)
    if area is None:
        raise HTTPException(404, detail="対象が見つかりません")
    duplicate = await pool.fetchval("SELECT 1 FROM seats WHERE seat_no = $1 AND id != $2", seat_no, id)
    if duplicate:
        raise HTTPException(409, detail="この座席番号は既に使用されています")
    await pool.execute(
        """UPDATE seats SET seat_no = $1, area_id = $2, seat_type = $3, status = $4,
                             pos_x = $5, pos_y = $6, updated_at = now()
           WHERE id = $7""",
        seat_no, body.area_id, body.seat_type, body.status, body.pos_x, body.pos_y, id,
    )
    return {"detail": "座席を更新しました"}


@router.delete("/{id}")
async def delete_seat(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-53: 座席の完全削除。廃止（A-24のstatus='retired'）とは別の操作で、予約履歴を残さず
    座席データそのものを消す（2026-08-28追加）。固定座席の割当（T-04）や予約履歴（T-08、
    キャンセル済みを含む）が残っている座席はFK制約上も削除できないため、事前チェックして
    分かりやすいメッセージで拒否する。

    固定座席の割当は2026-09-04より履歴を残す方式（ended_on）に変更したため、「現在有効な割当が
    ある」場合と「過去に割当があった（既に解除済み）」場合を分けてチェックする（2026-09-07修正。
    分けずにseat_id一致だけで判定すると、既に解除済みの座席でも履歴行が残っている限り常に
    「先にS-05で解除してください」と案内してしまうが、解除するものが何もなく手詰まりになる
    不具合があった。過去の履歴だけが残っている場合はFK制約上いずれにせよ物理削除できないため、
    予約履歴と同じく廃止をご利用いただく案内にする）。

    project_quarter_plans.allocated_seats（座席の島の割当、外部キー制約なしのJSONB配列）に
    含まれる座席は、reservations・fixed_seat_assignmentsのようなFK制約が効かないためこれらの
    チェックをすり抜けて削除でき、削除後もallocated_seatsに存在しない座席IDが残ったままになる
    （プロジェクトの必要座席数と実際に確保できる座席数が静かにずれる）不具合があったため、
    このチェックも追加した（2026-09-09追加）。"""
    pool = get_pool()
    existing = await pool.fetchrow("SELECT id FROM seats WHERE id = $1", id)
    if existing is None:
        raise HTTPException(404, detail="対象が見つかりません")
    has_active_fixed_assignment = await pool.fetchval(
        "SELECT 1 FROM fixed_seat_assignments WHERE seat_id = $1 AND ended_on IS NULL", id
    )
    if has_active_fixed_assignment:
        raise HTTPException(409, detail="固定座席の割当があるため削除できません。先に固定座席の指定（S-05）で解除してください")
    has_fixed_assignment_history = await pool.fetchval(
        "SELECT 1 FROM fixed_seat_assignments WHERE seat_id = $1", id
    )
    if has_fixed_assignment_history:
        raise HTTPException(409, detail="この座席には過去の固定座席割当履歴があるため削除できません。廃止をご利用ください")
    has_reservation = await pool.fetchval("SELECT 1 FROM reservations WHERE seat_id = $1", id)
    if has_reservation:
        raise HTTPException(409, detail="この座席の予約履歴があるため削除できません。廃止をご利用ください")
    has_project_allocation = await pool.fetchval(
        "SELECT 1 FROM project_quarter_plans WHERE allocated_seats @> $1::jsonb", json.dumps([id])
    )
    if has_project_allocation:
        raise HTTPException(409, detail="この座席はプロジェクト座席の島の割当に含まれているため削除できません。廃止をご利用ください")
    await pool.execute("DELETE FROM seats WHERE id = $1", id)
    return {"detail": "座席を削除しました"}
