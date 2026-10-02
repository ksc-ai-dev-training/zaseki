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
