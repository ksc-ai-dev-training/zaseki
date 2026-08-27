import { Navigate, Route, Routes } from 'react-router'
import { useMe } from './hooks/useMe'
import { apiFetch } from './lib/api'
import Login from './pages/Login'
import Availability from './pages/Availability'

// ルーティング定義・認証ガード。S-01・S-02以外の画面はまだ実装されていないため、
// ログイン後はS-02（空き状況・予約）をホームにする（後続の画面を実装するたびにルートを追加する）
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

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route
        path="*"
        element={
          <div>
            <div className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-2 text-sm text-slate-500">
              {me.last_name} {me.first_name}
              <button onClick={logout} className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
                ログアウト
              </button>
            </div>
            <Availability />
          </div>
        }
      />
    </Routes>
  )
}
