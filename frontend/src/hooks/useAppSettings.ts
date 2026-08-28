import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AppSettingItem } from '../types'

// A-49: 通知設定タブで編集可能な設定値の取得
export function useAppSettings() {
  const { data, error, isLoading, mutate } = useSWR<{ items: AppSettingItem[] }>(
    '/api/app-settings',
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, refresh: mutate }
}
