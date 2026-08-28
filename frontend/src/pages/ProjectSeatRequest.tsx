import { useState } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useMyProjects } from '../hooks/useMyProjects'
import { useProjectPlanDetail } from '../hooks/useProjectPlanDetail'
import type {
  MyProjectItem, PreviousPlanDetail, ProjectPlanDetail, QuarterPlanStatus,
  SeatAssignmentResult, Weekday,
} from '../types'

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

const STATUS_LABEL: Record<QuarterPlanStatus, string> = {
  seats_confirmed: 'アンケート未送信',
  survey_open: '曜日アンケート回答受付中',
  weekdays_finalized: '曜日確定済み（座席の島の割当待ち）',
  seats_allocated: '座席割当済み',
}
const STATUS_BADGE_CLASS: Record<QuarterPlanStatus, string> = {
  seats_confirmed: 'bg-slate-100 text-slate-500',
  survey_open: 'bg-amber-50 text-amber-700',
  weekdays_finalized: 'bg-blue-50 text-blue-700',
  seats_allocated: 'bg-green-50 text-green-700',
}

function WeekdayCheckboxGroup({ label, value, onChange }: { label: string; value: Set<Weekday>; onChange: (v: Set<Weekday>) => void }) {
  const toggle = (day: Weekday) => {
    const next = new Set(value)
    if (next.has(day)) next.delete(day)
    else next.add(day)
    onChange(next)
  }
  return (
    <div>
      <div className="mb-1 text-xs text-slate-500">{label}（曜日を2つ選択）</div>
      <div className="flex gap-3">
        {WEEKDAYS.map((w) => (
          <label key={w.key} className="inline-flex items-center gap-1 text-sm">
            <input type="checkbox" checked={value.has(w.key)} onChange={() => toggle(w.key)} />
            {w.label}
          </label>
        ))}
      </div>
    </div>
  )
}

// S-04 プロジェクト座席（PM側）。詳細設計書3.4節・4.3節
export default function ProjectSeatRequest() {
  const { items, error, isLoading } = useMyProjects()

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">プロジェクト座席</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-04</span>
      </header>

      <div className="space-y-8 p-6">
        {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">読み込みに失敗しました</p>}
        {!isLoading && items.length === 0 && (
          <p className="text-sm text-slate-400">所属しているプロジェクトはありません。</p>
        )}
        {items.map((mp) => <ProjectSection key={mp.project_id} item={mp} />)}
      </div>
    </div>
  )
}

function ProjectSection({ item }: { item: MyProjectItem }) {
  const roleLabel = item.project_title ?? '一般メンバー'

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-bold">
        {item.project_name}
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">{roleLabel}</span>
      </h2>
      {item.plan ? (
        <PlanPanel planId={item.plan.id} summaryStatus={item.plan.status} />
      ) : (
        <p className="rounded border border-slate-200 bg-white px-4 py-3 text-sm text-slate-400">
          対象四半期の計画はまだ開始されていません。
        </p>
      )}
    </section>
  )
}

