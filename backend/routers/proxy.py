# A-46, A-47, A-48, A-54, A-69 代理予約・取消（S-11）。詳細設計書3.11節
import calendar
import json
from datetime import date as Date, timedelta
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import (
    free_seat_bookable_period,
    get_pool,
    project_blocked_seats,
    release_expired_fixed_seats,
    users_with_current_project_seat,
)
from routers.seats import _seat_sort_key

router = APIRouter(prefix="/api/reservations", tags=["proxy"])

# 雇用形態そのもの（employment_type）の表示名。役割列で使う「AB」（一般+契約のみの略称、
# 要件定義書v0.61）とは別物のため混同しないこと（2026-08-28訂正）。
EMPLOYMENT_TYPE_JA = {"employee": "社員", "contract": "契約職員", "bp": "BP"}

_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


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
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = u.id AND fsa.ended_on IS NULL
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


async def _project_name_lookup(pool):
    """座席・日付からプロジェクト名を判定する関数を返す（A-46・A-69で共有）。座席の島の割当期間内、
    かつその日の曜日が確定した出社曜日（weekdays_finalized）に含まれる場合のみプロジェクト名を返す
    （database.project_blocked_seats()と同じ考え方。確定曜日以外の日にその座席へ入った予約は、
    プロジェクト座席としての専有対象外の日に行われた通常のフリー座席予約であるため対象外とする）。
    元はA-46にのみあったロジックをA-69（期間ビュー、2026-09-03追加）と共有するため切り出した。"""
    plan_rows = await pool.fetch(
        """SELECT p.name, pqp.period_start, pqp.period_end, pqp.allocated_seats, pqp.weekdays_finalized
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.status = 'seats_allocated' AND pqp.allocated_seats IS NOT NULL"""
    )
    plans = [
        (
            r["name"], r["period_start"], r["period_end"], set(json.loads(r["allocated_seats"])),
            set(json.loads(r["weekdays_finalized"])) if r["weekdays_finalized"] else set(),
        )
        for r in plan_rows
    ]

    def project_name_for(seat_id: int, date: Date) -> str | None:
        target_weekday = _WEEKDAY_CODES[date.weekday()]
        for name, p_start, p_end, seat_ids, weekdays in plans:
            if seat_id in seat_ids and p_start <= date <= p_end and target_weekday in weekdays:
                return name
        return None

    return project_name_for


