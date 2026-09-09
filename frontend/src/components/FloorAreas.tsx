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
  // 座席の島の割当モード（selectedSeatIdsがある時のみ意味を持つ）で、ブロックのラベルをクリック
  // したときにそのブロック内の座席をまとめて選択・解除するコールバック（2026-09-09追加）
  onToggleBlock?: (seatIds: number[], select: boolean) => void
  memberAssignMode?: boolean
  memberAssignEligibleIds?: Set<number>
  memberAssignPickedLabels?: Record<number, string>
  onMemberAssignClick?: (seat: Seat) => void
}

// ブロックの見出しラベル。座席の島の割当モード（selectedSeatIds・onToggleBlockが両方渡された時）
// のみクリック可能にし、そのブロック内で選択可能な座席（空き、または既に選択済み）をまとめて
// 選択／解除する。それ以外の画面では従来どおりただの見出しテキストとして表示する
// （2026-09-09追加。「座席タイルを1つずつクリックする必要があり工数が多すぎる」との指摘を受けた）
function SeatBlockLabel({ label, seatNos, seatByNo, selectedSeatIds, onToggleBlock }: {
  label: string
  seatNos: string[]
  seatByNo: Record<string, Seat>
  selectedSeatIds?: Set<number>
  onToggleBlock?: (seatIds: number[], select: boolean) => void
}) {
  if (!selectedSeatIds || !onToggleBlock) {
    return <div className="seat-block-label text-xs font-semibold text-slate-500 mb-1">{label}</div>
  }
  const selectableIds = seatNos
    .map((no) => seatByNo[no])
    .filter((s): s is Seat => Boolean(s) && ((s.status === 'free' && s.seat_type === 'free') || selectedSeatIds.has(s.id)))
    .map((s) => s.id)
  if (selectableIds.length === 0) {
    return <div className="seat-block-label text-xs font-semibold text-slate-400 mb-1">{label}</div>
  }
  const allSelected = selectableIds.every((id) => selectedSeatIds.has(id))
  return (
    <button
      type="button"
      onClick={() => onToggleBlock(selectableIds, !allSelected)}
      title={allSelected ? 'クリックしてこのブロックの選択をまとめて解除' : 'クリックしてこのブロックの空き座席をまとめて選択'}
      className={`seat-block-label mb-1 block w-full text-left text-xs font-semibold underline decoration-dotted ${
        allSelected ? 'text-green-700' : 'text-blue-700 hover:text-blue-900'
      }`}
    >
      {label}
    </button>
  )
}

const pillarStyle: CSSProperties = { width: 40, height: 36, justifySelf: 'center', alignSelf: 'center' }

// 画面モックアップ（docs/03_画面モックアップ/S-02_availability.html）の実際の
// フロアマップ画像に基づく配置をそのまま再現する。座席の状態のみ実データに差し替える。

export function NorthFloor({ seatByNo, ...tileProps }: FloorProps) {
  const tile = (no: string, style: CSSProperties) => (
    <SeatTile seat={seatByNo[no]} style={style} {...tileProps} />
  )
  const label = (text: string, seatNos: string[]) => (
    <SeatBlockLabel
      label={text}
      seatNos={seatNos}
      seatByNo={seatByNo}
      selectedSeatIds={tileProps.selectedSeatIds}
      onToggleBlock={tileProps.onToggleBlock}
    />
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="floor-block">
        {label('周辺スペース・Bブロック（ロッカー）', ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'])}
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
        {label('Aブロック', ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11'])}
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
      <SeatBlockLabel
        label={label}
        seatNos={seats}
        seatByNo={seatByNo}
        selectedSeatIds={tileProps.selectedSeatIds}
        onToggleBlock={tileProps.onToggleBlock}
      />
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
