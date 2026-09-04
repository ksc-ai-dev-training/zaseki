# A-08, A-09, A-10, A-11, A-12 空き状況・予約（S-02）。詳細設計書3.3節・5.5.2節・6.4節
import json
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

_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


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
    """A-08: 自分の予約一覧（FR-01-4）。常に自分のuser_idのみが対象（5.4節）。

    従来のtype〔single/recurring〕をレスポンスから廃止し、seat_type（座席種別）に置き換えた
    （2026-09-03追加。「種別としてプロジェクト座席なのに周期予約になっているのは違和感を感じる」との
    報告を受けた。typeは予約の作り方〔A-10かA-18か〕を表すだけで、プロジェクト座席はA-18経由のため
    常にrecurringになり、S-02の一覧では実際の座席種別〔フリー／プロジェクト〕が分からなかった）。
    プロジェクト座席の専有は座席自体のseats.seat_typeを変更しない設計（3.3節・3.9節、A-46備考も参照）
    のため、reservations行はプロジェクト座席であってもseats.seat_type='free'のまま記録される。
    そのためA-46（search_reservations）のproject_name_for()と同じ考え方で、座席の島の割当
    （project_quarter_plans.allocated_seats）と予約日の曜日が確定した出社曜日（weekdays_finalized）に
    一致する行のみseat_typeを'project'に上書きする。
    あわせてregistrant（登録者）を、自分以外が登録した場合は従来の固定文言「代理予約」から、実際に
    登録した利用者（created_by）の氏名＋「（代理予約）」に変更した（「誰が登録したのか特定の名前が
    表示されるようにしてほしい」との要望を受けた）。"""
    today = Date.today()
    if scope == "upcoming":
        condition = "r.status = 'active' AND r.date >= $2"
        order = "r.date ASC"
    else:
        condition = "(r.status = 'cancelled' OR r.date < $2)"
        order = "r.date DESC"

    pool = get_pool()
    rows = await pool.fetch(
        f"""SELECT r.id, r.date, r.status, r.created_by, r.seat_id, s.seat_no, s.seat_type,
                   a.name AS area_name, cb.last_name AS created_by_last_name, cb.first_name AS created_by_first_name
            FROM reservations r
            JOIN seats s ON s.id = r.seat_id
            JOIN areas a ON a.id = s.area_id
            LEFT JOIN users cb ON cb.id = r.created_by
            WHERE r.user_id = $1 AND {condition}
            ORDER BY {order}""",
        user.id, today,
    )

    plan_rows = await pool.fetch(
        """SELECT pqp.period_start, pqp.period_end, pqp.allocated_seats, pqp.weekdays_finalized
           FROM project_quarter_plans pqp
           WHERE pqp.status = 'seats_allocated' AND pqp.allocated_seats IS NOT NULL"""
    )
    plans = [
        (
            p["period_start"], p["period_end"], set(json.loads(p["allocated_seats"])),
            set(json.loads(p["weekdays_finalized"])) if p["weekdays_finalized"] else set(),
        )
        for p in plan_rows
    ]

    def is_project_seat(seat_id: int, date: Date) -> bool:
        target_weekday = _WEEKDAY_CODES[date.weekday()]
        return any(
            seat_id in seat_ids and p_start <= date <= p_end and target_weekday in weekdays
            for p_start, p_end, seat_ids, weekdays in plans
        )

    items = []
    for r in rows:
        if scope == "upcoming":
            state = "upcoming"
        else:
            state = "cancelled" if r["status"] == "cancelled" else "used"
        if r["created_by"] == user.id:
            registrant = "本人"
        elif r["created_by_last_name"] is not None:
            registrant = f"{r['created_by_last_name']} {r['created_by_first_name']}（代理予約）"
        else:
            registrant = "代理予約"
        seat_type = "project" if is_project_seat(r["seat_id"], r["date"]) else r["seat_type"]
        items.append({
            "id": r["id"], "date": r["date"].isoformat(), "seat_no": r["seat_no"],
            "area": r["area_name"], "seat_type": seat_type,
            "registrant": registrant,
            "state": state,
        })
    return {"items": items}
