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
  /** S-10「座席状況の履歴照会」。参照専用表示とし、状態によらずクリック不可のdivで表示する（2026-08-31追加） */
  readOnly?: boolean
  /** S-04「メンバーへの座席確保モード」（座席表からメンバーへ座席を選ぶ、2026-08-31追加） */
  memberAssignMode?: boolean
  /** 座席の島の範囲内かつ未確定（クリックして割り当てられる）座席id */
  memberAssignEligibleIds?: Set<number>
  /** このセッション中に暫定的に割り当て済みの座席id→メンバー氏名（送信前のプレビュー表示用） */
  memberAssignPickedLabels?: Record<number, string>
  onMemberAssignClick?: (seat: Seat) => void
}

// 実際に利用者が使用中の座席（自分の予約・使用中・固定座席・プロジェクト座席個人確定済み）は
// 座席番号ではなく氏名（苗字）を表示する（2026-08-31訂正。「座席番号と苗字が表示されているが
// 苗字のみの表示にしてほしい」との要望を受けた）。未確定（project_pending）はプロジェクトの
// 略称を表示するだけで特定の個人ではないため対象外とし、従来どおり座席番号も表示する。
const PERSON_OCCUPIED_STATUSES = new Set<SeatStatus>(['mine', 'occupied', 'occupied_fixed', 'project_confirmed'])

// 座席タイルの中身（座席番号または氏名、マイプロフィール・S-12のアイコン・誕生日バッジ）。
// アイコンを登録している利用者は、苗字とあわせてアイコンも表示する（FR-08-3）
function SeatContent({ seat }: { seat: Seat }) {
  const showSeatNo = !PERSON_OCCUPIED_STATUSES.has(seat.status)
  return (
    <>
      {seat.avatar_image && <img src={seat.avatar_image} alt="" className="seat-avatar" />}
      {seat.is_birthday && <span className="seat-birthday-badge" title="本日誕生日です">🎂</span>}
      {showSeatNo && seat.seat_no}
      {seat.display_name && <span className="seat-tag">{seat.display_name}</span>}
    </>
  )
}

// 座席1マス（S-02フロアマップ）。空き→予約モーダル、自分の予約→取消モーダルを開く
export default function SeatTile({
  seat, onReserve, onCancel, style, fixedSeatAssignMode, onAssignFixedSeat, selectedSeatIds, readOnly,
  memberAssignMode, memberAssignEligibleIds, memberAssignPickedLabels, onMemberAssignClick,
}: SeatTileProps) {
  if (!seat) {
    return <div className="seat-tile status-occupied opacity-40" style={style}>…</div>
  }

  if (readOnly) {
    return (
      <div className={`seat-tile ${STATUS_CLASS[seat.status]}`} style={style} title={seat.title ?? undefined}>
        <SeatContent seat={seat} />
      </div>
    )
  }

  if (memberAssignMode) {
    // 座席の島の範囲内かつ未確定の座席のみ選択可能（2026-08-31追加）。クリックすると割り当てる
    // メンバーを選ぶモーダルが開く（Availability.tsx側）。既に暫定割当済みの座席は再クリックで解除できる
    const eligible = memberAssignEligibleIds?.has(seat.id) ?? false
    const pickedLabel = memberAssignPickedLabels?.[seat.id]
    if (eligible) {
      return (
        <button
          type="button"
          className={`seat-tile status-free ${pickedLabel ? 'ring-2 ring-green-600' : ''}`}
          style={style}
          onClick={() => onMemberAssignClick?.(seat)}
        >
          {seat.seat_no}
          {pickedLabel && <span className="seat-tag">{pickedLabel}</span>}
        </button>
      )
    }
    return (
      <div className={`seat-tile opacity-40 ${STATUS_CLASS[seat.status]}`} style={style} title={seat.title ?? undefined}>
        <SeatContent seat={seat} />
      </div>
    )
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
        <SeatContent seat={seat} />
      </div>
    )
  }

  if ((seat.status === 'free' && seat.seat_type === 'free') || selectedSeatIds?.has(seat.id)) {
    // 座席の島の割当・編集モードでは、既に選択済みの座席は実際の予約状況に関わらずトグル
    // できるようにする（編集時、自分のプロジェクトの既存の個人予約がある座席も選択解除
    // できる必要があるため。2026-08-28追加）
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
        <SeatContent seat={seat} />
      </button>
    )
  }
  return (
    <div className={`seat-tile ${STATUS_CLASS[seat.status]}`} style={style} title={seat.title ?? undefined}>
      <SeatContent seat={seat} />
    </div>
  )
}
