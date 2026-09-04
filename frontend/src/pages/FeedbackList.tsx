import { useState } from 'react'
import { useFeedback } from '../hooks/useFeedback'
import type { FeedbackCategory } from '../types'

type CategoryFilter = FeedbackCategory | 'all'

const CATEGORY_OPTIONS: { key: CategoryFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'bug', label: '不具合報告' },
  { key: 'request', label: '改善要望' },
  { key: 'other', label: 'その他' },
]

const CATEGORY_BADGE_CLASS: Record<FeedbackCategory, string> = {
  bug: 'bg-red-50 text-red-700',
  request: 'bg-blue-50 text-blue-700',
  other: 'bg-slate-100 text-slate-500',
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// S-14 フィードバック一覧。ヘルプ画面（S-13）の「フィードバック」タブから送信された内容を
// 管理部が確認する（A-60、要件定義書4.9節・FR-09-3、2026-09-01追加）
export default function FeedbackList() {
  const { items, isLoading } = useFeedback()
  const [filter, setFilter] = useState<CategoryFilter>('all')

  const filtered = (items ?? []).filter((it) => filter === 'all' || it.category === filter)

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">フィードバック一覧</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-14</span>
      </header>

      <div className="p-6">
        <div className="mb-4 flex gap-2">
          {CATEGORY_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setFilter(o.key)}
              className={`rounded-full px-3 py-1 text-sm ${filter === o.key ? 'bg-blue-800 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'}`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

        {!isLoading && (
          <div className="rounded border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="w-40 px-4 py-2">日時</th>
                  <th className="w-28 px-4 py-2">分類</th>
                  <th className="w-32 px-4 py-2">送信者</th>
                  <th className="px-4 py-2">内容</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.id} className="border-b border-slate-100 align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{formatDateTime(it.created_at)}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${CATEGORY_BADGE_CLASS[it.category]}`}>{it.category_ja}</span>
                    </td>
                    <td className="px-4 py-2">{it.name}</td>
                    <td className="whitespace-pre-wrap px-4 py-2">{it.content}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-slate-400">該当するフィードバックはありません</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
