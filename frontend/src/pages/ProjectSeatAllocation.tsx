import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useProjects } from '../hooks/useProjects'
import { useQuarterPlans } from '../hooks/useQuarterPlans'
import Modal from '../components/Modal'
import type { QuarterPlanItem, QuarterPlanStatus, Weekday } from '../types'

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

const STATUS_LABEL: Record<QuarterPlanStatus, (p: QuarterPlanItem) => string> = {
  seats_confirmed: () => 'アンケート未送信',
  survey_open: (p) => `アンケート回答受付中（${p.has_response ? '回答済み' : '未回答'}）`,
  weekdays_finalized: () => '曜日確定済み（座席の島の割当待ち）',
  seats_allocated: (p) => `座席割当済み（${p.allocated_seat_label}）`,
}
const STATUS_BADGE_CLASS: Record<QuarterPlanStatus, string> = {
  seats_confirmed: 'bg-slate-100 text-slate-500',
  survey_open: 'bg-amber-50 text-amber-700',
  weekdays_finalized: 'bg-blue-50 text-blue-700',
  seats_allocated: 'bg-green-50 text-green-700',
}

function formatQuarterLabel(periodStart: string): string {
  const [y, m] = periodStart.split('-')
  const startMonth = Number(m)
  return `${y}年${startMonth}〜${startMonth + 2}月`
}

