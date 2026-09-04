import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { useMyProjects } from '../hooks/useMyProjects'
import { useProjectPlanDetail } from '../hooks/useProjectPlanDetail'
import type {
  FreeSeatBookingResult, MyProjectItem, PreviousPlanDetail, ProjectPlanDetail, ProjectPlanMember, QuarterPlanStatus,
  SeatAssignmentResult, Weekday,
} from '../types'

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

function formatWeekdays(days: Weekday[]): string {
  return WEEKDAYS.filter((w) => days.includes(w.key)).map((w) => w.label).join('・')
}

function formatQuarterLabel(periodStart: string): string {
  const [y, m] = periodStart.split('-')
  const startMonth = Number(m)
  return `${y}年${startMonth}〜${startMonth + 2}月`
}

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
      <div className="mb-1 text-xs text-slate-500">{label}</div>
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

  // 対象四半期タブ（S-09と同様の考え方）。自分が所属する全プロジェクトのplansに現れる
  // period_startの和集合をタブとし、初期表示は最も新しいもの（＝次の期間）を自動選択する
  // （2026-08-31追加。「対象四半期を自由に選択できるようにできる？」との要望を受けた。
  // 従来は各プロジェクトの直近1件のみが固定で表示され、他の四半期を見る手段がなかった）。
  const quarterTabs = useMemo(() => {
    const starts = new Set<string>()
    items.forEach((it) => it.plans.forEach((p) => starts.add(p.period_start)))
    return [...starts].sort()
  }, [items])

  const [selectedQuarter, setSelectedQuarter] = useState('')
  const [hasAutoSelectedQuarter, setHasAutoSelectedQuarter] = useState(false)
  useEffect(() => {
    if (!hasAutoSelectedQuarter && quarterTabs.length > 0) {
      setSelectedQuarter(quarterTabs[quarterTabs.length - 1])
      setHasAutoSelectedQuarter(true)
    }
  }, [quarterTabs, hasAutoSelectedQuarter])

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">プロジェクト座席</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-04</span>
      </header>

      <div className="p-6">
        {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">読み込みに失敗しました</p>}
        {!isLoading && items.length === 0 && (
          <p className="text-sm text-slate-400">所属しているプロジェクトはありません。</p>
        )}

        {quarterTabs.length > 0 && (
          <div className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200">
            {quarterTabs.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setSelectedQuarter(q)}
                className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                  selectedQuarter === q
                    ? 'border-blue-800 font-semibold text-blue-800'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {formatQuarterLabel(q)}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-8">
          {items.map((mp) => <ProjectSection key={mp.project_id} item={mp} selectedQuarter={selectedQuarter} />)}
        </div>
      </div>
    </div>
  )
}

function ProjectSection({ item, selectedQuarter }: { item: MyProjectItem; selectedQuarter: string }) {
  const roleLabel = item.project_title ?? '一般メンバー'
  const plan = item.plans.find((p) => p.period_start === selectedQuarter) ?? null

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-bold">
        {item.project_name}
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">{roleLabel}</span>
      </h2>
      {item.plans.length === 0 ? (
        <p className="rounded border border-slate-200 bg-white px-4 py-3 text-sm text-slate-400">
          対象四半期の計画はまだ開始されていません。
        </p>
      ) : plan ? (
        <PlanPanel key={plan.id} planId={plan.id} summaryStatus={plan.status} />
      ) : (
        <p className="rounded border border-slate-200 bg-white px-4 py-3 text-sm text-slate-400">
          この四半期の計画はありません。
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
        <SurveyPanel plan={plan} onSubmitted={refresh} />
      )}

      {plan.is_pmpl && (
        <MemberManagement plan={plan} onChanged={refresh} />
      )}

      {plan.can_manage_seat_assign && plan.status === 'seats_allocated' && (
        <BulkSeatAssign plan={plan} onChanged={refresh} />
      )}

      {plan.can_manage_seat_assign && (
        <BulkFreeSeatBooking plan={plan} />
      )}
    </div>
  )
}

type SurveyMode = 'hidden' | 'summary' | 'editing'

