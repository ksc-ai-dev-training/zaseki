import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AvailabilityResponse } from '../types'

export type AreaFilter = 'all' | 'north' | 'east' | 'west'

// A-06: 指定日・エリアの座席状況一覧（FR-04-1〜3）
export function useAvailability(date: string, area: AreaFilter) {
  const { data, error, isLoading, mutate } = useSWR<AvailabilityResponse>(
    `/api/seats/availability?date=${date}&area=${area}`,
    apiFetch,
  )
  return { availability: data, error, isLoading, refresh: mutate }
}
