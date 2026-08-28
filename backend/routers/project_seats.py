# A-27, A-38〜A-44 プロジェクト座席・エリア担当側（S-09）。詳細設計書3.9節
# S-08「プロジェクト・PM管理」タブ（プロジェクト・メンバーのCRUD、A-28・A-29）は
# S-04（PM側）とあわせて別途実装するため、本フェーズはS-09が必要とする読み取り専用の
# A-27のみ実装する（2026-08-28）。プロジェクト・メンバー自体はseed.pyで投入する。
import json
import re
from datetime import date as Date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import get_pool, get_setting

router = APIRouter(prefix="/api", tags=["project-seats"])


async def _base_months() -> list[int]:
    raw = await get_setting("quarter_base_months")
    return json.loads(raw) if raw else [1, 4, 7, 10]


def _quarter_start_for(d: Date, base_months: list[int]) -> Date:
    candidates = [m for m in base_months if m <= d.month]
    if candidates:
        return Date(d.year, max(candidates), 1)
    return Date(d.year - 1, max(base_months), 1)


def _quarter_end(period_start: Date, base_months: list[int]) -> Date:
    idx = base_months.index(period_start.month)
    if idx + 1 < len(base_months):
        next_start = Date(period_start.year, base_months[idx + 1], 1)
    else:
        next_start = Date(period_start.year + 1, base_months[0], 1)
    return next_start - timedelta(days=1)


def _next_quarter_start(today: Date, base_months: list[int]) -> Date:
    current = _quarter_start_for(today, base_months)
    idx = base_months.index(current.month)
    if idx + 1 < len(base_months):
        return Date(current.year, base_months[idx + 1], 1)
    return Date(current.year + 1, base_months[0], 1)


_SEAT_NO_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


def _format_seat_range(seat_nos: list[str]) -> str:
    """座席番号の配列を「D1〜D4」のように整形する（連番でなければカンマ区切り）"""
    parsed = []
    for no in seat_nos:
        m = _SEAT_NO_RE.match(no)
        parsed.append((m.group(1), int(m.group(2)), no) if m else (no, 0, no))
    parsed.sort(key=lambda p: (p[0], p[1]))
    prefixes = {p[0] for p in parsed}
    numbers = [p[1] for p in parsed]
    if len(prefixes) == 1 and numbers == list(range(min(numbers), max(numbers) + 1)):
        return f"{parsed[0][2]}〜{parsed[-1][2]}"
    return "、".join(p[2] for p in parsed)


@router.get("/projects")
async def list_projects(_: CurrentUser = Depends(require_roles("admin"))):
    """A-27: 全プロジェクト一覧。プロジェクトの作成・編集（A-28・A-29）はS-08「プロジェクト・PM管理」
    タブとあわせて別途実装するため未実装。S-09の「四半期計画を開始する」パネルで、次の四半期の
    計画がまだないプロジェクトを判定するために使う（2026-08-28追加、has_plan_for_next_quarter）。"""
    pool = get_pool()
    base_months = await _base_months()
    next_start = _next_quarter_start(Date.today(), base_months)
    next_end = _quarter_end(next_start, base_months)

    rows = await pool.fetch(
        """SELECT p.id, p.name,
                  string_agg(DISTINCT (u.last_name || ' ' || u.first_name), '、')
                      FILTER (WHERE pm.project_title IN ('PM', 'PL')) AS pm_pl_names,
                  EXISTS(
                      SELECT 1 FROM project_quarter_plans pqp
                      WHERE pqp.project_id = p.id AND pqp.period_start = $1
                  ) AS has_plan_for_next_quarter
           FROM projects p
           LEFT JOIN project_members pm ON pm.project_id = p.id
           LEFT JOIN users u ON u.id = pm.user_id
           GROUP BY p.id
           ORDER BY p.name""",
        next_start,
    )
    return {
        "next_quarter_start": next_start.isoformat(),
        "next_quarter_end": next_end.isoformat(),
        "items": [
            {
                "id": r["id"], "name": r["name"], "pm_pl_names": r["pm_pl_names"] or "未設定",
                "has_plan_for_next_quarter": r["has_plan_for_next_quarter"],
            }
            for r in rows
        ],
    }


