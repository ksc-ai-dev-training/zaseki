import type { CSSProperties } from 'react'
import SeatTile from './SeatTile'
import type { Seat } from '../types'

interface FloorProps {
  seatByNo: Record<string, Seat>
  onReserve: (seat: Seat) => void
  onCancel: (seat: Seat) => void
  fixedSeatAssignMode?: boolean
  onAssignFixedSeat?: (seat: Seat) => void
  selectedSeatIds?: Set<number>
  readOnly?: boolean
  memberAssignMode?: boolean
  memberAssignEligibleIds?: Set<number>
  memberAssignPickedLabels?: Record<number, string>
  onMemberAssignClick?: (seat: Seat) => void
}

const pillarStyle: CSSProperties = { width: 40, height: 36, justifySelf: 'center', alignSelf: 'center' }

// 画面モックアップ（docs/03_画面モックアップ/S-02_availability.html）の実際の
// フロアマップ画像に基づく配置をそのまま再現する。座席の状態のみ実データに差し替える。

export function NorthFloor({ seatByNo, ...tileProps }: FloorProps) {
  const tile = (no: string, style: CSSProperties) => (
    <SeatTile seat={seatByNo[no]} style={style} {...tileProps} />
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="floor-block">
        <div className="seat-block-label text-xs font-semibold text-slate-500 mb-1">周辺スペース・Bブロック（ロッカー）</div>
        <div className="seat-grid north-l rows-5">
          <div className="floor-pillar" style={{ gridColumn: '9 / span 2', gridRow: '1', ...pillarStyle }}>柱</div>
          <div className="floor-room" style={{ gridColumn: '6 / span 2', gridRow: '2 / span 4' }}>倉庫</div>
          <div className="floor-room" style={{ gridColumn: '10', gridRow: '2 / span 4' }}>キャビネット</div>
          {tile('B1', { gridColumn: '8', gridRow: '2' })}
          {tile('B5', { gridColumn: '9', gridRow: '2' })}
          {tile('B2', { gridColumn: '8', gridRow: '3' })}
          {tile('B6', { gridColumn: '9', gridRow: '3' })}
          {tile('B3', { gridColumn: '8', gridRow: '4' })}
          {tile('B7', { gridColumn: '9', gridRow: '4' })}
          {tile('B4', { gridColumn: '8', gridRow: '5' })}
          {tile('B8', { gridColumn: '9', gridRow: '5' })}
        </div>
      </div>
      <div className="floor-block">
        <div className="seat-block-label text-xs font-semibold text-slate-500 mb-1">Aブロック</div>
        <div className="seat-grid north-l rows-2">
          {tile('A1', { gridColumn: '3', gridRow: '1' })}
          <div className="floor-pillar" style={{ gridColumn: '4', gridRow: '1 / span 2', ...pillarStyle }}>柱</div>
          {tile('A2', { gridColumn: '5', gridRow: '1' })}
          {tile('A3', { gridColumn: '6', gridRow: '1' })}
          {tile('A4', { gridColumn: '7', gridRow: '1' })}
          {tile('A5', { gridColumn: '8', gridRow: '1' })}
          {tile('A6', { gridColumn: '9', gridRow: '1' })}
          <div className="floor-pillar" style={{ gridColumn: '10', gridRow: '1 / span 2', ...pillarStyle }}>柱</div>
          {tile('A7', { gridColumn: '5', gridRow: '2' })}
          {tile('A8', { gridColumn: '6', gridRow: '2' })}
          {tile('A9', { gridColumn: '7', gridRow: '2' })}
          {tile('A10', { gridColumn: '8', gridRow: '2' })}
          {tile('A11', { gridColumn: '9', gridRow: '2' })}
        </div>
      </div>
    </div>
  )
}

function SeatBlock({ label, seats, gridArea, seatByNo, ...tileProps }: {
  label: string
  seats: string[]
  gridArea: string
} & FloorProps) {
  return (
    <div className="floor-block" style={{ gridArea }}>
      <div className="seat-block-label text-xs font-semibold text-slate-500 mb-1">{label}</div>
      <div className="seat-grid cols-2">
        {seats.map((no) => (
          <SeatTile key={no} seat={seatByNo[no]} {...tileProps} />
        ))}
      </div>
    </div>
  )
}

const LOCKER = <div className="floor-room">ロッカー</div>

export function EastFloor({ seatByNo, ...tileProps }: FloorProps) {
  const block = (label: string, seats: string[], gridArea: string) => (
    <SeatBlock label={label} seats={seats} gridArea={gridArea} seatByNo={seatByNo} {...tileProps} />
  )
  return (
    <div className="floor-map map-east">
      <div style={{ gridArea: 'lockL1' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockL2' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockL3' }}>{LOCKER}</div>
      {block('Cブロック', ['C1', 'C2', 'C3', 'C4'], 'blkC')}
      {block('Dブロック', ['D1', 'D2', 'D3', 'D4'], 'blkD')}
      {block('Eブロック', ['E1', 'E2', 'E3', 'E4'], 'blkE')}
      {block('Fブロック', ['F1', 'F5', 'F2', 'F6', 'F3', 'F7', 'F4', 'F8'], 'blkF')}
      {block('Gブロック', ['G1', 'G2', 'G3', 'G4'], 'blkG')}
      {block('Hブロック', ['H1', 'H2', 'H3', 'H4'], 'blkH')}
      {block('Iブロック', ['I1', 'I2', 'I3', 'I4'], 'blkI')}
      <div style={{ gridArea: 'lockR1' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockR2' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockR3' }}>{LOCKER}</div>
      <div className="floor-room-stack" style={{ gridArea: 'clinic' }}>
        <div className="floor-room">女子救護室</div>
        <div className="floor-room">男子救護室</div>
        <div className="floor-room">オンライン診療室A</div>
        <div className="floor-room">オンライン診療室B</div>
      </div>
    </div>
  )
}

export function WestFloor({ seatByNo, ...tileProps }: FloorProps) {
  const block = (label: string, seats: string[], gridArea: string) => (
    <SeatBlock label={label} seats={seats} gridArea={gridArea} seatByNo={seatByNo} {...tileProps} />
  )
  return (
    <div className="floor-map map-west">
      <div style={{ gridArea: 'lockL1' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockL2' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockL3' }}>{LOCKER}</div>
      {block('Jブロック', ['J1', 'J2', 'J3', 'J4'], 'blkJ')}
      {block('Kブロック', ['K1', 'K2', 'K3', 'K4'], 'blkK')}
      {block('Lブロック', ['L1', 'L2', 'L3', 'L4'], 'blkL')}
      {block('Mブロック', ['M1', 'M5', 'M2', 'M6', 'M3', 'M7', 'M4', 'M8'], 'blkM')}
      {block('Nブロック', ['N1', 'N2', 'N3', 'N4'], 'blkN')}
      {block('Oブロック', ['O1', 'O2', 'O3', 'O4'], 'blkO')}
      {block('Pブロック', ['P1', 'P2', 'P3', 'P4'], 'blkP')}
      <div style={{ gridArea: 'lockR1' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockR2' }}>{LOCKER}</div>
      <div style={{ gridArea: 'lockR3' }}>{LOCKER}</div>
      <div className="floor-room" style={{ gridArea: 'server' }}>サーバールーム</div>
      <div className="floor-room" style={{ gridArea: 'sports' }}>運動エリア</div>
    </div>
  )
}
