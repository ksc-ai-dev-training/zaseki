import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
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
  /** 今編集中のプロジェクト（曜日）が編集前から元々割り当てられていた座席id（2026-09-24新設。
   * 「5から0にするとき、未確定〔プロジェクト座席〕の色の表示で座席が変更できているのかわかりにくい。
   * 一つの席を変更したら空きの席の色になるようにしたい」との要望を受けた）。selectedSeatIdsから
   * 外れた直後はDB上まだ自分の割当が残っているためstatus='project_pending'のまま返ってきて見た目が
   * 変わらなかったが、この集合に含まれる座席はselectedSeatIdsに無くても空き座席と同じ見た目・
   * クリック可能なタイルとして扱う（クリックすれば選び直せる） */
  originalAllocatedSeatIds?: Set<number>
  /** 他の曜日にこのプロジェクトが使用中の座席id一覧（2026-09-16新設）。「火曜日の座席を選ぶとき、
   * 月曜日はどこに座っているのか一目でわかるようにしてほしい」との要望を受けた。selectedSeatIdsとは
   * 独立に、破線マーカーとして重ねて表示する（見た目のみ、クリック挙動には影響しない） */
  otherWeekdaySeatIds?: Set<number>
  /** 座席の島の一括割当モードで、出社曜日が重なる他プロジェクトが既に選択中の座席id→プロジェクト名
   * （2026-09-17新設）。実際にその日空いていても選べないようにし、専用の表示にする */
  claimedByOtherPlanLabel?: Record<number, string>
  /** S-04「メンバーへの座席確保モード」（座席表からメンバーへ座席を選ぶ、2026-08-31追加） */
  memberAssignMode?: boolean
  /** 座席の島の範囲内かつ未確定（クリックして割り当てられる）座席id */
  memberAssignEligibleIds?: Set<number>
  /** このセッション中に暫定的に割り当て済みの座席id→メンバー氏名（送信前のプレビュー表示用） */
  memberAssignPickedLabels?: Record<number, string>
  onMemberAssignClick?: (seat: Seat) => void
  /** 座席に氏名が表示されている（PERSON_OCCUPIED_STATUSES）座席をクリックしたときにその利用者の
   * プロフィールを表示する（A-87、2026-09-25新設）。「名前が記入されている座席を押したとき
   * プロフィールが出てくるようにしたい」との要望を受けた。自分の予約（status='mine'）は従来どおり
   * 取消モーダルを優先し、対象外とする */
  onViewProfile?: (userId: number) => void
  /** フロアマップの座席配置編集モード（S-07「座席表の配置を編集する」から遷移するplaceSeatMode
   * の拡張、2026-09-10追加）。「座席をドラッグして配置できるようにしてほしい」との要望を受けた。
   * 有効な間は通常の予約・取消を行わず、ドラッグで位置（pos_x/pos_y）を変更できるようにする */
  positionEditMode?: boolean
  onSeatDragPointerDown?: (seat: Seat, e: ReactPointerEvent<HTMLButtonElement>) => void
  onSeatDragPointerMove?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onSeatDragPointerUp?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  /** 曜日確定の確認モーダルで、曜日ごとの座席の島を実際のフロア図に重ねて表示するプレビュー
   * モード（2026-09-17新設。「曜日とPJ座席を確定させる際の確認画面として、座席のエリア図と
   * 併記してほしい」との要望を受けた）。存在すること自体がプレビューモードの合図（クリック・
   * 実際の予約状況は無視し、指定した座席だけを読み取り専用タイルにする）。値はプロジェクト座席
   * （'project'、濃紺）と固定座席（'fixed'、固定座席と同じ紫、2026-09-25追加。「そもそも曜日別の
   * 座席配置なのですが、固定座席も配置されるようにしてほしい」との要望を受けた）を色分けする */
  previewKindBySeatId?: Record<number, 'project' | 'fixed'>
  previewLabelBySeatId?: Record<number, string>
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
      {seat.multi_seat_holder && (
        <span className="seat-multi-badge" title="この人は同じ日に複数の座席を保有しています">⚠</span>
      )}
      {showSeatNo && seat.seat_no}
      {seat.display_name && <span className="seat-tag">{seat.display_name}</span>}
    </>
  )
}

