# 開発用シードデータ投入スクリプト。dev-login（S-01）でログインできるユーザーと、
# 座席マスタ（S-07が未実装のため、実際の座席配置を直接投入）を用意する
# 使い方: python seed.py（各テーブルが空のときのみ投入する）
import asyncio

import database

# (email, last_name, first_name, role, area_manager_role)
USERS = [
    ("chida037@kogasoftware.com", "千田", "太郎", "admin", "manager"),
    ("yamada@kogasoftware.com", "山田", "花子", "admin", None),
    ("sato@kogasoftware.com", "佐藤", "健一", "general", None),
    ("suzuki@kogasoftware.com", "鈴木", "一郎", "general", None),
]

AREAS = ["NORTH", "EAST", "WEST"]

# 画面モックアップ（S-02）の実際の座席配置（ブロック文字, 席数）。全83席。
# 座席タイプはS-05（固定座席）・S-07（座席マスタ管理）・S-09（プロジェクト座席）が
# 未実装のため、現時点では全て'free'とする（各画面の実装時に一部がfixed/projectへ変わる）。
AREA_BLOCKS = {
    "NORTH": [("A", 11), ("B", 8)],
    "EAST": [("C", 4), ("D", 4), ("E", 4), ("F", 8), ("G", 4), ("H", 4), ("I", 4)],
    "WEST": [("J", 4), ("K", 4), ("L", 4), ("M", 8), ("N", 4), ("O", 4), ("P", 4)],
}

# (key, value, description) 詳細設計書2.17節の初期データ
APP_SETTINGS = [
    ("project_seat_deadline_day", "25", "プロジェクト座席の登録締切日（四半期基準日の前月◯日）"),
    ("free_seat_open_day", "26", "フリー座席の予約開始日（対象月の前月◯日）"),
    ("quarter_base_months", "[1,4,7,10]", "プロジェクト座席の四半期基準月"),
    ("reservation_retention_archive_days", "365", "予約日からT-13へ退避するまでの日数（D10）"),
    ("reservation_retention_delete_days", "365", "T-13退避後、論理削除するまでの日数（D10）"),
    ("seat_history_lookback_days", "31", "座席状況の履歴照会（S-10）で遡れる日数（D12）"),
]


async def main():
    pool = await database.init_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM users")
        if count > 0:
            print("users にデータが存在するためスキップしました")
        else:
            for email, last_name, first_name, role, area_manager_role in USERS:
                await conn.execute(
                    """INSERT INTO users (email, last_name, first_name, role, area_manager_role)
                       VALUES ($1, $2, $3, $4, $5)""",
                    email, last_name, first_name, role, area_manager_role,
                )
            print("usersにシードデータを投入しました")

        seat_count = await conn.fetchval("SELECT COUNT(*) FROM seats")
        if seat_count > 0:
            print("seats にデータが存在するためスキップしました")
        else:
            area_ids = {}
            for name in AREAS:
                row = await conn.fetchrow(
                    "INSERT INTO areas (name) VALUES ($1) RETURNING id", name
                )
                area_ids[name] = row["id"]
            for area_name, blocks in AREA_BLOCKS.items():
                for letter, size in blocks:
                    for n in range(1, size + 1):
                        await conn.execute(
                            "INSERT INTO seats (seat_no, area_id) VALUES ($1, $2)",
                            f"{letter}{n}", area_ids[area_name],
                        )
            print("areas・seatsにシードデータを投入しました")

        settings_count = await conn.fetchval("SELECT COUNT(*) FROM app_settings")
        if settings_count > 0:
            print("app_settings にデータが存在するためスキップしました")
        else:
            for key, value, description in APP_SETTINGS:
                await conn.execute(
                    "INSERT INTO app_settings (key, value, description) VALUES ($1, $2, $3)",
                    key, value, description,
                )
            print("app_settingsにシードデータを投入しました")
    await database.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
