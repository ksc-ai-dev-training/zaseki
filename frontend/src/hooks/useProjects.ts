import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { ProjectListItem } from '../types'

// A-27: 全プロジェクト一覧（S-08「プロジェクト・PM管理」タブ）。呼び出し時に次の四半期の計画データの
// 自動作成が行われる（S-09側、backend側の副作用）
export function useProjects() {
  const { data, error, isLoading, mutate } = useSWR<{ items: ProjectListItem[] }>('/api/projects', apiFetch)
  return {
    items: data?.items ?? [],
    error, isLoading, refresh: mutate,
  }
}
