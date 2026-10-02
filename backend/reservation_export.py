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
#
# 表形式への変更（2026-10-02）: 当初は固定座席・プロジェクト座席の島・個別予約を3区分に
# 分けた1件1行形式だったが、「今のシートだけだとだれがどの席に該当するのかわかりづらい。
# 既存のスプシの座席表のように視覚化できるとさらにいい」との要望を受けた。縦軸に座席、
# 横軸に日付を並べたマス目形式（旧・本社座席予約表の運用に近い形）に変更した。これにより
# A-69（期間ビュー、routers/proxy.py）がS-11向けに持つ「座席×日付ごとの占有状況」をそのまま
# 再利用できる。
#
# セル表示の簡略化（2026-10-02）: 「プロジェクトの名前も表示されている。名前のみでお願いします」
# との要望を受け、プロジェクト座席のセルに併記していた「（プロジェクト名）」を外し、利用者名のみ
# を表示するようにした。
#
# フロアマップ風シートの追加（2026-10-02）: 「このような座席に名前を配置するようにすることは
# できますか」とS-02フロアマップのスクリーンショットを示された。縦軸座席・横軸日付の表は
# 複数日分を一度に見られる一方、物理的な座席の配置とは対応しないため、「今後複数日分を見られる
# こと」と「フロアマップに近い見た目にすること（1日分のみ）」はどちらかを選ぶ必要があることを
# 確認した上で、両方を別シートとして用意する方針とした（既存のマス目表はそのまま維持し、
# 本日分のみのフロアマップ風シートを追加する）。見た目の精密さは「座席番号・名前の配置のみ」
# （会議室・ロッカー・柱などの装飾や色分けは含めない）という回答を得た。座席1つ1つの画面上の
# 座標（frontend/src/components/FloorAreas.tsx・index.cssのCSS Grid定義）は本来フロントエンド
# 側にしかないため、_FLOOR_BLOCKSとしてPython側に手動で書き写した（backend/seed.pyのAREA_BLOCKS
# と同様、既存のフロントエンド⇔バックエンド間の重複と同じ考え方）。座席配置編集（S-07）で
# 自由配置された座席（pos_x設定済み）はこの固定レイアウトに含まれないため、エリアごとの表の末尾に
# 「追加座席」としてまとめて列挙する。
import os
from datetime import date as Date

from auth_helpers import CurrentUser
from database import ROOT_ENV

_WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"]


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key) or ROOT_ENV.get(key, default)


# GAS（gas/reservation_export.gs）からの呼び出しを認証する共有トークン
# （routers/export.pyのX-Export-Tokenヘッダと照合）。通常のセッションCookie認証は
# ブラウザでの対話的ログインが前提のため、GASのようなサーバー間呼び出しには使えない。
# ローカルは.env、本番は`fly secrets set`で設定する（CLAUDE.mdの接続文字列の扱いと同じく、
# 値自体をGitHubへpushしてはならない）
EXPORT_API_TOKEN = _env("EXPORT_API_TOKEN")

# このエクスポート専用の、権限チェックを通過させるためだけのダミー値。id=0は実在のuser.id
# （IDENTITY列、1始まり）と絶対に一致しないため、get_period_grid内の「自分」ラベル付与
# ロジックが誤発火することもない（このエクスポートに「呼び出した本人」という概念はない）
_SYSTEM_USER = CurrentUser(
    id=0, email="system@zaseki.internal", last_name="システム", first_name="自動反映",
    role="admin", area_manager_role=None, employment_type="employee",
    employment_status="active", is_system_operator=False,
)


def _date_header(date_iso: str) -> str:
    d = Date.fromisoformat(date_iso)
    return f"{d.month}/{d.day}（{_WEEKDAY_JA[d.weekday()]}）"


