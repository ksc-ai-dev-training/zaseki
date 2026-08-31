# A-46, A-47, A-48, A-54 代理予約・取消（S-11）。詳細設計書3.11節
import calendar
from datetime import date as Date
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import get_pool, project_blocked_seats, release_expired_fixed_seats, users_with_current_project_seat

router = APIRouter(prefix="/api/reservations", tags=["proxy"])

# 雇用形態そのもの（employment_type）の表示名。役割列で使う「AB」（一般+契約のみの略称、
# 要件定義書v0.61）とは別物のため混同しないこと（2026-08-28訂正）。
EMPLOYMENT_TYPE_JA = {"employee": "社員", "contract": "契約職員", "bp": "BP"}


@router.get("/proxy-candidates")
async def list_proxy_candidates(q: str = "", _: CurrentUser = Depends(require_roles("admin"))):
    """A-54: 代理予約する対象者検索（登録済みの全利用者が対象、氏名の部分一致）。2026-08-28追加。
    S-05のA-52（固定座席を持たない利用者に限定）と異なり、S-11は固定座席の指定・プロジェクトメンバー
    への代理予約のいずれにも該当しない任意の利用者が対象のため、固定座席の有無で絞り込まない
    （基本設計書4.11節「対象者検索、登録済みの全利用者が対象」）。座席利用状況は'free'|'fixed'|'project'
    の3区分（SeatTypeと同じ値、2026-08-28再訂正。プロジェクト座席の利用状況〔T-05〜T-07〕は当初
    未実装のため区別せず一律の文言を返していたが、実装済みとなったため本日時点で実際に利用中かどうか
    を区別する）。"""
    await release_expired_fixed_seats()
    rows = await get_pool().fetch(
        """SELECT u.id, u.last_name, u.first_name, u.employment_type,
                  fsa.seat_id AS fixed_seat_id
           FROM users u
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = u.id
           WHERE u.deleted_at IS NULL
             AND ($1 = '' OR (u.last_name || u.first_name) ILIKE '%' || $1 || '%')
           ORDER BY u.last_name, u.first_name""",
        q,
    )
    pj_user_ids = await users_with_current_project_seat()
    return {
        "items": [
            {
                "user_id": r["id"],
                "user_name": f"{r['last_name']} {r['first_name']}",
                "employment_type": EMPLOYMENT_TYPE_JA.get(r["employment_type"], r["employment_type"]),
                "current_status": (
                    "fixed" if r["fixed_seat_id"] is not None
                    else "project" if r["id"] in pj_user_ids
                    else "free"
                ),
            }
            for r in rows
        ]
    }


