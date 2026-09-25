# A-13〜A-18、A-58、A-64、A-71〜A-72、A-75、A-78 プロジェクト座席・PM側（S-04）。詳細設計書3.4節
# （2026-09-09追記: A-70〜A-72・A-75は新設時に本ファイル冒頭のコメントを更新しないまま追加されて
# いたため、既存分とあわせてここに列挙するよう修正した。同日、A-78〔プロジェクトの自己申告作成〕を
# 新設した。2026-09-10、A-70〔/free-seat-bookings〕はS-02の複数人代理予約〔A-75〕と内容が重複する
# との判断により廃止した）
import json
from datetime import date as Date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import (
    effective_seat_ids,
    generate_recurring_reservations,
    get_pool,
    retry_excluded_dates,
    seats_by_weekday,
)
from routers.project_seats import _WEEKDAY_JA, _format_seat_range

router = APIRouter(prefix="/api", tags=["project-pm"])


async def _member_row(pool, project_id: int, user_id: int):
    return await pool.fetchrow(
        "SELECT id, project_title, can_assign_seats FROM project_members WHERE project_id = $1 AND user_id = $2",
        project_id, user_id,
    )


async def _require_owner(pool, plan_id: int, user_id: int):
    """P-OWNER: 対象プロジェクトのT-06に自分の行があること（A-14・A-15共通）"""
    plan = await pool.fetchrow(
        """SELECT pqp.*, p.name AS project_name, p.proxy_user_id, p.created_by
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


# python標準のDate.weekday()（0=月）を曜日コードへ変換する（database._WEEKDAY_CODESと同じ並び。
# 2026-09-24追加、メンバー個別の座席確保〔A-18・A-72・A-64〕を曜日ごとの実効座席
# 〔effective_seat_ids〕に対応させる際、除外理由を実際の日付付きで報告するために使う）
_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _dates_for_weekday(start: Date, end: Date, weekday_code: str) -> list[Date]:
    """[start, end]の範囲内で、指定した曜日（'mon'等）に該当する日付を全て返す"""
    dates = []
    d = start
    while d <= end:
        if _WEEKDAY_CODES[d.weekday()] == weekday_code:
            dates.append(d)
        d += timedelta(days=1)
    return dates


def _seat_label_for_plan(
    allocated_seats_json, overrides_json, weekdays_finalized: list[str] | None, seat_no_by_id: dict[int, str]
) -> tuple[str | None, bool]:
    """PM/PL向けの座席表示ラベルを、曜日ごとの例外（allocated_seats_overrides）を考慮して組み立てる
    （2026-09-18新設）。従来は基本の島（allocated_seats）だけを見ていたため、曜日によって座席が
    異なるプロジェクトではPM/PLに間違った座席が表示される不具合があった（QA調査で発見）。
    確定曜日どうしの実効座席が全て同じ（has_seat_override=False）なら従来どおり単一のラベルを、
    異なる場合は曜日ごとの内訳（「月: B1〜B3／火: C1〜C3」）を返す。戻り値は(ラベル, has_seat_override)。"""
    raw_by_weekday, has_seat_override = seats_by_weekday(allocated_seats_json, overrides_json, weekdays_finalized)
    if raw_by_weekday is None:
        return None, False
    if not has_seat_override:
        # 確定曜日どうしが全て同じなら、そのうちのどれか1つの実効座席をそのまま使えばよい
        any_seat_ids = next(iter(raw_by_weekday.values()))
        label = _format_seat_range([seat_no_by_id[sid] for sid in any_seat_ids if sid in seat_no_by_id])
        return label, False
    parts = []
    for w in weekdays_finalized or []:
        seat_ids = raw_by_weekday.get(w, [])
        seat_label = _format_seat_range([seat_no_by_id[sid] for sid in seat_ids if sid in seat_no_by_id]) or '未登録'
        parts.append(f"{_WEEKDAY_JA[w]}: {seat_label}")
    return '／'.join(parts), True


@router.get("/projects/mine")
async def list_my_projects(user: CurrentUser = Depends(require_auth)):
    """A-13: 自分がPM・PL・SL・メンバーであるプロジェクトと、対象四半期の計画状況の一覧。
    各プロジェクトについて存在する計画を全件（period_start昇順）返す（2026-08-31訂正。従来は
    直近のperiod_startを持つ計画1件〔現在進行中とみなす〕のみを返していたが、「対象四半期を
    自由に選択できるようにしてほしい」との要望を受け、S-09と同様に対象四半期を選べるようにした）。
    is_project_creator（2026-09-09追加。当初はis_seat_proxyという名前でT-05.proxy_user_id基準
    だったが、同日中の千田さんの案によるワークフロー変更で権限の基準がproxy_user_idからcreated_by
    〔プロジェクトの作成者〕に変わったことに伴い、フィールド名・基準列とも変更した）: 自分がこの
    プロジェクトの作成者（T-05.created_by）かどうか。表示用の情報にのみ使う。
    <strong>2026-09-14訂正:</strong> 「作成者は席決め担当にするのではなくただの作成者で、何も権限は
    ない。席決め担当になった人がアンケートなどに回答できる」との指摘を受け、権限判定の基準を
    is_project_creator（created_by）からis_seat_assigner（T-05.proxy_user_id、PJ席決担当）に戻した
    （2026-09-09の千田さんの案による変更を取り消し、当初のis_seat_proxyと同じ基準に戻した形になる。
    is_project_creatorは表示用の情報としてのみ残す）。S-02の「複数人の代理予約」ボタンの表示条件
    （Availability.tsx）が、実際の権限判定（bulk_assign_free_seats_by_seat等のcan_manage、
    role='admin' or proxy_user_id==自分 or can_assign_seats）より緩いと権限のないPM/PLが操作の
    最後で403になるため、is_seat_assignerをここでも同じ基準で計算して返す。フロント側は
    can_assign_seats or is_seat_assignerで判定する（project_title条件は使わない）。
    <strong>2026-09-14追加:</strong> A-55（プロジェクト削除）を物理削除から論理削除（projects.deleted_at）
    に変更したことに伴い、削除済みプロジェクトが自分の一覧に残り続けないよう、常にdeleted_at IS NULLで
    絞り込む。
    <strong>2026-09-25追加:</strong> is_seat_assigner・can_assign_seats・admin以外のメンバー（自分が
    project_title上はPM/PLでも、実際のPJ席決担当ではない場合を含む）から見ると、アンケート回答欄も
    メンバー管理も表示されず「前回分を見る」だけの空の画面に見え、なぜ操作できないのか・誰が担当なのか
    説明がなかった（QA調査で判明）。案内表示用に実際のPJ席決担当の氏名<code>seat_assigner_name</code>
    （proxy_user_id未設定なら<code>null</code>）を返すようにした。"""
    rows = await get_pool().fetch(
        """SELECT pm.project_id, p.name AS project_name, pm.project_title, pm.can_assign_seats,
                  (p.created_by = $1) AS is_project_creator,
                  (p.proxy_user_id = $1) AS is_seat_assigner,
                  proxy.last_name AS proxy_last_name, proxy.first_name AS proxy_first_name,
                  plan.id AS plan_id, plan.period_start, plan.period_end, plan.status,
                  plan.required_seats, plan.allocated_seats, plan.allocated_seats_overrides,
                  plan.weekdays_finalized
           FROM project_members pm
           JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
           LEFT JOIN users proxy ON proxy.id = p.proxy_user_id
           LEFT JOIN project_quarter_plans plan ON plan.project_id = pm.project_id
           WHERE pm.user_id = $1
           ORDER BY p.name, plan.period_start""",
        user.id,
    )
    pool = get_pool()
    # 曜日ごとの例外（allocated_seats_overrides）の座席番号もラベル整形に必要（2026-09-18追加。
    # 「曜日によって座席が異なる」不具合の修正、_seat_label_for_plan参照）
    all_seat_ids = {sid for r in rows if r["allocated_seats"] for sid in json.loads(r["allocated_seats"])}
    for r in rows:
        if r["allocated_seats_overrides"]:
            for override_seat_ids in json.loads(r["allocated_seats_overrides"]).values():
                all_seat_ids.update(override_seat_ids)
    seat_no_by_id = await _seat_labels(pool, list(all_seat_ids))

    items_by_project: dict[int, dict] = {}
    for r in rows:
        item = items_by_project.setdefault(r["project_id"], {
            "project_id": r["project_id"], "project_name": r["project_name"],
            "project_title": r["project_title"], "can_assign_seats": r["can_assign_seats"],
            "is_project_creator": r["is_project_creator"],
            "is_seat_assigner": r["is_seat_assigner"],
            "seat_assigner_name": f"{r['proxy_last_name']} {r['proxy_first_name']}" if r["proxy_last_name"] else None,
            "plans": [],
        })
        if r["plan_id"] is None:
            continue
        weekdays_finalized = json.loads(r["weekdays_finalized"]) if r["weekdays_finalized"] else None
        seat_label, has_seat_override = _seat_label_for_plan(
            r["allocated_seats"], r["allocated_seats_overrides"], weekdays_finalized, seat_no_by_id
        )
        item["plans"].append({
            "id": r["plan_id"], "period_start": r["period_start"].isoformat(),
            "period_end": r["period_end"].isoformat(), "status": r["status"],
            "required_seats": r["required_seats"],
            "allocated_seat_label": seat_label,
            "has_seat_override": has_seat_override,
        })
    return {"items": list(items_by_project.values())}


class SelfProjectCreate(BaseModel):
    name: str


@router.post("/projects/mine")
async def create_my_project(body: SelfProjectCreate, user: CurrentUser = Depends(require_auth)):
    """A-78: プロジェクトの自己申告作成（2026-09-09新設）。A-28（S-08、管理部専用）とは別に、
    認証済みであれば誰でも呼べる。作成者をT-05.created_byとして記録し、あわせてproject_membersに
    project_title='PM'として自動登録する（既存のPM/PL前提のUI表示や、A-29のPJ席決担当がPM/PLで
    ある必要があるというバリデーションと自然に整合させるため）。
    <strong>2026-09-14訂正:</strong> 「作成者は席決め担当にするのではなくただの作成者で、何も権限は
    ない。席決め担当になった人がアンケートなどに回答できる」との指摘を受け、アンケート回答・席決め等の
    実権限をcreated_by（作成者）ではなくproxy_user_id（PJ席決担当）に戻した（A-16・A-17・A-18・A-29・
    A-55・A-58・A-64・A-71・A-72・A-75参照）。自己申告作成の時点ではPJ席決担当を選ぶUIがまだ
    存在しないため、作成した本人を既定のPJ席決担当としてproxy_user_id にも設定する（後から
    A-29で他のPM/PLへ譲渡できる）。これをしないと、作成した本人が自分のプロジェクトに対して
    何の操作もできなくなってしまう。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="プロジェクト名を入力してください")
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO projects (name, created_by, proxy_user_id) VALUES ($1, $2, $2) RETURNING id", name, user.id
            )
            await conn.execute(
                "INSERT INTO project_members (project_id, user_id, project_title) VALUES ($1, $2, 'PM')",
                row["id"], user.id,
            )
    return {"id": row["id"], "detail": "プロジェクトを作成しました"}


