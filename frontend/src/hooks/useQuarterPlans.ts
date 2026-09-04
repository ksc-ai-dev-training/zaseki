import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { QuarterPlanItem } from '../types'

// A-38: プロジェクト座席の計画データ一覧（S-09）。2026-09-03、「四半期」の概念を撤廃したことに伴い
// quarter絞り込みパラメータを廃止し常に全件を返すよう変更した（検討資料「プロジェクト座席・曜日調整
// フロー改善案」変更D）。unplanned_projectsは、今日以降に及ぶ計画データを1件も持たないプロジェクト
// （まだ期間を設定していないプロジェクト）の一覧。
export function useQuarterPlans() {
  const { data, error, isLoading, mutate } = useSWR<{
    items: QuarterPlanItem[]
    unplanned_projects: { id: number; name: string }[]
  }>('/api/project-quarter-plans', apiFetch)
  return {
    items: data?.items ?? [],
    unplannedProjects: data?.unplanned_projects ?? [],
    error, isLoading, refresh: mutate,
  }
}
