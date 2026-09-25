import useSWR, { mutate as globalMutate } from 'swr'
import { apiFetch } from '../lib/api'
import type { FeedbackItem } from '../types'

// A-60: フィードバック一覧（S-14、管理部のみ）。取得のたびにサーバー側でfeedback_last_viewed_atが
// 更新され未読件数（A-88）が0になるため、サイドバーのバッジ（別のSWRキー）もあわせて再検証する
// （2026-09-25追加。「フィードバック開いたら件数が消えるようにしたい」との要望を受けた）
export function useFeedback() {
  const { data, error, isLoading } = useSWR<{ items: FeedbackItem[] }>('/api/feedback', apiFetch, {
    onSuccess: () => globalMutate('/api/feedback/count'),
  })
  return { items: data?.items, error, isLoading }
}

// A-88: フィードバックの未読件数（サイドバーのバッジ表示用、システム運用担当のみ）。enabledがfalseの
// 間（システム運用担当でない利用者）は呼び出さない（2026-09-25追加）
export function useFeedbackCount(enabled: boolean) {
  const { data } = useSWR<{ count: number }>(enabled ? '/api/feedback/count' : null, apiFetch)
  return data?.count
}
