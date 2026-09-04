import { Link } from 'react-router'
import { useAdminSummary } from '../hooks/useAdminSummary'

const CARDS: { id: string; to: string; name: string; desc: string }[] = [
  {
    id: 'S-05',
    to: '/fixed-seats',
    name: '固定座席の指定',
    desc: '固定座席利用者の座席を指定する（FR-01-5）。プロジェクトメンバーへの代理予約はプロジェクト座席画面（S-04）で行う。',
  },
  {
    id: 'S-11',
    to: '/proxy-booking',
    name: '代理予約・取消',
    desc: 'プロジェクトメンバー・固定座席利用者のいずれにも該当しない利用者について、通常の座席（フリー座席）を一時的に代理予約・代理取消する（FR-01-5・FR-01-7）。',
  },
  {
    id: 'S-07',
    to: '/seat-master',
    name: '座席マスタ管理',
    desc: '座席の追加・編集・廃止を行う（FR-06-1, FR-06-2）。',
  },
  {
    id: 'S-08',
    to: '/roles',
    name: '権限・役割管理',
    desc: '利用者への役割（管理部）の割当、プロジェクトメンバーへのPM・PL設定、PJ席決担当の指定、エリア責任者・副責任者の指定を行う。',
  },
  {
    id: 'S-09',
    to: '/project-seats-area',
    name: 'プロジェクト座席（エリア担当）',
    desc: '必要座席数の確認・出社曜日アンケートの実施・調整・座席の島の割当（FR-03-2〜6）を行う（四半期計画データはシステムが自動作成する）。',
  },
  {
    id: 'S-10',
    to: '/history',
    name: '座席状況の履歴照会',
    desc: '日付を指定して、過去の座席状況をフロアマップ形式で参照専用表示する。照会範囲は直近1か月（D12）。',
  },
]
// フィードバック一覧（S-14）はここには置かない。管理部ではなくシステム運用担当のみが対象のため、
// 本カード一覧（role='admin'向け入口）には含めず、サイドバーの専用リンクからアクセスする
// （FR-09-3、2026-09-01追加）。

// S-06 管理メニュー。座席数等のサマリーと、他画面への入口カードのみを持つ（4章の対象外）
export default function AdminMenu() {
  const { summary, isLoading } = useAdminSummary()

  const stats: { label: string; value: number | undefined; unit: string }[] = [
    { label: '総座席数', value: summary?.total_seats, unit: '席' },
    { label: '稼働エリア数', value: summary?.active_areas, unit: 'エリア' },
    { label: '登録利用者数', value: summary?.registered_users, unit: '名' },
    { label: '管理部人数', value: summary?.admin_count, unit: '名' },
  ]

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">管理メニュー</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-06</span>
      </header>

      <div className="p-6">
        <div className="mb-8 flex flex-wrap gap-4">
          {stats.map((s) => (
            <div key={s.label} className="min-w-[140px] flex-1 rounded border border-slate-200 bg-white px-5 py-4">
              <div className="text-xs text-slate-500">{s.label}</div>
              <div className="mt-1 text-2xl font-bold text-slate-800">
                {isLoading || s.value === undefined ? '—' : s.value}
                <span className="ml-1 text-sm font-normal text-slate-400">{s.unit}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c) => (
            <Link
              key={c.id}
              to={c.to}
              className="rounded border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm"
            >
              <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">
                {c.id}
              </span>
              <div className="mt-2 font-semibold text-slate-800">{c.name}</div>
              <div className="mt-1 text-xs leading-relaxed text-slate-500">{c.desc}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
