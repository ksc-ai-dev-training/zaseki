import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { useMe } from './hooks/useMe'
import { apiFetch } from './lib/api'
import Login from './pages/Login'
import Availability from './pages/Availability'
import AdminMenu from './pages/AdminMenu'
import FixedSeats from './pages/FixedSeats'
import ComingSoon from './pages/ComingSoon'
import Layout from './components/Layout'

// ルーティング定義・認証ガード。画面は1つずつ実装していく方針のため、まだ実装していない
// 画面へのリンクはComingSoonへ遷移する（後続の画面を実装するたびに置き換える）
export default function App() {
  const { me, isLoading, mutate } = useMe()

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-slate-400">読み込み中...</div>
  }

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  const logout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    await mutate()
  }

  // S-05・S-07・S-08・S-09・S-10・S-11は全てrole='admin'必須（詳細設計書5.5節）。
  // 一般利用者が直接URLを叩いても弾けるよう、ルート単位でも同じ条件をかけておく
  const requireAdmin = (element: ReactNode) => (me.role === 'admin' ? element : <Navigate to="/" replace />)

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout me={me} onLogout={logout} />}>
        <Route path="/" element={<Availability />} />
        <Route path="/project-seats" element={<ComingSoon id="S-04" name="プロジェクト座席" />} />
        <Route path="/project-seats-area" element={requireAdmin(<ComingSoon id="S-09" name="プロジェクト座席（エリア担当）" />)} />
        <Route path="/admin" element={requireAdmin(<AdminMenu />)} />
        <Route path="/fixed-seats" element={requireAdmin(<FixedSeats />)} />
        <Route path="/proxy-booking" element={requireAdmin(<ComingSoon id="S-11" name="代理予約・取消" />)} />
        <Route path="/seat-master" element={requireAdmin(<ComingSoon id="S-07" name="座席マスタ管理" />)} />
        <Route path="/roles" element={requireAdmin(<ComingSoon id="S-08" name="権限・役割管理" />)} />
        <Route path="/history" element={requireAdmin(<ComingSoon id="S-10" name="座席状況の履歴照会" />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