// 回答済みの場合は既定で折りたたみ（hidden）、「表示する」で回答内容の要約（summary）を
// 表示・非表示に切り替えられる。要約からは「回答を修正する」で編集フォーム（editing）を開ける
// （2026-08-31追加・同日再訂正。「アンケートに解答したら非表示にするようにしてほしい」→
// 「アンケートに回答したら表示と非表示ができるようにしてほしい」との要望を受けた。当初は
// 「回答を修正する」＝表示のトグルを兼ねていたが、修正〔編集フォーム〕と表示・非表示は別の
// 操作として分離した。曜日確定〔status変化〕までは引き続き回答内容を変更できるため、
// フォーム自体は削除しない）
function SurveyPanel({ plan, onSubmitted }: { plan: ProjectPlanDetail; onSubmitted: () => void }) {
  const [mode, setMode] = useState<SurveyMode>(plan.response === null ? 'editing' : 'hidden')

  if (mode === 'hidden' && plan.response) {
    return (
      <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-4 py-3">
        <span className="flex items-center gap-2 font-semibold">
          出社曜日アンケートの回答
          <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-normal text-green-700">回答済み</span>
        </span>
        <button type="button" onClick={() => setMode('summary')} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
          表示する
        </button>
      </div>
    )
  }

  if (mode === 'summary' && plan.response) {
    return (
      <div className="rounded border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 font-semibold">
          出社曜日アンケートの回答
          <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-normal text-green-700">回答済み</span>
        </div>
        <div className="space-y-1.5 p-4 text-sm">
          <div><span className="text-slate-500">第一希望: </span>{formatWeekdays(plan.response.choice1_weekdays)}</div>
          <div><span className="text-slate-500">第二希望: </span>{formatWeekdays(plan.response.choice2_weekdays)}</div>
          {plan.response.note && <div><span className="text-slate-500">備考: </span>{plan.response.note}</div>}
          {plan.response.requested_seats !== null && (
            <div><span className="text-slate-500">必要座席数の変更希望: </span>{plan.response.requested_seats}名</div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setMode('hidden')} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
              非表示にする
            </button>
            <button type="button" onClick={() => setMode('editing')} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
              回答を修正する
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <SurveyForm
      plan={plan}
      onSubmitted={async () => {
        // 折りたたみ後にすぐ表示する要約がstale値にならないよう、再取得が終わってから閉じる
        await onSubmitted()
        setMode('hidden')
      }}
      onCancel={plan.response ? () => setMode('summary') : undefined}
    />
  )
}

function SurveyForm({ plan, onSubmitted, onCancel }: { plan: ProjectPlanDetail; onSubmitted: () => void; onCancel?: () => void }) {
  const [choice1, setChoice1] = useState<Set<Weekday>>(new Set(plan.response?.choice1_weekdays ?? []))
  const [choice2, setChoice2] = useState<Set<Weekday>>(new Set(plan.response?.choice2_weekdays ?? []))
  const [note, setNote] = useState(plan.response?.note ?? '')
  const [requestedSeats, setRequestedSeats] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
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
            min={0}
            value={requestedSeats}
            onChange={(e) => setRequestedSeats(e.target.value)}
            placeholder="変更後の人数（変更がなければ空欄のまま）"
            className="h-9 w-56 rounded border border-slate-300 px-3 text-sm"
          />
        </label>
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className="rounded border border-slate-300 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              キャンセル
            </button>
          )}
          <button type="button" disabled={submitting} onClick={submit} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            この内容で回答する
          </button>
        </div>
      </div>
    </div>
  )
}

