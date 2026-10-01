# 障害時バックアップ用: 今後の座席予約状況をGoogleスプレッドシートへ反映するためのデータ組み立て
# （詳細設計書3.14節「バッチ処理」。要求仕様書には明記のない追加提案、2026-10-01新設）。
#
# 背景: 「もし仮にこの座席予約システムが止まってしまった場合、既存の座席予約スプレッドシートに
# 反映させることは可能か」との相談を受けた。双方向の運用フォールバック（止まっている間も
# スプレッドシート側で予約を受け付け続ける）は、まさにこのシステムが解決しようとした
# 「同時編集による上書き」（REQ-N-03）の問題をスプレッドシート側に持ち込むことになるため
# 採用せず、あくまで「障害時に今後誰がどこを使う予定だったか参照できるスナップショット」
# （DB→スプレッドシートの一方向、読み取り専用）として実装する。
#
# 方式転換（2026-10-01）: 当初はこのPythonプロセス自身がGoogleのサービスアカウントで
# Sheets APIを直接呼ぶ「push」方式で実装したが、実際に設定を進めたところ「サービスアカウント
# （組織外のアカウント扱いになる）へのスプレッドシートの編集者共有が、会社のGoogle Workspace
# の規定で禁止されている」ことが判明した。情シスにポリシーの許可リスト追加を依頼する、または
# 実在する社内アカウントのOAuthリフレッシュトークンに置き換える案も検討したが、「スプレッドシート
# 側で動くGoogle Apps Script（GAS）からこのAPIを呼んで取得し、書き込みはGAS側で行う」という
# 「pull」方式に変更することで、共有設定が一切不要になる（GASはそのスプレッドシートの所有者
# 自身のGoogleアカウント権限で動作するため）ことが分かり、採用した。この結果、Python側は
# サービスアカウント鍵・Google Sheets APIへの依存が完全になくなった（GAS側のスクリプトは
# `gas/reservation_export.gs`参照）。
import json
import os

from database import ROOT_ENV, effective_seat_ids, free_seat_bookable_period, get_pool, release_expired_fixed_seats
from routers.seats import _seat_sort_key

_WEEKDAY_JA = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金"}
_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key) or ROOT_ENV.get(key, default)


# GAS（gas/reservation_export.gs）からの呼び出しを認証する共有トークン
# （routers/export.pyのX-Export-Tokenヘッダと照合）。通常のセッションCookie認証は
# ブラウザでの対話的ログインが前提のため、GASのようなサーバー間呼び出しには使えない。
# ローカルは.env、本番は`fly secrets set`で設定する（CLAUDE.mdの接続文字列の扱いと同じく、
# 値自体をGitHubへpushしてはならない）
EXPORT_API_TOKEN = _env("EXPORT_API_TOKEN")


async def _fixed_seat_rows() -> list[list[str]]:
    """現在有効な固定座席の割当（T-04、ended_on IS NULL）を1件1行で返す。固定座席は
    割当期間中ずっと同じ状態のため、日付ごとに行を増やさず概要（開始日・終了日）だけ持たせる"""
    rows = await get_pool().fetch(
        """SELECT s.seat_no, a.name AS area_name, u.last_name, u.first_name, fsa.valid_from, fsa.valid_until
           FROM fixed_seat_assignments fsa
           JOIN seats s ON s.id = fsa.seat_id
           JOIN areas a ON a.id = s.area_id
           JOIN users u ON u.id = fsa.user_id
           WHERE fsa.ended_on IS NULL""",
    )
    rows = sorted(rows, key=lambda r: _seat_sort_key(r["seat_no"]))
    return [
        [
            r["seat_no"], r["area_name"], f"{r['last_name']} {r['first_name']}",
            r["valid_from"].isoformat(), r["valid_until"].isoformat() if r["valid_until"] else "無期限",
        ]
        for r in rows
    ]


