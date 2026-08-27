import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import { useMe } from '../hooks/useMe'
import type { DevUser } from '../types'

const ROLE_LABELS: Record<string, string> = {
  admin: '管理部',
  general: '一般',
}

// A-02 が認証を拒否したときに ?error= で渡してくる種別に対応するメッセージ（詳細設計書6.2節）
const LOGIN_ERRORS: Record<string, string> = {
  domain: '許可されていないアカウントです。kogasoftware.comのアカウントでログインしてください',
  retired: 'このアカウントは現在利用できません。心当たりがない場合は管理部にお問い合わせください',
  invalid_request: '認証処理に失敗しました。お手数ですが、もう一度お試しください。',
}

// S-01 ログイン画面。ローカル開発では Google 認証の代わりに開発用ログインを表示する
export default function Login() {
  const navigate = useNavigate()
  const { mutate } = useMe()
  const [error, setError] = useState<string | null>(null)
  const [searchParams] = useSearchParams()
  const { data } = useSWR<{ items: DevUser[] }>('/api/auth/dev-users', apiFetch)

  const authError = searchParams.get('error')
  const authErrorMessage = authError
    ? (LOGIN_ERRORS[authError] ?? LOGIN_ERRORS.invalid_request)
    : null

  const devLogin = async (email: string) => {
    setError(null)
    try {
      await apiFetch('/api/auth/dev-login', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      await mutate()
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインに失敗しました')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-blue-800 text-lg font-bold text-white">
          Z
        </div>
        <h1 className="text-center text-xl font-bold tracking-wide">Zaseki</h1>

        {authErrorMessage && (
          <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-center text-sm text-red-700">
            {authErrorMessage}
          </p>
        )}

        <a
          href="/api/auth/login"
          className="mt-6 flex h-11 items-center justify-center gap-2.5 rounded border border-slate-300 text-sm font-medium hover:bg-slate-50"
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Googleでログイン
        </a>

        {data && data.items.length > 0 && (
          <div className="mt-8 border-t border-slate-200 pt-4">
            <p className="mb-2 text-xs font-semibold text-amber-600">
              開発用ログイン（Google認証の代替）
            </p>
            <ul className="space-y-1">
              {data.items.map((u) => (
                <li key={u.email}>
                  <button
                    onClick={() => devLogin(u.email)}
                    className="flex w-full items-center justify-between rounded border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span>
                      {u.last_name} {u.first_name}
                      <span className="ml-2 text-xs text-slate-400">{u.email}</span>
                    </span>
                    <span className="rounded bg-slate-200 px-2 py-0.5 text-xs">
                      {ROLE_LABELS[u.role]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="mt-4 text-center text-sm text-red-600">{error}</p>}

        <div className="mt-7 border-t border-slate-200 pt-4 text-center text-[11px] text-slate-400">
          コガソフトウェア株式会社 社内システム
        </div>
      </div>
    </div>
  )
}
