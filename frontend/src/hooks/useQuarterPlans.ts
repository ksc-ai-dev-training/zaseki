import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { QuarterPlanItem } from '../types'

// A-38: 四半期での一覧（S-09）。quarterは対象期間の開始日（YYYY-MM-DD）、空なら全件
export function useQuarterPlans(quarter: string) {
  const params = new URLSearchParams()
  if (quarter) params.set('quarter', quarter)
  const { data, error, isLoading, mutate } = useSWR<{ items: QuarterPlanItem[] }>(
    `/api/project-quarter-plans?${params.toString()}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
