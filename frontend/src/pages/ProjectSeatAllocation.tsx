import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useQuarterPlans } from '../hooks/useQuarterPlans'
import { useFixedSeatAssignments } from '../hooks/useFixedSeatAssignments'
import { useProjects } from '../hooks/useProjects'
import Modal from '../components/Modal'
import type { PreviousPlanDetail, QuarterPlanItem, Weekday, WeekdayAiSuggestion } from '../types'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

// 出社曜日の確定・変更を「この内容で変更しますか」の確認画面に表示するための要約文字列
// （2026-09-11追加。「曜日調整の変更がわかりにくい。確認欄に各プロジェクトが何曜日に出社するか
// わかるようにしてほしい」との要望を受けた。それまでは確認なしに直接送信していた）
function formatWeekdays(days: Weekday[]): string {
  return WEEKDAYS.filter((w) => days.includes(w.key)).map((w) => w.label).join('・')
}

function weekdaysSummary(days: Set<Weekday> | undefined): string {
  const selected = WEEKDAYS.filter((w) => days?.has(w.key)).map((w) => w.label)
  return selected.length > 0 ? selected.join('・') : '（出社日なし）'
}

// 座席期間の入力補助（開始月＋か月数→開始日・終了日を自動計算、2026-09-07追加）。
// 「開始月と何か月、という入力で自動計算の方が使いやすそう」との要望を受けた。期間は必ずしも
// 月初〜月末に揃うとは限らない（A-65の備考どおり任意の開始日・終了日を指定できる）ため、既存の
// 開始日・終了日の直接入力は残したまま、これを使うと計算結果をその2つの入力へ反映するだけの
// 補助部品にする。
function monthStartDate(month: string): string {
  return `${month}-01`
}
function monthPlusDurationEndDate(month: string, months: number): string {
  const [y, m] = month.split('-').map(Number)
  const endMonthIndex = m - 1 + (months - 1)
  const endYear = y + Math.floor(endMonthIndex / 12)
  const endMonth = (endMonthIndex % 12) + 1
  const lastDay = new Date(endYear, endMonth, 0).getDate()
  return `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
}
function MonthDurationPicker({ onApply }: { onApply: (start: string, end: string) => void }) {
  const [month, setMonth] = useState('')
  const [months, setMonths] = useState(3)
  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-slate-400 bg-slate-50 px-3 py-2">
      <label className="block">
        <span className="mb-1 block text-xs text-slate-500">開始月</span>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="h-8 rounded border border-slate-500 px-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-slate-500">期間（か月）</span>
        <input
          type="number"
          min={1}
          value={months}
          onChange={(e) => setMonths(Math.max(1, Number(e.target.value) || 1))}
          className="h-8 w-20 rounded border border-slate-500 px-2 text-sm"
        />
      </label>
      <button
        type="button"
        disabled={!month}
        onClick={() => onApply(monthStartDate(month), monthPlusDurationEndDate(month, months))}
        className="h-8 rounded border border-slate-500 px-3 text-xs font-semibold text-slate-600 disabled:opacity-40"
      >
        開始日・終了日に反映
      </button>
    </div>
  )
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
// 2026-09-16修正: 「座席の島を割り当てる」ボタンはnoSeatNeeded（required_seats基準、PMの意図的な
// 上書きを尊重するため）で表示可否を決めていたが、実際に割り当てるAPI（A-44・A-80）は都度の実際の
// 非固定・非在宅メンバー数を再計算して判定するため、required_seatsが古いまま非0で残っている計画では
// 曜日確定・座席選択まで進めた最後の送信で初めて400エラーになっていた（「座席の島の割当が最後で
// 失敗する」との報告を受けた）。required_seatsの上書き自体は尊重しつつ、実際に割り当てても必ず
// 失敗する（対象メンバーが実在しない）ケースだけはボタン自体を出さないようにする
const seatBlockDoomed = (p: QuarterPlanItem) =>
  (p.status === 'weekdays_finalized' || p.status === 'seats_tentative') && !noSeatNeeded(p) && p.non_fixed_member_count === 0

// S-09 プロジェクト座席（エリア担当）。座席の島の割当（A-44）はS-02のフロアマップへ
// 「座席の島の割当モード」で遷移して行う（4.7節）。2026-09-03、「四半期」という概念自体を撤廃し、
// エリア責任者・管理部がプロジェクトごとに都度期間を設定する方式に変更した（検討資料「プロジェクト
// 座席・曜日調整フロー改善案」変更D。「四半期というが概念を撤廃して都度期間を設定するようにしましょう。
// プロジェクト席を決めるときはまず期間を設定した後、アンケートが自動で送られるようにしましょう」との
// 要望を受けた）。従来の四半期ごとの自動起票・対象四半期タブは廃止し、全期間を1本のリストで表示する。
export default function ProjectSeatAllocation() {
  const navigate = useNavigate()
  const { items: plans, unplannedProjects, areaSeatCapacity, refresh: refreshAll } = useQuarterPlans()
  // 座席期間の一括新規設定（A-68）の選択候補を「期間未設定のプロジェクト」だけでなく全プロジェクトに
  // 広げるために全件取得する（2026-09-11修正。「次の期間のプロジェクトを作成するとき、既に期間がある
  // プロジェクトが対象となっていない。これを対象化してほしい」との要望を受けた。従来はunplannedProjects
  //〔今日以降に及ぶ計画データを1件も持たないプロジェクト〕だけを候補にしていたため、現に進行中の
  // 期間があるプロジェクトについて、次のサイクル分の期間を先に設定しておく手段がなかった）
  const { items: allProjects } = useProjects()
  // プロジェクトごとの「今日以降に及ぶ既存の座席期間」（複数あれば開始日が最も早いものを代表として
  // 表示する）。一括設定モーダルで、既に期間があるプロジェクトを選んだときにその旨がわかるようにする
  const currentPeriodByProject = useMemo(() => {
    const map = new Map<number, { start: string; end: string }>()
    const today = todayStr()
    plans
      .filter((p) => p.period_end >= today)
      .forEach((p) => {
        const existing = map.get(p.project_id)
        if (!existing || p.period_start < existing.start) {
          map.set(p.project_id, { start: p.period_start, end: p.period_end })
        }
      })
    return map
  }, [plans])

  // 期間タブ（2026-09-11追加）。「2026-09-01〜2026-11-30」「2026-12-01〜2027-02-28」のように
  // プロジェクトが複数の異なる座席期間にまたがるようになると、座席割り当て一覧・曜日調整表が
  // 期間の異なるプロジェクト混在の1本のリストになり見づらいとの指摘を受けた（「期間を分けたら
  // それぞれ違う画面にしてほしい」）。2026-09-03に廃止した「四半期タブ」（カレンダー上の固定四半期
  // 区切り）とは異なり、実際に存在する座席期間（プロジェクトごとに任意）を動的に集計してタブ化する。
  // 存在する期間が1つ以下の間はタブ自体を表示しない（従来どおりの1本のリストのまま）。「期間」欄
  // （座席期間の新規設定・修正）はどの期間のタブを見ていても全プロジェクトを対象にするため、
  // タブの絞り込み対象には含めない。
  const distinctPeriods = useMemo(() => {
    const map = new Map<string, { start: string; end: string }>()
    plans.forEach((p) => {
      map.set(`${p.period_start}__${p.period_end}`, { start: p.period_start, end: p.period_end })
    })
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.start.localeCompare(a.start))
  }, [plans])
  const [periodTab, setPeriodTab] = useState<string>('all')
  const autoSelectedPeriodTab = useRef(false)
  useEffect(() => {
    // 旧・四半期タブの「初期表示は最も新しいタブ（＝次の期間）を自動選択」を踏襲する。
    // 一度だけ自動選択し、以後は利用者が選んだタブを維持する
    if (!autoSelectedPeriodTab.current && distinctPeriods.length > 1) {
      autoSelectedPeriodTab.current = true
      setPeriodTab(distinctPeriods[0].key)
    }
  }, [distinctPeriods])
  const visiblePlans = useMemo(
    () => (periodTab === 'all' ? plans : plans.filter((p) => `${p.period_start}__${p.period_end}` === periodTab)),
    [plans, periodTab]
  )

  // 曜日絞り込み（2026-09-16新設）。「曜日調整、座席割り当てで一つの曜日に絞り込む機能が欲しい」
  // との要望を受けた。曜日調整表（WeekdayMatrix）では選んだ曜日の列以外を非表示にし、下の
  // 「座席割り当て」一覧では選んだ曜日に出社しないプロジェクトの行を非表示にする、という表示のみの
  // 絞り込み（データ・チェック状態自体は変更しない）。1つの選択を両方の表示に共通して使う
  const [weekdayFilter, setWeekdayFilter] = useState<Weekday | 'all'>('all')

  // 曜日以外の絞り込み（2026-09-17新設）。「絞り込み機能を充実させたい」との要望を受け、状態・
  // エリア・プロジェクト名の3種類を追加した。曜日絞り込みと同じく表示のみの絞り込みで、
  // 曜日調整表（行）・確定した出社曜日・座席割り当て一覧のいずれにも共通して効く。
  // 状態は既存のQuarterPlanStatusをそのまま使うと「アンケート回答受付中」の中の未回答／回答済みを
  // 区別できない（管理部が最も見たいのは「未回答のものだけ」であることが多いため）ため、
  // survey_openだけhas_responseで2つに分割した専用のキー集合を使う
  type StatusFilterKey =
    | 'all' | 'seats_confirmed' | 'survey_open_unanswered' | 'survey_open_answered'
    | 'seats_tentative' | 'weekdays_finalized' | 'seats_allocated'
  const STATUS_FILTER_OPTIONS: { key: StatusFilterKey; label: string }[] = [
    { key: 'all', label: 'すべて' },
    { key: 'seats_confirmed', label: 'アンケート未送信' },
    { key: 'survey_open_unanswered', label: 'アンケート未回答' },
    { key: 'survey_open_answered', label: 'アンケート回答済み' },
    { key: 'seats_tentative', label: '仮の座席割り当て中' },
    { key: 'weekdays_finalized', label: '曜日確定済み' },
    { key: 'seats_allocated', label: '座席割当済み' },
  ]
  const matchesStatusFilter = (p: QuarterPlanItem, key: StatusFilterKey): boolean => {
    switch (key) {
      case 'all': return true
      case 'survey_open_unanswered': return p.status === 'survey_open' && !p.has_response
      case 'survey_open_answered': return p.status === 'survey_open' && p.has_response
      default: return p.status === key
    }
  }
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>('all')

  // previous_areaがnull（座席の島の割当実績がない新規プロジェクト）は、S-09の他の箇所と同じく
  // 「EAST・WEST」寄りに数えず独立した「新規」として選べるようにする（NORTH／EAST・WESTどちらに
  // 分類されるか未定なプロジェクトを、絞り込みでも紛れ込ませないため）
  type AreaFilterKey = 'all' | 'NORTH' | 'EAST_WEST' | 'NEW'
  const matchesAreaFilter = (p: QuarterPlanItem, key: AreaFilterKey): boolean => {
    switch (key) {
      case 'all': return true
      case 'NEW': return p.previous_area === null
      case 'EAST_WEST': return p.previous_area === 'EAST' || p.previous_area === 'WEST'
      case 'NORTH': return p.previous_area === 'NORTH'
    }
  }
  const [areaFilter, setAreaFilter] = useState<AreaFilterKey>('all')

  const [nameFilter, setNameFilter] = useState('')

  const filteredPlans = useMemo(
    () =>
      visiblePlans.filter(
        (p) =>
          matchesStatusFilter(p, statusFilter) &&
          matchesAreaFilter(p, areaFilter) &&
          (nameFilter.trim() === '' || p.project_name.toLowerCase().includes(nameFilter.trim().toLowerCase()))
      ),
    [visiblePlans, statusFilter, areaFilter, nameFilter]
  )
  // 座席割り当て一覧の絞り込みに使う「そのプロジェクトの出社曜日」。確定済みならweekdays_finalized、
  // 未確定（アンケート回答済みだが曜日調整前）なら第一希望を暫定的に使う（WeekdayMatrixの初期
  // チェック状態と同じ考え方）。どちらもなければ絞り込みの対象外（常に表示する。アンケート未回答
  // でリマインドが必要なプロジェクト等を、曜日で絞り込んでも見失わないようにするため）
  const planWeekdaysForFilter = (p: QuarterPlanItem): Weekday[] | null =>
    p.weekdays_finalized ?? p.choice1_weekdays ?? null
  // アンケート未回答（status='survey_open'かつhas_response=false）のプロジェクトを一覧の先頭に
  // まとめる（2026-09-17追加。「未回答のPJを上に表示させたい」との要望を受けた。エリア責任者が
  // リマインドを送るべき対象をすぐ見つけられるようにするのが目的で、それ以外の並び順
  // （APIが返す期間・名前順）は変えない、安定ソート）
  const isUnanswered = (p: QuarterPlanItem) => p.status === 'survey_open' && !p.has_response
  const seatListPlans = useMemo(() => {
    const base =
      weekdayFilter === 'all'
        ? filteredPlans
        : filteredPlans.filter((p) => {
            const days = planWeekdaysForFilter(p)
            return days === null || days.includes(weekdayFilter)
          })
    return [...base].sort((a, b) => Number(isUnanswered(b)) - Number(isUnanswered(a)))
  }, [filteredPlans, weekdayFilter])

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
    // 「全プロジェクトが同じ期間を共有する」ことを主経路にするため、既定で全プロジェクトを選択済みに
    // しておく（外したい場合だけ個別にチェックを外す）。2026-09-11修正: 選択候補を全プロジェクトへ
    // 広げた際、既定選択は当初どおり期間未設定のプロジェクトのみに限っていたが、「次の期間が来る
    // とき、既に期間がある過去のプロジェクトも含めて全てチェック状態にしてほしい」との要望を受けた。
    // 次のサイクルへ全プロジェクトをまとめて進める運用が主目的のため、既に期間があるプロジェクトも
    // 含めて全件を既定選択にする（今回のサイクルに含めたくないプロジェクトだけ個別にチェックを外す）
    setBulkCreateSelected(new Set(allProjects.map((p) => p.id)))
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
    () => visiblePlans.filter((p) => p.status === 'seats_confirmed' || p.status === 'survey_open'),
    [visiblePlans]
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

  // 割り当て済み（status='seats_allocated'）のプロジェクトを取り消す（2026-09-18新設。「座席割り当て」
  // 一覧から割り当て済みプロジェクトを取り消す方法がない、との指摘を受けた。「確定した出社曜日」表にも
  // 同じA-62〔unfinalize-weekdays〕を使う取り消し機能があるが、複数選択前提のモーダル経由で手数が
  // 多いため、この一覧からは対象1件を選んだ状態で直接・即座に取り消せるようにする）。status='survey_open'
  // まで戻る（出社曜日・座席の選択はどちらもやり直せるよう、weekdays_finalized・allocated_seatsは
  // クリアせず残る。A-62のdocstring参照）
  const cancelAllocation = async (p: QuarterPlanItem) => {
    if (!window.confirm(`「${p.project_name}」の座席割り当てを取り消し、アンケート回答受付中の状態に戻します。よろしいですか？`)) return
    setActionError(null)
    setActionMessage(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${p.id}/unfinalize-weekdays`, { method: 'PUT' })
      setActionMessage(`${p.project_name} の割り当てを取り消しました`)
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '取り消しに失敗しました')
    }
  }

  // weekday指定時は、その1日だけを例外として編集する（2026-09-16新設。「PJは曜日によって座席が
  // 変わる前提で進めてください」との上司フィードバックを受けた）。allocatedSeatIdsはその曜日の
  // 実効座席（基本の島か、既に例外があればその座席）を渡し、otherWeekdaySeatsで他の確定曜日の
  // 座席をフロアマップのマーカー表示用に渡す
  const goSeatBlock = (p: QuarterPlanItem, weekday?: Weekday) => {
    const byWeekday = p.allocated_seats_by_weekday
    const allocatedSeatIds = weekday && byWeekday ? byWeekday[weekday]?.seat_ids : p.allocated_seat_ids ?? undefined
    const otherWeekdaySeats =
      weekday && byWeekday
        ? Object.entries(byWeekday)
            .filter(([w]) => w !== weekday)
            .map(([w, v]) => ({ weekday: w as Weekday, seatLabel: v.seat_label, seatIds: v.seat_ids }))
        : undefined
    navigate('/', {
      state: {
        seatBlockFor: {
          planId: p.id, projectName: p.project_name, requiredSeats: p.required_seats,
          allocatedSeatIds: allocatedSeatIds ?? undefined, periodStart: p.period_start,
          weekdaysFinalized: p.weekdays_finalized, weekday, otherWeekdaySeats,
        },
      },
    })
  }

  // 座席の島の一括割当（A-80、2026-09-10新設）。「座席の割り当てを一括で登録できるようにしてほしい」
  // との要望を受けた。当初は行ごとの「座席の島を割り当てる」ボタンと同じ条件（status='weekdays_finalized'・
  // 未割当）のプロジェクトのみを対象とし、既に座席を持つものは対象外にしていたが、「座席割り当てを
  // 登録して、再度戻すのが不便なので、座席の島の一括割当では常に全PJを編集できるようにしてほしい」
  // との要望を受け、status='seats_tentative'（仮の座席割り当て中、既に仮の座席を持つ場合を含む）も
  // 対象に追加した（2026-09-17拡張。バックエンドのA-80は元々この2状態を受け付けており、フロント側の
  // 絞り込みだけが古いままだった）。既にallocated_seatIdsを渡すことで、Availability.tsx側が単一編集
  // モード〔SeatBlockFor〕と同じ要領で現在の座席を初期選択状態として復元する。status='seats_allocated'
  // （本当に確定済み）は引き続き対象外のまま「座席を編集」（1件ずつ、A-44）を使う（A-80自体が
  // 既存の個人予約〔A-18〕との整理ロジックを持たないため、そこまで進んだプロジェクトを一括画面で
  // 再割当てすると古い座席の予約が残ってしまう恐れがある）
  const bulkEligible = (p: QuarterPlanItem) =>
    (p.status === 'weekdays_finalized' || p.status === 'seats_tentative') && !noSeatNeeded(p) && !seatBlockDoomed(p)
  const bulkBlockEligiblePlans = useMemo(() => visiblePlans.filter(bulkEligible), [visiblePlans])
  // 座席の島の一括割当画面（Availability.tsx）は、開いた時点のプロジェクト一覧をlocation.stateへ
  // 積んだ「スナップショット」として持ち、以降その画面を開いている間は自動で更新されない。他の
  // プロジェクトの座席（allocatedSeatIds等）が、この画面を開く直前の別の操作やタブで変わっていた
  // 場合にスナップショットが古いままだと、実際には重ならないはずの曜日のプロジェクト同士が
  // 「重複しています」と誤警告される不具合につながっていた（2026-09-17修正。「ODTの座席を選んだら
  // 本来出社日ではないIKI_ビリングONEと重複していると出た。IKI_ビリングONEはその席を選んでいない」
  // との報告を受けた）。ボタンを押した瞬間に必ずサーバーから最新の一覧を取り直してから
  // スナップショットを作るようにし、古いデータを持ち込む可能性を減らす。
  // 2026-09-18修正:「座席の島の割当が必要なプロジェクト」一覧は、曜日調整表の「仮の座席割り当てを
  // 作成する」（A-84を経由する）を経ずに直接この画面へ来られる別の入口になっており、status=
  // 'weekdays_finalized'のプロジェクトが曜日次第でいきなり本確定（seats_allocated）まで進んでしまう
  // ことがあった。「仮で決めるものと同じようにしてほしい」との指摘を受け、createTentativeAndAssignと
  // 同様にA-84（tentative-weekdays）を先に呼び、必ず「仮」を経由してからこの画面へ渡すよう統一した
  // （対象曜日は各プロジェクトの現在のweekdays_finalizedをそのまま使う。チェックボックスでの選び直しは
  // 発生しないため、曜日調整表側のように選択状態を渡す必要はない）
  const goSeatBlockBulk = async () => {
    setActionError(null)
    try {
      const fresh = await refreshAll()
      const freshPlans = (fresh?.items ?? plans).filter(
        (p) => periodTab === 'all' || `${p.period_start}__${p.period_end}` === periodTab
      )
      const eligible = freshPlans.filter(bulkEligible)
      if (eligible.length === 0) return
      await apiFetch('/api/project-quarter-plans/tentative-weekdays', {
        method: 'PUT',
        body: JSON.stringify({
          plans: eligible.map((p) => ({ plan_id: p.id, weekdays_finalized: p.weekdays_finalized ?? [] })),
        }),
      })
      const afterTentative = await refreshAll()
      const eligibleIds = new Set(eligible.map((p) => p.id))
      const toAssign = (afterTentative?.items ?? []).filter(
        (p) => eligibleIds.has(p.id) && p.status === 'seats_tentative'
      )
      navigate('/', {
        state: {
          seatBlockBulkFor: {
            plans: toAssign.map((p) => ({
              planId: p.id, projectName: p.project_name, requiredSeats: p.required_seats,
              periodStart: p.period_start, weekdaysFinalized: p.weekdays_finalized, note: p.note,
              allocatedSeatIds: p.allocated_seat_ids ?? undefined,
              allocatedSeatsByWeekday: p.allocated_seats_by_weekday,
            })),
          },
        },
      })
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '仮の座席割り当ての作成に失敗しました')
    }
  }

  // 仮の座席割り当て（A-84、2026-09-16新設）。「曜日を確定するのではなくそこから座席割り当ての
  // 仮作成をできるようにしてほしい」との要望を受けた。WeekdayMatrixの「仮の座席割り当てを作成する」
  // から呼ばれ、その調整表に表示中の全プロジェクトの現在のチェック状態をA-84で仮の曜日として
  // 保存したうえで、一括割当画面へ引き継ぐ（「座席の島の割当をまとめて行う」と同じ、表示中の対象を
  // まとめて処理する考え方に統一。取り消し済み〔A-62でweekdays_finalizedを消さない非破壊設計〕の
  // プロジェクトを再度割り当てる際も、チェックを変えずにこのボタンだけで反映されるようにするため）。
  // 以前は既に座席を持つプロジェクトを除外していたが、上記bulkBlockEligiblePlansと同じ理由で対象に
  // 含めるよう変更した（2026-09-17拡張。既存の座席はallocatedSeatIds経由で初期選択状態として
  // 復元されるため、除外する必要がなくなった）。遷移先の座席の島の割当画面へ引き継ぐ対象
  // （toAssign）はitemsに絞らず、現在の対象期間で既にstatus='seats_tentative'になっている全
  // プロジェクトを対象にする（以前に仮にしたプロジェクトも一緒に座席を割り当てたいという通常の
  // 使い方を壊さないため）
  const createTentativeAndAssign = async (items: { planId: number; weekdaysFinalized: Weekday[] }[]) => {
    if (items.length > 0) {
      await apiFetch('/api/project-quarter-plans/tentative-weekdays', {
        method: 'PUT',
        body: JSON.stringify({
          plans: items.map((i) => ({ plan_id: i.planId, weekdays_finalized: i.weekdaysFinalized })),
        }),
      })
    }
    const fresh = await refreshAll()
    const freshPlans = (fresh?.items ?? []).filter(
      (p) => periodTab === 'all' || `${p.period_start}__${p.period_end}` === periodTab
    )
    const toAssign = freshPlans.filter(
      (p) => p.status === 'seats_tentative' && !noSeatNeeded(p) && !seatBlockDoomed(p)
    )
    if (toAssign.length === 0) return
    navigate('/', {
      state: {
        seatBlockBulkFor: {
          plans: toAssign.map((p) => ({
            planId: p.id, projectName: p.project_name, requiredSeats: p.required_seats,
            periodStart: p.period_start, weekdaysFinalized: p.weekdays_finalized, note: p.note,
            allocatedSeatIds: p.allocated_seat_ids ?? undefined,
            allocatedSeatsByWeekday: p.allocated_seats_by_weekday,
          })),
        },
      },
    })
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-400 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">プロジェクト座席（エリア担当）</h1>
      </header>

      <div className="space-y-8 p-6">
        {actionMessage && <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{actionMessage}</p>}
        {actionError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}

        {/* 期間（座席期間の設定）: 2026-09-10、「期間、座席割り当て、曜日調整表がそれぞれどの位置に
            あるかわかりやすくしてほしい」との要望を受け、ページを3つのセクションに分け、
            見出し・区切り線を追加した */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">期間</h2>
          {/* 2026-09-11修正: 従来は期間未設定のプロジェクトが1件もない（＝全プロジェクトに現在・今後の
              期間が設定済み）場合、この一括新規設定の入口ごと消えていた。そのため既に期間があるプロ
              ジェクトについて次のサイクル分の期間を先に作成しておく手段がなかった（「9月〜11月の
              プロジェクトを、次の期間を作成するときの対象にできない」との報告）。期間未設定の警告と
              一括新規設定ボタンの表示自体は分離し、ボタンは常に表示する */}
          <div className={`rounded border p-4 ${unplannedProjects.length > 0 ? 'border-amber-200 bg-amber-50' : 'border-slate-400 bg-slate-50'}`}>
            {unplannedProjects.length > 0 && (
              <div className="mb-2 text-sm font-semibold text-amber-800">期間未設定のプロジェクト（{unplannedProjects.length}件）</div>
            )}
            <button
              type="button"
              onClick={openBulkCreate}
              className="rounded border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100"
            >
              座席期間を新規設定する
            </button>
          </div>
        </section>

        <hr className="border-slate-400" />

        {/* 期間タブ: 存在する座席期間が2件以上のときだけ表示する。以降の「座席割り当て」「曜日調整表」
            セクションはこのタブで選んだ期間だけに絞り込む（「期間」セクション自体は期間を問わず
            全プロジェクトを対象にするため絞り込まない、2026-09-11追加） */}
        {distinctPeriods.length > 1 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPeriodTab('all')}
              className={`rounded-full px-3 py-1 text-xs font-medium ${periodTab === 'all' ? 'bg-blue-800 text-white' : 'border border-slate-500 text-slate-600 hover:bg-slate-50'}`}
            >
              すべて
            </button>
            {distinctPeriods.map((per) => (
              <button
                key={per.key}
                type="button"
                onClick={() => setPeriodTab(per.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${periodTab === per.key ? 'bg-blue-800 text-white' : 'border border-slate-500 text-slate-600 hover:bg-slate-50'}`}
              >
                {per.start} 〜 {per.end}
              </button>
            ))}
          </div>
        )}

        {/* 曜日での絞り込み（2026-09-16新設）。「曜日調整、座席割り当てで一つの曜日に絞り込む機能が
            欲しい」との要望を受けた。下の「曜日調整表」（列の絞り込み）・「座席割り当て」一覧（行の
            絞り込み）の両方に共通して効く */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">曜日で絞り込み:</span>
          <button
            type="button"
            onClick={() => setWeekdayFilter('all')}
            className={`rounded-full px-3 py-1 text-xs font-medium ${weekdayFilter === 'all' ? 'bg-blue-800 text-white' : 'border border-slate-500 text-slate-600 hover:bg-slate-50'}`}
          >
            すべて
          </button>
          {WEEKDAYS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWeekdayFilter(w.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${weekdayFilter === w.key ? 'bg-blue-800 text-white' : 'border border-slate-500 text-slate-600 hover:bg-slate-50'}`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* 曜日以外の絞り込み（状態・エリア・プロジェクト名、2026-09-17新設）。「絞り込み機能を
            充実させたい」との要望を受けた。曜日での絞り込みと同じく、曜日調整表（行）・確定した
            出社曜日・座席割り当て一覧のいずれにも共通して効く表示のみの絞り込み */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs">
            <span className="font-semibold text-slate-500">状態:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilterKey)}
              className="h-7 rounded border border-slate-500 px-1.5 text-xs"
            >
              {STATUS_FILTER_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-500">エリア:</span>
            {([
              { key: 'all', label: 'すべて' },
              { key: 'NORTH', label: 'NORTH' },
              { key: 'EAST_WEST', label: 'EAST・WEST' },
              { key: 'NEW', label: '新規' },
            ] as const).map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setAreaFilter(o.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${areaFilter === o.key ? 'bg-blue-800 text-white' : 'border border-slate-500 text-slate-600 hover:bg-slate-50'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="font-semibold text-slate-500">プロジェクト名:</span>
            <input
              type="text"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              placeholder="キーワードで絞り込み"
              className="h-7 w-44 rounded border border-slate-500 px-2 text-xs"
            />
          </label>
          {(statusFilter !== 'all' || areaFilter !== 'all' || nameFilter.trim() !== '') && (
            <button
              type="button"
              onClick={() => { setStatusFilter('all'); setAreaFilter('all'); setNameFilter('') }}
              className="text-xs text-slate-400 underline hover:text-slate-600"
            >
              絞り込みをクリア
            </button>
          )}
        </div>

        {/* 曜日調整表: 出社曜日の調整（未確定分）と、確定済み出社曜日の一覧。次のサイクルの座席割り当てを
            行う際に前回の曜日調整表を参考にしたいとの要望を受け、座席割り当てより上に表示するよう
            順序を入れ替えた（2026-09-15修正。以前は座席割り当て→曜日調整表の順だった） */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">曜日調整表</h2>
          <WeekdayMatrix
            plans={filteredPlans.filter((p) => p.status === 'survey_open' || p.status === 'seats_tentative')}
            areaSeatCapacity={areaSeatCapacity}
            onCreateTentative={createTentativeAndAssign}
            weekdayFilter={weekdayFilter}
          />

          <ConfirmedWeekdaysTable
            plans={filteredPlans.filter((p) => p.status === 'weekdays_finalized' || p.status === 'seats_allocated')}
            onChanged={refreshAll}
          />
        </section>

        <hr className="border-slate-400" />

        {/* 座席期間の一括修正（A-66）: 「座席期間を一括で新規設定する」（新しい計画行を追加するA-68）と
            紛らわしく、隣に並んでいると勘違いしやすいとの指摘を受け、座席割り当てと曜日調整表の間へ
            分離して配置した（2026-09-11修正）。2026-09-17再修正: 配置を離しても、A-68「座席期間を
            新規設定する」（新規に計画行を作る）とA-66「既存の計画の座席期間をまとめて修正する」
            （既にある計画行の日付を書き換える）が同じ機能に見えるとの指摘を受け、ボタン名・モーダル
            見出しの両方に「既存の計画」「まとめて修正」という言葉を入れ、新規作成とは別物だと
            わかるようにした */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={openBulkPeriod}
            className="rounded border border-slate-500 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            既存の計画の座席期間をまとめて修正する
          </button>
        </div>

        <hr className="border-slate-400" />

        {/* 座席割り当て: 一覧（対象期間・状態・行ごとの割当操作）と、一括割当の起点ボタン。
            一括割当ボタンは従来ページ最上部にあったが、「上に表示されているが下の方に表示してほしい」
            との要望を受け、この一覧の下（同じ座席割り当てセクション内）へ移動した（2026-09-10） */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">座席割り当て</h2>
          <div className="overflow-x-auto rounded border border-slate-400 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-400 text-left text-slate-500">
                  <th className="px-4 py-2">プロジェクト</th>
                  <th className="px-4 py-2">席決め担当</th>
                  <th className="px-4 py-2">対象期間</th>
                  <th className="px-4 py-2">必要座席数</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {seatListPlans.map((p) => (
                  <tr key={p.id} className="border-b border-slate-400">
                    <td className="px-4 py-2 font-semibold" title={p.note ?? undefined}>
                      {p.project_name}{p.note && <span className="ml-1 text-amber-500" title={p.note}>備考あり</span>}
                      {/* 曜日によって座席の島が異なる場合の目印（2026-09-16新設。「PJは曜日によって
                          座席が変わる前提で進めてください」との上司フィードバックを受けた）。
                          内訳は曜日で絞り込んで確認する想定のため、ここではtitleで簡易表示のみ。
                          2026-09-17修正: 「状態の表示自体をなくしましょう」との要望を受け状態の
                          バッジ列を削除したため、同じ列にあった🔀もプロジェクト名の隣へ移した */}
                      {p.has_seat_override && p.allocated_seats_by_weekday && (
                        <span
                          className="ml-1 cursor-help"
                          title={`曜日によって座席が異なります: ${Object.entries(p.allocated_seats_by_weekday)
                            .map(([w, v]) => `${WEEKDAYS.find((wd) => wd.key === w)?.label}: ${v.seat_label}`)
                            .join('／')}`}
                        >
                          🔀
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">{p.seat_assigner_names}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{p.period_start} 〜 {p.period_end}</td>
                    <td className="px-4 py-2 font-semibold">{p.required_seats}名</td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        {p.status === 'survey_open' && !noSeatNeeded(p) && (
                          <button type="button" onClick={() => sendReminder(p)} className="rounded border border-slate-500 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">リマインドを送る</button>
                        )}
                        {p.status === 'weekdays_finalized' && !noSeatNeeded(p) && (
                          seatBlockDoomed(p) ? (
                            <span
                              className="cursor-help rounded bg-slate-100 px-3 py-1 text-xs text-slate-400"
                              title="現在のメンバーが全員固定座席保有者または在宅のため不要のため、座席の島を割り当てられません。「人数を修正」の値にかかわらず割り当てできません。メンバー構成を見直すか、必要座席数を0に修正してください。"
                            >
                              座席の島を割り当てる
                            </span>
                          ) : (
                            // 曜日で絞り込み中は、その曜日だけを先に割り当てられるようにする（2026-09-18修正。
                            // 「座席の島の一括割当の時点で曜日ごとに別々の座席を選びたい」との要望を受けた）。
                            // 従来はここだけ絞り込みを無視して常にweekday未指定（基本の島を全確定曜日へ一括
                            // 作成）で呼んでいたため、一括割当画面で先に一部の曜日だけ登録していても、ここから
                            // 「全て」表示のままこのボタンを押すとその例外ごと基本の島で上書きされてしまう
                            // （曜日を絞り込んでいればその曜日だけの例外として保存され、既存の他の曜日の
                            // 割当は保持される）
                            <button
                              type="button"
                              onClick={() => goSeatBlock(p, weekdayFilter === 'all' ? undefined : weekdayFilter)}
                              className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900"
                            >
                              {weekdayFilter === 'all' ? '座席の島を割り当てる' : `${WEEKDAYS.find((w) => w.key === weekdayFilter)?.label}曜日の座席を割り当てる`}
                            </button>
                          )
                        )}
                        {p.status !== 'seats_allocated' && (
                          <button type="button" onClick={() => openHeadcount(p)} className="rounded border border-slate-500 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">人数を修正</button>
                        )}
                        {(p.status === 'seats_confirmed' || p.status === 'survey_open') && (
                          <button type="button" onClick={() => openPeriod(p)} className="rounded border border-slate-500 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">期間を修正</button>
                        )}
                        {/* 仮の座席割り当て（seats_tentative、2026-09-16追加）は本当に確定するまで
                            自由にやり直せるため、座席割当済み（seats_allocated）と同じ「座席を編集」
                            導線（1件ずつ、A-44）で選び直す。座席をまだ選んでいない（一括割当画面から
                            離脱した等）場合はボタンの表示自体はそのまま出し、A-44側で新規割当として扱う */}
                        {/* 曜日で絞り込み中は、その曜日だけを例外として編集する（2026-09-16新設。
                            「PJは曜日によって座席が変わる前提で進めてください」との上司フィードバック
                            を受けた）。「すべて」表示中は従来どおり基本の島（全確定曜日）を編集する */}
                        {(p.status === 'seats_allocated' || p.status === 'seats_tentative') && (
                          seatBlockDoomed(p) ? (
                            <span
                              className="cursor-help rounded bg-slate-100 px-3 py-1 text-xs text-slate-400"
                              title="現在のメンバーが全員固定座席保有者または在宅のため不要のため、座席の島を割り当てられません。メンバー構成を見直すか、必要座席数を0に修正してください。"
                            >
                              {weekdayFilter === 'all' ? '座席を編集' : `${WEEKDAYS.find((w) => w.key === weekdayFilter)?.label}曜日の座席を編集`}
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => goSeatBlock(p, weekdayFilter === 'all' ? undefined : weekdayFilter)}
                              className="rounded border border-slate-500 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                            >
                              {weekdayFilter === 'all' ? '座席を編集' : `${WEEKDAYS.find((w) => w.key === weekdayFilter)?.label}曜日の座席を編集`}
                            </button>
                          )
                        )}
                        {/* 割り当て済み・仮割り当て中プロジェクトの取り消し（2026-09-18新設。「割り当て済みの
                            プロジェクトを取り消しする機能がない」との指摘を受けた。「確定した出社曜日」表にも
                            同じA-62を使う取り消し機能はあるが、対象がweekdays_finalized・seats_allocatedのみ
                            （seats_tentativeは対象外）かつ複数選択前提のモーダル経由になるため、この一覧からは
                            対象1件を直接・即座に取り消せるようにする。2026-09-18再拡張: 当初はseats_allocated
                            のみだったが、「そもそも確定済みのプロジェクトを取り消す方法はないんですか」との
                            指摘（仮割当どうしが同じ座席・曜日で重複したまま取り消す手段がなかった）を受け、
                            seats_tentative（仮）も対象に追加した。バックエンド（A-62）は元々both対応済み */}
                        {(p.status === 'seats_allocated' || p.status === 'seats_tentative') && (
                          <button
                            type="button"
                            onClick={() => cancelAllocation(p)}
                            className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            取り消す
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {seatListPlans.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400">該当する計画がありません</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {bulkBlockEligiblePlans.length > 0 && (
            <div className="rounded border border-blue-200 bg-blue-50 p-4">
              <div className="mb-2 text-sm font-semibold text-blue-800">座席の島の割当が必要なプロジェクト（{bulkBlockEligiblePlans.length}件）</div>
              <button
                type="button"
                onClick={goSeatBlockBulk}
                className="rounded bg-blue-800 px-3 py-1.5 text-sm text-white hover:bg-blue-900"
              >
                座席の島の割当をまとめて行う
              </button>
            </div>
          )}
        </section>
      </div>

      {headcountTarget && (
        <Modal
          title={`必要座席数の確認・修正（${headcountTarget.project_name}）`}
          onClose={() => setHeadcountTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setHeadcountTarget(null)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
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
                className="h-9 w-28 rounded border border-slate-500 px-3"
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
              <button type="button" onClick={() => setPeriodTarget(null)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitPeriod} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">この内容で保存する</button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <MonthDurationPicker onApply={(s, e) => { setPeriodStartValue(s); setPeriodEndValue(e) }} />
            <label className="block">
              <span className="mb-1 block text-slate-500">開始日</span>
              <input
                type="date"
                value={periodStartValue}
                onChange={(e) => setPeriodStartValue(e.target.value)}
                className="h-9 w-full rounded border border-slate-500 px-3"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-slate-500">終了日</span>
              <input
                type="date"
                value={periodEndValue}
                onChange={(e) => setPeriodEndValue(e.target.value)}
                className="h-9 w-full rounded border border-slate-500 px-3"
              />
            </label>
            {actionError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{actionError}</p>}
          </div>
        </Modal>
      )}

      {bulkCreateModalOpen && (
        <Modal
          title="座席期間を一括で新規設定する"
          onClose={() => setBulkCreateModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setBulkCreateModalOpen(false)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
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
            <MonthDurationPicker onApply={(s, e) => { setBulkCreateStartValue(s); setBulkCreateEndValue(e) }} />
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">開始日</span>
                <input
                  type="date"
                  value={bulkCreateStartValue}
                  onChange={(e) => setBulkCreateStartValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-500 px-3"
                />
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">終了日</span>
                <input
                  type="date"
                  value={bulkCreateEndValue}
                  onChange={(e) => setBulkCreateEndValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-500 px-3"
                />
              </label>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {[...allProjects]
                .sort((a, b) => {
                  const aPlanned = currentPeriodByProject.has(a.id) ? 1 : 0
                  const bPlanned = currentPeriodByProject.has(b.id) ? 1 : 0
                  return aPlanned - bPlanned || a.name.localeCompare(b.name, 'ja')
                })
                .map((p) => {
                  const current = currentPeriodByProject.get(p.id)
                  return (
                    <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                      <input type="checkbox" checked={bulkCreateSelected.has(p.id)} onChange={() => toggleBulkCreateSelect(p.id)} />
                      <span>{p.name}</span>
                      {current && (
                        <span className="text-xs text-slate-400">（設定済み: {current.start}〜{current.end}）</span>
                      )}
                    </label>
                  )
                })}
              {allProjects.length === 0 && (
                <p className="px-2 py-1.5 text-slate-400">対象のプロジェクトがありません</p>
              )}
            </div>
            {bulkCreateError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{bulkCreateError}</p>}
          </div>
        </Modal>
      )}

      {bulkPeriodModalOpen && (
        <Modal
          title="既存の計画の座席期間をまとめて修正する"
          onClose={() => setBulkPeriodModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setBulkPeriodModalOpen(false)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
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
            <MonthDurationPicker onApply={(s, e) => { setBulkPeriodStartValue(s); setBulkPeriodEndValue(e) }} />
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">開始日</span>
                <input
                  type="date"
                  value={bulkPeriodStartValue}
                  onChange={(e) => setBulkPeriodStartValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-500 px-3"
                />
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">終了日</span>
                <input
                  type="date"
                  value={bulkPeriodEndValue}
                  onChange={(e) => setBulkPeriodEndValue(e.target.value)}
                  className="h-9 w-full rounded border border-slate-500 px-3"
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
// （status='seats_allocated'）の行も、2026-09-08から編集可能に含めた（「曜日変更はいつでもできる
// ようにしてほしい。座席が割り当てている状態でも。座席割り当て済みで変更があった場合、再度座席を
// 割り当てるようにしたい」との要望を受けた）。この場合、保存すると座席の島の割当前の状態
// （status='weekdays_finalized'）に戻り、「座席の島を割り当てる」ボタンが再度必要になる（A-43参照。
// 割当済みだった座席自体〔allocated_seats〕はクリアしないため、割当画面を開くと以前の選択が
// 初期状態のまま表示される）。
// 確定の取り消し（A-62）は、行ごとに即時実行する「取り消す」ボタン → 先頭列のチェックボックスで
// 選んでから一括実行、と試したが、「プロジェクトの確定を取り消すを押した後、どのプロジェクトにするか
// 選択するようにしてほしい」との要望を受け、まず「プロジェクトの確定を取り消す」ボタンを押し、
// 開いたモーダルで対象プロジェクトを選んでから実行する順序に変更した（2026-09-02）。
// 2026-09-16再拡張: 「割り当て済みからアンケート回答後に戻せるボタンが欲しい」との要望を受け、
// status='seats_allocated'（割当済み）もunfinalizeCandidatesに含めた。A-62は起点の状態を問わず常に
// status='survey_open'まで一段階で戻す（下記editablePlansとは対象が異なるため、引き続き別に絞り込む）。
// 曜日調整表・確定した出社曜日の両テーブルで使う「備考」欄（A-83、2026-09-14新設）。既存のnote
// （T-11、PM/PLがアンケート回答時に入力する読み取り専用の備考）とは別物で、こちらは調整表を使う
// 管理部・エリア責任者自身が入力・保存するメモ。プロジェクトごとに独立して保存するため、行の再描画で
// 編集中の内容が失われないよう、propの変更時（別の計画への切り替え・保存後の再取得）のみ
// ローカルstateを同期する
function AdminNoteField({ planId, initialValue }: { planId: number; initialValue: string | null }) {
  const [value, setValue] = useState(initialValue ?? '')
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 1行の<input>だと、長文を入力したとき先頭部分しか見えず後半が読めなくなるため
  // （2026-09-14修正。「たくさん入力するとき最初の部分は読めるが後半部分はほぼ読めない」との
  // 報告を受けた）、内容の折り返しに合わせて縦に自動で伸びる<textarea>に変更した。備考が
  // 短い（未入力の）行は1行分の高さのまま変わらず、長文を入力した行だけが必要な分だけ
  // 縦に伸びる（他の行の高さには影響しない）
  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  useEffect(() => {
    setValue(initialValue ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, initialValue])

  useEffect(() => {
    resize()
  }, [value])

  const save = async () => {
    if (value === (initialValue ?? '')) return
    setSaving(true)
    try {
      await apiFetch(`/api/project-quarter-plans/${planId}/admin-note`, {
        method: 'PUT',
        body: JSON.stringify({ admin_note: value || null }),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      disabled={saving}
      rows={1}
      placeholder="備考を入力"
      className="w-56 resize-none overflow-hidden rounded border border-slate-400 px-1.5 py-0.5 text-xs leading-snug disabled:opacity-50"
    />
  )
}

function ConfirmedWeekdaysTable({ plans, onChanged }: { plans: QuarterPlanItem[]; onChanged: () => void }) {
  const editablePlans = useMemo(
    () => plans.filter((p) => p.status === 'weekdays_finalized' || p.status === 'seats_allocated'),
    [plans]
  )
  const unfinalizeCandidates = useMemo(
    () => plans.filter((p) => p.status === 'weekdays_finalized' || p.status === 'seats_allocated'),
    [plans]
  )
  const editableIds = editablePlans.map((p) => p.id).join(',')
  const hasSeatsAllocatedEdit = editablePlans.some((p) => p.status === 'seats_allocated')
  const [checked, setChecked] = useState<Record<number, Set<Weekday>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 「この内容で変更する」を押した直後に送信せず、変更後の各プロジェクトの出社曜日を一覧で
  // 確認してから実行できるようにする確認モーダル（2026-09-11追加、上記weekdaysSummary参照）
  const [confirmModalOpen, setConfirmModalOpen] = useState(false)

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
      setConfirmModalOpen(false)
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
    <div className="rounded border border-slate-400 bg-white">
      <div className="border-b border-slate-400 px-4 py-3 font-semibold">
        確定した出社曜日
      </div>
      <div className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-400 text-left text-slate-500">
              <th className="pb-1 pr-3">プロジェクト</th>
              <th className="pb-1 pr-3">備考</th>
              {WEEKDAYS.map((w) => <th key={w.key} className="pb-1 px-2 text-center">{w.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const editable = p.status === 'weekdays_finalized' || p.status === 'seats_allocated'
              const confirmed = editable ? (checked[p.id] ?? new Set<Weekday>()) : new Set(p.weekdays_finalized ?? [])
              return (
                <tr key={p.id} className="border-b border-slate-400">
                  <td className="py-1 pr-3 font-semibold align-top">
                    {p.project_name}
                    {p.note && (
                      <span className="ml-1 cursor-help rounded bg-amber-50 px-1 text-xs font-normal text-amber-600" title={p.note}>
                        備考あり
                      </span>
                    )}
                    {p.status === 'seats_allocated' && (
                      <span className="ml-1 cursor-help rounded bg-amber-50 px-1 text-xs font-normal text-amber-600" title="変更すると座席の再割当が必要になります">
                        割当済み{p.allocated_seat_label ? `（${p.allocated_seat_label}）` : ''}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3 align-top">
                    <AdminNoteField planId={p.id} initialValue={p.admin_note} />
                  </td>
                  {WEEKDAYS.map((w) => {
                    const badge = weekdayBadge(p, w.key, confirmed)
                    if (editable) {
                      const isChecked = confirmed.has(w.key)
                      return (
                        <td key={w.key} className="px-2 py-1 text-center align-top">
                          {/* バッジの有無で行ごとに高さが変わりチェックボックスの縦位置がずれるため、
                              固定高さのスロットに入れる（2026-09-14修正、WeekdayMatrixと同じ対応） */}
                          <label className="inline-flex flex-col items-center gap-0.5">
                            <input type="checkbox" checked={isChecked} onChange={() => toggle(p.id, w.key)} className="h-3.5 w-3.5" />
                            <span className="flex h-3.5 items-center justify-center">
                              {badge && (
                                <span className={`rounded px-1 text-xs ${badge === '例外' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                                  {badge}
                                </span>
                              )}
                            </span>
                          </label>
                        </td>
                      )
                    }
                    const isConfirmed = confirmed.has(w.key)
                    return (
                      <td key={w.key} className="px-2 py-1 text-center align-top">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className={isConfirmed ? 'text-blue-800' : 'text-slate-300'}>{isConfirmed ? '✓' : '−'}</span>
                          <span className="flex h-3.5 items-center justify-center">
                            {badge && (
                              <span className={`rounded px-1 text-xs ${badge === '例外' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                                {badge}
                              </span>
                            )}
                          </span>
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
      {hasSeatsAllocatedEdit && (
        <p className="mx-4 mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          座席割当済みのプロジェクトが含まれています。「この内容で変更する」を押すと、該当プロジェクトは座席の島の割当前の状態に戻り、「座席の島を割り当てる」からの再割当が必要になります（割り当て済みだった座席は初期選択状態のまま残ります）。
        </p>
      )}
      {editablePlans.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-400 p-4">
          {unfinalizeCandidates.length > 0 && (
            <button
              type="button"
              onClick={openCancelModal}
              className="rounded bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-700"
            >
              プロジェクトの確定を取り消す
            </button>
          )}
          <button type="button" disabled={submitting} onClick={() => setConfirmModalOpen(true)} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            この内容で変更する
          </button>
        </div>
      )}

      {confirmModalOpen && (
        <Modal
          title="この内容で変更しますか"
          onClose={() => setConfirmModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setConfirmModalOpen(false)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitChanges} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
                この内容で変更する
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {editablePlans.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 border-b border-slate-400 pb-1.5">
                  <span className="font-semibold">{p.project_name}</span>
                  <span className="text-slate-600">{weekdaysSummary(checked[p.id])}</span>
                </li>
              ))}
            </ul>
            {hasSeatsAllocatedEdit && (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                座席割当済みのプロジェクトが含まれています。変更すると該当プロジェクトは座席の島の割当前の状態に戻り、「座席の島を割り当てる」からの再割当が必要になります（割り当て済みだった座席は初期選択状態のまま残ります）。
              </p>
            )}
            {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</p>}
          </div>
        </Modal>
      )}

      {cancelModalOpen && (
        <Modal
          title="出社曜日の確定を取り消す"
          onClose={() => setCancelModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setCancelModalOpen(false)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
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
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {unfinalizeCandidates.map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                  <input type="checkbox" checked={cancelSelected.has(p.id)} onChange={() => toggleCancelSelect(p.id)} />
                  <span>{p.project_name}</span>
                  {p.status === 'seats_allocated' && (
                    <span className="rounded bg-amber-50 px-1 text-xs font-normal text-amber-600">割当済み</span>
                  )}
                </label>
              ))}
            </div>
            {[...cancelSelected].some((id) => unfinalizeCandidates.find((p) => p.id === id)?.status === 'seats_allocated') && (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                割当済みのプロジェクトが含まれています。取り消すとアンケート回答後（出社曜日未確定）の状態まで
                一気に戻り、出社曜日の確定・座席の島の割当を最初からやり直す必要があります（確定していた曜日・
                割り当て済みだった座席は初期値として残ります）。メンバー個別の座席予約は自動的には取り消されない
                ため、必要に応じて別途調整してください。
              </p>
            )}
            {cancelError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{cancelError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}

function WeekdayMatrix({ plans, areaSeatCapacity, onCreateTentative, weekdayFilter }: {
  plans: QuarterPlanItem[]
  areaSeatCapacity: { NORTH: number; EAST_WEST: number }
  // 仮の座席割り当てを作成する（A-84、2026-09-16新設）。呼び出し元（親）がAPI呼び出し・座席割当
  // 画面への遷移までまとめて行う。WeekdayMatrix自身は対象と現在のチェック状態を渡すだけ
  onCreateTentative: (items: { planId: number; weekdaysFinalized: Weekday[] }[]) => Promise<void>
  // 曜日での絞り込み（2026-09-16新設）。'all'以外なら、選んだ曜日の列以外を非表示にする
  // （チェック状態・確定操作の対象自体は変更しない、表示のみの絞り込み）
  weekdayFilter: Weekday | 'all'
}) {
  const navigate = useNavigate()
  const visibleWeekdays = weekdayFilter === 'all' ? WEEKDAYS : WEEKDAYS.filter((w) => w.key === weekdayFilter)
  const [checked, setChecked] = useState<Record<number, Set<Weekday>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { items: fixedAssignments } = useFixedSeatAssignments()
  // AI提案（FR-03-11、2026-09-08追加）: aiSuggestedはAIが埋めた「未編集の」セルのみを保持し、
  // エリア責任者がセルを直接編集する（toggle）とそのセルだけ取り除く（バッジが消え、通常の
  // 確定操作対象になる）。aiReasoningはプロジェクトごとの判断理由（グループ単位で生成するため、
  // 生成のたびにそのグループのプロジェクト分だけ上書きされる）。
  const [aiSuggested, setAiSuggested] = useState<Record<number, Set<Weekday>>>({})
  const [aiReasoning, setAiReasoning] = useState<Record<number, string>>({})
  const [aiLoadingGroup, setAiLoadingGroup] = useState<string | null>(null)
  const [aiErrorByGroup, setAiErrorByGroup] = useState<Record<string, string>>({})
  // AIの応答に一部のplan_idの提案が含まれていなかった場合の注意書き（グループ単位、2026-09-09追加。
  // 従来は返ってきたsuggestionsだけを反映するため、AIが一部のプロジェクトの提案を返し忘れても
  // 気づけず、利用者が「グループ全体にAI提案が適用された」と誤認しうる不具合があった）
  const [aiPartialWarningByGroup, setAiPartialWarningByGroup] = useState<Record<string, string>>({})
  useEffect(() => {
    const initial: Record<number, Set<Weekday>> = {}
    plans.forEach((p) => {
      // weekdays_draft（A-86、2026-09-24新設）を最優先で使う。「曜日調整表のチェックマークを保存
      // できる機能がほしい、画面を閉じても残るようにしたい」との要望を受けた。weekdays_finalizedが
      // 確定するタイミング（A-43・A-84）で必ずNULLへ戻される（database.py・project_seats.py参照）
      // ため、ここに値が残っているのは「まだ確定していない編集中のチェック状態」の場合のみで、
      // weekdays_finalizedより古くなることはない。以前からの「確定した出社曜日」表からの取り消し
      // （A-62）で戻ってきた場合に直前の確定内容を初期値にする、というフォールバックの考え方は
      // そのまま維持する（毎回choice1_weekdaysへ戻すと、確定時に追加した「例外」日が消えてしまう）
      initial[p.id] = new Set(p.weekdays_draft ?? p.weekdays_finalized ?? p.choice1_weekdays ?? [])
    })
    setChecked(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans.map((p) => p.id).join(',')])

  // チェック状態の下書き保存（A-86、2026-09-24新設）。「常時保存機能を削除してほしい」との要望で
  // 撤去した旧・常時保存（scheduleAutoSave、A-84を都度自動呼び出し）は、statusをseats_tentativeへ
  // 進めてしまい仮の座席割り当ての挙動と衝突していた。今回はA-84・A-43とは完全に無関係な
  // weekdays_draft列だけを更新するAPIを新設したため、同じ「触るたびに自動保存する」という
  // 体験を、状態遷移への影響を一切気にせず安全に復活できる。チェックのたびに毎回リクエストは
  // 送らず、一定時間（800ms）操作が止まってからまとめて送る（デバウンス）。画面遷移・タブを
  // 閉じるなどでコンポーネントが破棄される際は、保留中の変更をタイマーを待たずその場で送る
  // （flushOnUnmount）。保存自体は表示用のメモに過ぎないため、失敗しても画面表示（ローカルの
  // checked）には影響させない（エラーを握りつぶす。次に別のセルを編集すればまた送られる）
  const pendingDraftRef = useRef<Record<number, Set<Weekday>>>({})
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushDraft = () => {
    const entries = Object.entries(pendingDraftRef.current)
    pendingDraftRef.current = {}
    if (entries.length === 0) return
    apiFetch('/api/project-quarter-plans/weekdays-draft', {
      method: 'PUT',
      body: JSON.stringify({
        plans: entries.map(([planId, days]) => ({ plan_id: Number(planId), weekdays: [...days] })),
      }),
      keepalive: true,
    }).catch(() => {})
  }
  const scheduleDraftSave = (planId: number, next: Set<Weekday>) => {
    pendingDraftRef.current[planId] = next
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null
      flushDraft()
    }, 800)
  }
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current)
        draftTimerRef.current = null
      }
      flushDraft()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 前回分の確定曜日・座席割当を常時表示（2026-09-16変更。当初は「前回の確定曜日をコピーする」ボタンで
  // チェック状態へ直接コピーしていたが、「座席の位置と出社曜日を記載されているようにしてほしい」との
  // 要望を受けて参照専用の表示に変更し、続けて「常時表示しててほしいのと座席番号のみでいいよ」との
  // 要望を受け、クリックで開くトグルではなく行内に常時表示する形に改め、メンバーごとの内訳
  // （assignments）ではなくその座席の島の座席番号だけ（allocated_seat_label）を表示するようにした。
  // 次サイクルの曜日調整・座席割当を検討する際に前回の実績を見比べられるようにするのが目的で、
  // チェック状態は変更しない。A-15（前回サイクルの参照）を再利用する
  const [previousByPlan, setPreviousByPlan] = useState<Record<number, PreviousPlanDetail>>({})
  useEffect(() => {
    const targets = plans.filter((p) => p.has_previous_plan && !(p.id in previousByPlan))
    targets.forEach((p) => {
      apiFetch<PreviousPlanDetail>(`/api/project-quarter-plans/${p.id}/previous`)
        .then((data) => setPreviousByPlan((prev) => ({ ...prev, [p.id]: data })))
        .catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans.map((p) => p.id).join(',')])

  if (plans.length === 0) return null

  // 2026-09-24修正:「常時保存機能を削除してほしい」との要望を受け、チェックのたびにA-84（仮の座席
  // 割り当て）を自動呼び出す常時自動保存（scheduleAutoSave）を廃止した。status・仮の座席割り当ての
  // 判定に関わる保存は、引き続き下の「仮の座席割り当てを作成する」ボタン（createTentative）を
  // 押したタイミングでのみ行う。チェックのたびに呼ぶのはA-86（weekdays_draftだけを更新する、
  // 上のscheduleDraftSave）のみで、こちらはstatusに一切関与しないため常時呼び出しても安全
  const toggle = (planId: number, day: Weekday) => {
    setChecked((prev) => {
      const next = new Set(prev[planId] ?? [])
      if (next.has(day)) next.delete(day)
      else next.add(day)
      scheduleDraftSave(planId, next)
      return { ...prev, [planId]: next }
    })
    // 手動で編集したセルはAI提案のバッジを外す（検討資料「プロジェクト座席・曜日調整フロー改善案」
    // 3.3節「仮/確定の区別」の方針どおり、以降は通常の確定操作対象として扱う）
    setAiSuggested((prev) => {
      if (!prev[planId]?.has(day)) return prev
      const next = new Set(prev[planId])
      next.delete(day)
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
  // との回答による。一度も割り当てたことがないプロジェクト（previous_area=null）は、以前は独立した
  // 「UNKNOWN」グループにまとめていたが、「基本的にEAST・WESTの区分になるので、そのエリアの扱いに
  // してほしい」との要望を受け、既定でEAST・WESTグループへ含めるよう変更した（2026-09-15変更）。
  // 当初はプロジェクトごとにNORTHへ切り替えるボタンを設けていたが、「このボタンはいらないかもです。
  // 新規プロジェクトはEAST・WESTエリアに入れるようにお願いします」との要望を受け、切り替え自体を
  // 廃止し常にEAST・WESTへ固定した（2026-09-17変更。新規プロジェクトである目印は「NEW」バッジ
  // 〔表示のみ、下記〕に置き換えた）。
  // seatCapacity: そのグループの物理座席数（座席タイプ問わず）。「曜日ごとの合計」がこれを超えた
  // 曜日を警告表示するために使う（2026-09-09追加）。
  const AREA_GROUPS: {
    key: string; label: string
    matchPlan: (p: QuarterPlanItem) => boolean
    matchFixed: (a: (typeof fixedAssignments)[number]) => boolean
    seatCapacity: number
  }[] = [
    {
      key: 'NORTH', label: 'NORTHエリア',
      matchPlan: (p) => p.previous_area === 'NORTH',
      matchFixed: (a) => a.area === 'NORTH', seatCapacity: areaSeatCapacity.NORTH,
    },
    {
      key: 'EAST_WEST', label: 'EAST・WESTエリア',
      matchPlan: (p) => p.previous_area === 'EAST' || p.previous_area === 'WEST' || p.previous_area === null,
      matchFixed: (a) => a.area === 'EAST' || a.area === 'WEST', seatCapacity: areaSeatCapacity.EAST_WEST,
    },
  ]
  const groups = AREA_GROUPS.map((g) => {
    // 新規プロジェクト（previous_area === null、座席の島の割当実績がなくNORTH⇔EAST・WESTの
    // 切り替えボタンが出る対象）を各グループの上に優先表示する（2026-09-15追加、「新規プロジェクトは
    // 上に優先的に表示させて」との要望を受けた）。新規・既存それぞれの中は、APIの返却順
    // （period_start DESCの次にp.name、DBの既定の照合順序で英数字名が仮名・漢字名より先に来やすく
    // 素直な「あいうえお順」になっていなかった）ではなく、プロジェクト名のlocaleCompare('ja')で
    // 並べ替える（2026-09-16変更、「それ以外の順番はあいうえお順にできる？」との要望を受けた）
    const groupPlans = plans
      .filter(g.matchPlan)
      .sort((a, b) => {
        const newDiff = Number(a.previous_area !== null) - Number(b.previous_area !== null)
        return newDiff !== 0 ? newDiff : a.project_name.localeCompare(b.project_name, 'ja')
      })
    const fixedSeatCount = fixedAssignments.filter(g.matchFixed).length
    return {
      ...g, plans: groupPlans, fixedSeatCount,
      totalRequired: groupPlans.reduce((sum, p) => sum + p.required_seats, 0) + fixedSeatCount,
    }
  }).filter((g) => g.plans.length > 0 || g.fixedSeatCount > 0)

  // AI提案の生成（A-74、FR-03-11、2026-09-08追加）。グループ単位で、そのグループの全プロジェクトの
  // 第一・第二希望・備考と座席容量をサーバーへ送り、仮の曜日案を受け取ってそのままcheckedへ反映する
  // （既存の内容は上書きする）。失敗時は該当グループを変更せずエラーを表示する（検討資料3.3節
  // 「失敗時」の方針）。
  // 座席容量: 当初はtotalRequired（そのグループの必要座席数＋固定座席数の合計、需要側の数値）を
  // そのまま流用していたが、これはNORTH・EAST/WESTの実際の物理座席数（areaSeatCapacity）とは
  // 無関係な値になっており、月〜金すべて同じ値になるため実質AIへの制約として機能していなかった。
  // 「人数オーバーしていないのに調整された」との指摘（2026-09-15、新人研修とLCC(CS)の例）を受け、
  // 実際の物理座席数を渡すよう修正した（2026-09-15修正）。
  // fixed_seat_count（2026-09-15追加、「できるだけフリー座席を残すような感じにしたい」との
  // 要望を受けた）: 固定座席保有者は曜日によらず毎日座席を使うため、座席容量からその分を引いた
  // 残りが実際にプロジェクト・フリー座席として使える数になる。AIに伝え、調整が必要な場合は
  // できるだけ余裕（フリー座席として残る分）が大きい曜日を優先させる
  const generateAiSuggestions = async (group: (typeof groups)[number]) => {
    setAiLoadingGroup(group.key)
    setAiErrorByGroup((prev) => ({ ...prev, [group.key]: '' }))
    setAiPartialWarningByGroup((prev) => ({ ...prev, [group.key]: '' }))
    try {
      const capacity = Object.fromEntries(WEEKDAYS.map((w) => [w.key, group.seatCapacity])) as Record<Weekday, number>
      const data = await apiFetch<{ suggestions: WeekdayAiSuggestion[]; missing_plan_ids: number[] }>(
        '/api/project-quarter-plans/weekday-ai-suggestions',
        {
          method: 'POST',
          body: JSON.stringify({
            plans: group.plans.map((p) => ({
              plan_id: p.id, project_name: p.project_name, required_seats: p.required_seats,
              choice1_weekdays: p.choice1_weekdays, choice2_weekdays: p.choice2_weekdays, note: p.note,
            })),
            weekday_capacity: capacity,
            fixed_seat_count: group.fixedSeatCount,
          }),
        },
      )
      setChecked((prev) => {
        const next = { ...prev }
        data.suggestions.forEach((s) => {
          const days = new Set(s.weekdays)
          next[s.plan_id] = days
          scheduleDraftSave(s.plan_id, days)
        })
        return next
      })
      setAiSuggested((prev) => {
        const next = { ...prev }
        data.suggestions.forEach((s) => { next[s.plan_id] = new Set(s.weekdays) })
        return next
      })
      setAiReasoning((prev) => {
        const next = { ...prev }
        data.suggestions.forEach((s) => { next[s.plan_id] = s.reasoning })
        return next
      })
      if (data.missing_plan_ids && data.missing_plan_ids.length > 0) {
        const names = data.missing_plan_ids
          .map((id) => group.plans.find((p) => p.id === id)?.project_name ?? `plan_id ${id}`)
          .join('、')
        setAiPartialWarningByGroup((prev) => ({
          ...prev,
          [group.key]: `次のプロジェクトはAIから提案が返ってこなかったため、内容を変更していません: ${names}`,
        }))
      }
    } catch (e) {
      setAiErrorByGroup((prev) => ({ ...prev, [group.key]: e instanceof ApiError ? e.message : 'AI提案の生成に失敗しました' }))
    } finally {
      setAiLoadingGroup(null)
    }
  }

  // 「仮の座席割り当てを作成する」は、この調整表に表示中の全プロジェクト（status IN
  // survey_open/seats_tentative、既に「曜日調整が必要な対象」として絞り込み済み）を、現在の
  // チェック状態のまま仮登録する（「座席の島の割当をまとめて行う」と同じ、表示中の対象を
  // まとめて処理する考え方）
  const createTentative = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await onCreateTentative(
        plans.map((p) => ({ planId: p.id, weekdaysFinalized: [...(checked[p.id] ?? [])] }))
      )
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '仮の座席割り当ての作成に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  // 「この内容で本当に曜日を確定する」対象（仮の座席割り当て済みの行のみ、2026-09-16新設）。
  // 確定の実行自体は独立した確認画面（ConfirmWeekdays.tsx）に切り出したため、ここでは件数の
  // 判定にのみ使う
  const tentativePlans = plans.filter((p) => p.status === 'seats_tentative')

  return (
    <div className="rounded border border-slate-400 bg-white">
      <div className="border-b border-slate-400 px-4 py-3 font-semibold">
        出社曜日の調整表
      </div>
      <div className="space-y-4 p-4">
        {groups.map((g) => {
          const totalRequired = g.totalRequired
          const dayTotal = (day: Weekday) =>
            g.plans.reduce((sum, p) => sum + (checked[p.id]?.has(day) ? p.required_seats : 0), 0) + g.fixedSeatCount
          return (
            <div key={g.key} className="overflow-x-auto">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-600">
                  {g.label}
                  <span className="ml-1.5 text-xs font-normal text-slate-400">（座席総数{g.seatCapacity}席）</span>
                </div>
                {g.plans.length > 0 && (
                  <button
                    type="button"
                    disabled={aiLoadingGroup === g.key}
                    onClick={() => generateAiSuggestions(g)}
                    className="shrink-0 rounded border border-purple-300 px-3 py-1 text-xs text-purple-700 hover:bg-purple-50 disabled:opacity-50"
                  >
                    {aiLoadingGroup === g.key ? 'AI提案を生成中...' : 'AI提案を生成する'}
                  </button>
                )}
              </div>
              {aiErrorByGroup[g.key] && (
                <p className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">{aiErrorByGroup[g.key]}</p>
              )}
              {aiPartialWarningByGroup[g.key] && (
                <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">{aiPartialWarningByGroup[g.key]}</p>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-400 text-left text-slate-500">
                    <th className="pb-1 pr-3">プロジェクト</th>
                    {/* 「人数」という表記だとメンバーの現在の人数と誤解されやすいため、実際に表示している
                        値（required_seats）に合わせて「必要座席数」に改めた（2026-09-14修正。「まず人数を
                        見るのではなく必要座席の数をしりたい」との指摘を受けた。表示値自体は元から
                        required_seatsのままで変更していない） */}
                    <th className="pb-1 pr-3">必要座席数</th>
                    <th className="pb-1 pr-3">備考</th>
                    {visibleWeekdays.map((w) => <th key={w.key} className="pb-1 px-2 text-center">{w.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {g.plans.map((p) => (
                    <tr key={p.id} className="border-b border-slate-400">
                      <td className="py-1 pr-3 font-semibold align-top">
                        {p.project_name}
                        {p.note && (
                          <span className="ml-1 cursor-help rounded bg-amber-50 px-1 text-xs font-normal text-amber-600" title={p.note}>
                            備考あり
                          </span>
                        )}
                        {aiReasoning[p.id] && (
                          <span
                            className="ml-1 cursor-help rounded bg-purple-50 px-1 text-xs font-normal text-purple-600"
                            title={`AI提案の理由: ${aiReasoning[p.id]}`}
                          >
                            AI提案
                          </span>
                        )}
                        {/* 座席の島の割当実績がない（previous_area === null）新規プロジェクトの目印
                            （2026-09-15追加、2026-09-17変更）。当初はNORTH⇔EAST・WESTを切り替える
                            ボタンだったが、「このボタンはいらないかもです。新規プロジェクトはEAST・WEST
                            エリアに入れるようにお願いします」との要望を受け、切り替え機能は廃止し
                            常にEAST・WESTグループへ固定した。あわせて「NEWマークがあるとわかりやすい」
                            との要望を受け、表示のみのバッジに置き換えた */}
                        {p.previous_area === null && (
                          <span
                            title="座席の島の割当実績がない新規プロジェクトです（EAST・WESTエリア扱い）"
                            className="ml-1 cursor-help rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-normal text-emerald-600"
                          >
                            NEW
                          </span>
                        )}
                        {/* 2026-09-16修正: 「前回: 木・金／F1、F2、F3、F4、F5、F6、F7、H3、H4」のように
                            座席数が多いプロジェクトだと1行が長くなり画面が煩雑になるとの指摘を受け、
                            常時全文表示からラベル＋titleツールチップ（カーソルを合わせると表示）に
                            変更したが、続けて「文字が多すぎて目が疲れるので絵文字でもいいから表現
                            できるものが欲しい」との要望を受け、ラベル文字も🕐（前回分）・🪑（仮の
                            座席）の絵文字アイコンに置き換えた。前回分・仮の座席の情報自体は変更なく
                            引き続き常に取得済みで、隠しているのは表示のみ（titleツールチップで
                            カーソルを合わせると詳細が見える） */}
                        {/* status='weekdays_finalized'でも、曜日で絞り込みながら一部の曜日だけ先に
                            割り当てた直後はallocated_seats_by_weekdayが埋まる（2026-09-18修正、上の
                            「座席の島を割り当てる」ボタンの曜日絞り込み対応参照）。「全て」表示に
                            戻ったときにこの進捗が見えないと、既に割り当てた曜日を忘れて重複作業したり
                            誤って上書きしてしまうため、seats_tentativeと同じバッジで表示する */}
                        {(p.has_previous_plan || p.status === 'seats_tentative' || (p.status === 'weekdays_finalized' && p.allocated_seats_by_weekday)) && (
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                            {p.has_previous_plan && (
                              <span
                                className="cursor-help"
                                title={
                                  previousByPlan[p.id]
                                    ? `前回: ${
                                        previousByPlan[p.id].weekdays_finalized === null
                                          ? '曜日未確定'
                                          : previousByPlan[p.id].weekdays_finalized!.length > 0
                                            ? formatWeekdays(previousByPlan[p.id].weekdays_finalized!)
                                            : '出社なし'
                                      }／${previousByPlan[p.id].allocated_seat_label ?? '座席未確保'}`
                                    : '読み込み中...'
                                }
                              >
                                🕐
                              </span>
                            )}
                            {(p.status === 'seats_tentative' || p.status === 'weekdays_finalized') && p.allocated_seats_by_weekday && (
                              <span
                                className="cursor-help"
                                title={
                                  p.has_seat_override
                                    ? `${p.status === 'seats_tentative' ? '仮の座席' : '割当状況'}（曜日によって異なる）: ${Object.entries(p.allocated_seats_by_weekday)
                                        .map(([w, v]) => `${WEEKDAYS.find((wd) => wd.key === w)?.label}: ${v.seat_label || '未割当'}`)
                                        .join('／')}`
                                    : `${p.status === 'seats_tentative' ? '仮の座席' : '割当状況'}: ${p.allocated_seat_label ?? '未選択（下の「座席割り当て」欄から選んでください）'}`
                                }
                              >
                                🪑
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-1 pr-3 align-top">{p.required_seats}名</td>
                      <td className="py-1 pr-3 align-top">
                        <AdminNoteField planId={p.id} initialValue={p.admin_note} />
                      </td>
                      {visibleWeekdays.map((w) => {
                        const badge = badgeFor(p, w.key)
                        const isChecked = checked[p.id]?.has(w.key) ?? false
                        const isAiSuggested = aiSuggested[p.id]?.has(w.key) ?? false
                        return (
                          <td key={w.key} className="px-2 py-1 text-center align-top">
                            {/* AI・希望バッジは行によって有無が分かれるため、常に同じ高さのスロットに
                                入れてチェックボックスの縦位置がセルごとにずれないようにする
                                （2026-09-14修正。「チェックマークの配置が所々ずれている」との報告を受けた） */}
                            <label className="inline-flex flex-col items-center gap-0.5">
                              <span className="flex h-3.5 items-center justify-center">
                                {isAiSuggested && (
                                  <span className="rounded bg-purple-50 px-1 text-xs text-purple-600">AI</span>
                                )}
                              </span>
                              <input type="checkbox" checked={isChecked} onChange={() => toggle(p.id, w.key)} className="h-3.5 w-3.5" />
                              <span className="flex h-3.5 items-center justify-center">
                                {badge && (
                                  <span className={`rounded px-1 text-xs ${badge === '例外' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                                    {badge}
                                  </span>
                                )}
                              </span>
                            </label>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  {g.plans.length === 0 && (
                    <tr><td colSpan={3 + visibleWeekdays.length} className="py-4 text-center text-slate-400">曜日調整が必要なプロジェクトはありません（固定座席のみ）</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-500 font-semibold">
                    {/* 「曜日ごとの合計」という行名だったが、必要座席数列に表示している値
                        （totalRequired）は曜日ごとの値ではなく、全プロジェクトの必要座席数＋固定座席数を
                        合計した目標値（各曜日の実際のチェック合計と比較するための基準）だったため、
                        「これはどの人数なのか」との指摘を受けた（2026-09-14修正）。行名を目標値である
                        ことがわかる表記に改め、目標値のセルにも同じ説明をtitleツールチップで補足した */}
                    <td className="py-1 pr-3" title="全プロジェクトの必要座席数と固定座席の利用者数を合計した目標値。各曜日の実際のチェック合計人数がこの数に達すると、その曜日は緑色で✓表示になる">
                      必要座席数の合計（各曜日と比較する目標値）
                      <span className="ml-1 text-xs font-normal text-slate-400">（固定座席{g.fixedSeatCount}名を含む）</span>
                    </td>
                    <td className="py-1 pr-3" title="全プロジェクトの必要座席数と固定座席の利用者数を合計した目標値">{totalRequired}名</td>
                    <td className="py-1 pr-3"></td>
                    {visibleWeekdays.map((w) => {
                      const total = dayTotal(w.key)
                      const filled = totalRequired > 0 && total === totalRequired
                      // 座席不足の警告（2026-09-09追加）: その曜日の合計が物理座席数を超えている場合、
                      // 座席の島の割当段階で初めて発覚し曜日を調整し直す手戻りが起きていたため、
                      // 曜日を確定する前のこの段階で気づけるようにした
                      const over = total > g.seatCapacity ? total - g.seatCapacity : 0
                      // 残り席数（2026-09-15追加、「曜日調整表に残り席数も表示させたい」との要望）。
                      // 座席不足時は⚠で不足数を示しているため、残り席数は0以上のときだけ表示する。
                      const remaining = over === 0 ? g.seatCapacity - total : null
                      return (
                        <td
                          key={w.key}
                          title={over > 0 ? `座席総数${g.seatCapacity}席に対して${total}名。${over}席不足しています` : undefined}
                          className={`px-2 py-1 text-center ${
                            over > 0 ? 'rounded bg-red-50 text-red-700' : filled ? 'rounded bg-green-50 text-green-700' : ''
                          }`}
                        >
                          {total}
                          {filled && <span className="ml-1">✓</span>}
                          {over > 0 && <span className="ml-1">⚠{over}</span>}
                          {remaining !== null && (
                            <span className="ml-1 text-xs font-normal text-slate-400">(残り{remaining}席)</span>
                          )}
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

      <div className="flex items-center justify-end gap-2 border-t border-slate-400 p-4">
        {/* 「本当に確定する」内容の確認・実行は、以前はこの画面内にモーダル・その後ページ内表示として
            持っていたが、「プロジェクト座席（エリア担当）ではなく別の画面としてみれるようにしたい」
            との要望を受け、独立した確認画面（/project-seats-area/confirm-weekdays、ConfirmWeekdays.tsx）
            に切り出した（2026-09-17変更）。仮の座席割り当て済みの行が1件以上あるときだけ表示する */}
        {tentativePlans.length > 0 && (
          <button
            type="button"
            onClick={() => navigate('/project-seats-area/confirm-weekdays')}
            className="rounded bg-green-700 px-4 py-1.5 text-sm text-white"
          >
            この内容で本当に曜日を確定する
          </button>
        )}
        <button type="button" disabled={submitting} onClick={createTentative} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
          仮の座席割り当てを作成する
        </button>
      </div>
    </div>
  )
}
