import { useState } from 'react'
import { useUserSearch, type UserSearchItem } from '../hooks/useUserSearch'
import Modal from './Modal'
import type { ProjectTitle } from '../types'

export const PROJECT_TITLE_LABEL: Record<'PM' | 'PL' | 'SL', string> = { PM: 'PM', PL: 'PL', SL: 'SL' }

export interface ProjectMemberRow {
  user_id: number
  name: string
  project_title: ProjectTitle
}

export interface ProjectForm {
  id: number | null
  name: string
  members: ProjectMemberRow[]
  proxyUserId: number | null
  // 作成者（projects.created_by、2026-09-09追加、千田さんの案）。アンケート回答・席決めの実権限を
  // 持つ利用者。proxyUserIdと異なりPM/PL限定ではなくメンバー全員から選べる
  createdBy: number | null
}

// プロジェクトの追加・編集モーダル。S-08「プロジェクト・PM管理」タブ発の共通コンポーネントで、
// 2026-09-10にS-04「プロジェクト座席」（プロジェクトの作成者向け）でも「S-08と同じ編集機能が
// 欲しい」との要望を受けて共有化した。両画面で見た目・操作内容が完全に同一になるよう、この
// ファイルを唯一の実装として両ページからimportする。
export default function ProjectEditModal({ form, setForm, onClose, onSubmit, submitting, error }: {
  form: ProjectForm
  setForm: (f: ProjectForm) => void
  onClose: () => void
  onSubmit: () => void
  submitting: boolean
  error: string | null
}) {
  const [query, setQuery] = useState('')
  const { items: candidates } = useUserSearch(query)
  const memberIds = new Set(form.members.map((m) => m.user_id))
  const searchResults = query ? candidates.filter((c) => !memberIds.has(c.id)).slice(0, 6) : []

  const addMember = (u: UserSearchItem) => {
    setForm({ ...form, members: [...form.members, { user_id: u.id, name: `${u.last_name} ${u.first_name}`, project_title: null }] })
    setQuery('')
  }
  const removeMember = (userId: number) => {
    setForm({
      ...form,
      members: form.members.filter((m) => m.user_id !== userId),
      proxyUserId: form.proxyUserId === userId ? null : form.proxyUserId,
      createdBy: form.createdBy === userId ? null : form.createdBy,
    })
  }
  const setTitle = (userId: number, title: ProjectTitle) => {
    const members = form.members.map((m) => (m.user_id === userId ? { ...m, project_title: title } : m))
    const proxyStillValid = form.proxyUserId !== null && members.some((m) => m.user_id === form.proxyUserId && (m.project_title === 'PM' || m.project_title === 'PL'))
    setForm({ ...form, members, proxyUserId: proxyStillValid ? form.proxyUserId : null })
  }

  return (
    <Modal
      title={form.id === null ? 'プロジェクトを追加' : `プロジェクトを編集（${form.name}）`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
          <button type="button" disabled={submitting} onClick={onSubmit} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">保存する</button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="mb-1 block text-slate-500">プロジェクト名</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例: Zaseki研修プロジェクト"
            className="h-9 w-full rounded border border-slate-300 px-3"
          />
        </label>

        <div>
          <span className="mb-1 block text-slate-500">メンバー・PM／PL・PJ席決担当・作成者</span>
          <p className="mb-2 text-xs text-slate-400">
            PJ席決担当は表示用の項目です。アンケート回答・メンバーへの座席確保を実際に行えるのは「作成者」のみです（2026-09-09変更）。
          </p>
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                  <th className="px-3 py-1.5">氏名</th>
                  <th className="px-3 py-1.5">役割</th>
                  <th className="px-3 py-1.5">PJ席決担当</th>
                  <th className="px-3 py-1.5">作成者</th>
                  <th className="px-3 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {form.members.map((m) => {
                  const canBeProxy = m.project_title === 'PM' || m.project_title === 'PL'
                  return (
                    <tr key={m.user_id} className="border-b border-slate-100">
                      <td className="px-3 py-1.5">{m.name}</td>
                      <td className="px-3 py-1.5">
                        <select
                          value={m.project_title ?? ''}
                          onChange={(e) => setTitle(m.user_id, (e.target.value || null) as ProjectTitle)}
                          className="h-8 rounded border border-slate-300 px-2"
                        >
                          <option value="">なし</option>
                          <option value="PM">PM</option>
                          <option value="PL">PL</option>
                          <option value="SL">SL</option>
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="radio"
                          name="proxy-user"
                          disabled={!canBeProxy}
                          checked={form.proxyUserId === m.user_id}
                          onChange={() => setForm({ ...form, proxyUserId: m.user_id })}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="radio"
                          name="created-by-user"
                          checked={form.createdBy === m.user_id}
                          onChange={() => setForm({ ...form, createdBy: m.user_id })}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button type="button" onClick={() => removeMember(m.user_id)} className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">削除</button>
                      </td>
                    </tr>
                  )
                })}
                {form.members.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-3 text-center text-xs text-slate-400">メンバーがいません</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="relative mt-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="氏名で検索してメンバーを追加"
              className="h-9 w-full rounded border border-slate-300 px-3 text-sm"
            />
            {searchResults.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded border border-slate-200 bg-white shadow">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => addMember(u)}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                  >
                    {u.last_name} {u.first_name} <span className="text-xs text-slate-400">{u.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      </div>
    </Modal>
  )
}

// プロジェクト削除の確認モーダル。S-08・S-04で共通の文言・操作にする（2026-09-10、共通化）
export function ProjectDeleteConfirmModal({ projectName, onClose, onConfirm, deleting, error }: {
  projectName: string
  onClose: () => void
  onConfirm: () => void
  deleting: boolean
  error: string | null
}) {
  return (
    <Modal
      title="プロジェクトの削除"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
          <button type="button" disabled={deleting} onClick={onConfirm} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">削除する</button>
        </>
      }
    >
      <p className="text-sm">プロジェクト「{projectName}」を削除しますか？メンバー構成・四半期ごとの座席計画（アンケート回答・座席の島の割当を含む）もあわせて削除されます。メンバーが既に個別に確保済みの座席予約は取り消されません。</p>
      {error && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </Modal>
  )
}
