# A-13〜A-18、A-58 プロジェクト座席・PM側（S-04）。詳細設計書3.4節
import json
from datetime import date as Date
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import (
    free_seat_open_date,
    generate_bulk_free_seat_reservations,
    generate_recurring_reservations,
    get_pool,
    project_blocked_seats,
)
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
    各プロジェクトについて存在する計画を全件（period_start昇順）返す（2026-08-31訂正。従来は
    直近のperiod_startを持つ計画1件〔現在進行中とみなす〕のみを返していたが、「対象四半期を
    自由に選択できるようにしてほしい」との要望を受け、S-09と同様に対象四半期を選べるようにした）。"""
    rows = await get_pool().fetch(
        """SELECT pm.project_id, p.name AS project_name, pm.project_title, pm.can_assign_seats,
                  plan.id AS plan_id, plan.period_start, plan.period_end, plan.status,
                  plan.required_seats, plan.allocated_seats
           FROM project_members pm
           JOIN projects p ON p.id = pm.project_id
           LEFT JOIN project_quarter_plans plan ON plan.project_id = pm.project_id
           WHERE pm.user_id = $1
           ORDER BY p.name, plan.period_start""",
        user.id,
    )
    pool = get_pool()
    all_seat_ids = {sid for r in rows if r["allocated_seats"] for sid in json.loads(r["allocated_seats"])}
    seat_no_by_id = await _seat_labels(pool, list(all_seat_ids))

    items_by_project: dict[int, dict] = {}
    for r in rows:
        item = items_by_project.setdefault(r["project_id"], {
            "project_id": r["project_id"], "project_name": r["project_name"],
            "project_title": r["project_title"], "can_assign_seats": r["can_assign_seats"],
            "plans": [],
        })
        if r["plan_id"] is None:
            continue
        allocated_seat_ids = json.loads(r["allocated_seats"]) if r["allocated_seats"] else None
        item["plans"].append({
            "id": r["plan_id"], "period_start": r["period_start"].isoformat(),
            "period_end": r["period_end"].isoformat(), "status": r["status"],
            "required_seats": r["required_seats"],
            "allocated_seat_label": (
                _format_seat_range([seat_no_by_id[sid] for sid in allocated_seat_ids if sid in seat_no_by_id])
                if allocated_seat_ids else None
            ),
        })
    return {"items": list(items_by_project.values())}


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
        """SELECT pm.id AS member_id, pm.user_id, u.last_name, u.first_name, pm.project_title, pm.can_assign_seats,
                  pm.seat_not_required,
                  EXISTS(SELECT 1 FROM fixed_seat_assignments fsa WHERE fsa.user_id = pm.user_id AND fsa.ended_on IS NULL) AS has_fixed_seat
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
                "has_fixed_seat": m["has_fixed_seat"],
                "seat_not_required": m["seat_not_required"],
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
    （曜日確定後は変更不可、2026-08-28追加）。第一・第二希望とも、選択できる曜日数は問わない
    （2026-09-02訂正。「2つのみの選択を変更してなんでも選択できるようにしてほしい」との要望を受け、
    従来の「ちょうど2つ」という制約〔choice1・choice2とも〕を撤廃した。0個〔希望なし〕も許容する）。
    """
    if body.requested_seats is not None and body.requested_seats < 0:
        raise HTTPException(400, detail="必要座席数は0以上を指定してください")
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


class SeatNotRequiredBody(BaseModel):
    seat_not_required: bool


@router.put("/project-members/{id}/seat-not-required")
async def update_seat_not_required(id: int, body: SeatNotRequiredBody, user: CurrentUser = Depends(require_auth)):
    """A-58: ずっと在宅勤務のためプロジェクト座席が不要なメンバーを設定する（FR-03-10、要求仕様書には
    明記のない追加提案）。T-06.seat_not_requiredを更新する。固定座席保有者と同様、メンバーへの座席確保
    （FR-03-7）の対象・未確保者数から除外されるだけで、既存の確保済み座席の予約は自動では取り消さない。
    座席確保操作（FR-03-7）を行える者（admin、PJ席決担当、席決め権限保有者）が設定できる。"""
    pool = get_pool()
    target = await pool.fetchrow(
        "SELECT pm.id, pm.project_id, p.proxy_user_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.id = $1",
        id,
    )
    if target is None:
        raise HTTPException(404, detail="対象が見つかりません")
    caller = await _member_row(pool, target["project_id"], user.id)
    can_manage = (
        user.role == "admin"
        or target["proxy_user_id"] == user.id
        or (caller is not None and caller["can_assign_seats"])
    )
    if not can_manage:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    await pool.execute(
        "UPDATE project_members SET seat_not_required = $1, updated_at = now() WHERE id = $2",
        body.seat_not_required, id,
    )
    return {"detail": "座席不要に設定しました" if body.seat_not_required else "座席不要の設定を解除しました"}


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
    当該メンバーの組み合わせのみ確保対象から除外する（要件定義書3.3節手順7）。固定座席保有者は
    そもそもプロジェクト座席が不要なため、指定されても確保せず除外する（RULE-07、2026-08-28追加）。"""
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
    member_rows = await pool.fetch(
        "SELECT user_id, seat_not_required FROM project_members WHERE project_id = $1", plan["project_id"]
    )
    member_user_ids = {r["user_id"] for r in member_rows}
    seat_not_required_user_ids = {r["user_id"] for r in member_rows if r["seat_not_required"]}
    fixed_seat_user_ids = {
        r["user_id"] for r in await pool.fetch(
            "SELECT user_id FROM fixed_seat_assignments WHERE user_id = ANY($1::bigint[]) AND ended_on IS NULL",
            list(member_user_ids),
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
        if a.member_user_id in fixed_seat_user_ids:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": "固定座席が割り当てられているため、プロジェクト座席は確保できません"})
            continue
        if a.member_user_id in seat_not_required_user_ids:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": "在宅勤務のためプロジェクト座席は不要に設定されています"})
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


class FreeSeatBookingBody(BaseModel):
    member_user_ids: list[int]
    area: Literal["all", "north", "east", "west"] = "all"
    pattern: dict
    start_date: Date
    end_date: Date


@router.post("/project-quarter-plans/{id}/free-seat-bookings")
async def bulk_book_free_seats(id: int, body: FreeSeatBookingBody, user: CurrentUser = Depends(require_auth)):
    """複数メンバーへ、通常のフリー座席（座席の島とは無関係）を日付ごとに自動で割り振って一括予約する
    （2026-09-04追加。「代理予約を複数名まとめて、PJのメンバーに対して行いたい。座席はプロジェクト
    座席ではなくフリー座席として扱ってほしい」との要望を受けた）。権限はA-18と同じ
    role='admin'またはP-PROXY（T-05.proxy_user_id）またはP-SEATASSIGN（T-06.can_assign_seats）。
    座席の島の割当状況（plan.status）には依存しない（フリー座席の確保なので島の有無を問わない）。
    RULE-05（予約可能期間）はadmin以外は通常どおり検証する（FR-01-7はadminのみの特例）。"""
    if not body.member_user_ids:
        raise HTTPException(400, detail="対象メンバーを1人以上指定してください")
    if body.start_date > body.end_date:
        raise HTTPException(400, detail="開始日は終了日以前の日付を指定してください")
    if body.pattern.get("type") not in ("daily", "weekly"):
        raise HTTPException(400, detail="pattern.typeはdaily・weeklyのいずれかを指定してください")
    if body.pattern.get("type") == "weekly" and not body.pattern.get("weekdays"):
        raise HTTPException(400, detail="毎週の場合は曜日を1つ以上指定してください")

    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.id, pqp.project_id, p.proxy_user_id FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")

    my_member = await _member_row(pool, plan["project_id"], user.id)
    can_manage = (
        user.role == "admin"
        or plan["proxy_user_id"] == user.id
        or (my_member is not None and my_member["can_assign_seats"])
    )
    if not can_manage:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    member_rows = await pool.fetch(
        "SELECT user_id, seat_not_required FROM project_members WHERE project_id = $1", plan["project_id"]
    )
    member_user_ids_in_project = {r["user_id"] for r in member_rows}
    seat_not_required_user_ids = {r["user_id"] for r in member_rows if r["seat_not_required"]}

    target_user_ids = []
    pre_excluded = []
    for uid in body.member_user_ids:
        if uid not in member_user_ids_in_project:
            pre_excluded.append({"user_id": uid, "reason": "このプロジェクトのメンバーではありません"})
        elif uid in seat_not_required_user_ids:
            pre_excluded.append({"user_id": uid, "reason": "在宅勤務のため座席は不要に設定されています"})
        else:
            target_user_ids.append(uid)
    if not target_user_ids:
        raise HTTPException(400, detail="対象にできるメンバーがいません")

    gen = await generate_bulk_free_seat_reservations(
        target_user_ids, body.area, body.pattern, body.start_date, body.end_date, user.id,
        enforce_rule05=(user.role != "admin"),
    )

    by_user: dict[int, list[dict]] = {}
    for r in gen["results"]:
        by_user.setdefault(r["user_id"], []).append(r)
    results = []
    for uid in body.member_user_ids:
        rows = by_user.get(uid)
        if rows is None:
            reason = next(p["reason"] for p in pre_excluded if p["user_id"] == uid)
            results.append({"user_id": uid, "status": "excluded", "reason": reason, "created_days": 0, "excluded_days": 0})
            continue
        created = [r for r in rows if r["status"] == "created"]
        excluded = [r for r in rows if r["status"] == "excluded"]
        if not created:
            results.append({
                "user_id": uid, "status": "excluded",
                "reason": excluded[0]["reason"] if excluded else "確保できる日がありません",
                "created_days": 0, "excluded_days": len(excluded),
            })
        else:
            results.append({
                "user_id": uid, "status": "assigned",
                "created_days": len(created), "excluded_days": len(excluded),
            })
    return {"results": results}


class FreeSeatAssignmentsBody(BaseModel):
    assignments: list[SeatAssignmentItem]
    date: Date


@router.post("/project-quarter-plans/{id}/free-seat-assignments")
async def bulk_assign_free_seats_by_seat(id: int, body: FreeSeatAssignmentsBody, user: CurrentUser = Depends(require_auth)):
    """複数メンバーへ、S-02のフロアマップ上で1人ずつクリックして選んだ座席を、指定日のフリー座席として
    一括予約する（2026-09-04追加。/free-seat-bookings〔エリア指定で自動割当〕に加えて、「フロアマップ
    から座席を選べるようにしたい」との要望を受けて追加した、同じ目的の別の入口）。権限・除外理由は
    generate_bulk_free_seat_reservationsと同じ考え方だが、座席は呼び出し元が指定済みのため自動選択は
    行わない（単発の日付のみ対応。日付範囲・繰り返しは/free-seat-bookings側を使う）。"""
    if not body.assignments:
        raise HTTPException(400, detail="座席を割り当てるメンバーを1人以上指定してください")

    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.id, pqp.project_id, p.proxy_user_id FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")

    my_member = await _member_row(pool, plan["project_id"], user.id)
    can_manage = (
        user.role == "admin"
        or plan["proxy_user_id"] == user.id
        or (my_member is not None and my_member["can_assign_seats"])
    )
    if not can_manage:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    member_rows = await pool.fetch(
        "SELECT user_id, seat_not_required FROM project_members WHERE project_id = $1", plan["project_id"]
    )
    member_user_ids_in_project = {r["user_id"] for r in member_rows}
    seat_not_required_user_ids = {r["user_id"] for r in member_rows if r["seat_not_required"]}
    fixed_user_ids = {
        r["user_id"] for r in await pool.fetch(
            "SELECT user_id FROM fixed_seat_assignments WHERE user_id = ANY($1::bigint[]) AND ended_on IS NULL",
            [a.member_user_id for a in body.assignments],
        )
    }

    seats = await pool.fetch(
        "SELECT id, seat_no, seat_type, status FROM seats WHERE id = ANY($1::bigint[])",
        [a.seat_id for a in body.assignments],
    )
    seat_by_id = {s["id"]: s for s in seats}
    blocked = await project_blocked_seats(body.date)
    enforce_rule05 = user.role != "admin"

    seat_counts: dict[int, int] = {}
    for a in body.assignments:
        seat_counts[a.seat_id] = seat_counts.get(a.seat_id, 0) + 1

    results = []
    for a in body.assignments:
        seat = seat_by_id.get(a.seat_id)
        seat_no = seat["seat_no"] if seat else "?"
        reason = None
        if a.member_user_id not in member_user_ids_in_project:
            reason = "このプロジェクトのメンバーではありません"
        elif a.member_user_id in seat_not_required_user_ids:
            reason = "在宅勤務のため座席は不要に設定されています"
        elif a.member_user_id in fixed_user_ids:
            reason = "固定座席が割り当てられているため、フリー座席は予約できません"
        elif seat is None or seat["status"] != "active" or seat["seat_type"] != "free":
            reason = "この座席はフリー座席として予約できません"
        elif seat_counts[a.seat_id] > 1:
            reason = "他のメンバーと座席が重複しています"
        elif a.seat_id in blocked:
            reason = f"この座席は{blocked[a.seat_id]}のプロジェクト座席として確保されているため予約できません"
        elif enforce_rule05:
            if body.date < Date.today():
                reason = "過去の日付は予約できません"
            else:
                open_date = await free_seat_open_date(body.date)
                if Date.today() < open_date:
                    reason = f"この座席は{open_date.month}月{open_date.day}日から予約できます"
        if reason is None:
            duplicate = await pool.fetchval(
                """SELECT 1 FROM reservations r JOIN seats s ON s.id = r.seat_id
                   WHERE r.user_id = $1 AND r.date = $2 AND r.status = 'active' AND s.seat_type = 'free'""",
                a.member_user_id, body.date,
            )
            if duplicate:
                reason = "同じ日に複数の座席は予約できません"
        if reason is not None:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": reason})
            continue
        try:
            await pool.execute(
                "INSERT INTO reservations (seat_id, user_id, date, created_by) VALUES ($1, $2, $3, $4)",
                a.seat_id, a.member_user_id, body.date, user.id,
            )
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no, "status": "assigned"})
        except asyncpg.UniqueViolationError:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": "この座席はすでに予約されています"})
    return {"results": results}


