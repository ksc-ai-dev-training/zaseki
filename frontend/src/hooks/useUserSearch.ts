import useSWR from 'swr'
import { apiFetch } from '../lib/api'

export interface UserSearchItem {
  id: number
  last_name: string
  first_name: string
  email: string
}

// A-79: プロジェクトメンバー追加用の軽量な利用者検索（2026-09-10新設）。ProjectEditModalが
// S-04（誰でもアクセス）でも使えるよう、admin専用のA-25（useUsers）ではなくこちらを使う。
// qが空の間はフェッチしない（全件ダンプを避ける）
export function useUserSearch(q: string) {
  const { data, error, isLoading } = useSWR<{ items: UserSearchItem[] }>(
    q ? `/api/users/search?q=${encodeURIComponent(q)}` : null,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading }
}