@router.get("/search")
async def search_reservations(
    user_name: str = "",
    seat_type: Literal["all", "free", "fixed", "project"] = "all",
    start: str = "",
    end: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-46: 代理予約・取消の対象者検索（予約・割当単位の一覧、座席種別を問わず）。
    表示期間（start/end、YYYY-MM）はフリー座席・プロジェクト座席の予約日にのみ適用する
    （固定座席は日付を持たない恒久的な割当のため対象外、基本設計書4.11節）。

    プロジェクト座席の専有は座席自体のseat_typeを変更しない設計（3.3節・3.9節参照）のため、
    reservations行はプロジェクト座席であってもseats.seat_type='free'のまま記録される。
    そのため「フリー座席」のクエリ結果に対し、座席の島の割当（project_quarter_plans.
    allocated_seats）とその予約日が対象期間内に含まれるかを都度突き合わせ、該当すれば
    'project'として分類し直す（2026-09-01訂正。「PJ席を利用しているのにフリー座席の表示に
    なっている」との報告を受けた。従来はT-05〜T-07が未実装だった頃の「プロジェクト座席は
    対象に含めない」という古い前提のままで、実装後もこの区別が行われていなかった）。
    割当期間内であっても、予約日の曜日がそのプロジェクトの確定した出社曜日（weekdays_finalized）に
    含まれない場合は'project'に分類しない（2026-09-02追加。database.project_blocked_seats()と
    同じ考え方。確定曜日以外の日にその座席へ入った予約は、プロジェクト座席としての専有対象外の
    日に行われた通常のフリー座席予約であるため）。"""
    await release_expired_fixed_seats()
    pool = get_pool()
    period_start = Date.fromisoformat(f"{start}-01") if start else None
    if end:
        end_year, end_month = (int(p) for p in end.split("-"))
        period_end = Date(end_year, end_month, calendar.monthrange(end_year, end_month)[1])
    else:
        period_end = None

    project_name_for = await _project_name_lookup(pool)

    items = []
    if seat_type in ("all", "free", "project"):
        rows = await pool.fetch(
            """SELECT r.id, r.date, u.id AS user_id, u.last_name, u.first_name,
                      s.id AS seat_id, s.seat_no, a.name AS area_name
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
        for r in rows:
            project_name = project_name_for(r["seat_id"], r["date"])
            row_type = "project" if project_name else "free"
            if seat_type != "all" and seat_type != row_type:
                continue
            items.append({
                "kind": "reservation", "id": r["id"], "user_id": r["user_id"],
                "user_name": f"{r['last_name']} {r['first_name']}", "seat_type": row_type,
                "date": r["date"].isoformat(), "seat_no": r["seat_no"], "area": r["area_name"],
                "project_name": project_name,
            })
    if seat_type in ("all", "fixed"):
        rows = await pool.fetch(
            """SELECT fsa.seat_id, u.id AS user_id, u.last_name, u.first_name, s.seat_no, a.name AS area_name
               FROM fixed_seat_assignments fsa
               JOIN users u ON u.id = fsa.user_id
               JOIN seats s ON s.id = fsa.seat_id
               JOIN areas a ON a.id = s.area_id
               WHERE fsa.ended_on IS NULL
                 AND ($1 = '' OR (u.last_name || u.first_name) ILIKE '%' || $1 || '%')
               ORDER BY u.last_name, u.first_name""",
            user_name,
        )
        items += [
            {
                "kind": "fixed", "id": r["seat_id"], "user_id": r["user_id"],
                "user_name": f"{r['last_name']} {r['first_name']}", "seat_type": "fixed",
                "date": None, "seat_no": r["seat_no"], "area": r["area_name"],
                "project_name": None,
            }
            for r in rows
        ]
    return {"items": items}


@router.get("/period-grid")
async def get_period_grid(
    start: Date | None = None,
    end: Date | None = None,
    area: Literal["all", "north", "east", "west"] = "all",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-69: 代理予約・取消の期間ビュー（S-11）。S-02のA-07（期間ビュー）と同じ座席×日付の
    マトリクス形式だが、管理部が任意の利用者の予約・割当を代理で取消・変更する（A-48・A-21）
    ための管理画面のため、A-07のような氏名の匿名化（姓のみの表示・「自分」表記・他者の
    reservation_idを隠す）は行わず、対象者の氏名・ユーザーIDと操作対象のID（reservation_idまたは
    seats.id）を常に返す（2026-09-03追加。「座席の予約・割当を代理で取り消すをS-02の期間ビューの
    ような画面にしたい」との要望を受けた）。固定座席もA-07のような「初日のみ氏名表示」の圧縮は
    行わず、どの日をクリックしても同じ固定座席の解除・変更操作ができるよう毎日氏名を返す。"""
    await release_expired_fixed_seats()
    pool = get_pool()
    full_start, full_end = await free_seat_bookable_period()
    range_start = min(max(start or full_start, full_start), full_end)
    range_end = min(max(end or full_end, full_start), full_end)
    if range_start > range_end:
        range_start, range_end = range_end, range_start

    project_name_for = await _project_name_lookup(pool)

    rows = await pool.fetch(
        """SELECT s.id, s.seat_no, s.seat_type, a.name AS area_name,
                  r.date, r.id AS reservation_id, r.user_id AS reserved_user_id, u.last_name, u.first_name
           FROM seats s
           JOIN areas a ON a.id = s.area_id
           LEFT JOIN reservations r
               ON r.seat_id = s.id AND r.date BETWEEN $1 AND $2 AND r.status = 'active'
           LEFT JOIN users u ON u.id = r.user_id
           WHERE s.status = 'active'
             AND ($3 = 'all' OR lower(a.name) = $3)
           ORDER BY CASE a.name WHEN 'NORTH' THEN 1 WHEN 'EAST' THEN 2 WHEN 'WEST' THEN 3 END, s.seat_no""",
        range_start, range_end, area,
    )

    seats: dict[int, dict] = {}
    for r in rows:
        seat = seats.setdefault(r["id"], {
            "id": r["id"], "seat_no": r["seat_no"], "area": r["area_name"],
            "seat_type": r["seat_type"], "days": {},
        })
        if r["date"] is None:
            continue
        if r["reserved_user_id"] is None:
            seat["days"][r["date"].isoformat()] = {
                "status": "free", "kind": None, "id": None,
                "user_id": None, "user_name": None, "project_name": None,
            }
            continue
        seat["days"][r["date"].isoformat()] = {
            "status": "reserved", "kind": "reservation", "id": r["reservation_id"],
            "user_id": r["reserved_user_id"], "user_name": f"{r['last_name']} {r['first_name']}",
            "project_name": project_name_for(r["id"], r["date"]),
        }

    # 表示期間と重なる固定座席割当を履歴も含めて取得する（今の割当だけでなく、期間内に
    # 交代があった場合は両方拾う。2026-09-04修正、seats.pyの同種の処理と同じ考え方）
    fixed_rows = await pool.fetch(
        """SELECT fsa.seat_id, fsa.user_id, fsa.valid_from, fsa.valid_until, fsa.ended_on,
                  u.last_name, u.first_name
           FROM fixed_seat_assignments fsa JOIN users u ON u.id = fsa.user_id
           WHERE fsa.valid_from <= $2
             AND (fsa.ended_on IS NULL OR fsa.ended_on >= $1)
             AND (fsa.valid_until IS NULL OR fsa.valid_until >= $1)""",
        range_start, range_end,
    )
    fixed_by_seat_id: dict[int, list] = {}
    for fr in fixed_rows:
        fixed_by_seat_id.setdefault(fr["seat_id"], []).append(fr)
    for seat_id, rows_for_seat in fixed_by_seat_id.items():
        seat = seats.get(seat_id)
        if seat is None:
            continue
        d = range_start
        while d <= range_end:
            match = next(
                (
                    fr for fr in rows_for_seat
                    if fr["valid_from"] <= d
                    and (fr["ended_on"] is None or d <= fr["ended_on"])
                    and (fr["valid_until"] is None or d <= fr["valid_until"])
                ),
                None,
            )
            if match is not None:
                seat["days"][d.isoformat()] = {
                    "status": "fixed", "kind": "fixed", "id": match["seat_id"],
                    "user_id": match["user_id"], "user_name": f"{match['last_name']} {match['first_name']}",
                    "project_name": None,
                }
            d += timedelta(days=1)

    dates = []
    d = range_start
    while d <= range_end:
        dates.append(d.isoformat())
        d += timedelta(days=1)

    return {
        "start": range_start.isoformat(), "end": range_end.isoformat(),
        "full_start": full_start.isoformat(), "full_end": full_end.isoformat(),
        "dates": dates,
        "seats": sorted(seats.values(), key=lambda s: _seat_sort_key(s["seat_no"])),
    }


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
        "SELECT 1 FROM fixed_seat_assignments WHERE user_id = $1 AND ended_on IS NULL", body.user_id
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
