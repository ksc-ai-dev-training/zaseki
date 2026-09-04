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
  /** マイプロフィール（S-12）で登録したアイコン画像（data URL）。未登録はnull（2026-08-31追加） */
  avatar_image: string | null
  /** システム運用担当（FR-09-3、2026-09-01追加）。role='admin'とは独立の属性で、
   * フィードバック一覧（S-14）へのアクセスに使う */
  is_system_operator: boolean
}

// A-56・A-57 マイプロフィール（S-12）。要件定義書4.8節・FR-08-1〜2
export interface MyProfile {
  avatar_image: string | null
  /** 生年月日は月・日のみ（年は保存しない、FR-08-2）。未登録はいずれもnull */
  birth_month: number | null
  birth_day: number | null
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
  /** マイプロフィール（S-12）で登録したアイコン画像（data URL）。未登録・空き座席等はnull（FR-08-3、2026-08-31追加） */
  avatar_image: string | null
  /** 表示中の日付（date引数）が誕生日（月日一致）の利用者が使用中の座席のみtrue（FR-08-4、2026-08-31追加） */
  is_birthday: boolean
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
  current_status: SeatType
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
  current_status: SeatType
}

// A-46 GET /reservations/search（S-11 予約・割当単位の一覧）
export type ProxyRowKind = 'reservation' | 'fixed'

export interface ProxyRow {
  kind: ProxyRowKind
  /** kind='reservation'ならreservations.id、kind='fixed'ならseats.id（A-21の解除に使う） */
  id: number
  user_id: number
  user_name: string
  seat_type: 'free' | 'fixed' | 'project'
  date: string | null
  seat_no: string
  area: 'NORTH' | 'EAST' | 'WEST'
  /** seat_type='project'のときのプロジェクト名。それ以外はnull（2026-09-01追加） */
  project_name: string | null
}

// S-02をS-11から「代理予約モード」で開く際にreact-routerのlocation.stateへ積む値
export interface ProxyBookingFor {
  userId: number
  userName: string
}

// A-07 GET /seats/availability/period（S-02 期間ビュー）。固定座席（seat_type='fixed'）は割当期間中の
// 最初の日のみ氏名を表示し、以降は'-'（display_name）とする（occupied_fixed、2026-09-02追加）
export type PeriodCellStatus = 'free' | 'mine' | 'occupied' | 'occupied_fixed'

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

// A-69 GET /reservations/period-grid（S-11 期間ビュー）。A-07と同じ座席×日付のマトリクス形式だが、
// 管理部が代理で取消・変更するため氏名の匿名化を行わず、対象者と操作対象のIDを常に返す
// （2026-09-03追加。「S-11をS-02の期間ビューのような画面にしたい」との要望を受けた）
export type PeriodGridCellStatus = 'free' | 'reserved' | 'fixed'

export interface PeriodGridCell {
  status: PeriodGridCellStatus
  kind: ProxyRowKind | null
  /** kind='reservation'ならreservations.id、kind='fixed'ならseats.id（A-21の解除に使う）。'free'ならnull */
  id: number | null
  user_id: number | null
  user_name: string | null
  project_name: string | null
}

export interface PeriodGridSeat {
  id: number
  seat_no: string
  area: 'NORTH' | 'EAST' | 'WEST'
  seat_type: SeatType
  days: Record<string, PeriodGridCell>
}

