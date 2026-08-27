# JWT発行/検証、認証ヘルパー（詳細設計書 5章）
import os
import time
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, Request

from database import APP_ENV, get_pool

_DEV_SECRET = "dev-secret-change-me"
JWT_SECRET = os.environ.get("JWT_SECRET", _DEV_SECRET)
if APP_ENV == "production" and JWT_SECRET == _DEV_SECRET:
    # 開発用の既定鍵のまま本番起動するとセッションを偽造できてしまうため、起動時に落とす
    raise RuntimeError("APP_ENV=production では JWT_SECRET の設定が必須です")
JWT_EXPIRES_SECONDS = int(os.environ.get("JWT_EXPIRES_SECONDS", str(12 * 3600)))
SESSION_COOKIE = "zaseki_session"
# 本番（HTTPS）ではセッションCookieに Secure 属性を付与する
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1" if APP_ENV == "production" else "0") == "1"


@dataclass
class CurrentUser:
    id: int
    email: str
    last_name: str
    first_name: str
    role: str
    area_manager_role: str | None
    employment_type: str
    employment_status: str


def issue_jwt(user_id: int, role: str) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "role": role, "iat": now, "exp": now + JWT_EXPIRES_SECONDS}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def verify_jwt(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, detail="認証が必要です")


async def require_auth(request: Request) -> CurrentUser:
    token = request.cookies.get(SESSION_COOKIE)
    if token is None:
        raise HTTPException(401, detail="認証が必要です")
    payload = verify_jwt(token)
    row = await get_pool().fetchrow(
        """SELECT id, email, last_name, first_name, role, area_manager_role,
                  employment_type, employment_status, deleted_at
           FROM users WHERE id = $1""",
        int(payload["sub"]),
    )
    # RULE-06: 退職済み（論理削除済み）の利用者はログイン状態であっても以後拒否する
    if row is None or row["deleted_at"] is not None:
        raise HTTPException(401, detail="認証が必要です")
    return CurrentUser(
        id=row["id"], email=row["email"], last_name=row["last_name"], first_name=row["first_name"],
        role=row["role"], area_manager_role=row["area_manager_role"],
        employment_type=row["employment_type"], employment_status=row["employment_status"],
    )


def require_roles(*roles: str):
    async def checker(user: CurrentUser = Depends(require_auth)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(403, detail="この操作を行う権限がありません")
        return user
    return checker
