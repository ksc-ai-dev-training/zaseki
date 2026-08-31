# A-27〜A-29 プロジェクト・PM管理（S-08）、A-38〜A-44 プロジェクト座席・エリア担当側（S-09）。
# 詳細設計書3.8節・3.9節
import json
import re
from datetime import date as Date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import get_pool, get_setting
from slack import send_slack_notification

router = APIRouter(prefix="/api", tags=["project-seats"])

_WEEKDAY_JA = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金"}


async def _base_months() -> list[int]:
    raw = await get_setting("quarter_base_months")
    return json.loads(raw) if raw else [1, 4, 7, 10]


async def _ensure_next_quarter_plans(pool) -> None:
    """次の四半期の計画データを、対象プロジェクトごとに自動的に起票する（FR-03-1、2026-08-28実装）。
    従来はエリア責任者・管理部が「四半期計画を開始する」ボタンを押す手動操作だったが、全プロジェクトが
    毎四半期必ず1件必要とするものであり手動操作を要する理由がないとの要望を受け、A-27・A-38の
    参照時に不足分を自動起票する方式に変更した。ON CONFLICT DO NOTHINGのため複数回呼んでも副作用はない。

    required_seatsの初期値は、固定座席（T-04）を既に持つメンバーを除いた人数とする（2026-08-28再訂正、
    「固定席の人のみのプロジェクトはプロジェクト席を用意する必要がない」との要望を受けた。固定座席保有者は
    RULE-07によりそもそもプロジェクト座席を確保できないため、必要数に含めると余分な座席を要求してしまう。
    メンバーが1人もいないプロジェクトは判定材料がないため、従来どおり1人扱いとする）。"""
    base_months = await _base_months()
    next_start = _next_quarter_start(Date.today(), base_months)
    next_end = _quarter_end(next_start, base_months)
    await pool.execute(
        """INSERT INTO project_quarter_plans (project_id, period_start, period_end, required_seats)
           SELECT p.id, $1, $2,
                  CASE WHEN COUNT(pm.id) = 0 THEN 1
                       ELSE COUNT(pm.id) FILTER (WHERE fsa.user_id IS NULL)
                  END
           FROM projects p
           LEFT JOIN project_members pm ON pm.project_id = p.id
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = pm.user_id
           GROUP BY p.id
           ON CONFLICT (project_id, period_start) DO NOTHING""",
        next_start, next_end,
    )


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
    """A-27: 全プロジェクト一覧。S-08「プロジェクト・PM管理」タブの一覧・編集モーダルのメンバー表で使う
    （2026-08-28、members・member_count・proxy_user_id・proxy_user_nameを追加）。呼び出し時に次の四半期の
    計画データの自動作成（_ensure_next_quarter_plans）を行う（2026-08-28追加、FR-03-1改訂）。"""
    pool = get_pool()
    await _ensure_next_quarter_plans(pool)

    rows = await pool.fetch(
        """SELECT p.id, p.name, p.proxy_user_id,
                  string_agg(DISTINCT (u.last_name || ' ' || u.first_name), '、')
                      FILTER (WHERE pm.project_title IN ('PM', 'PL')) AS pm_pl_names,
                  COUNT(pm.id) AS member_count,
                  COALESCE(json_agg(json_build_object(
                      'member_id', pm.id, 'user_id', pm.user_id,
                      'name', u.last_name || ' ' || u.first_name,
                      'project_title', pm.project_title
                  ) ORDER BY pm.id) FILTER (WHERE pm.id IS NOT NULL), '[]') AS members_json
           FROM projects p
           LEFT JOIN project_members pm ON pm.project_id = p.id
           LEFT JOIN users u ON u.id = pm.user_id
           GROUP BY p.id
           ORDER BY p.name"""
    )
    items = []
    for r in rows:
        members = json.loads(r["members_json"])
        proxy_name = next((m["name"] for m in members if m["user_id"] == r["proxy_user_id"]), None)
        items.append({
            "id": r["id"], "name": r["name"], "pm_pl_names": r["pm_pl_names"] or "未設定",
            "member_count": r["member_count"], "members": members,
            "proxy_user_id": r["proxy_user_id"], "proxy_user_name": proxy_name,
        })
    return {"items": items}


class ProjectCreate(BaseModel):
    name: str


