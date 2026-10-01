# 障害時バックアップ用: 今後の座席予約状況をGoogleスプレッドシートへ日次で自動反映する
# （詳細設計書3.14節「バッチ処理」。要求仕様書には明記のない追加提案、2026-10-01新設）。
#
# 背景: 「もし仮にこのシステムが止まってしまった場合、既存の座席予約スプレッドシートに
# 反映させることは可能か」との相談を受けた。双方向の運用フォールバック（止まっている間も
# スプレッドシート側で予約を受け付け続ける）は、まさにこのシステムが解決しようとした
# 「同時編集による上書き」（REQ-N-03）の問題をスプレッドシート側に持ち込むことになるため
# 採用せず、あくまで「障害時に今後誰がどこを使う予定だったか参照できるスナップショット」
# （DB→スプレッドシートの一方向、読み取り専用）として実装する。
#
# 認証方式: Googleログイン（A-01/A-02、google_auth.py）のOAuthクライアントとは別に、
# サーバー間連携用の「サービスアカウント」が別途必要（Google Cloud Consoleで作成し、
# 対象スプレッドシートにそのサービスアカウントのメールアドレスを編集者として共有しておく）。
# 既存のgoogle_auth.pyと同じ理由（他ライブラリに頼らずPyJWT・cryptography・httpxのみで
# 完結させる、依存ライブラリを増やさない方針）で、google-api-python-client等は使わず、
# サービスアカウントのJWTベアラー方式（RFC 7523）を自前で組み立てる。
import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
import jwt as pyjwt

from database import ROOT_ENV, effective_seat_ids, free_seat_bookable_period, get_pool, release_expired_fixed_seats
from routers.seats import _seat_sort_key

_WEEKDAY_JA = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金"}

SHEETS_TOKEN_URL = "https://oauth2.googleapis.com/token"
SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key) or ROOT_ENV.get(key, default)


# サービスアカウントのJSON鍵ファイルの中身をそのまま1行の文字列として設定する
# （ローカルは.env、本番は`fly secrets set`。CLAUDE.mdの接続文字列の扱いと同じく、
# このファイル自体やその内容をGitHubへpushしてはならない）
_SERVICE_ACCOUNT_JSON = _env("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON")
# 反映先のスプレッドシートID（URLの/d/と/editの間の文字列）。既定は要求仕様書記載の
# 「本社座席予約表」だが、障害時バックアップ専用の別シートに分けたい場合は差し替える
SPREADSHEET_ID = _env("RESERVATION_EXPORT_SPREADSHEET_ID")
# 書き込み先のタブ（シート）名。既存の運用ルールシート等を壊さないよう、専用の新しいタブに書く
SHEET_NAME = _env("RESERVATION_EXPORT_SHEET_NAME", "Zaseki自動反映")


def is_configured() -> bool:
    return bool(_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID)


async def _get_access_token(client: httpx.AsyncClient) -> str:
    """サービスアカウントのJWTベアラーフロー（RFC 7523）でアクセストークンを取得する。
    google_auth.pyのverify_id_token（Googleが発行したIDトークンの検証）とは逆方向の処理
    （自分の秘密鍵でアサーションに署名し、Googleのトークンエンドポイントへ提示する）。"""
    account = json.loads(_SERVICE_ACCOUNT_JSON)
    now = int(time.time())
    assertion = pyjwt.encode(
        {
            "iss": account["client_email"],
            "scope": SHEETS_SCOPE,
            "aud": account.get("token_uri", SHEETS_TOKEN_URL),
            "iat": now,
            "exp": now + 3600,
        },
        account["private_key"],
        algorithm="RS256",
    )
    res = await client.post(
        account.get("token_uri", SHEETS_TOKEN_URL),
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
    )
    res.raise_for_status()
    return res.json()["access_token"]


