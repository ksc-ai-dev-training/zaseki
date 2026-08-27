import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { FixedSeatAssignment } from '../types'

// A-19: 固定座席の割当一覧（S-05「固定座席利用者（現在の割当）」パネル）
export function useFixedSeatAssignments() {
  const { data, error, isLoading, mutate } = useSWR<{ items: FixedSeatAssignment[] }>(
    '/api/fixed-seat-assignments',
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
