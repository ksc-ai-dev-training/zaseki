# 出社曜日調整のAI（LLM）による仮案生成（FR-03-11、A-74）。詳細設計書3.9節参照。
# DBへの書き込みは行わない。検討資料「プロジェクト座席・曜日調整フロー改善案」変更Cで
# 決定済みの方針（生成AI・座席容量の定義・優先順位付けは判断理由つきでAIに委ねる）に基づく。
import json
import logging
import os

import httpx

from database import ROOT_ENV

logger = logging.getLogger(__name__)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY") or ROOT_ENV.get("OPENAI_API_KEY")
OPENAI_MODEL = "gpt-4o-mini"
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
_WEEKDAY_JA = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金"}

_SUGGESTION_SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "integer"},
                    "weekdays": {"type": "array", "items": {"type": "string", "enum": WEEKDAYS}},
                    "reasoning": {"type": "string"},
                },
                "required": ["plan_id", "weekdays", "reasoning"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["suggestions"],
    "additionalProperties": False,
}


class WeekdayAiSuggestionError(Exception):
    """AI提案の生成に失敗した場合（APIキー未設定・HTTPエラー・タイムアウト・想定外のレスポンス形状等）"""


def _ja_weekdays(weekdays: list[str] | None) -> str:
    if not weekdays:
        return "なし"
    names = [_WEEKDAY_JA[w] for w in weekdays if w in _WEEKDAY_JA]
    # 曜日数を明記する（2026-09-15追加）。「出社は週2日程度」という一般的な思い込みからか、
    # 3日以上の第一希望を勝手に2日へ削って採用してしまうことがあったため、日数を数え間違えないよう
    # 明示する
    return "・".join(names) + f"（{len(names)}日）"


def _build_prompt(plans: list[dict], weekday_capacity: dict[str, int], fixed_seat_count: int = 0) -> str:
    projects_lines = []
    for p in plans:
        line = (
            f"- plan_id={p['plan_id']} 「{p['project_name']}」（必要座席数{p.get('required_seats', 0)}名）: "
            f"第一希望={_ja_weekdays(p.get('choice1_weekdays'))}、"
            f"第二希望={_ja_weekdays(p.get('choice2_weekdays'))}"
        )
        if p.get("note"):
            line += f"、備考: {p['note']}"
        projects_lines.append(line)
    capacity_line = "、".join(f"{_WEEKDAY_JA[w]}: {weekday_capacity.get(w, 0)}人まで" for w in WEEKDAYS)
    # 固定座席保有者は曜日によらず毎日その座席を使用するため、フリー座席（一般の予約用）として
    # 実際に残るのは「座席容量－固定座席保有者数－その日のプロジェクト出社人数」になる
    # （2026-09-15追加、「できるだけフリー座席を残すような感じにしたい」との要望を受けた）
    fixed_seat_line = (
        f"\n【固定座席保有者】{fixed_seat_count}名（曜日によらず毎日座席を使用するため、"
        "上記の座席容量に含まれています）\n" if fixed_seat_count > 0 else "\n"
    )

    return (
        "あなたはオフィスの座席管理を担当しています。以下のプロジェクトの出社曜日希望をもとに、"
        "各曜日の合計人数（プロジェクトごとの人数の合計）が座席容量を超えないよう、"
        "プロジェクトごとに出社曜日（月〜金の部分集合、空でもよい）を決めてください。\n\n"
        f"【曜日ごとの座席容量】\n{capacity_line}\n"
        f"{fixed_seat_line}\n"
        f"【各プロジェクトの希望】\n" + "\n".join(projects_lines) + "\n\n"
        "まず、全プロジェクトが第一希望どおりに出社した場合の曜日ごとの合計人数を、各プロジェクトの"
        "必要座席数を実際に足し算して計算してください（複数のプロジェクトが同じ曜日を希望している"
        "だけでは容量超過とは限りません。人数の合計が座席容量を超えて初めて容量超過です）。"
        "どの曜日も座席容量を超えないのであれば、調整は一切行わず、全プロジェクトをそのまま"
        "第一希望の曜日（第一希望に含まれる曜日をすべて、記載されている日数のとおりに）に"
        "割り当ててください。第一希望・第二希望はそれぞれ1日とは限らず、複数日（0〜5日）を"
        "含みます。『週2日程度』のような一般的な出社日数の慣習は考慮せず、必ず希望に記載された"
        "曜日の数どおりに割り当ててください。座席容量を超える曜日がある場合に限り、その曜日に"
        "希望が重なっているプロジェクトの一部を第二希望や、第一・第二希望のいずれにも該当しない"
        "曜日に調整してください（この場合も、動かす必要のない曜日まで削らないでください）。"
        "第一希望のままで容量を超えないプロジェクトについては、第二希望の曜日を追加で足しては"
        "いけません。第二希望はあくまで、第一希望のままだと容量を超えてしまう場合の代替であり、"
        "容量に余裕があるからといって出社日数を増やす理由にはなりません。"
        "座席容量には、プロジェクト以外の一般の利用者が使うフリー座席の分も含まれています。"
        "調整が必要になった場合（複数の候補曜日から選べる場合）は、その曜日の座席容量に対する"
        "余裕（フリー座席として残る分）ができるだけ大きくなる曜日を優先してください。ただし、"
        "これは複数候補がある場合の決め方であり、重複がなく容量内に収まる第一希望を、この理由"
        "だけで動かす必要はありません。"
        "優先順位に固定的なルールはないため、あなたが合理的だと考える理由をつけて判断してください。"
        "備考は、出社できない曜日など具体的な曜日の制約が明記されている場合のみ考慮してください。"
        "配属未定・状況不明といった、曜日を指定しない不確実性の記述は、曜日を動かす理由にしないで"
        "ください。全プロジェクト（全plan_id）について、割り当てた曜日と日本語での判断理由を"
        "1件ずつ出力してください。"
    )