@router.post("/projects")
async def create_project(body: ProjectCreate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-28: プロジェクトの新規作成（S-08プロジェクト・PM管理タブ）。同名プロジェクトの重複チェックは
    行わない（要件定義書に禁止規定なし、4.6節）。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="プロジェクト名を入力してください")
    row = await get_pool().fetchrow("INSERT INTO projects (name) VALUES ($1) RETURNING id", name)
    return {"id": row["id"], "detail": "プロジェクトを追加しました"}


class ProjectMemberItem(BaseModel):
    user_id: int
    project_title: Literal["PM", "PL", "SL"] | None = None


class ProjectMembersUpdate(BaseModel):
    name: str
    members: list[ProjectMemberItem]
    proxy_user_id: int | None = None


@router.put("/projects/{id}/members")
async def update_project_members(id: int, body: ProjectMembersUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-29: メンバー構成・PM/PL/SL・PJ席決担当をまとめて更新する。bodyに含まれないuser_idの既存メンバーは
    削除、新規はcan_assign_seats=falseで追加、既存は所属継続のままproject_titleのみ更新する（UPSERT。
    2026-08-28追加。can_assign_seats・seat_assign_granted_byはbodyの対象外のため既存メンバーの値を保持する）。
    メンバー削除に伴う既存のプロジェクト座席予約（A-18生成分）・アンケート回答（T-11）の連鎖処理は行わない
    （要件定義書・基本設計書のいずれにも規定がないため、本フェーズのスコープ外とする）。<code>name</code>も
    あわせて更新する（2026-08-28追加。画面モックアップの編集モーダルがプロジェクト名・メンバーを1つの
    フォームとして一括保存する設計のため、名称変更用に別APIを新設せずA-29に統合した）。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="プロジェクト名を入力してください")
    if len(body.members) != len({m.user_id for m in body.members}):
        raise HTTPException(400, detail="同じ利用者が複数の行に指定されています")

    pool = get_pool()
    project = await pool.fetchrow("SELECT id FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")

    user_ids = [m.user_id for m in body.members]
    if user_ids:
        valid_count = await pool.fetchval(
            "SELECT COUNT(*) FROM users WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL", user_ids
        )
        if valid_count != len(user_ids):
            raise HTTPException(404, detail="対象が見つかりません")

    if body.proxy_user_id is not None:
        proxy_member = next((m for m in body.members if m.user_id == body.proxy_user_id), None)
        if proxy_member is None or proxy_member.project_title not in ("PM", "PL"):
            raise HTTPException(400, detail="PJ席決担当にはPMまたはPLのみ指定できます")

    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = {r["user_id"] for r in await conn.fetch(
                "SELECT user_id FROM project_members WHERE project_id = $1", id
            )}
            to_remove = existing - set(user_ids)
            if to_remove:
                await conn.execute(
                    "DELETE FROM project_members WHERE project_id = $1 AND user_id = ANY($2::bigint[])",
                    id, list(to_remove),
                )
            for m in body.members:
                await conn.execute(
                    """INSERT INTO project_members (project_id, user_id, project_title)
                       VALUES ($1, $2, $3)
                       ON CONFLICT (project_id, user_id) DO UPDATE SET project_title = $3, updated_at = now()""",
                    id, m.user_id, m.project_title,
                )
            await conn.execute(
                "UPDATE projects SET name = $1, proxy_user_id = $2, updated_at = now() WHERE id = $3",
                name, body.proxy_user_id, id,
            )
    return {"detail": "プロジェクトを更新しました"}


