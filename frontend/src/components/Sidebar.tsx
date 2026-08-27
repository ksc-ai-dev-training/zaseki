import { NavLink } from 'react-router'
import type { Me } from '../types'

interface SidebarProps {
  me: Me
  onLogout: () => void
}

const NAV_ITEMS: { to: string; label: string; adminOnly?: boolean }[] = [
  { to: '/', label: '空き状況・予約' },
  { to: '/project-seats', label: 'プロジェクト座席' },
  { to: '/project-seats-area', label: 'プロジェクト座席（エリア担当）', adminOnly: true },
  { to: '/admin', label: '管理メニュー', adminOnly: true },
]

const ROLE_LABEL: Record<Me['role'], string> = { admin: '管理部', general: '一般' }

// 画面共通のサイドバー（画面モックアップの.sidebarに相当）。スマホ幅では非表示にし、
// S-02のみに用意した簡易な上部バー（Layout.tsx）に譲る（スマホ対応の対象はS-02のみ、基本設計書4.7節）
export default function Sidebar({ me, onLogout }: SidebarProps) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white sm:flex">
      <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-blue-800 text-sm font-bold text-white">Z</div>
        <div>
          <div className="text-sm font-bold text-slate-800">Zaseki</div>
          <div className="text-[11px] text-slate-400">本社座席予約システム</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.filter((item) => !item.adminOnly || me.role === 'admin').map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `block rounded px-3 py-2 text-sm ${
                isActive ? 'bg-blue-50 font-semibold text-blue-800' : 'text-slate-600 hover:bg-slate-50'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-200 p-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
            {me.last_name.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              {me.last_name} {me.first_name}
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">{ROLE_LABEL[me.role]}</span>
            </div>
            <div className="truncate text-[11px] text-slate-400">{me.email}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="mt-3 w-full rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          ログアウト
        </button>
      </div>
    </aside>
  )
}
