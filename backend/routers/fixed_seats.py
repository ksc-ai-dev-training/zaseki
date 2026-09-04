# A-19, A-20, A-21, A-52 固定座席の指定（S-05）。詳細設計書3.5節
from datetime import date as Date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import close_fixed_seat_assignment, get_pool, release_expired_fixed_seats, users_with_current_project_seat

router = APIRouter(prefix="/api/fixed-seat-assignments", tags=["fixed-seat-assignments"])


@router.get("")
async def list_assignments(_: CurrentUser = Depends(require_roles("admin"))):
    """A-19: 固定座席の割当一覧（現在の割当パネル）"""
    await release_expired_fixed_seats()
    rows = await get_pool().fetch(
        """SELECT fsa.seat_id, s.seat_no, a.name AS area_name, u.id AS user_id, u.last_name, u.first_name,
                  fsa.valid_until
           FROM fixed_seat_assignments fsa
           JOIN seats s ON s.id = fsa.seat_id
           JOIN areas a ON a.id = s.area_id
           JOIN users u ON u.id = fsa.user_id
           WHERE fsa.ended_on IS NULL
           ORDER BY CASE a.name WHEN 'NORTH' THEN 1 WHEN 'EAST' THEN 2 WHEN 'WEST' THEN 3 END, s.seat_no"""
    )
    return {
        "items": [
            {
                "seat_id": r["seat_id"], "seat_no": r["seat_no"], "area": r["area_name"],
                "user_id": r["user_id"], "user_name": f"{r['last_name']} {r['first_name']}",
                "valid_until": r["valid_until"].isoformat() if r["valid_until"] else None,
            }
            for r in rows
        ]
    }


@router.get("/candidates")
async def list_candidates(q: str = "", _: CurrentUser = Depends(require_roles("admin"))):
    """A-52: 新しく固定座席を指定する対象者検索（固定座席を持たない利用者、氏名の部分一致）。
    2026-08-27追加。詳細設計書3.5節にはA-19・A-20・A-21のみ定義されていたが、4.4節が明記する
    「一覧には固定座席を持たない利用者のみを表示する」検索の裏付けとなるAPIが欠けていたため新設した。
    一覧は固定座席を持たない利用者のみなので座席利用状況は必ず'free'／'project'のいずれか
    （2026-08-28、current_statusを'free'|'fixed'|'project'の3区分〔SeatTypeと同じ値〕へ変更。
    従来はプロジェクト座席の利用状況を区別せず一律の文言を返していたが、T-05〜T-07の実装により
    本日時点で実際にプロジェクト座席を利用中かどうかを区別できるようになったため）。"""
    rows = await get_pool().fetch(
        """SELECT u.id, u.last_name, u.first_name
           FROM users u
           LEFT JOIN fixed_seat_assignments fsa ON fsa.user_id = u.id AND fsa.ended_on IS NULL
           WHERE u.deleted_at IS NULL AND fsa.seat_id IS NULL
             AND ($1 = '' OR (u.last_name || u.first_name) ILIKE '%' || $1 || '%')
           ORDER BY u.last_name, u.first_name""",
        q,
    )
    pj_user_ids = await users_with_current_project_seat()
    return {
        "items": [
            {
                "user_id": r["id"],
                "user_name": f"{r['last_name']} {r['first_name']}",
                "current_status": "project" if r["id"] in pj_user_ids else "free",
            }
            for r in rows
        ]
    }


class FixedSeatAssign(BaseModel):
    seat_id: int
    user_id: int
    # 任意の有効期限（FR-01-5、2026-08-28追加）。未指定（None）は従来どおり無期限。
    valid_until: Date | None = None


