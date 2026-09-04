# A-06・A-07 空き状況・予約（S-02）、A-45 座席状況の履歴照会（S-10）。詳細設計書3.3節・3.10節
import re
from collections import Counter
from datetime import date as Date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException

from auth_helpers import CurrentUser, require_auth, require_roles
from database import free_seat_bookable_period, get_pool, get_setting, project_blocked_seats, release_expired_fixed_seats

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


def _is_birthday(birth_month: int | None, birth_day: int | None, target: Date) -> bool:
    """FR-08-4: 誕生日バッジの判定。実行時点の実際の「今日」ではなく、表示中の日付（S-02の
    日付選択・S-10の照会日付）の月日と一致するかで判定する（2026-08-31追加。過去日・未来日を
    表示しているときに、その日を基準に誕生日を確認できるようにするため）。"""
    return birth_month == target.month and birth_day == target.day


@router.get("/availability")
async def get_availability(
    date: Date,
    area: Literal["all", "north", "east", "west"] = "all",
    user: CurrentUser = Depends(require_auth),
):
    """A-06: 指定日・エリアの座席状況一覧（FR-04-1〜3）。実体は_build_availability参照。
    過去方向はD12（app_settings.seat_history_lookback_days、既定31日）より前は照会できない
    （A-45と同じ下限。未来方向は予約のため従来どおり無制限。2026-09-04追加。それまでは
    一般ユーザーでも無制限に過去を遡れてしまっており、管理部専用のA-45〔S-10〕より制限が
    緩いという逆転が生じていた）。"""
    lookback_days = int(await get_setting("seat_history_lookback_days") or "31")
    if date < Date.today() - timedelta(days=lookback_days):
        raise HTTPException(400, detail="指定できる日付は直近1か月以内です")
    return await _build_availability(date, area, user)


@router.get("/history")
async def get_seat_history(
    date: Date,
    area: Literal["all", "north", "east", "west"] = "all",
    user: CurrentUser = Depends(require_roles("admin")),
):
    """A-45: 座席状況の履歴照会（S-10、FR-04-5）。レスポンス形式はA-06と同じ（_build_availability
    を共用する）。指定日はD12（app_settings.seat_history_lookback_days、既定31日）の範囲、
    かつ当日以前のみ照会できる（2026-08-31追加）。"""
    lookback_days = int(await get_setting("seat_history_lookback_days") or "31")
    today = Date.today()
    if date > today or date < today - timedelta(days=lookback_days):
        raise HTTPException(400, detail="指定できる日付は直近1か月以内です")
    return await _build_availability(date, area, user)


