import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { MyProjectItem } from '../types'

// A-13: 自分がPM・PL・SL・メンバーであるプロジェクトの一覧（S-04）
export function useMyProjects() {
  const { data, error, isLoading, mutate } = useSWR<{ items: MyProjectItem[] }>(
    '/api/projects/mine',
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
