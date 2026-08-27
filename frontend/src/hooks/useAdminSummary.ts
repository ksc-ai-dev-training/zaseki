import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AdminSummary } from '../types'

// A-51: 管理メニュー（S-06）のサマリー
export function useAdminSummary() {
  const { data, error, isLoading } = useSWR<AdminSummary>('/api/admin/summary', apiFetch)
  return { summary: data, error, isLoading }
}
