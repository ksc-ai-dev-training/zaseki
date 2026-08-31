import { useState } from 'react'
import { ApiError } from '../lib/api'
import { useSeatHistory } from '../hooks/useSeatHistory'
import { useFloorZoom } from '../hooks/useFloorZoom'
import { NorthFloor, EastFloor, WestFloor } from '../components/FloorAreas'
import type { AreaFilter } from '../hooks/useAvailability'
import type { Seat } from '../types'

function toLocalDateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function todayStr(): string {
  return toLocalDateStr(new Date())
}
function formatDateJa(dateStr: string): string {
  const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']
  const d = new Date(`${dateStr}T00:00:00`)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JA[d.getDay()]}）`
}

const AREA_TABS: { key: AreaFilter; label: string }[] = [
  { key: 'all', label: '全体表示' },
  { key: 'north', label: 'NORTHエリア' },
  { key: 'east', label: 'EASTエリア' },
  { key: 'west', label: 'WESTエリア' },
]

const LEGEND: { cls: string; label: string }[] = [
  { cls: 'status-free', label: '空き' },
  { cls: 'status-occupied', label: '使用中（フリー座席。名前を表示）' },
  { cls: 'status-fixed', label: '固定座席' },
  { cls: 'status-project', label: 'プロジェクト座席' },
  { cls: 'status-pending', label: '未確定（プロジェクト座席の決定待ち）' },
]

// S-10 座席状況の履歴照会。S-02のフロアマップ表示をそのまま流用し、全座席タイルを参照専用
// （SeatTileのreadOnly）で表示する。予約確認・取消・周期予約等のモーダルは持たない（A-45）
export default function SeatHistory() {
  const [date, setDate] = useState(todayStr())
  const [areaFilter, setAreaFilter] = useState<AreaFilter>('all')
  const [searchedDate, setSearchedDate] = useState<string | null>(null)

  const { history, error, isLoading } = useSeatHistory(searchedDate, areaFilter)

  const seatByNo: Record<string, Seat> = {}
  history?.areas.forEach((a) => {
    a.blocks.forEach((b) => {
      b.seats.forEach((s) => {
        seatByNo[s.seat_no] = s
      })
    })
  })
  const floorProps = {
    seatByNo,
    onReserve: () => {},
    onCancel: () => {},
    readOnly: true,
  }

  const areaNames = new Set(history?.areas.map((a) => a.area))
  const hasNorth = areaNames.has('NORTH')
  const hasEast = areaNames.has('EAST')
  const hasWest = areaNames.has('WEST')
  const hasAnyArea = hasNorth || hasEast || hasWest
  const { viewportRef, overviewRef } = useFloorZoom(areaFilter, hasAnyArea)

  const errorMessage = error instanceof ApiError ? error.message : error ? 'エラーが発生しました' : null

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">座席状況の履歴照会</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-10</span>
      </header>

      <div className="p-6">
        <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <span className="text-sm font-medium text-slate-600">照会する日付</span>
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
            className="h-8 rounded border border-slate-300 px-2 text-sm"
          />
          <button
            type="button"
            onClick={() => setSearchedDate(date)}
            disabled={!date}
            className="h-8 shrink-0 rounded bg-blue-800 px-4 text-sm text-white hover:bg-blue-900 disabled:opacity-50"
          >
            検索
          </button>
        </div>

        {errorMessage && (
          <p className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
        )}

        {!searchedDate && !errorMessage && (
          <p className="text-sm text-slate-400">日付を指定して検索してください。</p>
        )}

        {searchedDate && !errorMessage && (
          <>
            <p className="mb-3 text-sm text-slate-500">{formatDateJa(searchedDate)}の座席状況</p>

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

            <div className="seat-legend flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
              {LEGEND.map((l) => (
                <span key={l.cls} className="legend-item flex items-center gap-1.5">
                  <span className={`legend-swatch inline-block h-3.5 w-3.5 rounded-sm ${l.cls}`} />
                  {l.label}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