async def _ensure_sheet_exists(client: httpx.AsyncClient) -> None:
    """SHEET_NAMEのタブが対象スプレッドシートに無ければ新規作成する（Sheets APIは
    存在しないタブへの書き込みを自動で作ってくれないため）。既にあれば何もしない。"""
    res = await client.get(f"{SHEETS_API_BASE}/{SPREADSHEET_ID}")
    res.raise_for_status()
    titles = {s["properties"]["title"] for s in res.json().get("sheets", [])}
    if SHEET_NAME in titles:
        return
    res = await client.post(
        f"{SHEETS_API_BASE}/{SPREADSHEET_ID}:batchUpdate",
        json={"requests": [{"addSheet": {"properties": {"title": SHEET_NAME}}}]},
    )
    res.raise_for_status()


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


_WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def build_export_rows() -> list[list[str]]:
    """スプレッドシートへ書き込む全行を組み立てる。固定座席・プロジェクト座席の島（どちらも
    割当期間中ずっと変わらない静的な情報）と、日付ごとの個別予約（毎日変わりうる情報）とで
    性質が異なるため、1枚のシートの中で3つのセクションに分けて書く（間に空行を挟む）"""
    await release_expired_fixed_seats()
    rows: list[list[str]] = [["固定座席（現在有効な割当）"], ["座席番号", "エリア", "利用者", "開始日", "終了日"]]
    rows += await _fixed_seat_rows()
    rows += [[], ["プロジェクト座席の島（確定済み、曜日ごと）"], ["プロジェクト名", "座席番号", "エリア", "曜日", "期間"]]
    rows += await _project_seat_rows()
    rows += [[], ["個別の予約（フリー座席・プロジェクトメンバーの確保分、本日以降の予約可能期間分）"], ["日付", "曜日", "座席番号", "エリア", "利用者"]]
    rows += await _individual_reservation_rows()
    return rows


async def export_reservations_to_sheet() -> int:
    """DBの今後の予約状況をSHEET_NAMEタブへ上書きする（既存内容はクリアしてから書き直す、
    一方向のスナップショット反映）。戻り値は書き込んだ行数（ヘッダー含む）"""
    if not is_configured():
        raise RuntimeError("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON・RESERVATION_EXPORT_SPREADSHEET_IDが未設定です")
    rows = await build_export_rows()
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _get_access_token(client)
        client.headers["Authorization"] = f"Bearer {token}"
        await _ensure_sheet_exists(client)
        range_name = quote(SHEET_NAME, safe="")
        res = await client.post(f"{SHEETS_API_BASE}/{SPREADSHEET_ID}/values/{range_name}:clear")
        res.raise_for_status()
        res = await client.put(
            f"{SHEETS_API_BASE}/{SPREADSHEET_ID}/values/{range_name}!A1",
            params={"valueInputOption": "RAW"},
            json={"values": rows},
        )
        res.raise_for_status()
    return len(rows)


# 03:00 JST（UTC+9固定、サマータイムなし）で毎日実行する。実行基盤（cron等）を別途持たない
# 方針（詳細設計書3.14節冒頭）のため、アプリプロセス内でasyncio.sleepするだけの素朴な
# スケジューラにする。本番は1台構成（fly.toml）のため多重実行の心配はない
_JST = timezone(timedelta(hours=9))
_RUN_HOUR_JST = 3


def _seconds_until_next_run() -> float:
    now = datetime.now(_JST)
    target = now.replace(hour=_RUN_HOUR_JST, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


_logger = logging.getLogger("sheets_export")


async def daily_export_loop() -> None:
    """main.pyのlifespanからasyncio.create_task()で起動する常駐タスク。
    GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON等が未設定の環境（ローカル開発等）では何もしない"""
    if not is_configured():
        _logger.info("スプレッドシート自動反映は未設定のため無効化します（GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON等）")
        return
    while True:
        await asyncio.sleep(_seconds_until_next_run())
        try:
            count = await export_reservations_to_sheet()
            _logger.info("スプレッドシートへ予約状況を反映しました（%d行）", count)
        except Exception:
            _logger.exception("スプレッドシートへの予約状況反映に失敗しました")
