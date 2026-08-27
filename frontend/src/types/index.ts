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

// A-06 GET /seats/availability（S-02）。fixed/project周りの一部statusはS-05・S-09等の実装後に発生する
export type SeatType = 'free' | 'fixed' | 'project'
export type SeatStatus =
  | 'free' | 'mine' | 'occupied' | 'occupied_fixed' | 'project_confirmed' | 'project_pending'

export interface Seat {
  /** 仕様書のレスポンス例にはないが、予約登録（A-09）のBody.seat_idに使う拡張フィールド */
  id: number
  seat_no: string
  seat_type: SeatType
  status: SeatStatus
  display_name: string | null
  title: string | null
  /** status='mine'のときのみ設定（A-11での取消に使う、仕様書のレスポンス例に対する拡張） */
  reservation_id: number | null
}

export interface SeatBlock {
  block_label: string
  seats: Seat[]
}

export interface AreaAvailability {
  area: 'NORTH' | 'EAST' | 'WEST'
  blocks: SeatBlock[]
}

export interface AvailabilityResponse {
  date: string
  areas: AreaAvailability[]
}

// A-08 GET /reservations/mine（S-02）
export type ReservationState = 'upcoming' | 'used' | 'cancelled'

export interface MyReservation {
  id: number
  date: string
  seat_no: string
  area: string
  type: 'single' | 'recurring'
  registrant: string
  state: ReservationState
}