async def _project_seat_rows() -> list[list[str]]:
    """確定済み（status='seats_allocated'）のプロジェクト座席の島を、確定曜日×実効座席の
    単位で1行ずつ返す（曜日ごとに島が異なる場合はeffective_seat_idsで解決する）。
    座席の島自体は期間中ずっと同じ状態のため、固定座席と同じく日付ごとには展開しない"""
    pool = get_pool()
    seat_rows = await pool.fetch("SELECT s.id, s.seat_no, a.name AS area_name FROM seats s JOIN areas a ON a.id = s.area_id")
    seat_by_id = {r["id"]: (r["seat_no"], r["area_name"]) for r in seat_rows}
    plan_rows = await pool.fetch(
        """SELECT p.name AS project_name, pqp.period_start, pqp.period_end,
                  pqp.allocated_seats, pqp.allocated_seats_overrides, pqp.weekdays_finalized
           FROM project_quarter_plans pqp
           JOIN projects p ON p.id = pqp.project_id
           WHERE pqp.status = 'seats_allocated' AND pqp.period_end >= CURRENT_DATE AND p.deleted_at IS NULL""",
    )
    rows: list[list[str]] = []
    for r in plan_rows:
        weekdays = json.loads(r["weekdays_finalized"]) if r["weekdays_finalized"] else []
        period = f"{r['period_start'].isoformat()}〜{r['period_end'].isoformat()}"
        for weekday in weekdays:
            for seat_id in effective_seat_ids(r["allocated_seats"], r["allocated_seats_overrides"], weekday):
                seat_no, area_name = seat_by_id.get(seat_id, (f"id={seat_id}", ""))
                rows.append([r["project_name"], seat_no, area_name, _WEEKDAY_JA.get(weekday, weekday), period])
    rows.sort(key=lambda row: _seat_sort_key(row[1]))
    return rows


async def _individual_reservation_rows() -> list[list[str]]:
    """RULE-05の予約可能期間（本日〜当月末または来月末、free_seat_bookable_period）に
    含まれる、日付単位の実際の予約（フリー座席の単発・周期予約、プロジェクトメンバーへの
    座席確保分の両方を含む。T-08）を1件1行で返す。固定座席・座席の島自体は上の2関数で
    別途扱うためここでは対象にしない"""
    start, end = await free_seat_bookable_period()
    rows = await get_pool().fetch(
        """SELECT r.date, s.seat_no, a.name AS area_name, u.last_name, u.first_name
           FROM reservations r
           JOIN seats s ON s.id = r.seat_id
           JOIN areas a ON a.id = s.area_id
           JOIN users u ON u.id = r.user_id
           WHERE r.status = 'active' AND r.date BETWEEN $1 AND $2""",
        start, end,
    )
    rows = sorted(rows, key=lambda r: (r["date"], _seat_sort_key(r["seat_no"])))
    return [
        [r["date"].isoformat(), _WEEKDAY_JA.get(_WEEKDAY_CODES[r["date"].weekday()], ""), r["seat_no"], r["area_name"], f"{r['last_name']} {r['first_name']}"]
        for r in rows
    ]


async def build_export_rows() -> list[list[str]]:
    """GAS（gas/reservation_export.gs）がスプレッドシートへ書き込む全行を組み立てる。
    固定座席・プロジェクト座席の島（どちらも割当期間中ずっと変わらない静的な情報）と、
    日付ごとの個別予約（毎日変わりうる情報）とで性質が異なるため、1枚のシートの中で
    3つのセクションに分けて返す（間に空行を挟む）"""
    await release_expired_fixed_seats()
    rows: list[list[str]] = [["固定座席（現在有効な割当）"], ["座席番号", "エリア", "利用者", "開始日", "終了日"]]
    rows += await _fixed_seat_rows()
    rows += [[], ["プロジェクト座席の島（確定済み、曜日ごと）"], ["プロジェクト名", "座席番号", "エリア", "曜日", "期間"]]
    rows += await _project_seat_rows()
    rows += [[], ["個別の予約（フリー座席・プロジェクトメンバーの確保分、本日以降の予約可能期間分）"], ["日付", "曜日", "座席番号", "エリア", "利用者"]]
    rows += await _individual_reservation_rows()
    return rows