@router.get("/project-quarter-plans/{id}")
async def get_quarter_plan_detail(id: int, user: CurrentUser = Depends(require_auth)):
    """A-14: 四半期計画の詳細（必要座席数、状態、確定曜日、割当済み座席、メンバーごとの座席確保状況）。
    my_project_title・is_pmplは表示用（PMバッジ等）としてのみ残す。is_project_creatorも表示用の
    情報（自分が作成者かどうか）。
    <strong>2026-09-14訂正:</strong> 「作成者は席決め担当にするのではなくただの作成者で、何も権限は
    ない。席決め担当になった人がアンケートなどに回答できる」との指摘を受け、2026-09-09に一時的に
    T-05.created_by（作成者）基準へ切り替えていたアンケート回答（A-16）・席決め委任（A-17）等の
    実権限判定を、T-05.proxy_user_id（PJ席決担当）基準に戻した。フロント側の表示条件
    〔ProjectSeatRequest.tsx〕もis_project_creatorではなく新設のis_seat_assignerを見るようにする。"""
    pool = get_pool()
    plan, my_member = await _require_owner(pool, id, user.id)

    weekdays_finalized = json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else None
    allocated_seat_ids = json.loads(plan["allocated_seats"]) if plan["allocated_seats"] else None
    # 曜日ごとの実効座席（2026-09-18修正。「曜日によって座席が異なるプロジェクトでPM/PLに
    # 間違った座席が表示される」不具合の修正、_seat_label_for_plan参照）。座席番号の整形には
    # 基本の島だけでなく曜日ごとの例外の座席も必要なため、raw_by_weekdayの全曜日分の和集合で
    # seat_no_by_idを引く
    raw_by_weekday, has_seat_override = seats_by_weekday(
        plan["allocated_seats"], plan["allocated_seats_overrides"], weekdays_finalized
    )
    all_effective_seat_ids = {sid for seat_ids in (raw_by_weekday or {}).values() for sid in seat_ids}
    seat_no_by_id = await _seat_labels(pool, list(all_effective_seat_ids))
    allocated_seat_label, _ = _seat_label_for_plan(
        plan["allocated_seats"], plan["allocated_seats_overrides"], weekdays_finalized, seat_no_by_id
    )
    allocated_seats_by_weekday = (
        {
            w: {
                "seat_ids": seat_ids,
                "seat_label": _format_seat_range([seat_no_by_id[sid] for sid in seat_ids if sid in seat_no_by_id]),
            }
            for w, seat_ids in raw_by_weekday.items()
        }
        if raw_by_weekday is not None else None
    )

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
    # メンバーの実際の予約は、曜日によって物理座席が異なりうるため、基本の島だけでなく曜日ごとの
    # 例外の座席も含めた和集合（all_effective_seat_ids）から探す（2026-09-18修正。従来は基本の島
    # だけを見ており、例外の座席にしか予約がないメンバーが「未確保」と誤表示されるおそれがあった）。
    # 2026-09-24修正:「曜日ごとに分けて座席を選択できるようにしてほしい」との要望を受け、メンバー
    # 個別の座席確保自体も曜日ごとに異なる座席を持てるようにした（下のbulk_assign_seats参照）ため、
    # ここでも曜日（isodow）ごとに実際の予約座席を集計し、確定曜日どうしで座席が異なるメンバーには
    # T-07の座席の島と同じ「月: B1／火: C3」形式の内訳ラベルを表示する（_seat_label_for_planと
    # 同じ考え方）。1件のDISTINCT ONで代表1件だけ拾っていた従来の方式では、実際には曜日ごとに
    # 別の座席へ確保されているメンバーの一部の曜日が確認できなかった
    assigned_seats_by_weekday_by_user: dict[int, dict[str, int]] = {}
    if all_effective_seat_ids:
        assign_rows = await pool.fetch(
            """SELECT r.user_id, r.seat_id, EXTRACT(ISODOW FROM r.date)::int AS isodow
               FROM reservations r
               WHERE r.seat_id = ANY($1::bigint[]) AND r.status = 'active'
                 AND r.date BETWEEN $2 AND $3
               ORDER BY r.date""",
            list(all_effective_seat_ids), plan["period_start"], plan["period_end"],
        )
        isodow_to_weekday = {1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri"}
        for r in assign_rows:
            w = isodow_to_weekday.get(r["isodow"])
            if w is None:
                continue
            assigned_seats_by_weekday_by_user.setdefault(r["user_id"], {}).setdefault(w, r["seat_id"])
    assigned_seat_by_user: dict[int, int] = {
        # 代表値（assigned_seat_id・単一の座席のみのメンバーのassigned_seat_no用）は確定曜日の
        # 先頭から見つかったものを使う（従来のDISTINCT ON ... ORDER BY dateとほぼ同じ結果になる）
        uid: next(iter(seats.values()))
        for uid, seats in assigned_seats_by_weekday_by_user.items()
    }

    def _member_seat_label(user_id: int) -> str | None:
        seats = assigned_seats_by_weekday_by_user.get(user_id)
        if not seats:
            return None
        distinct = set(seats.values())
        if len(distinct) == 1:
            return seat_no_by_id.get(next(iter(distinct)))
        parts = [
            f"{_WEEKDAY_JA[w]}: {seat_no_by_id.get(seats[w], '?')}"
            for w in (weekdays_finalized or []) if w in seats
        ]
        return "／".join(parts) if parts else None

    is_pmpl = my_member["project_title"] in ("PM", "PL")
    is_project_creator = plan["created_by"] == user.id
    is_seat_assigner = plan["proxy_user_id"] == user.id
    can_manage_seat_assign = (
        user.role == "admin"
        or is_seat_assigner
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
        "weekdays_finalized": weekdays_finalized,
        "allocated_seat_ids": allocated_seat_ids,
        "has_seat_override": has_seat_override,
        "allocated_seats_by_weekday": allocated_seats_by_weekday,
        "allocated_seat_label": allocated_seat_label,
        # 「割り当てる座席」の選択肢（未確保のメンバー向け）に座席番号を表示するため、座席番号一覧を
        # 返す（2026-08-28追加）。2026-09-24修正:「このプロジェクトは曜日によって座席の島が異なる
        # ため、メンバーへの座席確保はまだこの画面から行えません」というブロックを撤去し、メンバー
        # 個別の座席確保（A-18・A-64、BulkSeatAssign）も曜日ごとに異なる座席を選べるようにしたため、
        # 選択肢は基本の島（allocated_seat_ids）だけでなく曜日ごとの例外も含めた和集合
        # （all_effective_seat_ids）を返す。フロント側は曜日によって座席が異なるプロジェクト
        # （has_seat_override）では、確定曜日ごとに別々の<select>でこの中から選ぶ
        "allocated_seats": (
            [{"id": sid, "seat_no": seat_no_by_id[sid]} for sid in all_effective_seat_ids if sid in seat_no_by_id]
            if all_effective_seat_ids else None
        ),
        # メンバー個別の座席確保（A-18・A-64、BulkSeatAssign）を一律ブロックする目印だったが、
        # 2026-09-24修正で撤去した。「曜日によって座席の島が異なるため確保できません」という要件は
        # 本来不要で、確定曜日ごとに別々の座席を選べるようにするのが正しい対応だったとの指摘を受けた
        # （bulk_assign_seats・retry_seat_assignment・change_member_seatのdocstring参照）。座席の島
        # 自体が全く割り当てられていない（all_effective_seat_idsが空、通常status='seats_allocated'
        # では起こらないはずの防御的なケース）の場合のみtrueにする
        "member_seat_assign_blocked_by_override": not all_effective_seat_ids,
        "my_project_title": my_member["project_title"], "is_pmpl": is_pmpl,
        "is_project_creator": is_project_creator,
        "is_seat_assigner": is_seat_assigner,
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
                "assigned_seat_no": _member_seat_label(m["user_id"]),
            }
            for m in members_rows
        ],
    }