@router.delete("/projects/{id}")
async def delete_project(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-55: プロジェクトの削除（S-08プロジェクト・PM管理タブ、2026-08-28追加）。project_membersと
    project_quarter_plans（FK経由でproject_weekday_responsesも連動）はプロジェクト自体が消える以上
    存在意義を失うため、本APIの一部としてあわせて削除する（A-29のメンバー削除とは異なり、削除対象を
    選べる余地がないためスコープ外にはできない）。座席の島の割当（allocated_seats）は削除される
    project_quarter_plans行の一部にすぎず、project_blocked_seats()はJOIN projectsで判定するため
    削除後は自動的にプロジェクト専有として扱われなくなる。一方、メンバーが個別に確保済みの座席予約
    （A-18生成分のreservations・recurring_rules）はproject_idを持たない独立したデータのため削除せず
    残す（本人が実際にその座席を使っている実態を、プロジェクトという管理上の入れ物の削除で消さない）。"""
    pool = get_pool()
    project = await pool.fetchrow("SELECT id, name FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """DELETE FROM project_weekday_responses
                   WHERE plan_id IN (SELECT id FROM project_quarter_plans WHERE project_id = $1)""",
                id,
            )
            await conn.execute("DELETE FROM project_quarter_plans WHERE project_id = $1", id)
            await conn.execute("DELETE FROM project_members WHERE project_id = $1", id)
            await conn.execute("DELETE FROM projects WHERE id = $1", id)
    return {"detail": f"プロジェクト「{project['name']}」を削除しました"}


@router.get("/project-quarter-plans")
async def list_quarter_plans(
    quarter: str = "",
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-38: 四半期での一覧。quarterはperiod_start（YYYY-MM-DD）での絞り込み（任意）。
    areaクエリパラメータは2026-08-27にT-07からarea_id自体が削除されたため対象外とした
    （2026-08-28、ドキュメントの記載漏れを整理）。A-27と同様、呼び出し時に次の四半期の計画データの
    自動作成を行う（2026-08-28追加、FR-03-1改訂）。"""
    pool = get_pool()
    await _ensure_next_quarter_plans(pool)
    rows = await pool.fetch(
        """SELECT pqp.id, pqp.project_id, p.name AS project_name, pqp.period_start, pqp.period_end,
                  pqp.required_seats, pqp.weekdays_finalized, pqp.allocated_seats, pqp.status,
                  string_agg(DISTINCT (u.last_name || ' ' || u.first_name), '、')
                      FILTER (WHERE pm.project_title IN ('PM', 'PL')) AS pm_pl_names,
                  COUNT(DISTINCT pm.id) FILTER (WHERE fsa.user_id IS NULL) AS non_fixed_member_count,
                  wr.choice1_weekdays, wr.choice2_weekdays, wr.note,
                  (wr.id IS NOT NULL) AS has_response
           FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id
           LEFT JOIN project_members pm ON pm.project_id = pqp.project_id
           LEFT JOIN users u ON u.id = pm.user_id
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = pm.user_id
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
            "non_fixed_member_count": r["non_fixed_member_count"],
            "weekdays_finalized": json.loads(r["weekdays_finalized"]) if r["weekdays_finalized"] else None,
            "allocated_seat_ids": allocated_seat_ids, "allocated_seat_label": allocated_label,
            "has_response": r["has_response"],
            "choice1_weekdays": json.loads(r["choice1_weekdays"]) if r["choice1_weekdays"] else None,
            "choice2_weekdays": json.loads(r["choice2_weekdays"]) if r["choice2_weekdays"] else None,
            "note": r["note"],
        })
    return {"items": items}


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
    """A-41: 出社曜日アンケートを送信（FR-03-3）。status→'survey_open'。Slack通知（FR-03-9①）を送信する
    （2026-08-28実装。Webhook URL未設定時は送信しない、送信失敗しても本操作は成功扱いとする）。"""
    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.id, pqp.status, pqp.period_start, pqp.period_end, p.name AS project_name
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "seats_confirmed":
        raise HTTPException(400, detail="この状態ではアンケートを送信できません")
    await pool.execute(
        "UPDATE project_quarter_plans SET status = 'survey_open', updated_at = now() WHERE id = $1", id
    )
    await send_slack_notification(
        f"「{plan['project_name']}」（{plan['period_start']}〜{plan['period_end']}）の出社曜日アンケートを送信しました。"
    )
    return {"detail": "アンケートを送信しました"}


@router.post("/project-quarter-plans/{id}/survey-reminder")
async def send_survey_reminder(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-42: 未回答のプロジェクトへのリマインドを手動送信（FR-03-9②）。A-41と同様、Slack通知を送信する
    （2026-08-28実装）。"""
    plan = await get_pool().fetchrow(
        """SELECT pqp.id, pqp.status, p.name AS project_name
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "survey_open":
        raise HTTPException(400, detail="この状態ではリマインドを送信できません")
    await send_slack_notification(
        f"リマインド: 「{plan['project_name']}」の出社曜日アンケートが未回答です。ご回答をお願いします。"
    )
    return {"detail": "リマインドを送信しました"}


class WeekdayFinalizeItem(BaseModel):
    plan_id: int
    weekdays_finalized: list[Literal["mon", "tue", "wed", "thu", "fri"]]


class WeekdayFinalizeBody(BaseModel):
    plans: list[WeekdayFinalizeItem]


@router.put("/project-quarter-plans/finalize-weekdays")
async def finalize_weekdays(body: WeekdayFinalizeBody, user: CurrentUser = Depends(require_roles("admin"))):
    """A-43: 指定した複数の計画の出社曜日を一括確定（FR-03-5）。status→'weekdays_finalized'。対象プロジェクト
    ごとの確定結果をまとめてSlack通知する（FR-03-9③、2026-08-28実装）。"""
    pool = get_pool()
    notified_lines = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            for item in body.plans:
                plan = await conn.fetchrow(
                    """SELECT pqp.id, pqp.status, p.name AS project_name
                       FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
                       WHERE pqp.id = $1""",
                    item.plan_id,
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
                weekday_label = "・".join(_WEEKDAY_JA[w] for w in item.weekdays_finalized) or "なし"
                notified_lines.append(f"・「{plan['project_name']}」: {weekday_label}")
    await send_slack_notification(
        "出社曜日を確定しました。\n" + "\n".join(notified_lines)
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
    割当と矛盾するため取り消す（期間外の予約は影響しない）。status='seats_allocated'（割当済み）
    への再呼び出しも許可し、既存の割当を編集できる（2026-08-28追加。「S-09で座席の割り当てを
    編集できるようにしたい」との要望を受けた）。編集時は、旧・新いずれの割当座席についても
    その期間中の予約（A-18で生成済みのメンバー個人の周期予約を含む）を取り消す。座席の島が
    変わればメンバーごとの具体的な座席（A-18）も作り直す必要があるため、PJ席決担当が編集後に
    再度確保し直す想定である。プロジェクトの現在のメンバーが全員固定座席（T-04）を保有している
    場合は、座席の島自体を割り当てられない（2026-08-31追加。「固定席の人はプロジェクト席を
    作成できないようにしてほしい」との要望を受けた。required_seatsは計画の起票時点のスナップショット
    のため、起票後にメンバー構成・固定座席の状況が変わっても遡って更新されない〔2.9節T-07参照〕。
    このため、required_seatsが古い値のまま残っている計画に対しては、この時点の実際のメンバー構成を
    都度再確認しないと、誰も使えない座席の島を作成できてしまう不具合があった）。"""
    if not body.seat_ids:
        raise HTTPException(400, detail="座席を1つ以上選択してください")
    pool = get_pool()
    plan = await pool.fetchrow(
        "SELECT id, project_id, status, period_start, period_end, allocated_seats FROM project_quarter_plans WHERE id = $1", id
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] not in ("weekdays_finalized", "seats_allocated"):
        raise HTTPException(400, detail="出社曜日の確定後でなければ座席の島を割り当てられません")

    non_fixed_member_count = await pool.fetchval(
        """SELECT COUNT(*) FROM project_members pm
           WHERE pm.project_id = $1
             AND NOT EXISTS (SELECT 1 FROM fixed_seat_assignments fsa WHERE fsa.user_id = pm.user_id)""",
        plan["project_id"],
    )
    if non_fixed_member_count == 0:
        raise HTTPException(400, detail="このプロジェクトのメンバーは全員固定座席を保有しているため、プロジェクト座席は不要です")

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

    old_seat_ids = json.loads(plan["allocated_seats"]) if plan["allocated_seats"] else []
    cancel_target_ids = list(set(old_seat_ids) | set(body.seat_ids))

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """UPDATE reservations SET status = 'cancelled', updated_at = now()
                   WHERE seat_id = ANY($1::bigint[]) AND status = 'active' AND date BETWEEN $2 AND $3""",
                cancel_target_ids, plan["period_start"], plan["period_end"],
            )
            await conn.execute(
                """UPDATE project_quarter_plans
                   SET allocated_seats = $1, status = 'seats_allocated', decided_by = $2, updated_at = now()
                   WHERE id = $3""",
                json.dumps(body.seat_ids), user.id, id,
            )
    was_edit = plan["status"] == "seats_allocated"
    return {"detail": "座席の島の割当を更新しました" if was_edit else "座席の島を割り当てました"}
