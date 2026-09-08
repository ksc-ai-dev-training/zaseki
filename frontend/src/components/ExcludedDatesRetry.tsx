import { useState } from 'react'
import { ApiError } from '../lib/api'
import type { ExcludedDate, RetrySeatAssignmentResult } from '../types'

interface ExcludedDatesRetryProps {
  excludedDates: ExcludedDate[]
  onRetry: (dates: string[], seatNo: string) => Promise<RetrySeatAssignmentResult>
  onRetried: (result: RetrySeatAssignmentResult) => void
}

// 一括予約の結果で「除外」となった日の一覧と、別の座席番号を入力してその除外分だけ振り替える
// ミニフォーム（2026-09-07追加。「席を取って結果で除外が出てきたとき、除外部分だけ別の席に
// 変更できる機能が欲しい」との要望を受けた。座席番号（seat_no）で指定するのは、これを使う
// PJ席決担当が座席id一覧を取得する手段（A-22座席一覧）を持たない管理部以外のためで、
// フロアマップで見えている座席番号をそのまま入力できるようにするため）
export default function ExcludedDatesRetry({ excludedDates, onRetry, onRetried }: ExcludedDatesRetryProps) {
  const [seatNo, setSeatNo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (excludedDates.length === 0) return null

  const submit = async () => {
    if (!seatNo.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await onRetry(excludedDates.map((d) => d.date), seatNo.trim())
      onRetried(result)
      setSeatNo('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '振り替えに失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
      <ul className="mb-1.5 space-y-0.5">
        {excludedDates.map((d, i) => (
          <li key={i} className="text-xs text-amber-800">
            {d.date}: {d.reason}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          value={seatNo}
          onChange={(e) => setSeatNo(e.target.value)}
          placeholder="座席番号（例: C3）"
          className="h-7 w-32 rounded border border-slate-300 px-2 text-xs"
        />
        <button
          type="button"
          disabled={submitting || !seatNo.trim()}
          onClick={submit}
          className="h-7 rounded bg-blue-800 px-2 text-xs text-white hover:bg-blue-900 disabled:opacity-50"
        >
          この座席に変更
        </button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  )
}
