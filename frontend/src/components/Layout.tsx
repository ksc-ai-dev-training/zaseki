import { NavLink, Outlet, useLocation } from 'react-router'
import Sidebar from './Sidebar'
import type { Me } from '../types'

interface LayoutProps {
  me: Me
  onLogout: () => void
}

// 認証後の共通レイアウト。PC幅はサイドバー、スマホ幅（S-02のみ対応、基本設計書4.7節）は
// 簡易な上部バーに切り替わる。上部バーにはS-12マイプロフィールへのリンクのみ追加している
// （2026-09-04追加。「スマホ版にもプロフィールの作成できる機能が欲しい」との要望を受けた）
export default function Layout({ me, onLogout }: LayoutProps) {
  const location = useLocation()
  const isHome = location.pathname === '/'

  return (
    <div className="sm:flex sm:min-h-screen">
      <Sidebar me={me} onLogout={onLogout} />

      <div className="flex items-center justify-end gap-2 border-b border-slate-400 bg-white px-4 py-2 text-sm text-slate-500 sm:hidden">
        {/* 空き状況・予約への戻りリンク（2026-09-14追加。「スマホ版でプロフィールの画面に
            行ったとき、座席予約に戻ることができない」との報告を受けた。この上部バーには
            従来マイプロフィール・ログアウトしかなく、スマホ幅では非表示のサイドバーが持つ
            「空き状況・予約」への導線が他のどの画面にもなかった）。既に空き状況・予約自体を
            見ている間は自分自身へのリンクになり冗長なため非表示にする */}
        {!isHome && (
          <NavLink
            to="/"
            end
            aria-label="空き状況・予約に戻る"
            title="空き状況・予約に戻る"
            className="flex shrink-0 items-center justify-center rounded border border-slate-500 p-1.5 text-slate-600 hover:bg-slate-50"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </NavLink>
        )}
        <span className="mr-auto min-w-0 truncate">{me.last_name} {me.first_name}</span>
        <NavLink to="/profile" className="shrink-0 rounded border border-slate-500 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
          プロフィール
        </NavLink>
        <button type="button" onClick={onLogout} className="shrink-0 rounded border border-slate-500 px-3 py-1 text-xs hover:bg-slate-50">
          ログアウト
        </button>
      </div>

      <div className="min-w-0 sm:flex-1">
        <Outlet />
      </div>
    </div>
  )
}
