# 開発用シードデータ投入スクリプト。dev-login（S-01）でログインできるユーザーを用意する
# 使い方: python seed.py（users テーブルが空のときのみ投入する）
import asyncio

import database

# (email, last_name, first_name, role, area_manager_role)
USERS = [
    ("chida037@kogasoftware.com", "千田", "太郎", "admin", "manager"),
    ("yamada@kogasoftware.com", "山田", "花子", "admin", None),
    ("sato@kogasoftware.com", "佐藤", "健一", "general", None),
    ("suzuki@kogasoftware.com", "鈴木", "一郎", "general", None),
]


async def main():
    pool = await database.init_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM users")
        if count > 0:
            print("users にデータが存在するためスキップしました")
            return
        for email, last_name, first_name, role, area_manager_role in USERS:
            await conn.execute(
                """INSERT INTO users (email, last_name, first_name, role, area_manager_role)
                   VALUES ($1, $2, $3, $4, $5)""",
                email, last_name, first_name, role, area_manager_role,
            )
        print("シードデータを投入しました")
    await database.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
