import { Outlet } from 'react-router'
import Sidebar from './Sidebar'
import type { Me } from '../types'

interface LayoutProps {
  me: Me
  onLogout: () => void
}

// 認証後の共通レイアウト。PC幅はサイドバー、スマホ幅（S-02のみ対応、基本設計書4.7節）は
// 簡易な上部バーに切り替わる
export default function Layout({ me, onLogout }: LayoutProps) {
  return (
    <div className="sm:flex sm:min-h-screen">
      <Sidebar me={me} onLogout={onLogout} />

      <div className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-2 text-sm text-slate-500 sm:hidden">
        {me.last_name} {me.first_name}
        <button type="button" onClick={onLogout} className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
          ログアウト
        </button>
      </div>

      <div className="min-w-0 sm:flex-1">
        <Outlet />
      </div>
    </div>
  )
}
