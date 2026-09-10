# A-27〜A-29・A-79 プロジェクト・PM管理（S-08、A-79はS-04も使用）、A-38〜A-44・A-74 プロジェクト座席・
# エリア担当側（S-09）。詳細設計書3.8節・3.9節
import json
import re
from datetime import date as Date
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import ai_weekday
from auth_helpers import CurrentUser, require_auth, require_roles
from database import get_pool
from slack import (
    DEFAULT_MESSAGE_FINALIZE_HEADER,
    DEFAULT_MESSAGE_REMINDER,
    SLACK_MESSAGE_FINALIZE_HEADER_KEY,
    SLACK_MESSAGE_REMINDER_KEY,
    render_slack_message,
    send_slack_notification,
)

router = APIRouter(prefix="/api", tags=["project-seats"])

_WEEKDAY_JA = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金"}
_WEEKDAY_ISODOW = {"mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5}


async def _required_seats_for_project(conn, project_id: int) -> int:
    """プロジェクトメンバーのうち、固定座席保有者・在宅のため不要なメンバー（FR-03-10）を除いた人数を
    必要座席数として算出する（メンバーが1人もいない場合のみ1人扱い）。旧_ensure_next_quarter_plans()の
    起票時ロジックを、A-67（都度の期間設定）向けに1プロジェクト単位の関数として切り出した
    （2026-09-03、検討資料「プロジェクト座席・曜日調整フロー改善案」変更D参照）。"""
    row = await conn.fetchrow(
        """SELECT CASE WHEN COUNT(pm.id) = 0 THEN 1
                       ELSE COUNT(pm.id) FILTER (WHERE fsa.user_id IS NULL AND NOT pm.seat_not_required)
                  END AS required_seats
           FROM project_members pm
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = pm.user_id AND fsa.ended_on IS NULL
           WHERE pm.project_id = $1""",
        project_id,
    )
    return row["required_seats"]


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
async def list_projects(user: CurrentUser = Depends(require_auth)):
    """A-27: プロジェクト一覧。S-08「プロジェクト・PM管理」タブの一覧・編集モーダルのメンバー表、および
    S-04「プロジェクト座席」の編集・削除機能（2026-09-10追加）で使う。呼び出し時の次の四半期の
    計画データの自動作成（_ensure_next_quarter_plans）は、2026-09-03に「四半期」という概念自体を撤廃した
    ことに伴い廃止した（検討資料「プロジェクト座席・曜日調整フロー改善案」変更D。プロジェクト座席の期間は
    エリア責任者・管理部が都度A-67で設定する）。created_by・created_by_name（2026-09-09追加、千田さんの案）:
    プロジェクトの作成者（T-05.created_by）。アンケート回答（A-16）・席決め（A-18等）の実権限を持つ利用者
    であり、S-08編集モーダルで管理部が確認・是正できるようにするために追加した（PJ席決担当
    〔proxy_user_id〕は表示用として引き続き残る。両者は別概念になった点に注意）。
    2026-09-10変更: 「S-04でもS-08と同じ編集・削除機能が欲しい」との要望を受け、role='admin'専用
    だった認可をrequire_authに緩和し、role='admin'以外は自分が作成者（created_by）のプロジェクトのみに
    絞り込むようにした（P-CREATOR）。レスポンス形状は変更していない。"""
    pool = get_pool()

    where_clause = "" if user.role == "admin" else "WHERE p.created_by = $1"
    params = [] if user.role == "admin" else [user.id]
    rows = await pool.fetch(
        f"""SELECT p.id, p.name, p.proxy_user_id, p.created_by,
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
           {where_clause}
           GROUP BY p.id
           ORDER BY p.name""",
        *params,
    )
    items = []
    for r in rows:
        members = json.loads(r["members_json"])
        proxy_name = next((m["name"] for m in members if m["user_id"] == r["proxy_user_id"]), None)
        created_by_name = next((m["name"] for m in members if m["user_id"] == r["created_by"]), None)
        items.append({
            "id": r["id"], "name": r["name"], "pm_pl_names": r["pm_pl_names"] or "未設定",
            "member_count": r["member_count"], "members": members,
            "proxy_user_id": r["proxy_user_id"], "proxy_user_name": proxy_name,
            "created_by": r["created_by"], "created_by_name": created_by_name,
        })
    return {"items": items}


@router.get("/users/search")
async def search_users_for_project(q: str = "", user: CurrentUser = Depends(require_auth)):
    """A-79: プロジェクトメンバー追加用の軽量な利用者検索（2026-09-10新設）。「S-04でもS-08と同じ
    編集機能が欲しい」との要望を受けた。S-08編集モーダルのメンバー検索は従来A-25（GET /users、
    role='admin'専用、在籍状況・役割・エリア責任者区分等の管理系フィールドまで返す）を使っていたが、
    S-04は誰でもアクセスするため、A-25をそのまま一般公開せず、モーダルが実際に使うid・氏名・emailの
    みを返す最小権限の専用エンドポイントを新設した（A-25自体は変更せず、S-08は引き続きA-25を使う）。
    qが空なら空配列を返す（全件ダンプを避ける）。在籍中（deleted_at IS NULL）の利用者のみ、氏名・email
    の部分一致で最大20件返す。"""
    if not q:
        return {"items": []}
    rows = await get_pool().fetch(
        """SELECT id, last_name, first_name, email FROM users
           WHERE deleted_at IS NULL
             AND ((last_name || first_name) ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
           ORDER BY last_name, first_name LIMIT 20""",
        q,
    )
    return {"items": [{"id": r["id"], "last_name": r["last_name"], "first_name": r["first_name"], "email": r["email"]} for r in rows]}


class ProjectCreate(BaseModel):
    name: str


@router.post("/projects")
async def create_project(body: ProjectCreate, user: CurrentUser = Depends(require_roles("admin"))):
    """A-28: プロジェクトの新規作成（S-08プロジェクト・PM管理タブ）。同名プロジェクトの重複チェックは
    行わない（要件定義書に禁止規定なし、4.6節）。created_by（作成者）は呼び出した管理部自身を設定する
    （2026-09-09追加。千田さんの案によるワークフロー変更でcreated_byがアンケート回答・席決めの実権限を
    持つようになったため。管理部が本来の担当者の代わりに作成した場合は、この画面のPUT /projects/{id}/
    membersで後から作成者を変更できる〔A-29参照〕）。project_membersの自動追加は行わない（従来通り、
    メンバーは後からA-29で設定する）。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="プロジェクト名を入力してください")
    row = await get_pool().fetchrow(
        "INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id", name, user.id
    )
    return {"id": row["id"], "detail": "プロジェクトを追加しました"}


class ProjectMemberItem(BaseModel):
    user_id: int
    project_title: Literal["PM", "PL", "SL"] | None = None


class ProjectMembersUpdate(BaseModel):
    name: str
    members: list[ProjectMemberItem]
    proxy_user_id: int | None = None
    # 作成者（T-05.created_by、2026-09-09追加、千田さんの案）。アンケート回答・席決めの実権限を持つ
    # 利用者を管理部が確認・是正できるようにする。proxy_user_idと異なりPM/PL限定ではなく、
    # membersに含まれるいずれかの利用者であればよい（作成者概念はPM/PL体制より広いため）。
    created_by: int | None = None


@router.put("/projects/{id}/members")
async def update_project_members(id: int, body: ProjectMembersUpdate, user: CurrentUser = Depends(require_auth)):
    """A-29: メンバー構成・PM/PL/SL・PJ席決担当・作成者をまとめて更新する。bodyに含まれないuser_idの
    既存メンバーは削除、新規はcan_assign_seats=falseで追加、既存は所属継続のままproject_titleのみ更新する
    （UPSERT。2026-08-28追加。can_assign_seats・seat_assign_granted_byはbodyの対象外のため既存メンバーの
    値を保持する）。メンバー削除に伴う既存のプロジェクト座席予約（A-18生成分）・アンケート回答（T-11）の
    連鎖処理は行わない（要件定義書・基本設計書のいずれにも規定がないため、本フェーズのスコープ外とする）。
    <code>name</code>もあわせて更新する（2026-08-28追加。画面モックアップの編集モーダルがプロジェクト名・
    メンバーを1つのフォームとして一括保存する設計のため、名称変更用に別APIを新設せずA-29に統合した）。
    <code>created_by</code>（2026-09-09追加）: 指定された場合、bodyのmembersに含まれるuser_idの
    いずれかでなければ400（PM/PL限定ではない）。バックフィル漏れの是正や、管理部が本来の担当者の
    代わりにA-28でプロジェクトを作成した場合の引き継ぎに使う。
    2026-09-10変更: 「S-04でもS-08と同じ編集機能が欲しい」との要望を受け、role='admin'専用だった認可を
    require_authに緩和し、role='admin'以外は対象プロジェクトの作成者（created_by＝自分）のみ許可する
    ようにした（P-CREATOR）。作成者は自分の判断で作成者自身を含むメンバー構成・役割・PJ席決担当・
    作成者〔他メンバーへの譲渡を含む〕を変更でき、管理部と全く同じ操作範囲を持つ。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="プロジェクト名を入力してください")
    if len(body.members) != len({m.user_id for m in body.members}):
        raise HTTPException(400, detail="同じ利用者が複数の行に指定されています")

    pool = get_pool()
    project = await pool.fetchrow("SELECT id, created_by FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin" and project["created_by"] != user.id:
        raise HTTPException(403, detail="この操作を行う権限がありません")

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

    if body.created_by is not None and body.created_by not in user_ids:
        raise HTTPException(400, detail="作成者にはメンバーのいずれかを指定してください")

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
                "UPDATE projects SET name = $1, proxy_user_id = $2, created_by = $3, updated_at = now() WHERE id = $4",
                name, body.proxy_user_id, body.created_by, id,
            )
    return {"detail": "プロジェクトを更新しました"}


