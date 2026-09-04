import { useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useProxyCandidates } from '../hooks/useProxyCandidates'
import { useProxySearch, type ProxySeatTypeFilter } from '../hooks/useProxySearch'
import { usePeriodGrid } from '../hooks/usePeriodGrid'
import { useIsMobile } from '../hooks/useIsMobile'
import type { AreaFilter } from '../hooks/useAvailability'
import Modal from '../components/Modal'
import type { AssignFixedSeatFor, ProxyBookingFor, ProxyRow, SeatType } from '../types'

const SEAT_TYPE_OPTIONS: { key: ProxySeatTypeFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'free', label: 'フリー座席' },
  { key: 'fixed', label: '固定座席' },
  { key: 'project', label: 'プロジェクト座席' },
]
const SEAT_TYPE_JA: Record<'free' | 'fixed' | 'project', string> = { free: 'フリー座席', fixed: '固定座席', project: 'プロジェクト座席' }
const SEAT_STATUS_JA: Record<SeatType, string> = { free: 'フリー', fixed: '固定', project: 'PJ' }
const SEAT_STATUS_BADGE_CLASS: Record<SeatType, string> = {
  free: 'bg-slate-100 text-slate-600',
  fixed: 'bg-blue-50 text-blue-700',
  project: 'bg-amber-50 text-amber-700',
}
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']

const AREA_TABS: { key: AreaFilter; label: string }[] = [
  { key: 'all', label: '全体表示' },
  { key: 'north', label: 'NORTHエリア' },
  { key: 'east', label: 'EASTエリア' },
  { key: 'west', label: 'WESTエリア' },
]

// 期間ビュー（S-02のusePeriodAvailabilityと同じ表）の列幅。左側の日付系4列はスクロール中も
// 見えるよう固定する（position: sticky、S-02を踏襲）
const PERIOD_COL_DATE_W = 96
const PERIOD_COL_WD_W = 44
const PERIOD_COL_RES_W = 56
const PERIOD_COL_VAC_W = 56

function formatDateJa(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  return `${dateStr}（${WEEKDAY_JA[d.getDay()]}）`
}
function formatDateShort(dateStr: string): { md: string; wd: string } {
  const d = new Date(`${dateStr}T00:00:00`)
  return { md: `${d.getMonth() + 1}/${d.getDate()}`, wd: WEEKDAY_JA[d.getDay()] }
}

