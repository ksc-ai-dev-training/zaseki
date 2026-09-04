import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { ProxyRow } from '../types'

export type ProxySeatTypeFilter = 'all' | 'free' | 'fixed' | 'project'

// A-46: 代理予約・取消の対象者検索（予約・割当単位の一覧）。start/endはYYYY-MM（表示期間、任意）
export function useProxySearch(userName: string, seatType: ProxySeatTypeFilter, start: string, end: string) {
  const params = new URLSearchParams({ seat_type: seatType })
  if (userName) params.set('user_name', userName)
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  const { data, error, isLoading, mutate } = useSWR<{ items: ProxyRow[] }>(
    `/api/reservations/search?${params.toString()}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
