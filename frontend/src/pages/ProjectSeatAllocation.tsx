import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useQuarterPlans } from '../hooks/useQuarterPlans'
import { useFixedSeatAssignments } from '../hooks/useFixedSeatAssignments'
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

// メンバー全員が固定座席を保有する、またはずっと在宅勤務でプロジェクト座席が不要（FR-03-10）な
// プロジェクトはrequired_seats=0となり、プロジェクト座席自体が不要（2026-08-28追加。「固定席の人のみの
// プロジェクトはプロジェクト席を用意する必要がない」との要望を受けた。2026-09-01訂正、在宅のため不要な
// メンバーも同じ扱いに揃えた）。status='seats_confirmed'のまま操作不要である旨を専用の表示に切り替える。
// non_fixed_member_countは都度算出する現在の値のため、required_seats（計画起票時点のスナップショット、
// 2.9節T-07参照）が古いまま残っている計画でも正しく判定できる（2026-08-31追加）。status='seats_confirmed'
// より後（survey_open・weekdays_finalized）は、アンケート回答で必要座席数を0に変更した場合もあるため
// （2026-09-02、必要座席数の変更希望欄が0以上を許容するようになったことに伴う）、この段階ではPMが
// 明示的に確定させたrequired_seatsを直接見て判定する（非固定席・非在宅のメンバーがまだいても、PMが
// 意図的に0にした場合はそれに従う）。「0名なので座席の島を割り振る必要がない」との報告を受けた、
// weekdays_finalizedで座席の島の割当を求めてしまう不具合の修正。
const noSeatNeeded = (p: QuarterPlanItem) => {
  if (p.status === 'seats_allocated') return false
  if (p.status === 'seats_confirmed') return p.non_fixed_member_count === 0
  return p.required_seats === 0
}
const statusLabel = (p: QuarterPlanItem) => {
  if (!noSeatNeeded(p)) return STATUS_LABEL[p.status](p)
  return p.status === 'seats_confirmed' ? '座席不要（全員固定座席／在宅）' : '座席不要（必要座席数0）'
}
const statusBadgeClass = (p: QuarterPlanItem) => {
  if (noSeatNeeded(p)) return 'bg-slate-100 text-slate-400'
  if (p.status === 'survey_open' && p.has_response) return 'bg-emerald-50 text-emerald-700'
  return STATUS_BADGE_CLASS[p.status]
}

