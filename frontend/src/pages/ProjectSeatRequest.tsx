import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { useMyProjects } from '../hooks/useMyProjects'
import { useProjectPlanDetail } from '../hooks/useProjectPlanDetail'
import { useProjects } from '../hooks/useProjects'
import ProjectEditModal, { ProjectDeleteConfirmModal, type ProjectForm } from '../components/ProjectEditModal'
import type {
  MyProjectItem, PreviousPlanDetail, ProjectListItem, ProjectPlanDetail, ProjectPlanMember,
  QuarterPlanStatus, RetrySeatAssignmentResult, SeatAssignmentResult, Weekday,
} from '../types'

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

function formatWeekdays(days: Weekday[]): string {
  return WEEKDAYS.filter((w) => days.includes(w.key)).map((w) => w.label).join('・')
}

// YYYY-MM-DDの文字列比較で「今日」を表す（period_end等のAPIレスポンスと同じ形式のため辞書順比較で足りる）
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 2026-09-11修正: 「2026年12月から14月というありもしない月が存在している」との報告を受けた。
// 2026-09-03に「四半期」の概念自体（常に3か月・カレンダー上の四半期区切りに揃う前提）を廃止し、
// プロジェクトごとに任意の座席期間を持てるようになって以降も、このタブ見出しだけは
// 「開始月＋2か月＝終了月」という固定3か月の前提のまま、かつ年またぎの繰り上げも考慮せずに
// 計算していたため、12月開始のように年をまたぐ期間で「12〜14月」という存在しない月が
// 表示されていた。実際の終了月（periodEnd）をそのまま使うよう修正した。
function formatPeriodLabel(periodStart: string, periodEnd: string): string {
  const [sy, sm] = periodStart.split('-').map(Number)
  const [ey, em] = periodEnd.split('-').map(Number)
  if (sy === ey) return `${sy}年${sm}〜${em}月`
  return `${sy}年${sm}月〜${ey}年${em}月`
}

