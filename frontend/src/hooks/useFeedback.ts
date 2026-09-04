import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { FeedbackItem } from '../types'

// A-60: フィードバック一覧（S-14、管理部のみ）
export function useFeedback() {
  const { data, error, isLoading } = useSWR<{ items: FeedbackItem[] }>('/api/feedback', apiFetch)
  return { items: data?.items, error, isLoading }
}