@router.get("/project-quarter-plans")
async def list_quarter_plans(
    quarter: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-38: 四半期での一覧。quarterはperiod_start（YYYY-MM-DD）での絞り込み（任意）。
    areaクエリパラメータは2026-08-27にT-07からarea_id自体が削除されたため対象外とした
    （2026-08-28、ドキュメントの記載漏れを整理）。"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT pqp.id, pqp.project_id, p.name AS project_name, pqp.period_start, pqp.period_end,
                  pqp.required_seats, pqp.weekdays_finalized, pqp.allocated_seats, pqp.status,
                  string_agg(DISTINCT (u.last_name || ' ' || u.first_name), '、')
                      FILTER (WHERE pm.project_title IN ('PM', 'PL')) AS pm_pl_names,
                  wr.choice1_weekdays, wr.choice2_weekdays, wr.note,
                  (wr.id IS NOT NULL) AS has_response
           FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id
           LEFT JOIN project_members pm ON pm.project_id = pqp.project_id
           LEFT JOIN users u ON u.id = pm.user_id
           LEFT JOIN project_weekday_responses wr ON wr.plan_id = pqp.id
           WHERE ($1 = '' OR pqp.period_start = $1::date)
           GROUP BY pqp.id, p.name, wr.choice1_weekdays, wr.choice2_weekdays, wr.note, wr.id
           ORDER BY pqp.period_start, p.name""",
        quarter,
    )

    seat_ids = {sid for r in rows if r["allocated_seats"] for sid in json.loads(r["allocated_seats"])}
    seat_no_by_id = {}
    if seat_ids:
        seat_rows = await pool.fetch(
            "SELECT id, seat_no FROM seats WHERE id = ANY($1::bigint[])", list(seat_ids)
        )
        seat_no_by_id = {r["id"]: r["seat_no"] for r in seat_rows}

    items = []
    for r in rows:
        allocated_seat_ids = json.loads(r["allocated_seats"]) if r["allocated_seats"] else None
        allocated_label = (
            _format_seat_range([seat_no_by_id[sid] for sid in allocated_seat_ids if sid in seat_no_by_id])
            if allocated_seat_ids else None
        )
        items.append({
            "id": r["id"], "project_id": r["project_id"], "project_name": r["project_name"],
            "pm_pl_names": r["pm_pl_names"] or "未設定",
            "period_start": r["period_start"].isoformat(), "period_end": r["period_end"].isoformat(),
            "required_seats": r["required_seats"], "status": r["status"],
            "weekdays_finalized": json.loads(r["weekdays_finalized"]) if r["weekdays_finalized"] else None,
            "allocated_seat_ids": allocated_seat_ids, "allocated_seat_label": allocated_label,
            "has_response": r["has_response"],
            "choice1_weekdays": json.loads(r["choice1_weekdays"]) if r["choice1_weekdays"] else None,
            "choice2_weekdays": json.loads(r["choice2_weekdays"]) if r["choice2_weekdays"] else None,
            "note": r["note"],
        })
    return {"items": items}


class QuarterPlanCreate(BaseModel):
    period_start: Date


@router.post("/projects/{id}/quarter-plans")
async def start_quarter_plan(id: int, body: QuarterPlanCreate, user: CurrentUser = Depends(require_roles("admin"))):
    """A-39: 対象プロジェクトの四半期計画を開始し新規作成する（FR-03-1）。status='seats_confirmed'で
    作成。required_seatsは作成時点のproject_membersの人数を既定値として自動算出する。"""
    pool = get_pool()
    project = await pool.fetchrow("SELECT id FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")
    base_months = await _base_months()
    if body.period_start.month not in base_months or body.period_start.day != 1:
        raise HTTPException(400, detail="対象四半期の開始日が不正です")
    period_end = _quarter_end(body.period_start, base_months)
    member_count = await pool.fetchval(
        "SELECT COUNT(*) FROM project_members WHERE project_id = $1", id
    )
    try:
        row = await pool.fetchrow(
            """INSERT INTO project_quarter_plans (project_id, period_start, period_end, required_seats, decided_by)
               VALUES ($1, $2, $3, $4, $5) RETURNING id""",
            id, body.period_start, period_end, max(member_count, 1), user.id,
        )
    except Exception:
        raise HTTPException(409, detail="この四半期の計画は既に開始されています")
    return {"id": row["id"], "detail": "四半期計画を開始しました"}


class RequiredSeatsUpdate(BaseModel):
    required_seats: int


@router.put("/project-quarter-plans/{id}/required-seats")
async def update_required_seats(id: int, body: RequiredSeatsUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-40: 必要座席数の例外的な手動上書き。status='seats_allocated'後は変更不可。"""
    if body.required_seats < 1:
        raise HTTPException(400, detail="必要座席数は1以上を指定してください")
    pool = get_pool()
    plan = await pool.fetchrow("SELECT id, status FROM project_quarter_plans WHERE id = $1", id)
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] == "seats_allocated":
        raise HTTPException(400, detail="座席の島の割当済みのため、必要座席数は変更できません")
    await pool.execute(
        "UPDATE project_quarter_plans SET required_seats = $1, updated_at = now() WHERE id = $2",
        body.required_seats, id,
    )
    return {"detail": "必要座席数を更新しました"}


