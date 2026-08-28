# Slack Incoming Webhook通知の送信（FR-03-9）。詳細設計書3.9節・3.12節参照
import httpx

from database import get_setting

# 通知設定タブ（S-08）でUI編集可能なapp_settingsのキー。roles.pyのEDITABLE_SETTING_KEYと同一の値
SLACK_WEBHOOK_SETTING_KEY = "project_seat_slack_webhook_url"


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
