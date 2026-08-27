# A-01〜A-05 認証系API（詳細設計書 3.2節）。ローカル開発では Google OAuth の代わりに dev-login を使う
import os
import secrets

import google_auth
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from auth_helpers import COOKIE_SECURE, SESSION_COOKIE, CurrentUser, issue_jwt, require_auth
from database import APP_ENV, get_pool

router = APIRouter(prefix="/api/auth", tags=["auth"])

GOOGLE_CLIENT_ID = google_auth.GOOGLE_CLIENT_ID
# Google OAuth 未設定時は開発用ログインを有効にする（DEV_AUTH=0 で明示無効化）。
# ただし APP_ENV=production では DEV_AUTH=1 を指定しても常に無効。
DEV_AUTH = (
    APP_ENV != "production"
    and os.environ.get("DEV_AUTH", "0" if GOOGLE_CLIENT_ID else "1") == "1"
)


def _login_error_redirect(reason: str) -> RedirectResponse:
    """S-01 にエラー種別を伝えて戻す。詳細はログに残し、画面には種別のみ渡す（詳細設計書6.2節）"""
    res = RedirectResponse(f"/login?error={reason}", status_code=302)
    res.delete_cookie(google_auth.STATE_COOKIE, path="/")
    return res


@router.get("/login")
async def login(request: Request):
    """A-01: Google OAuth 2.0 の認可URLへリダイレクトする"""
    if not google_auth.is_configured():
        raise HTTPException(
            501, detail="Google OAuth が未設定です（開発中は dev-login を使用してください）"
        )
    state = google_auth.new_state()
    url = google_auth.build_auth_url(state, google_auth.redirect_uri_for(request))
    response = RedirectResponse(url, status_code=302)
    # state は短命Cookieに保存し、コールバックで照合する（CSRF対策）
    response.set_cookie(
        google_auth.STATE_COOKIE, state, httponly=True, samesite="lax", path="/",
        secure=COOKIE_SECURE, max_age=google_auth.STATE_MAX_AGE,
    )
    return response


@router.get("/callback")
async def callback(request: Request, code: str | None = None, state: str | None = None):
    """A-02: OAuthコールバック。

    state照合 → トークン交換 → IDトークン検証 → ドメイン検証（NFR-01） →
    ユーザー登録/取得 → 退職済み確認（RULE-06） → JWT発行 → / へリダイレクト。
    """
    if not google_auth.is_configured():
        raise HTTPException(501, detail="Google OAuth が未設定です")

    # 1. state をCookie保存値と照合（不一致は不正リクエストとして拒否）
    expected = request.cookies.get(google_auth.STATE_COOKIE)
    if not code or not state or not expected or not secrets.compare_digest(state, expected):
        return _login_error_redirect("invalid_request")

    # 2. code をIDトークンに交換し、署名・発行者・audience を検証
    try:
        token = await google_auth.exchange_code(code, google_auth.redirect_uri_for(request))
        claims = google_auth.verify_id_token(token["id_token"])
    except Exception:
        return _login_error_redirect("invalid_request")

    email = (claims.get("email") or "").lower()
    # メール未確認のアカウントは他人のアドレスを騙れるため拒否する
    if not claims.get("email_verified", False):
        return _login_error_redirect("invalid_request")

    # 3. ドメイン検証（NFR-01）
    if not google_auth.verify_domain(email):
        return _login_error_redirect("domain")

    last_name = claims.get("family_name") or email.split("@")[0]
    first_name = claims.get("given_name") or ""

    # 4. users を email で検索。無ければ role='general' で自動登録（初回ログイン、D4）
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT id, role, deleted_at FROM users WHERE lower(email) = $1", email
    )
    if row is None:
        row = await pool.fetchrow(
            """INSERT INTO users (email, last_name, first_name)
               VALUES ($1, $2, $3) RETURNING id, role, deleted_at""",
            email, last_name, first_name,
        )
    elif row["deleted_at"] is not None:
        # 5. 退職済み（論理削除済み）の利用者はログイン拒否（RULE-06）
        return _login_error_redirect("retired")

    # 6. セッションJWTを HttpOnly Cookie に設定して / へ戻す
    token_jwt = issue_jwt(row["id"], row["role"])
    response = RedirectResponse("/", status_code=302)
    response.set_cookie(
        SESSION_COOKIE, token_jwt, httponly=True, samesite="lax", path="/", secure=COOKIE_SECURE
    )
    response.delete_cookie(google_auth.STATE_COOKIE, path="/")
    return response


class DevLoginRequest(BaseModel):
    email: str


@router.post("/dev-login")
async def dev_login(body: DevLoginRequest, response: Response):
    """A-03: 開発用ログイン（Google認証の代替）。登録済みメールアドレスでJWTを発行する。本番では無効。"""
    if not DEV_AUTH:
        raise HTTPException(404, detail="Not Found")
    row = await get_pool().fetchrow(
        "SELECT id, role, deleted_at FROM users WHERE email = $1", body.email
    )
    if row is None:
        raise HTTPException(403, detail="登録されていないユーザーです（seed.py を実行してください）")
    if row["deleted_at"] is not None:
        raise HTTPException(403, detail="このアカウントは現在利用できません。心当たりがない場合は管理部にお問い合わせください")
    token = issue_jwt(row["id"], row["role"])
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", path="/", secure=COOKIE_SECURE
    )
    return {"detail": "ログインしました"}


@router.get("/dev-users")
async def dev_users():
    """開発用: ログイン可能なユーザー一覧（S-01 のアカウント選択に使用）。本番では無効。"""
    if not DEV_AUTH:
        raise HTTPException(404, detail="Not Found")
    rows = await get_pool().fetch(
        """SELECT email, last_name, first_name, role FROM users
           WHERE deleted_at IS NULL ORDER BY id"""
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/logout")
async def logout(response: Response, user: CurrentUser = Depends(require_auth)):
    # A-04: セッションCookie破棄
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"detail": "ログアウトしました"}


@router.get("/me")
async def me(user: CurrentUser = Depends(require_auth)):
    # A-05: ログイン中ユーザー情報。所属プロジェクト等（T-05/T-06）は該当画面の実装時に追加する
    return {
        "id": user.id,
        "email": user.email,
        "last_name": user.last_name,
        "first_name": user.first_name,
        "role": user.role,
        "area_manager_role": user.area_manager_role,
        "employment_type": user.employment_type,
        "employment_status": user.employment_status,
    }
