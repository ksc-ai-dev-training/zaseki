# A-06 空き状況・予約（S-02）。詳細設計書3.3節
import re
from collections import Counter
from datetime import date as Date
from typing import Literal

from fastapi import APIRouter, Depends

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/seats", tags=["seats"])

_BLOCK_PREFIX_RE = re.compile(r"^([A-Za-z]+)")


def _block_label(seat_no: str) -> str:
    m = _BLOCK_PREFIX_RE.match(seat_no)
    return f"{m.group(1)}ブロック" if m else seat_no


def _seat_sort_key(seat_no: str) -> tuple[str, int]:
    m = re.match(r"^([A-Za-z]+)(\d+)$", seat_no)
    if not m:
        return (seat_no, 0)
    return (m.group(1), int(m.group(2)))


@router.get("/availability")
async def get_availability(
    date: Date,
    area: Literal["all", "north", "east", "west"] = "all",
    user: CurrentUser = Depends(require_auth),
):
    """A-06: 指定日・エリアの座席状況一覧（FR-04-1〜3）。

    座席タイプが'fixed'・'project'の座席は、それぞれT-04・T-07が未実装のため
    本APIでは通常のフリー座席と同じ予約有無ベースで判定する（該当画面の実装時に対応する）。
    """
    rows = await get_pool().fetch(
        """SELECT s.id, s.seat_no, s.seat_type, a.name AS area_name,
                  r.id AS reservation_id, r.user_id AS reserved_user_id, u.last_name, u.first_name
           FROM seats s
           JOIN areas a ON a.id = s.area_id
           LEFT JOIN reservations r
               ON r.seat_id = s.id AND r.date = $1 AND r.status = 'active'
           LEFT JOIN users u ON u.id = r.user_id
           WHERE s.status = 'active'
             AND ($2 = 'all' OR lower(a.name) = $2)
           ORDER BY a.name, s.seat_no""",
        date, area,
    )

    # 座席タイルの表示名（基本設計書3.3節）: 使用中の座席の姓が同一フロアで重複する場合のみ
    # 「姓（名の頭文字）」に切り替える。自分の予約は常に「姓（自分）」で区別不要。
    last_name_counts = Counter(
        r["last_name"] for r in rows if r["reserved_user_id"] is not None and r["reserved_user_id"] != user.id
    )

    areas: dict[str, dict[str, dict]] = {}
    for r in rows:
        area_name = r["area_name"]
        block_label = _block_label(r["seat_no"])
        areas.setdefault(area_name, {}).setdefault(block_label, [])

        if r["reserved_user_id"] is None:
            status, display_name = "free", None
        elif r["reserved_user_id"] == user.id:
            status, display_name = "mine", f"{r['last_name']}（自分）"
        else:
            status = "occupied"
            display_name = (
                r["last_name"] if last_name_counts[r["last_name"]] <= 1
                else f"{r['last_name']}（{r['first_name'][:1]}）"
            )

        areas[area_name][block_label].append({
            # 仕様書のレスポンス例にはないが、予約登録（A-09）のBody.seat_idに必要な拡張フィールド
            "id": r["id"],
            "seat_no": r["seat_no"],
            "seat_type": r["seat_type"],
            "status": status,
            "display_name": display_name,
            "title": None,
            # 仕様書のレスポンス例にはないが、フロアマップから直接取消する（A-11）ために
            # 自分の予約にのみ付与する拡張フィールド
            "reservation_id": r["reservation_id"] if status == "mine" else None,
        })

    return {
        "date": date.isoformat(),
        "areas": [
            {
                "area": area_name,
                "blocks": [
                    {"block_label": block_label, "seats": sorted(seats, key=lambda s: _seat_sort_key(s["seat_no"]))}
                    for block_label, seats in sorted(blocks.items())
                ],
            }
            for area_name, blocks in areas.items()
        ],
    }
