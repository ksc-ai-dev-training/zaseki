# A-08, A-09, A-10, A-11, A-12 空き状況・予約（S-02）。詳細設計書3.3節・5.5.2節・6.4節
from datetime import date as Date
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import (
    free_seat_open_date,
    generate_recurring_reservations,
    get_pool,
    project_blocked_seats,
    release_expired_fixed_seats,
)

router = APIRouter(prefix="/api/reservations", tags=["reservations"])


class ReservationCreate(BaseModel):
    seat_id: int
    date: Date


@router.post("")
async def create_reservation(body: ReservationCreate, user: CurrentUser = Depends(require_auth)):
    """A-09: 単発予約の登録（FR-01-1）。role='admin'はFR-01-7によりRULE-05（予約可能期間）をスキップするが、
    RULE-02（同一日複数予約禁止）・RULE-07（固定座席利用者はフリー座席を予約不可）は
    自分の予約として登録する限り管理部にも適用される（詳細設計書6章）。"""
    pool = get_pool()
    seat = await pool.fetchrow(
        "SELECT id, seat_no, seat_type, status FROM seats WHERE id = $1", body.seat_id
    )
    if seat is None or seat["status"] != "active":
        raise HTTPException(404, detail="対象が見つかりません")
    if seat["seat_type"] != "free":
        raise HTTPException(400, detail="この座席はフリー座席ではないため予約できません")

    blocked = await project_blocked_seats(body.date)
    if seat["id"] in blocked:
        raise HTTPException(400, detail=f"この座席は{blocked[seat['id']]}のプロジェクト座席として確保されているため予約できません")

    if user.role != "admin":
        if body.date < Date.today():
            raise HTTPException(400, detail="過去の日付は予約できません")
        open_date = await free_seat_open_date(body.date)
        if Date.today() < open_date:
            raise HTTPException(400, detail=f"この座席は{open_date.month}月{open_date.day}日から予約できます")

    # RULE-07: 固定座席の利用者はフリー座席を予約できない（同一人物が固定座席とフリー座席を
    # 同時に保有する状態を防ぐ）。RULE-02と同様、管理部が自分の予約として登録する場合も対象とする。
    # 有効期限切れの割当を先に解除しておくことで、期限切れ後にこの判定へ誤って引っかからないようにする。
    await release_expired_fixed_seats()
    has_fixed_seat = await pool.fetchval(
        "SELECT 1 FROM fixed_seat_assignments WHERE user_id = $1", user.id
    )
    if has_fixed_seat:
        raise HTTPException(400, detail="固定座席が割り当てられているため、フリー座席は予約できません")

    # RULE-02: 一般利用者は同一日に複数のフリー座席を予約できない。
    # 詳細設計書6章のとおりRULE-05と異なりP-ADMIN除外の定めがないため、管理部が自分の予約として
    # 登録する場合（A-09は常に本人の予約として登録する）も対象とする。
    duplicate = await pool.fetchval(
        """SELECT 1 FROM reservations r JOIN seats s ON s.id = r.seat_id
           WHERE r.user_id = $1 AND r.date = $2 AND r.status = 'active' AND s.seat_type = 'free'""",
        user.id, body.date,
    )
    if duplicate:
        raise HTTPException(400, detail="同じ日に複数の座席は予約できません")

    try:
        row = await pool.fetchrow(
            """INSERT INTO reservations (seat_id, user_id, date, created_by)
               VALUES ($1, $2, $3, $4) RETURNING id, date, status""",
            seat["id"], user.id, body.date, user.id,
        )
    except asyncpg.UniqueViolationError:
        # RULE-03: 同一座席・同一日の二重予約禁止
        raise HTTPException(409, detail="この座席はすでに予約されています")

    return {
        "id": row["id"], "seat_id": seat["id"], "seat_no": seat["seat_no"],
        "date": row["date"].isoformat(), "status": row["status"],
    }


class RecurringPattern(BaseModel):
    type: Literal["daily", "weekly"]
    weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]] | None = None


class RecurringReservationCreate(BaseModel):
    seat_id: int
    pattern: RecurringPattern
    start_date: Date
    end_date: Date