function PlanPanel({ planId, summaryStatus }: { planId: number; summaryStatus: QuarterPlanStatus }) {
  const { plan, refresh } = useProjectPlanDetail(planId)
  const [showPrevious, setShowPrevious] = useState(false)
  const [previous, setPrevious] = useState<PreviousPlanDetail | null>(null)
  const [previousError, setPreviousError] = useState<string | null>(null)

  const loadPrevious = async () => {
    setPreviousError(null)
    try {
      const data = await apiFetch<PreviousPlanDetail>(`/api/project-quarter-plans/${planId}/previous`)
      setPrevious(data)
      setShowPrevious(true)
    } catch (e) {
      setPreviousError(e instanceof ApiError ? e.message : '前回分の取得に失敗しました')
    }
  }

  if (!plan) return <p className="text-sm text-slate-400">読み込み中...</p>

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="px-4 py-2">対象四半期</th>
              <th className="px-4 py-2">状態</th>
              {plan.has_previous_plan && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-4 py-2 font-semibold">{plan.period_start} 〜 {plan.period_end}</td>
              <td className="px-4 py-2">
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_BADGE_CLASS[summaryStatus]}`}>
                  {STATUS_LABEL[summaryStatus]}
                  {summaryStatus === 'seats_allocated' && plan.allocated_seat_label && `（${plan.allocated_seat_label}）`}
                </span>
              </td>
              {plan.has_previous_plan && (
                <td className="px-4 py-2 text-right">
                  <button type="button" onClick={loadPrevious} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    前回分を見る
                  </button>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      {previousError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{previousError}</p>}
      {showPrevious && previous && (
        <div className="rounded border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 font-semibold">
            <span>前回分（{previous.period_start} 〜 {previous.period_end}）の座席割当</span>
            <button type="button" onClick={() => setShowPrevious(false)} className="text-xs font-normal text-slate-400 hover:text-slate-600">閉じる</button>
          </div>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="pb-2 pr-3">氏名</th>
                  <th className="pb-2">座席</th>
                </tr>
              </thead>
              <tbody>
                {previous.assignments.map((a) => (
                  <tr key={a.user_id} className="border-b border-slate-100">
                    <td className="py-2 pr-3">{a.name}</td>
                    <td className="py-2">{a.seat_no ?? '未確保'}</td>
                  </tr>
                ))}
                {previous.assignments.length === 0 && (
                  <tr><td colSpan={2} className="py-3 text-center text-slate-400">確保された座席はありませんでした</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {plan.is_pmpl && plan.status === 'survey_open' && (
        <SurveyForm plan={plan} onSubmitted={refresh} />
      )}

      {plan.is_pmpl && (
        <MemberManagement plan={plan} onChanged={refresh} />
      )}

      {plan.can_manage_seat_assign && plan.status === 'seats_allocated' && (
        <BulkSeatAssign plan={plan} onChanged={refresh} />
      )}
    </div>
  )
}

function SurveyForm({ plan, onSubmitted }: { plan: ProjectPlanDetail; onSubmitted: () => void }) {
  const [choice1, setChoice1] = useState<Set<Weekday>>(new Set(plan.response?.choice1_weekdays ?? []))
  const [choice2, setChoice2] = useState<Set<Weekday>>(new Set(plan.response?.choice2_weekdays ?? []))
  const [note, setNote] = useState(plan.response?.note ?? '')
  const [requestedSeats, setRequestedSeats] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (choice1.size !== 2) { setError('第一希望は曜日を2つ選択してください'); return }
    if (choice2.size !== 2) { setError('第二希望は曜日を2つ選択してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${plan.id}/response`, {
        method: 'PUT',
        body: JSON.stringify({
          choice1_weekdays: [...choice1], choice2_weekdays: [...choice2],
          note: note || null,
          requested_seats: requestedSeats ? Number(requestedSeats) : null,
        }),
      })
      onSubmitted()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '回答に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">出社曜日アンケートの回答</div>
      <div className="space-y-4 p-4">
        <WeekdayCheckboxGroup label="第一希望" value={choice1} onChange={setChoice1} />
        <WeekdayCheckboxGroup label="第二希望" value={choice2} onChange={setChoice2} />
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">備考（任意）</span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="エリア責任者への伝達事項があれば入力"
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">必要座席数の変更希望（現在: {plan.required_seats}名）</span>
          <input
            type="number"
            min={1}
            value={requestedSeats}
            onChange={(e) => setRequestedSeats(e.target.value)}
            placeholder="変更後の人数（変更がなければ空欄のまま）"
            className="h-9 w-56 rounded border border-slate-300 px-3 text-sm"
          />
        </label>
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="text-right">
          <button type="button" disabled={submitting} onClick={submit} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            この内容で回答する
          </button>
        </div>
      </div>
    </div>
  )
}