const STATUS_LABEL: Record<QuarterPlanStatus, string> = {
  seats_confirmed: 'アンケート未送信',
  survey_open: '曜日アンケート回答受付中',
  // 仮の座席割り当て（2026-09-16追加、S-09の「仮の座席割り当てを作成する」で入る状態）。曜日・座席
  // ともに本当に確定するまで自由にやり直せるため、PM/PL側には参照専用の情報として表示するのみ
  seats_tentative: '仮の座席割り当て中',
  weekdays_finalized: '曜日確定済み（座席の島の割当待ち）',
  seats_allocated: '座席割当済み',
}
const STATUS_BADGE_CLASS: Record<QuarterPlanStatus, string> = {
  seats_confirmed: 'bg-slate-100 text-slate-500',
  survey_open: 'bg-amber-50 text-amber-700',
  seats_tentative: 'bg-indigo-50 text-indigo-700',
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
  const { items, error, isLoading, refresh } = useMyProjects()
  // 自分がPJ席決担当のプロジェクトの編集・削除（2026-09-10追加。「S-04でもS-08と同じ編集・削除機能が
  // 欲しい」との要望を受けた）。A-27は非adminの場合は自分がPJ席決担当（proxy_user_id）のプロジェクト
  // のみ返すため、一般ユーザーがこの画面で呼んでも他人のプロジェクトは含まれない（2026-09-14訂正、
  // 従来はcreated_by基準だったが権限モデルの訂正によりproxy_user_id基準に戻った）
  const { items: allProjects, refresh: refreshProjects } = useProjects()
  const { me } = useMe()

  // 新しいプロジェクトを作成する際にメンバーも追加できるようにする（2026-09-10追加。「新しい
  // プロジェクトを作成するときメンバーの追加できるようにしてほしい」との要望を受けた）。従来は
  // プロジェクト名のみのフォームで、作成後に「編集」から改めてメンバーを追加する必要があった。
  // 編集で使っているのと同じProjectEditModal（S-08と共通）をそのまま流用し、作成（A-78、
  // proxy_user_id=作成した本人を設定して作成）に続けてメンバー構成の保存（A-29、proxy_user_id＝
  // 自分バイパスにより自分が作成した直後のプロジェクトへも呼べる）を行う
  const [createForm, setCreateForm] = useState<ProjectForm | null>(null)
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const openCreate = () => {
    if (!me) return
    setCreateError(null)
    setCreateForm({
      id: null, name: '',
      members: [{ user_id: me.id, name: `${me.last_name} ${me.first_name}`, project_title: 'PM' }],
      // proxyUserId（PJ席決担当）は既定で作成した本人にする（2026-09-15修正）。A-78
      // （POST /projects/mine）は作成時点でproxy_user_id=本人を設定するが、従来はここがnullの
      // ままsubmitCreateがA-29（メンバー保存）を呼ぶため、A-29のUPDATE文が直後にNULLへ上書きして
      // しまい、作成した本人がアンケート回答も座席確保もできなくなる不具合があった（PJ席決担当が
      // 実権限を持ち、作成者は表示専用という現在の権限モデルのため影響が大きい）。本人は上記の
      // membersで既定でPMとして追加済みのため、PJ席決担当の条件（PM/PLのメンバーであること）も満たす
      proxyUserId: me.id, createdBy: me.id,
    })
  }
  const submitCreate = async () => {
    if (!createForm) return
    if (!createForm.name.trim()) { setCreateError('プロジェクト名を入力してください'); return }
    setCreateSubmitting(true)
    setCreateError(null)
    try {
      const { id } = await apiFetch<{ id: number }>('/api/projects/mine', {
        method: 'POST', body: JSON.stringify({ name: createForm.name }),
      })
      await apiFetch(`/api/projects/${id}/members`, {
        method: 'PUT',
        body: JSON.stringify({
          name: createForm.name,
          members: createForm.members.map((m) => ({ user_id: m.user_id, project_title: m.project_title })),
          proxy_user_id: createForm.proxyUserId,
          created_by: createForm.createdBy,
        }),
      })
      setCreateForm(null)
      refresh()
      refreshProjects()
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : '作成に失敗しました')
    } finally {
      setCreateSubmitting(false)
    }
  }

  // 対象四半期タブ（S-09と同様の考え方）。自分が所属する全プロジェクトのplansに現れる
  // period_startの和集合をタブとし、初期表示は最も新しいもの（＝次の期間）を自動選択する
  // （2026-08-31追加。「対象四半期を自由に選択できるようにできる？」との要望を受けた。
  // 従来は各プロジェクトの直近1件のみが固定で表示され、他の四半期を見る手段がなかった）。
  const quarterTabs = useMemo(() => {
    const starts = new Set<string>()
    items.forEach((it) => it.plans.forEach((p) => starts.add(p.period_start)))
    return [...starts].sort()
  }, [items])
  // タブ見出し（formatPeriodLabel）に実際の終了月を使うため、period_start→period_endを引けるようにする
  const periodEndByStart = useMemo(() => {
    const map = new Map<string, string>()
    items.forEach((it) => it.plans.forEach((p) => {
      if (!map.has(p.period_start)) map.set(p.period_start, p.period_end)
    }))
    return map
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
        <button
          type="button"
          disabled={!me}
          onClick={openCreate}
          className="ml-auto rounded bg-blue-800 px-3 py-1.5 text-sm text-white hover:bg-blue-900 disabled:opacity-50"
        >
          ＋ 新しいプロジェクトを作成
        </button>
      </header>

      {createForm && (
        <ProjectEditModal
          form={createForm}
          setForm={setCreateForm}
          onClose={() => setCreateForm(null)}
          onSubmit={submitCreate}
          submitting={createSubmitting}
          error={createError}
          addTitle="新しいプロジェクトを作成"
        />
      )}

      <div className="p-6">
        {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">読み込みに失敗しました</p>}
        {!isLoading && items.length === 0 && (
          <p className="text-sm text-slate-400">所属しているプロジェクトはありません。</p>
        )}

        {quarterTabs.length > 0 && (
          <div className="scrollbar-hide mb-6 flex gap-1 overflow-x-auto border-b border-slate-200">
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
                {formatPeriodLabel(q, periodEndByStart.get(q) ?? q)}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-8">
          {items.map((mp, i) => (
            <Fragment key={mp.project_id}>
              {/* プロジェクトが多いと、どこまでが1件分か分かりにくいため区切り線を入れる
                  （2026-09-10追加。「その他の画面にも区切るポイントがあったら線を作成してほしい」との要望を受けた） */}
              {i > 0 && <hr className="border-slate-200" />}
              <ProjectSection
                item={mp}
                selectedQuarter={selectedQuarter}
                projectDetail={allProjects.find((p) => p.id === mp.project_id)}
                onProjectsChanged={() => { refresh(); refreshProjects() }}
              />
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

function ProjectSection({ item, selectedQuarter, projectDetail, onProjectsChanged }: {
  item: MyProjectItem
  selectedQuarter: string
  projectDetail: ProjectListItem | undefined
  onProjectsChanged: () => void
}) {
  const roleLabel = item.project_title ?? '一般メンバー'
  const plan = item.plans.find((p) => p.period_start === selectedQuarter) ?? null

  // 自分が作成したプロジェクトの編集・削除（2026-09-10追加。「S-04でもS-08と同じ編集・削除機能が
  // 欲しい。編集機能の内容はS-08にある編集機能とまんま同じものでいい」との要望を受けた）。
  // S-08のProjectsTabと全く同じProjectEditModal/ProjectDeleteConfirmModalを共有コンポーネントとして
  // 使い、対象をprojectDetail（A-27、自分が作成したプロジェクトのみ返る）から初期化する
  const [form, setForm] = useState<ProjectForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const openEdit = () => {
    if (!projectDetail) return
    setFormError(null)
    setForm({
      id: projectDetail.id, name: projectDetail.name,
      members: projectDetail.members.map((m) => ({ user_id: m.user_id, name: m.name, project_title: m.project_title })),
      proxyUserId: projectDetail.proxy_user_id,
      createdBy: projectDetail.created_by,
    })
  }
  const submitForm = async () => {
    if (!form || form.id === null) return
    if (!form.name.trim()) { setFormError('プロジェクト名を入力してください'); return }
    setSubmitting(true)
    setFormError(null)
    try {
      await apiFetch(`/api/projects/${form.id}/members`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          members: form.members.map((m) => ({ user_id: m.user_id, project_title: m.project_title })),
          proxy_user_id: form.proxyUserId,
          created_by: form.createdBy,
        }),
      })
      setForm(null)
      onProjectsChanged()
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }
  const confirmDelete = async () => {
    if (!projectDetail) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiFetch(`/api/projects/${projectDetail.id}`, { method: 'DELETE' })
      setShowDelete(false)
      onProjectsChanged()
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : '削除に失敗しました')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-bold">
        {item.project_name}
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">{roleLabel}</span>
        {item.is_seat_assigner && (
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              disabled={!projectDetail}
              onClick={openEdit}
              className="rounded border border-slate-300 px-3 py-1 text-xs font-normal text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              編集
            </button>
            <button
              type="button"
              disabled={!projectDetail}
              onClick={() => { setDeleteError(null); setShowDelete(true) }}
              className="rounded border border-red-200 px-3 py-1 text-xs font-normal text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              削除
            </button>
          </span>
        )}
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

      {form && (
        <ProjectEditModal
          form={form}
          setForm={setForm}
          onClose={() => setForm(null)}
          onSubmit={submitForm}
          submitting={submitting}
          error={formError}
        />
      )}
      {showDelete && projectDetail && (
        <ProjectDeleteConfirmModal
          projectName={projectDetail.name}
          onClose={() => setShowDelete(false)}
          onConfirm={confirmDelete}
          deleting={deleting}
          error={deleteError}
        />
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
                  {(summaryStatus === 'seats_allocated' || summaryStatus === 'seats_tentative') && plan.allocated_seat_label && `（${plan.allocated_seat_label}）`}
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
            <span>前回分（{previous.period_start} 〜 {previous.period_end}）の確定曜日・座席割当</span>
            <button type="button" onClick={() => setShowPrevious(false)} className="text-xs font-normal text-slate-400 hover:text-slate-600">閉じる</button>
          </div>
          <div className="p-4">
            {/* 確定曜日と座席割当が別々の枠に分かれていて見づらいとの指摘を受け、1つの表にまとめた
                （2026-09-15修正。previous.weekdays_finalizedはA-15のレスポンスに元々含まれていたが、
                このパネルでは座席割当〔assignments〕のみ表示しておりこの表には出していなかった） */}
            <p className="mb-3 text-sm">
              <span className="text-slate-500">確定曜日: </span>
              <span className="font-semibold">
                {previous.weekdays_finalized === null
                  // 2026-09-16修正: nullは「未確定のまま次のサイクルへ」、[]は「0曜日で確定済み」
                  // という別の状態なのに同じ文言だったため区別する
                  ? '曜日未確定でした'
                  : previous.weekdays_finalized.length > 0
                    ? formatWeekdays(previous.weekdays_finalized)
                    : '出社なし（0曜日）で確定済みでした'}
              </span>
            </p>
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

      {plan.is_seat_assigner && plan.status === 'survey_open' && (
        <SurveyPanel plan={plan} onSubmitted={refresh} />
      )}

      {plan.is_seat_assigner && (
        <MemberManagement plan={plan} onChanged={refresh} />
      )}

      {/* 対象期間が既に終了した計画では非表示にする（2026-09-15追加、「プロジェクトの人を変更する
          とき過去のプロジェクトにもそれが影響されている」との報告を受けた）。project_membersは
          期間を持たない単一の現在値のため、終了済みの過去の計画に対して表示し続けると、実際に
          その期間に在籍していたメンバーとは異なる「現在のメンバー」一覧が出てしまい紛らわしい。
          バックエンド（A-18・A-72）も同じ期間で書き込みを拒否するようにした */}
      {plan.can_manage_seat_assign && plan.status === 'seats_allocated' && plan.period_end >= todayIso() && (
        <BulkSeatAssign plan={plan} onChanged={refresh} />
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
  const [copying, setCopying] = useState(false)

  // 前回の回答をコピー（2026-09-10追加。「前回のPJ席の人、曜日調整がコピーできるようにしてほしい」
  // との要望を受けた）。A-15（前回サイクルの参照）を呼び、前回の第一・第二希望・備考・必要座席数の
  // 変更希望をこのフォームの入力欄に反映するだけで、送信自体は行わない（内容を見直してから
  // 「この内容で回答する」を押してもらう）。前回が未回答だった場合はその旨を表示するのみ
  const copyPrevious = async () => {
    setCopying(true)
    setError(null)
    try {
      const data = await apiFetch<PreviousPlanDetail>(`/api/project-quarter-plans/${plan.id}/previous`)
      if (!data.response) {
        setError('前回は未回答でした')
        return
      }
      setChoice1(new Set(data.response.choice1_weekdays))
      setChoice2(new Set(data.response.choice2_weekdays))
      setNote(data.response.note ?? '')
      setRequestedSeats(data.response.requested_seats !== null ? String(data.response.requested_seats) : '')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '前回分の取得に失敗しました')
    } finally {
      setCopying(false)
    }
  }

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
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 font-semibold">
        出社曜日アンケートの回答
        {plan.has_previous_plan && (
          <button
            type="button"
            disabled={copying}
            onClick={copyPrevious}
            className="rounded border border-slate-300 px-3 py-1 text-xs font-normal text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {copying ? 'コピー中...' : '前回の回答をコピーする'}
          </button>
        )}
      </div>
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

// 座席の島の割当の除外日振替（BulkSeatAssign専用）。ExcludedDatesRetryと異なり、座席は
// 座席番号のテキスト入力ではなく、島の範囲内の座席idから選ぶ（PM/PLは既にplan.allocated_seatsを
// 持っているため、A-22座席一覧なしで選択肢を作れる、2026-09-07追加）
function SeatIslandExcludedRetry({
  excludedDates, seatOptions, onRetry, onRetried,
}: {
  excludedDates: { date: string; reason: string }[]
  seatOptions: { id: number; seat_no: string }[]
  onRetry: (dates: string[], seatId: number) => Promise<RetrySeatAssignmentResult>
  onRetried: (result: RetrySeatAssignmentResult) => void
}) {
  const [seatId, setSeatId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (excludedDates.length === 0) return null

  const submit = async () => {
    if (!seatId) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await onRetry(excludedDates.map((d) => d.date), seatId)
      onRetried(result)
      setSeatId('')
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
          <li key={i} className="text-xs text-amber-800">{d.date}: {d.reason}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={seatId}
          onChange={(e) => setSeatId(e.target.value ? Number(e.target.value) : '')}
          className="h-7 rounded border border-slate-300 px-2 text-xs"
        >
          <option value="">座席を選択</option>
          {seatOptions.map((s) => (
            <option key={s.id} value={s.id}>{s.seat_no}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={submitting || !seatId}
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

function BulkSeatAssign({ plan, onChanged }: { plan: ProjectPlanDetail; onChanged: () => void }) {
  const navigate = useNavigate()
  const [picks, setPicks] = useState<Record<number, number | ''>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SeatAssignmentResult[] | null>(null)
  const [busyMemberId, setBusyMemberId] = useState<number | null>(null)
  const [copying, setCopying] = useState(false)

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

  // RULE-07廃止（2026-09-09）に伴い、固定座席保有者も確保対象に含める（固定座席との併用可）
  const unassigned = plan.members.filter((m) => m.assigned_seat_id === null && !m.seat_not_required)
  const assignedSeatIds = new Set(plan.members.map((m) => m.assigned_seat_id).filter((v): v is number => v !== null))
  const seatOptions = (plan.allocated_seats ?? []).filter((s) => !assignedSeatIds.has(s.id))

  // 前回の座席をコピー（2026-09-10追加。「前回のPJ席の人がコピーできるようにしてほしい」との
  // 要望を受けた）。A-15（前回サイクルの参照）で前回のメンバー→座席番号の対応を取得し、まだ未確保の
  // メンバーについて、前回と同じ座席番号が今回の座席の島（seatOptions）にも含まれていればpicksへ
  // 反映するだけで、確保自体は行わない（内容を見直してから既存の「この内容で確保する」を押してもらう）。
  // 座席の島は期ごとに異なりうるため、前回と同じ座席番号が今回はない場合はそのメンバーの分は
  // 何もしない（手動で選んでもらう）。既に手動で選択済みのpicksは上書きしない
  const copyPreviousSeats = async () => {
    setCopying(true)
    setError(null)
    try {
      const data = await apiFetch<PreviousPlanDetail>(`/api/project-quarter-plans/${plan.id}/previous`)
      const seatIdByNo = new Map(seatOptions.map((s) => [s.seat_no, s.id]))
      const previousSeatNoByUserId = new Map(
        data.assignments.filter((a) => a.seat_no !== null).map((a) => [a.user_id, a.seat_no as string])
      )
      setPicks((prev) => {
        const next = { ...prev }
        // usedSeatIdsはこの呼び出し内で完結させる（setState updaterはStrict Modeで2回
        // 呼ばれうるため、外側スコープの可変Setを共有すると2回目の呼び出しで既に使用済み
        // 扱いになり結果が空になる不具合になる。既存の手動選択分〔prev〕も重複対象に含める）
        const usedSeatIds = new Set(Object.values(next).filter((v): v is number => v !== ''))
        unassigned.forEach((m) => {
          if (next[m.user_id]) return
          const previousSeatNo = previousSeatNoByUserId.get(m.user_id)
          const seatId = previousSeatNo ? seatIdByNo.get(previousSeatNo) : undefined
          if (seatId !== undefined && !usedSeatIds.has(seatId)) {
            next[m.user_id] = seatId
            usedSeatIds.add(seatId)
          }
        })
        return next
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '前回分の取得に失敗しました')
    } finally {
      setCopying(false)
    }
  }
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
          weekdaysFinalized: plan.weekdays_finalized,
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

  // 座席の島の割当（A-18）の結果で除外となった日だけを、同じ島の範囲内の別の座席に振り替える
  // （2026-09-07追加。「席を取って結果で除外が出てきたとき、除外部分だけ別の席に変更できる機能が
  // 欲しい」との要望を受けた）
  const retrySeatAssignment = async (memberUserId: number, dates: string[], seatId: number) =>
    apiFetch<RetrySeatAssignmentResult>(`/api/project-quarter-plans/${plan.id}/seat-assignments/retry`, {
      method: 'POST',
      body: JSON.stringify({ member_user_id: memberUserId, seat_id: seatId, dates }),
    })
  const applySeatAssignmentRetryResult = (memberUserId: number, retriedDates: string[], result: RetrySeatAssignmentResult) => {
    setResults((prev) => {
      if (!prev) return prev
      const next = prev.map((r) =>
        r.member_user_id === memberUserId
          ? { ...r, excluded_dates: (r.excluded_dates ?? []).filter((d) => !retriedDates.includes(d.date)) }
          : r,
      )
      if (result.created_days > 0) {
        next.push({
          member_user_id: memberUserId, seat_id: result.seat_id, seat_no: result.seat_no,
          status: 'assigned', created_days: result.created_days, excluded_days: result.excluded_days,
          excluded_dates: result.excluded_dates,
        })
      }
      return next
    })
    onChanged()
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 font-semibold">
        メンバーへの座席確保
        {plan.has_previous_plan && unassigned.length > 0 && (
          <button
            type="button"
            disabled={copying}
            onClick={copyPreviousSeats}
            className="rounded border border-slate-300 px-3 py-1 text-xs font-normal text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {copying ? 'コピー中...' : '前回の座席をコピーする'}
          </button>
        )}
      </div>
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
                <td className="py-2 pr-3">
                  {m.name}
                  {m.has_fixed_seat && (
                    <span className="ml-1.5 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">固定座席あり</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-slate-500">
                  {m.seat_not_required ? '在宅のため不要' : m.assigned_seat_no ? `${m.assigned_seat_no} に確保済み` : '未確保'}
                </td>
                <td className="py-2 pr-3">
                  {m.seat_not_required ? (
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
                  <input
                    type="checkbox"
                    checked={m.seat_not_required}
                    disabled={busyMemberId === m.member_id || (m.assigned_seat_id !== null && !m.seat_not_required)}
                    title={m.assigned_seat_id !== null && !m.seat_not_required ? '既に座席を確保済みです。先に予約を取り消してください' : undefined}
                    onChange={(e) => toggleSeatNotRequired(m, e.target.checked)}
                  />
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
                    <Fragment key={i}>
                      <tr className="border-b border-slate-100">
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
                      {r.excluded_dates && r.excluded_dates.length > 0 && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={3} className="py-1">
                            <SeatIslandExcludedRetry
                              excludedDates={r.excluded_dates}
                              seatOptions={seatOptions.filter((s) => s.id !== r.seat_id)}
                              onRetry={(dates, seatId) => retrySeatAssignment(r.member_user_id, dates, seatId)}
                              onRetried={(result) => applySeatAssignmentRetryResult(r.member_user_id, r.excluded_dates!.map((d) => d.date), result)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