class SeatChangeBody(BaseModel):
    seat_id: int | None = None


@router.put("/project-quarter-plans/{id}/seat-assignments/{member_user_id}")
async def change_member_seat(id: int, member_user_id: int, body: SeatChangeBody, user: CurrentUser = Depends(require_auth)):
    """A-64: 既に座席を確保済みのメンバーの座席を、同じ座席の島の範囲内で別の座席に変更する
    （2026-09-03追加。「メンバーへの座席確保なのですが変更できるようにしてほしい」との要望を受けた。
    従来は一度確保すると「割り当てる座席」欄が「—」表示になり、この画面からは変更できず、
    S-11等で個別に取消してからA-18で確保し直す必要があった）。旧座席の予約を（未来分のみ）取り消してから、
    A-18と同じロジックで新しい座席への周期予約を生成する。権限・状態チェックはA-18と同じ。

    変更先の座席が既に他のメンバーに割り当て済みの場合は、当初拒否していたが（初版）、座席の島が
    必要人数ちょうどで確保されている（＝空き座席がない）ケースが多く、「変更先を選択を押しても座席が
    表示されないため変更することができません」との報告を受け、2026-09-03当日中に交換（スワップ）方式に
    変更した。対象の2名の座席をまとめて入れ替える（双方の旧座席の予約を取り消してから、それぞれ相手の
    座席で確保し直す）。

    body.seat_id=nullは「在宅勤務にする」（2026-09-03同日追加。「変更先の選択に在宅勤務も追加してほしい」
    との要望を受けた。従来、確保済みメンバーを在宅勤務〔seat_not_required〕に切り替えるには、この画面の
    「在宅のため不要」チェックボックスが確保済みの間は非活性〔先に予約の取消が必要〕で、この画面からは
    完結できなかった）。旧座席の予約を（未来分のみ）取り消し、T-06.seat_not_requiredをtrueにする。
    新しい座席の確保は行わない。"""
    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.*, p.proxy_user_id FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "seats_allocated":
        raise HTTPException(400, detail="座席の島の割当後でなければメンバーの座席を変更できません")

    my_member = await _member_row(pool, plan["project_id"], user.id)
    can_manage = (
        user.role == "admin"
        or plan["proxy_user_id"] == user.id
        or (my_member is not None and my_member["can_assign_seats"])
    )
    if not can_manage:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    allocated_seat_ids = set(json.loads(plan["allocated_seats"]) if plan["allocated_seats"] else [])
    if body.seat_id is not None and body.seat_id not in allocated_seat_ids:
        raise HTTPException(400, detail="この座席の島に含まれない座席です")

    member = await pool.fetchrow(
        "SELECT id, user_id, seat_not_required FROM project_members WHERE project_id = $1 AND user_id = $2",
        plan["project_id"], member_user_id,
    )
    if member is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if member["seat_not_required"]:
        raise HTTPException(400, detail="在宅勤務のためプロジェクト座席は不要に設定されています")
    has_fixed_seat = await pool.fetchval(
        "SELECT 1 FROM fixed_seat_assignments WHERE user_id = $1 AND ended_on IS NULL", member_user_id
    )
    if has_fixed_seat:
        raise HTTPException(400, detail="固定座席が割り当てられているため、プロジェクト座席は確保できません")

    assign_rows = await pool.fetch(
        """SELECT DISTINCT ON (r.user_id) r.user_id, r.seat_id
           FROM reservations r
           WHERE r.seat_id = ANY($1::bigint[]) AND r.status = 'active' AND r.date BETWEEN $2 AND $3
           ORDER BY r.user_id, r.date""",
        list(allocated_seat_ids), plan["period_start"], plan["period_end"],
    )
    assigned_seat_by_user = {r["user_id"]: r["seat_id"] for r in assign_rows}
    old_seat_id = assigned_seat_by_user.get(member_user_id)
    if old_seat_id is None:
        raise HTTPException(400, detail="まだ座席が確保されていません。新規の確保は「この内容で一括確保する」から行ってください")

    start_date = max(plan["period_start"], Date.today())

    if body.seat_id is None:
        await pool.execute(
            """UPDATE reservations SET status = 'cancelled', updated_at = now()
               WHERE seat_id = $1 AND user_id = $2 AND status = 'active' AND date BETWEEN $3 AND $4""",
            old_seat_id, member_user_id, start_date, plan["period_end"],
        )
        await pool.execute(
            "UPDATE project_members SET seat_not_required = true, updated_at = now() WHERE id = $1",
            member["id"],
        )
        return {
            "detail": "在宅勤務のため座席を解放しました", "seat_no": None, "created_days": 0, "excluded_days": 0,
            "swapped_with": None,
        }

    if old_seat_id == body.seat_id:
        raise HTTPException(400, detail="現在と同じ座席です")
    other_user_id = next(
        (uid for uid, sid in assigned_seat_by_user.items() if uid != member_user_id and sid == body.seat_id),
        None,
    )

    weekdays = json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else []
    seat_labels = await _seat_labels(pool, [old_seat_id, body.seat_id])

    await pool.execute(
        """UPDATE reservations SET status = 'cancelled', updated_at = now()
           WHERE seat_id = $1 AND user_id = $2 AND status = 'active' AND date BETWEEN $3 AND $4""",
        old_seat_id, member_user_id, start_date, plan["period_end"],
    )
    if other_user_id is not None:
        await pool.execute(
            """UPDATE reservations SET status = 'cancelled', updated_at = now()
               WHERE seat_id = $1 AND user_id = $2 AND status = 'active' AND date BETWEEN $3 AND $4""",
            body.seat_id, other_user_id, start_date, plan["period_end"],
        )

    gen = await generate_recurring_reservations(
        body.seat_id, member_user_id, {"type": "weekly", "weekdays": weekdays},
        start_date, plan["period_end"], user.id,
        enforce_rule05=False, check_project_block=False,
    )
    created = sum(1 for r in gen["results"] if r["status"] == "created")
    excluded = [r for r in gen["results"] if r["status"] == "excluded"]

    swapped_with = None
    if other_user_id is not None:
        other_gen = await generate_recurring_reservations(
            old_seat_id, other_user_id, {"type": "weekly", "weekdays": weekdays},
            start_date, plan["period_end"], user.id,
            enforce_rule05=False, check_project_block=False,
        )
        other_name_row = await pool.fetchrow(
            "SELECT last_name, first_name FROM users WHERE id = $1", other_user_id
        )
        swapped_with = f"{other_name_row['last_name']} {other_name_row['first_name']}" if other_name_row else None

    seat_no = seat_labels.get(body.seat_id, "?")
    detail = f"座席を{seat_no}に変更しました" if swapped_with is None else f"座席を{seat_no}に変更しました（{swapped_with}と交換）"
    return {
        "detail": detail, "seat_no": seat_no, "created_days": created, "excluded_days": len(excluded),
        "swapped_with": swapped_with,
    }
