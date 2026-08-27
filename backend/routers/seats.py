# A-06・A-07 空き状況・予約（S-02）。詳細設計書3.3節
import re
from collections import Counter
from datetime import date as Date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends

from auth_helpers import CurrentUser, require_auth
from database import free_seat_bookable_period, get_pool

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

    座席タイプが'project'の座席は、T-07が未実装のため通常のフリー座席と同じ予約有無ベースで
    判定する（該当画面の実装時に対応する）。'fixed'座席はT-04（S-05）の恒久割当で判定し、
    日次のreservationは参照しない（T-04には日次の行が存在しないため）。
    """
    rows = await get_pool().fetch(
        """SELECT s.id, s.seat_no, s.seat_type, a.name AS area_name,
                  r.id AS reservation_id, r.user_id AS reserved_user_id, ru.last_name, ru.first_name,
                  fsa.user_id AS fixed_user_id, fu.last_name AS fixed_last_name
           FROM seats s
           JOIN areas a ON a.id = s.area_id
           LEFT JOIN reservations r
               ON r.seat_id = s.id AND r.date = $1 AND r.status = 'active'
           LEFT JOIN users ru ON ru.id = r.user_id
           LEFT JOIN fixed_seat_assignments fsa ON fsa.seat_id = s.id
           LEFT JOIN users fu ON fu.id = fsa.user_id
           WHERE s.status = 'active'
             AND ($2 = 'all' OR lower(a.name) = $2)
           ORDER BY CASE a.name WHEN 'NORTH' THEN 1 WHEN 'EAST' THEN 2 WHEN 'WEST' THEN 3 END, s.seat_no""",
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

        if r["seat_type"] == "fixed":
            if r["fixed_user_id"] is None:
                status, display_name = "free", None
            else:
                status, display_name = "occupied_fixed", r["fixed_last_name"]
        elif r["reserved_user_id"] is None:
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


@router.get("/availability/period")
async def get_availability_period(
    start: Date | None = None,
    end: Date | None = None,
    area: Literal["all", "north", "east", "west"] = "all",
    user: CurrentUser = Depends(require_auth),
):
    """A-07: 期間ビュー（FR-04-4）。座席×日付の在席状況マトリクス。

    start・endは指定がなければRULE-05の予約可能期間全体（前月26日〜当月末日、当月26日
    以降は翌月末日まで延長）を既定値とし、指定があってもその範囲を超えないようクランプする
    （画面モックアップのresetPeriodFilter/clampToPeriodを踏襲）。
    固定座席（T-04未実装だがseat_type='fixed'）は毎日同じ利用者のままで一覧が見づらいため対象外とする。
    """
    full_start, full_end = await free_seat_bookable_period()
    range_start = min(max(start or full_start, full_start), full_end)
    range_end = min(max(end or full_end, full_start), full_end)
    if range_start > range_end:
        range_start, range_end = range_end, range_start

    rows = await get_pool().fetch(
        """SELECT s.id, s.seat_no, s.seat_type, a.name AS area_name,
                  r.date, r.id AS reservation_id, r.user_id AS reserved_user_id, u.last_name, u.first_name
           FROM seats s
           JOIN areas a ON a.id = s.area_id
           LEFT JOIN reservations r
               ON r.seat_id = s.id AND r.date BETWEEN $1 AND $2 AND r.status = 'active'
           LEFT JOIN users u ON u.id = r.user_id
           WHERE s.status = 'active' AND s.seat_type != 'fixed'
             AND ($3 = 'all' OR lower(a.name) = $3)
           ORDER BY CASE a.name WHEN 'NORTH' THEN 1 WHEN 'EAST' THEN 2 WHEN 'WEST' THEN 3 END, s.seat_no""",
        range_start, range_end, area,
    )

    # 姓の重複判定（A-06と同じ考え方）は日付ごとに独立して行う
    last_name_counts_by_date: dict[Date, Counter] = {}
    for r in rows:
        if r["date"] is not None and r["reserved_user_id"] is not None and r["reserved_user_id"] != user.id:
            last_name_counts_by_date.setdefault(r["date"], Counter())[r["last_name"]] += 1

    seats: dict[int, dict] = {}
    for r in rows:
        seat = seats.setdefault(r["id"], {
            "id": r["id"], "seat_no": r["seat_no"], "area": r["area_name"],
            "seat_type": r["seat_type"], "days": {},
        })
        if r["date"] is None:
            continue
        if r["reserved_user_id"] is None:
            status, display_name = "free", None
        elif r["reserved_user_id"] == user.id:
            status, display_name = "mine", f"{r['last_name']}（自分）"
        else:
            counts = last_name_counts_by_date[r["date"]]
            status = "occupied"
            display_name = (
                r["last_name"] if counts[r["last_name"]] <= 1
                else f"{r['last_name']}（{r['first_name'][:1]}）"
            )
        # 未指定の日（seatsのdaysに現れない日）はフロント側で'free'とみなす（ペイロード削減）
        seat["days"][r["date"].isoformat()] = {
            "status": status,
            "display_name": display_name,
            "reservation_id": r["reservation_id"] if status == "mine" else None,
        }

    dates = []
    d = range_start
    while d <= range_end:
        dates.append(d.isoformat())
        d += timedelta(days=1)

    return {
        "start": range_start.isoformat(),
        "end": range_end.isoformat(),
        "full_start": full_start.isoformat(),
        "full_end": full_end.isoformat(),
        "dates": dates,
        "seats": sorted(seats.values(), key=lambda s: _seat_sort_key(s["seat_no"])),
    }