@router.post("/project-quarter-plans/{id}/survey")
async def send_survey(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-41: 出社曜日アンケートを送信（FR-03-3）。status→'survey_open'。Slack通知（FR-03-9①）は
    本フェーズでは未実装（S-08通知設定タブでWebhook URLの保存はできるが、実際の送信処理はまだない）。"""
    pool = get_pool()
    plan = await pool.fetchrow("SELECT id, status FROM project_quarter_plans WHERE id = $1", id)
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "seats_confirmed":
        raise HTTPException(400, detail="この状態ではアンケートを送信できません")
    await pool.execute(
        "UPDATE project_quarter_plans SET status = 'survey_open', updated_at = now() WHERE id = $1", id
    )
    return {"detail": "アンケートを送信しました"}


@router.post("/project-quarter-plans/{id}/survey-reminder")
async def send_survey_reminder(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-42: 未回答のプロジェクトへのリマインドを手動送信（FR-03-9②）。A-41と同様、実際のSlack送信は
    本フェーズでは未実装。"""
    plan = await get_pool().fetchrow("SELECT id, status FROM project_quarter_plans WHERE id = $1", id)
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "survey_open":
        raise HTTPException(400, detail="この状態ではリマインドを送信できません")
    return {"detail": "リマインドを送信しました"}


class WeekdayFinalizeItem(BaseModel):
    plan_id: int
    weekdays_finalized: list[Literal["mon", "tue", "wed", "thu", "fri"]]


class WeekdayFinalizeBody(BaseModel):
    plans: list[WeekdayFinalizeItem]


@router.put("/project-quarter-plans/finalize-weekdays")
async def finalize_weekdays(body: WeekdayFinalizeBody, user: CurrentUser = Depends(require_roles("admin"))):
    """A-43: 指定した複数の計画の出社曜日を一括確定（FR-03-5）。status→'weekdays_finalized'。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for item in body.plans:
                plan = await conn.fetchrow(
                    "SELECT id, status FROM project_quarter_plans WHERE id = $1", item.plan_id
                )
                if plan is None:
                    raise HTTPException(404, detail="対象が見つかりません")
                if plan["status"] != "survey_open":
                    raise HTTPException(400, detail="この状態では曜日を確定できません")
                await conn.execute(
                    """UPDATE project_quarter_plans
                       SET weekdays_finalized = $1, status = 'weekdays_finalized', decided_by = $2, updated_at = now()
                       WHERE id = $3""",
                    json.dumps(item.weekdays_finalized), user.id, item.plan_id,
                )
    return {"detail": "出社曜日を確定しました"}


class SeatBlockAssign(BaseModel):
    seat_ids: list[int]


@router.put("/project-quarter-plans/{id}/seat-block")
async def assign_seat_block(id: int, body: SeatBlockAssign, user: CurrentUser = Depends(require_roles("admin"))):
    """A-44: 座席の島（範囲）を割り当てる（FR-03-6）。status→'seats_allocated'。他プロジェクトへの
    割当と期間（period_start〜period_end）が重複する座席は選択不可（座席単位の判定、基本設計書3.3節）。
    座席選択の対象は現在seat_type='free'の座席のみとする（固定座席を誤って巻き込まないため、
    2026-08-28追加）。プロジェクト座席としての専有は物理的な座席区分の変更ではなく、あくまで
    その四半期の期間中に限られるため、seats.seat_typeは変更しない（2026-08-28訂正。当初は
    'project'に変更する実装だったが、それだと割当決定〜四半期開始前の間も通常のフリー座席として
    予約できなくなってしまうため撤回した。専有判定はdatabase.project_blocked_seats()が
    その都度period_start〜period_endで行う）。残っている、その期間中の通常予約（T-08）のみ
    割当と矛盾するため取り消す（期間外の予約は影響しない）。"""
    if not body.seat_ids:
        raise HTTPException(400, detail="座席を1つ以上選択してください")
    pool = get_pool()
    plan = await pool.fetchrow(
        "SELECT id, status, period_start, period_end FROM project_quarter_plans WHERE id = $1", id
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "weekdays_finalized":
        raise HTTPException(400, detail="出社曜日の確定後でなければ座席の島を割り当てられません")

    seats = await pool.fetch(
        "SELECT id, status, seat_type FROM seats WHERE id = ANY($1::bigint[])", body.seat_ids
    )
    if (
        len(seats) != len(set(body.seat_ids))
        or any(s["status"] != "active" for s in seats)
        or any(s["seat_type"] != "free" for s in seats)
    ):
        raise HTTPException(404, detail="対象が見つかりません")

    other_plans = await pool.fetch(
        """SELECT allocated_seats FROM project_quarter_plans
           WHERE status = 'seats_allocated' AND id != $1
             AND period_start <= $2 AND period_end >= $3""",
        id, plan["period_end"], plan["period_start"],
    )
    already_allocated = {sid for r in other_plans if r["allocated_seats"] for sid in json.loads(r["allocated_seats"])}
    if already_allocated & set(body.seat_ids):
        raise HTTPException(409, detail="既に他プロジェクトへ割り当てられている座席が含まれています")

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """UPDATE reservations SET status = 'cancelled', updated_at = now()
                   WHERE seat_id = ANY($1::bigint[]) AND status = 'active' AND date BETWEEN $2 AND $3""",
                body.seat_ids, plan["period_start"], plan["period_end"],
            )
            await conn.execute(
                """UPDATE project_quarter_plans
                   SET allocated_seats = $1, status = 'seats_allocated', decided_by = $2, updated_at = now()
                   WHERE id = $3""",
                json.dumps(body.seat_ids), user.id, id,
            )
    return {"detail": "座席の島を割り当てました"}
