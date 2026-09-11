import { useState } from 'react'
import { NavLink } from 'react-router'
import type { Me } from '../types'

interface SidebarProps {
  me: Me
  onLogout: () => void
}

// サイドバーの折り畳み状態はブラウザに保存し、次回アクセス時も維持する
// （2026-09-09追加。「メニューを折り畳み出来るようにしてほしい」との要望を受けた）
const COLLAPSE_STORAGE_KEY = 'zaseki_sidebar_collapsed'

const NAV_ITEMS: { to: string; label: string; emoji: string; adminOnly?: boolean; systemOperatorOnly?: boolean }[] = [
  { to: '/', label: '空き状況・予約', emoji: '💺' },
  { to: '/project-seats', label: 'プロジェクト座席', emoji: '🧩' },
  { to: '/project-seats-area', label: 'プロジェクト座席（エリア担当）', emoji: '🗺️', adminOnly: true },
  { to: '/admin', label: '管理メニュー', emoji: '⚙️', adminOnly: true },
  { to: '/profile', label: 'マイプロフィール', emoji: '👤' },
  { to: '/help', label: 'ヘルプ', emoji: '❓' },
  // フィードバック一覧は管理部（role='admin'）ではなくシステム運用担当のみに見せる
  // （FR-09-3、2026-09-01追加。「管理部ではなくシステムを運用している人に見れるようにしてほしい」）
  { to: '/feedback', label: 'フィードバック一覧', emoji: '💬', systemOperatorOnly: true },
]

const ROLE_LABEL: Record<Me['role'], string> = { admin: '管理部', general: '一般' }

// 画面共通のサイドバー（画面モックアップの.sidebarに相当）。スマホ幅では非表示にし、
// S-02のみに用意した簡易な上部バー（Layout.tsx）に譲る（スマホ対応の対象はS-02のみ、基本設計書4.7節）
export default function Sidebar({ me, onLogout }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // localStorageが使えない環境（プライベートブラウズ等）ではセッション内のみの切り替えになる
      }
      return next
    })
  }

  if (collapsed) {
    return (
      <aside className="hidden w-14 shrink-0 flex-col items-center gap-3 bg-gradient-to-b from-[#26346f] to-[#10173a] py-4 sm:sticky sm:top-0 sm:flex sm:h-screen">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-white text-sm font-bold text-[#1b2a5e]">Z</div>
        <button
          type="button"
          onClick={toggleCollapsed}
          title="メニューを開く"
          aria-label="メニューを開く"
          className="rounded p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          »
        </button>
      </aside>
    )
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-gradient-to-b from-[#26346f] to-[#10173a] sm:sticky sm:top-0 sm:flex sm:h-screen">
      <div className="shrink-0 flex items-center gap-2 border-b border-white/10 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-white text-sm font-bold text-[#1b2a5e]">Z</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-white">Zaseki</div>
          <div className="text-[11px] text-indigo-200/60">本社座席予約システム</div>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          title="メニューを折り畳む"
          aria-label="メニューを折り畳む"
          className="shrink-0 rounded p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          «
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.filter(
          (item) => (!item.adminOnly || me.role === 'admin') && (!item.systemOperatorOnly || me.is_system_operator)
        ).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded px-3 py-2 text-sm ${
                isActive ? 'bg-white font-semibold text-[#1b2a5e]' : 'text-indigo-100/80 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <span aria-hidden="true">{item.emoji}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="shrink-0 border-t border-white/10 bg-black/10 p-3">
        <div className="flex items-center gap-2">
          {me.avatar_image ? (
            <img src={me.avatar_image} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">
              {me.last_name.slice(0, 1)}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
              {me.last_name} {me.first_name}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-normal ${
                  me.role === 'admin' ? 'bg-fuchsia-400/20 text-fuchsia-200' : 'bg-white/10 text-indigo-100'
                }`}
              >
                {ROLE_LABEL[me.role]}
              </span>
            </div>
            <div className="truncate text-[11px] text-indigo-200/50">{me.email}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="mt-3 w-full rounded border border-white/15 px-3 py-1.5 text-xs text-indigo-100 hover:bg-white/10 hover:text-white"
        >
          🚪 ログアウト
        </button>
      </div>
    </aside>
  )
}