async def build_export_rows() -> list[list[str]]:
    """GAS（gas/reservation_export.gs）がスプレッドシートへ書き込む表を組み立てる。
    1行目が日付の見出し、2行目以降が座席ごとの行で、セルにその日の利用者名のみが入る
    （プロジェクト座席であってもプロジェクト名は併記しない、空欄はその日空いていることを表す）。
    A-69（期間ビュー）と全く同じデータソースを使い、氏名は匿名化しない（障害時に実際に参照できる
    必要があるため）。表示期間はRULE-05の予約可能期間（本日〜当月末または来月末）と同じ
    （A-69の既定と同じ考え方）。"""
    from routers.proxy import get_period_grid  # 循環import回避のため遅延import

    grid = await get_period_grid(start=None, end=None, area="all", admin_user=_SYSTEM_USER)
    dates = grid["dates"]
    rows: list[list[str]] = [["エリア", "座席番号"] + [_date_header(d) for d in dates]]
    for seat in grid["seats"]:
        row = [seat["area"], seat["seat_no"]]
        for date_iso in dates:
            day = seat["days"].get(date_iso)
            if day is None or day["status"] in ("free", "fixed_absent"):
                row.append("")
            else:
                row.append(day["user_name"] or "")
        rows.append(row)
    return rows


# S-02フロアマップ（frontend/src/components/FloorAreas.tsx）の固定レイアウトを手で書き写したもの。
# エリアごとに「列グループ」（0〜2、左から順）に属するブロックの一覧。各ブロックは縦に積み上げ、
# 列グループ同士は横に並べる（index.cssのgrid-template-areasの配置に対応: EAST・WESTはいずれも
# 列グループ0＝lockLの右隣、1＝中央の縦長ブロック、2＝lockRの左隣。NORTHはロッカー・柱など
# 座席以外の装飾が多いため列グループ0のみを使い、Bブロックの下にAブロックを積む）。
# "rows"は1マス目＝座席番号, 2マス目＝座席番号というように、1行に2席ずつ並べる（Noneは空マス）。
_FLOOR_BLOCKS: dict[str, list[dict]] = {
    "NORTH": [
        {"label": "Bブロック（ロッカー）", "col": 0, "rows": [["B1", "B5"], ["B2", "B6"], ["B3", "B7"], ["B4", "B8"]]},
        {"label": "Aブロック", "col": 0, "rows": [["A1", "A2", "A3", "A4", "A5", "A6"], [None, "A7", "A8", "A9", "A10", "A11"]]},
    ],
    "EAST": [
        {"label": "Cブロック", "col": 0, "rows": [["C1", "C2"], ["C3", "C4"]]},
        {"label": "Dブロック", "col": 0, "rows": [["D1", "D2"], ["D3", "D4"]]},
        {"label": "Eブロック", "col": 0, "rows": [["E1", "E2"], ["E3", "E4"]]},
        {"label": "Fブロック", "col": 1, "rows": [["F1", "F5"], ["F2", "F6"], ["F3", "F7"], ["F4", "F8"]]},
        {"label": "Gブロック", "col": 2, "rows": [["G1", "G2"], ["G3", "G4"]]},
        {"label": "Hブロック", "col": 2, "rows": [["H1", "H2"], ["H3", "H4"]]},
        {"label": "Iブロック", "col": 2, "rows": [["I1", "I2"], ["I3", "I4"]]},
    ],
    "WEST": [
        {"label": "Jブロック", "col": 0, "rows": [["J1", "J2"], ["J3", "J4"]]},
        {"label": "Kブロック", "col": 0, "rows": [["K1", "K2"], ["K3", "K4"]]},
        {"label": "Lブロック", "col": 0, "rows": [["L1", "L2"], ["L3", "L4"]]},
        {"label": "Mブロック", "col": 1, "rows": [["M1", "M5"], ["M2", "M6"], ["M3", "M7"], ["M4", "M8"]]},
        {"label": "Nブロック", "col": 2, "rows": [["N1", "N2"], ["N3", "N4"]]},
        {"label": "Oブロック", "col": 2, "rows": [["O1", "O2"], ["O3", "O4"]]},
        {"label": "Pブロック", "col": 2, "rows": [["P1", "P2"], ["P3", "P4"]]},
    ],
}
_FLOOR_COL_GROUP_WIDTH = 3  # 座席2列＋区切り余白1列