// S-09 プロジェクト座席（エリア担当）。座席の島の割当（A-44）はS-02のフロアマップへ
// 「座席の島の割当モード」で遷移して行う（4.7節）。2026-09-03、「四半期」という概念自体を撤廃し、
// エリア責任者・管理部がプロジェクトごとに都度期間を設定する方式に変更した（検討資料「プロジェクト
// 座席・曜日調整フロー改善案」変更D。「四半期というが概念を撤廃して都度期間を設定するようにしましょう。
// プロジェクト席を決めるときはまず期間を設定した後、アンケートが自動で送られるようにしましょう」との
// 要望を受けた）。従来の四半期ごとの自動起票・対象四半期タブは廃止し、全期間を1本のリストで表示する。
export default function ProjectSeatAllocation() {
  const navigate = useNavigate()
  const { items: plans, unplannedProjects, refresh: refreshAll } = useQuarterPlans()

  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [headcountTarget, setHeadcountTarget] = useState<QuarterPlanItem | null>(null)
  const [headcountValue, setHeadcountValue] = useState(1)
  const [periodTarget, setPeriodTarget] = useState<QuarterPlanItem | null>(null)
  const [periodStartValue, setPeriodStartValue] = useState('')
  const [periodEndValue, setPeriodEndValue] = useState('')
  const [bulkPeriodModalOpen, setBulkPeriodModalOpen] = useState(false)
  const [bulkPeriodSelected, setBulkPeriodSelected] = useState<Set<number>>(new Set())
  const [bulkPeriodStartValue, setBulkPeriodStartValue] = useState('')
  const [bulkPeriodEndValue, setBulkPeriodEndValue] = useState('')
  const [bulkPeriodSubmitting, setBulkPeriodSubmitting] = useState(false)
  const [bulkPeriodError, setBulkPeriodError] = useState<string | null>(null)

  // 期間未設定のプロジェクトへの新規期間設定（A-68、2026-09-03新設。変更D再訂正）。「変更Aの期間は
  // 全プロジェクトに完全に自由〔任意の開始日・終了日〕、全プロジェクトが同じ期間を共有するように
  // したい」との要望を受け、プロジェクトを個別に選ぶ単発作成（A-67）ではなく、期間未設定の
  // プロジェクトをまとめて選び同じ期間を一括で新規設定する方式を主経路にした。既存の「期間を修正」
  // （A-65）は既にある計画データの期間を書き換えるのに対し、こちらは計画データ自体が存在しない
  // プロジェクトに対して新規作成する。設定すると即座にstatus='survey_open'で作成される（変更Bの方針）。
  const [bulkCreateModalOpen, setBulkCreateModalOpen] = useState(false)
  const [bulkCreateSelected, setBulkCreateSelected] = useState<Set<number>>(new Set())
  const [bulkCreateStartValue, setBulkCreateStartValue] = useState('')
  const [bulkCreateEndValue, setBulkCreateEndValue] = useState('')
  const [bulkCreateSubmitting, setBulkCreateSubmitting] = useState(false)
  const [bulkCreateError, setBulkCreateError] = useState<string | null>(null)

  const openBulkCreate = () => {
    setBulkCreateError(null)
    // 「全プロジェクトが同じ期間を共有する」ことを主経路にするため、期間未設定の全プロジェクトを
    // 既定で選択済みにしておく（外したい場合だけ個別にチェックを外す）
    setBulkCreateSelected(new Set(unplannedProjects.map((p) => p.id)))
    setBulkCreateStartValue('')
    setBulkCreateEndValue('')
    setBulkCreateModalOpen(true)
  }
  const toggleBulkCreateSelect = (projectId: number) => {
    setBulkCreateSelected((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }
  const submitBulkCreate = async () => {
    setBulkCreateSubmitting(true)
    setBulkCreateError(null)
    try {
      await apiFetch('/api/project-quarter-plans/bulk-create', {
        method: 'POST',
        body: JSON.stringify({
          project_ids: [...bulkCreateSelected],
          period_start: bulkCreateStartValue,
          period_end: bulkCreateEndValue,
        }),
      })
      setBulkCreateModalOpen(false)
      await refreshAll()
    } catch (e) {
      setBulkCreateError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setBulkCreateSubmitting(false)
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

  // 座席期間（開始日・終了日）の上書き（A-65、2026-09-03追加。「座席期間をエリア責任者が指定できる
  // ようにしたい」との要望を受けた。検討資料「プロジェクト座席・曜日調整フロー改善案」変更A）。
  // status='seats_confirmed'（アンケート未送信）の間のみ、バックエンド側でも制限している。
  const openPeriod = (p: QuarterPlanItem) => {
    setActionError(null)
    setPeriodStartValue(p.period_start)
    setPeriodEndValue(p.period_end)
    setPeriodTarget(p)
  }
  const submitPeriod = async () => {
    if (!periodTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${periodTarget.id}/period`, {
        method: 'PUT',
        body: JSON.stringify({ period_start: periodStartValue, period_end: periodEndValue }),
      })
      setPeriodTarget(null)
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  // 座席期間の一括設定（A-66、2026-09-03追加。「一括でプロジェクトの期間を決めれるようにしたい」との
  // 要望を受けた。先にボタンを押してから開いたモーダルで対象プロジェクトを選ぶ順序にする。対象は
  // 個別の「期間を修正」ボタンと同じ、座席の島の割当前（status IN ('seats_confirmed','survey_open')）
  // のプロジェクトのみ。選択した全プロジェクトへ同じ開始日・終了日をまとめて上書きする。
  // 2026-09-03、検討資料「プロジェクト座席・曜日調整フロー改善案」変更B: 四半期の自動起票時点で
  // status='survey_open'を直接設定するようになった（座席期間が決まった時点でPJ席決担当が即座に
  // アンケートに回答できる状態にしたいとの要望）ため、実質的にほぼ全てのプロジェクトがsurvey_open
  // として作成される。これに伴い、従来手動で行っていたアンケート送信（A-41「アンケートを送る」・
  // A-63一括送信）は廃止した。Slack通知もシステムからの自動送信をやめ、エリア責任者が自分でSlackに
  // 連絡する運用に変更した（システム側にSlack送信ボタンは残さない）。
  const periodEligiblePlans = useMemo(
    () => plans.filter((p) => p.status === 'seats_confirmed' || p.status === 'survey_open'),
    [plans]
  )
  const openBulkPeriod = () => {
    setBulkPeriodError(null)
    setBulkPeriodSelected(new Set())
    setBulkPeriodStartValue('')
    setBulkPeriodEndValue('')
    setBulkPeriodModalOpen(true)
  }
  const toggleBulkPeriodSelect = (planId: number) => {
    setBulkPeriodSelected((prev) => {
      const next = new Set(prev)
      if (next.has(planId)) next.delete(planId)
      else next.add(planId)
      return next
    })
  }
  const submitBulkPeriod = async () => {
    setBulkPeriodSubmitting(true)
    setBulkPeriodError(null)
    try {
      await apiFetch('/api/project-quarter-plans/period-bulk', {
        method: 'PUT',
        body: JSON.stringify({
          plan_ids: [...bulkPeriodSelected],
          period_start: bulkPeriodStartValue,
          period_end: bulkPeriodEndValue,
        }),
      })
      setBulkPeriodModalOpen(false)
      await refreshAll()
    } catch (e) {
      setBulkPeriodError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setBulkPeriodSubmitting(false)
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
    navigate('/', {
      state: {
        seatBlockFor: {
          planId: p.id, projectName: p.project_name, requiredSeats: p.required_seats,
          allocatedSeatIds: p.allocated_seat_ids ?? undefined, periodStart: p.period_start,
          weekdaysFinalized: p.weekdays_finalized,
        },
      },
    })
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

        {unplannedProjects.length > 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 p-4">
            <div className="mb-2 text-sm font-semibold text-amber-800">期間未設定のプロジェクト（{unplannedProjects.length}件）</div>
            <p className="mb-3 text-xs text-amber-700">現在・今後にわたる座席期間が1件も設定されていません。全プロジェクトが同じ期間を共有する運用のため、下のボタンからまとめて同じ開始日・終了日を設定してください（設定すると即座に出社曜日アンケートが回答可能になります）。</p>
            <button
              type="button"
              onClick={openBulkCreate}
              className="rounded border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100"
            >
              期間未設定のプロジェクトへ座席期間を一括設定する
            </button>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={openBulkPeriod}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            プロジェクトを選んで座席期間を一括設定する
          </button>
        </div>

        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-4 py-2">プロジェクト</th>
                <th className="px-4 py-2">席決め担当</th>
                <th className="px-4 py-2">対象期間</th>
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
                  <td className="px-4 py-2">{p.seat_assigner_names}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{p.period_start} 〜 {p.period_end}</td>
                  <td className="px-4 py-2 font-semibold">{p.required_seats}名</td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${statusBadgeClass(p)}`}>{statusLabel(p)}</span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      {p.status === 'survey_open' && !noSeatNeeded(p) && (
                        <button type="button" onClick={() => sendReminder(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">リマインドを送る</button>
                      )}
                      {p.status === 'weekdays_finalized' && !noSeatNeeded(p) && (
                        <button type="button" onClick={() => goSeatBlock(p)} className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900">座席の島を割り当てる</button>
                      )}
                      {p.status !== 'seats_allocated' && (
                        <button type="button" onClick={() => openHeadcount(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">人数を修正</button>
                      )}
                      {(p.status === 'seats_confirmed' || p.status === 'survey_open') && (
                        <button type="button" onClick={() => openPeriod(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">期間を修正</button>
                      )}
                      {p.status === 'seats_allocated' && (
                        <button type="button" onClick={() => goSeatBlock(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">座席を編集</button>
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

        <WeekdayMatrix
          plans={plans.filter((p) => p.status === 'survey_open')}
          onFinalized={refreshAll}
        />

        <ConfirmedWeekdaysTable
          plans={plans.filter((p) => p.status === 'weekdays_finalized' || p.status === 'seats_allocated')}
          onChanged={refreshAll}
        />
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

      {periodTarget && (
        <Modal
          title={`座席期間の修正（${periodTarget.project_name}）`}
          onClose={() => setPeriodTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setPeriodTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitPeriod} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">この内容で保存する</button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-slate-500">座席の島の割当前（曜日確定前）のみ変更できます。任意の開始日・終了日を指定できます。</p>
            <label className="block">
              <span className="mb-1 block text-slate-500">開始日</span>
              <input
                type="date"
                value={periodStartValue}
                onChange={(e) => setPeriodStartValue(e.target.value)}
                className="h-9 w-full rounded border border-slate-300 px-3"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-slate-500">終了日</span>
              <input
                type="date"
                value={periodEndValue}
                onChange={(e) => setPeriodEndValue(e.target.value)}
                className="h-9 w-full rounded border border-slate-300 px-3"
              />
            </label>
            {actionError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{actionError}</p>}
          </div>
        </Modal>
      )}

      {bulkCreateModalOpen && (
        <Modal
          title="期間未設定のプロジェクトへ座席期間を一括設定する"
          onClose={() => setBulkCreateModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setBulkCreateModalOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={bulkCreateSubmitting || bulkCreateSelected.size === 0 || !bulkCreateStartValue || !bulkCreateEndValue}
                onClick={submitBulkCreate}
                className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                この内容で設定する
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-slate-500">同じ開始日・終了日を設定するプロジェクトを選択してください（既定で全て選択済みです）。設定すると即座に出社曜日アンケートが回答可能になります。必要座席数はプロジェクトごとの現状の人数（固定座席保有者・在宅のため不要なメンバーを除く）から自動算出されます。</p>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">開始日</span>
                <input
                  type="date"
                  value={bulkCreateStartValue}
                  onChange={(e) => setBulkCreateStartValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-300 px-3"
                />
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">終了日</span>
                <input
                  type="date"
                  value={bulkCreateEndValue}
                  onChange={(e) => setBulkCreateEndValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-300 px-3"
                />
              </label>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {unplannedProjects.map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                  <input type="checkbox" checked={bulkCreateSelected.has(p.id)} onChange={() => toggleBulkCreateSelect(p.id)} />
                  <span>{p.name}</span>
                </label>
              ))}
              {unplannedProjects.length === 0 && (
                <p className="px-2 py-1.5 text-slate-400">対象のプロジェクトがありません</p>
              )}
            </div>
            {bulkCreateError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{bulkCreateError}</p>}
          </div>
        </Modal>
      )}

      {bulkPeriodModalOpen && (
        <Modal
          title="座席期間の一括設定"
          onClose={() => setBulkPeriodModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setBulkPeriodModalOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={bulkPeriodSubmitting || bulkPeriodSelected.size === 0 || !bulkPeriodStartValue || !bulkPeriodEndValue}
                onClick={submitBulkPeriod}
                className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                この内容で設定する
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-slate-500">同じ開始日・終了日を設定するプロジェクトを選択してください。座席の島の割当前（曜日確定前）のプロジェクトのみ対象です。</p>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">開始日</span>
                <input
                  type="date"
                  value={bulkPeriodStartValue}
                  onChange={(e) => setBulkPeriodStartValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-300 px-3"
                />
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">終了日</span>
                <input
                  type="date"
                  value={bulkPeriodEndValue}
                  onChange={(e) => setBulkPeriodEndValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-300 px-3"
                />
              </label>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {periodEligiblePlans.map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                  <input type="checkbox" checked={bulkPeriodSelected.has(p.id)} onChange={() => toggleBulkPeriodSelect(p.id)} />
                  <span>{p.project_name}</span>
                  <span className="text-xs text-slate-400">（現在: {p.period_start} 〜 {p.period_end}）</span>
                </label>
              ))}
              {periodEligiblePlans.length === 0 && (
                <p className="px-2 py-1.5 text-slate-400">対象のプロジェクトがありません</p>
              )}
            </div>
            {bulkPeriodError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{bulkPeriodError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}

// 第一希望・第二希望・例外のどれに該当するかでバッジ表示する（WeekdayMatrixの編集中バッジと
// 同じ考え方）。confirmedはDB上の確定値（読み取り専用行）・編集中のチェック状態（編集可能行）の
// どちらも受け取れるよう、呼び出し側でSetを作って渡す
function weekdayBadge(p: QuarterPlanItem, day: Weekday, confirmed: Set<Weekday>): string | null {
  const isChoice1 = p.choice1_weekdays?.includes(day)
  const isChoice2 = p.choice2_weekdays?.includes(day)
  if (isChoice1 && isChoice2) return '①②'
  if (isChoice1) return '①'
  if (isChoice2) return '②'
  if (confirmed.has(day)) return '例外'
  return null
}

// 確定した出社曜日の一覧表。曜日確定済み・座席割当済みのプロジェクトを対象に、出社曜日の調整表
// （WeekdayMatrix）と同じ「曜日×プロジェクト」のグリッド形式で常時表示する（2026-08-31再々訂正。
// 「それぞれのプロジェクトからボタンを押すのが面倒」との指摘を受けて一覧内の1列に圧縮表示していたが、
// 「表にしてほしい（曜日調整表の部分）」との指摘を受け、調整表と同じ表形式に作り直した）。
// 曜日確定済み（座席の島の割当前、status='weekdays_finalized'）の行はチェックボックスで直接編集でき、
// 下部の「この内容で変更する」で一括保存する（2026-09-02追加。「確定した出社曜日をミスして確定押して
// しまったときの変更ボタンが欲しい」との要望を受け、当初は一覧から個別に「確定を取り消す」→
// アンケート回答受付中に戻して調整表で再確定する方式、続けて対象プロジェクトのみのモーダルで直接
// 変更する方式を試みたが、「表から丸ごと取り消しではなく変更にしてほしい」「この表から一括で変更する
// ようにしたい。チェックしていたものはそのまま残してある状態で」との指摘を受け、この表自体を
// チェック状態が確定内容で初期化済みの編集可能なグリッドにする方式に落ち着いた）。座席の島の割当後
// （status='seats_allocated'）の行は、座席の島の割当時に前提となった出社曜日を後から変えられると
// 座席数の整合が崩れるため、従来どおりチェックボックスを持たない参照専用表示のままとする。
// 確定の取り消し（A-62）は、行ごとに即時実行する「取り消す」ボタン → 先頭列のチェックボックスで
// 選んでから一括実行、と試したが、「プロジェクトの確定を取り消すを押した後、どのプロジェクトにするか
// 選択するようにしてほしい」との要望を受け、まず「プロジェクトの確定を取り消す」ボタンを押し、
// 開いたモーダルで対象プロジェクトを選んでから実行する順序に変更した（2026-09-02）。
function ConfirmedWeekdaysTable({ plans, onChanged }: { plans: QuarterPlanItem[]; onChanged: () => void }) {
  const editablePlans = useMemo(() => plans.filter((p) => p.status === 'weekdays_finalized'), [plans])
  const editableIds = editablePlans.map((p) => p.id).join(',')
  const [checked, setChecked] = useState<Record<number, Set<Weekday>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  const [cancelSelected, setCancelSelected] = useState<Set<number>>(new Set())
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  useEffect(() => {
    const initial: Record<number, Set<Weekday>> = {}
    editablePlans.forEach((p) => {
      initial[p.id] = new Set(p.weekdays_finalized ?? [])
    })
    setChecked(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableIds])

  if (plans.length === 0) return null

  const toggle = (planId: number, day: Weekday) => {
    setChecked((prev) => {
      const next = new Set(prev[planId] ?? [])
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return { ...prev, [planId]: next }
    })
  }

  const submitChanges = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/project-quarter-plans/finalize-weekdays', {
        method: 'PUT',
        body: JSON.stringify({
          plans: editablePlans.map((p) => ({ plan_id: p.id, weekdays_finalized: [...(checked[p.id] ?? [])] })),
        }),
      })
      await onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '変更に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const openCancelModal = () => {
    setCancelError(null)
    setCancelSelected(new Set())
    setCancelModalOpen(true)
  }
  const toggleCancelSelect = (planId: number) => {
    setCancelSelected((prev) => {
      const next = new Set(prev)
      if (next.has(planId)) next.delete(planId)
      else next.add(planId)
      return next
    })
  }
  const submitCancel = async () => {
    setCanceling(true)
    setCancelError(null)
    try {
      await Promise.all(
        [...cancelSelected].map((planId) =>
          apiFetch(`/api/project-quarter-plans/${planId}/unfinalize-weekdays`, { method: 'PUT' })
        )
      )
      setCancelModalOpen(false)
      await onChanged()
    } catch (e) {
      setCancelError(e instanceof ApiError ? e.message : '取り消しに失敗しました')
    } finally {
      setCanceling(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">
        確定した出社曜日
      </div>
      <div className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="pb-2 pr-3">プロジェクト</th>
              {WEEKDAYS.map((w) => <th key={w.key} className="pb-2 px-2 text-center">{w.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const editable = p.status === 'weekdays_finalized'
              const confirmed = editable ? (checked[p.id] ?? new Set<Weekday>()) : new Set(p.weekdays_finalized ?? [])
              return (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-semibold">
                    {p.project_name}
                    <div className="text-xs font-normal text-slate-400">{p.period_start} 〜 {p.period_end}</div>
                    {p.note && <div className="text-xs font-normal text-slate-400">備考: {p.note}</div>}
                    {!editable && <div className="text-[10px] font-normal text-slate-400">座席割当済み（参照のみ）</div>}
                  </td>
                  {WEEKDAYS.map((w) => {
                    const badge = weekdayBadge(p, w.key, confirmed)
                    if (editable) {
                      const isChecked = confirmed.has(w.key)
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
                    }
                    const isConfirmed = confirmed.has(w.key)
                    return (
                      <td key={w.key} className="px-2 py-2 text-center">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className={isConfirmed ? 'text-blue-800' : 'text-slate-300'}>{isConfirmed ? '✓' : '−'}</span>
                          {badge && (
                            <span className={`rounded px-1 text-[10px] ${badge === '例外' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                              {badge}
                            </span>
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="mx-4 mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {editablePlans.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-4">
          <button
            type="button"
            onClick={openCancelModal}
            className="rounded bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-700"
          >
            プロジェクトの確定を取り消す
          </button>
          <button type="button" disabled={submitting} onClick={submitChanges} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            この内容で変更する
          </button>
        </div>
      )}

      {cancelModalOpen && (
        <Modal
          title="出社曜日の確定を取り消す"
          onClose={() => setCancelModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setCancelModalOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={canceling || cancelSelected.size === 0}
                onClick={submitCancel}
                className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                取り消す
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-slate-500">取り消すプロジェクトを選択してください。アンケート回答受付中の状態に戻り、出社曜日の調整表で再度確定できます。</p>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {editablePlans.map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                  <input type="checkbox" checked={cancelSelected.has(p.id)} onChange={() => toggleCancelSelect(p.id)} />
                  <span>{p.project_name}</span>
                </label>
              ))}
            </div>
            {cancelError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{cancelError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}

function WeekdayMatrix({ plans, onFinalized }: { plans: QuarterPlanItem[]; onFinalized: () => void }) {
  const [checked, setChecked] = useState<Record<number, Set<Weekday>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { items: fixedAssignments } = useFixedSeatAssignments()

  useEffect(() => {
    const initial: Record<number, Set<Weekday>> = {}
    plans.forEach((p) => {
      // 「確定した出社曜日」表からの取り消し（A-62）で戻ってきた場合は、直前に確定していた内容を
      // 初期値にする（毎回choice1_weekdaysへ戻すと、確定時に追加した「例外」日が消えてしまうため）
      initial[p.id] = new Set(p.weekdays_finalized ?? p.choice1_weekdays ?? [])
    })
    setChecked(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans.map((p) => p.id).join(',')])

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

  // 曜日調整表のNORTH／EAST・WEST分け（2026-09-03追加。「曜日表をNORTHエリア/EAST＆WESTに分けることは
  // できるか。EAST＆WESTは一緒にしてほしい」との要望を受けた）。曜日調整の段階（座席の島の割当前）では
  // プロジェクトごとのエリア情報がT-07に存在しないため、直近に座席の島を割り当てた四半期で実際に使った
  // エリア（A-38のprevious_area、backend/routers/project_seats.pyのlist_quarter_plans参照）で代用する、
  // との回答による。一度も割り当てたことがないプロジェクト（previous_area=null）は別グループにまとめる。
  const AREA_GROUPS: {
    key: string; label: string
    matchPlan: (p: QuarterPlanItem) => boolean
    matchFixed: (a: (typeof fixedAssignments)[number]) => boolean
  }[] = [
    { key: 'NORTH', label: 'NORTHエリア', matchPlan: (p) => p.previous_area === 'NORTH', matchFixed: (a) => a.area === 'NORTH' },
    { key: 'EAST_WEST', label: 'EAST・WESTエリア', matchPlan: (p) => p.previous_area === 'EAST' || p.previous_area === 'WEST', matchFixed: (a) => a.area === 'EAST' || a.area === 'WEST' },
    { key: 'UNKNOWN', label: '前回の割当エリアなし（座席の島の割当が未経験）', matchPlan: (p) => p.previous_area === null, matchFixed: () => false },
  ]
  const groups = AREA_GROUPS.map((g) => ({
    ...g,
    plans: plans.filter(g.matchPlan),
    fixedSeatCount: fixedAssignments.filter(g.matchFixed).length,
  })).filter((g) => g.plans.length > 0)

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
        出社曜日の調整表
      </div>
      <div className="space-y-6 p-4">
        {groups.map((g) => {
          const totalRequired = g.plans.reduce((sum, p) => sum + p.required_seats, 0) + g.fixedSeatCount
          const dayTotal = (day: Weekday) =>
            g.plans.reduce((sum, p) => sum + (checked[p.id]?.has(day) ? p.required_seats : 0), 0) + g.fixedSeatCount
          return (
            <div key={g.key} className="overflow-x-auto">
              <div className="mb-2 text-sm font-semibold text-slate-600">{g.label}</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="pb-2 pr-3">プロジェクト</th>
                    <th className="pb-2 pr-3">人数</th>
                    {WEEKDAYS.map((w) => <th key={w.key} className="pb-2 px-2 text-center">{w.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {g.plans.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-semibold">
                        {p.project_name}
                        <div className="text-xs font-normal text-slate-400">{p.period_start} 〜 {p.period_end}</div>
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
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    <td className="py-2 pr-3">曜日ごとの合計<span className="ml-1 text-xs font-normal text-slate-400">（固定座席{g.fixedSeatCount}名を含む）</span></td>
                    <td className="py-2 pr-3">{totalRequired}名</td>
                    {WEEKDAYS.map((w) => {
                      const total = dayTotal(w.key)
                      const filled = totalRequired > 0 && total === totalRequired
                      return (
                        <td key={w.key} className={`px-2 py-2 text-center ${filled ? 'rounded bg-green-50 text-green-700' : ''}`}>
                          {total}{filled && <span className="ml-1">✓</span>}
                        </td>
                      )
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        })}
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
