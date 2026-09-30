import { useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useAreas } from '../hooks/useAreas'
import { useSeatMaster, type SeatStatusFilter } from '../hooks/useSeatMaster'
import { usePagination } from '../hooks/usePagination'
import type { AreaFilter } from '../hooks/useAvailability'
import Modal from '../components/Modal'
import Pagination from '../components/Pagination'
import type { PosZone, SeatMasterItem, SeatType } from '../types'

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
  /** 座席配置モードで設定された座標・基準領域。編集時は変更せずそのまま送り返す（消えないように） */
  posX: number | null
  posY: number | null
  posZone: PosZone
}

// 座席の一括追加（A-77、2026-09-09追加）。連番プレフィックス欄は、この職場の座席番号が
// 「A1」「Q12」のようにプレフィックス＋連番であることが多いため、そこから座席番号一覧を
// 生成する補助入力（必須ではなく、seatNosTextを直接編集してもよい）
interface BulkSeatForm {
  areaId: number
  seatNosText: string
  rangePrefix: string
  rangeStart: string
  rangeEnd: string
}

interface BulkSeatResult {
  created_count: number
  skipped: string[]
}

// S-07 座席マスタ管理。座席の追加・編集・廃止を行う（FR-06-1, FR-06-2）
export default function SeatMaster() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [areaFilter, setAreaFilter] = useState<AreaFilter>('all')
  const [statusFilter, setStatusFilter] = useState<SeatStatusFilter>('all')
  const [form, setForm] = useState<SeatForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SeatMasterItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [bulkForm, setBulkForm] = useState<BulkSeatForm | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkSeatResult | null>(null)

  const { items: areas } = useAreas()
  const { items, isLoading, refresh } = useSeatMaster(areaFilter, statusFilter, query)
  const { page, setPage, pageSize, setPageSize, totalPages, pageItems, totalCount } = usePagination(items)

  const openAdd = () => {
    setFormError(null)
    setForm({ id: null, seatNo: '', areaId: areas[0]?.id ?? 0, seatType: 'free', active: true, hasFixedAssignment: false, posX: null, posY: null, posZone: null })
  }
  const openEdit = (seat: SeatMasterItem) => {
    setFormError(null)
    setForm({
      id: seat.id, seatNo: seat.seat_no, areaId: seat.area_id, seatType: seat.seat_type,
      active: seat.status === 'active', hasFixedAssignment: seat.has_fixed_assignment,
      posX: seat.pos_x, posY: seat.pos_y, posZone: seat.pos_zone,
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
          body: JSON.stringify({ seat_no: form.seatNo, area_id: form.areaId }),
        })
      } else {
        await apiFetch(`/api/seats/${form.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            seat_no: form.seatNo, area_id: form.areaId, seat_type: form.seatType,
            status: form.active ? 'active' : 'retired',
            pos_x: form.posX, pos_y: form.posY, pos_zone: form.posZone,
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

  const openBulkAdd = () => {
    setBulkError(null)
    setBulkResult(null)
    setBulkForm({ areaId: areas[0]?.id ?? 0, seatNosText: '', rangePrefix: '', rangeStart: '', rangeEnd: '' })
  }

  const applyRangeToText = () => {
    if (!bulkForm) return
    const start = Number(bulkForm.rangeStart)
    const end = Number(bulkForm.rangeEnd)
    const prefix = bulkForm.rangePrefix.trim()
    if (!prefix || !Number.isInteger(start) || !Number.isInteger(end) || start > end) return
    const seatNos: string[] = []
    for (let n = start; n <= end; n++) seatNos.push(`${prefix}${n}`)
    setBulkForm({ ...bulkForm, seatNosText: seatNos.join(', ') })
  }

  const submitBulkForm = async () => {
    if (!bulkForm) return
    const seatNos = bulkForm.seatNosText.split(/[\s,、]+/).map((s) => s.trim()).filter(Boolean)
    if (seatNos.length === 0) { setBulkError('座席番号を入力してください'); return }
    setBulkSubmitting(true)
    setBulkError(null)
    try {
      const res = await apiFetch<BulkSeatResult>('/api/seats/bulk', {
        method: 'POST',
        body: JSON.stringify({ seat_nos: seatNos, area_id: bulkForm.areaId }),
      })
      setBulkResult(res)
      await refresh()
    } catch (e) {
      setBulkError(e instanceof ApiError ? e.message : '登録に失敗しました')
    } finally {
      setBulkSubmitting(false)
    }
  }

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-400 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">座席マスタ管理</h1>
      </header>

      <div className="p-6">
        <div className="rounded border border-slate-400 bg-white">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-400 p-4">
            <input
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              placeholder="座席番号で検索"
              className="h-9 w-full max-w-[220px] rounded border border-slate-500 px-3 text-sm"
            />
            <span className="text-sm text-slate-500">エリア</span>
            <select
              value={areaFilter}
              onChange={(e) => { setAreaFilter(e.target.value as AreaFilter); setPage(1) }}
              className="h-9 rounded border border-slate-500 px-2 text-sm"
            >
              {AREA_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <span className="text-sm text-slate-500">状態</span>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as SeatStatusFilter); setPage(1) }}
              className="h-9 rounded border border-slate-500 px-2 text-sm"
            >
              {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => navigate('/', { state: { placeSeatMode: true } })}
              className="ml-auto rounded border border-blue-800 px-3 py-1.5 text-sm text-blue-800 hover:bg-blue-50"
            >
              座席表の配置を編集する
            </button>
            <button
              type="button"
              onClick={openBulkAdd}
              className="rounded border border-blue-800 px-3 py-1.5 text-sm text-blue-800 hover:bg-blue-50"
            >
              ＋ まとめて追加
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
                <tr className="border-b border-slate-400 text-left text-slate-500">
                  <th className="px-4 py-2">座席番号</th>
                  <th className="px-4 py-2">エリア</th>
                  <th className="px-4 py-2">座席タイプ</th>
                  <th className="px-4 py-2">状態</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((s) => (
                  <tr key={s.id} className="border-b border-slate-400">
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
                          className="rounded border border-slate-500 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
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

          <Pagination
            page={page}
            totalPages={totalPages}
            totalCount={totalCount}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      </div>

      {form && (
        <Modal
          title={form.id === null ? '座席を追加' : `座席を編集（${form.seatNo}）`}
          onClose={() => setForm(null)}
          footer={
            <>
              <button type="button" onClick={() => setForm(null)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
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
                className="h-9 w-full rounded border border-slate-500 px-3"
              />
            </label>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">エリア</span>
                <select
                  value={form.areaId}
                  onChange={(e) => setForm({ ...form, areaId: Number(e.target.value) })}
                  className="h-9 w-full rounded border border-slate-500 px-2"
                >
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              {/* 座席タイプは新規作成時には選ばせない（2026-09-30変更）。作成時に「固定」を選ぶと、
                  fixed_seat_assignmentsへの記録を伴わない「誰にも割り当てられていないのに二度と
                  予約できない」座席が生まれてしまうため（SeatCreateのコメント参照）。座席を固定に
                  するにはS-05「固定座席の指定」（A-20）を使う。既存座席の編集時のみ、データ不整合の
                  手動修正手段として引き続き変更できるようにする */}
              {form.id !== null && (
                <label className="block flex-1">
                  <span className="mb-1 block text-slate-500">座席タイプ</span>
                  <select
                    value={form.seatType}
                    onChange={(e) => setForm({ ...form, seatType: e.target.value as SeatType })}
                    className="h-9 w-full rounded border border-slate-500 px-2"
                  >
                    <option value="free">フリー</option>
                    <option value="fixed">固定</option>
                  </select>
                </label>
              )}
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

      {bulkForm && (
        <Modal
          title="座席をまとめて追加"
          onClose={() => setBulkForm(null)}
          footer={
            bulkResult ? (
              <button type="button" onClick={() => setBulkForm(null)} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white">閉じる</button>
            ) : (
              <>
                <button type="button" onClick={() => setBulkForm(null)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
                <button type="button" disabled={bulkSubmitting} onClick={submitBulkForm} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">まとめて登録する</button>
              </>
            )
          }
        >
          {bulkResult ? (
            <div className="space-y-2 text-sm">
              <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-green-800">
                {bulkResult.created_count}件の座席を追加しました。
              </p>
              {bulkResult.skipped.length > 0 && (
                <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                  以下の座席番号は既に使用されているためスキップしました: {bulkResult.skipped.join('、')}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {/* 座席タイプ欄は新規作成時には出さない（2026-09-30変更、上の単体追加フォームと同じ理由）。
                  常にfreeで作成する */}
              <label className="block">
                <span className="mb-1 block text-slate-500">エリア</span>
                <select
                  value={bulkForm.areaId}
                  onChange={(e) => setBulkForm({ ...bulkForm, areaId: Number(e.target.value) })}
                  className="h-9 w-full rounded border border-slate-500 px-2"
                >
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>

              <div className="rounded border border-slate-400 bg-slate-50 p-3">
                <span className="mb-2 block text-xs text-slate-500">連番で入力欄を作成（任意。「プレフィックス＋開始〜終了」の座席番号を下の欄にまとめて入力する）</span>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-500">プレフィックス</span>
                    <input
                      type="text"
                      value={bulkForm.rangePrefix}
                      onChange={(e) => setBulkForm({ ...bulkForm, rangePrefix: e.target.value })}
                      placeholder="例: Q"
                      className="h-8 w-20 rounded border border-slate-500 px-2 text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-500">開始番号</span>
                    <input
                      type="number"
                      value={bulkForm.rangeStart}
                      onChange={(e) => setBulkForm({ ...bulkForm, rangeStart: e.target.value })}
                      placeholder="1"
                      className="h-8 w-20 rounded border border-slate-500 px-2 text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-500">終了番号</span>
                    <input
                      type="number"
                      value={bulkForm.rangeEnd}
                      onChange={(e) => setBulkForm({ ...bulkForm, rangeEnd: e.target.value })}
                      placeholder="20"
                      className="h-8 w-20 rounded border border-slate-500 px-2 text-sm"
                    />
                  </label>
                  <button type="button" onClick={applyRangeToText} className="h-8 rounded border border-blue-800 px-3 text-xs text-blue-800 hover:bg-blue-50">
                    下の欄に反映
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-slate-500">座席番号（改行またはカンマ区切りで複数入力）</span>
                <textarea
                  rows={4}
                  value={bulkForm.seatNosText}
                  onChange={(e) => setBulkForm({ ...bulkForm, seatNosText: e.target.value })}
                  placeholder={'例:\nQ1, Q2, Q3\nQ4'}
                  className="w-full rounded border border-slate-500 px-3 py-2 text-sm"
                />
              </label>
              {bulkError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{bulkError}</p>}
            </div>
          )}
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="座席の削除"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setDeleteTarget(null)} className="rounded border border-slate-500 px-4 py-1.5 text-sm">キャンセル</button>
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
