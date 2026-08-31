import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { useMe } from './hooks/useMe'
import { apiFetch } from './lib/api'
import Login from './pages/Login'
import Availability from './pages/Availability'
import AdminMenu from './pages/AdminMenu'
import FixedSeats from './pages/FixedSeats'
import ProjectSeatAllocation from './pages/ProjectSeatAllocation'
import ProjectSeatRequest from './pages/ProjectSeatRequest'
import ProxyBooking from './pages/ProxyBooking'
import RoleManagement from './pages/RoleManagement'
import SeatMaster from './pages/SeatMaster'
import SeatHistory from './pages/SeatHistory'
import MyProfile from './pages/MyProfile'
import Layout from './components/Layout'

// ルーティング定義・認証ガード。S-01〜S-11、全11画面の実装が完了した（2026-08-31）
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
        <Route path="/profile" element={<MyProfile />} />
        <Route path="/project-seats" element={<ProjectSeatRequest />} />
        <Route path="/project-seats-area" element={requireAdmin(<ProjectSeatAllocation />)} />
        <Route path="/admin" element={requireAdmin(<AdminMenu />)} />
        <Route path="/fixed-seats" element={requireAdmin(<FixedSeats />)} />
        <Route path="/proxy-booking" element={requireAdmin(<ProxyBooking />)} />
        <Route path="/seat-master" element={requireAdmin(<SeatMaster />)} />
        <Route path="/roles" element={requireAdmin(<RoleManagement />)} />
        <Route path="/history" element={requireAdmin(<SeatHistory />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
