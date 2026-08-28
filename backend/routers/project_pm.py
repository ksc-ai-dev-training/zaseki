# A-13〜A-18 プロジェクト座席・PM側（S-04）。詳細設計書3.4節
import json
from datetime import date as Date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import generate_recurring_reservations, get_pool
from routers.project_seats import _format_seat_range

router = APIRouter(prefix="/api", tags=["project-pm"])


async def _member_row(pool, project_id: int, user_id: int):
    return await pool.fetchrow(
        "SELECT id, project_title, can_assign_seats FROM project_members WHERE project_id = $1 AND user_id = $2",
        project_id, user_id,
    )


async def _require_owner(pool, plan_id: int, user_id: int):
    """P-OWNER: 対象プロジェクトのT-06に自分の行があること（A-14・A-15共通）"""
    plan = await pool.fetchrow(
        """SELECT pqp.*, p.name AS project_name, p.proxy_user_id
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        plan_id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    member = await _member_row(pool, plan["project_id"], user_id)
    if member is None:
        raise HTTPException(403, detail="この操作を行う権限がありません")
    return plan, member


async def _seat_labels(pool, seat_ids: list[int]) -> dict[int, str]:
    if not seat_ids:
        return {}
    rows = await pool.fetch("SELECT id, seat_no FROM seats WHERE id = ANY($1::bigint[])", seat_ids)
    return {r["id"]: r["seat_no"] for r in rows}


@router.get("/projects/mine")
async def list_my_projects(user: CurrentUser = Depends(require_auth)):
    """A-13: 自分がPM・PL・SL・メンバーであるプロジェクトと、対象四半期の計画状況の一覧。
    各プロジェクトについて直近のperiod_startを持つ計画（現在進行中とみなす1件）のみを返す
    （5.4節のスコープ判定、2026-08-28追加）。"""
    rows = await get_pool().fetch(
        """SELECT pm.project_id, p.name AS project_name, pm.project_title, pm.can_assign_seats,
                  plan.id AS plan_id, plan.period_start, plan.period_end, plan.status,
                  plan.required_seats, plan.allocated_seats
           FROM project_members pm
           JOIN projects p ON p.id = pm.project_id
           LEFT JOIN LATERAL (
               SELECT * FROM project_quarter_plans
               WHERE project_id = pm.project_id ORDER BY period_start DESC LIMIT 1
           ) plan ON true
           WHERE pm.user_id = $1
           ORDER BY p.name""",
        user.id,
    )
    pool = get_pool()
    all_seat_ids = {sid for r in rows if r["allocated_seats"] for sid in json.loads(r["allocated_seats"])}
    seat_no_by_id = await _seat_labels(pool, list(all_seat_ids))

    items = []
    for r in rows:
        plan = None
        if r["plan_id"] is not None:
            allocated_seat_ids = json.loads(r["allocated_seats"]) if r["allocated_seats"] else None
            plan = {
                "id": r["plan_id"], "period_start": r["period_start"].isoformat(),
                "period_end": r["period_end"].isoformat(), "status": r["status"],
                "required_seats": r["required_seats"],
                "allocated_seat_label": (
                    _format_seat_range([seat_no_by_id[sid] for sid in allocated_seat_ids if sid in seat_no_by_id])
                    if allocated_seat_ids else None
                ),
            }
        items.append({
            "project_id": r["project_id"], "project_name": r["project_name"],
            "project_title": r["project_title"], "can_assign_seats": r["can_assign_seats"],
            "plan": plan,
        })
    return {"items": items}


@router.get("/project-quarter-plans/{id}")
async def get_quarter_plan_detail(id: int, user: CurrentUser = Depends(require_auth)):
    """A-14: 四半期計画の詳細（必要座席数、状態、確定曜日、割当済み座席、メンバーごとの座席確保状況）。"""
    pool = get_pool()
    plan, my_member = await _require_owner(pool, id, user.id)

    allocated_seat_ids = json.loads(plan["allocated_seats"]) if plan["allocated_seats"] else None
    seat_no_by_id = await _seat_labels(pool, allocated_seat_ids or [])

    response = await pool.fetchrow(
        "SELECT choice1_weekdays, choice2_weekdays, note, requested_seats FROM project_weekday_responses WHERE plan_id = $1",
        id,
    )

    members_rows = await pool.fetch(
        """SELECT pm.id AS member_id, pm.user_id, u.last_name, u.first_name, pm.project_title, pm.can_assign_seats
           FROM project_members pm JOIN users u ON u.id = pm.user_id
           WHERE pm.project_id = $1 ORDER BY pm.id""",
        plan["project_id"],
    )
    assigned_seat_by_user: dict[int, int] = {}
    if allocated_seat_ids:
        assign_rows = await pool.fetch(
            """SELECT DISTINCT ON (r.user_id) r.user_id, r.seat_id
               FROM reservations r
               WHERE r.seat_id = ANY($1::bigint[]) AND r.status = 'active'
                 AND r.date BETWEEN $2 AND $3
               ORDER BY r.user_id, r.date""",
            allocated_seat_ids, plan["period_start"], plan["period_end"],
        )
        assigned_seat_by_user = {r["user_id"]: r["seat_id"] for r in assign_rows}

    is_pmpl = my_member["project_title"] in ("PM", "PL")
    can_manage_seat_assign = (
        user.role == "admin"
        or plan["proxy_user_id"] == user.id
        or my_member["can_assign_seats"]
    )

    has_previous = await pool.fetchval(
        "SELECT 1 FROM project_quarter_plans WHERE project_id = $1 AND period_start < $2 LIMIT 1",
        plan["project_id"], plan["period_start"],
    )

    return {
        "id": plan["id"], "project_id": plan["project_id"], "project_name": plan["project_name"],
        "period_start": plan["period_start"].isoformat(), "period_end": plan["period_end"].isoformat(),
        "status": plan["status"], "required_seats": plan["required_seats"],
        "weekdays_finalized": json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else None,
        "allocated_seat_ids": allocated_seat_ids,
        "allocated_seat_label": (
            _format_seat_range([seat_no_by_id[sid] for sid in allocated_seat_ids if sid in seat_no_by_id])
            if allocated_seat_ids else None
        ),
        # 「割り当てる座席」の選択肢（未確保のメンバー向け）に座席番号を表示するため、
        # allocated_seat_idsと対になる座席番号一覧を返す（2026-08-28追加）
        "allocated_seats": (
            [{"id": sid, "seat_no": seat_no_by_id[sid]} for sid in allocated_seat_ids if sid in seat_no_by_id]
            if allocated_seat_ids else None
        ),
        "my_project_title": my_member["project_title"], "is_pmpl": is_pmpl,
        "can_manage_seat_assign": can_manage_seat_assign,
        "response": (
            {
                "choice1_weekdays": json.loads(response["choice1_weekdays"]),
                "choice2_weekdays": json.loads(response["choice2_weekdays"]),
                "note": response["note"], "requested_seats": response["requested_seats"],
            } if response else None
        ),
        "has_previous_plan": bool(has_previous),
        "members": [
            {
                "member_id": m["member_id"], "user_id": m["user_id"],
                "name": f"{m['last_name']} {m['first_name']}",
                "project_title": m["project_title"], "can_assign_seats": m["can_assign_seats"],
                "assigned_seat_id": assigned_seat_by_user.get(m["user_id"]),
                "assigned_seat_no": seat_no_by_id.get(assigned_seat_by_user.get(m["user_id"])),
            }
            for m in members_rows
        ],
    }


@router.get("/project-quarter-plans/{id}/previous")
async def get_previous_quarter_plan(id: int, user: CurrentUser = Depends(require_auth)):
    """A-15: 前回サイクル（3か月前とは限らず、同一プロジェクトで直近のもの）の計画を参照専用で取得（D13）。"""
    pool = get_pool()
    plan, _ = await _require_owner(pool, id, user.id)

    previous = await pool.fetchrow(
        """SELECT * FROM project_quarter_plans
           WHERE project_id = $1 AND period_start < $2
           ORDER BY period_start DESC LIMIT 1""",
        plan["project_id"], plan["period_start"],
    )
    if previous is None:
        raise HTTPException(404, detail="対象が見つかりません")

    allocated_seat_ids = json.loads(previous["allocated_seats"]) if previous["allocated_seats"] else []
    seat_no_by_id = await _seat_labels(pool, allocated_seat_ids)
    assignments = []
    if allocated_seat_ids:
        rows = await pool.fetch(
            """SELECT DISTINCT ON (r.user_id) r.user_id, r.seat_id, u.last_name, u.first_name
               FROM reservations r JOIN users u ON u.id = r.user_id
               WHERE r.seat_id = ANY($1::bigint[]) AND r.status = 'active'
                 AND r.date BETWEEN $2 AND $3
               ORDER BY r.user_id, r.date""",
            allocated_seat_ids, previous["period_start"], previous["period_end"],
        )
        assignments = [
            {"user_id": r["user_id"], "name": f"{r['last_name']} {r['first_name']}", "seat_no": seat_no_by_id.get(r["seat_id"])}
            for r in rows
        ]

    return {
        "id": previous["id"], "period_start": previous["period_start"].isoformat(),
        "period_end": previous["period_end"].isoformat(), "assignments": assignments,
    }


class SurveyResponseBody(BaseModel):
    choice1_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]]
    choice2_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]]
    note: str | None = None
    requested_seats: int | None = None


@router.put("/project-quarter-plans/{id}/response")
async def submit_survey_response(id: int, body: SurveyResponseBody, user: CurrentUser = Depends(require_auth)):
    """A-16: 出社曜日アンケートへの回答（FR-03-4）。T-11をUPSERT。requested_seatsはT-07.required_seats
    へ自動反映する。P-PMPL（project_title∈{'PM','PL'}）のみ、status='survey_open'の間のみ回答できる
    （曜日確定後は変更不可、2026-08-28追加）。"""
    if len(body.choice1_weekdays) != 2:
        raise HTTPException(400, detail="第一希望は曜日を2つ選択してください")
    if len(body.choice2_weekdays) != 2:
        raise HTTPException(400, detail="第二希望は曜日を2つ選択してください")
    if body.requested_seats is not None and body.requested_seats < 1:
        raise HTTPException(400, detail="必要座席数は1以上を指定してください")
    if body.note is not None and len(body.note) > 500:
        raise HTTPException(400, detail="備考は500文字以内で入力してください")

    pool = get_pool()
    plan = await pool.fetchrow("SELECT id, project_id, status FROM project_quarter_plans WHERE id = $1", id)
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    member = await _member_row(pool, plan["project_id"], user.id)
    if member is None or member["project_title"] not in ("PM", "PL"):
        raise HTTPException(403, detail="この操作を行う権限がありません")
    if plan["status"] != "survey_open":
        raise HTTPException(400, detail="現在はアンケートに回答できません")

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """INSERT INTO project_weekday_responses (plan_id, responded_by, choice1_weekdays, choice2_weekdays, note, requested_seats)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (plan_id) DO UPDATE SET
                       responded_by = $2, choice1_weekdays = $3, choice2_weekdays = $4, note = $5,
                       requested_seats = $6, responded_at = now()""",
                id, user.id, json.dumps(body.choice1_weekdays), json.dumps(body.choice2_weekdays),
                body.note, body.requested_seats,
            )
            if body.requested_seats is not None:
                await conn.execute(
                    "UPDATE project_quarter_plans SET required_seats = $1, updated_at = now() WHERE id = $2",
                    body.requested_seats, id,
                )
    return {"detail": "回答しました"}


class SeatAssignPermissionBody(BaseModel):
    can_assign_seats: bool


@router.put("/project-members/{id}/seat-assign-permission")
async def update_seat_assign_permission(id: int, body: SeatAssignPermissionBody, user: CurrentUser = Depends(require_auth)):
    """A-17: 「席決め」権限の付与・剥奪（FR-03-8）。P-PMPL（対象メンバーと同一プロジェクトのPM(PL)本人）。"""
    pool = get_pool()
    target = await pool.fetchrow("SELECT id, project_id FROM project_members WHERE id = $1", id)
    if target is None:
        raise HTTPException(404, detail="対象が見つかりません")
    caller = await _member_row(pool, target["project_id"], user.id)
    if caller is None or caller["project_title"] not in ("PM", "PL"):
        raise HTTPException(403, detail="この操作を行う権限がありません")

    await pool.execute(
        """UPDATE project_members SET can_assign_seats = $1,
               seat_assign_granted_by = CASE WHEN $1 THEN $2::bigint ELSE NULL END, updated_at = now()
           WHERE id = $3""",
        body.can_assign_seats, user.id, id,
    )
    return {"detail": "席決め権限を更新しました" if body.can_assign_seats else "席決め権限を外しました"}


class SeatAssignmentItem(BaseModel):
    member_user_id: int
    seat_id: int


class SeatAssignmentsBody(BaseModel):
    assignments: list[SeatAssignmentItem]


@router.post("/project-quarter-plans/{id}/seat-assignments")
async def bulk_assign_seats(id: int, body: SeatAssignmentsBody, user: CurrentUser = Depends(require_auth)):
    """A-18: 割り当てられた座席の島の範囲内で、メンバーへ座席を一括確保する（FR-03-7）。T-09（周期予約
    ルール）を生成し、確定した出社曜日（weekdays_finalized）・対象四半期をもとにT-08を一括生成する。
    role='admin'またはP-PROXY（T-05.proxy_user_id）またはP-SEATASSIGN（T-06.can_assign_seats）。
    座席はallocated_seatsの範囲外を指定不可。同一座席を複数のメンバーに重複して指定した場合、
    当該メンバーの組み合わせのみ確保対象から除外する（要件定義書3.3節手順7）。"""
    if not body.assignments:
        raise HTTPException(400, detail="座席を割り当てるメンバーを1人以上指定してください")

    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.*, p.proxy_user_id FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "seats_allocated":
        raise HTTPException(400, detail="座席の島の割当後でなければメンバーへ座席を確保できません")

    my_member = await _member_row(pool, plan["project_id"], user.id)
    can_manage = (
        user.role == "admin"
        or plan["proxy_user_id"] == user.id
        or (my_member is not None and my_member["can_assign_seats"])
    )
    if not can_manage:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    allocated_seat_ids = set(json.loads(plan["allocated_seats"]) if plan["allocated_seats"] else [])
    member_user_ids = {
        r["user_id"] for r in await pool.fetch(
            "SELECT user_id FROM project_members WHERE project_id = $1", plan["project_id"]
        )
    }
    weekdays = json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else []
    seat_no_by_id = await _seat_labels(pool, list(allocated_seat_ids))

    seat_counts: dict[int, int] = {}
    for a in body.assignments:
        seat_counts[a.seat_id] = seat_counts.get(a.seat_id, 0) + 1

    start_date = max(plan["period_start"], Date.today())
    results = []
    for a in body.assignments:
        seat_no = seat_no_by_id.get(a.seat_id, "?")
        if a.member_user_id not in member_user_ids or a.seat_id not in allocated_seat_ids:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": "対象が見つかりません"})
            continue
        if seat_counts[a.seat_id] > 1:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": "他のメンバーと座席が重複しています"})
            continue
        if start_date > plan["period_end"]:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": "対象四半期は既に終了しています"})
            continue
        gen = await generate_recurring_reservations(
            a.seat_id, a.member_user_id, {"type": "weekly", "weekdays": weekdays},
            start_date, plan["period_end"], user.id,
            enforce_rule05=False, check_project_block=False,
        )
        created = sum(1 for r in gen["results"] if r["status"] == "created")
        excluded = [r for r in gen["results"] if r["status"] == "excluded"]
        if created == 0:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": excluded[0]["reason"] if excluded else "確保できる日がありません"})
        else:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "assigned", "created_days": created, "excluded_days": len(excluded)})
    return {"results": results}
