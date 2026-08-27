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
}

// 座席1マス（S-02フロアマップ）。空き→予約モーダル、自分の予約→取消モーダルを開く
export default function SeatTile({ seat, onReserve, onCancel, style }: SeatTileProps) {
  if (!seat) {
    return <div className="seat-tile status-occupied opacity-40" style={style}>…</div>
  }
  if (seat.status === 'free') {
    return (
      <button type="button" className="seat-tile status-free" style={style} onClick={() => onReserve(seat)}>
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