@router.post("/recurring")
async def create_recurring_reservation(body: RecurringReservationCreate, user: CurrentUser = Depends(require_auth)):
    """A-10: 周期予約の登録（FR-01-6・D11）。role='admin'はFR-01-7によりRULE-05等をスキップする
    （A-09と同様）。3.2節のとおり、ルール違反や座席競合が生じる日のみ除外し、他の日は登録する。"""
    if body.start_date > body.end_date:
        raise HTTPException(400, detail="開始日は終了日以前を指定してください")
    if body.pattern.type == "weekly" and not body.pattern.weekdays:
        raise HTTPException(400, detail="毎週の場合は曜日を1つ以上選択してください")

    pool = get_pool()
    seat = await pool.fetchrow(
        "SELECT id, seat_no, seat_type, status FROM seats WHERE id = $1", body.seat_id
    )
    if seat is None or seat["status"] != "active":
        raise HTTPException(404, detail="対象が見つかりません")
    if seat["seat_type"] != "free":
        raise HTTPException(400, detail="この座席はフリー座席ではないため予約できません")

    await release_expired_fixed_seats()
    result = await generate_recurring_reservations(
        seat["id"], user.id, body.pattern.model_dump(exclude_none=True), body.start_date, body.end_date, user.id,
        enforce_rule05=(user.role != "admin"), check_project_block=True,
    )
    return {"rule_id": result["rule_id"], "seat_id": seat["id"], "seat_no": seat["seat_no"], "results": result["results"]}


@router.delete("/{reservation_id}")
async def cancel_reservation(reservation_id: int, user: CurrentUser = Depends(require_auth)):
    """A-11: 単発予約の取消。対象予約のuser_id＝自分（P-OWNER）。周期予約から生成された行（recurring_rule_id
    が設定された行）を1件だけ指定した場合も、その日だけを取り消す（A-12と同じ結果になる、2026-08-28追加）。"""
    row = await get_pool().fetchrow(
        """UPDATE reservations SET status = 'cancelled', updated_at = now()
           WHERE id = $1 AND user_id = $2 AND status = 'active'
           RETURNING id""",
        reservation_id, user.id,
    )
    if row is None:
        raise HTTPException(404, detail="対象が見つかりません")
    return {"detail": "予約を取り消しました"}


@router.delete("/recurring/{rule_id}")
async def cancel_recurring_occurrence(rule_id: int, date: Date, user: CurrentUser = Depends(require_auth)):
    """A-12: 周期予約のうち指定した1日分のみを取消（一部取消、REQ-F-03）。対象の周期予約ルールの
    user_id＝自分（P-OWNER）。当該日のT-08行のみstatus='cancelled'にする（ルール自体〔T-09〕は残す）。"""
    row = await get_pool().fetchrow(
        """UPDATE reservations SET status = 'cancelled', updated_at = now()
           WHERE recurring_rule_id = $1 AND date = $2 AND user_id = $3 AND status = 'active'
           RETURNING id""",
        rule_id, date, user.id,
    )
    if row is None:
        raise HTTPException(404, detail="対象が見つかりません")
    return {"detail": "予約を取り消しました"}


@router.get("/mine")
async def list_my_reservations(
    scope: Literal["upcoming", "past"], user: CurrentUser = Depends(require_auth)
):
    """A-08: 自分の予約一覧（FR-01-4）。常に自分のuser_idのみが対象（5.4節）"""
    today = Date.today()
    if scope == "upcoming":
        condition = "r.status = 'active' AND r.date >= $2"
        order = "r.date ASC"
    else:
        condition = "(r.status = 'cancelled' OR r.date < $2)"
        order = "r.date DESC"

    rows = await get_pool().fetch(
        f"""SELECT r.id, r.date, r.status, r.created_by, r.recurring_rule_id, s.seat_no, a.name AS area_name
            FROM reservations r
            JOIN seats s ON s.id = r.seat_id
            JOIN areas a ON a.id = s.area_id
            WHERE r.user_id = $1 AND {condition}
            ORDER BY {order}""",
        user.id, today,
    )

    items = []
    for r in rows:
        if scope == "upcoming":
            state = "upcoming"
        else:
            state = "cancelled" if r["status"] == "cancelled" else "used"
        items.append({
            "id": r["id"], "date": r["date"].isoformat(), "seat_no": r["seat_no"],
            "area": r["area_name"], "type": "recurring" if r["recurring_rule_id"] is not None else "single",
            "registrant": "本人" if r["created_by"] == user.id else "代理予約",
            "state": state,
        })
    return {"items": items}
