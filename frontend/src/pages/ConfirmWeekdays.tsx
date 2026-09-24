import { useState } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../lib/api'
import { useQuarterPlans } from '../hooks/useQuarterPlans'
import WeekdaySeatPreview from '../components/WeekdaySeatPreview'

// S-09「出社曜日の調整表」の「この内容で本当に曜日を確定する」の確認画面（2026-09-17新設。
// 当初はProjectSeatAllocation.tsx（プロジェクト座席〔エリア担当〕）内のモーダル→ページ内常時表示
// として実装していたが、「プロジェクト座席（エリア担当）ではなく別の画面としてみれるようにしたい」
// との要望を受け、独立した画面に切り出した。曜日調整表の「仮の座席割り当てを作成する」で
// status='seats_tentative'になった行だけを対象に、実際にfinalize-weekdays（A-43）を呼んで
// status='seats_allocated'まで確定する。対象の一覧・座席のエリア図プレビューは
// ProjectSeatAllocation.tsxとは別に、useQuarterPlansを直接呼んで最新の状態を取得する
// （「本当に確定する」ボタンで遷移してくる直前に必ず仮の座席割り当てが保存されているため、
// checked等の編集中の状態を引き継ぐ必要はなく、DBの値〔weekdays_finalized・allocated_seats〕を
// そのまま使えばよい）。
export default function ConfirmWeekdays() {
  const navigate = useNavigate()
  const { items: plans, isLoading, refresh } = useQuarterPlans()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tentativePlans = plans.filter((p) => p.status === 'seats_tentative')

  const confirmFinal = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/project-quarter-plans/finalize-weekdays', {
        method: 'PUT',
        body: JSON.stringify({
          plans: tentativePlans.map((p) => ({ plan_id: p.id, weekdays_finalized: p.weekdays_finalized ?? [] })),
        }),
      })
      await refresh()
      navigate('/project-seats-area')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '確定に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  // 2026-09-18修正: w-[97vw]はサイドバー幅を考慮せずビューポート全体に対する割合で計算するため、
  // サイドバーと合わせるとビューポート幅を超えてしまい、見出し行の「戻る」ボタン等が画面外に
  // はみ出す不具合があった（「この内容で確定する」ボタンを見出し位置に配置した際に発覚）。
  // 親レイアウト（Layout.tsx）がsm:flex-1でサイドバー分を差し引いた残り幅を渡してくれているため、
  // w-fullに変更してそれをそのまま使う（max-w-[2400px]で広い画面での上限は維持）
  return (
    <div className="mx-auto w-full max-w-[2400px] space-y-4 p-6">
      {/* 見出しテキスト（「この内容で本当に曜日を確定しますか」）を削除し、その位置に「この内容で
          確定する」ボタンを配置した（2026-09-18修正。「フロアマップが曜日4つぶん縦に並ぶため、
          下までスクロールしないとボタンが見つからない」との指摘を受け、いったん見出し横に追加した
          ところ、「見出しは削除してその位置にボタンを配置してほしい」との訂正を受けた）。下部の
          ボタン（内容を確認しながら押す一連の流れ用）はそのまま残す。position:stickyで
          スクロール中も常に見える行に置く */}
      <div className="sticky top-0 z-10 -mx-6 flex items-center justify-between gap-2 bg-slate-100 px-6 py-2">
        {tentativePlans.length > 0 ? (
          <button
            type="button"
            disabled={submitting}
            onClick={confirmFinal}
            className="rounded bg-green-700 px-4 py-1.5 text-sm text-white disabled:opacity-50"
          >
            この内容で確定する
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => navigate('/project-seats-area')}
          className="rounded border border-slate-500 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          戻る
        </button>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

      {!isLoading && tentativePlans.length === 0 && (
        <div className="rounded border border-slate-400 bg-white p-6 text-center text-sm text-slate-400">
          仮の座席割り当て中のプロジェクトはありません。「プロジェクト座席（エリア担当）」の出社曜日の調整表から
          「仮の座席割り当てを作成する」を行ってください。
        </div>
      )}

      {tentativePlans.length > 0 && (
        <div className="space-y-4 rounded border border-slate-400 bg-white p-4">
          <p className="text-sm text-slate-500">
            仮に割り当てた座席の島がそのまま座席割当済みになります。以降は曜日・座席を変更するとやり直しが必要になります。
          </p>
          {/* 座席のエリア図を曜日の数だけ縮小して並べたプレビュー（2026-09-17新設。「プロジェクトごとに
              1行のテキストだとわかりにくいので座席のエリア図と併記して一つの画面に収まるようにしてほしい」
              との要望を受けた）。以前は下にプロジェクトごとのテキスト一覧も併記していたが、「次に座席表を
              下にあるプロジェクトの紹介は削除していいよ」との要望を受けて削除した（2026-09-17修正。
              曜日×座席の対応はこのプレビュー自体で確認できるため） */}
          <WeekdaySeatPreview plans={tentativePlans} />
          <div className="flex justify-end gap-2 border-t border-slate-400 pt-3">
            <button
              type="button"
              onClick={() => navigate('/project-seats-area')}
              className="rounded border border-slate-500 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={confirmFinal}
              className="rounded bg-green-700 px-4 py-1.5 text-sm text-white disabled:opacity-50"
            >
              この内容で確定する
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
