// APIレスポンス型定義（詳細設計書 3章・4章）

export type Role = 'general' | 'admin'
export type AreaManagerRole = 'manager' | 'deputy' | null
export type EmploymentType = 'employee' | 'contract' | 'bp'
export type EmploymentStatus = 'active' | 'leave' | 'retired'

// A-05のレスポンス。所属プロジェクト等（T-05/T-06）はそれらを扱う画面の実装時に追加する
export interface Me {
  id: number
  email: string
  last_name: string
  first_name: string
  role: Role
  area_manager_role: AreaManagerRole
  employment_type: EmploymentType
  employment_status: EmploymentStatus
}

export interface DevUser {
  email: string
  last_name: string
  first_name: string
  role: Role
}
