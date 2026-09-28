# A-89 座席状況のリアルタイム反映（S-02）。詳細設計書3.3節
#
# 「席の予約がされたときリアルタイムですぐに反映されるようになっているか」との質問を受け、
# 当初はSWRのポーリング（フロントエンド側で1秒間隔に定期再取得）で対応していたが、続けて
# 「もっとすぐに反映することは可能か」との質問を受け、WebSocketによる即時プッシュへ切り替える
# 試験導入を行った（2026-09-28）。
#
# 実際の座席データはこのモジュールでは一切扱わない。各クライアントへは「何かが変わったので
# 空き状況を取り直してください」という空の合図（invalidateメッセージ）を送るだけで、実データは
# 引き続き既存のREST API（A-06・A-07）から取得させる。これにより、座席状況の算出ロジック
# （project_blocked_seats・multi_seat_holder等、3.3節・3.9節参照）をこのモジュールへ複製する
# 必要がなく、既存の権限チェック・キャッシュの仕組みもそのまま使える。
#
# Fly.io上は本アプリを1マシンのみで運用しているため（fly.toml参照）、プロセス内メモリでの
# 接続管理・ブロードキャストで足りる。複数マシン構成にする場合はRedis Pub/Sub等への切替が必要。
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.active.discard(websocket)

    async def broadcast_availability_changed(self) -> None:
        """座席の空き状況に影響しうる変更があったことを、接続中の全クライアントへ通知する
        （main.pyのミドルウェアから、対象パスへの書き込み系リクエストが成功するたびに呼ばれる）。
        送信に失敗した接続（切断済み等）はこの場で取り除く。"""
        dead: list[WebSocket] = []
        for ws in self.active:
            try:
                await ws.send_text("availability_changed")
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.discard(ws)


manager = ConnectionManager()