@router.post("")
async def assign(body: FixedSeatAssign, user: CurrentUser = Depends(require_roles("admin"))):
    """A-20: 座席タイプを問わず、座席を利用者の固定座席として割り当てる（S-02のフロアマップから
    座席タイプを問わず選べる、2026-08-27訂正）。割り当てと同時にseat_type='fixed'に変更し、
    以後の予約有無に基づく判定（A-06）を恒久割当ベースに切り替える。当該座席に残っている
    今後の通常予約（T-08）は割当と矛盾するため取り消す。対象者が既に別の固定座席を持つ場合は
    そちらを解除してから割り当てる（1人1固定座席、S-05の「座席を変更する」もこのAPIで表現する）。
    valid_untilを指定した場合、その日を過ぎるとrelease_expired_fixed_seats()により自動的に
    フリー座席へ戻る（2026-08-28追加）。RULE-07（固定座席利用者はフリー座席を予約不可）は新規予約側
    （A-09・A-18・A-47）では検証済みだったが、既にフリー座席・プロジェクト座席の予約（周期予約含む）
    を持つ利用者へ後から固定座席を指定した場合の逆方向が抜けており、両方の座席を保持できてしまう
    不具合があったため、対象者の他の今後の予約（新しい固定座席自体を除く）もあわせて取り消す
    （2026-08-28修正）。"""
    pool = get_pool()
    if body.valid_until is not None and body.valid_until <= Date.today():
        raise HTTPException(400, detail="有効期限は明日以降の日付を指定してください")
    seat = await pool.fetchrow("SELECT id, seat_type, status FROM seats WHERE id = $1", body.seat_id)
    if seat is None or seat["status"] != "active":
        raise HTTPException(404, detail="対象が見つかりません")
    if seat["seat_type"] == "fixed":
        already = await pool.fetchval(
            "SELECT 1 FROM fixed_seat_assignments WHERE seat_id = $1 AND ended_on IS NULL", body.seat_id
        )
        if already:
            raise HTTPException(409, detail="この座席は既に割り当てられています")
    target = await pool.fetchrow("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", body.user_id)
    if target is None:
        raise HTTPException(404, detail="対象が見つかりません")

    async with pool.acquire() as conn:
        async with conn.transaction():
            # 対象者が既に別の固定座席を持つ場合、履歴を残したままその割当を終了させる
            # （物理DELETEはしない。close_fixed_seat_assignment参照）
            old_seat_id = await close_fixed_seat_assignment(conn, user_id=body.user_id)
            if old_seat_id is not None and old_seat_id != body.seat_id:
                # 座席を変更する場合、元の座席をfixedのまま放置すると誰にも使えない座席として
                # 残ってしまうため、通常のフリー座席に戻す
                await conn.execute("UPDATE seats SET seat_type = 'free' WHERE id = $1", old_seat_id)
            await conn.execute("UPDATE seats SET seat_type = 'fixed' WHERE id = $1", body.seat_id)
            await conn.execute(
                """UPDATE reservations SET status = 'cancelled', updated_at = now()
                   WHERE seat_id = $1 AND status = 'active' AND date >= CURRENT_DATE""",
                body.seat_id,
            )
            await conn.execute(
                """UPDATE reservations SET status = 'cancelled', updated_at = now()
                   WHERE user_id = $1 AND seat_id != $2 AND status = 'active' AND date >= CURRENT_DATE""",
                body.user_id, body.seat_id,
            )
            await conn.execute(
                """INSERT INTO fixed_seat_assignments (seat_id, user_id, assigned_by, valid_from, valid_until)
                   VALUES ($1, $2, $3, CURRENT_DATE, $4)""",
                body.seat_id, body.user_id, user.id, body.valid_until,
            )
    return {"detail": "固定座席を指定しました"}


@router.delete("/{seat_id}")
async def unassign(seat_id: int, _: CurrentUser = Depends(require_roles("admin"))):
    """A-21: 固定座席の割当を解除。解除後は通常のフリー座席に戻す（seat_type='free'、2026-08-27訂正。
    座席タイプを問わず指定できるようになったことに伴う対応）。過去日の空き状況照会から参照できるよう
    行自体は残す（物理DELETEはしない、2026-09-04変更。close_fixed_seat_assignment参照）。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            freed_seat_id = await close_fixed_seat_assignment(conn, seat_id=seat_id)
            if freed_seat_id is None:
                raise HTTPException(404, detail="対象が見つかりません")
            await conn.execute("UPDATE seats SET seat_type = 'free' WHERE id = $1", seat_id)
    return {"detail": "固定座席の割当を解除しました"}
