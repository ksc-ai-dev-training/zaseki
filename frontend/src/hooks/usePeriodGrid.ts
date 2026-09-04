import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AreaFilter } from './useAvailability'
import type { PeriodGridResponse } from '../types'

// A-69: 期間ビュー（S-11、代理予約・取消の管理用グリッド）。start/end省略時はRULE-05の
// 予約可能期間全体が既定値になる（A-07のusePeriodAvailabilityと同じ考え方）
export function usePeriodGrid(start: string | undefined, end: string | undefined, area: AreaFilter) {
  const params = new URLSearchParams()
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  params.set('area', area)
  const query = params.toString()

  const { data, error, isLoading, mutate } = useSWR<PeriodGridResponse>(
    `/api/reservations/period-grid${query ? `?${query}` : ''}`,
    apiFetch,
  )
  return { grid: data, error, isLoading, refresh: mutate }
}
