# A-59・A-60・A-88 フィードバック（S-13ヘルプ「フィードバック」タブ・S-14一覧）。詳細設計書3.14節
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


@router.get("/count")
async def count_feedback(user: CurrentUser = Depends(require_system_operator)):
    """A-88: フィードバックの未読件数（S-14・サイドバー）。当初は総件数を返していたが、
    「これフィードバック開いたら件数が消えるようにしたい」との要望を受け、呼び出し者本人が
    フィードバック一覧（A-60）を最後に開いた日時（users.feedback_last_viewed_at）より後に
    送信された件数のみを返すよう変更した（2026-09-25修正）。一度も開いたことがない
    （feedback_last_viewed_atがNULL）場合は全件を未読として数える。一覧を開く（A-60）たびに
    その日時が更新されるため、一覧を開いた直後はこのバッジが消え、以後に届いた分だけ再び現れる。"""
    count = await get_pool().fetchval(
        """SELECT COUNT(*) FROM feedback f, users u
           WHERE u.id = $1 AND (u.feedback_last_viewed_at IS NULL OR f.created_at > u.feedback_last_viewed_at)""",
        user.id,
    )
    return {"count": count}


@router.get("")
async def list_feedback(user: CurrentUser = Depends(require_system_operator)):
    """A-60: フィードバック一覧（S-14、システム運用担当のみ）。新しい順。role='admin'（管理部）
    ではなく、is_system_operator（P-SYSOP）で判定する（2026-09-01訂正。「管理部ではなく
    システムを運用している人に見れるようにしてほしい」との要望を受けた）。呼び出し（＝一覧を開いた
    タイミング）ごとにusers.feedback_last_viewed_atを更新し、A-88の未読件数バッジがここで消える
    ようにする（2026-09-25追加。「フィードバック開いたら件数が消えるようにしたい」との要望）。"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT f.id, f.category, f.content, f.created_at, u.last_name, u.first_name
           FROM feedback f JOIN users u ON u.id = f.user_id
           ORDER BY f.created_at DESC"""
    )
    await pool.execute("UPDATE users SET feedback_last_viewed_at = now() WHERE id = $1", user.id)
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