@router.get("/project-quarter-plans/{id}/previous")
async def get_previous_quarter_plan(id: int, user: CurrentUser = Depends(require_auth)):
    """A-15: 前回サイクル（3か月前とは限らず、同一プロジェクトで直近のもの）の計画を参照専用で取得（D13）。
    2026-09-10変更: 「前回のPJ席の人・曜日調整がコピーできるようにしてほしい」との要望を受け、
    (1) 前回の座席割当（既存のassignments）に加え前回の出社曜日アンケート回答（response）・
    確定曜日（weekdays_finalized）も返すようにした（S-04の「前回の回答をコピーする」
    〔SurveyForm〕・「前回の座席をコピーする」〔BulkSeatAssign〕、S-09の「前回の確定曜日を
    コピーする」〔WeekdayMatrix〕がそれぞれ使う）。(2) S-09（エリア責任者、role='admin'）からも
    呼べるよう、role='admin'であれば自分がプロジェクトのメンバーでなくても許可するようにした。
    A-14と共有する_require_ownerはmy_memberがNone非許容の実装のため、それとは独立に権限判定する。
    2026-09-16追加: allocated_seat_label（座席番号だけの簡潔な表示、現在の計画のallocated_seat_labelと
    同じ_format_seat_rangeで整形）を追加した。S-09の曜日調整表に前回の座席の島・確定曜日を常時表示
    する欄向けで、メンバー個別の内訳までは不要なケース用（assignmentsは引き続き残す）。"""
    pool = get_pool()
    plan = await pool.fetchrow(
        "SELECT project_id, period_start FROM project_quarter_plans WHERE id = $1", id
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin":
        member = await _member_row(pool, plan["project_id"], user.id)
        if member is None:
            raise HTTPException(403, detail="この操作を行う権限がありません")

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

    response = await pool.fetchrow(
        "SELECT choice1_weekdays, choice2_weekdays, note, requested_seats FROM project_weekday_responses WHERE plan_id = $1",
        previous["id"],
    )

    return {
        "id": previous["id"], "period_start": previous["period_start"].isoformat(),
        "period_end": previous["period_end"].isoformat(), "assignments": assignments,
        # 座席番号だけを簡潔に示したい呼び出し元向け（2026-09-16追加、S-09の常時表示欄が使う）。
        # 個々のメンバーの割当ではなく、そのプロジェクトに割り当てられていた座席の島そのものを表す
        "allocated_seat_label": (
            _format_seat_range([seat_no_by_id[sid] for sid in allocated_seat_ids if sid in seat_no_by_id])
            if allocated_seat_ids else None
        ),
        "weekdays_finalized": json.loads(previous["weekdays_finalized"]) if previous["weekdays_finalized"] else None,
        "response": (
            {
                "choice1_weekdays": json.loads(response["choice1_weekdays"]),
                "choice2_weekdays": json.loads(response["choice2_weekdays"]),
                "note": response["note"], "requested_seats": response["requested_seats"],
            } if response else None
        ),
    }


class SurveyResponseBody(BaseModel):
    choice1_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]]
    choice2_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]]
    note: str | None = None
    requested_seats: int | None = None


