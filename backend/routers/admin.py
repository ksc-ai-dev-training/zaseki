# A-51 管理メニュー（S-06）。詳細設計書3.6節
from fastapi import APIRouter, Depends

from auth_helpers import require_roles
from database import get_pool

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/summary")
async def get_summary(_=Depends(require_roles("admin"))):
    """A-51: 他画面への入口カード上部に表示するサマリー（総座席数・稼働エリア数・登録利用者数・管理部人数）"""
    pool = get_pool()
    return {
        "total_seats": await pool.fetchval("SELECT count(*) FROM seats WHERE status = 'active'"),
        "active_areas": await pool.fetchval("SELECT count(DISTINCT area_id) FROM seats WHERE status = 'active'"),
        "registered_users": await pool.fetchval("SELECT count(*) FROM users WHERE deleted_at IS NULL"),
        "admin_count": await pool.fetchval("SELECT count(*) FROM users WHERE role = 'admin' AND deleted_at IS NULL"),
    }
