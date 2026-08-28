import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { RoleMasterItem } from '../types'

// A-32: 役割マスタ一覧（S-08 役割マスタ管理タブ）
export function useRoleMaster() {
  const { data, error, isLoading, mutate } = useSWR<{ items: RoleMasterItem[] }>(
    '/api/role-master',
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
