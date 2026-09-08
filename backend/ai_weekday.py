# 出社曜日調整のAI（LLM）による仮案生成（FR-03-11、A-74）。詳細設計書3.9節参照。
# DBへの書き込みは行わない。検討資料「プロジェクト座席・曜日調整フロー改善案」変更Cで
# 決定済みの方針（生成AI・座席容量の定義・優先順位付けは判断理由つきでAIに委ねる）に基づく。
import json
import os

import httpx

from database import ROOT_ENV

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
    return "・".join(_WEEKDAY_JA[w] for w in weekdays if w in _WEEKDAY_JA)


def _build_prompt(plans: list[dict], weekday_capacity: dict[str, int]) -> str:
    projects_lines = []
    for p in plans:
        line = (
            f"- plan_id={p['plan_id']} 「{p['project_name']}」: "
            f"第一希望={_ja_weekdays(p.get('choice1_weekdays'))}、"
            f"第二希望={_ja_weekdays(p.get('choice2_weekdays'))}"
        )
        if p.get("note"):
            line += f"、備考: {p['note']}"
        projects_lines.append(line)
    capacity_line = "、".join(f"{_WEEKDAY_JA[w]}: {weekday_capacity.get(w, 0)}人まで" for w in WEEKDAYS)

    return (
        "あなたはオフィスの座席管理を担当しています。以下のプロジェクトの出社曜日希望をもとに、"
        "各曜日の合計人数（プロジェクトごとの人数の合計）が座席容量を超えないよう、"
        "プロジェクトごとに出社曜日（月〜金の部分集合、空でもよい）を決めてください。\n\n"
        f"【曜日ごとの座席容量】\n{capacity_line}\n\n"
        f"【各プロジェクトの希望】\n" + "\n".join(projects_lines) + "\n\n"
        "第一希望をできるだけ優先しつつ、容量を超える場合は一部のプロジェクトを第二希望や、"
        "第一・第二希望のいずれにも該当しない曜日に調整してください。優先順位に固定的なルールは"
        "ないため、あなたが合理的だと考える理由をつけて判断してください。備考に出社できない曜日等の"
        "制約が書かれている場合は考慮してください。全プロジェクト（全plan_id）について、"
        "割り当てた曜日と日本語での判断理由を1件ずつ出力してください。"
    )


async def suggest_weekdays(plans: list[dict], weekday_capacity: dict[str, int]) -> list[dict]:
    """A-74: 各プロジェクトの第一・第二希望・備考（T-11）と曜日ごとの座席容量から、OpenAIへ
    仮の曜日調整案を問い合わせる。plans各要素は{plan_id, project_name, choice1_weekdays,
    choice2_weekdays, note}。戻り値は[{plan_id, weekdays, reasoning}, ...]（DBへの反映は
    呼び出し元〔project_seats.py〕・フロントエンドの責任範囲外、あくまで提案）。"""
    if not OPENAI_API_KEY:
        raise WeekdayAiSuggestionError("OPENAI_API_KEYが設定されていません")

    prompt = _build_prompt(plans, weekday_capacity)
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={
                    "model": OPENAI_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
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
        raise WeekdayAiSuggestionError(f"AI提案の生成に失敗しました: {e}") from e

    valid_plan_ids = {p["plan_id"] for p in plans}
    result = []
    for s in suggestions:
        plan_id = s.get("plan_id")
        if plan_id not in valid_plan_ids:
            continue
        weekdays = [w for w in s.get("weekdays", []) if w in WEEKDAYS]
        result.append({"plan_id": plan_id, "weekdays": weekdays, "reasoning": s.get("reasoning", "")})
    return result