@router.get("/search")
async def search_reservations(
    user_name: str = "",
    seat_type: Literal["all", "free", "fixed"] = "all",
    start: str = "",
    end: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-46: 代理予約・取消の対象者検索（予約・割当単位の一覧、座席種別を問わず）。
    表示期間（start/end、YYYY-MM）はフリー座席の予約日にのみ適用する（固定座席は日付を
    持たない恒久的な割当のため対象外、基本設計書4.11節）。プロジェクト座席（T-05〜T-07）は
    未実装のため対象に含めない（2026-08-28追加、A-46に絞り込みパラメータを追加）。"""
    await release_expired_fixed_seats()
    pool = get_pool()
    period_start = Date.fromisoformat(f"{start}-01") if start else None
    if end:
        end_year, end_month = (int(p) for p in end.split("-"))
        period_end = Date(end_year, end_month, calendar.monthrange(end_year, end_month)[1])
    else:
        period_end = None

    items = []
    if seat_type in ("all", "free"):
        rows = await pool.fetch(
            """SELECT r.id, r.date, u.id AS user_id, u.last_name, u.first_name, s.seat_no, a.name AS area_name
               FROM reservations r
               JOIN users u ON u.id = r.user_id
               JOIN seats s ON s.id = r.seat_id
               JOIN areas a ON a.id = s.area_id
               WHERE r.status = 'active' AND s.seat_type = 'free'
                 AND ($1 = '' OR (u.last_name || u.first_name) ILIKE '%' || $1 || '%')
                 AND ($2::date IS NULL OR r.date >= $2::date)
                 AND ($3::date IS NULL OR r.date <= $3::date)
               ORDER BY r.date, u.last_name, u.first_name""",
            user_name, period_start, period_end,
        )
        items += [
            {
                "kind": "reservation", "id": r["id"], "user_id": r["user_id"],
                "user_name": f"{r['last_name']} {r['first_name']}", "seat_type": "free",
                "date": r["date"].isoformat(), "seat_no": r["seat_no"], "area": r["area_name"],
            }
            for r in rows
        ]
    if seat_type in ("all", "fixed"):
        rows = await pool.fetch(
            """SELECT fsa.seat_id, u.id AS user_id, u.last_name, u.first_name, s.seat_no, a.name AS area_name
               FROM fixed_seat_assignments fsa
               JOIN users u ON u.id = fsa.user_id
               JOIN seats s ON s.id = fsa.seat_id
               JOIN areas a ON a.id = s.area_id
               WHERE ($1 = '' OR (u.last_name || u.first_name) ILIKE '%' || $1 || '%')
               ORDER BY u.last_name, u.first_name""",
            user_name,
        )
        items += [
            {
                "kind": "fixed", "id": r["seat_id"], "user_id": r["user_id"],
                "user_name": f"{r['last_name']} {r['first_name']}", "seat_type": "fixed",
                "date": None, "seat_no": r["seat_no"], "area": r["area_name"],
            }
            for r in rows
        ]
    return {"items": items}


class ProxyReservationCreate(BaseModel):
    user_id: int
    seat_id: int
    date: Date


@router.post("/proxy")
async def create_proxy_reservation(body: ProxyReservationCreate, admin_user: CurrentUser = Depends(require_roles("admin"))):
    """A-47: フリー座席の代理予約（新規はフリー座席のみ、FR-01-5）。管理部はFR-01-7により
    座席タイプ別の確保サイクル・予約可能期間（RULE-05）の制限を受けない。RULE-02・RULE-07・
    RULE-03は対象者（body.user_id）の状態で判定する（A-09と同様の考え方だが、判定対象は
    呼び出し者ではなく代理予約の対象者）。周期予約（繰り返しパターン指定）はA-10が未実装のため
    本APIでは単発のみ対応する（2026-08-28追加時点のスコープ、A-10実装後に拡張予定）。"""
    pool = get_pool()
    await release_expired_fixed_seats()
    seat = await pool.fetchrow("SELECT id, seat_no, seat_type, status FROM seats WHERE id = $1", body.seat_id)
    if seat is None or seat["status"] != "active":
        raise HTTPException(404, detail="対象が見つかりません")
    if seat["seat_type"] != "free":
        raise HTTPException(400, detail="この座席はフリー座席ではないため予約できません")
    blocked = await project_blocked_seats(body.date)
    if seat["id"] in blocked:
        raise HTTPException(400, detail=f"この座席は{blocked[seat['id']]}のプロジェクト座席として確保されているため予約できません")
    target = await pool.fetchrow("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", body.user_id)
    if target is None:
        raise HTTPException(404, detail="対象が見つかりません")

    has_fixed_seat = await pool.fetchval(
        "SELECT 1 FROM fixed_seat_assignments WHERE user_id = $1", body.user_id
    )
    if has_fixed_seat:
        raise HTTPException(400, detail="固定座席が割り当てられているため、フリー座席は予約できません")

    duplicate = await pool.fetchval(
        """SELECT 1 FROM reservations r JOIN seats s ON s.id = r.seat_id
           WHERE r.user_id = $1 AND r.date = $2 AND r.status = 'active' AND s.seat_type = 'free'""",
        body.user_id, body.date,
    )
    if duplicate:
        raise HTTPException(400, detail="同じ日に複数の座席は予約できません")

    try:
        row = await pool.fetchrow(
            """INSERT INTO reservations (seat_id, user_id, date, created_by)
               VALUES ($1, $2, $3, $4) RETURNING id, date, status""",
            seat["id"], body.user_id, body.date, admin_user.id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, detail="この座席はすでに予約されています")

    return {
        "id": row["id"], "seat_id": seat["id"], "seat_no": seat["seat_no"],
        "date": row["date"].isoformat(), "status": row["status"],
    }


@router.delete("/proxy/{id}")
async def cancel_proxy_reservation(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-48: フリー座席の予約を代理で取消する（対象者を問わない）。固定座席の解除は既存の
    A-21（DELETE /fixed-seat-assignments/{seat_id}）をそのまま使う（S-11の一覧はkind='fixed'の
    行についてA-21を呼ぶ、2026-08-28追加。ロジックの重複を避けるため）。"""
    row = await get_pool().fetchrow(
        """UPDATE reservations SET status = 'cancelled', updated_at = now()
           WHERE id = $1 AND status = 'active'
           RETURNING id""",
        id,
    )
    if row is None:
        raise HTTPException(404, detail="対象が見つかりません")
    return {"detail": "予約を取り消しました"}
