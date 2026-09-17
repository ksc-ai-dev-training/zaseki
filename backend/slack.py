# Slack Incoming Webhook通知の送信（FR-03-9）。詳細設計書3.9節・3.12節参照
import httpx

from database import get_setting

# 通知設定タブ（S-08）でUI編集可能なapp_settingsのキー。roles.pyのEDITABLE_SETTING_KEYSと同一の値
SLACK_WEBHOOK_SETTING_KEY = "project_seat_slack_webhook_url"

# 通知文言（app_settings、通知設定タブから編集可能。2026-09-02追加。「実際の通知の文言を編集できる
# 機能を追加してほしい」との要望を受けた。従来はproject_seats.pyの各エンドポイントにf-stringで
# 直接埋め込んでいた文言を、テンプレート文字列としてapp_settingsへ切り出した）。{}内はPythonの
# str.format()で埋め込むプレースホルダーで、対応するキーワード引数を渡さずに送信すると埋め込みに
# 失敗するため、その場合は初期文言にフォールバックする（render_slack_message参照）。
# アンケート送信時の文言（project_seat_slack_message_survey）は、2026-09-03の変更B（検討資料
# 「プロジェクト座席・曜日調整フロー改善案」）でA-41・A-63〔システムによるアンケート送信通知〕自体を
# 廃止したことに伴い削除した（エリア責任者が自分でSlackへ連絡する運用に変更）。
SLACK_MESSAGE_REMINDER_KEY = "project_seat_slack_message_reminder"
SLACK_MESSAGE_FINALIZE_HEADER_KEY = "project_seat_slack_message_finalize_header"
# 座席の島の割当が決まった（status→'seats_allocated'）時の通知文言。2026-09-16新設（「座席の割り当て、
# 曜日確定が決まったときスラックに通知されるのをオン/オフ切り替えてほしい」との要望を受けた際、
# 座席の島の割当は従来Slack通知していなかったことが判明し、あわせて新規に自動通知を追加した）
SLACK_MESSAGE_SEAT_BLOCK_HEADER_KEY = "project_seat_slack_message_seat_block_header"

# 通知の種類ごとのオン/オフスイッチ（app_settings、値は'true'/'false'の文字列。2026-09-16追加）。
# 未設定（初回）は'true'扱い＝従来どおり通知する。is_notification_enabled参照
SLACK_NOTIFY_FINALIZE_KEY = "project_seat_slack_notify_finalize"
SLACK_NOTIFY_SEAT_BLOCK_KEY = "project_seat_slack_notify_seat_block"

DEFAULT_MESSAGE_REMINDER = "リマインド: 「{project_name}」の出社曜日アンケートが未回答です。ご回答をお願いします。"
DEFAULT_MESSAGE_FINALIZE_HEADER = "出社曜日を確定しました。"
DEFAULT_MESSAGE_SEAT_BLOCK_HEADER = "座席の島を割り当てました。"


async def is_notification_enabled(key: str) -> bool:
    """通知設定タブ（S-08）のオン/オフスイッチを見て、その種類の自動Slack通知を送るべきか判定する。
    値は'true'/'false'の文字列（app_settings）で、未設定（初回）は'true'扱いとする（2026-09-16追加。
    「座席の割り当て、曜日確定が決まったときスラックに通知されるのをオン/オフ切り替えてほしい」
    との要望を受けた。既存の全体スイッチであるWebhook URL自体は変更せず、これとは別に通知の種類
    ごとに一時的に止められるようにする狙い）。"""
    return (await get_setting(key)) != "false"


async def render_slack_message(key: str, default: str, **kwargs: str) -> str:
    """通知設定タブ（S-08）で編集した通知文言（app_settings）を取得し、{project_name}等の
    プレースホルダーへkwargsを埋め込んで返す。未設定（初回）はdefaultをそのまま使う。編集後の文言に
    誤って存在しないプレースホルダーを書いてしまった等でstr.format()が失敗した場合も、通知はあくまで
    付随的な処理のため業務処理自体は失敗させず、defaultへフォールバックする（2026-09-02追加）。"""
    template = await get_setting(key) or default
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError, ValueError):
        return default.format(**kwargs)


async def send_slack_notification(text: str) -> None:
    """T-16.project_seat_slack_webhook_urlへtextを投稿する。未設定時は何もしない（FR-03-9）。
    送信失敗（Slack側の障害・不正なURL等）はログ出力のみで、呼び出し元の業務処理（アンケート送信・
    リマインド・曜日確定）は失敗させない。通知はあくまで付随的な処理であり、これが失敗したことを
    理由に主操作自体を失敗扱いにするべきではないため（2026-08-28追加）。"""
    webhook_url = await get_setting(SLACK_WEBHOOK_SETTING_KEY)
    if not webhook_url:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(webhook_url, json={"text": text})
            response.raise_for_status()
    except Exception as e:
        print(f"Slack通知の送信に失敗しました: {e}")
