import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AvailabilityResponse } from '../types'
import type { AreaFilter } from './useAvailability'

// A-45: 座席状況の履歴照会（S-10）。「検索」実行前（date=null）はAPIを呼ばない
export function useSeatHistory(date: string | null, area: AreaFilter) {
  const { data, error, isLoading } = useSWR<AvailabilityResponse>(
    date ? `/api/seats/history?date=${date}&area=${area}` : null,
    apiFetch,
  )
  return { history: data, error, isLoading }
}
