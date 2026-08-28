import type { CSSProperties } from 'react'
import type { Seat, SeatStatus } from '../types'

const STATUS_CLASS: Record<SeatStatus, string> = {
  free: 'status-free',
  mine: 'status-mine',
  occupied: 'status-occupied',
  occupied_fixed: 'status-fixed',
  project_confirmed: 'status-project',
  project_pending: 'status-pending',
}

interface SeatTileProps {
  seat: Seat | undefined
  onReserve: (seat: Seat) => void
  onCancel: (seat: Seat) => void
  style?: CSSProperties
  /** S-05から遷移した「固定座席指定モード」。有効な間は通常の予約・取消を行わない */
  fixedSeatAssignMode?: boolean
  onAssignFixedSeat?: (seat: Seat) => void
  /** S-09「座席の島の割当モード」で選択済みの座席id一覧（見た目のハイライトのみに使う。
   * クリック自体は通常の空き座席クリックと同じonReserve経由で、Availability.tsx側で分岐する） */
  selectedSeatIds?: Set<number>
}

// 座席1マス（S-02フロアマップ）。空き→予約モーダル、自分の予約→取消モーダルを開く
export default function SeatTile({ seat, onReserve, onCancel, style, fixedSeatAssignMode, onAssignFixedSeat, selectedSeatIds }: SeatTileProps) {
  if (!seat) {
    return <div className="seat-tile status-occupied opacity-40" style={style}>…</div>
  }

  if (fixedSeatAssignMode) {
    // 座席タイプを問わず、当日空いている座席であれば指定できる（2026-08-27訂正）。
    // 使用中・自分の予約・固定座席（他者）等はここでは選べないため非活性にする
    const eligible = seat.status === 'free'
    if (eligible) {
      return (
        <button
          type="button"
          className="seat-tile status-free ring-2 ring-blue-500"
          style={style}
          onClick={() => onAssignFixedSeat?.(seat)}
        >
          {seat.seat_no}
        </button>
      )
    }
    return (
      <div className={`seat-tile opacity-40 ${STATUS_CLASS[seat.status]}`} style={style}>
        {seat.seat_no}
        {seat.display_name && <span className="seat-tag">{seat.display_name}</span>}
      </div>
    )
  }

  if (seat.status === 'free' && seat.seat_type === 'free') {
    const selected = selectedSeatIds?.has(seat.id)
    return (
      <button
        type="button"
        className={`seat-tile status-free ${selected ? 'ring-2 ring-green-600' : ''}`}
        style={style}
        onClick={() => onReserve(seat)}
      >
        {seat.seat_no}
      </button>
    )
  }
  if (seat.status === 'mine') {
    return (
      <button type="button" className="seat-tile status-mine" style={style} onClick={() => onCancel(seat)}>
        {seat.seat_no}
        {seat.display_name && <span className="seat-tag">{seat.display_name}</span>}
      </button>
    )
  }
  return (
    <div className={`seat-tile ${STATUS_CLASS[seat.status]}`} style={style} title={seat.title ?? undefined}>
      {seat.seat_no}
      {seat.display_name && <span className="seat-tag">{seat.display_name}</span>}
    </div>
  )
}