async def _build_availability(date: Date, area: str, user: CurrentUser) -> dict:
    """A-06・A-45共通のフロアマップ状況組み立て処理。

    'fixed'座席はT-04（S-05）の恒久割当で判定し、日次のreservationは参照しない（T-04には
    日次の行が存在しないため）。release_expired_fixed_seats()は実際の本日時点で期限切れの割当のみ
    解除するため、指定dateが未来日で、かつその日が割当のvalid_untilを過ぎている場合は、まだDB上の
    割当は残っていてもその日には空席として扱う（2026-09-02修正。フロアマップで期限翌日以降の未来日を
    表示すると、まだ本日を迎えていない期限切れ前の割当のせいで、期限を過ぎているはずのその日でも
    「固定」表示のままになる不具合があったため）。プロジェクト座席はT-07（S-09）の座席の島の割当（allocated_seats）
    のうち、指定dateがその計画のperiod_start〜period_endに含まれるものだけを対象とする
    （project_blocked_seats、2026-08-28訂正。割当が決定した四半期の前でも通常のフリー座席として
    予約できる必要があるため、座席自体を恒久的にproject化する実装は撤回した）。対象期間中の
    プロジェクト座席のうち、指定dateに実際の予約（S-04 A-18の周期予約〔T-09〕から生成されたT-08行）
    があれば'project_confirmed'（個人確定済み、display_nameはその利用者の姓）、なければ
    'project_pending'（未確定、display_nameはプロジェクト名）とする（2026-08-28、A-10・S-04実装に
    伴い区別を追加）。
    """
    await release_expired_fixed_seats()
    lookback_days = int(await get_setting("seat_history_lookback_days") or "31")
    history_min_date = Date.today() - timedelta(days=lookback_days)
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT s.id, s.seat_no, s.seat_type, s.pos_x, s.pos_y, a.name AS area_name,
                  r.id AS reservation_id, r.user_id AS reserved_user_id, ru.last_name, ru.first_name,
                  ru.avatar_image AS reserved_avatar_image, ru.birth_month AS reserved_birth_month,
                  ru.birth_day AS reserved_birth_day,
                  fsa.user_id AS fixed_user_id, fsa.valid_until AS fixed_valid_until,
                  fu.last_name AS fixed_last_name,
                  fu.avatar_image AS fixed_avatar_image, fu.birth_month AS fixed_birth_month,
                  fu.birth_day AS fixed_birth_day
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

    project_name_by_seat_id = await project_blocked_seats(date)

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

        avatar_image = None
        is_birthday = False

        if r["seat_type"] == "fixed":
            expired_on_viewed_date = r["fixed_valid_until"] is not None and r["fixed_valid_until"] < date
            if r["fixed_user_id"] is None or expired_on_viewed_date:
                status, display_name = "free", None
            else:
                status, display_name = "occupied_fixed", r["fixed_last_name"]
                avatar_image = r["fixed_avatar_image"]
                is_birthday = _is_birthday(r["fixed_birth_month"], r["fixed_birth_day"], date)
        elif r["id"] in project_name_by_seat_id:
            if r["reserved_user_id"] is None:
                status, display_name = "project_pending", project_name_by_seat_id[r["id"]]
            elif r["reserved_user_id"] == user.id:
                status, display_name = "mine", f"{r['last_name']}（自分）"
                avatar_image = r["reserved_avatar_image"]
                is_birthday = _is_birthday(r["reserved_birth_month"], r["reserved_birth_day"], date)
            else:
                status = "project_confirmed"
                display_name = (
                    r["last_name"] if last_name_counts[r["last_name"]] <= 1
                    else f"{r['last_name']}（{r['first_name'][:1]}）"
                )
                avatar_image = r["reserved_avatar_image"]
                is_birthday = _is_birthday(r["reserved_birth_month"], r["reserved_birth_day"], date)
        elif r["reserved_user_id"] is None:
            status, display_name = "free", None
        elif r["reserved_user_id"] == user.id:
            status, display_name = "mine", f"{r['last_name']}（自分）"
            avatar_image = r["reserved_avatar_image"]
            is_birthday = _is_birthday(r["reserved_birth_month"], r["reserved_birth_day"], date)
        else:
            status = "occupied"
            display_name = (
                r["last_name"] if last_name_counts[r["last_name"]] <= 1
                else f"{r['last_name']}（{r['first_name'][:1]}）"
            )
            avatar_image = r["reserved_avatar_image"]
            is_birthday = _is_birthday(r["reserved_birth_month"], r["reserved_birth_day"], date)

        areas[area_name][block_label].append({
            # 仕様書のレスポンス例にはないが、予約登録（A-09）のBody.seat_idに必要な拡張フィールド
            "id": r["id"],
            "seat_no": r["seat_no"],
            "seat_type": r["seat_type"],
            "status": status,
            "display_name": display_name,
            # マイプロフィール（S-12）で登録したアイコン画像（data URL）。未登録・空き座席等はnull
            # （FR-08-3、2026-08-31追加）
            "avatar_image": avatar_image,
            # 表示中の日付が誕生日（月日一致）の利用者が使用中の座席のみtrue（FR-08-4、2026-08-31追加）
            "is_birthday": is_birthday,
            "title": None,
            # 仕様書のレスポンス例にはないが、S-02「座席配置モード」で配置した座席のみ設定される
            # フロアマップ上の自由配置座標（エリアパネルに対する%）。未設定ならnull
            "pos_x": r["pos_x"],
            "pos_y": r["pos_y"],
            # 仕様書のレスポンス例にはないが、フロアマップから直接取消する（A-11）ために
            # 自分の予約にのみ付与する拡張フィールド
            "reservation_id": r["reservation_id"] if status == "mine" else None,
        })

    return {
        "date": date.isoformat(),
        "history_min_date": history_min_date.isoformat(),
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
    固定座席（seat_type='fixed'）は毎日同じ利用者のままで表示が冗長になるため、割当期間中の
    最初の日だけ氏名を表示し、以降は'-'とする（2026-09-02、「固定座席の人の席は表示しなくていい」
    としていた方針を「表示してほしいが冗長さは避けたい」に変更する要望を受けて対象に含めた。
    以前の除外方針は撤回）。有効期限（valid_until）を過ぎた日はA-06と同様に空き席として扱う。
    """
    await release_expired_fixed_seats()
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
           WHERE s.status = 'active'
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

    fixed_rows = await get_pool().fetch(
        "SELECT fsa.seat_id, u.last_name, fsa.valid_until FROM fixed_seat_assignments fsa JOIN users u ON u.id = fsa.user_id"
    )
    fixed_by_seat_id = {r["seat_id"]: r for r in fixed_rows}
    for seat in seats.values():
        fsa = fixed_by_seat_id.get(seat["id"])
        if seat["seat_type"] != "fixed" or fsa is None:
            continue
        name_shown = False
        d = range_start
        while d <= range_end:
            if fsa["valid_until"] is None or d <= fsa["valid_until"]:
                display_name = fsa["last_name"] if not name_shown else "-"
                name_shown = True
                seat["days"][d.isoformat()] = {
                    "status": "occupied_fixed",
                    "display_name": display_name,
                    "reservation_id": None,
                }
            d += timedelta(days=1)

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
