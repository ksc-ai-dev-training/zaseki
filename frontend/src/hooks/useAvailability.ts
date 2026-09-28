import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AvailabilityResponse } from '../types'

export type AreaFilter = 'all' | 'north' | 'east' | 'west'

// A-06: 指定日・エリアの座席状況一覧（FR-04-1〜3）
export function useAvailability(date: string, area: AreaFilter) {
  const { data, error, isLoading, mutate } = useSWR<AvailabilityResponse>(
    `/api/seats/availability?date=${date}&area=${area}`,
    apiFetch,
    // 他の利用者が予約・取消した結果をリアルタイムに近い形で画面に反映するため、1秒間隔で
    // 自動的に再取得する（2026-09-28追加。「席の予約がされたときリアルタイムですぐに反映される
    // ようになっているか」との質問を受け、従来は自分の操作直後の再取得とタブのフォーカス時の
    // 再検証〔SWR既定動作〕のみで、他の利用者の操作は画面を開いたままでは反映されなかった。
    // WebSocket等のサーバープッシュまでは導入せず、定期ポーリングで対応する。当初5秒間隔で
    // 実装したが「もっとすぐに反映することは可能か」との質問を受け、1秒に短縮した。SWRは既定で
    // 同一キーへの再取得を2秒間まとめる（dedupingInterval既定2000ms）ため、これも1秒に
    // 下げないとrefreshIntervalを1秒にしても実際には2秒間隔にしかならない点に注意）
    { refreshInterval: 1000, dedupingInterval: 1000 },
  )
  return { availability: data, error, isLoading, refresh: mutate }
}
