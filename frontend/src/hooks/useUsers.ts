import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { UserRoleItem, Role, EmploymentStatus } from '../types'

export type UserRoleFilter = 'all' | Role
export type UserStatusFilter = 'all' | EmploymentStatus

// A-25: 利用者一覧（S-08 利用者ロール管理タブ）
export function useUsers(role: UserRoleFilter, employmentStatus: UserStatusFilter, showRetired: boolean, q: string) {
  const params = new URLSearchParams({ role, employment_status: employmentStatus, show_retired: String(showRetired) })
  if (q) params.set('q', q)
  const { data, error, isLoading, mutate } = useSWR<{ items: UserRoleItem[] }>(
    `/api/users?${params.toString()}`,
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
