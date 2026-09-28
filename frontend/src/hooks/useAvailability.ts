import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AvailabilityResponse } from '../types'

export type AreaFilter = 'all' | 'north' | 'east' | 'west'

// A-06: 指定日・エリアの座席状況一覧（FR-04-1〜3）
export function useAvailability(date: string, area: AreaFilter) {
  const { data, error, isLoading, mutate } = useSWR<AvailabilityResponse>(
    `/api/seats/availability?date=${date}&area=${area}`,
    apiFetch,
    // 他の利用者が予約・取消した結果は、主にWebSocket（useLiveAvailabilitySync、A-89）による
    // 即時プッシュで反映される（2026-09-28、ポーリング〔当初5秒→1秒〕からの切替）。本間隔は
    // WebSocketが切断されている間の保険として残す30秒間隔の緩いポーリングで、通常はWebSocketの
    // 再接続（3秒後）の方が先に効くため、実際にこの間隔で取り直されることは稀な想定
    { refreshInterval: 30000 },
  )
  return { availability: data, error, isLoading, refresh: mutate }
}
