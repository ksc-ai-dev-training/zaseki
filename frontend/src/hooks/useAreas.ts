import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { Area } from '../types'

// A-30: エリア一覧（静的なマスタ参照、role='admin'必須）。enabled=falseの間は取得しない
// （一般利用者がS-02を開くたびに403が発生するのを避けるため）
export function useAreas(enabled: boolean = true) {
  const { data, error, isLoading } = useSWR<{ items: Area[] }>(enabled ? '/api/areas' : null, apiFetch)
  return { items: data?.items ?? [], error, isLoading }
}
