import { useEffect, useState } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useUsers, type UserRoleFilter, type UserStatusFilter } from '../hooks/useUsers'
import { useAppSettings } from '../hooks/useAppSettings'
import { useProjects } from '../hooks/useProjects'
import { useMe } from '../hooks/useMe'
import Modal from '../components/Modal'
import ProjectEditModal, { PROJECT_TITLE_LABEL, ProjectDeleteConfirmModal, type ProjectForm } from '../components/ProjectEditModal'
import type {
  AreaManagerRole, EmploymentType, EmploymentStatus, ProjectListItem, ProjectMemberSummary,
  Role, UserRoleItem,
} from '../types'

type Tab = 'users' | 'projects' | 'notifications'

const TABS: { key: Tab; label: string }[] = [
  { key: 'users', label: '利用者ロール管理' },
  { key: 'projects', label: 'プロジェクト・PM管理' },
  { key: 'notifications', label: '通知設定' },
]

const ROLE_OPTIONS: { key: UserRoleFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'general', label: '一般' },
  { key: 'admin', label: '管理部' },
]
const STATUS_OPTIONS: { key: UserStatusFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'active', label: '在籍中' },
  { key: 'leave', label: '休職中' },
  { key: 'retired', label: '退職済み' },
]
const EMPLOYMENT_TYPE_JA: Record<EmploymentType, string> = { employee: '社員', contract: '契約職員', bp: 'BP' }
const EMPLOYMENT_STATUS_JA: Record<EmploymentStatus, string> = { active: '在籍中', leave: '休職中', retired: '退職済み' }
const AREA_MANAGER_ROLE_JA: Record<'manager' | 'deputy', string> = { manager: 'エリア責任者', deputy: '副責任者' }

// 要件定義書v0.61: 一般利用者の役割列は雇用形態に応じて社員／AB（契約）／BPに分けて表示する
function roleBadgeLabel(u: UserRoleItem): string {
  if (u.role === 'admin') return '管理部'
  if (u.employment_type === 'contract') return 'AB'
  if (u.employment_type === 'bp') return 'BP'
  return '社員'
}

interface UserForm {
  id: number
  lastName: string
  firstName: string
  employmentType: EmploymentType
  isAdmin: boolean
  areaManagerRole: AreaManagerRole
  employmentStatus: EmploymentStatus
  isSystemOperator: boolean
}

