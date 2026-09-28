import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AreaFilter } from './useAvailability'
import type { PeriodAvailabilityResponse } from '../types'

// A-07: 期間ビュー（FR-04-4）。start/end省略時はRULE-05の予約可能期間全体が既定値になる
export function usePeriodAvailability(start: string | undefined, end: string | undefined, area: AreaFilter) {
  const params = new URLSearchParams()
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  params.set('area', area)
  const query = params.toString()

  const { data, error, isLoading, mutate } = useSWR<PeriodAvailabilityResponse>(
    `/api/seats/availability/period${query ? `?${query}` : ''}`,
    apiFetch,
    // useAvailability（A-06）と同じ理由で、WebSocket切断時の保険として30秒間隔のポーリングのみ
    // 残す（2026-09-28、ポーリングからWebSocket〔A-89〕への切替）
    { refreshInterval: 30000 },
  )
  return { period: data, error, isLoading, refresh: mutate }
}
