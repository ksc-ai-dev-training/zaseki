import { Link } from 'react-router'
import { useAdminSummary } from '../hooks/useAdminSummary'

// サイドバーの「管理メニュー」項目の下にも同じ入口をまとめて出せるよう、この一覧をエクスポートする
// （2026-09-14追加。「管理部メニューの下に固定座席の指定、代理予約・取り消し、座席マスタ管理、
// 権限・PJ管理、プロジェクト席（エリア担当）を選べるようにしてほしい」との要望を受けた。
// S-06本体〔カード一覧〕とサイドバーの二重管理を避けるため、この配列を唯一の情報源にする）
export const CARDS: { id: string; to: string; name: string }[] = [
  { id: 'S-05', to: '/fixed-seats', name: '固定座席の指定' },
  { id: 'S-11', to: '/proxy-booking', name: '代理予約・取消' },
  { id: 'S-07', to: '/seat-master', name: '座席マスタ管理' },
  { id: 'S-08', to: '/roles', name: '権限・PJ管理' },
  { id: 'S-09', to: '/project-seats-area', name: 'プロジェクト座席（エリア担当）' },
]
// S-10（座席状況の履歴照会）は2026-09-07に廃止した。空き状況・予約（S-02）が過去31日
// （D12・S-10と同じ上限）に加えて未来も無制限に見られ、S-10はその完全な部分集合でしか
// なかったため（「空き状況・予約の方が見れる範囲が広い」との指摘を受けた）。
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
      </header>

      <div className="space-y-8 p-6">
        {/* サマリーと画面一覧の境目が分かりにくかったため区切り線を追加（2026-09-10追加。
            「その他の画面にも区切るポイントがあったら線を作成してほしい」との要望を受けた） */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">サマリー</h2>
          <div className="flex flex-wrap gap-4">
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
        </section>

        <hr className="border-slate-200" />

        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">各画面への入口</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CARDS.map((c) => (
              <Link
                key={c.id}
                to={c.to}
                className="rounded border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm"
              >
                <div className="font-semibold text-slate-800">{c.name}</div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