def _floor_cell_name(seat: dict, today_iso: str) -> str:
    day = seat["days"].get(today_iso)
    if day is None or day["status"] in ("free", "fixed_absent"):
        return ""
    return day["user_name"] or ""


def _build_floor_sheet(area: str, seats_by_no: dict[str, dict], today_iso: str) -> list[list[str]]:
    """1エリア分のフロアマップ風の表（本日分のみ）を組み立てる。各座席を「座席番号の行」
    「利用者名の行」の2行1組で、_FLOOR_BLOCKSの配置どおりに並べる。"""
    cells: dict[tuple[int, int], str] = {}
    row_cursor: dict[int, int] = {}
    placed_seat_nos: set[str] = set()

    for block in _FLOOR_BLOCKS[area]:
        base_col = block["col"] * _FLOOR_COL_GROUP_WIDTH
        r = row_cursor.get(block["col"], 0)
        cells[(r, base_col)] = block["label"]
        r += 1
        for tile_row in block["rows"]:
            for i, seat_no in enumerate(tile_row):
                if seat_no is None:
                    continue
                placed_seat_nos.add(seat_no)
                seat = seats_by_no.get(seat_no)
                cells[(r, base_col + i)] = seat_no
                cells[(r + 1, base_col + i)] = _floor_cell_name(seat, today_iso) if seat else ""
            r += 2
        row_cursor[block["col"]] = r + 1  # 次のブロックとの間に1行空ける

    # 座席配置編集（S-07）で自由配置された座席は固定レイアウトに無いため、列グループ0の末尾に列挙する
    extra_seat_nos = sorted(no for no in seats_by_no if no not in placed_seat_nos)
    if extra_seat_nos:
        r = row_cursor.get(0, 0)
        cells[(r, 0)] = "追加座席"
        r += 1
        for i in range(0, len(extra_seat_nos), 2):
            for j, seat_no in enumerate(extra_seat_nos[i:i + 2]):
                cells[(r, j)] = seat_no
                cells[(r + 1, j)] = _floor_cell_name(seats_by_no[seat_no], today_iso)
            r += 2

    if not cells:
        return []
    max_row = max(r for r, _ in cells) + 1
    max_col = max(c for _, c in cells) + 1
    grid = [["" for _ in range(max_col)] for _ in range(max_row)]
    for (r, c), value in cells.items():
        grid[r][c] = value
    return grid


async def build_floor_sheets() -> dict[str, list[list[str]]]:
    """GAS（gas/reservation_export.gs）がスプレッドシートへ書き込む、本日分のみのフロアマップ風の
    表をエリアごとに組み立てる。build_export_rows()と同じデータソース（A-69の期間ビュー）を使うが、
    こちらは複数日分ではなく本日（dates[0]）1日分のみを対象に、座席番号・利用者名を実際の
    フロアマップの配置（_FLOOR_BLOCKS）どおりに並べる（会議室・ロッカー・柱などの装飾、色分けは
    含めない）。戻り値は{"NORTH": [[...], ...], "EAST": [...], "WEST": [...]}。"""
    from routers.proxy import get_period_grid  # 循環import回避のため遅延import

    grid = await get_period_grid(start=None, end=None, area="all", admin_user=_SYSTEM_USER)
    today_iso = grid["dates"][0]
    seats_by_no_by_area: dict[str, dict[str, dict]] = {"NORTH": {}, "EAST": {}, "WEST": {}}
    for seat in grid["seats"]:
        seats_by_no_by_area.setdefault(seat["area"], {})[seat["seat_no"]] = seat

    return {
        area: _build_floor_sheet(area, seats_by_no_by_area.get(area, {}), today_iso)
        for area in _FLOOR_BLOCKS
    }