// S-08 権限・役割管理
export default function RoleManagement() {
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">権限・役割管理</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-08</span>
      </header>

      <div className="border-b border-slate-200 bg-white px-6">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`border-b-2 px-3 py-3 text-sm font-medium ${
                tab === t.key ? 'border-blue-800 text-blue-800' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        {tab === 'users' && <UsersTab />}
        {tab === 'projects' && <ProjectsTab />}
        {tab === 'notifications' && <NotificationsTab />}
      </div>
    </div>
  )
}

function UsersTab() {
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<UserRoleFilter>('all')
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all')
  const [showRetired, setShowRetired] = useState(false)
  const { items, isLoading, refresh } = useUsers(roleFilter, statusFilter, showRetired, query)

  const [form, setForm] = useState<UserForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const openEdit = (u: UserRoleItem) => {
    setFormError(null)
    setForm({
      id: u.id, lastName: u.last_name, firstName: u.first_name, employmentType: u.employment_type,
      isAdmin: u.role === 'admin', areaManagerRole: u.area_manager_role, employmentStatus: u.employment_status,
      isSystemOperator: u.is_system_operator,
    })
  }

  const submitForm = async () => {
    if (!form) return
    setSubmitting(true)
    setFormError(null)
    try {
      await apiFetch(`/api/users/${form.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          last_name: form.lastName, first_name: form.firstName, employment_type: form.employmentType,
          role: form.isAdmin ? 'admin' : ('general' as Role),
          area_manager_role: form.isAdmin ? form.areaManagerRole : null,
          employment_status: form.employmentStatus,
          is_system_operator: form.isSystemOperator,
        }),
      })
      setForm(null)
      await refresh()
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="氏名・メールで検索"
          className="h-9 w-full max-w-[220px] rounded border border-slate-300 px-3 text-sm"
        />
        <span className="text-sm text-slate-500">役割</span>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as UserRoleFilter)} className="h-9 rounded border border-slate-300 px-2 text-sm">
          {ROLE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <span className="text-sm text-slate-500">在籍状況</span>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as UserStatusFilter)} className="h-9 rounded border border-slate-300 px-2 text-sm">
          {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          退職済みを表示する
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="px-4 py-2">氏名</th>
              <th className="px-4 py-2">メールアドレス</th>
              <th className="px-4 py-2">雇用形態</th>
              <th className="px-4 py-2">役割</th>
              <th className="px-4 py-2">エリア担当</th>
              <th className="px-4 py-2">在籍状況</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id} className="border-b border-slate-100">
                <td className="px-4 py-2 font-semibold">{u.last_name} {u.first_name}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{u.email}</td>
                <td className="px-4 py-2">{EMPLOYMENT_TYPE_JA[u.employment_type]}</td>
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${u.role === 'admin' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600'}`}>
                    {roleBadgeLabel(u)}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{u.area_manager_role ? AREA_MANAGER_ROLE_JA[u.area_manager_role] : 'なし'}</td>
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${
                    u.employment_status === 'retired' ? 'bg-slate-100 text-slate-500'
                    : u.employment_status === 'leave' ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'
                  }`}>
                    {EMPLOYMENT_STATUS_JA[u.employment_status]}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button type="button" onClick={() => openEdit(u)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    編集
                  </button>
                </td>
              </tr>
            ))}
            {!isLoading && items.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-slate-400">該当する利用者がいません</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-slate-400">
        「エリア担当」（エリア責任者・副責任者）はrole=管理部の利用者のみ設定できる。特定のエリアへの配置は行わず、全プロジェクト共通の役割として設定する。
      </p>

      {form && (
        <Modal
          title={`利用者情報を編集（${form.lastName} ${form.firstName}）`}
          onClose={() => setForm(null)}
          footer={
            <>
              <button type="button" onClick={() => setForm(null)} className="rounded border border-slate-300 px-4 py-1.5 text-sm">キャンセル</button>
              <button type="button" disabled={submitting} onClick={submitForm} className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">保存する</button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex gap-2">
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">姓</span>
                <input type="text" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="h-9 w-full rounded border border-slate-300 px-3" />
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-slate-500">名</span>
                <input type="text" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="h-9 w-full rounded border border-slate-300 px-3" />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-slate-500">雇用形態</span>
              <select
                value={form.employmentType}
                onChange={(e) => setForm({ ...form, employmentType: e.target.value as EmploymentType })}
                className="h-9 w-full rounded border border-slate-300 px-2"
              >
                <option value="employee">社員</option>
                <option value="contract">契約職員</option>
                <option value="bp">BP</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isAdmin}
                onChange={(e) => setForm({ ...form, isAdmin: e.target.checked, areaManagerRole: e.target.checked ? form.areaManagerRole : null })}
              />
              <span>管理部ロールを付与する</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-slate-500">エリア担当（管理部ロールの利用者のみ設定可）</span>
              <select
                value={form.areaManagerRole ?? ''}
                disabled={!form.isAdmin}
                onChange={(e) => setForm({ ...form, areaManagerRole: (e.target.value || null) as AreaManagerRole })}
                className="h-9 w-full rounded border border-slate-300 px-2 disabled:bg-slate-50 disabled:text-slate-400"
              >
                <option value="">なし</option>
                <option value="manager">エリア責任者</option>
                <option value="deputy">副責任者</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-slate-500">在籍状況</span>
              <select
                value={form.employmentStatus}
                onChange={(e) => setForm({ ...form, employmentStatus: e.target.value as EmploymentStatus })}
                className="h-9 w-full rounded border border-slate-300 px-2"
              >
                <option value="active">在籍中</option>
                <option value="leave">休職中</option>
                <option value="retired">退職済み</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isSystemOperator}
                onChange={(e) => setForm({ ...form, isSystemOperator: e.target.checked })}
              />
              <span>システム運用担当（フィードバック一覧を閲覧できる。管理部ロールとは独立）</span>
            </label>
            {form.employmentStatus === 'retired' && (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                「退職済み」に変更して保存すると、この利用者は論理削除され、以後ログイン・予約ができなくなります。あわせて固定座席の割当があれば解除し、今後の予約（フリー座席・プロジェクト座席）はすべて取消扱いになります（RULE-06）。
              </p>
            )}
            {formError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">{formError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}

function ProjectsTab() {
  const { items, isLoading, refresh } = useProjects()
  const { me } = useMe()
  const [form, setForm] = useState<ProjectForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiFetch(`/api/projects/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      await refresh()
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : '削除に失敗しました')
    } finally {
      setDeleting(false)
    }
  }

  const openAdd = () => {
    setFormError(null)
    // 作成者は既定でこの画面を操作している管理部自身にする（A-28がcreated_byを呼び出し者に設定する
    // のと揃える。ここで指定しないと、直後のA-29呼び出しでcreated_byがnullに上書きされてしまう）。
    // 追加後にメンバーを選んで作成者を変更することもできる
    setForm({ id: null, name: '', members: [], proxyUserId: null, createdBy: me?.id ?? null })
  }
  const openEdit = (p: ProjectListItem) => {
    setFormError(null)
    setForm({
      id: p.id, name: p.name,
      members: p.members.map((m) => ({ user_id: m.user_id, name: m.name, project_title: m.project_title })),
      proxyUserId: p.proxy_user_id,
      createdBy: p.created_by,
    })
  }

  const submitForm = async () => {
    if (!form) return
    if (!form.name.trim()) { setFormError('プロジェクト名を入力してください'); return }
    setSubmitting(true)
    setFormError(null)
    try {
      const id = form.id ?? (await apiFetch<{ id: number }>('/api/projects', {
        method: 'POST', body: JSON.stringify({ name: form.name }),
      })).id
      await apiFetch(`/api/projects/${id}/members`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          members: form.members.map((m) => ({ user_id: m.user_id, project_title: m.project_title })),
          proxy_user_id: form.proxyUserId,
          created_by: form.createdBy,
        }),
      })
      setForm(null)
      await refresh()
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="flex justify-end border-b border-slate-200 p-4">
        <button type="button" onClick={openAdd} className="rounded bg-blue-800 px-3 py-1.5 text-sm text-white hover:bg-blue-900">
          ＋ プロジェクトを追加
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="px-4 py-2">プロジェクト名</th>
              <th className="px-4 py-2">PM・PL・SL</th>
              <th className="px-4 py-2">PJ席決担当</th>
              <th className="px-4 py-2">作成者</th>
              <th className="px-4 py-2">メンバー数</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const titled = p.members.filter((m): m is ProjectMemberSummary & { project_title: 'PM' | 'PL' | 'SL' } => m.project_title !== null)
              return (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="px-4 py-2 font-semibold">{p.name}</td>
                  <td className="px-4 py-2">
                    {titled.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {titled.map((m) => (
                          <span key={m.member_id} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            {PROJECT_TITLE_LABEL[m.project_title]} {m.name}
                          </span>
                        ))}
                      </div>
                    ) : <span className="text-xs text-slate-400">未設定</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{p.proxy_user_name ?? '未設定'}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{p.created_by_name ?? '未設定'}</td>
                  <td className="px-4 py-2">{p.member_count}名</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => openEdit(p)} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        編集
                      </button>
                      <button type="button" onClick={() => { setDeleteError(null); setDeleteTarget(p) }} className="rounded border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50">
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!isLoading && items.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-slate-400">プロジェクトが登録されていません</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <ProjectEditModal
          form={form}
          setForm={setForm}
          onClose={() => setForm(null)}
          onSubmit={submitForm}
          submitting={submitting}
          error={formError}
        />
      )}

      {deleteTarget && (
        <ProjectDeleteConfirmModal
          projectName={deleteTarget.name}
          onClose={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
          deleting={deleting}
          error={deleteError}
        />
      )}
    </div>
  )
}

