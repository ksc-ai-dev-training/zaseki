import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { ProjectPlanDetail } from '../types'

// A-14: 四半期計画の詳細（S-04）
export function useProjectPlanDetail(planId: number) {
  const { data, error, isLoading, mutate } = useSWR<ProjectPlanDetail>(
    `/api/project-quarter-plans/${planId}`,
    apiFetch,
  )
  return { plan: data, error, isLoading, refresh: mutate }
}
