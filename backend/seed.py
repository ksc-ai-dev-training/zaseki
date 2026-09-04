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
    # 追加ダミー利用者22名（2026-09-02、複数人での動作確認用。既存の苗字と重複するもの
    # 〔木下・島田・石川・木村〕はメールアドレスに2を付けて区別する）
    ("koga@kogasoftware.com", "古賀", "実", "general", None),
    ("fujiwara@kogasoftware.com", "藤原", "舞子", "general", None),
    ("kitahori@kogasoftware.com", "北堀", "淳", "general", None),
    ("soyama@kogasoftware.com", "曽山", "恵", "general", None),
    ("zenyoji@kogasoftware.com", "善養寺", "剛", "general", None),
    ("matsuo@kogasoftware.com", "松尾", "詩織", "general", None),
    ("minowa@kogasoftware.com", "箕輪", "涼太", "general", None),
    ("kinoshita2@kogasoftware.com", "木下", "遥", "general", None),
    ("shimada2@kogasoftware.com", "島田", "直人", "general", None),
    ("kotani@kogasoftware.com", "胡谷", "芽衣", "general", None),
    ("ikeda@kogasoftware.com", "池田", "大地", "general", None),
    ("ishikawa2@kogasoftware.com", "石川", "悠真", "general", None),
    ("taki@kogasoftware.com", "滝", "遥香", "general", None),
    ("ishizuka@kogasoftware.com", "石塚", "賢人", "general", None),
    ("koike@kogasoftware.com", "小池", "千尋", "general", None),
    ("nishimura@kogasoftware.com", "西村", "拓", "general", None),
    ("ogiwara@kogasoftware.com", "荻原", "沙也加", "general", None),
    ("nohara@kogasoftware.com", "野原", "蓮", "general", None),
    ("suga@kogasoftware.com", "菅", "美月", "general", None),
    ("kimura2@kogasoftware.com", "木村", "大輔", "general", None),
    ("nagai@kogasoftware.com", "永井", "彩花", "general", None),
    ("tsukamoto@kogasoftware.com", "塚本", "蒼", "general", None),
    # 追加ダミー利用者79名（2026-09-02、プロジェクト体制表〔顧客名は伏せた社内案件コード〕に
    # 登場する人物のうち、まだ登録されていない氏名を新規追加。氏名は表の「苗字＋名の頭文字」
    # 表記から推測した仮の姓名であり、実在の個人情報ではない。うち6名（末尾参照）は表でBP
    # 〔協力会社〕と付記されていたため、DBには直接employment_type='bp'で投入した
    # （このリストではemployment_typeを表現できないため、再シード時は'employee'扱いになる点に注意）
    ("suzuki2@kogasoftware.com", "鈴木", "菜々子", "general", None),
    ("ishimoto@kogasoftware.com", "石本", "大輔", "general", None),
    ("sugitate@kogasoftware.com", "杉立", "洋平", "general", None),
    ("kono@kogasoftware.com", "河野", "加奈子", "general", None),
    ("toki@kogasoftware.com", "土岐", "悠", "general", None),
    ("inoyama@kogasoftware.com", "猪山", "直也", "general", None),
    ("masuda@kogasoftware.com", "増田", "崚", "general", None),
    ("kominato@kogasoftware.com", "小湊", "恵美", "general", None),
    ("yoshidome@kogasoftware.com", "吉留", "拓海", "general", None),
    ("sato2@kogasoftware.com", "佐藤", "駿", "general", None),
    ("shimoyama@kogasoftware.com", "下山", "恭子", "general", None),
    ("miyazawa@kogasoftware.com", "宮澤", "隆", "general", None),
    ("kimoto@kogasoftware.com", "木本", "沙織", "general", None),
    ("matsubayashi@kogasoftware.com", "松林", "健二", "general", None),
    ("tanaka2@kogasoftware.com", "田中", "優子", "general", None),
    ("watanabe2@kogasoftware.com", "渡辺", "誠", "general", None),
    ("katayama@kogasoftware.com", "片山", "恵子", "general", None),
    ("kitawaki@kogasoftware.com", "北脇", "亮太", "general", None),
    ("kobayashi2@kogasoftware.com", "小林", "直樹", "general", None),
    ("okamura@kogasoftware.com", "岡村", "由紀", "general", None),
    ("ogata@kogasoftware.com", "尾方", "健", "general", None),
    ("nagano@kogasoftware.com", "長野", "誠一", "general", None),
    ("hayami@kogasoftware.com", "速水", "香織", "general", None),
    ("mikazuki@kogasoftware.com", "三ヶ月", "大輔", "general", None),
    ("haga@kogasoftware.com", "芳賀", "大", "general", None),
    ("tomozawa@kogasoftware.com", "友澤", "麻美", "general", None),
    ("yukawa@kogasoftware.com", "由川", "健太", "general", None),
    ("urabe@kogasoftware.com", "占部", "直人", "general", None),
    ("nakayama@kogasoftware.com", "仲山", "恵", "general", None),
    ("sugiura@kogasoftware.com", "杉浦", "隆之", "general", None),
    ("okazaki@kogasoftware.com", "岡崎", "由美子", "general", None),
    ("koike2@kogasoftware.com", "小池", "悟", "general", None),
    ("ota@kogasoftware.com", "太田", "優", "general", None),
    ("takizawa@kogasoftware.com", "瀧澤", "誠", "general", None),
    ("sasaki@kogasoftware.com", "佐々木", "隼", "general", None),
    ("matsumori@kogasoftware.com", "松盛", "健一", "general", None),
    ("toshimi@kogasoftware.com", "都志見", "亜紀", "general", None),
    ("koga2@kogasoftware.com", "古賀", "彩", "general", None),
    ("kido@kogasoftware.com", "城戸", "大地", "general", None),
    ("yokoyama@kogasoftware.com", "横山", "直樹", "general", None),
    ("nagata@kogasoftware.com", "永田", "幸子", "general", None),
    ("wakiya@kogasoftware.com", "脇屋", "大輔", "general", None),
    ("suzuki3@kogasoftware.com", "鈴木", "愛", "general", None),
    ("sugai@kogasoftware.com", "菅井", "康弘", "general", None),
    ("masuda2@kogasoftware.com", "増田", "晴", "general", None),
    ("kojima@kogasoftware.com", "小嶋", "直子", "general", None),
    ("nakahata@kogasoftware.com", "中畑", "亮", "general", None),
    ("nakamichi@kogasoftware.com", "仲道", "健太", "general", None),
    ("okubo@kogasoftware.com", "大久保", "克", "general", None),
    ("usuda@kogasoftware.com", "臼田", "由紀子", "general", None),
    ("okamoto@kogasoftware.com", "岡本", "大輔", "general", None),
    ("iwamoto@kogasoftware.com", "岩本", "恵美", "general", None),
    ("matsuura@kogasoftware.com", "松浦", "圭", "general", None),
    ("amakasa@kogasoftware.com", "天笠", "誠", "general", None),
    ("yano@kogasoftware.com", "矢野", "大輔", "general", None),
    ("kaneda@kogasoftware.com", "金田", "直樹", "general", None),
    ("hibino@kogasoftware.com", "日比野", "恵子", "general", None),
    ("taniguchi@kogasoftware.com", "谷口", "大介", "general", None),
    ("shimizu2@kogasoftware.com", "清水", "麻衣", "general", None),
    ("koike3@kogasoftware.com", "小池", "太", "general", None),
    ("okubo2@kogasoftware.com", "大久保", "駿", "general", None),
    ("otaka@kogasoftware.com", "大髙", "隆", "general", None),
    ("takahashi2@kogasoftware.com", "高橋", "幸子", "general", None),
    ("hoshino@kogasoftware.com", "星野", "大輝", "general", None),
    ("yoshikai@kogasoftware.com", "吉開", "直人", "general", None),
    ("tachibana@kogasoftware.com", "橘", "健太郎", "general", None),
    ("nagai2@kogasoftware.com", "長井", "由美", "general", None),
    ("fujisaki@kogasoftware.com", "藤﨑", "誠", "general", None),
    ("saito2@kogasoftware.com", "斉藤", "卓", "general", None),
    ("saito3@kogasoftware.com", "斉藤", "大", "general", None),
    ("fukui@kogasoftware.com", "福井", "恵美", "general", None),
    ("hario@kogasoftware.com", "針生", "直樹", "general", None),
    ("miyawaki@kogasoftware.com", "宮脇", "沙織", "general", None),
    # 以下6名はBP（協力会社）としてDBに投入済み（このリストの再シードでは'employee'扱いになる点に注意）
    ("takasu@kogasoftware.com", "高須", "誠", "general", None),
    ("yokomori@kogasoftware.com", "横森", "大輔", "general", None),
    ("takayama@kogasoftware.com", "髙山", "直子", "general", None),
    ("katafuchi@kogasoftware.com", "片渕", "健", "general", None),
    ("watanabe3@kogasoftware.com", "渡邉", "誠", "general", None),
    ("nitta@kogasoftware.com", "新田", "恵美", "general", None),
    ("arai@kogasoftware.com", "荒井", "健太", "general", None),
    # 追加ダミー利用者11名（2026-09-02、別のプロジェクト体制表〔顧客名は伏せた社内案件コード〕
    # に登場する人物のうち、まだ登録されていない氏名を新規追加。表に苗字のみで名の記載が
    # ない人は仮の名を補って登録した。既存の苗字と同じ読みでも字が異なるもの〔蓑輪≠箕輪〕は
    # 別人として区別し、既に登録済みの苗字〔藤﨑・藤原・平・善養寺・大坪・木下〕は追加しなかった）
    ("naomi@kogasoftware.com", "直海", "陸", "general", None),
    ("chida2@kogasoftware.com", "千田", "春香", "general", None),
    ("matsuda2@kogasoftware.com", "松田", "拓", "general", None),
    ("miyake@kogasoftware.com", "三宅", "悠人", "general", None),
    ("kikuchi@kogasoftware.com", "菊地", "彩乃", "general", None),
    ("minowa2@kogasoftware.com", "蓑輪", "直輝", "general", None),
    ("takaishi@kogasoftware.com", "高石", "竜也", "general", None),
    ("oba@kogasoftware.com", "大羽", "智子", "general", None),
    ("fujimura@kogasoftware.com", "藤村", "健吾", "general", None),
    ("ishida@kogasoftware.com", "石田", "由佳", "general", None),
    ("izumi@kogasoftware.com", "泉", "大樹", "general", None),
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
    ("project_seat_deadline_day", "25", "プロジェクト座席の登録締切日（対象期間の開始月の前月◯日。2026-09-03、四半期基準日ベースから期間開始日ベースに変更）"),
    ("free_seat_open_day", "26", "フリー座席の予約開始日（対象月の前月◯日）"),
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
