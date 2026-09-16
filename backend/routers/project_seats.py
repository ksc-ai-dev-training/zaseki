# A-27〜A-29・A-79 プロジェクト・PM管理（S-08、A-79はS-04も使用）、A-38〜A-44・A-74・A-80〜A-81
# プロジェクト座席・エリア担当側（S-09）。詳細設計書3.8節・3.9節
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
    """座席番号の配列を「D1〜D4」のように整形する（連番でなければカンマ区切り）。
    1件だけの場合はその座席番号をそのまま返す（2026-09-16修正。従来は1件でも「O2〜O2」のような
    自己範囲になっていた）"""
    if len(seat_nos) == 1:
        return seat_nos[0]
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
    プロジェクトの作成者（T-05.created_by）。S-08編集モーダルで管理部が確認・是正できるようにするために
    追加した（PJ席決担当〔proxy_user_id〕とは別概念）。
    2026-09-10変更: 「S-04でもS-08と同じ編集・削除機能が欲しい」との要望を受け、role='admin'専用
    だった認可をrequire_authに緩和し、一時的にrole='admin'以外は自分が作成者（created_by）の
    プロジェクトのみに絞り込むP-CREATORスコープにしていた。
    <strong>2026-09-14変更:</strong> A-55を物理削除から論理削除（projects.deleted_at）に変更した
    ことに伴い、削除済みプロジェクトが一覧に残り続けないよう、常にdeleted_at IS NULLで絞り込む。
    <strong>2026-09-14再訂正:</strong> 「作成者は席決め担当にするのではなくただの作成者で、何も権限は
    ない」との指摘を受け、A-16・A-18等の実権限判定と同様、絞り込みの基準をcreated_by（作成者）から
    proxy_user_id（PJ席決担当）に戻した。作成者であってもPJ席決担当でなければ編集・削除できない
    （A-29・A-55と一致させ、一覧に出るのに操作すると403になる不整合を避けるため）。レスポンス形状は
    変更していない。"""
    pool = get_pool()

    where_clause = "WHERE p.deleted_at IS NULL" if user.role == "admin" else "WHERE p.deleted_at IS NULL AND p.proxy_user_id = $1"
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
                  ) ORDER BY pm.id) FILTER (WHERE pm.id IS NOT NULL), '[]') AS members_json,
                  MAX(creator.last_name || ' ' || creator.first_name) AS created_by_name
           FROM projects p
           LEFT JOIN project_members pm ON pm.project_id = p.id
           LEFT JOIN users u ON u.id = pm.user_id
           LEFT JOIN users creator ON creator.id = p.created_by
           {where_clause}
           GROUP BY p.id
           ORDER BY p.name""",
        *params,
    )
    items = []
    for r in rows:
        members = json.loads(r["members_json"])
        proxy_name = next((m["name"] for m in members if m["user_id"] == r["proxy_user_id"]), None)
        items.append({
            "id": r["id"], "name": r["name"], "pm_pl_names": r["pm_pl_names"] or "未設定",
            "member_count": r["member_count"], "members": members,
            "proxy_user_id": r["proxy_user_id"], "proxy_user_name": proxy_name,
            "created_by": r["created_by"], "created_by_name": r["created_by_name"],
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
    # 2026-09-16修正: 画面表示「姓 名」のスペースを除去してから比較する（last_name||first_nameは
    # スペース無し結合のため、表示通りに入力すると常に0件になっていた）
    rows = await get_pool().fetch(
        """SELECT id, last_name, first_name, email FROM users
           WHERE deleted_at IS NULL
             AND ((last_name || first_name) ILIKE '%' || replace(replace($1, ' ', ''), '　', '') || '%' OR email ILIKE '%' || $1 || '%')
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
    require_authに緩和した。
    <strong>2026-09-14訂正:</strong> 「そもそも要件が違う。作成者は席決め担当にするのではなくただの
    作成者で、何も権限はない。席決め担当になった人がアンケートなどに回答できる」との指摘を受け、
    2026-09-09に千田さんの案でP-PROXY（proxy_user_id）からP-CREATOR（created_by）へ切り替えていた
    権限判定を、P-PROXYへ戻した。role='admin'以外は対象プロジェクトのPJ席決担当（proxy_user_id＝自分）
    のみ許可する。PJ席決担当は自分の判断でメンバー構成・役割・PJ席決担当〔他メンバーへの譲渡を含む〕・
    作成者を変更でき、管理部と全く同じ操作範囲を持つ。created_by（作成者）は表示用の記録項目に戻り、
    この判定には使わない。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, detail="プロジェクト名を入力してください")
    if len(body.members) != len({m.user_id for m in body.members}):
        raise HTTPException(400, detail="同じ利用者が複数の行に指定されています")

    pool = get_pool()
    project = await pool.fetchrow("SELECT id, created_by, proxy_user_id FROM projects WHERE id = $1", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin" and project["proxy_user_id"] != user.id:
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
        # 2026-09-14追加: S-08側は「作成者＝ログインした（作成した）本人」を自動設定するが、その本人を
        # 必ずしもプロジェクトメンバーとして追加するとは限らない（作成者欄自体をUIから外したため、
        # メンバーに含める操作を促す手段がない）。作成者はT-06の正式なメンバーである必要はなく、単に
        # 実在する利用者であればよい（projects.created_byはusersへのFKで、project_membersへのFKでは
        # ない）という元々のデータモデルに合わせ、メンバー一覧に含まれない場合は利用者として実在するかのみ検証する。
        creator_exists = await pool.fetchval(
            "SELECT COUNT(*) FROM users WHERE id = $1 AND deleted_at IS NULL", body.created_by
        )
        if not creator_exists:
            raise HTTPException(404, detail="対象が見つかりません")

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
    """A-55: プロジェクトの削除（S-08プロジェクト・PM管理タブ、2026-08-28追加）。
    2026-09-10変更: 「S-04でもS-08と同じ削除機能が欲しい」との要望を受け、role='admin'専用だった認可を
    require_authに緩和した。
    <strong>2026-09-14変更:</strong> 「プロジェクトを削除するとき、既に期間を設定した座席（座席の島の
    割当を含む）まで一緒になくなる扱いになっている。期間を設定したところまではプロジェクト席として
    残してほしい」との指摘を受け、project_members・project_quarter_plans（座席期間・座席の島の割当）・
    project_weekday_responsesを物理削除する従来の実装をやめ、projects.deleted_atを立てるだけの
    論理削除に変更した。既に設定済みの座席期間・座席の島の割当はそのまま残り、project_blocked_seats()
    （deleted_atを見ない）により従来どおりperiod_endまで座席を専有し続ける。一覧系API（A-27・A-38・
    A-13）はdeleted_at IS NULLで絞り込むため、削除済みプロジェクトは一覧・管理操作の対象からは
    消える。メンバーが個別に確保済みの座席予約（A-18生成分のreservations・recurring_rules）は
    元からproject_idを持たない独立データのため、この変更以前から削除対象外だった。
    <strong>2026-09-14再訂正:</strong> 「作成者は席決め担当にするのではなくただの作成者で、何も
    権限はない。席決め担当になった人がアンケートなどに回答できる」との指摘を受け、role='admin'以外の
    許可条件をP-CREATOR（created_by）からP-PROXY（proxy_user_id、PJ席決担当）に戻した。"""
    pool = get_pool()
    project = await pool.fetchrow("SELECT id, name, created_by, proxy_user_id FROM projects WHERE id = $1 AND deleted_at IS NULL", id)
    if project is None:
        raise HTTPException(404, detail="対象が見つかりません")
    if user.role != "admin" and project["proxy_user_id"] != user.id:
        raise HTTPException(403, detail="この操作を行う権限がありません")

    await pool.execute("UPDATE projects SET deleted_at = now() WHERE id = $1", id)
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
    「前回の確定曜日をコピーする」ボタン（A-15を呼ぶ）の表示条件に使う。admin_note（2026-09-14追加）は
    管理部・エリア責任者がS-09の出社曜日の調整表に入力する備考（A-83で更新）。noteとは別物で、
    PM/PLがアンケート回答時に入力する備考（T-11、読み取り専用）に対し、こちらは調整表を使う
    管理部・エリア責任者自身が保存するメモである。"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT pqp.id, pqp.project_id, p.name AS project_name, pqp.period_start, pqp.period_end,
                  pqp.required_seats, pqp.weekdays_finalized, pqp.allocated_seats, pqp.status, pqp.admin_note,
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
           WHERE p.deleted_at IS NULL
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
            "admin_note": r["admin_note"],
            "previous_area": previous_area_by_project.get(r["project_id"]),
            "has_previous_plan": r["has_previous_plan"],
        })

    # 期間未設定のプロジェクト（今日以降に及ぶ計画データを1件も持たないプロジェクト）を別枠で返す
    # （2026-09-03追加、変更D。「四半期」の自動起票がなくなったため、S-09側でエリア責任者が
    # 「まだ期間を設定していないプロジェクト」に気づけるようにする必要がある）。
    unplanned_rows = await pool.fetch(
        """SELECT p.id, p.name
           FROM projects p
           WHERE p.deleted_at IS NULL
             AND NOT EXISTS (
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


class AdminNoteUpdate(BaseModel):
    admin_note: str | None = None


@router.put("/project-quarter-plans/{id}/admin-note")
async def update_admin_note(id: int, body: AdminNoteUpdate, _: CurrentUser = Depends(require_roles("admin"))):
    """A-83: S-09の出社曜日の調整表に管理部・エリア責任者が入力する備考の保存（2026-09-14新設）。
    「曜日調整表にそれぞれのプロジェクトの備考欄が欲しい」との要望を受けた。既存のnote
    （T-11.note、PM/PLがアンケート回答時に入力する備考）とは別物で、こちらは調整表を使う
    管理部・エリア責任者自身が保存する独立したメモ（T-07.admin_note）。座席の割当状況・確定状況に
    関わらずいつでも変更でき、他のA-40・A-65のようなstatusによる制限は設けない（単なるメモのため）。"""
    admin_note = (body.admin_note or "").strip() or None
    if admin_note is not None and len(admin_note) > 500:
        raise HTTPException(400, detail="備考は500文字以内で入力してください")
    pool = get_pool()
    plan = await pool.fetchrow("SELECT id FROM project_quarter_plans WHERE id = $1", id)
    if plan is None:
        raise HTTPException(404, detail="対象が見つかりません")
    await pool.execute(
        "UPDATE project_quarter_plans SET admin_note = $1, updated_at = now() WHERE id = $2",
        admin_note, id,
    )
    return {"detail": "備考を更新しました"}


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
    # 2026-09-15追加: 従来はrequired_seats（必要座席数＝人数）が一切送られておらず、AIは
    # 「各曜日の合計人数が座席容量を超えないように」と指示されながら、そもそも各プロジェクトの
    # 人数を知らないままだった（複数プロジェクトが同じ曜日を希望している＝容量超過、という
    # 実際の人数によらない誤った決めつけの原因になっていた）。AIコードレビューで発見。
    required_seats: int = 0
    choice1_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]] | None = None
    choice2_weekdays: list[Literal["mon", "tue", "wed", "thu", "fri"]] | None = None
    note: str | None = None


class WeekdayAiSuggestBody(BaseModel):
    plans: list[WeekdayAiSuggestPlan]
    weekday_capacity: dict[Literal["mon", "tue", "wed", "thu", "fri"], int]
    # そのグループの固定座席保有者数（2026-09-15追加、「できるだけフリー座席を残すような感じに
    # したい」との要望を受けた）。固定座席保有者は曜日によらず毎日座席を使うため、AIへ伝えて
    # 実質的な残り座席（フリー座席として使える分）を意識した調整をさせる
    fixed_seat_count: int = 0


@router.post("/project-quarter-plans/weekday-ai-suggestions")
async def suggest_weekdays_ai(body: WeekdayAiSuggestBody, _: CurrentUser = Depends(require_roles("admin"))):
    """A-74: 出社曜日の調整表（WeekdayMatrix、S-09）の仮案を生成AI（LLM）に生成させる（FR-03-11、
    2026-09-08追加。検討資料「プロジェクト座席・曜日調整フロー改善案」変更C）。DBへの書き込みは
    行わない（提案のみ）。WeekdayMatrixはNORTH／EAST・WEST（統合）の2グループに分かれて表示される
    ため、フロントエンドはグループ単位で本APIを呼ぶ（1回の呼び出し＝1グループ分）。座席の島の割当
    実績がない（previous_area=null）プロジェクトは、当初は「前回の割当エリアなし」という独立した
    第3グループにまとめていたが、「基本的にEAST・WESTの区分になるので、そのエリアの扱いにしてほしい。
    NORTHエリアの場合は切り替えるボタンを押すような感じ」との要望を受け、既定でEAST・WESTグループへ
    含め、エリア責任者がプロジェクトごとにNORTHへ切り替えられるボタンを設ける形に変更した
    （2026-09-15変更、フロントエンドのareaOverrideのみで完結する画面上の分類であり、本APIやA-38の
    previous_area自体には影響しない）。plansの各フィールドはA-38のレスポンスをフロントエンドが
    そのまま渡す（バックエンド側でDBを読み直さない）。weekday_capacityは、当初は「曜日ごとの合計」
    （v2.32・v2.33実装済み、固定座席の人数＋各プロジェクトのrequired_seatsの合計、需要側の数値）を
    そのまま渡していたが、これはNORTH・EAST/WESTの実際の物理座席数（A-38のarea_seat_capacity）とは
    無関係な値で、月〜金すべて同じ値になるため実質AIへの制約として機能しておらず、容量オーバーが
    無いにもかかわらずAIがプロジェクトの出社曜日を動かしてしまう不具合の原因になっていた
    （2026-09-15修正。新人研修とLCC(CS)の例：両者の第一希望は重複せず容量内に収まるのに、備考
    「配属になる可能性があるので現状不明」をAIが曜日の制約と誤読し調整してしまった）。フロントエンドは
    area_seat_capacityの実数値を渡すよう修正した。
    実際のLLM呼び出しはai_weekday.suggest_weekdays()に委譲する（OpenAI Chat Completions APIを
    httpxで直接呼ぶ、専用SDKは追加していない）。呼び出しに失敗した場合は502を返し、フロントエンドは
    対象グループのマトリクス表を変更しない（検討資料3.3節「失敗時」の方針）。missing_plan_ids
    （2026-09-09追加）: 依頼したplan_idのうちAIの応答に含まれていなかったもの。フロントエンドは
    このplan_idに該当する行について「AI提案なし」である旨を利用者に示す。fixed_seat_count
    （2026-09-15追加、「できるだけフリー座席を残すような感じにしたい」との要望を受けた）は
    そのグループの固定座席保有者数（既存ロジックのg.fixedSeatCountをそのまま渡す）。固定座席
    保有者は曜日によらず毎日座席を使用するため、座席容量からこの人数を引いた分が実際にプロジェクト
    ＋フリー座席として使える残りになる。プロンプトにこの人数を伝え、調整が必要な場合（複数の
    候補曜日がある場合）はできるだけ余裕（フリー座席として残る分）が大きい曜日を優先するよう
    指示する。重複がなく容量内に収まる第一希望をこの理由だけで動かすことはしない。"""
    if not body.plans:
        raise HTTPException(400, detail="対象のプロジェクトを1件以上指定してください")
    try:
        result = await ai_weekday.suggest_weekdays(
            [p.model_dump() for p in body.plans], dict(body.weekday_capacity), body.fixed_seat_count,
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
        "SELECT id, seat_no, status, seat_type FROM seats WHERE id = ANY($1::bigint[])", body.seat_ids
    )
    if (
        len(seats) != len(set(body.seat_ids))
        or any(s["status"] != "active" for s in seats)
        or any(s["seat_type"] != "free" for s in seats)
    ):
        raise HTTPException(404, detail="対象が見つかりません")
    seat_no_by_id = {s["id"]: s["seat_no"] for s in seats}

    other_plans = await pool.fetch(
        """SELECT pqp.allocated_seats, pqp.weekdays_finalized, p.name AS project_name
           FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.status = 'seats_allocated' AND pqp.id != $1
             AND pqp.period_start <= $2 AND pqp.period_end >= $3""",
        id, plan["period_end"], plan["period_start"],
    )
    # 四半期の期間が重なっていても、確定した出社曜日が1日も重ならない他プロジェクトとは
    # 同じ座席を共有できる（2026-09-02追加。「10/1が初日のプロジェクト座席でフロアマップを見ると
    # 未確定で埋まっている」の調査に伴う関連修正。座席の専有はdatabase.project_blocked_seats()と
    # 同じく曜日単位で判定するのが実態のため、割当時の重複チェックも期間だけでなく曜日の重なりを
    # 見るようにした。例: 火・水出社のプロジェクトと木・金出社のプロジェクトは同じ座席を割り当てられる）
    my_weekdays = set(json.loads(plan["weekdays_finalized"])) if plan["weekdays_finalized"] else set()
    # 座席id→重複先のプロジェクト名（2026-09-10追加。「どのプロジェクトがかぶっているのか
    # わかるようにできる？」との要望を受け、単に「含まれています」だけでなく、具体的にどの座席が
    # どのプロジェクトと重複しているかをエラーメッセージに含めるようにした）
    allocated_owner: dict[int, str] = {}
    for r in other_plans:
        other_weekdays = set(json.loads(r["weekdays_finalized"])) if r["weekdays_finalized"] else set()
        if not (my_weekdays & other_weekdays):
            continue
        if r["allocated_seats"]:
            for sid in json.loads(r["allocated_seats"]):
                allocated_owner[sid] = r["project_name"]
    conflicting_seat_ids = [sid for sid in body.seat_ids if sid in allocated_owner]
    if conflicting_seat_ids:
        detail = "、".join(f"{seat_no_by_id.get(sid, sid)}（「{allocated_owner[sid]}」と重複）" for sid in conflicting_seat_ids)
        raise HTTPException(409, detail=f"既に他プロジェクトへ割り当てられている座席が含まれています: {detail}")

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


class SeatBlockBulkAssignItem(BaseModel):
    plan_id: int
    seat_ids: list[int]


class SeatBlockBulkAssign(BaseModel):
    assignments: list[SeatBlockBulkAssignItem]


@router.post("/project-quarter-plans/seat-block-bulk")
async def assign_seat_block_bulk(body: SeatBlockBulkAssign, user: CurrentUser = Depends(require_roles("admin"))):
    """A-80: 複数プロジェクトの座席の島をまとめて割り当てる（FR-03-6の一括版、2026-09-10新設）。
    「S-09で座席の割り当てを一括で登録できるようにしてほしい。右画面にプロジェクト名を並べ、選ぶと
    備考・曜日・座席数を表示し、左の座席表で割り当てる」との要望を受けた。対象はA-44と異なり
    status='weekdays_finalized'（未割当）の新規割当のみとし、既存の割当の編集はA-44（1件ずつ）の
    ままとする（old_seat_idsとの結合が不要になるぶん単純化できる）。
    検証はプロジェクトごとにA-44と同じ内容を繰り返す（計画の存在・状態、メンバー全員が固定座席／
    在宅で不要でないか、指定座席が有効なフリー座席か、既にseats_allocatedな他プロジェクトとの
    曜日重複）のに加え、A-44には無い「この一括リクエスト内の他プロジェクトとの重複」も検証する
    （isodowごとに、このバッチ内で既に確保された座席id集合を積み上げて後続の項目と突き合わせる）。
    A-66（period-bulk）・A-68（bulk-create）と同じ「1件でも失敗したら全体を失敗させ、どのプロジェクト
    も更新しない」方針を踏襲する（部分成功による中途半端な状態を避けるため）。個別の結果配列は返さず、
    単一のdetailメッセージのみを返す（この2つの既存の一括系APIと同じレスポンス形状）。"""
    if not body.assignments:
        raise HTTPException(400, detail="対象プロジェクトを1つ以上選択してください")
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            claimed_by_isodow: dict[int, dict[int, str]] = {}
            for item in body.assignments:
                if not item.seat_ids:
                    raise HTTPException(400, detail="座席を1つ以上選択してください")
                plan = await conn.fetchrow(
                    """SELECT pqp.id, pqp.project_id, pqp.status, pqp.period_start, pqp.period_end,
                              pqp.weekdays_finalized, p.name AS project_name
                       FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
                       WHERE pqp.id = $1""",
                    item.plan_id,
                )
                if plan is None:
                    raise HTTPException(404, detail="対象が見つかりません")
                if plan["status"] != "weekdays_finalized":
                    raise HTTPException(400, detail=f"「{plan['project_name']}」は出社曜日の確定後（未割当）でなければ一括割当の対象にできません")

                non_fixed_member_count = await conn.fetchval(
                    """SELECT COUNT(*) FROM project_members pm
                       WHERE pm.project_id = $1
                         AND NOT pm.seat_not_required
                         AND NOT EXISTS (SELECT 1 FROM fixed_seat_assignments fsa WHERE fsa.user_id = pm.user_id AND fsa.ended_on IS NULL)""",
                    plan["project_id"],
                )
                if non_fixed_member_count == 0:
                    raise HTTPException(400, detail=f"「{plan['project_name']}」はメンバーが全員固定座席保有者または在宅のため不要であり、プロジェクト座席は不要です")

                seats = await conn.fetch(
                    "SELECT id, seat_no, status, seat_type FROM seats WHERE id = ANY($1::bigint[])", item.seat_ids
                )
                if (
                    len(seats) != len(set(item.seat_ids))
                    or any(s["status"] != "active" for s in seats)
                    or any(s["seat_type"] != "free" for s in seats)
                ):
                    raise HTTPException(404, detail=f"「{plan['project_name']}」の対象座席が見つかりません")
                seat_no_by_id = {s["id"]: s["seat_no"] for s in seats}

                my_weekdays = set(json.loads(plan["weekdays_finalized"])) if plan["weekdays_finalized"] else set()
                other_plans = await conn.fetch(
                    """SELECT pqp.allocated_seats, pqp.weekdays_finalized, p.name AS project_name
                       FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
                       WHERE pqp.status = 'seats_allocated' AND pqp.id != $1
                         AND pqp.period_start <= $2 AND pqp.period_end >= $3""",
                    item.plan_id, plan["period_end"], plan["period_start"],
                )
                # 座席id→重複先のプロジェクト名（2026-09-10追加。「どのプロジェクトがかぶっているのか
                # わかるようにできる？」との要望を受け、A-44と同様にエラーメッセージへ座席番号・
                # 重複先のプロジェクト名を含めるようにした）
                allocated_owner: dict[int, str] = {}
                for r in other_plans:
                    other_weekdays = set(json.loads(r["weekdays_finalized"])) if r["weekdays_finalized"] else set()
                    if not (my_weekdays & other_weekdays):
                        continue
                    if r["allocated_seats"]:
                        for sid in json.loads(r["allocated_seats"]):
                            allocated_owner[sid] = r["project_name"]
                conflicting_seat_ids = [sid for sid in item.seat_ids if sid in allocated_owner]
                if conflicting_seat_ids:
                    detail = "、".join(f"{seat_no_by_id.get(sid, sid)}（「{allocated_owner[sid]}」と重複）" for sid in conflicting_seat_ids)
                    raise HTTPException(409, detail=f"「{plan['project_name']}」に、既に他プロジェクトへ割り当てられている座席が含まれています: {detail}")

                my_isodows = [_WEEKDAY_ISODOW[w] for w in my_weekdays]
                batch_conflict_owner: dict[int, str] = {}
                for sid in item.seat_ids:
                    for isodow in my_isodows:
                        owner = claimed_by_isodow.get(isodow, {}).get(sid)
                        if owner and owner != plan["project_name"]:
                            batch_conflict_owner[sid] = owner
                if batch_conflict_owner:
                    detail = "、".join(f"{seat_no_by_id.get(sid, sid)}（「{owner}」と重複）" for sid, owner in batch_conflict_owner.items())
                    raise HTTPException(409, detail=f"「{plan['project_name']}」に、この一括登録内の他のプロジェクトと重複する座席が含まれています: {detail}")
                for isodow in my_isodows:
                    claimants = claimed_by_isodow.setdefault(isodow, {})
                    for sid in item.seat_ids:
                        claimants.setdefault(sid, plan["project_name"])

                await conn.execute(
                    """UPDATE reservations SET status = 'cancelled', updated_at = now()
                       WHERE seat_id = ANY($1::bigint[]) AND status = 'active' AND date BETWEEN $2 AND $3
                         AND EXTRACT(ISODOW FROM date)::int = ANY($4::int[])""",
                    item.seat_ids, plan["period_start"], plan["period_end"], my_isodows,
                )
                await conn.execute(
                    """UPDATE project_quarter_plans
                       SET allocated_seats = $1, status = 'seats_allocated', decided_by = $2, updated_at = now()
                       WHERE id = $3""",
                    json.dumps(item.seat_ids), user.id, item.plan_id,
                )
    return {"detail": f"{len(body.assignments)}件のプロジェクトへ座席の島を割り当てました"}


class SeatBlockCheckItem(BaseModel):
    plan_id: int
    seat_ids: list[int]


class SeatBlockCheck(BaseModel):
    assignments: list[SeatBlockCheckItem]


@router.post("/project-quarter-plans/seat-block-check")
async def check_seat_block(body: SeatBlockCheck, user: CurrentUser = Depends(require_roles("admin"))):
    """A-81: 座席の島の割当（A-44・A-80）を実際に登録する前に、重複がないか事前確認する
    （FR-03-6関連、2026-09-10新設）。「座席の島の割当を行う際、かぶっている部分があったら登録する前に
    事前にかぶっていますと通知してほしい」との要望を受けた。A-44・A-80の重複判定は曜日単位（3.9節参照）
    のため、S-02のフロアマップで表示中の1日だけを見ていても、別の曜日で既に確保されている座席との
    重複には気づけず、実際に登録して初めて409エラーで判明する形になっていた。本APIはA-44・A-80と
    同じ重複判定ロジック（既にseats_allocatedな他プロジェクトとの曜日重複、および本リクエスト内の
    複数プロジェクト間の重複）だけを行い、更新は一切行わない読み取り専用のチェックであり、S-02側で
    座席選択が変わるたびに呼び出して警告バナーとして表示する用途に使う。単一プロジェクト（A-44）・
    一括（A-80）のどちらの画面からも、assignmentsを1件または複数件渡して共用する。返す警告文には
    座席番号・重複先のプロジェクト名を含める（2026-09-10追加。「もしかぶっていたら時どのプロジェクトが
    かぶっているのかわかるようにできる？」との要望を受けた。あわせてA-44・A-80自体の409エラー
    メッセージにも同じ詳細を追加した）。"""
    conflicts: list[str] = []
    if not body.assignments:
        return {"conflicts": conflicts}
    pool = get_pool()
    all_seat_ids = {sid for item in body.assignments for sid in item.seat_ids}
    seat_no_by_id: dict[int, str] = {}
    if all_seat_ids:
        seat_rows = await pool.fetch("SELECT id, seat_no FROM seats WHERE id = ANY($1::bigint[])", list(all_seat_ids))
        seat_no_by_id = {r["id"]: r["seat_no"] for r in seat_rows}

    claimed_by_isodow: dict[int, dict[int, str]] = {}
    for item in body.assignments:
        if not item.seat_ids:
            continue
        plan = await pool.fetchrow(
            """SELECT pqp.id, pqp.period_start, pqp.period_end, pqp.weekdays_finalized,
                      p.name AS project_name
               FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
               WHERE pqp.id = $1""",
            item.plan_id,
        )
        if plan is None:
            continue
        my_weekdays = set(json.loads(plan["weekdays_finalized"])) if plan["weekdays_finalized"] else set()
        other_plans = await pool.fetch(
            """SELECT pqp.allocated_seats, pqp.weekdays_finalized, p.name AS project_name
               FROM project_quarter_plans pqp JOIN projects p ON p.id = pqp.project_id
               WHERE pqp.status = 'seats_allocated' AND pqp.id != $1
                 AND pqp.period_start <= $2 AND pqp.period_end >= $3""",
            item.plan_id, plan["period_end"], plan["period_start"],
        )
        allocated_owner: dict[int, str] = {}
        for r in other_plans:
            other_weekdays = set(json.loads(r["weekdays_finalized"])) if r["weekdays_finalized"] else set()
            if not (my_weekdays & other_weekdays):
                continue
            if r["allocated_seats"]:
                for sid in json.loads(r["allocated_seats"]):
                    allocated_owner[sid] = r["project_name"]
        conflicting_seat_ids = [sid for sid in item.seat_ids if sid in allocated_owner]
        if conflicting_seat_ids:
            detail = "、".join(f"{seat_no_by_id.get(sid, sid)}（「{allocated_owner[sid]}」と重複）" for sid in conflicting_seat_ids)
            conflicts.append(f"「{plan['project_name']}」に、既に他プロジェクトへ割り当てられている座席が含まれています: {detail}")

        my_isodows = [_WEEKDAY_ISODOW[w] for w in my_weekdays]
        batch_conflict_owner: dict[int, str] = {}
        for sid in item.seat_ids:
            for isodow in my_isodows:
                owner = claimed_by_isodow.get(isodow, {}).get(sid)
                if owner and owner != plan["project_name"]:
                    batch_conflict_owner[sid] = owner
        if batch_conflict_owner:
            detail = "、".join(f"{seat_no_by_id.get(sid, sid)}（「{owner}」と重複）" for sid, owner in batch_conflict_owner.items())
            conflicts.append(f"「{plan['project_name']}」に、この選択内の他のプロジェクトと重複する座席が含まれています: {detail}")
        for isodow in my_isodows:
            claimants = claimed_by_isodow.setdefault(isodow, {})
            for sid in item.seat_ids:
                claimants.setdefault(sid, plan["project_name"])
    return {"conflicts": conflicts}
