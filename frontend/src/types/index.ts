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
  /** S-02「座席配置モード」で配置した座席のみ設定される、エリアパネルに対する%座標。未設定はnull */
  pos_x: number | null
  pos_y: number | null
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
  /** 任意の有効期限（YYYY-MM-DD）。nullは無期限（2026-08-28追加） */
  valid_until: string | null
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

// A-54 GET /reservations/proxy-candidates（S-11 代理予約する対象者検索）
export interface ProxyCandidate {
  user_id: number
  user_name: string
  employment_type: string
  current_status: string
}

// A-46 GET /reservations/search（S-11 予約・割当単位の一覧）
export type ProxyRowKind = 'reservation' | 'fixed'

export interface ProxyRow {
  kind: ProxyRowKind
  /** kind='reservation'ならreservations.id、kind='fixed'ならseats.id（A-21の解除に使う） */
  id: number
  user_id: number
  user_name: string
  seat_type: 'free' | 'fixed'
  date: string | null
  seat_no: string
  area: 'NORTH' | 'EAST' | 'WEST'
}

// S-02をS-11から「代理予約モード」で開く際にreact-routerのlocation.stateへ積む値
export interface ProxyBookingFor {
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

// A-30 GET /areas（S-07 座席マスタ管理のエリア選択欄等）
export interface Area {
  id: number
  name: 'NORTH' | 'EAST' | 'WEST'
}

// A-22 GET /seats（S-07 座席マスタ管理）
export interface SeatMasterItem {
  id: number
  seat_no: string
  area_id: number
  area: 'NORTH' | 'EAST' | 'WEST'
  seat_type: SeatType
  status: 'active' | 'retired'
  /** 編集時の警告表示に使う（4.5節: 座席タイプ変更・廃止は個別確認が必要） */
  has_fixed_assignment: boolean
  /** S-02「座席配置モード」で配置した座席のみ設定される。編集時に保持するため取得しておく */
  pos_x: number | null
  pos_y: number | null
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

// A-25 GET /users（S-08 利用者ロール管理タブ）
export interface UserRoleItem {
  id: number
  last_name: string
  first_name: string
  email: string
  employment_type: EmploymentType
  role: Role
  area_manager_role: AreaManagerRole
  employment_status: EmploymentStatus
  retired: boolean
  /** T-15のrole_master_id一覧。編集モーダルのチェックボックス初期状態に使う */
  custom_role_ids: number[]
}

// A-32 GET /role-master（S-08 役割マスタ管理タブ）
export interface RoleMasterItem {
  id: number
  name: string
  description: string | null
  assigned_count: number
}

// A-49 GET /app-settings（S-08 通知設定タブ）
export interface AppSettingItem {
  key: string
  value: string | null
  description: string | null
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri'

// A-27 GET /projects（S-09「四半期計画を開始する」パネル）
export interface ProjectListItem {
  id: number
  name: string
  pm_pl_names: string
  has_plan_for_next_quarter: boolean
}

export type QuarterPlanStatus = 'seats_confirmed' | 'survey_open' | 'weekdays_finalized' | 'seats_allocated'

// A-38 GET /project-quarter-plans（S-09 プロジェクト一覧・出社曜日の調整表）
export interface QuarterPlanItem {
  id: number
  project_id: number
  project_name: string
  pm_pl_names: string
  period_start: string
  period_end: string
  required_seats: number
  status: QuarterPlanStatus
  weekdays_finalized: Weekday[] | null
  allocated_seat_ids: number[] | null
  allocated_seat_label: string | null
  has_response: boolean
  choice1_weekdays: Weekday[] | null
  choice2_weekdays: Weekday[] | null
  note: string | null
}

// S-02をS-09から「座席の島の割当モード」で開く際にreact-routerのlocation.stateへ積む値
export interface SeatBlockFor {
  planId: number
  projectName: string
  requiredSeats: number
}

export type ProjectTitle = 'PM' | 'PL' | 'SL' | null

// A-13 GET /projects/mine（S-04）
export interface MyProjectPlanSummary {
  id: number
  period_start: string
  period_end: string
  status: QuarterPlanStatus
  required_seats: number
  allocated_seat_label: string | null
}

export interface MyProjectItem {
  project_id: number
  project_name: string
  project_title: ProjectTitle
  can_assign_seats: boolean
  plan: MyProjectPlanSummary | null
}

// A-14 GET /project-quarter-plans/{id}（S-04）
export interface ProjectPlanMember {
  member_id: number
  user_id: number
  name: string
  project_title: ProjectTitle
  can_assign_seats: boolean
  assigned_seat_id: number | null
  assigned_seat_no: string | null
}

export interface ProjectPlanResponse {
  choice1_weekdays: Weekday[]
  choice2_weekdays: Weekday[]
  note: string | null
  requested_seats: number | null
}

export interface ProjectPlanDetail {
  id: number
  project_id: number
  project_name: string
  period_start: string
  period_end: string
  status: QuarterPlanStatus
  required_seats: number
  weekdays_finalized: Weekday[] | null
  allocated_seat_ids: number[] | null
  allocated_seat_label: string | null
  allocated_seats: { id: number; seat_no: string }[] | null
  my_project_title: ProjectTitle
  is_pmpl: boolean
  can_manage_seat_assign: boolean
  response: ProjectPlanResponse | null
  has_previous_plan: boolean
  members: ProjectPlanMember[]
}

// A-15 GET /project-quarter-plans/{id}/previous（S-04）
export interface PreviousPlanAssignment {
  user_id: number
  name: string
  seat_no: string | null
}

export interface PreviousPlanDetail {
  id: number
  period_start: string
  period_end: string
  assignments: PreviousPlanAssignment[]
}

// A-18 POST /project-quarter-plans/{id}/seat-assignments（S-04）
export interface SeatAssignmentResult {
  member_user_id: number
  seat_id: number
  seat_no: string
  status: 'assigned' | 'excluded'
  reason?: string
  created_days?: number
  excluded_days?: number
}
