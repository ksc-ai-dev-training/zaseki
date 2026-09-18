import { useMemo } from 'react'
import { useSeatMaster } from '../hooks/useSeatMaster'
import { NorthFloor, EastFloor, WestFloor } from './FloorAreas'
import SeatTile from './SeatTile'
import type { QuarterPlanItem, Seat, Weekday } from '../types'

const WEEKDAYS: { key: Weekday; label: string; headerClass: string }[] = [
  { key: 'mon', label: '月', headerClass: 'bg-blue-700' },
  { key: 'tue', label: '火', headerClass: 'bg-rose-600' },
  { key: 'wed', label: '水', headerClass: 'bg-emerald-600' },
  { key: 'thu', label: '木', headerClass: 'bg-amber-600' },
  { key: 'fri', label: '金', headerClass: 'bg-purple-600' },
]

// 「曜日とPJ座席を確定させる際の確認画面として、設定した内容を一画面で表示してほしい。
// プロジェクトごとに1行のテキストだとわかりにくいので座席のエリア図と併記してほしい」との
// 要望を受けた（2026-09-17新設。当初はProjectSeatAllocation.tsxのWeekdayMatrix内に直接書いていたが、
// 「プロジェクト座席（エリア担当）ではなく別の画面としてみれるようにしたい」との要望を受け、独立した
// 確認画面（pages/ConfirmWeekdays.tsx）からも使えるよう共通コンポーネントとして切り出した）。
// 実際のフロア図（NorthFloor/EastFloor/WestFloor、S-02と同じコンポーネント）を曜日の数だけ縮小して
// 横に並べ、タブ切り替えなしで全曜日の座席の島を一度に見比べられるようにする。座席の状態
// （空き・使用中等）は無関係なため、座席マスタ（日付に依存しない静的な座席一覧、useSeatMaster）
// だけを使い、対象プロジェクトの座席だけを塗る読み取り専用プレビュー（SeatTile.tsxの
// previewColorBySeatId参照）。当初はプロジェクトごとに色分けしていたが、「色だとわかりづらい」
// との指摘を受け（配色が10色循環のためプロジェクト数が多いと衝突もしていた）、色ではなく
// プロジェクト名をタイルにそのまま表示する方式に変更した（2026-09-17修正）。
// 2026-09-17さらに修正: 当初はNORTH／EAST／WESTエリアを別々のセクションに分け、それぞれの中で
// 曜日を横に並べていたが、「エリアごとに分けてありますが一緒にすることは可能ですか」との要望を
// 受け、S-02の「全体表示」と同じ結合レイアウト（.floor-overview、NorthFloorとEast/West
// スタックを1枚の続いたキャンバスにする）を曜日ごとに1つずつ使うよう変更した。エリアで
// セクションを分けず、「曜日」だけを軸に横へ並べる
export default function WeekdaySeatPreview({ plans }: { plans: QuarterPlanItem[] }) {
  const { items: seatMaster } = useSeatMaster('all', 'active', '')

  const seatAreaById = useMemo(() => new Map(seatMaster.map((s) => [s.id, s.area])), [seatMaster])

  const seatByNo = useMemo(() => {
    const map: Record<string, Seat> = {}
    seatMaster.forEach((s) => {
      map[s.seat_no] = {
        id: s.id, seat_no: s.seat_no, seat_type: s.seat_type, status: 'free',
        display_name: null, title: null, avatar_image: null, is_birthday: false,
        reservation_id: null, pos_x: s.pos_x, pos_y: s.pos_y, multi_seat_holder: false,
      }
    })
    return map
  }, [seatMaster])

  // S-07「座席表の配置を編集する」でドラッグして自由配置（pos_x/pos_y）を持つに至った座席は、
  // NorthFloor/EastFloor/WestFloor側の固定グリッド描画からは除外される（FloorAreas.tsxのtile()参照）。
  // Availability.tsxと同様、position:relativeのパネル内に%座標で重ねるオーバーレイとして別途描画
  // しないと、そもそもタイル自体が存在せず色を付けようがない（2026-09-17修正。「色が付与されて
  // いない」との報告を受けた。座席そのものが描画されていなかったのが原因だった）
  const freePositionedByArea = useMemo(() => {
    const map: Record<'NORTH' | 'EAST' | 'WEST', Seat[]> = { NORTH: [], EAST: [], WEST: [] }
    Object.values(seatByNo).forEach((seat) => {
      if (seat.pos_x == null) return
      const area = seatAreaById.get(seat.id)
      if (area) map[area].push(seat)
    })
    return map
  }, [seatByNo, seatAreaById])

  const weekdaysInvolved = WEEKDAYS.filter((w) =>
    plans.some((p) => p.allocated_seats_by_weekday && w.key in p.allocated_seats_by_weekday)
  )

  const areasInvolved = (['NORTH', 'EAST', 'WEST'] as const).filter((area) =>
    plans.some((p) =>
      Object.values(p.allocated_seats_by_weekday ?? {}).some((v) => v.seat_ids.some((id) => seatAreaById.get(id) === area))
    )
  )
  const hasNorth = areasInvolved.includes('NORTH')
  const hasEast = areasInvolved.includes('EAST')
  const hasWest = areasInvolved.includes('WEST')

  if (seatMaster.length === 0 || weekdaysInvolved.length === 0 || areasInvolved.length === 0) return null

  return (
    <div className="space-y-4 rounded border border-slate-400 bg-slate-50 p-3">
      <div className="grid max-h-[88vh] grid-cols-[repeat(2,max-content)] gap-3 overflow-auto pb-1">
        {weekdaysInvolved.map((w) => {
          // previewColorBySeatIdの値自体は使わず（SeatTile.tsx側は名前表示に変えたため）、
          // キーの存在＝「割り当てあり」の合図としてのみ使う。NORTH/EAST/WESTのどのFloorへ渡しても、
          // 各コンポーネントは自分が知っている座席番号だけを描画するため、エリアで絞り込む必要はない
          const previewColorBySeatId: Record<number, string> = {}
          const previewLabelBySeatId: Record<number, string> = {}
          plans.forEach((p) => {
            const ids = p.allocated_seats_by_weekday?.[w.key]?.seat_ids ?? []
            ids.forEach((id) => {
              previewColorBySeatId[id] = '1'
              previewLabelBySeatId[id] = p.project_name
            })
          })
          const tileProps = { onReserve: () => {}, onCancel: () => {}, previewColorBySeatId, previewLabelBySeatId }
          return (
            <div key={w.key} className="shrink-0 overflow-hidden rounded border border-slate-400 bg-white">
              {/* 曜日ラベル（2026-09-17拡大）: 「曜日の表示がわかりにくい」との指摘を受け、小さい
                  グレー文字だったものを、曜日ごとに色分けした帯にして視認性を上げた。2列×複数行に
                  並ぶため、上下にスクロールしても今どの曜日を見ているか一目でわかるようにする狙い */}
              <div className={`px-3 py-1.5 text-center text-base font-bold text-white ${w.headerClass}`}>
                {w.label}曜日
              </div>
              <div className="p-1.5" style={{ zoom: 0.75 }}>
                <div className="floor-overview inline-flex">
                  {hasNorth && (
                    <div className="north-column">
                      <div className="panel-north">
                        <NorthFloor seatByNo={seatByNo} {...tileProps} />
                        {freePositionedByArea.NORTH.map((seat) => (
                          <div key={seat.id} className="free-placed-seat" style={{ left: `${seat.pos_x}%`, top: `${seat.pos_y}%` }}>
                            <SeatTile seat={seat} {...tileProps} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(hasEast || hasWest) && (
                    <div className="floor-overview-stack">
                      {hasEast && (
                        <div className="panel-east">
                          <EastFloor seatByNo={seatByNo} {...tileProps} />
                          {freePositionedByArea.EAST.map((seat) => (
                            <div key={seat.id} className="free-placed-seat" style={{ left: `${seat.pos_x}%`, top: `${seat.pos_y}%` }}>
                              <SeatTile seat={seat} {...tileProps} />
                            </div>
                          ))}
                        </div>
                      )}
                      {hasWest && (
                        <div className="panel-west">
                          <WestFloor seatByNo={seatByNo} {...tileProps} />
                          {freePositionedByArea.WEST.map((seat) => (
                            <div key={seat.id} className="free-placed-seat" style={{ left: `${seat.pos_x}%`, top: `${seat.pos_y}%` }}>
                              <SeatTile seat={seat} {...tileProps} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