// S-09 プロジェクト座席（エリア担当）。座席の島の割当（A-44）はS-02のフロアマップへ
// 「座席の島の割当モード」で遷移して行う（4.7節）
export default function ProjectSeatAllocation() {
  const navigate = useNavigate()
  const { items: projects, nextQuarterStart, nextQuarterEnd, refresh: refreshProjects } = useProjects()
  const { items: allPlans, refresh: refreshAllPlans } = useQuarterPlans('')

  const [selectedQuarter, setSelectedQuarter] = useState('')
  const { items: plans, refresh: refreshPlans } = useQuarterPlans(selectedQuarter)

  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [headcountTarget, setHeadcountTarget] = useState<QuarterPlanItem | null>(null)
  const [headcountValue, setHeadcountValue] = useState(1)
  const [surveyTarget, setSurveyTarget] = useState<QuarterPlanItem | null>(null)

  const refreshAll = async () => {
    await Promise.all([refreshProjects(), refreshAllPlans(), refreshPlans()])
  }

  const quarterTabs = useMemo(() => {
    const starts = [...new Set(allPlans.map((p) => p.period_start))].sort()
    return starts
  }, [allPlans])

  const startablePlans = projects.filter((p) => !p.has_plan_for_next_quarter)

  const startPlan = async (projectId: number) => {
    if (!nextQuarterStart) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/projects/${projectId}/quarter-plans`, {
        method: 'POST',
        body: JSON.stringify({ period_start: nextQuarterStart }),
      })
      setActionMessage('四半期計画を開始しました')
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '開始に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const openHeadcount = (p: QuarterPlanItem) => {
    setActionError(null)
    setHeadcountValue(p.required_seats)
    setHeadcountTarget(p)
  }
  const submitHeadcount = async () => {
    if (!headcountTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${headcountTarget.id}/required-seats`, {
        method: 'PUT',
        body: JSON.stringify({ required_seats: headcountValue }),
      })
      setHeadcountTarget(null)
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const openSurvey = (p: QuarterPlanItem) => {
    setActionError(null)
    setSurveyTarget(p)
  }
  const submitSurvey = async () => {
    if (!surveyTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${surveyTarget.id}/survey`, { method: 'POST' })
      setSurveyTarget(null)
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const sendReminder = async (p: QuarterPlanItem) => {
    setActionError(null)
    setActionMessage(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${p.id}/survey-reminder`, { method: 'POST' })
      setActionMessage(`${p.project_name} にリマインドを送信しました`)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'リマインドの送信に失敗しました')
    }
  }

  const goSeatBlock = (p: QuarterPlanItem) => {
    navigate('/', { state: { seatBlockFor: { planId: p.id, projectName: p.project_name, requiredSeats: p.required_seats } } })
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">プロジェクト座席（エリア担当）</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-09</span>
      </header>

      <div className="space-y-6 p-6">
        {actionMessage && <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{actionMessage}</p>}
        {actionError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}

        <div className="rounded border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 font-semibold">四半期計画を開始する</div>
          <div className="p-4">
            <p className="mb-3 text-xs text-slate-500">対象四半期の計画がまだ始まっていないプロジェクトの一覧。</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="pb-2 pr-3">プロジェクト</th>
                  <th className="pb-2 pr-3">対象四半期</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {startablePlans.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 font-semibold">{p.name}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">{nextQuarterStart} 〜 {nextQuarterEnd}</td>
                    <td className="py-2">
                      <button type="button" disabled={submitting} onClick={() => startPlan(p.id)} className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900 disabled:opacity-50">
                        開始する
                      </button>
                    </td>
                  </tr>
                ))}
                {startablePlans.length === 0 && (
                  <tr><td colSpan={3} className="py-4 text-center text-slate-400">対象のプロジェクトはありません</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 border-b border-slate-200">
          <button
            type="button"
            onClick={() => setSelectedQuarter('')}
            className={`border-b-2 px-3 py-2 text-sm ${selectedQuarter === '' ? 'border-blue-800 text-blue-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            すべて
          </button>
          {quarterTabs.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setSelectedQuarter(q)}
              className={`border-b-2 px-3 py-2 text-sm ${selectedQuarter === q ? 'border-blue-800 text-blue-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {formatQuarterLabel(q)}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-4 py-2">プロジェクト</th>
                <th className="px-4 py-2">PM（PL）</th>
                <th className="px-4 py-2">対象四半期</th>
                <th className="px-4 py-2">必要座席数</th>
                <th className="px-4 py-2">状態</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="px-4 py-2 font-semibold" title={p.note ?? undefined}>
                    {p.project_name}{p.note && <span className="ml-1 text-amber-500" title={p.note}>備考あり</span>}
                  </td>
                  <td className="px-4 py-2">{p.pm_pl_names}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{p.period_start} 〜 {p.period_end}</td>
                  <td className="px-4 py-2 font-semibold">{p.required_seats}名</td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_BADGE_CLASS[p.status]}`}>{STATUS_LABEL[p.status](p)}</span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      {p.status === 'seats_confirmed' && (
                        <button type="button" onClick={() => openSurvey(p)} className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900">アンケートを送る</button>
                      )}
                      {p.status === 'survey_open' && (
                        <button type="button" onClick={() => sendReminder(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">リマインドを送る</button>
                      )}
                      {p.status === 'weekdays_finalized' && (
                        <button type="button" onClick={() => goSeatBlock(p)} className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900">座席の島を割り当てる</button>
                      )}
                      {p.status !== 'seats_allocated' && (
                        <button type="button" onClick={() => openHeadcount(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">人数を修正</button>
                      )}
                      {p.status === 'seats_allocated' && (
                        <button type="button" disabled className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-400">完了</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {plans.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-slate-400">該当する計画がありません</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedQuarter && (
          <WeekdayMatrix
            quarter={selectedQuarter}
            plans={plans.filter((p) => p.status === 'survey_open')}
            onFinalized={refreshAll}
          />
        )}
      </div>

      {headcountTarget && (
        <Modal
          title={`必要座席数の確認・修正（${headcountTarget.project_name}）`}
          onClose={() => setHeadcountTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setHeadcountTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitHeadcount} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">この内容で保存する</button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">対象四半期</span><span>{headcountTarget.period_start} 〜 {headcountTarget.period_end}</span></div>
            <label className="block">
              <span className="mb-1 block text-slate-500">必要座席数</span>
              <input
                type="number"
                min={1}
                value={headcountValue}
                onChange={(e) => setHeadcountValue(Number(e.target.value))}
                className="h-9 w-28 rounded border border-slate-300 px-3"
              />
            </label>
            {actionError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{actionError}</p>}
          </div>
        </Modal>
      )}

      {surveyTarget && (
        <Modal
          title={`出社曜日アンケートの送信（${surveyTarget.project_name}）`}
          onClose={() => setSurveyTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setSurveyTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitSurvey} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">アンケートを送信する</button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">対象四半期</dt><dd>{surveyTarget.period_start} 〜 {surveyTarget.period_end}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">必要座席数</dt><dd>{surveyTarget.required_seats}名<span className="ml-1 text-xs text-slate-400">（現状のプロジェクト人数）</span></dd></div>
          </dl>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}
    </div>
  )
}

function WeekdayMatrix({ quarter, plans, onFinalized }: { quarter: string; plans: QuarterPlanItem[]; onFinalized: () => void }) {
  const [checked, setChecked] = useState<Record<number, Set<Weekday>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const initial: Record<number, Set<Weekday>> = {}
    plans.forEach((p) => {
      initial[p.id] = new Set(p.choice1_weekdays ?? [])
    })
    setChecked(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarter, plans.map((p) => p.id).join(',')])

  if (plans.length === 0) return null

  const toggle = (planId: number, day: Weekday) => {
    setChecked((prev) => {
      const next = new Set(prev[planId] ?? [])
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return { ...prev, [planId]: next }
    })
  }

  const badgeFor = (p: QuarterPlanItem, day: Weekday): string | null => {
    const isChoice1 = p.choice1_weekdays?.includes(day)
    const isChoice2 = p.choice2_weekdays?.includes(day)
    if (isChoice1 && isChoice2) return '①②'
    if (isChoice1) return '①'
    if (isChoice2) return '②'
    if (checked[p.id]?.has(day)) return '例外'
    return null
  }

  const confirmWeekdays = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/project-quarter-plans/finalize-weekdays', {
        method: 'PUT',
        body: JSON.stringify({
          plans: plans.map((p) => ({ plan_id: p.id, weekdays_finalized: [...(checked[p.id] ?? [])] })),
        }),
      })
      await onFinalized()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '確定に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">
        出社曜日の調整表（対象四半期: {plans[0]?.period_start} 〜 {plans[0]?.period_end}）
      </div>
      <div className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="pb-2 pr-3">プロジェクト</th>
              <th className="pb-2 pr-3">人数</th>
              {WEEKDAYS.map((w) => <th key={w.key} className="pb-2 px-2 text-center">{w.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className="border-b border-slate-100">
                <td className="py-2 pr-3 font-semibold">
                  {p.project_name}
                  {p.note && <div className="text-xs font-normal text-slate-400">備考: {p.note}</div>}
                </td>
                <td className="py-2 pr-3">{p.required_seats}名</td>
                {WEEKDAYS.map((w) => {
                  const badge = badgeFor(p, w.key)
                  const isChecked = checked[p.id]?.has(w.key) ?? false
                  return (
                    <td key={w.key} className="px-2 py-2 text-center">
                      <label className="inline-flex flex-col items-center gap-0.5">
                        <input type="checkbox" checked={isChecked} onChange={() => toggle(p.id, w.key)} />
                        {badge && (
                          <span className={`rounded px-1 text-[10px] ${badge === '例外' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                            {badge}
                          </span>
                        )}
                      </label>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="mx-4 mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="border-t border-slate-200 p-4 text-right">
        <button type="button" disabled={submitting} onClick={confirmWeekdays} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
          この内容で全プロジェクトの曜日を確定する
        </button>
      </div>
    </div>
  )
}
