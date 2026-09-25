# A-56・A-57 マイプロフィール（S-12）。詳細設計書3.13節。要件定義書4.8節・FR-08-1〜4
# A-87 他利用者のプロフィール閲覧（S-02、2026-09-25追加）
import base64
import calendar
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/users/me/profile", tags=["profile"])
# 他利用者のプロフィール閲覧用（A-87）。/api/users/me/profileとパスが競合しないよう別ルーターに分ける
public_router = APIRouter(prefix="/api/users", tags=["profile"])

MAX_HOBBY_LENGTH = 200

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
    hobby: str | None = None


def _validate_hobby(value: str | None) -> None:
    if value is not None and len(value) > MAX_HOBBY_LENGTH:
        raise HTTPException(400, detail=f"趣味は{MAX_HOBBY_LENGTH}文字以内で入力してください")


def _row_to_profile(row) -> dict:
    return {
        "avatar_image": row["avatar_image"],
        "birth_month": row["birth_month"],
        "birth_day": row["birth_day"],
        "hobby": row["hobby"],
    }


@router.get("")
async def get_my_profile(user: CurrentUser = Depends(require_auth)):
    """A-56: 自分のプロフィール（アイコン・生年月日・趣味）を取得する。"""
    row = await get_pool().fetchrow(
        "SELECT avatar_image, birth_month, birth_day, hobby FROM users WHERE id = $1", user.id
    )
    return _row_to_profile(row)


@router.put("")
async def update_my_profile(body: ProfileUpdate, user: CurrentUser = Depends(require_auth)):
    """A-57: 自分のプロフィール（アイコン・生年月日・趣味）を更新する。いずれの項目も任意で、
    nullを渡すと未設定に戻せる（FR-08-1・FR-08-2）。他人の行は更新できない（本人のみ）。"""
    _validate_avatar_image(body.avatar_image)
    _validate_birthday(body.birth_month, body.birth_day)
    _validate_hobby(body.hobby)
    row = await get_pool().fetchrow(
        """UPDATE users SET avatar_image = $1, birth_month = $2, birth_day = $3, hobby = $4, updated_at = now()
           WHERE id = $5
           RETURNING avatar_image, birth_month, birth_day, hobby""",
        body.avatar_image, body.birth_month, body.birth_day, body.hobby, user.id,
    )
    return _row_to_profile(row)


@public_router.get("/{user_id}/profile")
async def get_user_profile(user_id: int, _user: CurrentUser = Depends(require_auth)):
    """A-87: 他利用者のプロフィールを閲覧する（読み取り専用）。「座席表で名前が入っている座席を
    押したときプロフィールが出てくるようにしたい」との要望を受けた（S-02）。氏名・所属・
    マイプロフィール（S-12）で本人が任意で登録したアイコン・生年月日・趣味を返す。メールアドレス・
    在籍状況等の管理情報は含めない（社内向けの軽い自己紹介目的のため）。退職済み（employment_status=
    'retired'）・削除済みの利用者は404にする（座席表には表示され得ないため実運用上は起こらないが、
    念のため直接IDを指定された場合に備える）。"""
    row = await get_pool().fetchrow(
        """SELECT last_name, first_name, role, avatar_image, birth_month, birth_day, hobby
           FROM users WHERE id = $1 AND deleted_at IS NULL AND employment_status != 'retired'""",
        user_id,
    )
    if row is None:
        raise HTTPException(404, detail="利用者が見つかりません")
    return {
        "last_name": row["last_name"],
        "first_name": row["first_name"],
        "role": row["role"],
        "avatar_image": row["avatar_image"],
        "birth_month": row["birth_month"],
        "birth_day": row["birth_day"],
        "hobby": row["hobby"],
    }