// S-11 代理予約・取消。実際の座席選択（新規の代理予約）はここでは行わず、S-02のフロアマップへ
// 「代理予約モード」で遷移して行う（4.11節）
export default function ProxyBooking() {
  const navigate = useNavigate()
  const [candidateQuery, setCandidateQuery] = useState('')
  const { items: candidates, isLoading: candidatesLoading } = useProxyCandidates(candidateQuery)

  // 期間ビュー（取消・変更の主画面）: S-02のA-07と同じ座席×日付のマトリクス（A-69）。
  // 「座席の予約・割当を代理で取り消すをS-02の期間ビューのような画面にしたい」との要望を受けて
  // 2026-09-03に全面刷新した。氏名では絞り込まず、対象エリア・表示期間のみで全座席の状況を表示する
  const [gridAreaFilter, setGridAreaFilter] = useState<AreaFilter>('all')
  const [gridPeriodOverride, setGridPeriodOverride] = useState<{ start: string; end: string } | null>(null)
  const { grid, isLoading: gridLoading, refresh: refreshGrid } = usePeriodGrid(gridPeriodOverride?.start, gridPeriodOverride?.end, gridAreaFilter)
  const gridPeriodStart = gridPeriodOverride?.start ?? grid?.start ?? ''
  const gridPeriodEnd = gridPeriodOverride?.end ?? grid?.end ?? ''
  const resetGridPeriod = () => setGridPeriodOverride(null)
  const isMobile = useIsMobile()
  const periodVacantLeftOffset = isMobile ? PERIOD_COL_DATE_W : PERIOD_COL_DATE_W + PERIOD_COL_WD_W + PERIOD_COL_RES_W

  // 氏名・期間でまとめて取り消す（一括取消、既存のA-46・A-48はそのまま流用）。上の期間ビューとは
  // 独立した検索条件（表示期間はYYYY-MM単位）で対象を絞り込む
  const [rowUserName, setRowUserName] = useState('')
  const [seatType, setSeatType] = useState<ProxySeatTypeFilter>('all')
  const [bulkPeriodStart, setBulkPeriodStart] = useState('')
  const [bulkPeriodEnd, setBulkPeriodEnd] = useState('')
  const { items: rows, refresh: refreshRows } = useProxySearch(rowUserName, seatType, bulkPeriodStart, bulkPeriodEnd)

  const [cancelTarget, setCancelTarget] = useState<ProxyRow | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [bulkModalOpen, setBulkModalOpen] = useState(false)
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const bulkTargets = rows.filter((r) => r.kind === 'reservation')
  const bulkCancelEnabled = rowUserName.trim() !== '' && bulkPeriodStart !== '' && bulkPeriodEnd !== '' && bulkTargets.length > 0

  const goProxyBook = (target: ProxyBookingFor) => {
    navigate('/', { state: { proxyBookingFor: target } })
  }

  // 期間ビューのセル（予約・固定座席の割当）をクリックして取消・変更の対象にする
  // （'free'のセルは操作対象がないため何もしない）
  const openGridCell = (seat: { seat_no: string; area: 'NORTH' | 'EAST' | 'WEST'; seat_type: SeatType }, date: string, cell: {
    status: string; kind: 'reservation' | 'fixed' | null; id: number | null; user_id: number | null
    user_name: string | null; project_name: string | null
  }) => {
    if (cell.kind === null || cell.id === null || cell.user_id === null || cell.user_name === null) return
    setActionError(null)
    setCancelTarget({
      kind: cell.kind, id: cell.id, user_id: cell.user_id, user_name: cell.user_name,
      seat_type: seat.seat_type, date: cell.kind === 'fixed' ? null : date,
      seat_no: seat.seat_no, area: seat.area, project_name: cell.project_name,
    })
  }

  const confirmCancel = async () => {
    if (!cancelTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      if (cancelTarget.kind === 'fixed') {
        await apiFetch(`/api/fixed-seat-assignments/${cancelTarget.id}`, { method: 'DELETE' })
      } else {
        await apiFetch(`/api/reservations/proxy/${cancelTarget.id}`, { method: 'DELETE' })
      }
      setCancelTarget(null)
      await Promise.all([refreshRows(), refreshGrid()])
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : (cancelTarget.kind === 'fixed' ? '解除に失敗しました' : '取消に失敗しました'))
    } finally {
      setSubmitting(false)
    }
  }

  // 「変更」: 現在の予約・割当を取り消したうえで、S-02へ代理予約モード（フリー座席）・固定座席指定
  // モード（固定座席）で遷移し、続けて新しい座席を選べるようにする（2026-09-03追加。「取り消しは
  // 現状実装されているが、変更も追加してほしい」との要望を受けた。専用の変更APIは持たず、既存の
  // 取消系API〔A-48・A-21〕＋代理予約系の画面遷移〔A-47の入口〕を組み合わせて実現する）
  const confirmChange = async () => {
    if (!cancelTarget) return
    setSubmitting(true)
    setActionError(null)
    try {
      if (cancelTarget.kind === 'fixed') {
        await apiFetch(`/api/fixed-seat-assignments/${cancelTarget.id}`, { method: 'DELETE' })
        const target: AssignFixedSeatFor = { userId: cancelTarget.user_id, userName: cancelTarget.user_name }
        navigate('/', { state: { assignFixedSeatFor: target } })
      } else {
        await apiFetch(`/api/reservations/proxy/${cancelTarget.id}`, { method: 'DELETE' })
        goProxyBook({ userId: cancelTarget.user_id, userName: cancelTarget.user_name })
      }
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '変更に失敗しました')
      setSubmitting(false)
    }
  }

  const confirmBulkCancel = async () => {
    setBulkSubmitting(true)
    setBulkError(null)
    try {
      await Promise.all(
        bulkTargets.map((r) => apiFetch(`/api/reservations/proxy/${r.id}`, { method: 'DELETE' }))
      )
      setBulkModalOpen(false)
      await Promise.all([refreshRows(), refreshGrid()])
    } catch (e) {
      setBulkError(e instanceof ApiError ? e.message : '一括取消に失敗しました')
    } finally {
      setBulkSubmitting(false)
    }
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">代理予約・取消（対象者選択）</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-11</span>
      </header>

      <div className="space-y-6 p-6">
        <div className="rounded border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 font-semibold">代理予約する対象者を選ぶ</div>
          <div className="p-4">
            <input
              type="search"
              value={candidateQuery}
              onChange={(e) => setCandidateQuery(e.target.value)}
              placeholder="氏名で検索（登録済みの利用者が対象）"
              className="mb-3 h-9 w-full max-w-sm rounded border border-slate-300 px-3 text-sm"
            />
            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="sticky top-0 z-10 border-b border-slate-200 bg-white text-left text-slate-500">
                    <th className="pb-2 pr-3">氏名</th>
                    <th className="pb-2 pr-3">雇用形態</th>
                    <th className="pb-2 pr-3">現在の座席利用状況</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.user_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{c.user_name}</td>
                      <td className="py-2 pr-3">{c.employment_type}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded px-2 py-0.5 text-xs ${SEAT_STATUS_BADGE_CLASS[c.current_status]}`}>
                          {SEAT_STATUS_JA[c.current_status]}
                        </span>
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => goProxyBook({ userId: c.user_id, userName: c.user_name })}
                          className="rounded bg-blue-800 px-3 py-1 text-xs text-white hover:bg-blue-900"
                        >
                          この人を代理予約する
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!candidatesLoading && candidates.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-slate-400">対象者が見つかりません</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="rounded border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 font-semibold">座席の予約・割当を代理で取り消す・変更する</div>
          <div className="p-4">
            <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <span className="shrink-0 text-sm font-medium text-slate-600">表示期間</span>
              <input
                type="date"
                value={gridPeriodStart}
                min={grid?.full_start}
                max={grid?.full_end}
                disabled={!grid}
                onChange={(e) => setGridPeriodOverride({ start: e.target.value, end: gridPeriodEnd })}
                className="h-8 rounded border border-slate-300 px-2 text-sm"
              />
              <span className="text-center text-sm text-slate-500 sm:text-left">〜</span>
              <input
                type="date"
                value={gridPeriodEnd}
                min={grid?.full_start}
                max={grid?.full_end}
                disabled={!grid}
                onChange={(e) => setGridPeriodOverride({ start: gridPeriodStart, end: e.target.value })}
                className="h-8 rounded border border-slate-300 px-2 text-sm"
              />
              <button
                type="button"
                onClick={resetGridPeriod}
                className="h-8 shrink-0 rounded border border-slate-300 px-3 text-sm hover:bg-slate-50 sm:ml-2"
              >
                予約可能期間全体を表示
              </button>
            </div>

            <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200">
              {AREA_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setGridAreaFilter(t.key)}
                  className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                    gridAreaFilter === t.key
                      ? 'border-blue-800 font-semibold text-blue-800'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {gridLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

            {grid && (
              <div className="max-h-[70vh] overflow-auto rounded border border-slate-300 bg-white">
                <table className="text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th
                        className="sticky top-0 left-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-3 py-2"
                        style={{ minWidth: PERIOD_COL_DATE_W }}
                      >
                        日付
                      </th>
                      {!isMobile && (
                        <th
                          className="sticky top-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 py-2 text-center"
                          style={{ left: PERIOD_COL_DATE_W, minWidth: PERIOD_COL_WD_W }}
                        >
                          曜日
                        </th>
                      )}
                      {!isMobile && (
                        <th
                          className="sticky top-0 z-30 whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 py-2 text-center"
                          style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W, minWidth: PERIOD_COL_RES_W }}
                        >
                          予約数
                        </th>
                      )}
                      <th
                        className="sticky top-0 z-30 whitespace-nowrap border-r border-b border-slate-300 bg-slate-100 px-2 py-2 text-center"
                        style={{ left: periodVacantLeftOffset, minWidth: PERIOD_COL_VAC_W }}
                      >
                        空席
                      </th>
                      {grid.seats.map((seat) => (
                        <th
                          key={seat.id}
                          className="sticky top-0 z-20 min-w-[64px] whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-1 py-2 text-center text-xs font-normal"
                        >
                          <div className="font-semibold text-slate-700">{seat.seat_no}</div>
                          <div className="text-slate-400">{SEAT_TYPE_JA[seat.seat_type]}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.dates.map((d) => {
                      const reserved = grid.seats.filter((s) => (s.days[d]?.status ?? 'free') !== 'free').length
                      const vacant = grid.seats.length - reserved
                      const { wd } = formatDateShort(d)
                      return (
                        <tr key={d} className="border-b border-slate-300">
                          <td className="sticky left-0 z-10 whitespace-nowrap border-r border-slate-300 bg-white px-3 py-1.5 font-semibold">
                            {d.replaceAll('-', '/')}
                          </td>
                          {!isMobile && (
                            <td
                              className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-500"
                              style={{ left: PERIOD_COL_DATE_W }}
                            >
                              {wd}
                            </td>
                          )}
                          {!isMobile && (
                            <td
                              className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-600"
                              style={{ left: PERIOD_COL_DATE_W + PERIOD_COL_WD_W }}
                            >
                              {reserved}
                            </td>
                          )}
                          <td
                            className="sticky z-10 whitespace-nowrap border-r border-slate-300 bg-white px-2 py-1.5 text-center text-slate-600"
                            style={{ left: periodVacantLeftOffset }}
                          >
                            {vacant}
                          </td>
                          {grid.seats.map((seat) => {
                            const cell = seat.days[d]
                            const status = cell?.status ?? 'free'
                            return (
                              <td key={seat.id} className="border-r border-slate-200 px-1 py-1.5 text-center">
                                {status === 'free' ? (
                                  <span className="whitespace-nowrap text-[11px] text-slate-300">空き</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => openGridCell(seat, d, cell)}
                                    title="クリックして取消・変更"
                                    className={`whitespace-nowrap text-[11px] underline decoration-dotted hover:opacity-70 ${
                                      status === 'fixed' ? 'text-violet-700' : cell?.project_name ? 'text-amber-700' : 'text-slate-600'
                                    }`}
                                  >
                                    {cell?.user_name}
                                  </button>
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

          <div className="border-t border-slate-200 p-4">
            <div className="mb-2 text-xs font-semibold text-slate-500">氏名・期間でまとめて取り消す</div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="search"
                value={rowUserName}
                onChange={(e) => setRowUserName(e.target.value)}
                placeholder="氏名で検索"
                className="h-9 w-full max-w-[220px] rounded border border-slate-300 px-3 text-sm"
              />
              <span className="text-sm text-slate-500">座席種別</span>
              <select
                value={seatType}
                onChange={(e) => setSeatType(e.target.value as ProxySeatTypeFilter)}
                className="h-9 rounded border border-slate-300 px-2 text-sm"
              >
                {SEAT_TYPE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <span className="text-sm text-slate-500">期間</span>
              <input
                type="month"
                value={bulkPeriodStart}
                onChange={(e) => setBulkPeriodStart(e.target.value)}
                className="h-9 rounded border border-slate-300 px-2 text-sm"
              />
              <span className="text-slate-400">〜</span>
              <input
                type="month"
                value={bulkPeriodEnd}
                onChange={(e) => setBulkPeriodEnd(e.target.value)}
                className="h-9 rounded border border-slate-300 px-2 text-sm"
              />
              <button
                type="button"
                disabled={!bulkCancelEnabled}
                onClick={() => { setBulkError(null); setBulkModalOpen(true) }}
                className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                title={bulkCancelEnabled ? undefined : '氏名・期間（開始・終了）を指定すると使えます'}
              >
                この条件に一致する予約をまとめて取り消す（{bulkTargets.length}件）
              </button>
            </div>
          </div>
        </div>
      </div>

      {cancelTarget && (
        <Modal
          title={cancelTarget.kind === 'fixed' ? '座席の解除・変更（代理）' : '予約の取消・変更（代理）'}
          onClose={() => setCancelTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setCancelTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={confirmChange} className="rounded border border-blue-300 px-4 py-1.5 text-sm text-blue-800 disabled:opacity-50">
                変更する（座席を選び直す）
              </button>
              <button type="button" disabled={submitting} onClick={confirmCancel} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">
                {cancelTarget.kind === 'fixed' ? '解除する' : '取消する'}
              </button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">対象者</dt><dd>{cancelTarget.user_name}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席種別</dt><dd>{SEAT_TYPE_JA[cancelTarget.seat_type]}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">日付</dt><dd>{cancelTarget.date ? formatDateJa(cancelTarget.date) : '－'}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席</dt><dd>{cancelTarget.seat_no}{cancelTarget.project_name && `（${cancelTarget.project_name}）`}</dd></div>
          </dl>
          <p className="mt-3 text-sm text-slate-600">
            {cancelTarget.kind === 'fixed'
              ? 'この固定座席の割当を解除します。「変更する」を選ぶと、解除したうえで続けて別の固定座席を指定できます。'
              : 'この予約を取り消します。「変更する」を選ぶと、取り消したうえで続けて別の座席を代理予約できます。'}
          </p>
          {actionError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
        </Modal>
      )}

      {bulkModalOpen && (
        <Modal
          title="予約の一括取消（代理）"
          onClose={() => setBulkModalOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setBulkModalOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={bulkSubmitting} onClick={confirmBulkCancel} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">
                取り消す
              </button>
            </>
          }
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">氏名（検索条件）</dt><dd>{rowUserName}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">座席種別</dt><dd>{SEAT_TYPE_OPTIONS.find((o) => o.key === seatType)?.label}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">表示期間</dt><dd>{bulkPeriodStart} 〜 {bulkPeriodEnd}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">対象件数</dt><dd>{bulkTargets.length}件</dd></div>
          </dl>
          <p className="mt-3 text-sm text-slate-600">
            上記の条件に一致する予約（固定座席の割当を除く）を、まとめて取り消します。よろしいですか？
          </p>
          {bulkError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{bulkError}</p>}
        </Modal>
      )}
    </div>
  )
}
