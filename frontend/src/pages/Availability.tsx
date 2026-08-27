import { useState } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useAvailability, type AreaFilter } from '../hooks/useAvailability'
import { useMyReservations } from '../hooks/useMyReservations'
import { useFloorZoom } from '../hooks/useFloorZoom'
import { usePeriodAvailability } from '../hooks/usePeriodAvailability'
import Modal from '../components/Modal'
import { NorthFloor, EastFloor, WestFloor } from '../components/FloorAreas'
import type { Seat, SeatStatus, SeatType } from '../types'

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']

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

// S-02 空き状況・予約。画面モックアップの実際のフロアマップ配置（部屋・柱・ロッカー含む）を再現する
export default function Availability() {
  const [date, setDate] = useState(todayStr())
  const [viewMode, setViewMode] = useState<'floormap' | 'period'>('floormap')
  const [areaFilter, setAreaFilter] = useState<AreaFilter>('all')
  const [reservationTab, setReservationTab] = useState<'upcoming' | 'past'>('upcoming')
  const [periodOverride, setPeriodOverride] = useState<{ start: string; end: string } | null>(null)
  const [reserveTarget, setReserveTarget] = useState<{ seatId: number; seatNo: string; area: string; date: string } | null>(null)
  const [cancelTarget, setCancelTarget] = useState<{ seat: Seat; area: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { availability, isLoading, refresh: refreshAvailability } = useAvailability(date, areaFilter)
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
    setReserveTarget({ seatId, seatNo, area, date: targetDate })
  }
  const openCancel = (seat: Seat, area: string) => {
    setActionError(null)
    setCancelTarget({ seat, area })
  }
  const resetPeriodFilter = () => setPeriodOverride(null)

  const confirmReserve = async () => {
    if (!reserveTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
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

  const cancelFromList = async (id: number) => {
    try {
      await apiFetch(`/api/reservations/${id}`, { method: 'DELETE' })
      await refreshAll()
    } catch (e) {
      window.alert(e instanceof ApiError ? e.message : '取消に失敗しました')
    }
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
  const floorProps = {
    seatByNo,
    onReserve: (seat: Seat) => openReserve(seat.id, seat.seat_no, seatArea[seat.seat_no], date),
    onCancel: (seat: Seat) => openCancel(seat, seatArea[seat.seat_no]),
  }

  const areaNames = new Set(availability?.areas.map((a) => a.area))
  const hasNorth = areaNames.has('NORTH')
  const hasEast = areaNames.has('EAST')
  const hasWest = areaNames.has('WEST')
  const hasAnyArea = hasNorth || hasEast || hasWest
  const { viewportRef, overviewRef } = useFloorZoom(areaFilter, hasAnyArea)

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">空き状況・予約</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-02</span>
      </header>

      <div className="p-6">

      <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center justify-between gap-1 sm:justify-start">
          <button
            type="button"
            onClick={() => setDate((d) => shiftDateStr(d, -1))}
            aria-label="前日"
            className="h-8 w-8 shrink-0 rounded border border-slate-300 hover:bg-slate-50"
          >
            ‹
          </button>
          <input
            type="date"
            value={date}
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
                <div className="panel-north">
                  <h2 className="area-heading area-north mb-3">NORTHエリア</h2>
                  <NorthFloor {...floorProps} />
                </div>
              </div>
            )}
            {(hasEast || hasWest) && (
              <div className="floor-overview-stack">
                {hasEast && (
                  <div className="panel-east">
                    <h2 className="area-heading area-east mb-3">EASTエリア</h2>
                    <EastFloor {...floorProps} />
                  </div>
                )}
                {hasWest && (
                  <div className="panel-west">
                    <h2 className="area-heading area-west mb-3">WESTエリア</h2>
                    <WestFloor {...floorProps} />
                  </div>
                )}
              </div>
            )}
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
            <div className="max-h-[70vh] overflow-auto rounded border border-slate-200 bg-white">
              <table className="text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th
                      className="sticky top-0 left-0 z-30 whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-3 py-2"
                      style={{ minWidth: PERIOD_COL_DATE_W }}
                    >
                      日付
                    </th>
                    <th
                      className="sticky top-0 z-30 whitespace-nowrap border-b border-slate-200 bg-slate-100 px-2 py-2 text-center"
                      style={{ left: PERIOD_COL_DATE_W, minWidth: PERIOD_COL_WD_W }}
                    >
                      曜日
                    </th>
                    <th
                      className="sticky top-0 z-30 whitespace-nowrap border-b border-slate-200 bg-slate-100 px-2 py-2 text-center"
                      style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W, minWidth: PERIOD_COL_RES_W }}
                    >
                      予約数
                    </th>
                    <th
                      className="sticky top-0 z-30 whitespace-nowrap border-r border-b border-slate-200 bg-slate-100 px-2 py-2 text-center"
                      style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W + PERIOD_COL_RES_W, minWidth: PERIOD_COL_VAC_W }}
                    >
                      空席
                    </th>
                    {period.seats.map((seat) => (
                      <th
                        key={seat.id}
                        className="sticky top-0 z-20 min-w-[64px] whitespace-nowrap border-b border-slate-200 bg-slate-100 px-1 py-2 text-center text-xs font-normal"
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
                      <tr key={d} className="border-b border-slate-100">
                        <td
                          className="sticky left-0 z-10 whitespace-nowrap border-r border-slate-200 bg-white px-3 py-1.5 font-semibold"
                        >
                          {d.replaceAll('-', '/')}
                        </td>
                        <td
                          className="sticky z-10 whitespace-nowrap bg-white px-2 py-1.5 text-center text-slate-500"
                          style={{ left: PERIOD_COL_DATE_W }}
                        >
                          {wd}
                        </td>
                        <td
                          className="sticky z-10 whitespace-nowrap bg-white px-2 py-1.5 text-center text-slate-600"
                          style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W }}
                        >
                          {reserved}
                        </td>
                        <td
                          className="sticky z-10 whitespace-nowrap border-r border-slate-200 bg-white px-2 py-1.5 text-center text-slate-600"
                          style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W + PERIOD_COL_RES_W }}
                        >
                          {vacant}
                        </td>
                        {period.seats.map((seat) => {
                          const cell = seat.days[d]
                          const status = cell?.status ?? 'free'
                          return (
                            <td key={seat.id} className="px-1 py-1.5 text-center">
                              {status === 'free' ? (
                                <button
                                  type="button"
                                  onClick={() => openReserve(seat.id, seat.seat_no, seat.area, d)}
                                  className="whitespace-nowrap rounded border border-dashed border-slate-400 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
                                >
                                  空き
                                </button>
                              ) : (
                                <span className={`whitespace-nowrap text-[11px] ${status === 'mine' ? 'font-semibold text-blue-800' : 'text-slate-600'}`}>
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
                      {r.type === 'single' ? '単発' : '周期予約'}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{r.registrant}</td>
                  <td className="py-2">
                    {reservationTab === 'upcoming' ? (
                      <button
                        type="button"
                        onClick={() => cancelFromList(r.id)}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        取消
                      </button>
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
          title="座席の予約"
          onClose={() => setReserveTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setReserveTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={confirmReserve} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">予約する</button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{reserveTarget.seatNo}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{reserveTarget.area}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">日付</dt><dd>{formatDateJa(reserveTarget.date)}</dd></div>
          </dl>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
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
    </div>
  )
}