// STATUS_CLASSに加え、multi_seat_holderならseat-multi-holderを重ねて赤色表示にする（2026-09-09追加）
function tileClass(seat: Seat): string {
  return `${STATUS_CLASS[seat.status]}${seat.multi_seat_holder ? ' seat-multi-holder' : ''}`
}

// 他の曜日にこのプロジェクトが使用中の座席への破線マーカー（2026-09-16新設）。選択中（緑の実線
// リング）とは独立に重ねられるよう、outline（box-shadowベースのringとは別レイヤー）を使う
function otherWeekdayClass(seat: Seat, otherWeekdaySeatIds?: Set<number>): string {
  return otherWeekdaySeatIds?.has(seat.id) ? ' outline outline-2 outline-dashed outline-amber-500' : ''
}

// 座席1マス（S-02フロアマップ）。空き→予約モーダル、自分の予約→取消モーダルを開く
export default function SeatTile({
  seat, onReserve, onCancel, style, fixedSeatAssignMode, onAssignFixedSeat, selectedSeatIds, originalAllocatedSeatIds,
  otherWeekdaySeatIds, claimedByOtherPlanLabel, memberAssignMode, memberAssignEligibleIds, memberAssignPickedLabels, onMemberAssignClick,
  positionEditMode, onSeatDragPointerDown, onSeatDragPointerMove, onSeatDragPointerUp,
  previewKindBySeatId, previewLabelBySeatId, onViewProfile,
}: SeatTileProps) {
  if (!seat) {
    return <div className="seat-tile status-occupied opacity-40" style={style}>…</div>
  }

  if (previewKindBySeatId) {
    // 色だけでは似た色同士が見分けにくい（プロジェクト数が多いと配色が循環して衝突もする）との
    // 指摘を受け、色分けではなくプロジェクト名をそのままタイルに表示する方式に変更した
    // （2026-09-17修正）。固定座席（'fixed'）は通常のフロアマップと同じ紫（.status-fixed）、
    // プロジェクト座席（'project'）は濃紺で区別する（2026-09-25追加）
    const kind = previewKindBySeatId[seat.id]
    const label = previewLabelBySeatId?.[seat.id]
    const colors =
      kind === 'fixed'
        ? { background: '#ede9fe', borderColor: '#a78bfa', color: '#5b21b6' }
        : kind === 'project'
          ? { background: '#1e3a8a', borderColor: '#1e3a8a', color: '#ffffff' }
          : { background: '#f8fafc', borderColor: '#e2e8f0', color: '#94a3b8' }
    return (
      <div
        className="seat-tile overflow-hidden"
        style={{
          ...style,
          ...colors,
          fontWeight: label ? 600 : 400,
          fontSize: label ? '9px' : undefined,
          lineHeight: 1.2,
          padding: '1px 2px',
          whiteSpace: 'normal',
          wordBreak: 'break-all',
          textAlign: 'center',
        }}
        title={label ? `${label}（${seat.seat_no}）` : undefined}
      >
        {label ?? seat.seat_no}
      </div>
    )
  }

  if (positionEditMode) {
    // 座席配置編集モード中は通常の予約・取消・他モードの操作を行わず、ドラッグの起点にする
    // （2026-09-10追加）。setPointerCaptureにより、ポインタがこのボタンの外に出てもmove/up
    // イベントはこの要素で受け続けるため、move/upハンドラも同じ要素に付ける
    return (
      <button
        type="button"
        className="seat-tile status-free cursor-grab select-none touch-none active:cursor-grabbing"
        style={style}
        onPointerDown={(e) => { e.preventDefault(); onSeatDragPointerDown?.(seat, e) }}
        onPointerMove={onSeatDragPointerMove}
        onPointerUp={onSeatDragPointerUp}
      >
        {seat.seat_no}
      </button>
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
      <div className={`seat-tile opacity-40 ${tileClass(seat)}`} style={style} title={seat.title ?? undefined}>
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
      <div className={`seat-tile opacity-40 ${tileClass(seat)}`} style={style}>
        <SeatContent seat={seat} />
      </div>
    )
  }

  // 座席の島の一括割当モードで、実際は空いている（status='free'）が出社曜日が重なる他プロジェクトが
  // 既に選択中の座席（2026-09-17新設。「前に決めた座席の内容が消えている」との指摘を受けた。以前は
  // このケースをseatByNo側でstatus='occupied'に書き換えて対処していたが、それだと表示中の日付に
  // よらず常に使用中に固定されてしまっていた。実際の空き状況の表示はそのままに、ここでだけ選択不可の
  // 専用タイルに切り替える。自分自身（selectedSeatIds、選んでいる本人のプロジェクト）と重なる
  // ことはない前提だが、念のため優先する
  const claimedByOtherPlan = seat.status === 'free' && !selectedSeatIds?.has(seat.id) ? claimedByOtherPlanLabel?.[seat.id] : undefined
  if (claimedByOtherPlan) {
    return (
      <div
        className="seat-tile"
        style={{ ...style, background: '#fce7f3', borderColor: '#f9a8d4', color: '#9d174d' }}
        title={`「${claimedByOtherPlan}」がこの一括割当の中で選択中の座席です`}
      >
        {seat.seat_no}
        <span className="seat-tag">{claimedByOtherPlan}</span>
      </div>
    )
  }

  if (
    (seat.status === 'free' && seat.seat_type === 'free') ||
    selectedSeatIds?.has(seat.id) ||
    // 2026-09-24追加:「一つの席を変更したら空きの席の色になるようにしたい」との要望。選択を外した
    // 直後はDB上まだ自分の割当が残っているためstatus='project_pending'のまま返ってくるが、元々
    // 自分（このプロジェクト・曜日）の座席だった分は、選択が外れていても空き座席と同じ見た目・
    // クリック可能な状態にする（選び直しもできる）
    originalAllocatedSeatIds?.has(seat.id)
  ) {
    // 座席の島の割当・編集モードでは、既に選択済みの座席は実際の予約状況に関わらずトグル
    // できるようにする（編集時、自分のプロジェクトの既存の個人予約がある座席も選択解除
    // できる必要があるため。2026-08-28追加）
    const selected = selectedSeatIds?.has(seat.id)
    // 一括割当モードで自分（選択中）のプロジェクトが確定曜日として持つ座席にも、他プロジェクトと
    // 同じくラベルを付けて表示を安定させる（2026-09-17追加。「プロジェクトを順番に押していくと
    // 座席が消えたり出てきたりする」との指摘を受けた。以前は自分自身の座席だけラベルなしだった
    // ため、選択中のプロジェクトが切り替わるたびに表示が入れ替わって見えていた）
    const ownLabel = selected ? claimedByOtherPlanLabel?.[seat.id] : undefined
    return (
      <button
        type="button"
        className={`seat-tile status-free ${selected ? 'ring-2 ring-green-600' : ''}${otherWeekdayClass(seat, otherWeekdaySeatIds)}`}
        style={style}
        title={otherWeekdaySeatIds?.has(seat.id) ? '他の曜日にこのプロジェクトが使用中の座席です' : undefined}
        onClick={() => onReserve(seat)}
      >
        {seat.seat_no}
        {ownLabel && <span className="seat-tag">{ownLabel}</span>}
      </button>
    )
  }
  if (seat.status === 'mine') {
    return (
      <button type="button" className={`seat-tile ${tileClass(seat)}`} style={style} onClick={() => onCancel(seat)}>
        <SeatContent seat={seat} />
      </button>
    )
  }
  // 座席に氏名が表示されている（他利用者が使用中・固定座席・プロジェクト座席個人確定済み）座席は、
  // クリックするとその利用者のプロフィールを表示する（2026-09-25追加）
  if (PERSON_OCCUPIED_STATUSES.has(seat.status) && seat.user_id !== null && onViewProfile) {
    return (
      <button
        type="button"
        className={`seat-tile ${tileClass(seat)}${otherWeekdayClass(seat, otherWeekdaySeatIds)}`}
        style={style}
        title={seat.title ?? (otherWeekdaySeatIds?.has(seat.id) ? '他の曜日にこのプロジェクトが使用中の座席です' : 'クリックするとプロフィールを表示します')}
        onClick={() => onViewProfile(seat.user_id as number)}
      >
        <SeatContent seat={seat} />
      </button>
    )
  }
  return (
    <div
      className={`seat-tile ${tileClass(seat)}${otherWeekdayClass(seat, otherWeekdaySeatIds)}`}
      style={style}
      title={seat.title ?? (otherWeekdaySeatIds?.has(seat.id) ? '他の曜日にこのプロジェクトが使用中の座席です' : undefined)}
    >
      <SeatContent seat={seat} />
    </div>
  )
}
