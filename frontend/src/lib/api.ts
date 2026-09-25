// APIクライアント（fetchラッパー）。401は共通処理で /login へリダイレクトする

export class ApiError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

// Pydanticのバリデーションエラー種別（item.type）ごとの日本語メッセージ。フィールド名（loc）は
// APIの内部パラメータ名（英語）でありそのまま出しても利用者には伝わらないため含めない。ここに
// ない種別は汎用メッセージにフォールバックする（すべてを網羅する必要はない。この経路自体、HTML側の
// input要素のチェックをすり抜けた入力等、通常操作ではまず起こらない想定外系のエラー用のため）
const PYDANTIC_ERROR_MESSAGES: Record<string, string> = {
  int_parsing: '整数で入力してください（小数点は使用できません）',
  int_from_float: '整数で入力してください（小数点は使用できません）',
  int_type: '整数で入力してください',
  float_parsing: '数値で入力してください',
  string_type: '文字列で入力してください',
  missing: '入力してください',
  greater_than_equal: '値が小さすぎます',
  less_than_equal: '値が大きすぎます',
  string_too_long: '文字数が多すぎます',
}
const GENERIC_VALIDATION_MESSAGE = '入力内容が正しくありません'

// FastAPIのバリデーションエラー（Pydanticが型不正等で自動的に返す422応答）はdetailが
// 文字列ではなく{type, loc, msg, ...}の配列になる。従来はbody.detailをそのまま文字列扱いして
// いたため、Error(detail)がArray.prototype.toString()経由で"[object Object]"になり、画面に
// 無意味なエラーメッセージが表示されていた（2026-09-25発見。数値欄に小数を入力する等、HTML側の
// number input（type="number"）は小数の入力自体を止めないため、実運用でも起こりうる）。msgは
// Pydantic組み込みの英語メッセージ（例: "Input should be a valid integer, got a number with
// a fractional part"）でそのまま出しても利用者には読めないため使わず、typeを日本語メッセージへ
// 変換する（2026-09-25追加。「エラー文を日本語訳してほしい」との指摘を受けた）。
function extractDetail(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const messages = raw.map((item) => {
      if (item && typeof item === 'object' && 'type' in item) {
        return PYDANTIC_ERROR_MESSAGES[String((item as { type: unknown }).type)] ?? GENERIC_VALIDATION_MESSAGE
      }
      return typeof item === 'string' ? item : GENERIC_VALIDATION_MESSAGE
    })
    return messages.length > 0 ? [...new Set(messages)].join('、') : null
  }
  if (raw && typeof raw === 'object') return GENERIC_VALIDATION_MESSAGE
  return null
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.location.href = '/login'
  }
  if (!res.ok) {
    let detail = 'エラーが発生しました'
    try {
      const body = await res.json()
      const parsed = extractDetail(body?.detail)
      if (parsed) detail = parsed
    } catch {
      // JSONでないレスポンスは汎用メッセージのまま
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}
