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

// A-51 GET /admin/summary（S-06 管理メニュー）
export interface AdminSummary {
  total_seats: number
  active_areas: number
  registered_users: number
  admin_count: number
}

// A-19 GET /fixed-seat-assignments（S-05 固定座席利用者一覧）
export interface FixedSeatAssignment {
  seat_id: number
  seat_no: string
  area: 'NORTH' | 'EAST' | 'WEST'
  user_id: number
  user_name: string
}

// A-52 GET /fixed-seat-assignments/candidates（S-05 対象者検索）
export interface FixedSeatCandidate {
  user_id: number
  user_name: string
  current_status: string
}

// S-02をS-05から「固定座席指定モード」で開く際にreact-routerのlocation.stateへ積む値
export interface AssignFixedSeatFor {
  userId: number
  userName: string
}

// A-07 GET /seats/availability/period（S-02 期間ビュー）。固定座席（seat_type='fixed'）は対象外
export type PeriodCellStatus = 'free' | 'mine' | 'occupied'

export interface PeriodCell {
  status: PeriodCellStatus
  display_name: string | null
  reservation_id: number | null
}

export interface PeriodSeat {
  id: number
  seat_no: string
  area: 'NORTH' | 'EAST' | 'WEST'
  seat_type: SeatType
  /** 日付(YYYY-MM-DD)ごとのセル。キーが存在しない日は'free'とみなす（ペイロード削減） */
  days: Record<string, PeriodCell>
}

export interface PeriodAvailabilityResponse {
  start: string
  end: string
  /** RULE-05に基づく予約可能期間全体（「予約可能期間全体を表示」で戻す先） */
  full_start: string
  full_end: string
  dates: string[]
  seats: PeriodSeat[]
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