function MemberManagement({ plan, onChanged }: { plan: ProjectPlanDetail; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (memberId: number, next: boolean) => {
    setBusyId(memberId)
    setError(null)
    try {
      await apiFetch(`/api/project-members/${memberId}/seat-assign-permission`, {
        method: 'PUT',
        body: JSON.stringify({ can_assign_seats: next }),
      })
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '更新に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">メンバー管理（席決め権限）</div>
      <div className="p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="pb-2 pr-3">氏名</th>
              <th className="pb-2 pr-3">役割</th>
              <th className="pb-2">席決め権限</th>
            </tr>
          </thead>
          <tbody>
            {plan.members.map((m) => (
              <tr key={m.member_id} className="border-b border-slate-100">
                <td className="py-2 pr-3">{m.name}</td>
                <td className="py-2 pr-3 text-xs text-slate-500">{m.project_title ?? '一般メンバー'}</td>
                <td className="py-2">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={m.can_assign_seats}
                      disabled={busyId === m.member_id}
                      onChange={(e) => toggle(m.member_id, e.target.checked)}
                    />
                    席決めを任せる
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </div>
  )
}

function BulkSeatAssign({ plan, onChanged }: { plan: ProjectPlanDetail; onChanged: () => void }) {
  const [picks, setPicks] = useState<Record<number, number | ''>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SeatAssignmentResult[] | null>(null)

  const unassigned = plan.members.filter((m) => m.assigned_seat_id === null && !m.has_fixed_seat)
  const assignedSeatIds = new Set(plan.members.map((m) => m.assigned_seat_id).filter((v): v is number => v !== null))
  const seatOptions = (plan.allocated_seats ?? []).filter((s) => !assignedSeatIds.has(s.id))

  const submit = async () => {
    const assignments = Object.entries(picks)
      .filter(([, seatId]) => seatId !== '')
      .map(([userId, seatId]) => ({ member_user_id: Number(userId), seat_id: seatId as number }))
    if (assignments.length === 0) {
      setError('座席を選んだメンバーがいません。少なくとも1名の座席を選んでください。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const data = await apiFetch<{ results: SeatAssignmentResult[] }>(`/api/project-quarter-plans/${plan.id}/seat-assignments`, {
        method: 'POST',
        body: JSON.stringify({ assignments }),
      })
      setResults(data.results)
      setPicks({})
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '確保に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">メンバーへの座席確保</div>
      <div className="p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="pb-2 pr-3">氏名</th>
              <th className="pb-2 pr-3">座席の確保状況</th>
              <th className="pb-2">割り当てる座席</th>
            </tr>
          </thead>
          <tbody>
            {plan.members.map((m) => (
              <tr key={m.member_id} className="border-b border-slate-100">
                <td className="py-2 pr-3">{m.name}</td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  {m.has_fixed_seat ? '固定座席あり' : m.assigned_seat_no ? `${m.assigned_seat_no} に確保済み` : '未確保'}
                </td>
                <td className="py-2">
                  {m.has_fixed_seat ? (
                    <span className="text-xs text-slate-400">対象外（固定座席保有者）</span>
                  ) : m.assigned_seat_id === null ? (
                    <select
                      value={picks[m.user_id] ?? ''}
                      onChange={(e) => setPicks((prev) => ({ ...prev, [m.user_id]: e.target.value ? Number(e.target.value) : '' }))}
                      className="h-8 w-32 rounded border border-slate-300 px-2 text-sm"
                    >
                      <option value="">座席を選択</option>
                      {seatOptions.map((s) => (
                        <option key={s.id} value={s.id}>{s.seat_no}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="mt-3 text-right">
          <button type="button" disabled={submitting || unassigned.length === 0} onClick={submit} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            この内容で一括確保する
          </button>
        </div>

        {results && (
          <div className="mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="pb-2 pr-3">氏名</th>
                  <th className="pb-2 pr-3">座席</th>
                  <th className="pb-2">結果</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const member = plan.members.find((m) => m.user_id === r.member_user_id)
                  return (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{member?.name ?? r.member_user_id}</td>
                      <td className="py-2 pr-3">{r.seat_no}</td>
                      <td className="py-2">
                        {r.status === 'assigned' ? (
                          <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700">
                            確保済み{r.excluded_days ? `（${r.excluded_days}日を除外）` : ''}
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">除外（{r.reason}）</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

