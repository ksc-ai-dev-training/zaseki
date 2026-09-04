import { useRef, useState, type MouseEvent } from 'react'
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
import { FLOOR_LAYOUT_SEATS, blockLabelOf } from '../lib/floorLayout'
import type {
  AssignFixedSeatFor, MemberSeatAssignFor, MyReservation, ProjectPlanDetail, ProxyBookingFor,
  RecurringReservationResult, SeatBlockFor, Seat, SeatStatus, SeatType, Weekday,
} from '../types'

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']
const RECURRING_WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: '月' }, { key: 'tue', label: '火' }, { key: 'wed', label: '水' },
  { key: 'thu', label: '木' }, { key: 'fri', label: '金' },
]

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
// 該当する日を返す（最大6日先まで探索。該当する曜日がなければperiodStartそのままを返す）。
// 「曜日が確定しているときに座席の割り当てをするので、その曜日のプロジェクト始動日初日に
// 設定してほしい」との要望を受けた（2026-09-02追加。開始日自体が確定曜日でないこともあるため）
function firstMatchingWeekdayOnOrAfter(periodStart: string, weekdaysFinalized: Weekday[]): string {
  if (weekdaysFinalized.length === 0) return periodStart
  const dows = new Set(weekdaysFinalized.map((w) => WEEKDAY_DOW[w]))
  let d = periodStart
  for (let i = 0; i < 7; i++) {
    if (dows.has(new Date(`${d}T00:00:00`).getDay())) return d
    d = shiftDateStr(d, 1)
  }
  return periodStart
}
function formatDateJa(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JA[d.getDay()]}）`
}
function formatDateShort(dateStr: string): { md: string; wd: string } {
  const d = new Date(`${dateStr}T00:00:00`)
  return { md: `${d.getMonth() + 1}/${d.getDate()}`, wd: WEEKDAY_JA[d.getDay()] }
}

const AREA_TABS: { key: AreaFilter; label: string }[] = [
  { key: 'all', label: '全体表示' },
  { key: 'north', label: 'NORTHエリア' },
  { key: 'east', label: 'EASTエリア' },
  { key: 'west', label: 'WESTエリア' },
]

const SEAT_TYPE_JA: Record<SeatType, string> = { free: 'フリー', fixed: '固定', project: 'プロジェクト' }

// 期間ビュー（S-02）の表: 縦軸=日付・予約数・空席、横軸=座席番号・種別（現行スプレッドシート準拠）。
// 左側の日付系4列・上部の座席ヘッダー行はスクロール中も見えるよう固定する（position: sticky）
const PERIOD_COL_DATE_W = 96
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
// role='admin'またはP-PROXY（プロジェクトの代表者）またはP-SEATASSIGN（席決め権限）を持つプロジェクトが対象
function FreeSeatProxyBookingButton() {
  const navigate = useNavigate()
  const { items: myProjects } = useMyProjects()
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState<number | ''>('')
  const [plan, setPlan] = useState<ProjectPlanDetail | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [selectedMembers, setSelectedMembers] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const eligibleProjects = myProjects.filter((p) => (p.can_assign_seats || p.project_title === 'PM' || p.project_title === 'PL') && p.plans.length > 0)

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
    navigate('/', {
      replace: true,
      state: {
        memberSeatAssignFor: {
          planId: plan.id, projectName: plan.project_name, periodStart: todayStr(),
          allocatedSeatIds: [], members, freeSeat: true,
        },
      },
    })
  }

  const candidates = plan?.members.filter((m) => !m.has_fixed_seat && !m.seat_not_required) ?? []

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="ml-auto rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
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
            <p className="text-xs text-slate-400">
              メンバーを選んで進むと、フロアマップ上で表示中の日に空いているフリー座席をクリックして、1人ずつ割り当てられます。
            </p>
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
  // S-04から「座席表から選ぶ」で遷移した場合、location.stateに対象計画が積まれる
  // （メンバーへの座席確保モード、2026-08-31追加）
  const memberSeatAssignFor = (location.state as { memberSeatAssignFor?: MemberSeatAssignFor } | null)?.memberSeatAssignFor

  const topRef = useRef<HTMLDivElement>(null)
  // 座席の島の割当モード・メンバーへの座席確保モードでは、操作時点（今日）ではなく対象四半期の
  // 開始日（10/1・1/1・4/1・7/1のいずれか）を初期表示にする（2026-08-31追加。「プロジェクト座席が
  // 決まる基準日の座席表を表示してほしい」との要望を受けた。実際に座席が使われ始める日の
  // 空き状況を見て選べるようにする）
  const [date, setDate] = useState(
    seatBlockFor
      ? firstMatchingWeekdayOnOrAfter(seatBlockFor.periodStart, seatBlockFor.weekdaysFinalized ?? [])
      : memberSeatAssignFor?.periodStart ?? todayStr()
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
  const [cancelTarget, setCancelTarget] = useState<{ seat: Seat; area: string } | null>(null)
  const [assignFixedSeatTarget, setAssignFixedSeatTarget] = useState<{ seat: Seat; area: string } | null>(null)
  const [assignIndefinite, setAssignIndefinite] = useState(true)
  const [assignValidUntil, setAssignValidUntil] = useState('')
  const [placeSeatTarget, setPlaceSeatTarget] = useState<{ area: 'NORTH' | 'EAST' | 'WEST'; posX: number; posY: number } | null>(null)
  const [newSeatNo, setNewSeatNo] = useState('')
  const [newSeatType, setNewSeatType] = useState<SeatType>('free')
  // 割当済み計画を「編集」で開いた場合、現在の割当座席を初期選択状態にする（2026-08-28追加）
  const [seatBlockSelection, setSeatBlockSelection] = useState<Set<number>>(
    () => new Set(seatBlockFor?.allocatedSeatIds ?? []),
  )
  // メンバーへの座席確保モード（2026-08-31追加）: userId → seatIdの暫定割当。送信するまでサーバーには反映しない
  const [memberPicks, setMemberPicks] = useState<Record<number, number>>({})
  const [pickMemberTarget, setPickMemberTarget] = useState<{ seatId: number; seatNo: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { availability, isLoading, refresh: refreshAvailability } = useAvailability(date, areaFilter)
  const { items: areas } = useAreas(placeSeatMode)
  const { period, isLoading: periodLoading, refresh: refreshPeriod } = usePeriodAvailability(periodOverride?.start, periodOverride?.end, areaFilter)
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

  const openReserve = (seatId: number, seatNo: string, area: string, targetDate: string) => {
    setActionError(null)
    if (seatBlockFor) {
      // S-09「座席の島の割当モード」: モーダルは開かず、クリックのたびに選択をトグルする
      setSeatBlockSelection((prev) => {
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
  }
  const openCancel = (seat: Seat, area: string) => {
    setActionError(null)
    setCancelTarget({ seat, area })
  }
  const openAssignFixedSeat = (seat: Seat, area: string) => {
    setActionError(null)
    setAssignIndefinite(true)
    setAssignValidUntil('')
    setAssignFixedSeatTarget({ seat, area })
  }
  // S-04「メンバーへの座席確保モード」: 暫定割当済みの座席を再クリックした場合は割当を解除し、
  // 未割当の座席をクリックした場合は割り当てる相手を選ぶモーダルを開く（2026-08-31追加）
  const onMemberAssignClick = (seat: Seat) => {
    setActionError(null)
    const pickedUserId = Object.entries(memberPicks).find(([, seatId]) => seatId === seat.id)?.[0]
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
  const exitProxyBookingMode = () => navigate('.', { replace: true, state: null })
  const exitMemberSeatAssignMode = () => { setMemberPicks({}); navigate('.', { replace: true, state: null }) }

  const confirmMemberSeatAssign = async () => {
    if (!memberSeatAssignFor || Object.keys(memberPicks).length === 0) return
    setSubmitting(true)
    setActionError(null)
    const assignments = Object.entries(memberPicks).map(([userId, seatId]) => ({
      member_user_id: Number(userId), seat_id: seatId,
    }))
    try {
      if (memberSeatAssignFor.freeSeat) {
        await apiFetch(`/api/project-quarter-plans/${memberSeatAssignFor.planId}/free-seat-assignments`, {
          method: 'POST',
          body: JSON.stringify({ assignments, date }),
        })
      } else {
        await apiFetch(`/api/project-quarter-plans/${memberSeatAssignFor.planId}/seat-assignments`, {
          method: 'POST',
          body: JSON.stringify({ assignments }),
        })
      }
      setMemberPicks({})
      navigate('/project-seats', { replace: true })
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '座席の確保に失敗しました')
    } finally {
      setSubmitting(false)
    }
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

  const confirmReserve = async () => {
    if (!reserveTarget) return
    setSubmitting(true)
    setActionError(null)
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
      await apiFetch('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({ seat_id: reserveTarget.seatId, date: reserveTarget.date }),
      })
      setReserveTarget(null)
      await refreshAll()
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
      setCancelTarget(null)
      await refreshAll()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '取消に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmAssignFixedSeat = async () => {
    if (!assignFixedSeatTarget || !assignFixedSeatFor) return
    if (!assignIndefinite && !assignValidUntil) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch('/api/fixed-seat-assignments', {
        method: 'POST',
        body: JSON.stringify({
          seat_id: assignFixedSeatTarget.seat.id,
          user_id: assignFixedSeatFor.userId,
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

  const cancelFromList = async (id: number) => {
    try {
      await apiFetch(`/api/reservations/${id}`, { method: 'DELETE' })
      await refreshAll()
    } catch (e) {
      window.alert(e instanceof ApiError ? e.message : '取消に失敗しました')
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
  const memberAssignPickedLabels: Record<number, string> = {}
  Object.entries(memberPicks).forEach(([userId, seatId]) => {
    const member = memberSeatAssignFor?.members.find((m) => m.userId === Number(userId))
    if (member) memberAssignPickedLabels[seatId] = member.name
  })

  const floorProps = {
    seatByNo,
    onReserve: (seat: Seat) => openReserve(seat.id, seat.seat_no, seatArea[seat.seat_no], date),
    onCancel: (seat: Seat) => openCancel(seat, seatArea[seat.seat_no]),
    fixedSeatAssignMode: Boolean(assignFixedSeatFor),
    onAssignFixedSeat: (seat: Seat) => openAssignFixedSeat(seat, seatArea[seat.seat_no]),
    selectedSeatIds: seatBlockFor ? seatBlockSelection : undefined,
    memberAssignMode: Boolean(memberSeatAssignFor),
    memberAssignEligibleIds: memberSeatAssignFor ? memberAssignEligibleIds : undefined,
    memberAssignPickedLabels: memberSeatAssignFor ? memberAssignPickedLabels : undefined,
    onMemberAssignClick,
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
  const periodVacantLeftOffset = isMobile ? PERIOD_COL_DATE_W : PERIOD_COL_DATE_W + PERIOD_COL_WD_W + PERIOD_COL_RES_W

  // S-07から追加した座席のうち、フロアマップの固定レイアウト（実際の配置図）に含まれないものは
  // 通常のフロアマップの図には現れない。座席配置モード（pos_x/pos_yあり）で配置済みのものは
  // パネル上に直接重ねて表示し、それ以外（座標未設定）は「追加座席」として下に別枠一覧表示する。
  const extraSeatGroups = new Map<string, Seat[]>()
  const freePositionedByArea: Record<'NORTH' | 'EAST' | 'WEST', Seat[]> = { NORTH: [], EAST: [], WEST: [] }
  Object.keys(seatByNo).forEach((no) => {
    const area = seatArea[no] as 'NORTH' | 'EAST' | 'WEST' | undefined
    if (!area || FLOOR_LAYOUT_SEATS[area].has(no)) return
    const seat = seatByNo[no]
    if (seat.pos_x !== null && seat.pos_y !== null) {
      freePositionedByArea[area].push(seat)
      return
    }
    const label = `${area} ${blockLabelOf(no)}`
    if (!extraSeatGroups.has(label)) extraSeatGroups.set(label, [])
    extraSeatGroups.get(label)!.push(seat)
  })
  extraSeatGroups.forEach((seats) => seats.sort((a, b) => a.seat_no.localeCompare(b.seat_no)))

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
        />
      </div>
    ))

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">空き状況・予約</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-02</span>
        {!assignFixedSeatFor && !proxyBookingFor && !seatBlockFor && !memberSeatAssignFor && !placeSeatMode && (
          <FreeSeatProxyBookingButton />
        )}
      </header>

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
          <span>新しい座席を配置中です。フロアマップの空いている位置をクリックしてください。</span>
          <button type="button" onClick={exitPlaceSeatMode} className="shrink-0 text-blue-700 underline hover:text-blue-900">
            完了・キャンセル
          </button>
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

      {seatBlockFor && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-8 py-2.5 text-sm text-blue-900">
          <span>
            <strong>{seatBlockFor.projectName}</strong>の座席の島を{seatBlockFor.allocatedSeatIds ? '編集' : '割り当て'}中です（必要座席数: {seatBlockFor.requiredSeats}名）。
            フロアマップの座席をクリックして選択・解除してください。選択中: {seatBlockSelection.size}席
          </span>
          <span className="flex shrink-0 gap-3">
            <button
              type="button"
              disabled={submitting || seatBlockSelection.size === 0}
              onClick={confirmSeatBlock}
              className="rounded bg-blue-800 px-3 py-1 text-white hover:bg-blue-900 disabled:opacity-50"
            >
              {seatBlockFor.allocatedSeatIds ? 'この内容で更新する' : 'この内容で割り当てる'}
            </button>
            <button type="button" onClick={exitSeatBlockMode} className="text-blue-700 underline hover:text-blue-900">
              キャンセル
            </button>
          </span>
        </div>
      )}
      {seatBlockFor && actionError && (
        <p className="border-b border-red-200 bg-red-50 px-8 py-2 text-sm text-red-700">{actionError}</p>
      )}

      {memberSeatAssignFor && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-8 py-2.5 text-sm text-blue-900">
          <span>
            <strong>{memberSeatAssignFor.projectName}</strong>のメンバーへの座席を確保中です。
            {memberSeatAssignFor.freeSeat
              ? `${formatDateJa(date)}の空いているフリー座席をクリックし、割り当てる相手を選んでください。`
              : '座席の島の中から空いている座席をクリックし、割り当てる相手を選んでください。'}
            選択中: {Object.keys(memberPicks).length}/{memberSeatAssignFor.members.length}名
          </span>
          <span className="flex shrink-0 gap-3">
            <button
              type="button"
              disabled={submitting || Object.keys(memberPicks).length === 0}
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
      )}
      {memberSeatAssignFor && actionError && (
        <p className="border-b border-red-200 bg-red-50 px-8 py-2 text-sm text-red-700">{actionError}</p>
      )}

      <div className="p-6" ref={topRef}>

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

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
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
            <span className="text-xs text-slate-400">座席マスタ管理（S-07）で追加された座席（配置図には未反映）</span>
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
              min={period?.full_start}
              max={period?.full_end}
              disabled={!period}
              onChange={(e) => setPeriodOverride({ start: e.target.value, end: periodEnd })}
              className="h-8 rounded border border-slate-300 px-2 text-sm"
            />
            <span className="text-center text-sm text-slate-500 sm:text-left">〜</span>
            <input
              type="date"
              value={periodEnd}
              min={period?.full_start}
              max={period?.full_end}
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

          {periodLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

          {period && (
            <div className="max-h-[70vh] overflow-auto rounded border border-slate-300 bg-white">
              <table className="text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th
                      className="sticky top-0 left-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-3 py-2"
                      style={{ minWidth: PERIOD_COL_DATE_W }}
                    >
                      日付
                    </th>
                    {!isMobile && (
                      <th
                        className="sticky top-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 py-2 text-center"
                        style={{ left: PERIOD_COL_DATE_W, minWidth: PERIOD_COL_WD_W }}
                      >
                        曜日
                      </th>
                    )}
                    {!isMobile && (
                      <th
                        className="sticky top-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 py-2 text-center"
                        style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W, minWidth: PERIOD_COL_RES_W }}
                      >
                        予約数
                      </th>
                    )}
                    <th
                      className="sticky top-0 z-30 whitespace-nowrap border-r border-b border-slate-300 bg-slate-100 px-2 py-2 text-center"
                      style={{ left: periodVacantLeftOffset, minWidth: PERIOD_COL_VAC_W }}
                    >
                      空席
                    </th>
                    {period.seats.map((seat) => (
                      <th
                        key={seat.id}
                        className="sticky top-0 z-20 min-w-[64px] whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-1 py-2 text-center text-xs font-normal"
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
                          {d.replaceAll('-', '/')}
                        </td>
                        {!isMobile && (
                          <td
                            className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-500"
                            style={{ left: PERIOD_COL_DATE_W }}
                          >
                            {wd}
                          </td>
                        )}
                        {!isMobile && (
                          <td
                            className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-600"
                            style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W }}
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
                          return (
                            <td key={seat.id} className="border-r border-slate-200 px-1 py-1.5 text-center">
                              {status === 'free' ? (
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
                                  {cell?.display_name}
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
                          onClick={() => cancelFromList(r.id)}
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
                <button type="button" disabled={submitting} onClick={confirmReserve} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
                  {recurring ? 'この内容で登録する' : '予約する'}
                </button>
              </>
            )
          }
        >
          {recurringResult ? (
            <div>
              <p className="mb-2 text-sm text-slate-600">{recurringResult.seat_no} への繰り返し予約の登録結果</p>
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
                    <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
                    繰り返し予約にする
                  </label>
                  {recurring && (
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
              {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
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

      {assignFixedSeatTarget && assignFixedSeatFor && (
        <Modal
          title="固定座席の指定"
          onClose={() => setAssignFixedSeatTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setAssignFixedSeatTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button
                type="button"
                disabled={submitting || (!assignIndefinite && !assignValidUntil)}
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
                  min={shiftDateStr(todayStr(), 1)}
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

      {pickMemberTarget && memberSeatAssignFor && (
        <Modal
          title={`${pickMemberTarget.seatNo} を割り当てる相手`}
          onClose={() => setPickMemberTarget(null)}
          footer={<button type="button" onClick={() => setPickMemberTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>}
        >
          <div className="space-y-1.5">
            {memberSeatAssignFor.members.filter((m) => memberPicks[m.userId] === undefined).map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => {
                  setMemberPicks((prev) => ({ ...prev, [m.userId]: pickMemberTarget.seatId }))
                  setPickMemberTarget(null)
                }}
                className="block w-full rounded border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                {m.name}
              </button>
            ))}
            {memberSeatAssignFor.members.filter((m) => memberPicks[m.userId] === undefined).length === 0 && (
              <p className="text-sm text-slate-400">割り当て待ちのメンバーはいません</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
