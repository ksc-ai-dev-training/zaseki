import { useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useAreas } from '../hooks/useAreas'
import { useSeatMaster, type SeatStatusFilter } from '../hooks/useSeatMaster'
import type { AreaFilter } from '../hooks/useAvailability'
import Modal from '../components/Modal'
import type { SeatMasterItem, SeatType } from '../types'

const PAGE_SIZE = 10

const AREA_OPTIONS: { key: AreaFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'north', label: 'NORTH' },
  { key: 'east', label: 'EAST' },
  { key: 'west', label: 'WEST' },
]
const STATUS_OPTIONS: { key: SeatStatusFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'active', label: '有効' },
  { key: 'retired', label: '廃止' },
]
const SEAT_TYPE_JA: Record<SeatType, string> = { free: 'フリー', fixed: '固定', project: 'プロジェクト' }

interface SeatForm {
  id: number | null
  seatNo: string
  areaId: number
  seatType: SeatType
  active: boolean
  hasFixedAssignment: boolean
  /** 座席配置モードで設定された座標。編集時は変更せずそのまま送り返す（消えないように） */
  posX: number | null
  posY: number | null
}

function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set([1, 2, total - 1, total, current - 1, current, current + 1])
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const result: (number | '…')[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - (sorted[i - 1] as number) > 1) result.push('…')
    result.push(p)
  })
  return result
}