@router.delete("/projects/{id}")
async def delete_project(id: int, user: CurrentUser = Depends(require_auth)):
    """A-55: プロジェクトの削除（S-08プロジェクト・PM管理タブ、2026-08-28追加）。project_membersと
    project_quarter_plans（FK経由でproject_weekday_responsesも連動）はプロジェクト自体が消える以上
    存在意義を失うため、本APIの一部としてあわせて削除する（A-29のメンバー削除とは異なり、削除対象を
    選べる余地がないためスコープ外にはできない）。座席の島の割当（allocated_seats）は削除される
    project_quarter_plans行の一部にすぎず、project_blocked_seats()はJOIN projectsで判定するため
    削除後は自動的にプロジェクト専有として扱われなくなる。一方、メンバーが個別に確保済みの座席予約
    （A-18生成分のreservations・recurring_rules）はproject_idを持たない独立したデータのため削除せず
    残す（本人が実際にその座席を使っている実態を、プロジェクトという管理上の入れ物の削除で消さない）。
    2026-09-10変更: 「S-04でもS-08と同じ削除機能が欲しい」との要望を受け、role='admin'専用だった認可を
    require_authに緩和し、role='admin'以外は対象プロジェクトの作成者（created_by＝自分）のみ許可する
    ようにした（P-CREATOR）。削除の挙動自体は変更していない。"""
    pool = get_pool()
    project = await pool.fetchrow("SELECT id, name, created_by FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin" and project["created_by"] != user.id:
        raise HTTPException(403, detail="この操作を行う権限がありません")

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
    _: CurrentUser = Depends(require_roles("admin")),
):
    """A-38: プロジェクト座席の計画データ一覧。2026-09-03、「四半期」という概念自体を撤廃したことに伴い
    quarterクエリパラメータ（period_startでの絞り込み）を廃止し、常に全件を返すよう変更した
    （検討資料「プロジェクト座席・曜日調整フロー改善案」変更D。S-09の対象四半期タブも廃止し、
    period_start降順の1本のリストに一本化した）。areaクエリパラメータは2026-08-27にT-07から
    area_id自体が削除されたため対象外とした（2026-08-28、ドキュメントの記載漏れを整理）。呼び出し時の
    次の四半期の計画データの自動作成（旧FR-03-1）も、変更Dで廃止した（プロジェクト座席の期間は
    エリア責任者・管理部がA-67で都度設定する）。non_fixed_member_countは、固定座席保有者に加えて
    seat_not_requiredなメンバー（FR-03-10）も除いた「実際にプロジェクト座席を必要とするメンバー数」を
    表す（2026-09-01訂正。固定座席保有者と同じ扱いに揃えてほしいとの要望を受けた。フィールド名は変更せず
    互換のまま意味だけ拡張している）。各行のseat_assigner_namesはPJ席決担当（T-05.proxy_user_id、S-08
    「プロジェクト・PM管理」タブの「PJ席決担当」列で指定）の氏名（2026-09-02再訂正。当初は
    T-06.can_assign_seats〔S-04の「席決めを任せる」で個別に委譲する別の権限〕から求めていたが、
    「S-08の担当者のS-09の席決め担当に落とし込みたい」との指摘を受け、S-08の一覧・編集モーダルの
    「PJ席決担当」列（A-27のproxy_user_nameと同じ、projects.proxy_user_id）から求めるよう修正した。
    A-27と同じくPM・PLのいずれか1名に限定される想定だが、未指定の間は空になりうる）。
    previous_area（'NORTH'|'EAST'|'WEST'|null）は、直近に座席の島を割り当てた四半期（status=
    'seats_allocated'、対象四半期の絞り込みに関わらず全期間から探す）で実際に使ったエリアを返す
    （2026-09-03追加、S-09の曜日調整表をエリアで分けたいとの要望を受けた。T-07にarea_id自体は
    存在しないため、割当済みの座席〔allocated_seats〕から逆引きする。一度も座席の島を割り当てて
    いないプロジェクトはnull）。area_seat_capacity（{NORTH, EAST_WEST}の各エリアの有効座席数、
    座席タイプを問わない）は、出社曜日の調整表の「曜日ごとの合計」が物理座席数を超えていないか
    その場で判定できるようにするため2026-09-09追加。座席総数を毎回手で数える代わりに、必要数が
    超過した曜日をUI側で警告表示する（3.9節参照）。has_previous_plan（2026-09-10追加）は、
    同一プロジェクトにこの計画より前の期間の計画が存在するかどうかを返す。出社曜日の調整表の
    「前回の確定曜日をコピーする」ボタン（A-15を呼ぶ）の表示条件に使う。"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT pqp.id, pqp.project_id, p.name AS project_name, pqp.period_start, pqp.period_end,
                  pqp.required_seats, pqp.weekdays_finalized, pqp.allocated_seats, pqp.status,
                  (SELECT pu.last_name || ' ' || pu.first_name FROM users pu WHERE pu.id = p.proxy_user_id)
                      AS seat_assigner_names,
                  COUNT(DISTINCT pm.id) FILTER (WHERE fsa.user_id IS NULL AND NOT pm.seat_not_required) AS non_fixed_member_count,
                  wr.choice1_weekdays, wr.choice2_weekdays, wr.note,
                  (wr.id IS NOT NULL) AS has_response,
                  EXISTS(
                      SELECT 1 FROM project_quarter_plans pqp2
                      WHERE pqp2.project_id = pqp.project_id AND pqp2.period_start < pqp.period_start
                  ) AS has_previous_plan
           FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id
           LEFT JOIN project_members pm ON pm.project_id = pqp.project_id
           LEFT JOIN users u ON u.id = pm.user_id
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = pm.user_id AND fsa.ended_on IS NULL
           LEFT JOIN project_weekday_responses wr ON wr.plan_id = pqp.id
           GROUP BY pqp.id, p.name, p.proxy_user_id, wr.choice1_weekdays, wr.choice2_weekdays, wr.note, wr.id
           ORDER BY pqp.period_start DESC, p.name"""
    )

    seat_ids = {sid for r in rows if r["allocated_seats"] for sid in json.loads(r["allocated_seats"])}
    seat_no_by_id = {}
    if seat_ids:
        seat_rows = await pool.fetch(
            "SELECT id, seat_no FROM seats WHERE id = ANY($1::bigint[])", list(seat_ids)
        )
        seat_no_by_id = {r["id"]: r["seat_no"] for r in seat_rows}

    # 曜日調整表のNORTH／EAST・WEST分け（2026-09-03追加。「曜日表をNORTHエリア/EAST＆WESTに分けることは
    # できるか」との要望を受けた）。T-07は2026-08-27にarea_idを削除済みで、曜日調整の段階（座席の島の
    # 割当前）ではプロジェクトごとのエリア情報が存在しないため、直近に座席の島を割り当てた（status=
    # 'seats_allocated'）四半期で実際に使ったエリアを「前回の割当エリア」として代用する、との回答による。
    # 対象四半期の絞り込みに関わらず全期間から探すため、rowsではなくproject_quarter_plansを直接見る。
    area_rows = await pool.fetch(
        """SELECT DISTINCT ON (pqp.project_id) pqp.project_id, a.name AS area_name
           FROM project_quarter_plans pqp
           CROSS JOIN LATERAL jsonb_array_elements_text(pqp.allocated_seats::jsonb) AS elem(seat_id_text)
           JOIN seats s ON s.id = elem.seat_id_text::bigint
           JOIN areas a ON a.id = s.area_id
           WHERE pqp.status = 'seats_allocated' AND pqp.allocated_seats IS NOT NULL
           ORDER BY pqp.project_id, pqp.period_start DESC"""
    )
    previous_area_by_project = {r["project_id"]: r["area_name"] for r in area_rows}

    items = []
    for r in rows:
        allocated_seat_ids = json.loads(r["allocated_seats"]) if r["allocated_seats"] else None
        allocated_label = (
            _format_seat_range([seat_no_by_id[sid] for sid in allocated_seat_ids if sid in seat_no_by_id])
            if allocated_seat_ids else None
        )
        items.append({
            "id": r["id"], "project_id": r["project_id"], "project_name": r["project_name"],
            "seat_assigner_names": r["seat_assigner_names"] or "未設定",
            "period_start": r["period_start"].isoformat(), "period_end": r["period_end"].isoformat(),
            "required_seats": r["required_seats"], "status": r["status"],
            "non_fixed_member_count": r["non_fixed_member_count"],
            "weekdays_finalized": json.loads(r["weekdays_finalized"]) if r["weekdays_finalized"] else None,
            "allocated_seat_ids": allocated_seat_ids, "allocated_seat_label": allocated_label,
            "has_response": r["has_response"],
            "choice1_weekdays": json.loads(r["choice1_weekdays"]) if r["choice1_weekdays"] else None,
            "choice2_weekdays": json.loads(r["choice2_weekdays"]) if r["choice2_weekdays"] else None,
            "note": r["note"],
            "previous_area": previous_area_by_project.get(r["project_id"]),
            "has_previous_plan": r["has_previous_plan"],
        })

    # 期間未設定のプロジェクト（今日以降に及ぶ計画データを1件も持たないプロジェクト）を別枠で返す
    # （2026-09-03追加、変更D。「四半期」の自動起票がなくなったため、S-09側でエリア責任者が
    # 「まだ期間を設定していないプロジェクト」に気づけるようにする必要がある）。
    unplanned_rows = await pool.fetch(
        """SELECT p.id, p.name
           FROM projects p
           WHERE NOT EXISTS (
               SELECT 1 FROM project_quarter_plans pqp
               WHERE pqp.project_id = p.id AND pqp.period_end >= CURRENT_DATE
           )
           ORDER BY p.name"""
    )
    unplanned_projects = [{"id": r["id"], "name": r["name"]} for r in unplanned_rows]

    # 曜日調整表のNORTH／EAST・WEST分け（前述）と揃えたエリア別の有効座席数。座席タイプ（フリー／固定／
    # プロジェクト）を問わず、そのエリアに物理的に存在する座席数を数える（2026-09-09追加）。
    capacity_rows = await pool.fetch(
        """SELECT a.name AS area_name, COUNT(*) AS cnt FROM seats s
           JOIN areas a ON a.id = s.area_id
           WHERE s.status = 'active'
           GROUP BY a.name"""
    )
    capacity_by_area = {r["area_name"]: r["cnt"] for r in capacity_rows}
    area_seat_capacity = {
        "NORTH": capacity_by_area.get("NORTH", 0),
        "EAST_WEST": capacity_by_area.get("EAST", 0) + capacity_by_area.get("WEST", 0),
    }

    return {"items": items, "unplanned_projects": unplanned_projects, "area_seat_capacity": area_seat_capacity}


