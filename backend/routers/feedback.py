# A-59・A-60 フィードバック（S-13ヘルプ「フィードバック」タブ・S-14一覧）。詳細設計書3.14節
# 要件定義書4.9節、FR-09-2・FR-09-3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth, require_system_operator
from database import get_pool

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

CATEGORY_JA = {"bug": "不具合報告", "request": "改善要望", "other": "その他"}


class FeedbackCreate(BaseModel):
    category: Literal["bug", "request", "other"]
    content: str


@router.post("")
async def submit_feedback(body: FeedbackCreate, user: CurrentUser = Depends(require_auth)):
    """A-59: ヘルプ画面からのフィードバック送信（FR-09-2）。分類（不具合報告／改善要望／その他）＋
    自由記述。送信者本人・分類・日時とともに保存するのみで、Slack通知等は行わない（管理部が
    一覧〔A-60〕で随時確認する運用のため）。"""
    content = body.content.strip()
    if not content:
        raise HTTPException(400, detail="内容を入力してください")
    if len(content) > 2000:
        raise HTTPException(400, detail="内容は2000文字以内で入力してください")
    await get_pool().execute(
        "INSERT INTO feedback (user_id, category, content) VALUES ($1, $2, $3)",
        user.id, body.category, content,
    )
    return {"detail": "フィードバックを送信しました"}


@router.get("")
async def list_feedback(_: CurrentUser = Depends(require_system_operator)):
    """A-60: フィードバック一覧（S-14、システム運用担当のみ）。新しい順。role='admin'（管理部）
    ではなく、is_system_operator（P-SYSOP）で判定する（2026-09-01訂正。「管理部ではなく
    システムを運用している人に見れるようにしてほしい」との要望を受けた）。"""
    rows = await get_pool().fetch(
        """SELECT f.id, f.category, f.content, f.created_at, u.last_name, u.first_name
           FROM feedback f JOIN users u ON u.id = f.user_id
           ORDER BY f.created_at DESC"""
    )
    return {
        "items": [
            {
                "id": r["id"],
                "category": r["category"],
                "category_ja": CATEGORY_JA[r["category"]],
                "content": r["content"],
                "created_at": r["created_at"].isoformat(),
                "name": f"{r['last_name']} {r['first_name']}",
            }
            for r in rows
        ]
    }