async def suggest_weekdays(plans: list[dict], weekday_capacity: dict[str, int], fixed_seat_count: int = 0) -> dict:
    """A-74: 各プロジェクトの第一・第二希望・備考（T-11）と曜日ごとの座席容量から、OpenAIへ
    仮の曜日調整案を問い合わせる。plans各要素は{plan_id, project_name, choice1_weekdays,
    choice2_weekdays, note}。戻り値は{suggestions: [{plan_id, weekdays, reasoning}, ...],
    missing_plan_ids: [...]}（DBへの反映は呼び出し元〔project_seats.py〕・フロントエンドの
    責任範囲外、あくまで提案）。missing_plan_idsは、渡したplan_idのうちAIの応答に含まれて
    いなかったもの（2026-09-09追加。従来は無言でその分だけ提案が欠けており、フロントエンドも
    返ってきたsuggestionsだけを反映するため、利用者が「グループ全体に提案が適用された」と
    誤認しうる不具合があった。呼び出し元がこれを見て利用者に知らせる）。fixed_seat_count
    （2026-09-15追加、「できるだけフリー座席を残すような感じにしたい」との要望を受けた）は
    そのグループの固定座席保有者数。曜日容量ぎりぎりまでプロジェクトで埋めると、一般の利用者が
    使うフリー座席が残らなくなるため、調整が必要な場合（複数の候補曜日がある場合）はできるだけ
    余裕を残す曜日を選ぶようプロンプトへ含める。"""
    if not OPENAI_API_KEY:
        raise WeekdayAiSuggestionError("OPENAI_API_KEYが設定されていません")

    prompt = _build_prompt(plans, weekday_capacity, fixed_seat_count)
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={
                    "model": OPENAI_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    # temperature=0（2026-09-15追加）: 容量に余裕がある（重複がない）プロジェクトでも
                    # 実行のたびに結果がぶれ、同じ入力なのに第一希望から動かされたりされなかったりする
                    # ことがあったため、なるべく決定的な出力にする狙いで追加。
                    "temperature": 0,
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": "weekday_suggestions",
                            "schema": _SUGGESTION_SCHEMA,
                            "strict": True,
                        },
                    },
                },
            )
            response.raise_for_status()
            data = response.json()
        content = data["choices"][0]["message"]["content"]
        suggestions = json.loads(content)["suggestions"]
    except Exception as e:
        # 従来はこの例外の詳細（原因がレート制限か、スキーマ不一致か、キー誤りか等）が
        # HTTPExceptionのdetail経由でも一切ログにも残らず、502発生時に原因を追えなかった
        # （2026-09-09修正）。ここでサーバーログに残す。
        logger.exception(
            "AI提案の生成に失敗しました（対象plan_id: %s、モデル: %s）",
            [p.get("plan_id") for p in plans], OPENAI_MODEL,
        )
        raise WeekdayAiSuggestionError(f"AI提案の生成に失敗しました: {e}") from e

    valid_plan_ids = {p["plan_id"] for p in plans}
    result = []
    for s in suggestions:
        plan_id = s.get("plan_id")
        if plan_id not in valid_plan_ids:
            continue
        weekdays = [w for w in s.get("weekdays", []) if w in WEEKDAYS]
        result.append({"plan_id": plan_id, "weekdays": weekdays, "reasoning": s.get("reasoning", "")})

    missing_plan_ids = sorted(valid_plan_ids - {r["plan_id"] for r in result})
    if missing_plan_ids:
        logger.warning("AI提案が一部のplan_idについて返ってこなかった: %s", missing_plan_ids)
    return {"suggestions": result, "missing_plan_ids": missing_plan_ids}