const WEBHOOK_KEY = 'project_seat_slack_webhook_url'
// アンケート送信時の文言（project_seat_slack_message_survey）は、2026-09-03の変更B（検討資料
// 「プロジェクト座席・曜日調整フロー改善案」）でシステムによるアンケート送信通知自体を廃止した
// ことに伴い削除した（エリア責任者が自分でSlackへ連絡する運用に変更）。
const MESSAGE_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'project_seat_slack_message_reminder', label: 'リマインド送信時の文言', hint: '使える項目: {project_name}' },
  { key: 'project_seat_slack_message_finalize_header', label: '曜日確定時の文言（見出し行）', hint: 'この後にプロジェクトごとの確定曜日一覧（固定フォーマット）が続く' },
]

function NotificationsTab() {
  const { items, isLoading, refresh } = useAppSettings()
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (items.length > 0) {
      setValues(Object.fromEntries(items.map((it) => [it.key, it.value ?? ''])))
    }
  }, [items])

  const setField = (key: string, v: string) => { setValues((prev) => ({ ...prev, [key]: v })); setSaved(false) }

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await Promise.all(
        Object.entries(values).map(([key, value]) =>
          apiFetch(`/api/app-settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) })
        )
      )
      setSaved(true)
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl rounded border border-slate-200 bg-white p-6">
      <p className="mb-4 text-sm text-slate-500">
        出社曜日アンケート関連の通知先（Slack Incoming Webhook URL）と、実際に送信される通知文言を設定する。プロジェクト座席共通の1つの通知先のみを持つ。エリア責任者・副責任者の指定は「利用者ロール管理」タブで行う。
      </p>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">Slack通知先（Webhook URL）</span>
        <input
          type="text"
          value={values[WEBHOOK_KEY] ?? ''}
          onChange={(e) => setField(WEBHOOK_KEY, e.target.value)}
          placeholder="https://hooks.slack.com/services/..."
          disabled={isLoading}
          className="h-9 w-full rounded border border-slate-300 px-3"
        />
      </label>

      <div className="mt-6 space-y-4">
        <div className="text-sm font-semibold text-slate-700">通知文言（2026-09-02追加。「実際の通知の文言を編集できる機能を追加してほしい」との要望を受けた）</div>
        {MESSAGE_FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="mb-1 block text-slate-500">{f.label}</span>
            <textarea
              rows={2}
              value={values[f.key] ?? ''}
              onChange={(e) => setField(f.key, e.target.value)}
              disabled={isLoading}
              maxLength={500}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-400">{f.hint}</span>
          </label>
        ))}
      </div>

      {saved && <p className="mt-4 text-xs text-green-700">保存しました</p>}
      {error && <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <button type="button" disabled={saving} onClick={save} className="mt-4 rounded bg-blue-800 px-4 py-1.5 text-sm text-white disabled:opacity-50">
        保存する
      </button>
    </div>
  )
}