// S-07 座席マスタ管理。座席の追加・編集・廃止を行う（FR-06-1, FR-06-2）
export default function SeatMaster() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [areaFilter, setAreaFilter] = useState<AreaFilter>('all')
  const [statusFilter, setStatusFilter] = useState<SeatStatusFilter>('all')
  const [page, setPage] = useState(1)
  const [form, setForm] = useState<SeatForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SeatMasterItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const { items: areas } = useAreas()
  const { items, isLoading, refresh } = useSeatMaster(areaFilter, statusFilter, query)

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const openAdd = () => {
    setFormError(null)
    setForm({ id: null, seatNo: '', areaId: areas[0]?.id ?? 0, seatType: 'free', active: true, hasFixedAssignment: false, posX: null, posY: null })
  }
  const openEdit = (seat: SeatMasterItem) => {
    setFormError(null)
    setForm({
      id: seat.id, seatNo: seat.seat_no, areaId: seat.area_id, seatType: seat.seat_type,
      active: seat.status === 'active', hasFixedAssignment: seat.has_fixed_assignment,
      posX: seat.pos_x, posY: seat.pos_y,
    })
  }

  const submitForm = async () => {
    if (!form) return
    setSubmitting(true)
    setFormError(null)
    try {
      if (form.id === null) {
        await apiFetch('/api/seats', {
          method: 'POST',
          body: JSON.stringify({ seat_no: form.seatNo, area_id: form.areaId, seat_type: form.seatType }),
        })
      } else {
        await apiFetch(`/api/seats/${form.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            seat_no: form.seatNo, area_id: form.areaId, seat_type: form.seatType,
            status: form.active ? 'active' : 'retired',
            pos_x: form.posX, pos_y: form.posY,
          }),
        })
      }
      setForm(null)
      await refresh()
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiFetch(`/api/seats/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      await refresh()
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : '削除に失敗しました')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">座席マスタ管理</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-07</span>
      </header>

      <div className="p-6">
        <div className="rounded border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
            <input
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              placeholder="座席番号で検索"
              className="h-9 w-full max-w-[220px] rounded border border-slate-300 px-3 text-sm"
            />
            <span className="text-sm text-slate-500">エリア</span>
            <select
              value={areaFilter}
              onChange={(e) => { setAreaFilter(e.target.value as AreaFilter); setPage(1) }}
              className="h-9 rounded border border-slate-300 px-2 text-sm"
            >
              {AREA_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <span className="text-sm text-slate-500">状態</span>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as SeatStatusFilter); setPage(1) }}
              className="h-9 rounded border border-slate-300 px-2 text-sm"
            >
              {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => navigate('/', { state: { placeSeatMode: true } })}
              className="ml-auto rounded border border-blue-800 px-3 py-1.5 text-sm text-blue-800 hover:bg-blue-50"
            >
              座席表に配置する
            </button>
            <button
              type="button"
              onClick={openAdd}
              className="rounded bg-blue-800 px-3 py-1.5 text-sm text-white hover:bg-blue-900"
            >
              ＋ 座席を追加
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-4 py-2">座席番号</th>
                  <th className="px-4 py-2">エリア</th>
                  <th className="px-4 py-2">座席タイプ</th>
                  <th className="px-4 py-2">状態</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((s) => (
                  <tr key={s.id} className="border-b border-slate-100">
                    <td className="px-4 py-2 font-semibold">{s.seat_no}</td>
                    <td className="px-4 py-2">{s.area}</td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{SEAT_TYPE_JA[s.seat_type]}</span>
                    </td>
                    <td className="px-4 py-2">
                      {s.status === 'active' ? (
                        <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700">有効</span>
                      ) : (
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">廃止</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(s)}
                          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          onClick={() => { setDeleteError(null); setDeleteTarget(s) }}
                          className="rounded border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!isLoading && items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-400">該当する座席がありません</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <span className="text-xs text-slate-500">
              全<strong className="text-slate-700">{items.length}</strong>件中
              {items.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1}〜{Math.min(currentPage * PAGE_SIZE, items.length)}件を表示
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                  className="h-7 w-7 rounded border border-slate-300 text-sm disabled:opacity-40"
                >
                  ‹
                </button>
                {pageNumbers(currentPage, totalPages).map((p, i) =>
                  p === '…' ? (
                    <span key={`e${i}`} className="px-1 text-sm text-slate-400">…</span>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPage(p)}
                      className={`h-7 min-w-7 rounded border px-1.5 text-sm ${
                        p === currentPage ? 'border-blue-800 bg-blue-800 text-white' : 'border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {p}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage(currentPage + 1)}
                  className="h-7 w-7 rounded border border-slate-300 text-sm disabled:opacity-40"
                >
                  ›
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {form && (
        <Modal
          title={form.id === null ? '座席を追加' : `座席を編集（${form.seatNo}）`}
          onClose={() => setForm(null)}
          footer={
            <>
              <button type="button" onClick={() => setForm(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitForm} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">保存する</button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-slate-500">座席番号</span>
              <input
                type="text"
                value={form.seatNo}
                onChange={(e) => setForm({ ...form, seatNo: e.target.value })}
                placeholder="例: A1"
                className="h-9 w-full rounded border border-slate-300 px-3"
              />
            </label>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">エリア</span>
                <select
                  value={form.areaId}
                  onChange={(e) => setForm({ ...form, areaId: Number(e.target.value) })}
                  className="h-9 w-full rounded border border-slate-300 px-2"
                >
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">座席タイプ</span>
                <select
                  value={form.seatType}
                  onChange={(e) => setForm({ ...form, seatType: e.target.value as SeatType })}
                  className="h-9 w-full rounded border border-slate-300 px-2"
                >
                  <option value="free">フリー</option>
                  <option value="fixed">固定</option>
                  <option value="project">プロジェクト</option>
                </select>
              </label>
            </div>
            {form.id !== null && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                <span>有効（オフにすると廃止扱いになり、新規予約の対象外になる。FR-06-2）</span>
              </label>
            )}
            {form.hasFixedAssignment && (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                この座席には固定座席の割当があります。座席タイプの変更・廃止は、割当との整合性を個別にご確認ください。
              </p>
            )}
            {formError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{formError}</p>}
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="座席の削除"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setDeleteTarget(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={deleting} onClick={confirmDelete} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">削除する</button>
            </>
          }
        >
          <p className="text-sm">
            座席「{deleteTarget.seat_no}」（{deleteTarget.area}）を削除します。廃止（一覧に残したまま新規予約対象から外す）とは異なり、座席データ自体を完全に削除します。この操作は取り消せません。
          </p>
          {deleteError && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{deleteError}</p>}
        </Modal>
      )}
    </div>
  )
}
