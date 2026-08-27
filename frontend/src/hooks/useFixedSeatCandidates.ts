import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { FixedSeatCandidate } from '../types'

// A-52: 新しく固定座席を指定する対象者検索（固定座席を持たない利用者、氏名の部分一致）
export function useFixedSeatCandidates(q: string) {
  const { data, error, isLoading } = useSWR<{ items: FixedSeatCandidate[] }>(
    `/api/fixed-seat-assignments/candidates?q=${encodeURIComponent(q)}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading }
}
