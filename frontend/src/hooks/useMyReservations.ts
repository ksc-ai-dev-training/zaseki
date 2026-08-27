import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { MyReservation } from '../types'

// A-08: 自分の予約一覧（FR-01-4）
export function useMyReservations(scope: 'upcoming' | 'past') {
  const { data, error, isLoading, mutate } = useSWR<{ items: MyReservation[] }>(
    `/api/reservations/mine?scope=${scope}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, mutate }
}
