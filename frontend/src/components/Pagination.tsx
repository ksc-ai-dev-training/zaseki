import { PAGE_SIZE_OPTIONS, pageNumbers } from '../hooks/usePagination'

// usePagination（frontend/src/hooks/usePagination.ts）と対になる表示部品。「全n件中x〜y件を表示」・
// 表示件数（10/25/50/100件）の選択・ページ番号ボタンをまとめて描画する（2026-09-29新設）
export default function Pagination({
  page, totalPages, totalCount, pageSize, onPageChange, onPageSizeChange,
}: {
  page: number
  totalPages: number
  totalCount: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-slate-500">
          全<strong className="text-slate-700">{totalCount}</strong>件中
          {totalCount === 0 ? 0 : (page - 1) * pageSize + 1}〜{Math.min(page * pageSize, totalCount)}件を表示
        </span>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          表示件数
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-7 rounded border border-slate-500 px-1.5 text-xs"
          >
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}件</option>)}
          </select>
        </label>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => onPageChange(page - 1)}
            className="h-7 w-7 rounded border border-slate-500 text-sm disabled:opacity-40"
          >
            ‹
          </button>
          {pageNumbers(page, totalPages).map((p, i) =>
            p === '…' ? (
              <span key={`e${i}`} className="px-1 text-sm text-slate-400">…</span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                className={`h-7 min-w-7 rounded border px-1.5 text-sm ${
                  p === page ? 'border-blue-800 bg-blue-800 text-white' : 'border-slate-500 hover:bg-slate-50'
                }`}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={page === totalPages}
            onClick={() => onPageChange(page + 1)}
            className="h-7 w-7 rounded border border-slate-500 text-sm disabled:opacity-40"
          >
            ›
          </button>
        </div>
      )}
    </div>
  )
}
