import { useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useProxyCandidates } from '../hooks/useProxyCandidates'
import { useProxySearch, type ProxySeatTypeFilter } from '../hooks/useProxySearch'
import Modal from '../components/Modal'
import type { ProxyBookingFor, ProxyRow } from '../types'

const SEAT_TYPE_OPTIONS: { key: ProxySeatTypeFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'free', label: 'フリー座席' },
  { key: 'fixed', label: '固定座席' },
]
const SEAT_TYPE_JA: Record<'free' | 'fixed', string> = { free: 'フリー座席', fixed: '固定座席' }

function formatDateJa(dateStr: string): string {
  const weekdayJa = ['日', '月', '火', '水', '木', '金', '土']
  const d = new Date(`${dateStr}T00:00:00`)
  return `${dateStr}（${weekdayJa[d.getDay()]}）`
}

// S-11 代理予約・取消。実際の座席選択（新規の代理予約）はここでは行わず、S-02のフロアマップへ
// 「代理予約モード」で遷移して行う（4.11節）
export default function ProxyBooking() {
  const navigate = useNavigate()
  const [candidateQuery, setCandidateQuery] = useState('')
  const { items: candidates, isLoading: candidatesLoading } = useProxyCandidates(candidateQuery)

  const [rowUserName, setRowUserName] = useState('')
  const [seatType, setSeatType] = useState<ProxySeatTypeFilter>('all')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const { items: rows, isLoading: rowsLoading, refresh: refreshRows } = useProxySearch(rowUserName, seatType, periodStart, periodEnd)

  const [cancelTarget, setCancelTarget] = useState<ProxyRow | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const goProxyBook = (target: ProxyBookingFor) => {
    navigate('/', { state: { proxyBookingFor: target } })
  }

  const confirmCancel = async () => {
    if (!cancelTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      if (cancelTarget.kind === 'fixed') {
        await apiFetch(`/api/fixed-seat-assignments/${cancelTarget.id}`, { method: 'DELETE' })
      } else {
        await apiFetch(`/api/reservations/proxy/${cancelTarget.id}`, { method: 'DELETE' })
      }
      setCancelTarget(null)
      await refreshRows()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : (cancelTarget.kind === 'fixed' ? '解除に失敗しました' : '取消に失敗しました'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">代理予約・取消（対象者選択）</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-11</span>
      </header>

      <div className="space-y-6 p-6">
        <div className="rounded border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 font-semibold">代理予約する対象者を選ぶ</div>
          <div className="p-4">
            <input
              type="search"
              value={candidateQuery}
              onChange={(e) => setCandidateQuery(e.target.value)}
              placeholder="氏名で検索（登録済みの利用者が対象）"
              className="mb-3 h-9 w-full max-w-sm rounded border border-slate-300 px-3 text-sm"
            />
            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="sticky top-0 z-10 border-b border-slate-200 bg-white text-left text-slate-500">
                    <th className="pb-2 pr-3">氏名</th>
                    <th className="pb-2 pr-3">雇用形態</th>
                    <th className="pb-2 pr-3">現在の座席利用状況</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.user_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{c.user_name}</td>
                      <td className="py-2 pr-3">{c.employment_type}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{c.current_status}</td>
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => goProxyBook({ userId: c.user_id, userName: c.user_name })}
                          className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900"
                        >
                          この人を代理予約する
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!candidatesLoading && candidates.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-slate-400">対象者が見つかりません</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="rounded border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 font-semibold">座席の予約・割当を代理で取り消す</div>
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input
                type="search"
                value={rowUserName}
                onChange={(e) => setRowUserName(e.target.value)}
                placeholder="氏名で検索"
                className="h-9 w-full max-w-[220px] rounded border border-slate-300 px-3 text-sm"
              />
              <span className="text-sm text-slate-500">座席種別</span>
              <select
                value={seatType}
                onChange={(e) => setSeatType(e.target.value as ProxySeatTypeFilter)}
                className="h-9 rounded border border-slate-300 px-2 text-sm"
              >
                {SEAT_TYPE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <span className="text-sm text-slate-500">表示期間</span>
              <input
                type="month"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="h-9 rounded border border-slate-300 px-2 text-sm"
              />
              <span className="text-slate-400">〜</span>
              <input
                type="month"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="h-9 rounded border border-slate-300 px-2 text-sm"
              />
            </div>
            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="sticky top-0 z-10 border-b border-slate-200 bg-white text-left text-slate-500">
                    <th className="pb-2 pr-3">氏名</th>
                    <th className="pb-2 pr-3">座席種別</th>
                    <th className="pb-2 pr-3">日付</th>
                    <th className="pb-2 pr-3">座席</th>
                    <th className="pb-2 pr-3">エリア</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}-${r.id}`} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{r.user_name}</td>
                      <td className="py-2 pr-3">
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{SEAT_TYPE_JA[r.seat_type]}</span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{r.date ? formatDateJa(r.date) : '恒久的な割当（日付なし）'}</td>
                      <td className="py-2 pr-3">{r.seat_no}</td>
                      <td className="py-2 pr-3">{r.area}</td>
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => { setActionError(null); setCancelTarget(r) }}
                          className="rounded border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          {r.kind === 'fixed' ? '解除' : '取消'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!rowsLoading && rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-slate-400">該当する予約・割当がありません</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {cancelTarget && (
        <Modal
          title={cancelTarget.kind === 'fixed' ? '座席の解除（代理）' : '予約の取消（代理）'}
          onClose={() => setCancelTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setCancelTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={confirmCancel} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">
                {cancelTarget.kind === 'fixed' ? '解除する' : '取消する'}
              </button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">対象者</dt><dd>{cancelTarget.user_name}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席種別</dt><dd>{SEAT_TYPE_JA[cancelTarget.seat_type]}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">日付</dt><dd>{cancelTarget.date ? formatDateJa(cancelTarget.date) : '－'}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{cancelTarget.seat_no}</dd></div>
          </dl>
          <p className="mt-3 text-sm text-slate-600">
            {cancelTarget.kind === 'fixed' ? 'この固定座席の割当を解除します。よろしいですか？' : 'この予約を取り消します。よろしいですか？'}
          </p>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}
    </div>
  )
}
