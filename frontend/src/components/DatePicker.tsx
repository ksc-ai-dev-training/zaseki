import { useEffect, useRef, useState } from 'react'

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']

function toDateObj(s: string): Date {
  return new Date(`${s}T00:00:00`)
}
function fmt(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 月の1日を含む週の日曜から、月末を含む週の土曜まで（6週間・42マス）を並べる
function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

/**
 * ブラウザ標準<input type="date">の代替コンポーネント。月表示のカレンダーで日付をクリックして
 * 選ぶ操作感はそのまま踏襲しつつ、標準カレンダーに付いてくる「削除」（選択日をクリアするリンク）は
 * 持たない（2026-09-28新設。「削除ボタンを押すと日付がNaN年NaN月NaN日になる、削除機能自体を
 * なくしてほしい」との要望を受けた。標準の<input type="date">はrequired等を付けても「削除」リンクを
 * 個別に消す方法がないため、カレンダー部分を自前実装に置き換えた）。valueは空文字にはならない
 * （常にYYYY-MM-DDを保つ）前提のコンポーネントのため、標準のonChangeのように空文字が渡ることはない
 */
export default function DatePicker({
  value, onChange, min, max, disabled, className,
}: {
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [viewYear, setViewYear] = useState(() => (value ? toDateObj(value) : new Date()).getFullYear())
  const [viewMonth, setViewMonth] = useState(() => (value ? toDateObj(value) : new Date()).getMonth())
  const rootRef = useRef<HTMLDivElement>(null)

  // 開くたびに、現在選択中の日付が見える月へ表示を合わせる
  useEffect(() => {
    if (!open) return
    const base = value ? toDateObj(value) : new Date()
    setViewYear(base.getFullYear())
    setViewMonth(base.getMonth())
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const shiftMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1)
    setViewYear(d.getFullYear())
    setViewMonth(d.getMonth())
  }
  const pick = (d: Date) => {
    onChange(fmt(d))
    setOpen(false)
  }
  const isOutOfRange = (s: string) => (min !== undefined && s < min) || (max !== undefined && s > max)

  return (
    <div className={`relative inline-block ${className ?? ''}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full items-center justify-between gap-2 rounded border border-slate-500 bg-white px-2 text-sm disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
      >
        <span>{value ? value.replaceAll('-', '/') : ''}</span>
        <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="14" height="13" rx="1.5" />
          <path d="M3 8h14M6.5 2.5v3M13.5 2.5v3" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-64 rounded border border-slate-400 bg-white p-2 text-slate-800 shadow-lg">
          <div className="mb-1 flex items-center justify-between">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="前の月" className="h-6 w-6 rounded hover:bg-slate-100">‹</button>
            <span className="text-sm font-semibold">{viewYear}年{viewMonth + 1}月</span>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="次の月" className="h-6 w-6 rounded hover:bg-slate-100">›</button>
          </div>
          <div className="grid grid-cols-7 text-center text-xs text-slate-500">
            {WEEKDAY_JA.map((w) => <div key={w} className="py-1">{w}</div>)}
          </div>
          <div className="grid grid-cols-7 text-center text-xs">
            {buildMonthGrid(viewYear, viewMonth).map((d) => {
              const s = fmt(d)
              const inMonth = d.getMonth() === viewMonth
              const blocked = isOutOfRange(s)
              const selected = s === value
              return (
                <button
                  key={s}
                  type="button"
                  disabled={blocked}
                  onClick={() => pick(d)}
                  className={`m-0.5 rounded py-1 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent ${
                    selected ? 'bg-blue-800 text-white' : inMonth ? 'text-slate-800 hover:bg-slate-100' : 'text-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {d.getDate()}
                </button>
              )
            })}
          </div>
          {!isOutOfRange(fmt(new Date())) && (
            <div className="mt-1 text-right">
              <button type="button" onClick={() => pick(new Date())} className="text-xs text-blue-700 hover:underline">今日</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
