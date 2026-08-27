import { useState } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useAvailability, type AreaFilter } from '../hooks/useAvailability'
import { useMyReservations } from '../hooks/useMyReservations'
import { useFloorZoom } from '../hooks/useFloorZoom'
import Modal from '../components/Modal'
import { NorthFloor, EastFloor, WestFloor } from '../components/FloorAreas'
import type { Seat, SeatStatus } from '../types'

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

const AREA_TABS: { key: AreaFilter; label: string }[] = [
  { key: 'all', label: '全体表示' },
  { key: 'north', label: 'NORTHエリア' },
  { key: 'east', label: 'EASTエリア' },
  { key: 'west', label: 'WESTエリア' },
]

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
  const [areaFilter, setAreaFilter] = useState<AreaFilter>('all')
  const [reservationTab, setReservationTab] = useState<'upcoming' | 'past'>('upcoming')
  const [reserveTarget, setReserveTarget] = useState<{ seat: Seat; area: string } | null>(null)
  const [cancelTarget, setCancelTarget] = useState<{ seat: Seat; area: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { availability, isLoading, refresh: refreshAvailability } = useAvailability(date, areaFilter)
  const upcoming = useMyReservations('upcoming')
  const past = useMyReservations('past')

  const refreshAll = async () => {
    await Promise.all([refreshAvailability(), upcoming.mutate(), past.mutate()])
  }

  const openReserve = (seat: Seat, area: string) => {
    setActionError(null)
    setReserveTarget({ seat, area })
  }
  const openCancel = (seat: Seat, area: string) => {
    setActionError(null)
    setCancelTarget({ seat, area })
  }

  const confirmReserve = async () => {
    if (!reserveTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      await apiFetch('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({ seat_id: reserveTarget.seat.id, date }),
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
    onReserve: (seat: Seat) => openReserve(seat, seatArea[seat.seat_no]),
    onCancel: (seat: Seat) => openCancel(seat, seatArea[seat.seat_no]),
  }

  const areaNames = new Set(availability?.areas.map((a) => a.area))
  const hasNorth = areaNames.has('NORTH')
  const hasEast = areaNames.has('EAST')
  const hasWest = areaNames.has('WEST')
  const hasAnyArea = hasNorth || hasEast || hasWest
  const { viewportRef, overviewRef } = useFloorZoom(areaFilter, hasAnyArea)

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-bold">空き状況・予約</h1>

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
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{reserveTarget.seat.seat_no}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">エリア</dt><dd>{reserveTarget.area}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">日付</dt><dd>{formatDateJa(date)}</dd></div>
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
