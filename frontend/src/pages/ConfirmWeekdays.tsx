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
  // 対象プロジェクトを個別に取り消す（2026-09-17新設。「特定のプロジェクトの割り当てをキャンセルする
  // 方法がない」との指摘を受けた）。A-62（unfinalize-weekdays）をseats_tentativeにも使えるよう
  // 拡張し、そのプロジェクトだけをsurvey_openに戻す（曜日・座席の選択はやり直せるよう残る）。
  // このページの対象一覧（tentativePlans）から即座に外れる
  const [cancelingId, setCancelingId] = useState<number | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const tentativePlans = plans.filter((p) => p.status === 'seats_tentative')

  const cancelOne = async (id: number) => {
    setCancelingId(id)
    setCancelError(null)
    try {
      await apiFetch(`/api/project-quarter-plans/${id}/unfinalize-weekdays`, { method: 'PUT' })
      await refresh()
    } catch (e) {
      setCancelError(e instanceof ApiError ? e.message : '取り消しに失敗しました')
    } finally {
      setCancelingId(null)
    }
  }

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

  return (
    <div className="mx-auto w-[97vw] max-w-[2400px] space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">この内容で本当に曜日を確定しますか</h1>
        <button
          type="button"
          onClick={() => navigate('/project-seats-area')}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          戻る
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-400">読み込み中...</p>}

      {!isLoading && tentativePlans.length === 0 && (
        <div className="rounded border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          仮の座席割り当て中のプロジェクトはありません。「プロジェクト座席（エリア担当）」の出社曜日の調整表から
          「仮の座席割り当てを作成する」を行ってください。
        </div>
      )}

      {tentativePlans.length > 0 && (
        <div className="space-y-4 rounded border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">
            仮に割り当てた座席の島がそのまま座席割当済みになります。以降は曜日・座席を変更するとやり直しが必要になります。
          </p>
          {/* 座席のエリア図を曜日の数だけ縮小して並べたプレビュー（2026-09-17新設。「プロジェクトごとに
              1行のテキストだとわかりにくいので座席のエリア図と併記して一つの画面に収まるようにしてほしい」
              との要望を受けた）。以前は下にプロジェクトごとのテキスト一覧も併記していたが、「次に座席表を
              下にあるプロジェクトの紹介は削除していいよ」との要望を受けて削除した（2026-09-17修正。
              曜日×座席の対応はこのプレビュー自体で確認できるため） */}
          <WeekdaySeatPreview plans={tentativePlans} />
          {/* プロジェクトごとに個別に取り消せるチップ一覧（2026-09-17新設） */}
          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
            {tentativePlans.map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-1 pl-3 pr-1.5 text-xs text-slate-700">
                {p.project_name}
                <button
                  type="button"
                  disabled={cancelingId === p.id}
                  onClick={() => cancelOne(p.id)}
                  title="このプロジェクトの仮の座席割り当てを取り消す（アンケート回答後の状態に戻ります）"
                  className="rounded-full px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {cancelError && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{cancelError}</p>}
          {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={() => navigate('/project-seats-area')}
              className="rounded border border-slate-300 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
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
