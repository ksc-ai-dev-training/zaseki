import { useState, type SVGProps } from 'react'
import { NavLink } from 'react-router'
import type { Me } from '../types'
import { CARDS as ADMIN_MENU_CARDS } from '../pages/AdminMenu'

interface SidebarProps {
  me: Me
  onLogout: () => void
}

// サイドバーの折り畳み状態はブラウザに保存し、次回アクセス時も維持する
// （2026-09-09追加。「メニューを折り畳み出来るようにしてほしい」との要望を受けた）
const COLLAPSE_STORAGE_KEY = 'zaseki_sidebar_collapsed'

// ナビ項目のアイコンは色付き絵文字ではなく、currentColorで塗られる線画SVGにする
// （2026-09-11変更。「絵文字は色を付けないで文字と同じ色にできる？」との要望を受けた。
// 色付き絵文字グリフはCSSのcolorでは着色できないため、線画アイコンに置き換えて対応した）
function IconIllust({ children, ...props }: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      {children}
    </svg>
  )
}
const MapIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6-13l6 3m0 0l5.447-2.724A1 1 0 0121 5.618v10.764a1 1 0 01-.553.894L15 20m0-13v13m0-13l-6-3" />
  </IconIllust>
)
const BriefcaseIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </IconIllust>
)
const CogIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </IconIllust>
)
const UserIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </IconIllust>
)
const QuestionMarkCircleIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </IconIllust>
)
const ChatIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </IconIllust>
)
const LogoutIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconIllust {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
  </IconIllust>
)

const NAV_ITEMS: {
  to: string
  label: string
  Icon: (props: SVGProps<SVGSVGElement>) => React.ReactElement
  adminOnly?: boolean
  systemOperatorOnly?: boolean
}[] = [
  { to: '/', label: '空き状況・予約', Icon: MapIcon },
  { to: '/project-seats', label: 'プロジェクト座席', Icon: BriefcaseIcon },
  // 独立した「プロジェクト座席（エリア担当）」項目は2026-09-14に削除した（「プロジェクト席と管理
  // メニューの間にあるプロジェクト座席（エリア担当）を削除してほしい」との要望を受けた）。同じ画面
  // への入口は「管理メニュー」直下のサブリンク（ADMIN_MENU_CARDS）にまとめて残す
  { to: '/admin', label: '管理メニュー', Icon: CogIcon, adminOnly: true },
  { to: '/profile', label: 'マイプロフィール', Icon: UserIcon },
  { to: '/help', label: 'ヘルプ', Icon: QuestionMarkCircleIcon },
  // フィードバック一覧は管理部（role='admin'）ではなくシステム運用担当のみに見せる
  // （FR-09-3、2026-09-01追加。「管理部ではなくシステムを運用している人に見れるようにしてほしい」）
  { to: '/feedback', label: 'フィードバック一覧', Icon: ChatIcon, systemOperatorOnly: true },
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
          <div key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded px-3 py-2 text-sm ${
                  isActive ? 'bg-white font-semibold text-[#1b2a5e]' : 'text-indigo-100/80 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <item.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {item.label}
            </NavLink>
            {/* 管理メニューの下に各画面への入口をまとめて出す（2026-09-14追加。「管理部メニューの
                下に固定座席の指定、代理予約・取り消し、座席マスタ管理、権限・PJ管理、プロジェクト
                席（エリア担当）を選べるようにしてほしい」との要望を受けた。S-06のカード一覧
                〔AdminMenu.tsx〕と同じCARDSを参照し、二重管理を避ける） */}
            {item.to === '/admin' && (
              <div className="mt-1 space-y-0.5 border-l border-white/10 pl-3">
                {ADMIN_MENU_CARDS.map((c) => (
                  <NavLink
                    key={c.to}
                    to={c.to}
                    className={({ isActive }) =>
                      `block rounded px-3 py-1.5 text-xs ${
                        isActive ? 'bg-white font-semibold text-[#1b2a5e]' : 'text-indigo-100/70 hover:bg-white/10 hover:text-white'
                      }`
                    }
                  >
                    {c.name}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
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
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs text-indigo-100 hover:bg-white/10 hover:text-white"
        >
          <LogoutIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ログアウト
        </button>
      </div>
    </aside>
  )
}
