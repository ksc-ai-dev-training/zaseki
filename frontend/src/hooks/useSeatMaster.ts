import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AreaFilter } from './useAvailability'
import type { SeatMasterItem } from '../types'

export type SeatStatusFilter = 'all' | 'active' | 'retired'

// A-22: 座席一覧（S-07 座席マスタ管理）
export function useSeatMaster(area: AreaFilter, status: SeatStatusFilter, q: string) {
  const params = new URLSearchParams({ area, status })
  if (q) params.set('q', q)
  const { data, error, isLoading, mutate } = useSWR<{ items: SeatMasterItem[] }>(
    `/api/seats?${params.toString()}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
