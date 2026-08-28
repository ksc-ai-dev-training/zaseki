import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { ProjectListItem } from '../types'

// A-27: 全プロジェクト一覧（S-09「四半期計画を開始する」パネル）
export function useProjects() {
  const { data, error, isLoading, mutate } = useSWR<{
    next_quarter_start: string
    next_quarter_end: string
    items: ProjectListItem[]
  }>('/api/projects', apiFetch)
  return {
    items: data?.items ?? [],
    nextQuarterStart: data?.next_quarter_start,
    nextQuarterEnd: data?.next_quarter_end,
    error, isLoading, refresh: mutate,
  }
}