export interface PeriodGridResponse {
  start: string
  end: string
  full_start: string
  full_end: string
  dates: string[]
  seats: PeriodGridSeat[]
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
  seat_type: SeatType
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
  /** システム運用担当（FR-09-3、2026-09-01追加）。フィードバック一覧（S-14）へのアクセスに使う */
  is_system_operator: boolean
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

// A-27 GET /projects（S-08「プロジェクト・PM管理」タブ）
export interface ProjectMemberSummary {
  member_id: number
  user_id: number
  name: string
  project_title: ProjectTitle
}

export interface ProjectListItem {
  id: number
  name: string
  pm_pl_names: string
  member_count: number
  members: ProjectMemberSummary[]
  proxy_user_id: number | null
  proxy_user_name: string | null
}

export type QuarterPlanStatus = 'seats_confirmed' | 'survey_open' | 'weekdays_finalized' | 'seats_allocated'

// A-38 GET /project-quarter-plans（S-09 プロジェクト一覧・出社曜日の調整表）
export interface QuarterPlanItem {
  id: number
  project_id: number
  project_name: string
  seat_assigner_names: string
  period_start: string
  period_end: string
  required_seats: number
  non_fixed_member_count: number
  status: QuarterPlanStatus
  weekdays_finalized: Weekday[] | null
  allocated_seat_ids: number[] | null
  allocated_seat_label: string | null
  has_response: boolean
  choice1_weekdays: Weekday[] | null
  choice2_weekdays: Weekday[] | null
  note: string | null
  previous_area: 'NORTH' | 'EAST' | 'WEST' | null
}

// S-02をS-09から「座席の島の割当モード」で開く際にreact-routerのlocation.stateへ積む値
export interface SeatBlockFor {
  planId: number
  projectName: string
  requiredSeats: number
  // 割当済み（status='seats_allocated'）の計画を「編集」で開いた場合、現在の割当座席（2026-08-28追加）。
  // 新規割当（weekdays_finalizedから遷移）の場合はundefined
  allocatedSeatIds?: number[]
  // 対象四半期の開始日（YYYY-MM-DD、10/1・1/1・4/1・7/1のいずれか）。フロアマップの初期表示日の
  // 起点にする（2026-08-31追加。「プロジェクト座席が決まる基準日の座席表を表示してほしい」との
  // 要望を受けた。割当時点〔今日〕ではなく実際に座席が使われ始める日の空き状況を見ながら座席を
  // 選べるようにするため）
  periodStart: string
  // 確定した出社曜日（T-07.weekdays_finalized）。フロアマップの初期表示日は、periodStartそのもの
  // ではなく、periodStart以降でこの曜日に最初に該当する日にする（2026-09-02追加。「曜日が確定して
  // いるときに座席の割り当てをするので、その曜日のプロジェクト始動日初日に設定してほしい」との
  // 要望を受けた。periodStart自体が確定曜日と一致しないことがあるため）
  weekdaysFinalized?: Weekday[] | null
}

// S-04をS-02から「メンバーへの座席確保モード」で開く際にreact-routerのlocation.stateへ積む値
// （2026-08-31追加。「座席表から選択できるようにしてほしい」との要望を受けた）
export interface MemberSeatAssignFor {
  planId: number
  projectName: string
  // 対象四半期の開始日（YYYY-MM-DD）。フロアマップの初期表示日にする（S-09の座席の島の割当と同じ考え方）
  periodStart: string
  // 座席の島の範囲（この範囲内の座席のみ選択対象にする）
  allocatedSeatIds: number[]
  // まだ座席が確保されていないメンバー（固定座席保有者は対象外）
  members: { userId: number; name: string }[]
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
  // 対象四半期を自由に選択できるよう、存在する計画を全件（period_start昇順）返す
  // （2026-08-31訂正。従来はplan: MyProjectPlanSummary | null で直近1件のみだった）
  plans: MyProjectPlanSummary[]
}

// A-14 GET /project-quarter-plans/{id}（S-04）
export interface ProjectPlanMember {
  member_id: number
  user_id: number
  name: string
  project_title: ProjectTitle
  can_assign_seats: boolean
  has_fixed_seat: boolean
  seat_not_required: boolean
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

// A-10 POST /reservations/recurring（S-02）
export interface RecurringReservationDayResult {
  date: string
  status: 'created' | 'excluded'
  reason?: string
}

export interface RecurringReservationResult {
  rule_id: number
  seat_id: number
  seat_no: string
  results: RecurringReservationDayResult[]
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

// フィードバック（S-13「フィードバック」タブ・S-14一覧、FR-09-2・FR-09-3、2026-09-01追加）
export type FeedbackCategory = 'bug' | 'request' | 'other'

// A-60 GET /feedback（S-14、管理部のみ）
export interface FeedbackItem {
  id: number
  category: FeedbackCategory
  category_ja: string
  content: string
  created_at: string
  name: string
}