function MemberManagement({ plan, onChanged }: { plan: ProjectPlanDetail; onChanged: () => void }) {
  const { me } = useMe()
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
                  {m.user_id === me?.id ? (
                    <span className="text-xs text-slate-400">－</span>
                  ) : (
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={m.can_assign_seats}
                        disabled={busyId === m.member_id}
                        onChange={(e) => toggle(m.member_id, e.target.checked)}
                      />
                      席決めを任せる
                    </label>
                  )}
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
  const navigate = useNavigate()
  const [picks, setPicks] = useState<Record<number, number | ''>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SeatAssignmentResult[] | null>(null)
  const [busyMemberId, setBusyMemberId] = useState<number | null>(null)

  // 確保済みメンバーの座席変更（2026-09-03追加。「メンバーへの座席確保なのですが変更できるように
  // してほしい」との要望を受けた。従来は一度確保すると「割り当てる座席」欄が「—」になり、この画面
  // からは変更できなかった）。新規確保用のpicksとは別に、行ごとの変更先選択をchangePicksで持つ。
  // 'home'は在宅勤務にする特殊な選択肢（2026-09-03同日追加。「変更先の選択に在宅勤務も追加してほしい」
  // との要望を受けた。従来、確保済みメンバーを在宅勤務に切り替えるには「在宅のため不要」チェックボックスが
  // 確保済みの間は非活性〔先に予約の取消が必要〕で、この画面からは完結できなかった）
  const [changePicks, setChangePicks] = useState<Record<number, number | 'home' | ''>>({})
  const [changingMemberId, setChangingMemberId] = useState<number | null>(null)
  const [changeError, setChangeError] = useState<string | null>(null)
  const [changeMessage, setChangeMessage] = useState<string | null>(null)

  const unassigned = plan.members.filter((m) => m.assigned_seat_id === null && !m.has_fixed_seat && !m.seat_not_required)
  const assignedSeatIds = new Set(plan.members.map((m) => m.assigned_seat_id).filter((v): v is number => v !== null))
  const seatOptions = (plan.allocated_seats ?? []).filter((s) => !assignedSeatIds.has(s.id))
  // 変更先の候補は、必要人数ちょうどで座席の島が埋まっている（空き座席がない）ことが多く、
  // 空き座席だけでは選べる相手がいなかったため、既に他メンバーに割り当て済みの座席も選択肢に含め、
  // 選ぶとその相手と座席を交換する（2026-09-03追加。「変更先を選択を押しても座席が表示されないため
  // 変更することができません」との報告を受けた）
  const memberNameBySeatId = new Map(
    plan.members.filter((mm) => mm.assigned_seat_id !== null).map((mm) => [mm.assigned_seat_id as number, mm.name])
  )

  // ずっと在宅勤務でプロジェクト座席が不要なメンバーの設定（FR-03-10、2026-09-01追加。
  // 「出社する必要がなく席を確保しなくていい人もいるのでそれ用の選択をできるようにしてほしい」
  // との要望を受けた）。固定座席保有者と同様、確保対象・未確保者数から除外する
  const toggleSeatNotRequired = async (m: ProjectPlanMember, next: boolean) => {
    setBusyMemberId(m.member_id)
    setError(null)
    try {
      await apiFetch(`/api/project-members/${m.member_id}/seat-not-required`, {
        method: 'PUT',
        body: JSON.stringify({ seat_not_required: next }),
      })
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '更新に失敗しました')
    } finally {
      setBusyMemberId(null)
    }
  }

  // 座席表（S-02のフロアマップ）から選ぶ導線（2026-08-31追加。「座席表から選択できるように
  // してほしい」との要望を受けた）。プルダウンでの一括確保はそのまま残し、選択肢を追加する形にした
  const goSeatMap = () => {
    navigate('/', {
      state: {
        memberSeatAssignFor: {
          planId: plan.id,
          projectName: plan.project_name,
          periodStart: plan.period_start,
          allocatedSeatIds: (plan.allocated_seats ?? []).map((s) => s.id),
          members: unassigned.map((m) => ({ userId: m.user_id, name: m.name })),
        },
      },
    })
  }

  const changeSeat = async (m: ProjectPlanMember) => {
    const pick = changePicks[m.user_id]
    if (!pick) return
    setChangingMemberId(m.member_id)
    setChangeError(null)
    setChangeMessage(null)
    try {
      const data = await apiFetch<{ seat_no: string | null; excluded_days: number; swapped_with: string | null }>(
        `/api/project-quarter-plans/${plan.id}/seat-assignments/${m.user_id}`,
        { method: 'PUT', body: JSON.stringify({ seat_id: pick === 'home' ? null : pick }) },
      )
      setChangePicks((prev) => {
        const next = { ...prev }
        delete next[m.user_id]
        return next
      })
      if (data.seat_no === null) {
        setChangeMessage(`${m.name}を在宅勤務にし、座席を解放しました`)
      } else {
        const swapNote = data.swapped_with ? `（${data.swapped_with}と交換）` : ''
        const excludedNote = data.excluded_days ? `（${data.excluded_days}日を除外）` : ''
        setChangeMessage(`${m.name}の座席を${data.seat_no}に変更しました${swapNote}${excludedNote}`)
      }
      onChanged()
    } catch (e) {
      setChangeError(e instanceof ApiError ? e.message : '変更に失敗しました')
    } finally {
      setChangingMemberId(null)
    }
  }

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
              <th className="pb-2 pr-3">割り当てる座席</th>
              <th className="pb-2">在宅のため不要</th>
            </tr>
          </thead>
          <tbody>
            {plan.members.map((m) => (
              <tr key={m.member_id} className="border-b border-slate-100">
                <td className="py-2 pr-3">{m.name}</td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  {m.has_fixed_seat ? '固定座席あり' : m.seat_not_required ? '在宅のため不要' : m.assigned_seat_no ? `${m.assigned_seat_no} に確保済み` : '未確保'}
                </td>
                <td className="py-2 pr-3">
                  {m.has_fixed_seat ? (
                    <span className="text-xs text-slate-400">対象外（固定座席保有者）</span>
                  ) : m.seat_not_required ? (
                    <span className="text-xs text-slate-400">対象外（在宅のため不要）</span>
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
                    <div className="flex items-center gap-1">
                      <select
                        value={changePicks[m.user_id] ?? ''}
                        onChange={(e) => setChangePicks((prev) => ({
                          ...prev,
                          [m.user_id]: e.target.value ? (e.target.value === 'home' ? 'home' : Number(e.target.value)) : '',
                        }))}
                        className="h-8 w-36 rounded border border-slate-300 px-2 text-sm"
                      >
                        <option value="">変更先を選択</option>
                        <option value="home">在宅勤務</option>
                        {(plan.allocated_seats ?? []).filter((s) => s.id !== m.assigned_seat_id).map((s) => {
                          const occupant = memberNameBySeatId.get(s.id)
                          return (
                            <option key={s.id} value={s.id}>
                              {s.seat_no}{occupant ? `（${occupant}と交換）` : ''}
                            </option>
                          )
                        })}
                      </select>
                      <button
                        type="button"
                        disabled={!changePicks[m.user_id] || changingMemberId === m.member_id}
                        onClick={() => changeSeat(m)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        確保する
                      </button>
                    </div>
                  )}
                </td>
                <td className="py-2">
                  {m.has_fixed_seat ? (
                    <span className="text-xs text-slate-400">－</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={m.seat_not_required}
                      disabled={busyMemberId === m.member_id || (m.assigned_seat_id !== null && !m.seat_not_required)}
                      title={m.assigned_seat_id !== null && !m.seat_not_required ? '既に座席を確保済みです。先に予約を取り消してください' : undefined}
                      onChange={(e) => toggleSeatNotRequired(m, e.target.checked)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {changeError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{changeError}</p>}
        {changeMessage && <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{changeMessage}</p>}
        <div className="mt-3 flex items-center justify-between">
          <button type="button" disabled={unassigned.length === 0} onClick={goSeatMap} className="rounded border border-slate-300 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            座席表から選ぶ
          </button>
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

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const AREA_OPTIONS: { key: 'all' | 'north' | 'east' | 'west'; label: string }[] = [
  { key: 'all', label: '全体' }, { key: 'north', label: 'NORTH' }, { key: 'east', label: 'EAST' }, { key: 'west', label: 'WEST' },
]

// 代理予約を複数名まとめて、プロジェクト座席（座席の島）とは別に通常のフリー座席として確保する
// （2026-09-04追加。「代理予約は複数人まとめてできるとありがたい。今までは該当箇所にコピーすれば
// よかったので」との要望を受けた。座席の島の割当と異なり、対象四半期・座席の島の状態を問わず
// いつでも使える。空き座席への割当は自動（エリア指定のみ）で、座席は日によって変わり得る）
function BulkFreeSeatBooking({ plan }: { plan: ProjectPlanDetail }) {
  const candidates = plan.members.filter((m) => !m.has_fixed_seat && !m.seat_not_required)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [area, setArea] = useState<'all' | 'north' | 'east' | 'west'>('all')
  const [patternType, setPatternType] = useState<'daily' | 'weekly'>('daily')
  const [weekdays, setWeekdays] = useState<Set<Weekday>>(new Set())
  const [startDate, setStartDate] = useState(todayStr())
  const [endDate, setEndDate] = useState(todayStr())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<FreeSeatBookingResult[] | null>(null)

  const toggleMember = (userId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const submit = async () => {
    if (selected.size === 0) {
      setError('対象メンバーを1人以上選択してください')
      return
    }
    if (startDate > endDate) {
      setError('開始日は終了日以前の日付を指定してください')
      return
    }
    if (patternType === 'weekly' && weekdays.size === 0) {
      setError('毎週の場合は曜日を1つ以上選択してください')
      return
    }
    setSubmitting(true)
    setError(null)
    setResults(null)
    try {
      const data = await apiFetch<{ results: FreeSeatBookingResult[] }>(
        `/api/project-quarter-plans/${plan.id}/free-seat-bookings`,
        {
          method: 'POST',
          body: JSON.stringify({
            member_user_ids: [...selected],
            area,
            pattern: { type: patternType, weekdays: patternType === 'weekly' ? [...weekdays] : undefined },
            start_date: startDate,
            end_date: endDate,
          }),
        },
      )
      setResults(data.results)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '確保に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3 font-semibold">フリー座席をまとめて確保（代理予約）</div>
      <div className="p-4">
        <p className="mb-3 text-xs text-slate-500">
          座席の島とは別に、通常のフリー座席を複数メンバーへ日付ごとに自動で割り振って確保します（1人1席）。
        </p>

        <div className="mb-3">
          <div className="mb-1 text-xs text-slate-500">対象メンバー</div>
          <div className="flex flex-wrap gap-3">
            {candidates.map((m) => (
              <label key={m.member_id} className="inline-flex items-center gap-1 text-sm">
                <input type="checkbox" checked={selected.has(m.user_id)} onChange={() => toggleMember(m.user_id)} />
                {m.name}
              </label>
            ))}
            {candidates.length === 0 && <span className="text-sm text-slate-400">対象にできるメンバーがいません</span>}
          </div>
        </div>

        <div className="mb-3">
          <div className="mb-1 text-xs text-slate-500">エリア</div>
          <div className="flex gap-3">
            {AREA_OPTIONS.map((a) => (
              <label key={a.key} className="inline-flex items-center gap-1 text-sm">
                <input type="radio" checked={area === a.key} onChange={() => setArea(a.key)} />
                {a.label}
              </label>
            ))}
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">開始日</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 rounded border border-slate-300 px-3" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">終了日</span>
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className="h-9 rounded border border-slate-300 px-3" />
          </label>
          <div className="flex gap-4">
            <label className="inline-flex items-center gap-1 text-sm">
              <input type="radio" checked={patternType === 'daily'} onChange={() => setPatternType('daily')} />
              毎日
            </label>
            <label className="inline-flex items-center gap-1 text-sm">
              <input type="radio" checked={patternType === 'weekly'} onChange={() => setPatternType('weekly')} />
              毎週（曜日を選択）
            </label>
          </div>
        </div>
        {patternType === 'weekly' && (
          <div className="mb-3">
            <WeekdayCheckboxGroup label="対象の曜日" value={weekdays} onChange={setWeekdays} />
          </div>
        )}

        {error && <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="button"
          disabled={submitting || candidates.length === 0}
          onClick={submit}
          className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50"
        >
          この内容でまとめて確保する
        </button>

        {results && (
          <div className="mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="pb-2 pr-3">氏名</th>
                  <th className="pb-2">結果</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const member = plan.members.find((m) => m.user_id === r.user_id)
                  return (
                    <tr key={r.user_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{member?.name ?? r.user_id}</td>
                      <td className="py-2">
                        {r.status === 'assigned' ? (
                          <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700">
                            {r.created_days}日確保{r.excluded_days ? `（${r.excluded_days}日を除外）` : ''}
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

