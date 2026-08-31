import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { MyProfile } from '../types'

// A-56・A-57: マイプロフィール（S-12）
export function useMyProfile() {
  const { data, error, isLoading, mutate } = useSWR<MyProfile>('/api/users/me/profile', apiFetch)
  return { profile: data, error, isLoading, mutate }
}
