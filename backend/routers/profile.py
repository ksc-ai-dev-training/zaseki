# A-56・A-57 マイプロフィール（S-12）。詳細設計書3.13節。要件定義書4.8節・FR-08-1〜4
import base64
import calendar
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/users/me/profile", tags=["profile"])

# 外部ストレージを使わない簡易実装のため、アップロード画像はdata URL（Base64）のままDBに保存する。
# 際限なく肥大化しないよう、デコード後のバイト数に上限を設ける（2026-08-31追加）
MAX_AVATAR_BYTES = 300 * 1024
_AVATAR_DATA_URL_RE = re.compile(r"^data:image/(png|jpe?g|gif|webp);base64,(?P<data>.+)$", re.DOTALL)


def _validate_avatar_image(value: str | None) -> None:
    if value is None:
        return
    m = _AVATAR_DATA_URL_RE.match(value)
    if not m:
        raise HTTPException(400, detail="画像はJPEG・PNG・GIF・WebP形式でアップロードしてください")
    try:
        decoded = base64.b64decode(m.group("data"), validate=True)
    except Exception:
        raise HTTPException(400, detail="画像はJPEG・PNG・GIF・WebP形式でアップロードしてください")
    if len(decoded) > MAX_AVATAR_BYTES:
        raise HTTPException(400, detail="画像は300KB以下のファイルを選択してください")


def _validate_birthday(birth_month: int | None, birth_day: int | None) -> None:
    if birth_month is None and birth_day is None:
        return
    if birth_month is None or birth_day is None:
        raise HTTPException(400, detail="生年月日は月・日をどちらも指定してください")
    if not (1 <= birth_month <= 12):
        raise HTTPException(400, detail="月は1〜12の範囲で指定してください")
    # 年を保存しないため、うるう年（2028年）を基準に日数の上限を判定する（2/29を許容するため）
    max_day = calendar.monthrange(2028, birth_month)[1]
    if not (1 <= birth_day <= max_day):
        raise HTTPException(400, detail=f"{birth_month}月は1〜{max_day}日の範囲で指定してください")


class ProfileUpdate(BaseModel):
    avatar_image: str | None
    birth_month: int | None
    birth_day: int | None


def _row_to_profile(row) -> dict:
    return {
        "avatar_image": row["avatar_image"],
        "birth_month": row["birth_month"],
        "birth_day": row["birth_day"],
    }


@router.get("")
async def get_my_profile(user: CurrentUser = Depends(require_auth)):
    """A-56: 自分のプロフィール（アイコン・生年月日）を取得する。"""
    row = await get_pool().fetchrow(
        "SELECT avatar_image, birth_month, birth_day FROM users WHERE id = $1", user.id
    )
    return _row_to_profile(row)


@router.put("")
async def update_my_profile(body: ProfileUpdate, user: CurrentUser = Depends(require_auth)):
    """A-57: 自分のプロフィール（アイコン・生年月日）を更新する。いずれの項目も任意で、
    nullを渡すと未設定に戻せる（FR-08-1・FR-08-2）。他人の行は更新できない（本人のみ）。"""
    _validate_avatar_image(body.avatar_image)
    _validate_birthday(body.birth_month, body.birth_day)
    row = await get_pool().fetchrow(
        """UPDATE users SET avatar_image = $1, birth_month = $2, birth_day = $3, updated_at = now()
           WHERE id = $4
           RETURNING avatar_image, birth_month, birth_day""",
        body.avatar_image, body.birth_month, body.birth_day, user.id,
    )
    return _row_to_profile(row)
