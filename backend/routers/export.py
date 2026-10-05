# 障害時バックアップ用、予約状況のスプレッドシートへの反映（GAS連携）。詳細設計書3.14節参照
from fastapi import APIRouter, Header, HTTPException, Query

import reservation_export

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/reservations")
async def export_reservations(
    x_export_token: str | None = Header(default=None),
    date: str | None = Query(default=None, description="floor_sheetsの対象日（YYYY-MM-DD）。省略時・予約可能期間外の場合は本日になる"),
):
    """GAS（Google Apps Script、gas/reservation_export.gs）が時間主導トリガーで定期的に
    呼び出し、返ってきた行をスプレッドシートへ書き込む（書き込み自体はGAS側で行う「pull」方式。
    reservation_export.pyのモジュールコメント参照）。通常のセッションCookie認証はブラウザでの
    対話的ログインが前提のためGASからは使えず、固定の共有トークン（EXPORT_API_TOKEN）で
    認証する。未設定の環境ではエンドポイント自体を404にして存在を隠す（dev-loginと同じ考え方）。
    rowsは複数日分の座席×日付マス目表、floor_sheetsは1日分のみのフロアマップ風の表
    （エリア名→{"rows": 表示文字列の表, "kinds": 色分け用の区分の表}、2026-10-02追加）、
    floor_sheets_dateはfloor_sheetsが実際にどの日付のものかを表す（dateクエリパラメータが
    未指定・範囲外の場合は本日にフォールバックするため、呼び出し側はこの値を見れば実際に
    使われた日付がわかる。2026-10-05追加）。"""
    if not reservation_export.EXPORT_API_TOKEN:
        raise HTTPException(404, detail="Not Found")
    if x_export_token != reservation_export.EXPORT_API_TOKEN:
        raise HTTPException(403, detail="Forbidden")
    rows = await reservation_export.build_export_rows()
    floor_sheets_date, floor_sheets = await reservation_export.build_floor_sheets(date)
    return {"rows": rows, "floor_sheets": floor_sheets, "floor_sheets_date": floor_sheets_date}
