import { Navigate, Route, Routes } from 'react-router'
import { useMe } from './hooks/useMe'
import { apiFetch } from './lib/api'
import Login from './pages/Login'

// ルーティング定義・認証ガード。S-01（ログイン）以外の画面はまだ実装されていないため、
// ログイン後は暫定のホームを表示する（後続の画面を実装するたびにルートを追加する）
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
          <div className="flex min-h-screen items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-slate-500">
                ログインしました: {me.last_name} {me.first_name}
              </p>
              <button
                onClick={logout}
                className="mt-4 rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
              >
                ログアウト
              </button>
            </div>
          </div>
        }
      />
    </Routes>
  )
}
