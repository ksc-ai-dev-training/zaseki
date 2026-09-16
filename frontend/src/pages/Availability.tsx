import { Fragment, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useAvailability, type AreaFilter } from '../hooks/useAvailability'
import { useMyReservations } from '../hooks/useMyReservations'
import { useFloorZoom } from '../hooks/useFloorZoom'
import { useIsMobile } from '../hooks/useIsMobile'
import { usePeriodAvailability } from '../hooks/usePeriodAvailability'
import { useAreas } from '../hooks/useAreas'
import { useMyProjects } from '../hooks/useMyProjects'
import Modal from '../components/Modal'
import { NorthFloor, EastFloor, WestFloor } from '../components/FloorAreas'
import SeatTile from '../components/SeatTile'
import ExcludedDatesRetry from '../components/ExcludedDatesRetry'
import { FLOOR_LAYOUT_SEATS, blockLabelOf, compareSeatNo } from '../lib/floorLayout'
import type {
  AssignFixedSeatFor, MemberSeatAssignFor, MyReservation, ProjectPlanDetail, ProxyBookingFor,
  RecurringReservationResult, RetrySeatAssignmentResult, SeatAssignmentResult, SeatBlockBulkFor, SeatBlockFor, Seat, SeatStatus, SeatType, Weekday,
} from '../types'

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']
const RECURRING_WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

// メンバーへの座席確保モード（座席の島の割当、freeSeat=false）で、1人分の暫定割当
interface MemberFreeSeatPick {
  seatId: number
}

// メンバーへのフリー座席確保モード（freeSeat=true）の暫定割当1件。1人のメンバーが複数の日付・
// 座席を持てるよう、memberPicksとは別に配列で管理する（2026-09-08修正。「日にちを検索してその日の
// 座席表を見ながら、複数日をそれぞれ別の座席で確保したい」との要望を受け、開始日＋繰り返し
// パターンの指定方式から、日付ごとに座席をクリックして選ぶ方式に変更した。日付の切替は画面上部の
// 日付ナビゲーション（date）をそのまま使う）
interface FreeSeatDayPick {
  userId: number
  userName: string
  seatId: number
  seatNo: string
  date: string
}

// メンバーへのフリー座席確保モード（freeSeat=true）の「曜日パターン＋期間」方式（一括登録）の
// 暫定割当1件。座席を1回クリックして相手を選ぶだけで、その人の期間全体をまとめて登録できる
// （2026-09-09復活。「参考元より工数が多すぎて使いづらい」との指摘を受け、日付ごとに1件ずつ
// クリックする方式〔上のFreeSeatDayPick、以下byDateモード〕を例外時の代替手段に格下げし、
// こちらを既定モードに戻した。バックエンドのAPI形状〔A-75〕は元々この方式のまま変わっていない）
interface FreeSeatPatternPick {
  userId: number
  userName: string
  seatId: number
  seatNo: string
  startDate: string
  patternType: 'daily' | 'weekly'
  weekdays?: Weekday[]
  endDate: string
}

// メンバーへのフリー座席確保結果の表示用（2026-09-08追加）。SeatAssignmentResult自体には日付が
// 含まれないため、送信時のFreeSeatDayPick.dateを表示用に付加する（assignments配列とresults配列は
// 同じ順序で1対1に対応するためインデックスで対応付けられる）
type MemberAssignResultRow = SeatAssignmentResult & { date?: string }

function toLocalDateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function todayStr(): string {
  return toLocalDateStr(new Date())
}
function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  return toLocalDateStr(d)
}
const WEEKDAY_DOW: Record<Weekday, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 }
// 対象四半期の開始日（periodStart）以降で、確定した出社曜日（weekdaysFinalized）に最初に
// 該当する日を返す（最大6日先まで探索。該当する曜日がなければ起点の日をそのまま返す）。
// 「曜日が確定しているときに座席の割り当てをするので、その曜日のプロジェクト始動日初日に
// 設定してほしい」との要望を受けた（2026-09-02追加。開始日自体が確定曜日でないこともあるため）。
// 2026-09-14修正: periodStartを常に起点にしていたため、既に始まっている期間（例:
// 2026-07-01開始で今日が2026-09-14）ではperiodStartそのものが1か月以上前の過去日付になり、
// A-06（座席状況取得）のD12過去参照制限（既定31日）に引っかかって400エラーになり、
// フロアマップが表示できなくなっていた（「座席の島の割当をまとめて行うのボタンを押したとき
// 本来座席表が見れるはずなのに見れない」との報告を受けた）。起点をperiodStartと今日の
// 遅い方（max）にすることで、既に始まっている期間では今日以降の直近の該当曜日を指すようにした
// （期間がまだ始まっていない場合はperiodStartのまま、従来どおり）
function firstMatchingWeekdayOnOrAfter(periodStart: string, weekdaysFinalized: Weekday[]): string {
  const start = periodStart > todayStr() ? periodStart : todayStr()
  if (weekdaysFinalized.length === 0) return start
  const dows = new Set(weekdaysFinalized.map((w) => WEEKDAY_DOW[w]))
  let d = start
  for (let i = 0; i < 7; i++) {
    if (dows.has(new Date(`${d}T00:00:00`).getDay())) return d
    d = shiftDateStr(d, 1)
  }
  return start
}
function formatDateJa(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JA[d.getDay()]}）`
}
function formatDateShort(dateStr: string): { md: string; wd: string } {
  const d = new Date(`${dateStr}T00:00:00`)
  return { md: `${d.getMonth() + 1}/${d.getDate()}`, wd: WEEKDAY_JA[d.getDay()] }
}
// 曜日パターンの暫定割当（FreeSeatPatternPick）が、表示中の日付を実際に含むかどうか
// （座席タイルのプレビュー表示に使う。期間内でも曜日が一致しない日は含まない）
function patternPickCoversDate(p: FreeSeatPatternPick, dateStr: string): boolean {
  if (dateStr < p.startDate || dateStr > p.endDate) return false
  if (p.patternType === 'daily') return true
  return (p.weekdays ?? []).some((w) => WEEKDAY_DOW[w] === new Date(`${dateStr}T00:00:00`).getDay())
}

const AREA_TABS: { key: AreaFilter; label: string }[] = [
  { key: 'all', label: '全体表示' },
  { key: 'north', label: 'NORTHエリア' },
  { key: 'east', label: 'EASTエリア' },
  { key: 'west', label: 'WESTエリア' },
]

const SEAT_TYPE_JA: Record<SeatType, string> = { free: 'フリー', fixed: '固定', project: 'プロジェクト' }

// RULE-02（同一日複数予約禁止）の拒否メッセージ。バックエンドのDUPLICATE_SEAT_MESSAGE
// （backend/database.py）と文字列を必ず一致させること。confirmReserveの catch 内でこの文言と
// 完全一致するかどうかだけを見て「変更する」ボタンの表示を判定しているため、どちらか一方だけ
// 文言を変えるとボタンが出なくなる（2026-09-09、両側を定数化してこのリスクを明示した）。
const DUPLICATE_SEAT_MESSAGE = '同じ日に複数の座席は予約できません'

// 期間ビュー（S-02）の表: 縦軸=日付・予約数・空席、横軸=座席番号・種別（現行スプレッドシート準拠）。
// 左側の日付系4列・上部の座席ヘッダー行はスクロール中も見えるよう固定する（position: sticky）
const PERIOD_COL_DATE_W = 96
// スマホ幅では日付列に年を表示しない（下記PERIOD_COL_DATE_Wの説明・isMobile分岐参照）ため、
// 列幅も「09/11」相当まで狭める（2026-09-11追加。「期間ビューなのですが年を非表示にすることは
// できますか」との要望を受けた）
const PERIOD_COL_DATE_W_MOBILE = 64
const PERIOD_COL_WD_W = 44
const PERIOD_COL_RES_W = 56
const PERIOD_COL_VAC_W = 56

const STATUS_CSS_CLASS: Record<SeatStatus, string> = {
  free: 'status-free',
  mine: 'status-mine',
  occupied: 'status-occupied',
  occupied_fixed: 'status-fixed',
  project_confirmed: 'status-project',
  project_pending: 'status-pending',
}

const LEGEND: { status: SeatStatus; label: string }[] = [
  { status: 'free', label: '空き（予約可能）' },
  { status: 'mine', label: '自分の予約' },
  { status: 'occupied', label: '使用中（他の利用者）' },
  { status: 'occupied_fixed', label: '固定座席' },
  { status: 'project_confirmed', label: 'プロジェクト座席' },
  { status: 'project_pending', label: '未確定（プロジェクト座席）' },
]

// S-02から「複数人の代理予約（PJメンバー）」を開始するボタン。対象プロジェクト・メンバーを選ぶと
// フロアマップが「フリー座席の複数人代理予約モード」に切り替わる（2026-09-04追加。「フリー座席を
// まとめて確保（代理予約）はS-02でできるようにしたい」との要望を受けた。S-04の日付範囲・自動割当版
// 〔/free-seat-bookings〕に加え、フロアマップから1人ずつクリックして座席を選べる入口を追加した）。
// role='admin'またはP-PROXY（プロジェクトの代表者）またはP-SEATASSIGN（席決め権限）を持つプロジェクトが対象。
// 既にS-02上にいるため、モード開始はnavigateを使わず親（Availability）にコールバックで伝える
// （2026-09-07修正。「画面遷移はされずにS-02で予約される」ようにしてほしいとの要望を受けた）
function FreeSeatProxyBookingButton({ onStart }: { onStart: (payload: MemberSeatAssignFor) => void }) {
  const { items: myProjects } = useMyProjects()
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState<number | ''>('')
  const [plan, setPlan] = useState<ProjectPlanDetail | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [selectedMembers, setSelectedMembers] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // 実際の権限判定（バックエンドのcan_manage、project_pm.py参照）はcan_assign_seats or
  // proxy_user_id==自分のいずれかで、project_title（PM/PL）自体は権限を持たない。以前は
  // project_title==='PM'/'PL'もOR条件に含めていたため、権限のないPM/PLにもボタンが表示され、
  // 対象メンバー選択・座席クリックまで操作した最後にAPIの403で初めて拒否される不具合があった
  // （2026-09-09修正。同日中に千田さんの案でcan_manageの基準がproxy_user_idからcreated_byへ
  // 変わったことに伴い、ここもis_seat_proxy→is_project_creatorに追従したが、2026-09-14に
  // 「作成者はただの作成者で権限はない。席決め担当になった人がアンケートなどに回答できる」との
  // 指摘を受け、is_project_creator→is_seat_assigner〔proxy_user_id基準〕に戻した）。
  const eligibleProjects = myProjects.filter((p) => (p.can_assign_seats || p.is_seat_assigner) && p.plans.length > 0)
  // 対象プロジェクトを1つも持たない利用者にはボタン自体を表示しない（2026-09-07修正。
  // 「対象外の人にはボタン自体を表示しないように」との要望を受けた。以前はボタンが
  // 常に表示され、押した後のモーダル内のプルダウンで初めて対象外と分かる作りだった）
  if (eligibleProjects.length === 0) return null

  const openModal = () => {
    setOpen(true)
    setProjectId('')
    setPlan(null)
    setSelectedMembers(new Set())
    setError(null)
  }

  const pickProject = async (id: number) => {
    setProjectId(id)
    setPlan(null)
    setSelectedMembers(new Set())
    setError(null)
    const project = myProjects.find((p) => p.project_id === id)
    const latestPlanId = project?.plans[project.plans.length - 1]?.id
    if (!latestPlanId) return
    setPlanLoading(true)
    try {
      const data = await apiFetch<ProjectPlanDetail>(`/api/project-quarter-plans/${latestPlanId}`)
      setPlan(data)
      // 対象メンバーは既定で全員チェック済みにする（2026-09-10追加。「対象メンバーのチェックを
      // 最初全員チェックされている状態にしてほしい」との要望を受けた。以前は何も選ばれておらず、
      // メンバー数が多いプロジェクトほど1人ずつチェックする手間が大きかった）。対象外にしたい
      // 人だけチェックを外せばよい
      setSelectedMembers(new Set(data.members.filter((m) => !m.seat_not_required).map((m) => m.user_id)))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'メンバーの取得に失敗しました')
    } finally {
      setPlanLoading(false)
    }
  }

  const toggleMember = (userId: number) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const start = () => {
    if (!plan || selectedMembers.size === 0) return
    const members = plan.members
      .filter((m) => selectedMembers.has(m.user_id))
      .map((m) => ({ userId: m.user_id, name: m.name }))
    onStart({
      planId: plan.id, projectName: plan.project_name, periodStart: todayStr(),
      allocatedSeatIds: [], members, freeSeat: true,
    })
    setOpen(false)
  }

  // RULE-07廃止（2026-09-09）に伴い、固定座席保有者も対象に含める（フリー座席との併用可）
  const candidates = plan?.members.filter((m) => !m.seat_not_required) ?? []

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-full bg-blue-800 px-3 py-1 text-sm text-white hover:bg-blue-900"
      >
        複数人の代理予約（PJメンバー）
      </button>
      {open && (
        <Modal
          title="複数人の代理予約（フリー座席）"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={!plan || selectedMembers.size === 0}
                onClick={start}
                className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                フロアマップで座席を選ぶ
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">対象プロジェクト</span>
              <select
                value={projectId}
                onChange={(e) => pickProject(Number(e.target.value))}
                className="h-9 w-full rounded border border-slate-300 px-3"
              >
                <option value="">選択してください</option>
                {eligibleProjects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>{p.project_name}</option>
                ))}
              </select>
            </label>
            {planLoading && <p className="text-xs text-slate-400">読み込み中...</p>}
            {plan && (
              <div>
                <div className="mb-1 text-xs text-slate-500">対象メンバー</div>
                <div className="flex flex-wrap gap-3">
                  {candidates.map((m) => (
                    <label key={m.member_id} className="inline-flex items-center gap-1">
                      <input type="checkbox" checked={selectedMembers.has(m.user_id)} onChange={() => toggleMember(m.user_id)} />
                      {m.name}
                    </label>
                  ))}
                  {candidates.length === 0 && <span className="text-xs text-slate-400">対象にできるメンバーがいません</span>}
                </div>
              </div>
            )}
            {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}

// S-02 空き状況・予約。画面モックアップの実際のフロアマップ配置（部屋・柱・ロッカー含む）を再現する
export default function Availability() {
  const location = useLocation()
  const navigate = useNavigate()
  // S-05から「この人に固定座席を指定する」で遷移した場合、location.stateに対象者が積まれる
  const assignFixedSeatFor = (location.state as { assignFixedSeatFor?: AssignFixedSeatFor } | null)?.assignFixedSeatFor
  // S-07から「座席表に配置する」で遷移した場合の座席配置モード
  const placeSeatMode = Boolean((location.state as { placeSeatMode?: boolean } | null)?.placeSeatMode)
  // S-11から「この人を代理予約する」で遷移した場合、location.stateに対象者が積まれる（代理予約モード）
  const proxyBookingFor = (location.state as { proxyBookingFor?: ProxyBookingFor } | null)?.proxyBookingFor
  // S-09から「座席の島を割り当てる」で遷移した場合、location.stateに対象計画が積まれる（座席の島の割当モード）
  const seatBlockFor = (location.state as { seatBlockFor?: SeatBlockFor } | null)?.seatBlockFor
  // S-09から「座席の島の割当をまとめて行う」で遷移した場合、location.stateに対象計画一覧が積まれる
  // （座席の島の一括割当モード、A-80・2026-09-10新設。単一プロジェクト用のseatBlockForとは独立した
  // 別モードとして扱う。編集〔allocatedSeatIdsあり〕という単一モード特有の概念が一括モードには
  // 存在しないため、型を混在させない）
  const seatBlockBulkFor = (location.state as { seatBlockBulkFor?: SeatBlockBulkFor } | null)?.seatBlockBulkFor
  // S-04から「座席表から選ぶ」で遷移した場合、location.stateに対象計画が積まれる
  // （メンバーへの座席確保モード、2026-08-31追加）
  const memberSeatAssignFromNav = (location.state as { memberSeatAssignFor?: MemberSeatAssignFor } | null)?.memberSeatAssignFor
  // S-02の「複数人の代理予約（PJメンバー）」ボタンは既にこの画面上にいるため、画面遷移
  // （navigate呼び出し）を挟まずローカルのstateだけでモードに入る（2026-09-07修正。
  // 「画面遷移はされずにS-02で予約される」ようにしてほしいとの要望を受けた。以前はnavigate('/')を
  // 使っており、URLは変わらないもののルーターの再描画で画面がちらつく／リセットされる見た目になっていた）
  const [memberSeatAssignOverride, setMemberSeatAssignOverride] = useState<MemberSeatAssignFor | null>(null)
  const memberSeatAssignFor = memberSeatAssignOverride ?? memberSeatAssignFromNav

  const topRef = useRef<HTMLDivElement>(null)
  // 座席の島の割当モード・メンバーへの座席確保モードでは、操作時点（今日）ではなく対象四半期の
  // 開始日（10/1・1/1・4/1・7/1のいずれか）を初期表示にする（2026-08-31追加。「プロジェクト座席が
  // 決まる基準日の座席表を表示してほしい」との要望を受けた。実際に座席が使われ始める日の
  // 空き状況を見て選べるようにする）
  const [date, setDate] = useState(
    seatBlockFor
      ? firstMatchingWeekdayOnOrAfter(seatBlockFor.periodStart, seatBlockFor.weekdaysFinalized ?? [])
      : seatBlockBulkFor?.plans[0]
        ? firstMatchingWeekdayOnOrAfter(seatBlockBulkFor.plans[0].periodStart, seatBlockBulkFor.plans[0].weekdaysFinalized ?? [])
        : memberSeatAssignFor
          ? firstMatchingWeekdayOnOrAfter(memberSeatAssignFor.periodStart, memberSeatAssignFor.weekdaysFinalized ?? [])
          : todayStr()
  )
  const [viewMode, setViewMode] = useState<'floormap' | 'period'>('floormap')
  const [areaFilter, setAreaFilter] = useState<AreaFilter>('all')
  const [reservationTab, setReservationTab] = useState<'upcoming' | 'past'>('upcoming')
  const [periodOverride, setPeriodOverride] = useState<{ start: string; end: string } | null>(null)
  const [reserveTarget, setReserveTarget] = useState<{ seatId: number; seatNo: string; area: string; date: string } | null>(null)
  const [recurring, setRecurring] = useState(false)
  const [recurringType, setRecurringType] = useState<'daily' | 'weekly'>('weekly')
  const [recurringWeekdays, setRecurringWeekdays] = useState<Set<Weekday>>(new Set())
  const [recurringEndDate, setRecurringEndDate] = useState('')
  const [recurringResult, setRecurringResult] = useState<RecurringReservationResult | null>(null)
  // 「同じ日に複数の座席は予約できません」で拒否された場合、その場で「変更する」を選べるようにする
  // （2026-09-08追加。「同じ日に複数の座席は予約できませんと出てきたら変更するボタンが欲しい」との
  // 要望を受けた。existingSameDayReservation〔下記〕は誤ってプロジェクト座席を巻き込んで自動変更
  // しないよう事前の案内対象からは除外しているが、実際にサーバー側で拒否された後は、利用者の
  // 明示的なクリックを経て初めてreplace_existing=trueで再送信するため、対象をプロジェクト座席に
  // 広げても2026-09-07に修正した不具合〔確定済みプロジェクト座席の意図しない自動取消〕は再発しない）
  const [duplicateSeatError, setDuplicateSeatError] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<{ seat: Seat; area: string } | null>(null)
  // 「自分の予約」一覧の「取消」は確認なしで即削除していた（フロアマップから同じ予約を取り消す
  // 場合は確認モーダルが出るのに対して不揃いだった）。同じ取消操作に対して確認の有無が導線ごとに
  // 異なるのを避けるため、こちらにも確認モーダルを挟む（2026-09-16修正）
  const [listCancelTarget, setListCancelTarget] = useState<MyReservation | null>(null)
  const [listCancelSubmitting, setListCancelSubmitting] = useState(false)
  const [listCancelError, setListCancelError] = useState<string | null>(null)
  const [assignFixedSeatTarget, setAssignFixedSeatTarget] = useState<{ seat: Seat; area: string } | null>(null)
  const [assignIndefinite, setAssignIndefinite] = useState(true)
  const [assignValidUntil, setAssignValidUntil] = useState('')
  // 固定座席の開始日（2026-09-07追加。「何日から固定座席の指定ができるようにしたい」との
  // 要望を受けた）。過去日を指定すれば記録の補正、未来日を指定すれば事前の予約設定に使える
  const [assignValidFrom, setAssignValidFrom] = useState(todayStr())
  const [placeSeatTarget, setPlaceSeatTarget] = useState<{ area: 'NORTH' | 'EAST' | 'WEST'; posX: number; posY: number } | null>(null)
  const [newSeatNo, setNewSeatNo] = useState('')
  const [newSeatType, setNewSeatType] = useState<SeatType>('free')
  // 割当済み計画を「編集」で開いた場合、現在の割当座席を初期選択状態にする（2026-08-28追加）
  const [seatBlockSelection, setSeatBlockSelection] = useState<Set<number>>(
    () => new Set(seatBlockFor?.allocatedSeatIds ?? []),
  )
  // 座席の島の一括割当モード（2026-09-10追加）: 右側の一覧で選択中のプロジェクト、および
  // planId→選択中の座席idのSet（プロジェクトを切り替えても保持する）
  const [activeBulkPlanId, setActiveBulkPlanId] = useState<number | null>(seatBlockBulkFor?.plans[0]?.planId ?? null)
  const [bulkSelections, setBulkSelections] = useState<Record<number, Set<number>>>({})
  // メンバーへの座席確保モード（2026-08-31追加）: userId → 暫定割当の座席（＋freeSeatの場合は
  // その人だけの繰り返しパターン）。送信するまでサーバーには反映しない
  const [memberPicks, setMemberPicks] = useState<Record<number, MemberFreeSeatPick>>({})
  // メンバーへのフリー座席確保モードの暫定割当一覧（2026-09-08追加、上のFreeSeatDayPick参照）。
  // 「繰り返し予約にする」のチェックを入れずに確定した、単発（1日だけ）の割当用
  const [freeSeatPicks, setFreeSeatPicks] = useState<FreeSeatDayPick[]>([])
  // 「繰り返し予約にする」のチェックを入れて確定した、曜日パターン＋期間の割当用（2026-09-09復活）。
  // 単発とパターンは同じ操作フロー（pickMemberConfig）の中でチェックボックス1つで選び分け、
  // 送信時（confirmMemberSeatAssign）は両方の配列をまとめて結合する
  const [freeSeatPatternPicks, setFreeSeatPatternPicks] = useState<FreeSeatPatternPick[]>([])
  const [pickMemberTarget, setPickMemberTarget] = useState<{ seatId: number; seatNo: string } | null>(null)
  // メンバーへのフリー座席確保（freeSeat）で、座席クリック→相手選択の直後に開く確認モーダル。
  // 通常の座席予約モーダル（reserveTarget、上のrecurring系state）と同じ作りに統一し、既定は
  // 表示中の1日だけの確保、「繰り返し予約にする」にチェックを入れた場合だけ曜日パターン・終了日を
  // 指定する（2026-09-10修正。「1日と曜日でモードが分かれていて分かりにくい、普段のフリー座席の
  // 取り方の画面と同じにしてほしい」との要望を受け、事前にpatternモード／byDateモードを選ばせる
  // 方式〔2026-09-09〕をやめた）。startDateはモーダルを開いた時点の表示中の日付を保持する
  // （確認中に上部の日付が変わっても内容がずれないように）
  const [pickMemberConfig, setPickMemberConfig] = useState<{ seatId: number; seatNo: string; userId: number; userName: string; startDate: string } | null>(null)
  const [pickRecurring, setPickRecurring] = useState(false)
  const [pickRecurringType, setPickRecurringType] = useState<'daily' | 'weekly'>('weekly')
  const [pickRecurringWeekdays, setPickRecurringWeekdays] = useState<Set<Weekday>>(new Set())
  const [pickRecurringEndDate, setPickRecurringEndDate] = useState('')
  const [memberAssignResult, setMemberAssignResult] = useState<MemberAssignResultRow[] | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // RULE-07廃止（2026-09-09）に伴い、固定座席保有者が同じ日にフリー座席等を予約すると複数の座席を
  // 保有する状態になる。本人が気づけるよう、予約完了後に画面上へ警告を表示する
  // （「2つ座席を保有していることを通知する」との要望、方式は「本人に画面上で警告」を選択）
  const [multiSeatNotice, setMultiSeatNotice] = useState<string | null>(null)

  const { availability, isLoading, refresh: refreshAvailability } = useAvailability(date, areaFilter)
  const { items: areas } = useAreas(placeSeatMode)
  const { period, isLoading: periodLoading, error: periodFetchError, refresh: refreshPeriod } = usePeriodAvailability(periodOverride?.start, periodOverride?.end, areaFilter)
  const periodError = periodFetchError instanceof ApiError ? periodFetchError.message : null
  const upcoming = useMyReservations('upcoming')
  const past = useMyReservations('past')

  // 表示中の表示期間: ユーザーが編集していなければサーバー既定値（period.start/end、RULE-05の
  // 予約可能期間全体）をそのまま表示する。編集後はサーバー側のクランプ結果ではなく入力値を
  // 表示し続ける（無効な日付を打ち消し合って表示が飛ばないように）。
  const periodStart = periodOverride?.start ?? period?.start ?? ''
  const periodEnd = periodOverride?.end ?? period?.end ?? ''

  const refreshAll = async () => {
    await Promise.all([refreshAvailability(), refreshPeriod(), upcoming.mutate(), past.mutate()])
  }

  // 座席の島の割当モード（単一・一括共通）の選択状態を読み書きするヘルパー（2026-09-10追加、
  // 一括割当モードの新設に伴い、単一のseatBlockSelectionと一括のbulkSelections[activeBulkPlanId]の
  // どちらを操作するかをここで吸収する）
  const currentBlockSelection = seatBlockBulkFor
    ? bulkSelections[activeBulkPlanId ?? -1] ?? new Set<number>()
    : seatBlockSelection
  const updateBlockSelection = (updater: (prev: Set<number>) => Set<number>) => {
    if (seatBlockBulkFor) {
      if (activeBulkPlanId === null) return
      setBulkSelections((prev) => ({ ...prev, [activeBulkPlanId]: updater(prev[activeBulkPlanId] ?? new Set()) }))
    } else {
      setSeatBlockSelection(updater)
    }
  }
  // 一括割当モードで、右の一覧からプロジェクトを切り替える。その計画の対象四半期の開始日以降で
  // 確定した出社曜日に最初に該当する日にフロアマップの表示日を合わせる（単一モードの初期表示日と
  // 同じ考え方、firstMatchingWeekdayOnOrAfter参照）
  const pickBulkProject = (planId: number) => {
    setActionError(null)
    setActiveBulkPlanId(planId)
    const plan = seatBlockBulkFor?.plans.find((p) => p.planId === planId)
    if (plan) setDate(firstMatchingWeekdayOnOrAfter(plan.periodStart, plan.weekdaysFinalized ?? []))
  }
  const activeBulkPlan = seatBlockBulkFor?.plans.find((p) => p.planId === activeBulkPlanId)

  const openReserve = (seatId: number, seatNo: string, area: string, targetDate: string) => {
    setActionError(null)
    if (seatBlockFor || seatBlockBulkFor) {
      // S-09「座席の島の割当モード」（単一・一括とも）: モーダルは開かず、クリックのたびに選択をトグルする
      updateBlockSelection((prev) => {
        const next = new Set(prev)
        if (next.has(seatId)) next.delete(seatId)
        else next.add(seatId)
        return next
      })
      return
    }
    setReserveTarget({ seatId, seatNo, area, date: targetDate })
    setRecurring(false)
    setRecurringType('weekly')
    setRecurringWeekdays(new Set())
    setRecurringEndDate('')
    setRecurringResult(null)
    setDuplicateSeatError(false)
  }
  const openCancel = (seat: Seat, area: string) => {
    setActionError(null)
    setCancelTarget({ seat, area })
  }
  const openAssignFixedSeat = (seat: Seat, area: string) => {
    setActionError(null)
    setAssignIndefinite(true)
    setAssignValidUntil('')
    setAssignValidFrom(todayStr())
    setAssignFixedSeatTarget({ seat, area })
  }
  // S-04「メンバーへの座席確保モード」: 暫定割当済みの座席を再クリックした場合は割当を解除し、
  // 未割当の座席をクリックした場合は割り当てる相手を選ぶモーダルを開く（2026-08-31追加）
  const onMemberAssignClick = (seat: Seat) => {
    setActionError(null)
    if (memberSeatAssignFor?.freeSeat) {
      // 繰り返し（曜日パターン）の割当は座席1件につき1人分の期間全体を割り当てるため、日付を
      // 問わずこの座席が既に選ばれているかどうかで判定する（2026-09-09復活）
      const patternIndex = freeSeatPatternPicks.findIndex((p) => p.seatId === seat.id)
      if (patternIndex !== -1) {
        setFreeSeatPatternPicks((prev) => prev.filter((_, i) => i !== patternIndex))
        return
      }
      // 単発（1日だけ）の割当は日付ごとの暫定割当のため、「今表示中の日付」にこの座席の割当が
      // 既にあるかどうかで判定する（2026-09-08修正、上のFreeSeatDayPick参照）
      const dayIndex = freeSeatPicks.findIndex((p) => p.seatId === seat.id && p.date === date)
      if (dayIndex !== -1) {
        setFreeSeatPicks((prev) => prev.filter((_, i) => i !== dayIndex))
        return
      }
      setPickMemberTarget({ seatId: seat.id, seatNo: seat.seat_no })
      return
    }
    const pickedUserId = Object.entries(memberPicks).find(([, pick]) => pick.seatId === seat.id)?.[0]
    if (pickedUserId !== undefined) {
      setMemberPicks((prev) => {
        const next = { ...prev }
        delete next[Number(pickedUserId)]
        return next
      })
      return
    }
    setPickMemberTarget({ seatId: seat.id, seatNo: seat.seat_no })
  }
  const resetPeriodFilter = () => setPeriodOverride(null)
  const exitAssignFixedSeatMode = () => navigate('.', { replace: true, state: null })
  const exitPlaceSeatMode = () => navigate('.', { replace: true, state: null })
  const exitSeatBlockMode = () => { setSeatBlockSelection(new Set()); navigate('.', { replace: true, state: null }) }
  // 座席の島の割当モードで、ブロックのラベル（「Cブロック」等）をクリックしたときにそのブロック
  // 内の座席をまとめて選択・解除する（2026-09-09追加。「座席タイルを1つずつクリックする必要があり
  // 工数が多すぎる」との指摘を受けた。対象は各ブロックの中で選択可能な座席〔空き、または既に
  // 選択済み〕のみで、他の予約が入っている等で選択できない座席は対象外のまま残る）
  const onToggleSeatBlock = (seatIds: number[], select: boolean) => {
    updateBlockSelection((prev) => {
      const next = new Set(prev)
      seatIds.forEach((id) => { if (select) next.add(id); else next.delete(id) })
      return next
    })
  }

  const confirmSeatBlock = async () => {
    if (!seatBlockFor || seatBlockSelection.size === 0) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${seatBlockFor.planId}/seat-block`, {
        method: 'PUT',
        body: JSON.stringify({ seat_ids: [...seatBlockSelection] }),
      })
      setSeatBlockSelection(new Set())
      navigate('/project-seats-area', { replace: true })
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '座席の島の割当に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }
  const exitSeatBlockBulkMode = () => {
    setBulkSelections({})
    setActiveBulkPlanId(null)
    navigate('.', { replace: true, state: null })
  }
  const confirmSeatBlockBulk = async () => {
    const assignments = Object.entries(bulkSelections)
      .filter(([, set]) => set.size > 0)
      .map(([planId, set]) => ({ plan_id: Number(planId), seat_ids: [...set] }))
    if (assignments.length === 0) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch('/api/project-quarter-plans/seat-block-bulk', {
        method: 'POST',
        body: JSON.stringify({ assignments }),
      })
      setBulkSelections({})
      navigate('/project-seats-area', { replace: true })
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '座席の島の一括割当に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }
  // 座席の島の割当（単一・一括）で、選択内容を実際に登録する前に重複がないか事前確認する
  // （A-81、2026-09-10新設）。「かぶっている部分があったら登録する前に事前に通知してほしい」との
  // 要望を受けた。曜日単位の重複はフロアマップの1日表示だけでは気づけないことがあるため、選択が
  // 変わるたびにこのAPIを呼び、警告バナーとして表示する（実際の登録は行わない読み取り専用チェック）
  const blockCheckAssignments = seatBlockBulkFor
    ? Object.entries(bulkSelections)
        .filter(([, s]) => s.size > 0)
        .map(([planId, s]) => ({ plan_id: Number(planId), seat_ids: [...s] }))
    : seatBlockFor && seatBlockSelection.size > 0
      ? [{ plan_id: seatBlockFor.planId, seat_ids: [...seatBlockSelection] }]
      : []
  const blockCheckKey = JSON.stringify(blockCheckAssignments)
  const [blockConflicts, setBlockConflicts] = useState<string[]>([])
  useEffect(() => {
    if (!seatBlockFor && !seatBlockBulkFor) return
    if (blockCheckAssignments.length === 0) {
      setBlockConflicts([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      apiFetch<{ conflicts: string[] }>('/api/project-quarter-plans/seat-block-check', {
        method: 'POST',
        body: JSON.stringify({ assignments: blockCheckAssignments }),
      })
        .then((data) => { if (!cancelled) setBlockConflicts(data.conflicts) })
        .catch(() => { if (!cancelled) setBlockConflicts([]) })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockCheckKey])

  const exitProxyBookingMode = () => navigate('.', { replace: true, state: null })
  // S-04から遷移してきた場合（座席の島の割当）は従来どおりURLを戻す。S-02のボタンから
  // ローカルstateだけで入った場合（freeSeat）は画面遷移せず、そのstateを消すだけにする
  // （2026-09-07修正、上のmemberSeatAssignOverride参照）
  const exitMemberSeatAssignMode = () => {
    setMemberPicks({})
    setFreeSeatPicks([])
    setFreeSeatPatternPicks([])
    setPickMemberConfig(null)
    setPickRecurring(false)
    setMemberAssignResult(null)
    if (memberSeatAssignFromNav) navigate('.', { replace: true, state: null })
    else setMemberSeatAssignOverride(null)
  }

  const confirmMemberSeatAssign = async () => {
    if (!memberSeatAssignFor) return
    if (memberSeatAssignFor.freeSeat
      ? freeSeatPicks.length === 0 && freeSeatPatternPicks.length === 0
      : Object.keys(memberPicks).length === 0) return
    setSubmitting(true)
    setActionError(null)
    try {
      if (memberSeatAssignFor.freeSeat) {
        // 繰り返し予約（pickMemberConfigで「繰り返し予約にする」にチェック）: 1件の暫定割当＝1人分の
        // 期間全体（start_date〜end_date、繰り返しパターン）をそのままassignmentとして送る。単発
        // （チェックなし）: 1件のクリック＝1日分のassignmentとして送る（start_date=end_date、
        // pattern='daily'固定）。両方とも1回の確定で混在しうるため、配列として結合して送る
        const patternPicks = freeSeatPatternPicks
        const dayPicks = freeSeatPicks
        const assignments = [
          ...patternPicks.map((p) => ({
            member_user_id: p.userId,
            seat_id: p.seatId,
            start_date: p.startDate,
            end_date: p.endDate,
            pattern: { type: p.patternType, weekdays: p.patternType === 'weekly' ? p.weekdays : undefined },
          })),
          ...dayPicks.map((p) => ({
            member_user_id: p.userId,
            seat_id: p.seatId,
            start_date: p.date,
            end_date: p.date,
            pattern: { type: 'daily' as const },
          })),
        ]
        const data = await apiFetch<{ results: SeatAssignmentResult[] }>(
          `/api/project-quarter-plans/${memberSeatAssignFor.planId}/free-seat-assignments`,
          { method: 'POST', body: JSON.stringify({ assignments }) },
        )
        // assignmentsとresultsは同じ順序で1対1に対応する（project_pm.pyのbody.assignmentsループ参照）。
        // patternモードの行は特定の1日に対応しないためdateはundefined（結果表示は「－」になる）
        const dates: (string | undefined)[] = [...patternPicks.map(() => undefined), ...dayPicks.map((p) => p.date)]
        setMemberAssignResult(data.results.map((r, i) => ({ ...r, date: dates[i] })))
        setFreeSeatPicks([])
        setFreeSeatPatternPicks([])
        await refreshAll()
      } else {
        const assignments = Object.entries(memberPicks).map(([userId, pick]) => ({
          member_user_id: Number(userId), seat_id: pick.seatId,
        }))
        await apiFetch(`/api/project-quarter-plans/${memberSeatAssignFor.planId}/seat-assignments`, {
          method: 'POST',
          body: JSON.stringify({ assignments }),
        })
        setMemberPicks({})
        navigate('/project-seats', { replace: true })
      }
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '座席の確保に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  // 一括確保の結果で「除外」となった日だけを、別の座席に振り替える（2026-09-07追加。「席を取って
  // 結果で除外が出てきたとき、除外部分だけ別の席に変更できる機能が欲しい」との要望を受けた）。
  // 振替に成功した分は、元の行とは別の座席として新しい行を追加する（1人が期間の途中で座席が
  // 変わったことを分かりやすくするため。元の行のexcluded_datesは振替後の残り〔なお除外の場合〕に
  // 更新する）
  const retryMemberFreeSeat = async (memberUserId: number, dates: string[], seatNo: string) =>
    apiFetch<RetrySeatAssignmentResult>(`/api/project-quarter-plans/${memberSeatAssignFor!.planId}/free-seat-assignments/retry`, {
      method: 'POST',
      body: JSON.stringify({ member_user_id: memberUserId, seat_no: seatNo, dates }),
    })
  const applyRetryResult = (memberUserId: number, retriedDates: string[], result: RetrySeatAssignmentResult) => {
    setMemberAssignResult((prev) => {
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
          excluded_dates: result.excluded_dates, date: retriedDates[0],
        })
      }
      return next
    })
  }

  // 座席配置モード中、パネルの本当に何もない背景をクリックした場合のみ配置を開始する
  // （既存の座席タイル・部屋・柱等の上のクリックはそれぞれの本来の動作に任せる）
  const handlePanelClick = (e: MouseEvent<HTMLDivElement>, area: 'NORTH' | 'EAST' | 'WEST') => {
    if (!placeSeatMode || e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    setActionError(null)
    setNewSeatNo('')
    setNewSeatType('free')
    setPlaceSeatTarget({
      area,
      posX: ((e.clientX - rect.left) / rect.width) * 100,
      posY: ((e.clientY - rect.top) / rect.height) * 100,
    })
  }

  // 表示中の座席と同じ日に、既にフリー座席の予約を持っているか（座席の変更、2026-09-04追加。
  // 固定座席の「座席を変更する」と同じく、「一度取消が必要なのか分かりにくい」との指摘を受け、
  // 自動的に取り消して変更されることを案内した上で、実際に自動で変更できるようにした）。
  // seat_type==='project'（PM/PLが決めた座席の島の割当による確定済みプロジェクト座席）は対象から
  // 除外する（2026-09-07修正。除外していないと、プロジェクト座席を確定済みの日に別のフリー座席を
  // クリックしただけで、汎用の案内文だけで確定済みのプロジェクト座席が自動的に取り消されてしまう
  // 不具合があった。除外した場合はreplace_existing=falseのまま送信され、バックエンドの通常の
  // 重複チェックで「同じ日に複数の座席は予約できません」と拒否されるため、プロジェクト座席を
  // 手放すには一覧から明示的に取消してもらう形になる）
  const existingSameDayReservation = reserveTarget
    ? upcoming.items.find(
        (r) => r.date === reserveTarget.date && r.seat_no !== reserveTarget.seatNo && r.seat_type !== 'project'
      )
    : undefined

  // duplicateSeatErrorの表示専用（プロジェクト座席も含める、上記duplicateSeatErrorのコメント参照）。
  // 「同じ日に複数の座席は予約できません」で拒否された後、どの座席が競合しているかを示すために使う
  const anySameDayReservation = reserveTarget
    ? upcoming.items.find((r) => r.date === reserveTarget.date && r.seat_no !== reserveTarget.seatNo)
    : undefined

  // 繰り返し予約は開始日（クリックした日）自体が予約可能期間内でなければ意味がないため、
  // その場合はチェックボックス自体を選べないようにする（2026-09-07追加。「繰り返し予約は
  // そもそも予約範囲可能範囲でしか選べないようにしてほしい」との要望を受けた。終了日は既に
  // period.full_endで上限を設けていたが、開始日側は制限しておらず、範囲外の日を起点にして
  // 繰り返し予約を試みると、送信後に全日「除外」される結果になっていた）
  const recurringStartOutOfRange = Boolean(
    reserveTarget && period && (reserveTarget.date < period.full_start || reserveTarget.date > period.full_end)
  )

  const confirmReserve = async () => {
    if (!reserveTarget) return
    setSubmitting(true)
    setActionError(null)
    setDuplicateSeatError(false)
    setMultiSeatNotice(null)
    try {
      if (proxyBookingFor) {
        // S-11「代理予約モード」: 対象者の代理でA-47を呼び、完了後はS-11に戻る（4.11節）。
        // A-47は単発のみ対応のため、この分岐に周期予約は存在しない（詳細設計書3.11節）。
        await apiFetch('/api/reservations/proxy', {
          method: 'POST',
          body: JSON.stringify({ user_id: proxyBookingFor.userId, seat_id: reserveTarget.seatId, date: reserveTarget.date }),
        })
        setReserveTarget(null)
        navigate('/proxy-booking', { replace: true })
        return
      }
      if (recurring) {
        if (recurringStartOutOfRange) {
          setActionError('この日は予約可能期間外のため、繰り返し予約は設定できません')
          return
        }
        if (recurringType === 'weekly' && recurringWeekdays.size === 0) {
          setActionError('毎週の場合は曜日を1つ以上選択してください')
          return
        }
        if (!recurringEndDate || recurringEndDate < reserveTarget.date) {
          setActionError('終了日は開始日以降の日付を指定してください')
          return
        }
        if (period?.full_end && recurringEndDate > period.full_end) {
          setActionError(`終了日は予約可能期間の末日（${formatDateJa(period.full_end)}）までにしてください`)
          return
        }
        const data = await apiFetch<RecurringReservationResult>('/api/reservations/recurring', {
          method: 'POST',
          body: JSON.stringify({
            seat_id: reserveTarget.seatId,
            pattern: { type: recurringType, weekdays: recurringType === 'weekly' ? [...recurringWeekdays] : undefined },
            start_date: reserveTarget.date,
            end_date: recurringEndDate,
          }),
        })
        setRecurringResult(data)
        await refreshAll()
        return
      }
      const data = await apiFetch<{ multi_seat_warning: string | null }>('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          seat_id: reserveTarget.seatId, date: reserveTarget.date,
          replace_existing: Boolean(existingSameDayReservation),
        }),
      })
      // upcoming.mutate()（自分の予約一覧の再取得）が完了する前にモーダルを閉じると、閉じた直後に
      // 別の座席をクリックして次の予約モーダルを開いた際、existingSameDayReservation/
      // anySameDayReservationがまだ古いupcoming.itemsを参照してしまい、「現在の予約」として
      // 実際より前の（既に置き換え済みの）座席が表示されることがあった（2026-09-11修正。
      // 「B2という表示...共通点がわからないのですが検討違いの席が表示されています」との報告を受けた）。
      // refreshAll完了後にモーダルを閉じることで、次のクリック時には必ず最新のupcoming.itemsを使う
      await refreshAll()
      setReserveTarget(null)
      setMultiSeatNotice(data.multi_seat_warning)
    } catch (e) {
      const message = e instanceof ApiError ? e.message : '予約に失敗しました'
      setActionError(message)
      if (!proxyBookingFor && !recurring && message === DUPLICATE_SEAT_MESSAGE) {
        setDuplicateSeatError(true)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // 「同じ日に複数の座席は予約できません」で拒否された直後、利用者が明示的に「変更する」または
  // 「両方予約する」を押した場合のみ、それぞれreplace_existing・keep_both=trueで再送信する
  // （2026-09-08追加、2026-09-09にkeep_both〔両方保有〕を追加。「フリー座席、プロジェクト席の人も
  // 二つ席を確保できるようにしていい」とのルール改定を受けた。既定の「変更」は維持したまま、
  // 「両方保有」を明示的な選択肢として追加した）
  const confirmReserveResolveDuplicate = async (mode: 'replace' | 'keep_both') => {
    if (!reserveTarget) return
    setSubmitting(true)
    setActionError(null)
    setMultiSeatNotice(null)
    try {
      const data = await apiFetch<{ multi_seat_warning: string | null }>('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          seat_id: reserveTarget.seatId, date: reserveTarget.date,
          replace_existing: mode === 'replace', keep_both: mode === 'keep_both',
        }),
      })
      // 上のconfirmReserveと同じ理由でrefreshAll完了後にモーダルを閉じる（2026-09-11修正）
      await refreshAll()
      setReserveTarget(null)
      setDuplicateSeatError(false)
      setMultiSeatNotice(data.multi_seat_warning)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '予約に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmCancel = async () => {
    if (!cancelTarget?.seat.reservation_id) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch(`/api/reservations/${cancelTarget.seat.reservation_id}`, { method: 'DELETE' })
      // confirmReserve等と同じ理由でrefreshAll完了後にモーダルを閉じる（2026-09-11修正）
      await refreshAll()
      setCancelTarget(null)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '取消に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmAssignFixedSeat = async () => {
    if (!assignFixedSeatTarget || !assignFixedSeatFor) return
    if (!assignValidFrom) return
    if (!assignIndefinite && !assignValidUntil) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch('/api/fixed-seat-assignments', {
        method: 'POST',
        body: JSON.stringify({
          seat_id: assignFixedSeatTarget.seat.id,
          user_id: assignFixedSeatFor.userId,
          valid_from: assignValidFrom,
          valid_until: assignIndefinite ? null : assignValidUntil,
        }),
      })
      setAssignFixedSeatTarget(null)
      // 指定完了後はこの画面（S-02）に留まらず、固定座席の指定（S-05）に戻る
      navigate('/fixed-seats', { replace: true })
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '固定座席の指定に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmPlaceSeat = async () => {
    if (!placeSeatTarget) return
    const area = areas.find((a) => a.name === placeSeatTarget.area)
    if (!area) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch('/api/seats', {
        method: 'POST',
        body: JSON.stringify({
          seat_no: newSeatNo, area_id: area.id, seat_type: newSeatType,
          pos_x: placeSeatTarget.posX, pos_y: placeSeatTarget.posY,
        }),
      })
      setPlaceSeatTarget(null)
      await refreshAvailability()
      // 配置モード自体は続行し、続けて別の座席を配置できるようにする
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '座席の追加に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  // 座席配置編集モード中、既存の座席タイルをドラッグして位置を変更する（2026-09-10追加。
  // 「座席をドラッグして配置できるようにしてほしい」との要望を受けた。実際のオフィス配置を
  // 再現した固定レイアウトの座席〔A1等〕も対象に含めるため、ドロップ位置が既存の
  // FLOOR_LAYOUT_SEATSの範囲かどうかは問わず、常にpos_x/pos_y（とドロップ先のarea_id）を
  // 更新する。以後はその座標を使ってfree-placed-seatとして描画される（FloorAreas.tsx・
  // freePositionedByArea参照）。ドラッグ中の見た目はポインタ追従のゴースト表示のみとし、
  // ドラッグ元のタイル自体はAPI成功までそのまま残す（失敗時に元へ戻す処理を省くため）
  const panelRefs = useRef<Record<'NORTH' | 'EAST' | 'WEST', HTMLDivElement | null>>({ NORTH: null, EAST: null, WEST: null })
  const [draggingSeat, setDraggingSeat] = useState<{ seat: Seat; clientX: number; clientY: number } | null>(null)

  // 座席の位置を自動で整列（グリッドスナップ・近くの座席への吸着）させる機能を2026-09-10に
  // 試験的に追加したが、「絶妙にずれていて整列することができません」「その整列にできるのは
  // 却下でいいです。消してください」との指摘を受け、同日中に撤回した。ドロップした位置を
  // そのままpos_x/pos_yとして使う、素朴な実装に戻している
  const findDropPoint = (clientX: number, clientY: number) => {
    const target = (['NORTH', 'EAST', 'WEST'] as const)
      .map((areaName) => ({ areaName, el: panelRefs.current[areaName] }))
      .find(({ el }) => {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      })
    if (!target?.el) return null
    const rect = target.el.getBoundingClientRect()
    return {
      areaName: target.areaName,
      posX: ((clientX - rect.left) / rect.width) * 100,
      posY: ((clientY - rect.top) / rect.height) * 100,
    }
  }

  const onSeatDragPointerDown = (seat: Seat, e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraggingSeat({ seat, clientX: e.clientX, clientY: e.clientY })
  }
  const onSeatDragPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingSeat) return
    setDraggingSeat({ ...draggingSeat, clientX: e.clientX, clientY: e.clientY })
  }
  const onSeatDragPointerUp = async (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingSeat) return
    const seat = draggingSeat.seat
    setDraggingSeat(null)
    const dropPoint = findDropPoint(e.clientX, e.clientY)
    if (!dropPoint) return
    const area = areas.find((a) => a.name === dropPoint.areaName)
    if (!area) return
    try {
      await apiFetch(`/api/seats/${seat.id}/position`, {
        method: 'PATCH',
        body: JSON.stringify({ area_id: area.id, pos_x: dropPoint.posX, pos_y: dropPoint.posY }),
      })
      await refreshAvailability()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : '座席の位置の変更に失敗しました')
    }
  }

  const confirmListCancel = async () => {
    if (!listCancelTarget) return
    setListCancelSubmitting(true)
    setListCancelError(null)
    try {
      await apiFetch(`/api/reservations/${listCancelTarget.id}`, { method: 'DELETE' })
      setListCancelTarget(null)
      await refreshAll()
    } catch (e) {
      setListCancelError(e instanceof ApiError ? e.message : '取消に失敗しました')
    } finally {
      setListCancelSubmitting(false)
    }
  }

  // 「変更」: 専用の変更APIは持たず、対象の予約日・エリアのフロアマップへ移動して
  // 取消・別座席の予約をその場で行えるようにする（基本設計書2.2節S-02「変更（フロアマップへの
  // アンカーリンク）」）。周期予約の1日分でも、A-11による取消はその日だけを取り消す挙動になるため
  // 同じ導線で扱える。
  const changeFromList = (r: MyReservation) => {
    setViewMode('floormap')
    setAreaFilter(r.area.toLowerCase() as AreaFilter)
    setDate(r.date)
    topRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const seatByNo: Record<string, Seat> = {}
  const seatArea: Record<string, string> = {}
  availability?.areas.forEach((a) => {
    a.blocks.forEach((b) => {
      b.seats.forEach((s) => {
        seatByNo[s.seat_no] = s
        seatArea[s.seat_no] = a.area
      })
    })
  })
  // 座席の島の一括割当モード: 今選んでいるプロジェクトと出社曜日が重なる他プロジェクトが、この
  // 一括登録の中で既に選択中の座席は、使用中（他プロジェクトが選択中）としてタイルに表示し選べない
  // ようにする（2026-09-10追加、2026-09-11修正）。出社曜日が重ならないプロジェクト同士は同じ座席を
  // 共有できるのが本来の設計（database.project_blocked_seats()参照）のため、曜日が重ならない場合は
  // 対象から除外する（「火水出社のプロジェクトを選んだら、木金出社の別プロジェクトの選択中表示が
  // 出てきてしまう」との報告を受けた不具合修正）
  if (seatBlockBulkFor && activeBulkPlan) {
    const activeWeekdays = new Set(activeBulkPlan.weekdaysFinalized ?? [])
    const seatIdToNo = new Map(Object.values(seatByNo).map((s) => [s.id, s.seat_no]))
    Object.entries(bulkSelections).forEach(([planIdStr, ids]) => {
      const planId = Number(planIdStr)
      if (planId === activeBulkPlanId) return
      const claimingPlan = seatBlockBulkFor.plans.find((p) => p.planId === planId)
      const claimingWeekdays = claimingPlan?.weekdaysFinalized ?? []
      const overlaps = claimingWeekdays.some((w) => activeWeekdays.has(w))
      if (!overlaps) return
      ids.forEach((seatId) => {
        const seatNo = seatIdToNo.get(seatId)
        const seat = seatNo ? seatByNo[seatNo] : undefined
        if (seatNo && seat) {
          seatByNo[seatNo] = { ...seat, status: 'occupied', display_name: claimingPlan ? `${claimingPlan.projectName}（選択中）` : null }
        }
      })
    })
  }
  // メンバーへの座席確保モード: 座席の島の範囲内かつ未確定（status='project_pending'）の座席のみ選択可
  // （2026-08-31追加）。暫定割当済みの座席は、割り当てたメンバーの氏名をタイルにプレビュー表示する。
  // freeSeatモード（2026-09-04追加）は座席の島に限らず、表示中の日に空いているフリー座席（status='free'）
  // から選べる
  const memberAssignEligibleIds = new Set(
    Object.values(seatByNo)
      .filter((s) => memberSeatAssignFor?.freeSeat
        ? s.status === 'free'
        : memberSeatAssignFor?.allocatedSeatIds.includes(s.id) && s.status === 'project_pending')
      .map((s) => s.id),
  )
  // 座席タイルへのプレビュー表示（誰が割り当て済みか）。freeSeatは今表示中の日付（date）に
  // 実際にかかっている暫定割当だけをタイルに反映する（単発は日付が一致するもの、繰り返しは
  // 期間・曜日パターンが今表示中の日付を含むもの。2026-09-10修正、繰り返し分も表示するようにした）
  const memberAssignPickedLabels: Record<number, string> = {}
  if (memberSeatAssignFor?.freeSeat) {
    freeSeatPatternPicks.filter((p) => patternPickCoversDate(p, date)).forEach((p) => { memberAssignPickedLabels[p.seatId] = p.userName })
    freeSeatPicks.filter((p) => p.date === date).forEach((p) => { memberAssignPickedLabels[p.seatId] = p.userName })
  } else {
    Object.entries(memberPicks).forEach(([userId, pick]) => {
      const member = memberSeatAssignFor?.members.find((m) => m.userId === Number(userId))
      if (member) memberAssignPickedLabels[pick.seatId] = member.name
    })
  }

  const floorProps = {
    seatByNo,
    onReserve: (seat: Seat) => openReserve(seat.id, seat.seat_no, seatArea[seat.seat_no], date),
    onCancel: (seat: Seat) => openCancel(seat, seatArea[seat.seat_no]),
    fixedSeatAssignMode: Boolean(assignFixedSeatFor),
    onAssignFixedSeat: (seat: Seat) => openAssignFixedSeat(seat, seatArea[seat.seat_no]),
    selectedSeatIds: (seatBlockFor || seatBlockBulkFor) ? currentBlockSelection : undefined,
    onToggleBlock: (seatBlockFor || seatBlockBulkFor) ? onToggleSeatBlock : undefined,
    memberAssignMode: Boolean(memberSeatAssignFor),
    memberAssignEligibleIds: memberSeatAssignFor ? memberAssignEligibleIds : undefined,
    memberAssignPickedLabels: memberSeatAssignFor ? memberAssignPickedLabels : undefined,
    onMemberAssignClick,
    positionEditMode: placeSeatMode,
    onSeatDragPointerDown,
    onSeatDragPointerMove,
    onSeatDragPointerUp,
  }

  const areaNames = new Set(availability?.areas.map((a) => a.area))
  const hasNorth = areaNames.has('NORTH')
  const hasEast = areaNames.has('EAST')
  const hasWest = areaNames.has('WEST')
  const hasAnyArea = hasNorth || hasEast || hasWest
  const { viewportRef, overviewRef } = useFloorZoom(areaFilter, hasAnyArea)
  const isMobile = useIsMobile()
  // 期間ビューの「曜日」「予約数」列はスマホ幅では非表示にする（2026-09-03追加。「スマホ版限定で
  // 期間ビューが見づらいので予約数と曜日の表示をなくしてほしい」との要望を受けた）。非表示にした分、
  // 後続の「空席」列（sticky）のleftオフセットも詰める
  // 日付列自体もスマホ幅では年を省略して「09/11」のみ表示し、列幅を狭める（2026-09-11追加）
  const periodDateColW = isMobile ? PERIOD_COL_DATE_W_MOBILE : PERIOD_COL_DATE_W
  const periodVacantLeftOffset = isMobile ? periodDateColW : periodDateColW + PERIOD_COL_WD_W + PERIOD_COL_RES_W

  // S-07から追加した座席のうち、フロアマップの固定レイアウト（実際の配置図）に含まれないものは
  // 通常のフロアマップの図には現れない。座席配置モード（pos_x/pos_yあり）で配置済みのものは
  // パネル上に直接重ねて表示し、それ以外（座標未設定）は「追加座席」として下に別枠一覧表示する。
  // 固定レイアウト所属の座席（A1等）であっても、ドラッグでpos_x/pos_yを持つに至ったものは
  // 同じ自由配置オーバーレイ側で描画する（2026-09-10追加。「座席をドラッグして配置できるように
  // してほしい」との要望を受け、既存83席も対象に含めた。FloorAreas.tsx側は該当座席をこの条件と
  // 対になる形で描画しないよう修正済み）
  const extraSeatGroups = new Map<string, Seat[]>()
  const freePositionedByArea: Record<'NORTH' | 'EAST' | 'WEST', Seat[]> = { NORTH: [], EAST: [], WEST: [] }
  Object.keys(seatByNo).forEach((no) => {
    const area = seatArea[no] as 'NORTH' | 'EAST' | 'WEST' | undefined
    if (!area) return
    const seat = seatByNo[no]
    if (seat.pos_x !== null && seat.pos_y !== null) {
      freePositionedByArea[area].push(seat)
      return
    }
    if (FLOOR_LAYOUT_SEATS[area].has(no)) return
    const label = `${area} ${blockLabelOf(no)}`
    if (!extraSeatGroups.has(label)) extraSeatGroups.set(label, [])
    extraSeatGroups.get(label)!.push(seat)
  })
  extraSeatGroups.forEach((seats) => seats.sort((a, b) => compareSeatNo(a.seat_no, b.seat_no)))

  const renderFreePositionedSeats = (area: 'NORTH' | 'EAST' | 'WEST') =>
    freePositionedByArea[area].map((seat) => (
      <div key={seat.id} className="free-placed-seat" style={{ left: `${seat.pos_x}%`, top: `${seat.pos_y}%` }}>
        <SeatTile
          seat={seat}
          onReserve={floorProps.onReserve}
          onCancel={floorProps.onCancel}
          fixedSeatAssignMode={floorProps.fixedSeatAssignMode}
          onAssignFixedSeat={floorProps.onAssignFixedSeat}
          selectedSeatIds={floorProps.selectedSeatIds}
          memberAssignMode={floorProps.memberAssignMode}
          memberAssignEligibleIds={floorProps.memberAssignEligibleIds}
          memberAssignPickedLabels={floorProps.memberAssignPickedLabels}
          onMemberAssignClick={floorProps.onMemberAssignClick}
          positionEditMode={floorProps.positionEditMode}
          onSeatDragPointerDown={floorProps.onSeatDragPointerDown}
          onSeatDragPointerMove={floorProps.onSeatDragPointerMove}
          onSeatDragPointerUp={floorProps.onSeatDragPointerUp}
        />
      </div>
    ))

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">空き状況・予約</h1>
      </header>

      {multiSeatNotice && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-8 py-2.5 text-sm text-red-800">
          <span>⚠ {multiSeatNotice}</span>
          <button type="button" onClick={() => setMultiSeatNotice(null)} className="shrink-0 text-red-700 underline hover:text-red-900">
            閉じる
          </button>
        </div>
      )}

      {assignFixedSeatFor && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-8 py-2.5 text-sm text-blue-900">
          <span>
            <strong>{assignFixedSeatFor.userName}</strong>さんの固定座席を指定中です。フロアマップで枠の付いた座席をクリックしてください。
          </span>
          <button type="button" onClick={exitAssignFixedSeatMode} className="shrink-0 text-blue-700 underline hover:text-blue-900">
            キャンセル
          </button>
        </div>
      )}

      {placeSeatMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-8 py-2.5 text-sm text-blue-900">
          <span>座席表の配置を編集中です。空いている位置をクリックすると新しい座席を追加、既存の座席はドラッグすると位置を変更できます。</span>
          <button type="button" onClick={exitPlaceSeatMode} className="shrink-0 text-blue-700 underline hover:text-blue-900">
            完了・キャンセル
          </button>
        </div>
      )}

      {draggingSeat && (
        <div
          className="seat-tile status-free"
          style={{
            position: 'fixed', left: draggingSeat.clientX, top: draggingSeat.clientY,
            transform: 'translate(-50%, -50%)', pointerEvents: 'none', opacity: 0.85, zIndex: 50,
          }}
        >
          {draggingSeat.seat.seat_no}
        </div>
      )}

      {proxyBookingFor && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-8 py-2.5 text-sm text-blue-900">
          <span>
            <strong>{proxyBookingFor.userName}</strong>さんの代理予約中です。フロアマップまたは期間ビューで空いている座席をクリックしてください。
          </span>
          <button type="button" onClick={exitProxyBookingMode} className="shrink-0 text-blue-700 underline hover:text-blue-900">
            キャンセル
          </button>
        </div>
      )}

      {memberSeatAssignFor && memberAssignResult && (
        <div className="border-b border-blue-200 bg-blue-50 px-8 py-3 text-sm text-blue-900">
          <div className="mb-2 flex items-center justify-between">
            <strong>{memberSeatAssignFor.projectName}への座席確保結果</strong>
            <button type="button" onClick={exitMemberSeatAssignMode} className="rounded bg-blue-800 px-3 py-1 text-white hover:bg-blue-900">
              閉じる
            </button>
          </div>
          <table className="w-full max-w-2xl text-sm">
            <thead>
              <tr className="border-b border-blue-200 text-left text-blue-700">
                <th className="pb-1 pr-3">氏名</th>
                <th className="pb-1 pr-3">日付</th>
                <th className="pb-1 pr-3">座席</th>
                <th className="pb-1">結果</th>
              </tr>
            </thead>
            <tbody>
              {memberAssignResult.map((r, i) => {
                const member = memberSeatAssignFor.members.find((m) => m.userId === r.member_user_id)
                return (
                  <Fragment key={i}>
                    <tr className="border-b border-blue-100">
                      <td className="py-1 pr-3">{member?.name ?? r.member_user_id}</td>
                      <td className="py-1 pr-3">{r.date ? formatDateJa(r.date) : '－'}</td>
                      <td className="py-1 pr-3">{r.seat_no}</td>
                      <td className="py-1">
                        {r.status === 'assigned' ? (
                          <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700">
                            {r.created_days}日確保{r.excluded_days ? `（${r.excluded_days}日を除外）` : ''}
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">除外（{r.reason}）</span>
                        )}
                      </td>
                    </tr>
                    {r.excluded_dates && r.excluded_dates.length > 0 && (
                      <tr className="border-b border-blue-100">
                        <td className="py-1 pr-3"></td>
                        <td colSpan={3} className="py-1">
                          <ExcludedDatesRetry
                            excludedDates={r.excluded_dates}
                            onRetry={(dates, seatNo) => retryMemberFreeSeat(r.member_user_id, dates, seatNo)}
                            onRetried={(result) => applyRetryResult(r.member_user_id, r.excluded_dates!.map((d) => d.date), result)}
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
      {memberSeatAssignFor && !memberAssignResult && (
        <div className="border-b border-blue-200 bg-blue-50 px-8 py-2.5 text-sm text-blue-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <strong>{memberSeatAssignFor.projectName}</strong>のメンバーへの座席を確保中です。
              {memberSeatAssignFor.freeSeat
                ? '上の日付を切り替えながら、空いているフリー座席をクリックして割り当てる相手を選んでください。相手を選んだあと「繰り返し予約にする」にチェックを入れると、曜日パターンで期間全体をまとめて確保できます（チェックを入れなければ、その1日だけの確保になります）。'
                : '座席の島の中から空いている座席をクリックし、割り当てる相手を選んでください。'}
              選択中: {memberSeatAssignFor.freeSeat
                ? freeSeatPatternPicks.length + freeSeatPicks.length
                : Object.keys(memberPicks).length}
              {memberSeatAssignFor.freeSeat ? '件' : `/${memberSeatAssignFor.members.length}名`}
            </span>
            <span className="flex shrink-0 gap-3">
              <button
                type="button"
                disabled={submitting || (memberSeatAssignFor.freeSeat
                  ? freeSeatPatternPicks.length === 0 && freeSeatPicks.length === 0
                  : Object.keys(memberPicks).length === 0)}
                onClick={confirmMemberSeatAssign}
                className="rounded bg-blue-800 px-3 py-1 text-white hover:bg-blue-900 disabled:opacity-50"
              >
                この内容で確保する
              </button>
              <button type="button" onClick={exitMemberSeatAssignMode} className="text-blue-700 underline hover:text-blue-900">
                キャンセル
              </button>
            </span>
          </div>
          {memberSeatAssignFor.freeSeat && freeSeatPatternPicks.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {freeSeatPatternPicks.map((p, i) => (
                <li key={i} className="flex items-center gap-1.5 rounded border border-blue-200 bg-white px-2 py-1 text-xs">
                  {p.userName}・{p.seatNo}・{formatDateJa(p.startDate)}〜{formatDateJa(p.endDate)}
                  （{p.patternType === 'weekly'
                    ? (p.weekdays ?? []).map((w) => RECURRING_WEEKDAYS.find((r) => r.key === w)?.label ?? w).join('')
                    : '毎日'}）
                  <button
                    type="button"
                    onClick={() => setFreeSeatPatternPicks((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="この割当を取り消す"
                    className="text-red-600 hover:text-red-800"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {memberSeatAssignFor.freeSeat && freeSeatPicks.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {freeSeatPicks.map((p, i) => (
                <li key={i} className="flex items-center gap-1.5 rounded border border-blue-200 bg-white px-2 py-1 text-xs">
                  {p.userName}・{formatDateJa(p.date)}・{p.seatNo}
                  <button
                    type="button"
                    onClick={() => setFreeSeatPicks((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="この割当を取り消す"
                    className="text-red-600 hover:text-red-800"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {memberSeatAssignFor && actionError && (
        <p className="border-b border-red-200 bg-red-50 px-8 py-2 text-sm text-red-700">{actionError}</p>
      )}

      <div className={(seatBlockFor || seatBlockBulkFor) ? 'lg:flex lg:items-start' : ''}>
      <div className="min-w-0 flex-1 p-6" ref={topRef}>

      <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {viewMode === 'floormap' && (
          <>
            <div className="flex items-center justify-between gap-1 sm:justify-start">
              <button
                type="button"
                onClick={() => setDate((d) => shiftDateStr(d, -1))}
                aria-label="前日"
                disabled={Boolean(availability?.history_min_date) && date <= availability!.history_min_date}
                className="h-8 w-8 shrink-0 rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
              >
                ‹
              </button>
              <input
                type="date"
                value={date}
                min={availability?.history_min_date}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded border border-slate-300 px-2 text-sm sm:flex-none"
              />
              <button
                type="button"
                onClick={() => setDate((d) => shiftDateStr(d, 1))}
                aria-label="翌日"
                className="h-8 w-8 shrink-0 rounded border border-slate-300 hover:bg-slate-50"
              >
                ›
              </button>
              <button
                type="button"
                onClick={() => setDate(todayStr())}
                className="h-8 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-50"
              >
                今日
              </button>
            </div>
            <span className="text-sm text-slate-500">{formatDateJa(date)}</span>
            {!assignFixedSeatFor && !proxyBookingFor && !seatBlockFor && !seatBlockBulkFor && !memberSeatAssignFor && !placeSeatMode && (
              <FreeSeatProxyBookingButton
                onStart={(payload) => {
                  setActionError(null)
                  setMemberPicks({})
                  setFreeSeatPicks([])
                  setMemberAssignResult(null)
                  setMemberSeatAssignOverride(payload)
                }}
              />
            )}
          </>
        )}
        <div className="flex gap-1 sm:ml-auto">
          <button
            type="button"
            onClick={() => setViewMode('floormap')}
            className={`rounded-full px-3 py-1 text-sm ${viewMode === 'floormap' ? 'bg-blue-800 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'}`}
          >
            フロアマップ表示
          </button>
          <button
            type="button"
            onClick={() => setViewMode('period')}
            className={`rounded-full px-3 py-1 text-sm ${viewMode === 'period' ? 'bg-blue-800 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'}`}
          >
            期間ビュー
          </button>
        </div>
      </div>

      <div className="scrollbar-hide mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {AREA_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setAreaFilter(t.key)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
              areaFilter === t.key
                ? 'border-blue-800 font-semibold text-blue-800'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {viewMode === 'floormap' && (
      <>
      {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

      {hasAnyArea && (
        <div ref={viewportRef} className="floor-zoom-viewport mb-6 overflow-auto pb-2">
          <div ref={overviewRef} className="floor-overview inline-flex">
            {hasNorth && (
              <div className="north-column">
                {areaFilter === 'all' && (
                  <div className="north-side-rooms">
                    <div className="floor-room" style={{ flex: 1 }}>会議室D</div>
                    <div className="floor-room" style={{ flex: 2 }}>ワークラウンジ</div>
                  </div>
                )}
                <div
                  ref={(el) => { panelRefs.current.NORTH = el }}
                  className={`panel-north ${placeSeatMode ? 'placement-mode-active' : ''}`}
                  onClick={(e) => handlePanelClick(e, 'NORTH')}
                >
                  <h2 className="area-heading area-north mb-3">NORTHエリア</h2>
                  <NorthFloor {...floorProps} />
                  {renderFreePositionedSeats('NORTH')}
                </div>
              </div>
            )}
            {(hasEast || hasWest) && (
              <div className="floor-overview-stack">
                {hasEast && (
                  <div
                    ref={(el) => { panelRefs.current.EAST = el }}
                    className={`panel-east ${placeSeatMode ? 'placement-mode-active' : ''}`}
                    onClick={(e) => handlePanelClick(e, 'EAST')}
                  >
                    <h2 className="area-heading area-east mb-3">EASTエリア</h2>
                    <EastFloor {...floorProps} />
                    {renderFreePositionedSeats('EAST')}
                  </div>
                )}
                {hasWest && (
                  <div
                    ref={(el) => { panelRefs.current.WEST = el }}
                    className={`panel-west ${placeSeatMode ? 'placement-mode-active' : ''}`}
                    onClick={(e) => handlePanelClick(e, 'WEST')}
                  >
                    <h2 className="area-heading area-west mb-3">WESTエリア</h2>
                    <WestFloor {...floorProps} />
                    {renderFreePositionedSeats('WEST')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {extraSeatGroups.size > 0 && (
        <div className="mb-6 rounded border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="font-semibold">追加座席</h3>
            <span className="text-xs text-slate-400">
              座席マスタ管理で追加された座席（配置図には未反映）
              {placeSeatMode && '。ドラッグして配置図に配置できます'}
            </span>
          </div>
          <div className="flex flex-wrap gap-4">
            {[...extraSeatGroups.entries()].map(([label, seats]) => (
              <div key={label}>
                <div className="mb-1 text-xs font-semibold text-slate-500">{label}</div>
                <div className="flex flex-wrap gap-2">
                  {seats.map((seat) => (
                    <SeatTile
                      key={seat.id}
                      seat={seat}
                      onReserve={floorProps.onReserve}
                      onCancel={floorProps.onCancel}
                      fixedSeatAssignMode={floorProps.fixedSeatAssignMode}
                      onAssignFixedSeat={floorProps.onAssignFixedSeat}
                      positionEditMode={floorProps.positionEditMode}
                      onSeatDragPointerDown={floorProps.onSeatDragPointerDown}
                      onSeatDragPointerMove={floorProps.onSeatDragPointerMove}
                      onSeatDragPointerUp={floorProps.onSeatDragPointerUp}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="seat-legend mb-8 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
        {LEGEND.map((l) => (
          <span key={l.status} className="legend-item flex items-center gap-1.5">
            <span className={`legend-swatch inline-block h-3.5 w-3.5 rounded-sm ${STATUS_CSS_CLASS[l.status]}`} />
            {l.label}
          </span>
        ))}
        <span className="legend-item flex items-center gap-1.5">
          <span className="legend-swatch inline-block h-3.5 w-3.5 rounded-sm seat-multi-holder" />
          複数の座席を保有中（要確認）
        </span>
      </div>
      </>
      )}

      {viewMode === 'period' && (
        <div className="mb-8">
          <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <span className="shrink-0 text-sm font-medium text-slate-600">表示期間</span>
            <input
              type="date"
              value={periodStart}
              disabled={!period}
              onChange={(e) => setPeriodOverride({ start: e.target.value, end: periodEnd })}
              className="h-8 rounded border border-slate-300 px-2 text-sm"
            />
            <span className="text-center text-sm text-slate-500 sm:text-left">〜</span>
            <input
              type="date"
              value={periodEnd}
              disabled={!period}
              onChange={(e) => setPeriodOverride({ start: periodStart, end: e.target.value })}
              className="h-8 rounded border border-slate-300 px-2 text-sm"
            />
            <button
              type="button"
              onClick={resetPeriodFilter}
              className="h-8 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-50 sm:ml-2"
            >
              予約可能期間全体を表示
            </button>
          </div>
          {/* 表示期間はRULE-05（予約可能期間）に縛られず自由に指定できる（2026-09-10、
              「見れる範囲をもっと伸ばしてほしい」との要望を受けた。閲覧は予約可否とは別の話のため、
              過去・未来とも自由に指定できるようにした。バックエンドは366日を超える範囲を400で拒否する） */}
          {periodError && (
            <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{periodError}</p>
          )}

          {periodLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

          {period && (
            <div className="overflow-x-auto rounded border border-slate-300 bg-white">
              <table className="text-sm">
                <thead>
                  {/* 期間ビューを「箱の中でスクロール」から「ページ全体のスクロール」に変更した
                      （2026-09-10、「全期間見れるようにしてほしい」との要望を受けた。従来は
                      max-h-[70vh]の箱の中に全期間を収めていたため、パッと見では今月あたりまでしか
                      見えず「1ヶ月しか見れない」と誤解されやすかった）。横スクロール用の
                      overflow-x-autoを維持したまま縦方向もsticky top-0で追従させることはCSSの
                      仕様上できない（overflow-xを visible 以外にすると overflow-y も自動的に
                      auto 扱いになり、この要素自身が縦のスクロールコンテナになってページ全体の
                      スクロールを追従できなくなる）ため、ヘッダーの縦方向のstickyは諦め、
                      左端の列（日付・曜日・予約数・空席）の横方向のstickyのみ残した */}
                  <tr className="text-left text-slate-500">
                    <th
                      className="sticky left-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-3 py-2"
                      style={{ minWidth: periodDateColW }}
                    >
                      日付
                    </th>
                    {!isMobile && (
                      <th
                        className="sticky z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 py-2 text-center"
                        style={{ left: periodDateColW, minWidth: PERIOD_COL_WD_W }}
                      >
                        曜日
                      </th>
                    )}
                    {!isMobile && (
                      <th
                        className="sticky z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 py-2 text-center"
                        style={{ left: periodDateColW + PERIOD_COL_WD_W, minWidth: PERIOD_COL_RES_W }}
                      >
                        予約数
                      </th>
                    )}
                    <th
                      className="sticky z-30 whitespace-nowrap border-r border-b border-slate-300 bg-slate-100 px-2 py-2 text-center"
                      style={{ left: periodVacantLeftOffset, minWidth: PERIOD_COL_VAC_W }}
                    >
                      空席
                    </th>
                    {period.seats.map((seat) => (
                      <th
                        key={seat.id}
                        className="min-w-[64px] whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-1 py-2 text-center text-xs font-normal"
                      >
                        <div className="font-semibold text-slate-700">{seat.seat_no}</div>
                        <div className="text-slate-400">{SEAT_TYPE_JA[seat.seat_type]}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {period.dates.map((d) => {
                    const reserved = period.seats.filter((s) => (s.days[d]?.status ?? 'free') !== 'free').length
                    const vacant = period.seats.length - reserved
                    const { wd } = formatDateShort(d)
                    return (
                      <tr key={d} className="border-b border-slate-300">
                        <td
                          className="sticky left-0 z-10 whitespace-nowrap border-r border-slate-300 bg-white px-3 py-1.5 font-semibold"
                        >
                          {isMobile ? d.slice(5).replaceAll('-', '/') : d.replaceAll('-', '/')}
                        </td>
                        {!isMobile && (
                          <td
                            className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-500"
                            style={{ left: periodDateColW }}
                          >
                            {wd}
                          </td>
                        )}
                        {!isMobile && (
                          <td
                            className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-600"
                            style={{ left: periodDateColW + PERIOD_COL_WD_W }}
                          >
                            {reserved}
                          </td>
                        )}
                        <td
                          className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-600"
                          style={{ left: periodVacantLeftOffset }}
                        >
                          {vacant}
                        </td>
                        {period.seats.map((seat) => {
                          const cell = seat.days[d]
                          const status = cell?.status ?? 'free'
                          // 2026-09-16修正: 固定席・プロジェクト席は未使用中の日でも「空き」ボタンが
                          // 出てしまい、押しても必ずエラーになっていた（フロアマップ表示は
                          // seat.seat_type==='free'も見て正しくフィルタしているのに、期間ビューは
                          // statusしか見ていなかった）。座席タイプもフリーの場合のみボタンにする
                          const bookable = status === 'free' && seat.seat_type === 'free'
                          return (
                            <td key={seat.id} className="border-r border-slate-200 px-1 py-1.5 text-center">
                              {bookable ? (
                                <button
                                  type="button"
                                  onClick={() => openReserve(seat.id, seat.seat_no, seat.area, d)}
                                  className="whitespace-nowrap rounded border border-dashed border-slate-400 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
                                >
                                  空き
                                </button>
                              ) : (
                                <span
                                  className={`whitespace-nowrap text-[11px] ${
                                    status === 'mine' ? 'font-semibold text-blue-800' : status === 'occupied_fixed' ? 'text-violet-700' : 'text-slate-600'
                                  }`}
                                >
                                  {cell?.display_name ?? (status === 'free' ? '－' : '')}
                                </span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3 font-semibold">自分の予約</div>
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 px-4 pt-2">
          <button
            type="button"
            onClick={() => setReservationTab('upcoming')}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${reservationTab === 'upcoming' ? 'border-blue-800 font-semibold text-blue-800' : 'border-transparent text-slate-500'}`}
          >
            今後の予約 <span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs">{upcoming.items.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setReservationTab('past')}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${reservationTab === 'past' ? 'border-blue-800 font-semibold text-blue-800' : 'border-transparent text-slate-500'}`}
          >
            過去の予約
          </button>
        </div>
        <div className="overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="pb-2 pr-3">予約日</th>
                <th className="pb-2 pr-3">座席</th>
                <th className="pb-2 pr-3">エリア</th>
                <th className="pb-2 pr-3">種別</th>
                <th className="pb-2 pr-3">登録者</th>
                <th className="pb-2">{reservationTab === 'upcoming' ? '操作' : '状態'}</th>
              </tr>
            </thead>
            <tbody>
              {(reservationTab === 'upcoming' ? upcoming.items : past.items).map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3">{formatDateJa(r.date)}</td>
                  <td className="py-2 pr-3">{r.seat_no}</td>
                  <td className="py-2 pr-3">{r.area}</td>
                  <td className="py-2 pr-3">
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                      {SEAT_TYPE_JA[r.seat_type]}座席
                    </span>
                  </td>
                  <td className="py-2 pr-3">{r.registrant}</td>
                  <td className="py-2">
                    {reservationTab === 'upcoming' ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => changeFromList(r)}
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          変更
                        </button>
                        <button
                          type="button"
                          onClick={() => { setListCancelError(null); setListCancelTarget(r) }}
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <span className={`rounded px-2 py-0.5 text-xs ${r.state === 'cancelled' ? 'bg-slate-100 text-slate-500' : 'bg-green-50 text-green-700'}`}>
                        {r.state === 'cancelled' ? '取消済み' : '利用済み'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {(reservationTab === 'upcoming' ? upcoming.items : past.items).length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-slate-400">予約はありません</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      </div>

      {seatBlockFor && (
        <aside className="shrink-0 border-t border-slate-200 bg-white p-6 lg:sticky lg:top-0 lg:h-screen lg:w-80 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <h2 className="text-sm font-semibold text-slate-800">
            座席の島の{seatBlockFor.allocatedSeatIds ? '編集' : '割当'}
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">プロジェクト</dt>
              <dd className="text-right font-medium">{seatBlockFor.projectName}</dd>
            </div>
            <div className="flex justify-between"><dt className="text-slate-500">必要座席数</dt><dd>{seatBlockFor.requiredSeats}名</dd></div>
            <div className="flex justify-between">
              <dt className="text-slate-500">選択中</dt>
              <dd className={`font-semibold ${seatBlockSelection.size >= seatBlockFor.requiredSeats ? 'text-green-700' : 'text-amber-700'}`}>
                {seatBlockSelection.size}席
              </dd>
            </div>
          </dl>
          {blockConflicts.length > 0 && (
            <div className="mt-3 space-y-1 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {blockConflicts.map((c, i) => (<p key={i}>⚠ {c}</p>))}
            </div>
          )}
          {actionError && (
            <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{actionError}</p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              disabled={submitting || seatBlockSelection.size === 0}
              onClick={confirmSeatBlock}
              className="rounded bg-blue-800 px-3 py-2 text-sm text-white hover:bg-blue-900 disabled:opacity-50"
            >
              {seatBlockFor.allocatedSeatIds ? 'この内容で更新する' : 'この内容で割り当てる'}
            </button>
            <button
              type="button"
              onClick={exitSeatBlockMode}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              キャンセル
            </button>
          </div>
        </aside>
      )}

      {seatBlockBulkFor && (
        <aside className="shrink-0 border-t border-slate-200 bg-white p-6 lg:sticky lg:top-0 lg:h-screen lg:w-80 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <h2 className="text-sm font-semibold text-slate-800">座席の島の一括割当</h2>
          <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
            {seatBlockBulkFor.plans.map((p) => {
              const count = bulkSelections[p.planId]?.size ?? 0
              const active = p.planId === activeBulkPlanId
              return (
                <li key={p.planId}>
                  <button
                    type="button"
                    onClick={() => pickBulkProject(p.planId)}
                    className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs ${
                      active ? 'border-blue-400 bg-blue-50 font-semibold text-blue-800' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <span className="truncate">{p.projectName}</span>
                    <span className={`shrink-0 ${count > 0 ? 'text-green-700' : 'text-slate-400'}`}>{count}/{p.requiredSeats}名</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {activeBulkPlan && (
            <dl className="mt-4 space-y-2 border-t border-slate-200 pt-3 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">プロジェクト</dt>
                <dd className="text-right font-medium">{activeBulkPlan.projectName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">曜日</dt>
                <dd>{(activeBulkPlan.weekdaysFinalized ?? []).map((w) => RECURRING_WEEKDAYS.find((r) => r.key === w)?.label ?? w).join('') || '未定'}</dd>
              </div>
              <div className="flex justify-between"><dt className="text-slate-500">必要座席数</dt><dd>{activeBulkPlan.requiredSeats}名</dd></div>
              {activeBulkPlan.note && (
                <div>
                  <dt className="text-slate-500">備考</dt>
                  <dd className="mt-0.5 text-slate-700">{activeBulkPlan.note}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-slate-500">選択中</dt>
                <dd className={`font-semibold ${currentBlockSelection.size >= activeBulkPlan.requiredSeats ? 'text-green-700' : 'text-amber-700'}`}>
                  {currentBlockSelection.size}席
                </dd>
              </div>
            </dl>
          )}
          {blockConflicts.length > 0 && (
            <div className="mt-3 space-y-1 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {blockConflicts.map((c, i) => (<p key={i}>⚠ {c}</p>))}
            </div>
          )}
          {actionError && (
            <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{actionError}</p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              disabled={submitting || Object.values(bulkSelections).every((s) => s.size === 0)}
              onClick={confirmSeatBlockBulk}
              className="rounded bg-blue-800 px-3 py-2 text-sm text-white hover:bg-blue-900 disabled:opacity-50"
            >
              この内容でまとめて登録する
            </button>
            <button
              type="button"
              onClick={exitSeatBlockBulkMode}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              キャンセル
            </button>
          </div>
        </aside>
      )}
      </div>

      {reserveTarget && (
        <Modal
          title={proxyBookingFor ? '座席の代理予約' : recurring ? '繰り返し予約' : '座席の予約'}
          onClose={() => setReserveTarget(null)}
          footer={
            recurringResult ? (
              <button type="button" onClick={() => setReserveTarget(null)} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white">閉じる</button>
            ) : (
              <>
                <button type="button" onClick={() => setReserveTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
                {!proxyBookingFor && !recurring && existingSameDayReservation && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => confirmReserveResolveDuplicate('keep_both')}
                    className="rounded border border-amber-300 bg-amber-50 px-4 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    複数座席 予約
                  </button>
                )}
                <button type="button" disabled={submitting} onClick={confirmReserve} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
                  {recurring
                    ? 'この内容で登録する'
                    : !proxyBookingFor && existingSameDayReservation
                      ? '変更する'
                      : '予約する'}
                </button>
              </>
            )
          }
        >
          {recurringResult ? (
            <div>
              <p className="mb-2 text-sm text-slate-600">{recurringResult.seat_no} への繰り返し予約の登録結果</p>
              {recurringResult.multi_seat_warning && (
                <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {recurringResult.multi_seat_warning}
                </p>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="pb-1 pr-3">日付</th>
                    <th className="pb-1">結果</th>
                  </tr>
                </thead>
                <tbody>
                  {recurringResult.results.map((r) => (
                    <tr key={r.date} className="border-b border-slate-100">
                      <td className="py-1 pr-3">{formatDateJa(r.date)}</td>
                      <td className="py-1">
                        {r.status === 'created' ? (
                          <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700">登録済み</span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">除外（{r.reason}）</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <dl className="space-y-1.5 text-sm">
                {proxyBookingFor && (
                  <div className="flex justify-between"><dt className="text-slate-500">対象者</dt><dd>{proxyBookingFor.userName}</dd></div>
                )}
                <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{reserveTarget.seatNo}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{reserveTarget.area}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{recurring ? '開始日' : '日付'}</dt><dd>{formatDateJa(reserveTarget.date)}</dd></div>
              </dl>
              {!proxyBookingFor && (
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={recurring}
                      disabled={recurringStartOutOfRange}
                      onChange={(e) => {
                        // 単発予約の「同じ日に複数の座席は予約できません」エラー（duplicateSeatError）は
                        // 繰り返し予約には適用されない別の確認フローのため、繰り返し予約に切り替えたら
                        // 古いエラー表示を消す（2026-09-09修正。従来はチェックを入れてもエラー表示と
                        // 「変更する」ボタンが残ったままになり、紛らわしかった）
                        setRecurring(e.target.checked)
                        setActionError(null)
                        setDuplicateSeatError(false)
                      }}
                    />
                    繰り返し予約にする
                  </label>
                  {recurringStartOutOfRange && (
                    <p className="mt-1 text-xs text-slate-400">
                      この日は予約可能期間（{formatDateJa(period!.full_start)}〜{formatDateJa(period!.full_end)}）外のため、繰り返し予約は設定できません。
                    </p>
                  )}
                  {recurring && !recurringStartOutOfRange && (
                    <div className="mt-3 space-y-3 text-sm">
                      <div className="flex gap-4">
                        <label className="inline-flex items-center gap-1">
                          <input type="radio" checked={recurringType === 'weekly'} onChange={() => setRecurringType('weekly')} />
                          毎週（曜日を選択）
                        </label>
                        <label className="inline-flex items-center gap-1">
                          <input type="radio" checked={recurringType === 'daily'} onChange={() => setRecurringType('daily')} />
                          毎日
                        </label>
                      </div>
                      {recurringType === 'weekly' && (
                        <div className="flex gap-3">
                          {RECURRING_WEEKDAYS.map((w) => (
                            <label key={w.key} className="inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={recurringWeekdays.has(w.key)}
                                onChange={(e) => {
                                  const next = new Set(recurringWeekdays)
                                  if (e.target.checked) next.add(w.key)
                                  else next.delete(w.key)
                                  setRecurringWeekdays(next)
                                }}
                              />
                              {w.label}
                            </label>
                          ))}
                        </div>
                      )}
                      <label className="block">
                        <span className="mb-1 block text-xs text-slate-500">終了日（この日を含む）</span>
                        <input
                          type="date"
                          min={reserveTarget.date}
                          max={period?.full_end}
                          value={recurringEndDate}
                          onChange={(e) => setRecurringEndDate(e.target.value)}
                          className="h-9 w-44 rounded border border-slate-300 px-3"
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
              {actionError && (
                <div className="mt-3 space-y-2">
                  <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>
                  {duplicateSeatError && (
                    <div
                      className={`rounded border px-3 py-2 text-sm ${
                        anySameDayReservation?.seat_type === 'project'
                          ? 'border-red-200 bg-red-50 text-red-800'
                          : 'border-amber-200 bg-amber-50 text-amber-800'
                      }`}
                    >
                      <p>
                        {anySameDayReservation?.seat_type === 'project'
                          ? `現在の予約（${anySameDayReservation.seat_no}）は、PM・PLが割り当てたプロジェクトの確保済み座席です。取り消してこの座席に変更しますか？（プロジェクト座席の確保が失われます）他の座席を追加でもう1つ予約することもできます。`
                          : anySameDayReservation
                            ? `現在の予約（${anySameDayReservation.seat_no}）を取り消して、この座席に変更しますか？他の座席を追加でもう1つ予約することもできます。`
                            : 'この日の他の予約を取り消して、この座席に変更しますか？他の座席を追加でもう1つ予約することもできます。'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => confirmReserveResolveDuplicate('replace')}
                          className={`rounded px-3 py-1 text-xs text-white disabled:opacity-50 ${
                            anySameDayReservation?.seat_type === 'project'
                              ? 'bg-red-700 hover:bg-red-800'
                              : 'bg-amber-700 hover:bg-amber-800'
                          }`}
                        >
                          {anySameDayReservation?.seat_type === 'project' ? 'プロジェクト座席を取り消して変更する' : '変更する'}
                        </button>
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => confirmReserveResolveDuplicate('keep_both')}
                          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          両方予約する（既存の予約は残す）
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      {cancelTarget && (
        <Modal
          title="予約の取消"
          onClose={() => setCancelTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setCancelTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">戻る</button>
              <button type="button" disabled={submitting} onClick={confirmCancel} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">予約を取り消す</button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{cancelTarget.seat.seat_no}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{cancelTarget.area}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">日付</dt><dd>{formatDateJa(date)}</dd></div>
          </dl>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}

      {listCancelTarget && (
        <Modal
          title="予約の取消"
          onClose={() => setListCancelTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setListCancelTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">戻る</button>
              <button type="button" disabled={listCancelSubmitting} onClick={confirmListCancel} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">予約を取り消す</button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{listCancelTarget.seat_no}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{listCancelTarget.area}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">日付</dt><dd>{formatDateJa(listCancelTarget.date)}</dd></div>
          </dl>
          {listCancelError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{listCancelError}</p>}
        </Modal>
      )}

      {assignFixedSeatTarget && assignFixedSeatFor && (
        <Modal
          title="固定座席の指定"
          onClose={() => setAssignFixedSeatTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setAssignFixedSeatTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={submitting || !assignValidFrom || (!assignIndefinite && !assignValidUntil)}
                onClick={confirmAssignFixedSeat}
                className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                指定する
              </button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">対象者</dt><dd>{assignFixedSeatFor.userName}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{assignFixedSeatTarget.seat.seat_no}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{assignFixedSeatTarget.area}</dd></div>
          </dl>
          {assignFixedSeatFor.currentSeatNo && (
            <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              現在の固定座席（{assignFixedSeatFor.currentSeatNo}）は自動的に解除され、この座席に変更されます。先に解除する必要はありません。
            </p>
          )}
          <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-slate-500">開始日（過去日を指定すると記録の補正、未来日を指定すると事前の予約設定になります）</span>
              <input
                type="date"
                value={assignValidFrom}
                onChange={(e) => setAssignValidFrom(e.target.value)}
                className="h-9 w-full rounded border border-slate-300 px-3"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={assignIndefinite}
                onChange={(e) => setAssignIndefinite(e.target.checked)}
              />
              <span>無期限にする（変更するまでこの座席を使い続ける）</span>
            </label>
            {!assignIndefinite && (
              <label className="block">
                <span className="mb-1 block text-slate-500">期限を決めてください（この日まで固定座席として使用、翌日以降は自動的に空き席になる）</span>
                <input
                  type="date"
                  value={assignValidUntil}
                  onChange={(e) => setAssignValidUntil(e.target.value)}
                  min={shiftDateStr(assignValidFrom || todayStr(), 1)}
                  className="h-9 w-full rounded border border-slate-300 px-3"
                />
              </label>
            )}
          </div>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}

      {placeSeatTarget && (
        <Modal
          title="新しい座席を配置"
          onClose={() => setPlaceSeatTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setPlaceSeatTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting || !newSeatNo.trim()} onClick={confirmPlaceSeat} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">配置する</button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">エリア</span><span>{placeSeatTarget.area}</span></div>
            <label className="block">
              <span className="mb-1 block text-slate-500">座席番号</span>
              <input
                type="text"
                value={newSeatNo}
                onChange={(e) => setNewSeatNo(e.target.value)}
                placeholder="例: Q1"
                className="h-9 w-full rounded border border-slate-300 px-3"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-slate-500">座席タイプ</span>
              <select
                value={newSeatType}
                onChange={(e) => setNewSeatType(e.target.value as SeatType)}
                className="h-9 w-full rounded border border-slate-300 px-2"
              >
                <option value="free">フリー</option>
                <option value="fixed">固定</option>
                <option value="project">プロジェクト</option>
              </select>
            </label>
          </div>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}

      {pickMemberTarget && memberSeatAssignFor && (() => {
        // 対象外: 既に曜日パターンで期間全体が確保済みの人（座席を問わず）、または
        // 今表示中の日付に単発の割当が既にある人
        const isAvailable = (m: { userId: number }) => memberSeatAssignFor.freeSeat
          ? !freeSeatPatternPicks.some((p) => p.userId === m.userId) && !freeSeatPicks.some((p) => p.userId === m.userId && p.date === date)
          : memberPicks[m.userId] === undefined
        return (
          <Modal
            title={`${pickMemberTarget.seatNo} を割り当てる相手（${formatDateJa(date)}）`}
            onClose={() => setPickMemberTarget(null)}
            footer={<button type="button" onClick={() => setPickMemberTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>}
          >
            <div className="space-y-1.5">
              {memberSeatAssignFor.members.filter(isAvailable).map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => {
                    if (memberSeatAssignFor.freeSeat) {
                      // 相手を選んだ直後に、通常の座席予約モーダルと同じ作りで内容を確認してから
                      // 確定する（既定は表示中の1日だけ。「繰り返し予約にする」で期間・曜日パターンに
                      // 切り替えられる）
                      setPickRecurring(false)
                      setPickRecurringType('weekly')
                      setPickRecurringWeekdays(new Set())
                      setPickRecurringEndDate('')
                      setPickMemberConfig({ seatId: pickMemberTarget.seatId, seatNo: pickMemberTarget.seatNo, userId: m.userId, userName: m.name, startDate: date })
                    } else {
                      setMemberPicks((prev) => ({ ...prev, [m.userId]: { seatId: pickMemberTarget.seatId } }))
                    }
                    setPickMemberTarget(null)
                  }}
                  className="block w-full rounded border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  {m.name}
                </button>
              ))}
              {memberSeatAssignFor.members.filter(isAvailable).length === 0 && (
                <p className="text-sm text-slate-400">割り当て待ちのメンバーはいません</p>
              )}
            </div>
          </Modal>
        )
      })()}

      {pickMemberConfig && (
        <Modal
          title={`${pickMemberConfig.seatNo} を ${pickMemberConfig.userName} さんに確保`}
          onClose={() => setPickMemberConfig(null)}
          footer={
            <>
              <button type="button" onClick={() => setPickMemberConfig(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={pickRecurring && (
                  !pickRecurringEndDate
                  || pickRecurringEndDate < pickMemberConfig.startDate
                  || (pickRecurringType === 'weekly' && pickRecurringWeekdays.size === 0)
                )}
                onClick={() => {
                  if (pickRecurring) {
                    setFreeSeatPatternPicks((prev) => [...prev, {
                      userId: pickMemberConfig.userId, userName: pickMemberConfig.userName,
                      seatId: pickMemberConfig.seatId, seatNo: pickMemberConfig.seatNo,
                      startDate: pickMemberConfig.startDate,
                      patternType: pickRecurringType,
                      weekdays: pickRecurringType === 'weekly' ? [...pickRecurringWeekdays] : undefined,
                      endDate: pickRecurringEndDate,
                    }])
                  } else {
                    setFreeSeatPicks((prev) => [...prev, {
                      userId: pickMemberConfig.userId, userName: pickMemberConfig.userName,
                      seatId: pickMemberConfig.seatId, seatNo: pickMemberConfig.seatNo, date: pickMemberConfig.startDate,
                    }])
                  }
                  setPickMemberConfig(null)
                }}
                className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                この内容で追加する
              </button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">対象者</dt><dd>{pickMemberConfig.userName}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{pickMemberConfig.seatNo}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">{pickRecurring ? '開始日' : '日付'}</dt><dd>{formatDateJa(pickMemberConfig.startDate)}</dd></div>
          </dl>
          <div className="mt-3 border-t border-slate-200 pt-3">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={pickRecurring}
                onChange={(e) => setPickRecurring(e.target.checked)}
              />
              繰り返し予約にする
            </label>
            {pickRecurring && (
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex gap-4">
                  <label className="inline-flex items-center gap-1">
                    <input type="radio" checked={pickRecurringType === 'weekly'} onChange={() => setPickRecurringType('weekly')} />
                    毎週（曜日を選択）
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="radio" checked={pickRecurringType === 'daily'} onChange={() => setPickRecurringType('daily')} />
                    毎日
                  </label>
                </div>
                {pickRecurringType === 'weekly' && (
                  <div className="flex gap-3">
                    {RECURRING_WEEKDAYS.map((w) => (
                      <label key={w.key} className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={pickRecurringWeekdays.has(w.key)}
                          onChange={(e) => {
                            const next = new Set(pickRecurringWeekdays)
                            if (e.target.checked) next.add(w.key)
                            else next.delete(w.key)
                            setPickRecurringWeekdays(next)
                          }}
                        />
                        {w.label}
                      </label>
                    ))}
                  </div>
                )}
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500">終了日（この日を含む）</span>
                  <input
                    type="date"
                    min={pickMemberConfig.startDate}
                    max={period?.full_end}
                    value={pickRecurringEndDate}
                    onChange={(e) => setPickRecurringEndDate(e.target.value)}
                    className="h-9 w-44 rounded border border-slate-300 px-3"
                  />
                </label>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