@router.put("/project-quarter-plans/{id}/response")
async def submit_survey_response(id: int, body: SurveyResponseBody, user: CurrentUser = Depends(require_auth)):
    """A-16: 出社曜日アンケートへの回答（FR-03-4）。T-11をUPSERT。requested_seatsはT-07.required_seats
    へ自動反映する。status='survey_open'の間のみ回答できる（曜日確定後は変更不可、2026-08-28追加）。
    第一・第二希望とも、選択できる曜日数は問わない（2026-09-02訂正。「2つのみの選択を変更してなんでも
    選択できるようにしてほしい」との要望を受け、従来の「ちょうど2つ」という制約〔choice1・choice2とも〕
    を撤廃した。0個〔希望なし〕も許容する）。
    2026-09-09変更（千田さんの案、2026-09-14に取り消し）: 回答できる対象を、一時的にP-PMPL
    （project_title∈{'PM','PL'}）からP-CREATOR（T-05.created_by＝プロジェクトの作成者）に
    変更していたが、「作成者は席決め担当にするのではなくただの作成者で、何も権限はない。
    席決め担当になった人がアンケートなどに回答できる」との指摘を受け、P-PROXY（T-05.proxy_user_id＝
    PJ席決担当）基準に戻した。role='admin'は引き続き対象外にはしない（他のAPIと同様の管理部
    バイパス、ただしA-13の一覧が自分がメンバーのプロジェクトのみを返すため、admin自身がメンバー
    でない限りこの画面には辿り着けない＝API直叩き向けの保険）。"""
    if body.requested_seats is not None and body.requested_seats < 0:
        raise HTTPException(400, detail="必要座席数は0以上を指定してください")
    if body.note is not None and len(body.note) > 500:
        raise HTTPException(400, detail="備考は500文字以内で入力してください")

    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.id, pqp.project_id, pqp.status, p.proxy_user_id
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin" and plan["proxy_user_id"] != user.id:
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
    """A-17: 「席決め」権限の付与・剥奪（FR-03-8）。2026-09-09変更（千田さんの案、2026-09-14に取消し）:
    付与できる人を一時的にP-PMPL（対象メンバーと同一プロジェクトのPM(PL)本人）からP-CREATOR
    （T-05.created_by＝プロジェクトの作成者）に変更していたが、「作成者は席決め担当にするのでは
    なくただの作成者で、何も権限はない」との指摘を受け、P-PROXY（T-05.proxy_user_id＝PJ席決担当）
    基準に戻した。role='admin'も対象とする（A-16と同じ考え方）。"""
    pool = get_pool()
    target = await pool.fetchrow(
        """SELECT pm.id, pm.project_id, p.proxy_user_id
           FROM project_members pm JOIN projects p ON p.id = pm.project_id
           WHERE pm.id = $1""",
        id,
    )
    if target is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin" and target["proxy_user_id"] != user.id:
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
    座席確保操作（FR-03-7）を行える者（admin、PJ席決担当、席決め権限保有者）が設定できる
    （2026-09-09にPJ席決担当〔proxy_user_id〕から作成者〔created_by〕へ変更していたが、
    「作成者は席決め担当にするのではなくただの作成者で、何も権限はない」との指摘を受け、
    2026-09-14にproxy_user_id基準へ戻した）。"""
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
    # 従来どおり全確定曜日へ共通の1つの座席を割り当てる場合はseat_idを送る。曜日によって座席の島が
    # 異なるプロジェクト（has_seat_override）では、代わりにseats_by_weekdayで曜日ごとに別々の座席を
    # 指定できる（2026-09-24追加。「曜日ごとに座席が違うプロジェクトでも、その座席に割り当てられて
    # いればそのエリアで席を割り振れるようにしてほしい」との要望を受けた。詳細はbulk_assign_seats
    # docstring参照）。両方省略した場合はそのメンバーを除外扱いにする
    seat_id: int | None = None
    seats_by_weekday: dict[Literal["mon", "tue", "wed", "thu", "fri"], int] | None = None


class SeatAssignmentsBody(BaseModel):
    assignments: list[SeatAssignmentItem]


@router.post("/project-quarter-plans/{id}/seat-assignments")
async def bulk_assign_seats(id: int, body: SeatAssignmentsBody, user: CurrentUser = Depends(require_auth)):
    """A-18: 割り当てられた座席の島の範囲内で、メンバーへ座席を一括確保する（FR-03-7）。T-09（周期予約
    ルール）を生成し、確定した出社曜日（weekdays_finalized）・対象四半期をもとにT-08を一括生成する。
    role='admin'またはP-PROXY（T-05.proxy_user_id、PJ席決担当）またはP-SEATASSIGN
    （T-06.can_assign_seats）（2026-09-09に一時的にP-CREATOR〔T-05.created_by、プロジェクトの
    作成者〕へ変更していたが、「作成者は席決め担当にするのではなくただの作成者で、何も権限は
    ない」との指摘を受け、2026-09-14に元のP-PROXY基準へ戻した）。
    座席は各曜日の実効座席（database.effective_seat_ids()）の範囲外を指定不可。同一座席・同一曜日を
    複数のメンバーに重複して指定した場合、当該メンバーの組み合わせのみ確保対象から除外する
    （要件定義書3.3節手順7）。固定座席保有者を確保対象から一律除外していたRULE-07は2026-09-09に
    廃止した（「固定席・プロジェクト席・フリー座席は同時に持てる状態でよい」との回答を受けた）。
    デフォルトの必要座席数（required_seats）の算出ロジック自体は変更していないため、固定座席保有者を
    含めて確保する場合は必要に応じてPM・PL側で必要座席数を調整する。

    2026-09-24修正:「このプロジェクトは曜日によって座席の島が異なるため、メンバーへの座席確保は
    まだこの画面から行えません」というブロックを撤去した。以前は基本の島（allocated_seats）のみを
    対象に、確定した全曜日へ同じ物理座席で1本の周期予約（T-09）を作る仕組みだったため、曜日ごとに
    実効座席が異なるプロジェクト（has_seat_override）には未対応で、対応しないまま実行すると、ある
    曜日では既に別プロジェクトへ明け渡し済みの座席へ誤ってメンバーを確保してしまう恐れがあった
    （2026-09-18のQA調査で発見し、いったんブロックで塞いでいた）。「曜日ごとに分けて座席を選択
    できるようにしてほしい」との要望を受け、今回はブロックを外す代わりに本APIを曜日ごとの実効座席に
    対応させた。メンバーごとにseats_by_weekdayで曜日別の座席を指定できるようにし、各(座席, 曜日)の
    組み合わせがdatabase.effective_seat_ids()の結果に含まれているかをその都度検証する（project_seats.py
    のA-44・A-80と同じ(座席id, 曜日)単位の考え方）。含まれていない・このバッチ内の他メンバーと同じ
    曜日に重複している場合は、その曜日だけをこれまでの「除外」と同じ形式（excluded_dates、該当曜日の
    実際の日付ぶん）で報告し、有効な曜日だけをまとめて座席ごとにgenerate_recurring_reservations()へ
    渡す（1人のメンバーが曜日によって異なる座席を使う場合、座席ごとに複数のT-09行を作る）。
    seats_by_weekdayを省略しseat_idのみ指定した場合は、従来どおりその1つの座席を全確定曜日へ適用
    しようとするが、有効性の検証自体は上と同じ曜日単位で行うため、曜日によって座席の島が異なる
    プロジェクトでその座席が一部の曜日にしか属さない場合は、属さない曜日だけが除外される
    （その座席が全確定曜日に共通なら従来と全く同じ結果になる）。"""
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
    # 2026-09-15追加: 「プロジェクトの人を変更するとき過去のプロジェクトにもそれが影響されている」
    # との報告を受けた。project_membersは期間を持たない単一の現在値のため、既に終了した過去の計画
    # （period_end<今日）に対して本APIを呼んでも、確保対象は常にその時点の「現在のメンバー」になって
    # しまい、実際にその期間に在籍していたメンバーとは一致しない。書き込み自体は
    # start_date=max(period_start, 今日)によりperiod_endを超える日付は生成されないため実害はない
    # （period_end<今日なら対象日数は常に0件）が、無反応のまま何も起きないのは分かりにくいため、
    # 期間が既に終了した計画は明示的に拒否するようにした。
    if plan["period_end"] < Date.today():
        raise HTTPException(400, detail="この計画の対象期間は既に終了しています。現在のメンバー構成を過去の期間に適用することはできません")

    my_member = await _member_row(pool, plan["project_id"], user.id)
    can_manage = (
        user.role == "admin"
        or plan["proxy_user_id"] == user.id
        or (my_member is not None and my_member["can_assign_seats"])
    )
    if not can_manage:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    weekdays_finalized = json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else []
    if not weekdays_finalized:
        raise HTTPException(400, detail="出社曜日が確定していません")

    # 曜日ごとの実効座席（database.effective_seat_ids()、project_seats.pyのA-44・A-80と同じ関数）。
    # 座席の選択が実際にその曜日のプロジェクトの座席の島に含まれているかの検証に使う
    effective_by_weekday: dict[str, set[int]] = {
        w: set(effective_seat_ids(plan["allocated_seats"], plan["allocated_seats_overrides"], w))
        for w in weekdays_finalized
    }
    all_effective_seat_ids = {sid for ids in effective_by_weekday.values() for sid in ids}
    if not all_effective_seat_ids:
        raise HTTPException(400, detail="座席の島が割り当てられていません")

    member_rows = await pool.fetch(
        "SELECT user_id, seat_not_required FROM project_members WHERE project_id = $1", plan["project_id"]
    )
    member_user_ids = {r["user_id"] for r in member_rows}
    seat_not_required_user_ids = {r["user_id"] for r in member_rows if r["seat_not_required"]}
    seat_no_by_id = await _seat_labels(pool, list(all_effective_seat_ids))

    # メンバーごとの「曜日→座席」マップを組み立てる。seats_by_weekdayが指定されていればそれを使い
    # （未指定の曜日は確保対象外）、無指定ならseat_idを全確定曜日に共通で使う
    member_weekday_seat: dict[int, dict[str, int]] = {}
    for a in body.assignments:
        if a.seats_by_weekday:
            member_weekday_seat[a.member_user_id] = dict(a.seats_by_weekday)
        elif a.seat_id is not None:
            member_weekday_seat[a.member_user_id] = {w: a.seat_id for w in weekdays_finalized}
        else:
            member_weekday_seat[a.member_user_id] = {}

    # (曜日, 座席id) → このバッチ内で割り当てようとしているメンバー数。同じ曜日・同じ座席を複数
    # メンバーへ割り当てようとしていないか検出する（generate_recurring_reservationsは
    # check_project_block=Falseで呼ぶため他プロジェクトとの重複は検出されるが、このバッチ内の
    # メンバー同士の重複は自前で検出する必要がある。旧実装のseat_counts〔座席id単位〕を
    # (曜日, 座席id)単位に拡張した）
    weekday_seat_counts: dict[tuple[str, int], int] = {}
    for seat_map in member_weekday_seat.values():
        for w, sid in seat_map.items():
            weekday_seat_counts[(w, sid)] = weekday_seat_counts.get((w, sid), 0) + 1

    start_date = max(plan["period_start"], Date.today())
    results = []
    for a in body.assignments:
        seat_map = member_weekday_seat[a.member_user_id]
        seat_ids_used = sorted({sid for sid in seat_map.values()})
        seat_label = (
            _format_seat_range([seat_no_by_id.get(sid, "?") for sid in seat_ids_used])
            if len(seat_ids_used) <= 1
            else "／".join(f"{_WEEKDAY_JA[w]}: {seat_no_by_id.get(seat_map[w], '?')}" for w in weekdays_finalized if w in seat_map)
        )
        seat_id_out = seat_ids_used[0] if len(seat_ids_used) == 1 else None

        if a.member_user_id not in member_user_ids:
            results.append({"member_user_id": a.member_user_id, "seat_id": seat_id_out, "seat_no": seat_label,
                             "status": "excluded", "reason": "対象が見つかりません"})
            continue
        if a.member_user_id in seat_not_required_user_ids:
            results.append({"member_user_id": a.member_user_id, "seat_id": seat_id_out, "seat_no": seat_label,
                             "status": "excluded", "reason": "在宅勤務のためプロジェクト座席は不要に設定されています"})
            continue
        if not seat_map:
            results.append({"member_user_id": a.member_user_id, "seat_id": None, "seat_no": None,
                             "status": "excluded", "reason": "座席が選択されていません"})
            continue
        if start_date > plan["period_end"]:
            results.append({"member_user_id": a.member_user_id, "seat_id": seat_id_out, "seat_no": seat_label,
                             "status": "excluded", "reason": "対象四半期は既に終了しています"})
            continue

        excluded_dates: list[dict] = []
        valid_weekdays_by_seat: dict[int, list[str]] = {}
        for w, sid in seat_map.items():
            if w not in weekdays_finalized:
                continue
            if sid not in effective_by_weekday.get(w, set()):
                excluded_dates.extend(
                    {"date": d.isoformat(), "reason": "この曜日はこの座席がプロジェクトの座席の島に含まれていません"}
                    for d in _dates_for_weekday(start_date, plan["period_end"], w)
                )
                continue
            if weekday_seat_counts.get((w, sid), 0) > 1:
                excluded_dates.extend(
                    {"date": d.isoformat(), "reason": "他のメンバーと座席が重複しています"}
                    for d in _dates_for_weekday(start_date, plan["period_end"], w)
                )
                continue
            valid_weekdays_by_seat.setdefault(sid, []).append(w)

        created_total = 0
        for sid, ws in valid_weekdays_by_seat.items():
            gen = await generate_recurring_reservations(
                sid, a.member_user_id, {"type": "weekly", "weekdays": ws},
                start_date, plan["period_end"], user.id,
                enforce_rule05=False, check_project_block=False,
            )
            created_total += sum(1 for r in gen["results"] if r["status"] == "created")
            excluded_dates.extend(
                {"date": r["date"], "reason": r["reason"]} for r in gen["results"] if r["status"] == "excluded"
            )

        if created_total == 0:
            results.append({"member_user_id": a.member_user_id, "seat_id": seat_id_out, "seat_no": seat_label,
                             "status": "excluded",
                             "reason": excluded_dates[0]["reason"] if excluded_dates else "確保できる日がありません",
                             "excluded_dates": excluded_dates})
        else:
            results.append({"member_user_id": a.member_user_id, "seat_id": seat_id_out, "seat_no": seat_label,
                             "status": "assigned", "created_days": created_total, "excluded_days": len(excluded_dates),
                             "excluded_dates": excluded_dates})
    return {"results": results}


class RetrySeatAssignmentBody(BaseModel):
    member_user_id: int
    seat_id: int
    dates: list[Date]


@router.post("/project-quarter-plans/{id}/seat-assignments/retry")
async def retry_seat_assignment(id: int, body: RetrySeatAssignmentBody, user: CurrentUser = Depends(require_auth)):
    """A-72: メンバーへの座席の島の割当（A-18）の結果で「除外」となった日だけを、同じ座席の島の
    範囲内の別の座席に振り替える（2026-09-07追加。A-71〔free-seat-assignments/retry〕のプロジェクト
    座席版）。A-18と同じくRULE-05・座席専有チェックはスキップし（enforce_rule05=False・
    check_project_block=False）、対象期間もA-18と同じ（本日以降〜plan.period_end）。権限はA-18と同じ
    role='admin'またはP-PROXY（T-05.proxy_user_id）またはP-SEATASSIGN（2026-09-09に一時的にP-CREATOR
    へ変更していたが、2026-09-14にP-PROXYへ戻した。A-18のdocstring参照）。
    2026-09-24修正: A-18と同じ理由でブロックを撤去した。振替先のbody.seat_idが、指定した各日付の
    実際の曜日について有効か（database.effective_seat_ids()）を日付ごとに検証する。曜日によって
    座席の島が異なるプロジェクトで、振替先が一部の日の曜日にしか属さない座席の場合、属さない日は
    振替を行わず除外として報告する（A-18と同じ(座席id, 曜日)単位の検証）。"""
    if not body.dates:
        raise HTTPException(400, detail="振り替える日付を1つ以上指定してください")

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
    # A-18と同じ理由（2026-09-15追加）で、既に終了した計画への振り替えは拒否する
    if plan["period_end"] < Date.today():
        raise HTTPException(400, detail="この計画の対象期間は既に終了しています。現在のメンバー構成を過去の期間に適用することはできません")

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
    member_user_ids = {r["user_id"] for r in member_rows}
    seat_not_required_user_ids = {r["user_id"] for r in member_rows if r["seat_not_required"]}
    if body.member_user_id not in member_user_ids:
        raise HTTPException(404, detail="対象が見つかりません")
    if body.member_user_id in seat_not_required_user_ids:
        raise HTTPException(400, detail="在宅勤務のためプロジェクト座席は不要に設定されています")

    # 日付ごとに、その曜日の実効座席にbody.seat_idが含まれているかを検証する（2026-09-24修正）
    valid_dates: list[Date] = []
    excluded_dates: list[dict] = []
    for d in body.dates:
        w = _WEEKDAY_CODES[d.weekday()]
        if body.seat_id in effective_seat_ids(plan["allocated_seats"], plan["allocated_seats_overrides"], w):
            valid_dates.append(d)
        else:
            excluded_dates.append({"date": d.isoformat(), "reason": "この曜日はこの座席がプロジェクトの座席の島に含まれていません"})
    if not valid_dates:
        raise HTTPException(400, detail="座席の島の範囲外の座席です")

    seat_no_by_id = await _seat_labels(pool, [body.seat_id])
    results = await retry_excluded_dates(
        body.seat_id, body.member_user_id, valid_dates, user.id,
        enforce_rule05=False, check_project_block=False,
    )
    created = [r for r in results if r["status"] == "created"]
    excluded_dates.extend({"date": r["date"], "reason": r["reason"]} for r in results if r["status"] == "excluded")
    return {
        "seat_id": body.seat_id, "seat_no": seat_no_by_id.get(body.seat_id, "?"),
        "created_days": len(created), "excluded_days": len(excluded_dates),
        "excluded_dates": excluded_dates,
    }


class FreeSeatAssignmentPattern(BaseModel):
    type: Literal["daily", "weekly"]
    weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]] | None = None


class FreeSeatAssignmentItem(BaseModel):
    member_user_id: int
    seat_id: int
    start_date: Date
    end_date: Date
    pattern: FreeSeatAssignmentPattern


class FreeSeatAssignmentsBody(BaseModel):
    assignments: list[FreeSeatAssignmentItem]


@router.post("/project-quarter-plans/{id}/free-seat-assignments")
async def bulk_assign_free_seats_by_seat(id: int, body: FreeSeatAssignmentsBody, user: CurrentUser = Depends(require_auth)):
    """A-75: 複数メンバーへ、S-02のフロアマップ上で1人ずつクリックして選んだ座席を、それぞれ指定した期間・
    繰り返しパターン（毎日／毎週）でフリー座席として一括予約する（2026-09-04追加、2026-09-07に
    単発日付のみの対応から日付範囲・繰り返しパターン対応へ拡張。さらに同日、期間・パターンを全員
    共通の1つから、座席をクリックするたびにその場のモーダルで1人分ずつ確認・確定する方式に変更した。
    「フリー座席と同じ席の取り方（座席をクリックするたびにモーダルで確認・確定）をしてほしい」との
    要望を受けた）。2026-09-08、フロントエンドの入力方式を「開始日＋繰り返しパターン」から
    「日にちを検索してその日の座席表を見ながら、日付ごとに座席をクリックして選ぶ」方式へ変更した
    （「複数日選択した後、フリー座席を決定する予約方法にしたい。日付ごとに別の座席を選べるように
    したい」との要望を受けた）ことに伴い、1回のクリック＝1件のassignment（start_date=end_date、
    pattern.type='daily'固定）として送られてくるようになったが、APIのBody形状・処理自体は変更して
    いない（1人のメンバーが複数の日付・座席を別々のassignmentとして持てるだけで、以前から
    assignments一覧の各要素は独立して処理していたため）。呼び出し元が指定した特定の座席に
    メンバーを固定して繰り返し予約する（エリア指定で自動割当するA-70は、S-02の本APIと内容が
    重複するとの判断により2026-09-10に廃止した）。日ごとのRULE-02・RULE-05・座席専有チェックは
    A-10・A-18と共通のgenerate_recurring_reservationsに委譲する（メンバー・座席1組につき1件の
    recurring_rulesを作成。RULE-07は2026-09-09に廃止）。

    ID管理の補足（2026-09-09追加）: このエンドポイントは新設時にA番号を振らないまま docstring に
    記載されず、retry_free_seat_assignment（A-71）のdocstring内で「A-58（bulk_assign_free_seats_by_seat）
    と同じ」と誤って言及されていた。A-58は実際にはupdate_seat_not_required（PUT
    /project-members/{id}/seat-not-required）に既に割り当て済みの番号（詳細設計書3.4節）であり、
    重複していた。A-70〜A-74が既に使用済みだったため、本エンドポイントには新たにA-75を割り当てて
    解消した。権限はA-18と同じrole='admin'またはP-PROXY（T-05.proxy_user_id）またはP-SEATASSIGN
    （2026-09-09に一時的にP-CREATORへ変更していたが、「作成者は席決め担当にするのではなくただの
    作成者で、何も権限はない」との指摘を受け2026-09-14にP-PROXYへ戻した）。"""
    if not body.assignments:
        raise HTTPException(400, detail="座席を割り当てるメンバーを1人以上指定してください")
    for a in body.assignments:
        if a.start_date > a.end_date:
            raise HTTPException(400, detail="開始日は終了日以前を指定してください")
        if a.pattern.type == "weekly" and not a.pattern.weekdays:
            raise HTTPException(400, detail="毎週の場合は曜日を1つ以上選択してください")

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

    seats = await pool.fetch(
        "SELECT id, seat_no, seat_type, status FROM seats WHERE id = ANY($1::bigint[])",
        [a.seat_id for a in body.assignments],
    )
    seat_by_id = {s["id"]: s for s in seats}
    enforce_rule05 = user.role != "admin"

    # 座席の重複（同じ座席を複数人に割り当てようとした場合）は、ここで一律に弾かず
    # generate_recurring_reservations側の日単位の重複チェック（UNIQUE制約）に委ねる
    # （2026-09-08修正。以前はリクエスト内で同じseat_idが2回以上出現した時点で全件を
    # 「他のメンバーと座席が重複しています」として除外していたが、「日にちを検索してその日の
    # 座席表を見ながら、複数日をそれぞれ別の座席で確保したい」との要望を受け、1人のメンバーが
    # 複数の日付・座席を個別に指定できるようにしたところ、日付が重ならない限り同じ座席番号を
    # 別の日に複数回使うのは本来問題ないにもかかわらず誤って全件除外されてしまう不具合になった。
    # 各assignmentは順番にawaitされるため、本当に同じ座席・同じ日が重複した場合は後続の
    # INSERTがUNIQUE制約違反となり、その日だけ正しく除外される）
    results = []
    for a in body.assignments:
        seat = seat_by_id.get(a.seat_id)
        seat_no = seat["seat_no"] if seat else "?"
        reason = None
        if a.member_user_id not in member_user_ids_in_project:
            reason = "このプロジェクトのメンバーではありません"
        elif a.member_user_id in seat_not_required_user_ids:
            reason = "在宅勤務のため座席は不要に設定されています"
        elif seat is None or seat["status"] != "active" or seat["seat_type"] != "free":
            reason = "この座席はフリー座席として予約できません"
        if reason is not None:
            results.append({"member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                             "status": "excluded", "reason": reason, "created_days": 0, "excluded_days": 0})
            continue
        gen = await generate_recurring_reservations(
            a.seat_id, a.member_user_id, a.pattern.model_dump(exclude_none=True), a.start_date, a.end_date, user.id,
            enforce_rule05=enforce_rule05, check_project_block=True,
        )
        created = [r for r in gen["results"] if r["status"] == "created"]
        excluded = [r for r in gen["results"] if r["status"] == "excluded"]
        # excluded_dates: 除外された日だけを別の座席に振り替えられるよう、日付・理由を明細で返す
        # （2026-09-07追加、A-71参照）
        excluded_dates = [{"date": r["date"], "reason": r["reason"]} for r in excluded]
        if not created:
            results.append({
                "member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                "status": "excluded", "reason": excluded[0]["reason"] if excluded else "確保できる日がありません",
                "created_days": 0, "excluded_days": len(excluded), "excluded_dates": excluded_dates,
            })
        else:
            results.append({
                "member_user_id": a.member_user_id, "seat_id": a.seat_id, "seat_no": seat_no,
                "status": "assigned", "created_days": len(created), "excluded_days": len(excluded),
                "excluded_dates": excluded_dates,
            })
    return {"results": results}


class RetryFreeSeatAssignmentBody(BaseModel):
    member_user_id: int
    seat_no: str
    dates: list[Date]


@router.post("/project-quarter-plans/{id}/free-seat-assignments/retry")
async def retry_free_seat_assignment(id: int, body: RetryFreeSeatAssignmentBody, user: CurrentUser = Depends(require_auth)):
    """A-71: 複数人のフリー座席一括確保（S-02の座席クリック版、A-75）の
    結果で「除外」となった日だけを、指定した別の座席に振り替える（2026-09-07追加。「席を取って結果で
    除外が出てきたとき、除外部分だけ別の席に変更できる機能が欲しい」との要望を受けた）。権限・除外
    理由の考え方はA-75（bulk_assign_free_seats_by_seat、2026-09-09訂正。従来ここでA-58と誤記していたが、
    A-58は既にupdate_seat_not_requiredに割り当て済みのため、正しい番号A-75に修正した）と同じ。振替は
    datesで明示的に指定された日付
    だけを対象にする（元々成功していた日には触れない）。座席はidではなく座席番号（seat_no）で指定する
    （A-22座席一覧は管理部専用のため、管理部以外の呼び出し元〔PJ席決担当〕が座席idの一覧を取得する
    手段がなく、フロアマップ上で見えている座席番号をそのまま入力できるようにするため）。権限は
    role='admin'またはP-PROXY（T-05.proxy_user_id）またはP-SEATASSIGN（2026-09-09に一時的に
    P-CREATORへ変更していたが、2026-09-14にP-PROXYへ戻した。A-18のdocstring参照）。"""
    if not body.dates:
        raise HTTPException(400, detail="振り替える日付を1つ以上指定してください")

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
    if body.member_user_id not in member_user_ids_in_project:
        raise HTTPException(404, detail="対象が見つかりません")
    if body.member_user_id in seat_not_required_user_ids:
        raise HTTPException(400, detail="在宅勤務のため座席は不要に設定されています")

    seat = await pool.fetchrow("SELECT id, seat_no, seat_type, status FROM seats WHERE seat_no = $1", body.seat_no)
    if seat is None or seat["status"] != "active" or seat["seat_type"] != "free":
        raise HTTPException(400, detail="この座席番号は存在しないか、フリー座席として予約できません")

    results = await retry_excluded_dates(
        seat["id"], body.member_user_id, body.dates, user.id,
        enforce_rule05=(user.role != "admin"), check_project_block=True,
    )
    created = [r for r in results if r["status"] == "created"]
    excluded = [r for r in results if r["status"] == "excluded"]
    return {
        "seat_id": seat["id"], "seat_no": seat["seat_no"],
        "created_days": len(created), "excluded_days": len(excluded),
        "excluded_dates": [{"date": r["date"], "reason": r["reason"]} for r in excluded],
    }


class SeatChangeBody(BaseModel):
    seat_id: int | None = None


@router.put("/project-quarter-plans/{id}/seat-assignments/{member_user_id}")
async def change_member_seat(id: int, member_user_id: int, body: SeatChangeBody, user: CurrentUser = Depends(require_auth)):
    """A-64: 既に座席を確保済みのメンバーの座席を、同じ座席の島の範囲内で別の座席に変更する
    （2026-09-03追加。「メンバーへの座席確保なのですが変更できるようにしてほしい」との要望を受けた。
    従来は一度確保すると「割り当てる座席」欄が「—」表示になり、この画面からは変更できず、
    S-11等で個別に取消してからA-18で確保し直す必要があった）。旧座席の予約を（未来分のみ）取り消してから、
    A-18と同じロジックで新しい座席への周期予約を生成する。権限・状態チェックはA-18と同じ
    （role='admin'またはP-PROXY〔T-05.proxy_user_id〕またはP-SEATASSIGN。2026-09-09に一時的に
    P-CREATORへ変更していたが、2026-09-14にP-PROXYへ戻した）。

    変更先の座席が既に他のメンバーに割り当て済みの場合は、当初拒否していたが（初版）、座席の島が
    必要人数ちょうどで確保されている（＝空き座席がない）ケースが多く、「変更先を選択を押しても座席が
    表示されないため変更することができません」との報告を受け、2026-09-03当日中に交換（スワップ）方式に
    変更した。対象の2名の座席をまとめて入れ替える（双方の旧座席の予約を取り消してから、それぞれ相手の
    座席で確保し直す）。

    body.seat_id=nullは「在宅勤務にする」（2026-09-03同日追加。「変更先の選択に在宅勤務も追加してほしい」
    との要望を受けた。従来、確保済みメンバーを在宅勤務〔seat_not_required〕に切り替えるには、この画面の
    「在宅のため不要」チェックボックスが確保済みの間は非活性〔先に予約の取消が必要〕で、この画面からは
    完結できなかった）。旧座席の予約を（未来分のみ）取り消し、T-06.seat_not_requiredをtrueにする。
    新しい座席の確保は行わない。

    2026-09-24修正:「このプロジェクトは曜日によって座席の島が異なるため、メンバーの座席変更はまだ
    この画面から行えません」というブロックを撤去した。ただし本APIは「全確定曜日に共通の1つの座席」
    という前提のswap（交換）操作のため、A-18のように曜日ごとに異なる座席へ部分的に変更する機能は
    今回のスコープ外とし、代わりに変更先の座席が全確定曜日の実効座席（database.effective_seat_ids()）
    に共通して含まれていることを要求する（1日でも属さない曜日があれば拒否）。曜日ごとに異なる座席へ
    変更したい場合は、A-18（この内容で一括確保する）で該当メンバーを選び直すか、エリア担当にご相談
    いただく。"""
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

    weekdays_finalized = json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else []
    if not weekdays_finalized:
        raise HTTPException(400, detail="出社曜日が確定していません")
    effective_by_weekday = {
        w: set(effective_seat_ids(plan["allocated_seats"], plan["allocated_seats_overrides"], w))
        for w in weekdays_finalized
    }
    allocated_seat_ids = {sid for ids in effective_by_weekday.values() for sid in ids}
    if body.seat_id is not None and not all(body.seat_id in ids for ids in effective_by_weekday.values()):
        raise HTTPException(
            400,
            detail="この座席は確定曜日の一部でプロジェクトの座席の島に含まれていないため選べません。曜日ごとに異なる座席にしたい場合は「この内容で一括確保する」から選び直してください",
        )

    member = await pool.fetchrow(
        "SELECT id, user_id, seat_not_required FROM project_members WHERE project_id = $1 AND user_id = $2",
        plan["project_id"], member_user_id,
    )
    if member is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if member["seat_not_required"]:
        raise HTTPException(400, detail="在宅勤務のためプロジェクト座席は不要に設定されています")

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

    weekdays = weekdays_finalized
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
