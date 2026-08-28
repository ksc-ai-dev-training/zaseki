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
    # ダミー利用者（S-05の対象者検索・S-02の使用中表示等、複数人が必要な画面の動作確認用）
    ("tanaka@kogasoftware.com", "田中", "一郎", "general", None),
    ("nakamura@kogasoftware.com", "中村", "誠", "general", None),
    ("yamamoto@kogasoftware.com", "山本", "健太", "general", None),
    ("shimizu@kogasoftware.com", "清水", "陽子", "general", None),
    ("takahashi@kogasoftware.com", "高橋", "美咲", "general", None),
    ("ishii@kogasoftware.com", "石井", "大輔", "general", None),
    ("kimura@kogasoftware.com", "木村", "拓也", "general", None),
    ("watanabe@kogasoftware.com", "渡辺", "真一", "general", None),
    ("ito@kogasoftware.com", "伊藤", "大輝", "general", None),
    ("kato@kogasoftware.com", "加藤", "彩子", "general", None),
    # 追加ダミー利用者20名（2026-08-28、S-08プロジェクト・PM管理タブ等の複数人での動作確認用）
    ("kobayashi@kogasoftware.com", "小林", "健太", "general", None),
    ("matsumoto@kogasoftware.com", "松本", "由美", "general", None),
    ("inoue@kogasoftware.com", "井上", "直樹", "general", None),
    ("kinoshita@kogasoftware.com", "木下", "愛", "general", None),
    ("saito@kogasoftware.com", "斎藤", "亮", "general", None),
    ("endo@kogasoftware.com", "遠藤", "舞", "general", None),
    ("fujita@kogasoftware.com", "藤田", "翔太", "general", None),
    ("okada@kogasoftware.com", "岡田", "恵美", "general", None),
    ("hasegawa@kogasoftware.com", "長谷川", "大和", "general", None),
    ("murakami@kogasoftware.com", "村上", "沙織", "general", None),
    ("kondo@kogasoftware.com", "近藤", "拓真", "general", None),
    ("ishikawa@kogasoftware.com", "石川", "美穂", "general", None),
    ("yoshida@kogasoftware.com", "吉田", "隼人", "general", None),
    ("yamaguchi@kogasoftware.com", "山口", "彩", "general", None),
    ("matsuda@kogasoftware.com", "松田", "龍之介", "general", None),
    ("abe@kogasoftware.com", "阿部", "千夏", "general", None),
    ("mori@kogasoftware.com", "森", "悠斗", "general", None),
    ("hayashi@kogasoftware.com", "林", "麻衣", "general", None),
    ("shimada@kogasoftware.com", "島田", "康介", "general", None),
    ("sakurai@kogasoftware.com", "桜井", "陽菜", "general", None),
]

AREAS = ["NORTH", "EAST", "WEST"]

# 画面モックアップ（S-02）の実際の座席配置（ブロック文字, 席数）。全83席。
# 座席タイプはS-07（座席マスタ管理）・S-09（プロジェクト座席）が未実装のため、
# 現時点ではS-05（固定座席の指定）で割り当てたもの以外は全て'free'とする
# （各画面の実装時に残りが一部project等へ変わる）。
AREA_BLOCKS = {
    "NORTH": [("A", 11), ("B", 8)],
    "EAST": [("C", 4), ("D", 4), ("E", 4), ("F", 8), ("G", 4), ("H", 4), ("I", 4)],
    "WEST": [("J", 4), ("K", 4), ("L", 4), ("M", 8), ("N", 4), ("O", 4), ("P", 4)],
}

# 座席タイプを問わず指定できるため（2026-08-27訂正）、事前に'fixed'として投入する座席はなく、
# 割当（A-20）自体がseat_type='fixed'への変更を兼ねる。デモ用にA1だけ事前に割り当てておく。
FIXED_SEAT_PRE_ASSIGN = {"A1": "sato@kogasoftware.com"}

# (key, value, description) 詳細設計書2.17節の初期データ
APP_SETTINGS = [
    ("project_seat_deadline_day", "25", "プロジェクト座席の登録締切日（四半期基準日の前月◯日）"),
    ("free_seat_open_day", "26", "フリー座席の予約開始日（対象月の前月◯日）"),
    ("quarter_base_months", "[1,4,7,10]", "プロジェクト座席の四半期基準月"),
    ("reservation_retention_archive_days", "365", "予約日からT-13へ退避するまでの日数（D10）"),
    ("reservation_retention_delete_days", "365", "T-13退避後、論理削除するまでの日数（D10）"),
    ("seat_history_lookback_days", "31", "座席状況の履歴照会（S-10）で遡れる日数（D12）"),
]

# S-09動作確認用のデモプロジェクト（S-08プロジェクト・PM管理タブが未実装のため、
# プロジェクト自体の作成手段が現時点でシード以外にない。(name, [(email, project_title), ...])）
PROJECTS = [
    ("Zaseki研修プロジェクト", [
        ("tanaka@kogasoftware.com", "PM"),
        ("nakamura@kogasoftware.com", "PL"),
        ("yamamoto@kogasoftware.com", None),
        ("shimizu@kogasoftware.com", None),
    ]),
    ("経歴書刷新プロジェクト", [
        ("takahashi@kogasoftware.com", "PM"),
        ("ishii@kogasoftware.com", None),
        ("kimura@kogasoftware.com", None),
    ]),
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

            for seat_no, email in FIXED_SEAT_PRE_ASSIGN.items():
                seat_id = await conn.fetchval("SELECT id FROM seats WHERE seat_no = $1", seat_no)
                user_id = await conn.fetchval("SELECT id FROM users WHERE email = $1", email)
                admin_id = await conn.fetchval("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
                await conn.execute("UPDATE seats SET seat_type = 'fixed' WHERE id = $1", seat_id)
                await conn.execute(
                    "INSERT INTO fixed_seat_assignments (seat_id, user_id, assigned_by) VALUES ($1, $2, $3)",
                    seat_id, user_id, admin_id,
                )
            print("fixed_seat_assignmentsにシードデータを投入しました")

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

        project_count = await conn.fetchval("SELECT COUNT(*) FROM projects")
        if project_count > 0:
            print("projects にデータが存在するためスキップしました")
        else:
            for name, members in PROJECTS:
                project_id = await conn.fetchval(
                    "INSERT INTO projects (name) VALUES ($1) RETURNING id", name
                )
                for email, project_title in members:
                    user_id = await conn.fetchval("SELECT id FROM users WHERE email = $1", email)
                    await conn.execute(
                        "INSERT INTO project_members (project_id, user_id, project_title) VALUES ($1, $2, $3)",
                        project_id, user_id, project_title,
                    )
            print("projects・project_membersにシードデータを投入しました")
    await database.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