class QuarterPlanCreate(BaseModel):
    period_start: Date
    period_end: Date


@router.post("/projects/{id}/quarter-plans")
async def create_quarter_plan(id: int, body: QuarterPlanCreate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-67: プロジェクトの座席期間を都度設定する（FR-03-1、2026-09-03新設）。「四半期という概念を撤廃して
    都度期間を設定するようにしましょう。プロジェクト席を決めるときはまず期間を設定した後、アンケートが
    自動で送られるようにしましょう」との要望を受けた（検討資料「プロジェクト座席・曜日調整フロー改善案」
    変更D）。従来のシステムによる四半期ごとの自動起票（_ensure_next_quarter_plans、FR-03-1の旧仕様）を
    廃止し、エリア責任者・管理部が対象プロジェクトごとに本APIで任意の開始日・終了日を明示的に設定する
    方式に一本化した。新規作成した計画データはA-65・A-66と同様に直接status='survey_open'で作成し、
    出社曜日アンケートを即座に回答可能にする（変更Bの方針を踏襲）。required_seatsは、旧
    _ensure_next_quarter_plans()と同じロジック（固定座席保有者・在宅のため不要なメンバーを除いた人数、
    メンバーが1人もいなければ1人扱い）で自動算出する。Body: {period_start, period_end}（YYYY-MM-DD）。
    period_end < period_startは400。同じproject_idの他の計画と期間が重なる場合は400。
    UNIQUE (project_id, period_start)制約に抵触する場合（同じ開始日の計画が既に存在する場合）は409。"""
    if body.period_end < body.period_start:
        raise HTTPException(400, detail="終了日は開始日以降を指定してください")
    pool = get_pool()
    project = await pool.fetchrow("SELECT id FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")

    overlap = await pool.fetchval(
        """SELECT 1 FROM project_quarter_plans
           WHERE project_id = $1 AND period_start <= $3 AND period_end >= $2""",
        id, body.period_start, body.period_end,
    )
    if overlap:
        raise HTTPException(400, detail="指定した期間が、このプロジェクトの他の計画期間と重なっています")

    async with pool.acquire() as conn:
        async with conn.transaction():
            required_seats = await _required_seats_for_project(conn, id)
            try:
                row = await conn.fetchrow(
                    """INSERT INTO project_quarter_plans
                           (project_id, period_start, period_end, required_seats, status)
                       VALUES ($1, $2, $3, $4, 'survey_open')
                       RETURNING id""",
                    id, body.period_start, body.period_end, required_seats,
                )
            except asyncpg.UniqueViolationError:
                raise HTTPException(409, detail="同じ開始日の計画が既に存在します")
    return {"id": row["id"], "detail": "座席期間を設定しました"}


class QuarterPlanBulkCreate(BaseModel):
    project_ids: list[int]
    period_start: Date
    period_end: Date


@router.post("/project-quarter-plans/bulk-create")
async def create_quarter_plans_bulk(body: QuarterPlanBulkCreate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-68: 複数のプロジェクトへ同じ座席期間（開始日・終了日）をまとめて新規設定する（FR-03-1、
    2026-09-03新設）。「変更Aの期間は全プロジェクトに完全に自由〔任意の開始日・終了日〕、全プロジェクトが
    同じ期間を共有するようにしたい」との要望を受けた（検討資料「プロジェクト座席・曜日調整フロー改善案」
    変更D再訂正）。A-67（単一プロジェクトへの新規設定）だけでは「全プロジェクトが同じ期間を共有する」
    運用を都度手作業で繰り返すことになるため、通常はS-09の「期間未設定のプロジェクトへ座席期間を
    一括設定する」から本APIを使い、期間未設定の全プロジェクトへ同じ期間をまとめて設定する想定。
    A-66（period-bulk、既存計画の一括修正）と対になる新規作成版で、同じトランザクション方針
    （1件でも期間の重なりがあれば全体を失敗させ、どのプロジェクトも作成しない）を踏襲する。
    Body: {project_ids: [...], period_start, period_end}。required_seatsはA-67と同じロジックで
    プロジェクトごとに自動算出する。作成した計画データは直接status='survey_open'で作成する。"""
    if not body.project_ids:
        raise HTTPException(400, detail="期間を設定するプロジェクトを1つ以上選択してください")
    if body.period_end < body.period_start:
        raise HTTPException(400, detail="終了日は開始日以降を指定してください")
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for project_id in body.project_ids:
                project = await conn.fetchrow("SELECT id, name FROM projects WHERE id = $1", project_id)
                if project is None:
                    raise HTTPException(404, detail="対象が見つかりません")
                overlap = await conn.fetchval(
                    """SELECT 1 FROM project_quarter_plans
                       WHERE project_id = $1 AND period_start <= $3 AND period_end >= $2""",
                    project_id, body.period_start, body.period_end,
                )
                if overlap:
                    raise HTTPException(400, detail=f"「{project['name']}」は、指定した期間が他の計画期間と重なっています")
                required_seats = await _required_seats_for_project(conn, project_id)
                try:
                    await conn.execute(
                        """INSERT INTO project_quarter_plans
                               (project_id, period_start, period_end, required_seats, status)
                           VALUES ($1, $2, $3, $4, 'survey_open')""",
                        project_id, body.period_start, body.period_end, required_seats,
                    )
                except asyncpg.UniqueViolationError:
                    raise HTTPException(409, detail=f"「{project['name']}」は、同じ開始日の計画が既に存在します")
    return {"detail": "座席期間を設定しました"}


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


class PeriodUpdate(BaseModel):
    period_start: Date
    period_end: Date


@router.put("/project-quarter-plans/{id}/period")
async def update_period(id: int, body: PeriodUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-65: 座席期間（開始日・終了日）の例外的な上書き（FR-03-1、2026-09-03追加）。「座席期間を
    エリア責任者が指定〔2か月間のプロジェクト席など〕できるようにしたい」との要望を受けた
    （検討資料「プロジェクト座席・曜日調整フロー改善案」変更A）。当初は四半期単位の自動起票
    （_ensure_next_quarter_plans）を残したまま必要なプロジェクトのみ上書きする位置づけだったが、
    同日中の変更Dで自動起票自体を廃止し、都度A-67で新規作成した計画データの期間を後から修正する
    用途に変わった。status IN ('seats_confirmed', 'survey_open')（座席の島の割当前）の間
    変更でき、weekdays_finalized以降は対象外とする（同日中の変更Bで、起票と同時にstatus=
    'survey_open'になるよう変更したため、実質的にsurvey_openの間ずっと変更できることになる。
    必要座席数〔A-40〕がいつでも変更できるのと同じ考え方に揃えた）。"""
    if body.period_end < body.period_start:
        raise HTTPException(400, detail="終了日は開始日以降を指定してください")
    pool = get_pool()
    plan = await pool.fetchrow(
        "SELECT id, project_id, status FROM project_quarter_plans WHERE id = $1", id
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] not in ("seats_confirmed", "survey_open"):
        raise HTTPException(400, detail="座席の島の割当前（曜日確定前）のみ座席期間を変更できます")

    overlap = await pool.fetchval(
        """SELECT 1 FROM project_quarter_plans
           WHERE project_id = $1 AND id != $2
             AND period_start <= $4 AND period_end >= $3""",
        plan["project_id"], id, body.period_start, body.period_end,
    )
    if overlap:
        raise HTTPException(400, detail="指定した期間が、同じプロジェクトの他の計画期間と重なっています")

    try:
        await pool.execute(
            "UPDATE project_quarter_plans SET period_start = $1, period_end = $2, updated_at = now() WHERE id = $3",
            body.period_start, body.period_end, id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, detail="同じ開始日の計画が既に存在します")
    return {"detail": "座席期間を更新しました"}


class PeriodBulkUpdate(BaseModel):
    plan_ids: list[int]
    period_start: Date
    period_end: Date


@router.put("/project-quarter-plans/period-bulk")
async def update_period_bulk(body: PeriodBulkUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-66: 指定した複数の計画へ同じ座席期間（開始日・終了日）をまとめて上書きする（FR-03-1、
    2026-09-03追加）。「一括でプロジェクトの期間を決めれるようにしたい」との要望を受けた。かつては
    A-63（survey-bulk、廃止）と同じ考え方だった。1件でも対象外（status NOT IN ('seats_confirmed',
    'survey_open')）や他の計画期間との重なりがあれば全体を失敗させ、どのプロジェクトも更新しない
    （部分成功による中途半端な状態を避けるため）。単一の計画に対する上書き（A-65）と条件は同じ。"""
    if not body.plan_ids:
        raise HTTPException(400, detail="期間を設定するプロジェクトを1つ以上選択してください")
    if body.period_end < body.period_start:
        raise HTTPException(400, detail="終了日は開始日以降を指定してください")
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for plan_id in body.plan_ids:
                plan = await conn.fetchrow(
                    """SELECT pqp.id, pqp.project_id, pqp.status, p.name AS project_name
                       FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
                       WHERE pqp.id = $1""",
                    plan_id,
                )
                if plan is None:
                    raise HTTPException(404, detail="対象が見つかりません")
                if plan["status"] not in ("seats_confirmed", "survey_open"):
                    raise HTTPException(400, detail=f"「{plan['project_name']}」は座席の島の割当前（曜日確定前）ではないため、座席期間を変更できません")
                overlap = await conn.fetchval(
                    """SELECT 1 FROM project_quarter_plans
                       WHERE project_id = $1 AND id != $2
                         AND period_start <= $4 AND period_end >= $3""",
                    plan["project_id"], plan_id, body.period_start, body.period_end,
                )
                if overlap:
                    raise HTTPException(400, detail=f"「{plan['project_name']}」は、指定した期間が他の計画期間と重なっています")
                try:
                    await conn.execute(
                        "UPDATE project_quarter_plans SET period_start = $1, period_end = $2, updated_at = now() WHERE id = $3",
                        body.period_start, body.period_end, plan_id,
                    )
                except asyncpg.UniqueViolationError:
                    raise HTTPException(409, detail=f"「{plan['project_name']}」は、同じ開始日の計画が既に存在します")
    return {"detail": "座席期間を更新しました"}


@router.post("/project-quarter-plans/{id}/survey-reminder")
async def send_survey_reminder(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-42: 未回答のプロジェクトへのリマインドを手動送信（FR-03-9②）。A-41と同様、Slack通知を送信する
    （2026-08-28実装）。通知文言は通知設定タブ（S-08）で編集でき、{project_name}を埋め込める
    （2026-09-02追加）。"""
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
    message = await render_slack_message(
        SLACK_MESSAGE_REMINDER_KEY, DEFAULT_MESSAGE_REMINDER, project_name=plan["project_name"],
    )
    await send_slack_notification(message)
    return {"detail": "リマインドを送信しました"}


class WeekdayAiSuggestPlan(BaseModel):
    plan_id: int
    project_name: str
    choice1_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]] | None = None
    choice2_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]] | None = None
    note: str | None = None


class WeekdayAiSuggestBody(BaseModel):
    plans: list[WeekdayAiSuggestPlan]
    weekday_capacity: dict[Literal["mon", "tue", "wed", "thu", "fri"], int]


@router.post("/project-quarter-plans/weekday-ai-suggestions")
async def suggest_weekdays_ai(body: WeekdayAiSuggestBody, _: CurrentUser = Depends(require_roles("admin"))):
    """A-74: 出社曜日の調整表（WeekdayMatrix、S-09）の仮案を生成AI（LLM）に生成させる（FR-03-11、
    2026-09-08追加。検討資料「プロジェクト座席・曜日調整フロー改善案」変更C）。DBへの書き込みは
    行わない（提案のみ）。WeekdayMatrixはNORTH／EAST・WEST（統合）／前回の割当エリアなしの3グループに
    分かれて表示されるため、フロントエンドはグループ単位で本APIを呼ぶ（1回の呼び出し＝1グループ分）。
    plansの各フィールドはA-38のレスポンスをフロントエンドがそのまま渡す（バックエンド側でDBを
    読み直さない）。weekday_capacityは「曜日ごとの合計」（v2.32・v2.33実装済み、固定座席の人数＋
    各プロジェクトのrequired_seatsの合計）と同じ値をそのグループ分だけフロントエンドが算出して渡す。
    実際のLLM呼び出しはai_weekday.suggest_weekdays()に委譲する（OpenAI Chat Completions APIを
    httpxで直接呼ぶ、専用SDKは追加していない）。呼び出しに失敗した場合は502を返し、フロントエンドは
    対象グループのマトリクス表を変更しない（検討資料3.3節「失敗時」の方針）。missing_plan_ids
    （2026-09-09追加）: 依頼したplan_idのうちAIの応答に含まれていなかったもの。フロントエンドは
    このplan_idに該当する行について「AI提案なし」である旨を利用者に示す。"""
    if not body.plans:
        raise HTTPException(400, detail="対象のプロジェクトを1件以上指定してください")
    try:
        result = await ai_weekday.suggest_weekdays(
            [p.model_dump() for p in body.plans], dict(body.weekday_capacity),
        )
    except ai_weekday.WeekdayAiSuggestionError as e:
        raise HTTPException(502, detail="AI提案の生成に失敗しました。しばらくしてから再度お試しください") from e
    return result


class WeekdayFinalizeItem(BaseModel):
    plan_id: int
    weekdays_finalized: list[Literal["mon", "tue", "wed", "thu", "fri"]]


class WeekdayFinalizeBody(BaseModel):
    plans: list[WeekdayFinalizeItem]


@router.put("/project-quarter-plans/finalize-weekdays")
async def finalize_weekdays(body: WeekdayFinalizeBody, user: CurrentUser = Depends(require_roles("admin"))):
    """A-43: 指定した複数の計画の出社曜日を一括確定（FR-03-5）。status→'weekdays_finalized'。対象プロジェクト
    ごとの確定結果をまとめてSlack通知する（FR-03-9③、2026-08-28実装）。status='weekdays_finalized'（確定済み）
    の計画を含めてもよく、その場合は確定内容の上書きとして扱う（2026-09-02訂正。「確定した出社曜日をミスして
    確定押してしまったときの変更ボタンが欲しい」との要望を受けた。当初は一度確定した計画をアンケート回答受付中
    に戻してから全プロジェクト共通の調整表で再確定させる方式〔A-61〕だったが、「表から丸ごと取り消しではなく
    変更にしてほしい」との指摘を受け、対象プロジェクトを個別に直接上書きできるこの方式に改めた。A-61は廃止し、
    本APIに統合した）。status='seats_allocated'（座席の島の割当後）の計画も含められる（2026-09-08追加。
    「曜日変更はいつでもできるようにしてほしい。座席が割り当てている状態でも」との要望を受けた）。曜日が
    実際に変化した場合のみstatus→'weekdays_finalized'に戻る（変化していなければstatus='seats_allocated'
    のまま何もしない。詳細は下記の説明を参照）ため、座席の島の割当（A-44）からのやり直しが必要になる。既存の
    allocated_seatsはクリアしない（PJ席決担当がS-02の座席の島の割当画面を開いたとき、以前選んでいた
    座席が初期選択状態のまま表示され、変更が不要ならそのまま再確定できるようにするため）。座席の島の
    割当・メンバーへの個別の座席確保（A-18生成分）自体は、この時点では取り消さない。A-44を再度呼び出した
    時点で、その既存のA-44自身の重複排除ロジック（旧・新いずれの割当座席についてもその期間中の通常予約を
    取り消す）により整理される。確定自体を取り消してアンケート回答受付中に戻す操作は、本APIではなく
    別途のunfinalize_weekdays（A-62、こちらはstatus='seats_allocated'は引き続き対象外）で行う。通知の
    先頭行（見出し）は通知設定タブ（S-08）で編集できる（2026-09-02追加）。プロジェクトごとの結果一覧
    （「・「プロジェクト名」: 曜日」の行）は編集対象外の固定フォーマットとする。
    status='seats_allocated'の計画は、送信された曜日が確定済みの曜日から実際に変化している場合のみ
    'weekdays_finalized'へ差し戻す。フロント（S-09の「確定した出社曜日」表）は表内の全行をまとめて
    一括送信する作りのため、この判定をしないと曜日を編集していない他の座席割当済みプロジェクトまで
    巻き込んで座席の島の割当が巻き戻ってしまう不具合があった（2026-09-08修正）。"""
    pool = get_pool()
    notified_lines = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            for item in body.plans:
                plan = await conn.fetchrow(
                    """SELECT pqp.id, pqp.status, pqp.weekdays_finalized, p.name AS project_name
                       FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
                       WHERE pqp.id = $1""",
                    item.plan_id,
                )
                if plan is None:
                    raise HTTPException(404, detail="対象が見つかりません")
                if plan["status"] not in ("survey_open", "weekdays_finalized", "seats_allocated"):
                    raise HTTPException(400, detail="この状態では曜日を確定できません")
                current_weekdays = json.loads(plan["weekdays_finalized"]) if plan["weekdays_finalized"] else []
                unchanged = set(current_weekdays) == set(item.weekdays_finalized)
                if plan["status"] == "seats_allocated" and unchanged:
                    continue
                await conn.execute(
                    """UPDATE project_quarter_plans
                       SET weekdays_finalized = $1, status = 'weekdays_finalized', decided_by = $2, updated_at = now()
                       WHERE id = $3""",
                    json.dumps(item.weekdays_finalized), user.id, item.plan_id,
                )
                weekday_label = "・".join(_WEEKDAY_JA[w] for w in item.weekdays_finalized) or "なし"
                notified_lines.append(f"・「{plan['project_name']}」: {weekday_label}")
    header = await render_slack_message(SLACK_MESSAGE_FINALIZE_HEADER_KEY, DEFAULT_MESSAGE_FINALIZE_HEADER)
    await send_slack_notification(header + "\n" + "\n".join(notified_lines))
    return {"detail": "出社曜日を確定しました"}


@router.put("/project-quarter-plans/{id}/unfinalize-weekdays")
async def unfinalize_weekdays(id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-62: 出社曜日の確定を取り消し、status→'survey_open'に戻す（2026-09-02追加。「取り消しボタンも作成する
    ようにしてほしい」との要望を受け、A-61〔廃止〕と同じ内容で再新設。配置場所は「確定した出社曜日」表の各行
    〔S-09〕とする）。status='weekdays_finalized'からのみ呼び出せる（それ以外は400）。座席の島の割当（A-44）後の
    status='seats_allocated'は対象外（そちらは既存の「座席を編集」で対応する別の操作のため）。weekdays_finalized
    の値はクリアせず残し、出社曜日の調整表（WeekdayMatrix）に再表示される際、直前の確定内容をチェック状態の
    初期値として使う。"""
    pool = get_pool()
    plan = await pool.fetchrow(
        """SELECT pqp.id, pqp.status, p.name AS project_name
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.id = $1""",
        id,
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] != "weekdays_finalized":
        raise HTTPException(400, detail="この状態では確定を取り消せません")
    await pool.execute(
        "UPDATE project_quarter_plans SET status = 'survey_open', updated_at = now() WHERE id = $1", id
    )
    return {"detail": "出社曜日の確定を取り消しました"}


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
    再度確保し直す想定である。プロジェクトの現在のメンバーが全員固定座席（T-04）を保有している、
    またはずっと在宅勤務でプロジェクト座席が不要（T-06.seat_not_required、FR-03-10）である
    場合は、座席の島自体を割り当てられない（2026-08-31追加・2026-09-01訂正。「固定席の人はプロジェクト席を
    作成できないようにしてほしい」「在宅の人も固定座席保有者と同じように必要座席数から除外してほしい」
    との要望を受けた。required_seatsは計画の起票時点のスナップショット
    のため、起票後にメンバー構成・固定座席の状況が変わっても遡って更新されない〔2.9節T-07参照〕。
    このため、required_seatsが古い値のまま残っている計画に対しては、この時点の実際のメンバー構成を
    都度再確認しないと、誰も使えない座席の島を作成できてしまう不具合があった）。"""
    if not body.seat_ids:
        raise HTTPException(400, detail="座席を1つ以上選択してください")
    pool = get_pool()
    plan = await pool.fetchrow(
        "SELECT id, project_id, status, period_start, period_end, allocated_seats, weekdays_finalized "
        "FROM project_quarter_plans WHERE id = $1", id
    )
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if plan["status"] not in ("weekdays_finalized", "seats_allocated"):
        raise HTTPException(400, detail="出社曜日の確定後でなければ座席の島を割り当てられません")

    non_fixed_member_count = await pool.fetchval(
        """SELECT COUNT(*) FROM project_members pm
           WHERE pm.project_id = $1
             AND NOT pm.seat_not_required
             AND NOT EXISTS (SELECT 1 FROM fixed_seat_assignments fsa WHERE fsa.user_id = pm.user_id AND fsa.ended_on IS NULL)""",
        plan["project_id"],
    )
    if non_fixed_member_count == 0:
        raise HTTPException(400, detail="このプロジェクトのメンバーは全員固定座席保有者または在宅のため不要のいずれかであり、プロジェクト座席は不要です")

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
        """SELECT allocated_seats, weekdays_finalized FROM project_quarter_plans
           WHERE status = 'seats_allocated' AND id != $1
             AND period_start <= $2 AND period_end >= $3""",
        id, plan["period_end"], plan["period_start"],
    )
    # 四半期の期間が重なっていても、確定した出社曜日が1日も重ならない他プロジェクトとは
    # 同じ座席を共有できる（2026-09-02追加。「10/1が初日のプロジェクト座席でフロアマップを見ると
    # 未確定で埋まっている」の調査に伴う関連修正。座席の専有はdatabase.project_blocked_seats()と
    # 同じく曜日単位で判定するのが実態のため、割当時の重複チェックも期間だけでなく曜日の重なりを
    # 見るようにした。例: 火・水出社のプロジェクトと木・金出社のプロジェクトは同じ座席を割り当てられる）
    my_weekdays = set(json.loads(plan["weekdays_finalized"])) if plan["weekdays_finalized"] else set()
    already_allocated: set[int] = set()
    for r in other_plans:
        other_weekdays = set(json.loads(r["weekdays_finalized"])) if r["weekdays_finalized"] else set()
        if not (my_weekdays & other_weekdays):
            continue
        if r["allocated_seats"]:
            already_allocated |= set(json.loads(r["allocated_seats"]))
    if already_allocated & set(body.seat_ids):
        raise HTTPException(409, detail="既に他プロジェクトへ割り当てられている座席が含まれています")

    old_seat_ids = json.loads(plan["allocated_seats"]) if plan["allocated_seats"] else []
    cancel_target_ids = list(set(old_seat_ids) | set(body.seat_ids))
    # 取り消す予約は、このプロジェクトが実際に専有する曜日（my_weekdays）に該当する日のみに限る
    # （2026-09-02追加。座席の共有〔上記〕を許可したことに伴う対の修正。曜日を絞らずに期間内を
    # 一律で取り消すと、曜日が重ならない他プロジェクト〔共有相手〕の正当な予約まで巻き込んで
    # 取り消してしまうため）
    my_isodows = [_WEEKDAY_ISODOW[w] for w in my_weekdays]

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """UPDATE reservations SET status = 'cancelled', updated_at = now()
                   WHERE seat_id = ANY($1::bigint[]) AND status = 'active' AND date BETWEEN $2 AND $3
                     AND EXTRACT(ISODOW FROM date)::int = ANY($4::int[])""",
                cancel_target_ids, plan["period_start"], plan["period_end"], my_isodows,
            )
            await conn.execute(
                """UPDATE project_quarter_plans
                   SET allocated_seats = $1, status = 'seats_allocated', decided_by = $2, updated_at = now()
                   WHERE id = $3""",
                json.dumps(body.seat_ids), user.id, id,
            )
    was_edit = plan["status"] == "seats_allocated"
    return {"detail": "座席の島の割当を更新しました" if was_edit else "座席の島を割り当てました"}
