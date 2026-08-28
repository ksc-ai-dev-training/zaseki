import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { ProxyCandidate } from '../types'

// A-54: 代理予約する対象者検索（登録済みの全利用者が対象、氏名の部分一致）
export function useProxyCandidates(q: string) {
  const { data, error, isLoading } = useSWR<{ items: ProxyCandidate[] }>(
    `/api/reservations/proxy-candidates?q=${encodeURIComponent(q)}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading }
}
