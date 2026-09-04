import { useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useFixedSeatAssignments } from '../hooks/useFixedSeatAssignments'
import { useFixedSeatCandidates } from '../hooks/useFixedSeatCandidates'
import Modal from '../components/Modal'
import type { AssignFixedSeatFor, FixedSeatAssignment, SeatType } from '../types'

const SEAT_STATUS_JA: Record<SeatType, string> = { free: 'フリー', fixed: '固定', project: 'PJ' }
const SEAT_STATUS_BADGE_CLASS: Record<SeatType, string> = {
  free: 'bg-slate-100 text-slate-600',
  fixed: 'bg-blue-50 text-blue-700',
  project: 'bg-amber-50 text-amber-700',
}

// S-05 固定座席の指定。実際の座席選択はここでは行わず、S-02のフロアマップへ
// 「固定座席指定モード」で遷移して行う（4.4節）
export default function FixedSeats() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const { items: candidates, isLoading: candidatesLoading } = useFixedSeatCandidates(query)
  const [assignmentQuery, setAssignmentQuery] = useState('')
  const { items: allAssignments, isLoading: assignmentsLoading, refresh: refreshAssignments } = useFixedSeatAssignments()
  const assignments = assignmentQuery
    ? allAssignments.filter((a) => a.user_name.includes(assignmentQuery))
    : allAssignments

  const [unassignTarget, setUnassignTarget] = useState<FixedSeatAssignment | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const goAssign = (target: AssignFixedSeatFor) => {
    navigate('/', { state: { assignFixedSeatFor: target } })
  }

  const confirmUnassign = async () => {
    if (!unassignTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/fixed-seat-assignments/${unassignTarget.seat_id}`, { method: 'DELETE' })
      setUnassignTarget(null)
      await refreshAssignments()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '解除に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">固定座席の指定（対象者選択）</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-05</span>
      </header>

      <div className="space-y-6 p-6">
        <div className="rounded border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 font-semibold">新しく固定座席を指定する</div>
          <div className="p-4">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="氏名で検索（固定座席を持たない利用者が対象）"
              className="mb-3 h-9 w-full max-w-sm rounded border border-slate-300 px-3 text-sm"
            />
            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="pb-2 pr-3">氏名</th>
                    <th className="pb-2 pr-3">現在の座席利用状況</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.user_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{c.user_name}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded px-2 py-0.5 text-xs ${SEAT_STATUS_BADGE_CLASS[c.current_status]}`}>
                          {SEAT_STATUS_JA[c.current_status]}
                        </span>
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => goAssign({ userId: c.user_id, userName: c.user_name })}
                          className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900"
                        >
                          この人に固定座席を指定する
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!candidatesLoading && candidates.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-slate-400">対象者が見つかりません</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="rounded border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3 font-semibold">
            固定座席利用者（現在の割当）
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">{assignments.length}件</span>
            <input
              type="search"
              value={assignmentQuery}
              onChange={(e) => setAssignmentQuery(e.target.value)}
              placeholder="氏名で検索"
              className="ml-auto h-9 w-full max-w-[220px] rounded border border-slate-300 px-3 text-sm font-normal"
            />
          </div>
          <div className="overflow-x-auto p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="pb-2 pr-3">氏名</th>
                  <th className="pb-2 pr-3">固定座席</th>
                  <th className="pb-2 pr-3">エリア</th>
                  <th className="pb-2 pr-3">期限</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.seat_id} className="border-b border-slate-100">
                    <td className="py-2 pr-3">{a.user_name}</td>
                    <td className="py-2 pr-3">{a.seat_no}</td>
                    <td className="py-2 pr-3">{a.area}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">{a.valid_until ?? '無期限'}</td>
                    <td className="py-2">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => goAssign({ userId: a.user_id, userName: a.user_name })}
                          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          座席を変更する
                        </button>
                        <button
                          type="button"
                          onClick={() => { setActionError(null); setUnassignTarget(a) }}
                          className="rounded border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          解除する
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!assignmentsLoading && assignments.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-slate-400">
                      {assignmentQuery ? '該当する利用者がいません' : '固定座席の割当はありません'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {unassignTarget && (
        <Modal
          title="固定座席の解除"
          onClose={() => setUnassignTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setUnassignTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={confirmUnassign} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">解除する</button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">氏名</dt><dd>{unassignTarget.user_name}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">固定座席</dt><dd>{unassignTarget.seat_no}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{unassignTarget.area}</dd></div>
          </dl>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}
    </div>
  )
}
