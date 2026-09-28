import { useState, type ReactNode } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import type { FeedbackCategory } from '../types'

type Tab = 'common' | 'pmpl' | 'admin' | 'feedback'

const TABS: { key: Tab; label: string }[] = [
  { key: 'common', label: '共通操作（全員）' },
  { key: 'pmpl', label: 'PM・PL向け' },
  { key: 'admin', label: '管理部・エリア責任者向け' },
  { key: 'feedback', label: 'フィードバック' },
]

const CATEGORY_OPTIONS: { key: FeedbackCategory; label: string }[] = [
  { key: 'request', label: '改善要望' },
  { key: 'bug', label: '不具合報告' },
  { key: 'other', label: 'その他' },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded border border-slate-400 bg-white p-5">
      <h2 className="mb-3 text-[15px] font-semibold text-slate-800">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-slate-700">{children}</div>
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-900">
      {children}
    </div>
  )
}

// 操作手順の画面キャプチャ（2026-09-08追加。「予約方法のやり方を写真付きで作成してほしい」との
// 要望を受けた。実際にログインして操作した画面のスクリーンショットを frontend/public/help/ に
// 配置し、ここから参照する）
function Screenshot({ src, caption }: { src: string; caption: string }) {
  return (
    <figure className="overflow-hidden rounded border border-slate-400">
      <img src={src} alt={caption} className="block w-full" />
      <figcaption className="border-t border-slate-400 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
        {caption}
      </figcaption>
    </figure>
  )
}

// フィードバックの送信フォーム（A-59、FR-09-2）。分類＋自由記述のみのシンプルな構成。
// 送信されたフィードバックは一覧画面（S-14、A-60、is_system_operatorの利用者のみ閲覧可）で確認する
function FeedbackForm() {
  const [category, setCategory] = useState<FeedbackCategory>('request')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = async () => {
    setError(null)
    if (!content.trim()) {
      setError('内容を入力してください')
      return
    }
    setSubmitting(true)
    try {
      await apiFetch('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ category, content }),
      })
      setContent('')
      setSent(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Section title="フィードバックを送る">
      <p>気づいたことがあれば分類を選んで送ってください。システムの運用担当者が確認します。</p>
      <div>
        <div className="mb-1.5 text-xs font-semibold text-slate-600">分類</div>
        <div className="flex gap-4">
          {CATEGORY_OPTIONS.map((o) => (
            <label key={o.key} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="feedback-category"
                checked={category === o.key}
                onChange={() => {
                  setCategory(o.key)
                  setSent(false)
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-xs font-semibold text-slate-600">内容</div>
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            setSent(false)
          }}
          rows={5}
          maxLength={2000}
          placeholder="気づいたことを自由に記入してください"
          className="w-full rounded border border-slate-500 px-3 py-2 text-sm"
        />
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {sent && <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">送信しました。ご協力ありがとうございます。</p>}
      <div>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="rounded bg-blue-800 px-4 py-1.5 text-sm text-white hover:bg-blue-900 disabled:opacity-50"
        >
          送信する
        </button>
      </div>
    </Section>
  )
}

// S-13 ヘルプ（操作マニュアル）。要求仕様書には明記のない追加提案（FR-09-1、2026-09-01追加）。
// 「開発部分の人もヘルプとして操作マニュアルを作成してほしい、画面内に作成してほしい」との要望を受け、
// 検討資料の操作マニュアル下書き（2026-09-01）の内容を、役割別タブに整理して画面内に組み込んだ。
// 2026-09-28、「もう一度０から書き直してほしい」との要望を受け、タブ構成・章立て・スクリーンショットは
// 維持したまま説明文を全面的に書き直した後、続けて「もう少し短くしてほしい」との要望を受けさらに
// 簡潔にした（いずれもAskUserQuestion・要望のとおり）。
export default function Help() {
  const [tab, setTab] = useState<Tab>('common')

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-400 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">ヘルプ（操作マニュアル）</h1>
      </header>

      <div className="border-b border-slate-400 bg-white px-6">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`border-b-2 px-3 py-3 text-sm font-medium ${
                tab === t.key ? 'border-blue-800 text-blue-800' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-3xl space-y-5 p-6">
        {tab === 'common' && (
          <>
            <Section title="ログイン">
              <ol className="list-decimal space-y-1 pl-5">
                <li>ログイン画面の「Googleでログイン」から、会社の許可されたドメインのGoogleアカウントでログインします。</li>
                <li>初回ログイン時はGoogleアカウントの氏名がそのまま登録されます。誤りがあれば管理部に修正を依頼してください。</li>
              </ol>
            </Section>

            <Section title="マイプロフィールの設定">
              <ol className="list-decimal space-y-3 pl-5">
                <li>サイドバーの「マイプロフィール」から、アイコン画像・生年月日（月日のみ）・趣味を登録できます（すべて任意）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/profile-01-page.png" caption="マイプロフィール画面（アイコンの登録・生年月日・趣味の設定）" />
                  </div>
                </li>
                <li>アイコンは「画像を選択」→表示範囲を調整して「適用する」→最後に「保存する」の順に進めます。</li>
                <li>趣味は200文字までの自由記述です。他の利用者にも見えます。</li>
              </ol>
              <ul className="list-disc space-y-1 pl-5">
                <li>アイコンは座席タイルに氏名とあわせて表示されます。誕生日（月日）が一致する日は座席タイルに🎂が付きます。</li>
                <li>氏名が表示されている座席をクリックすると、相手のプロフィールを見られます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/profile-02-view.png" caption="氏名が表示されている座席をクリックすると開くプロフィール" />
                  </div>
                </li>
              </ul>
            </Section>

            <Section title="座席の予約・取消（フロアマップ表示）">
              <ol className="list-decimal space-y-3 pl-5">
                <li>サイドバーの「空き状況・予約」がトップ画面です。日付とエリアを選びます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-01-floormap.png" caption="空き状況・予約画面。白い枠の座席が空き、色付きの座席は使用中・固定座席など" />
                  </div>
                </li>
                <li>空いている座席をクリックし、確認ダイアログで「予約する」を押します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-02-modal.png" caption="座席をクリックすると開く予約確認ダイアログ" />
                  </div>
                </li>
                <li>予約が完了すると座席が自分用の表示に変わります。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-03-done.png" caption="予約完了後、座席が自分の予約として表示される" />
                  </div>
                </li>
                <li>複数日まとめて確保する場合は、確認ダイアログの「繰り返し予約にする」で曜日パターンと終了日を指定します。</li>
                <li>予約内容はフロアマップ下の「自分の予約」一覧から「変更」「取消」できます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-04-mylist.png" caption="座席状況の凡例と「自分の予約」一覧" />
                  </div>
                </li>
              </ol>
              <Note>
                使用中の座席・固定座席・自分の予約・確定済みのプロジェクト座席は姓で表示されます。同姓の利用者が同じフロア・同じ日にいる場合のみ「姓（名の頭文字）」で区別されます。
              </Note>
              <Note>
                既に別の座席を予約済みでも、別の空き座席をクリックできます。既定では自動的に変更扱いになりますが、「複数座席 予約」を選べば両方保有できます（複数保有中はフロアマップ上で赤く表示されます）。
              </Note>
            </Section>

            <Section title="空き状況を一覧で確認する（期間ビュー）">
              <ol className="list-decimal space-y-3 pl-5">
                <li>「期間ビュー」タブに切り替えます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/periodview-01-grid.png" caption="期間ビュー（日付×座席のグリッド）" />
                  </div>
                </li>
                <li>期間を指定すると、日付×座席のグリッドで空き状況をまとめて確認できます。</li>
                <li>グリッド内の「空き」ボタンからそのまま予約できます。</li>
              </ol>
            </Section>

            <Section title="自分の予約の確認・変更・取消">
              <p>「自分の予約」一覧の「今後の予約」「過去の予約」タブから、各行の「変更」「取消」で操作します。</p>
            </Section>
          </>
        )}

        {tab === 'pmpl' && (
          <>
            <Note>
              以下はPJ席決担当と、その権限を任されたメンバーの操作です。サイドバーの「プロジェクト座席」から開きます。「新しいプロジェクトを作成」からは誰でも新規作成できます。
            </Note>

            <Section title="出社曜日アンケートへの回答">
              <ol className="list-decimal space-y-3 pl-5">
                <li>第一希望・第二希望それぞれ曜日を2つまで選んで回答します。前サイクルがあれば「前回の回答をコピーする」も使えます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/pmsurvey-01-form.png" caption="出社曜日アンケートの回答フォーム（第一希望・第二希望）" />
                  </div>
                </li>
                <li>備考・必要座席数の変更希望も同じ画面で入力できます。</li>
                <li>曜日確定までは「回答を修正する」で何度でも書き直せます。</li>
              </ol>
            </Section>

            <Note>
              「メンバー管理」「メンバーへの座席確保」はボタンごとに表が開閉します。両方同時に開いておけます。
            </Note>

            <Section title="メンバー管理（席決め権限）">
              <p>PJ席決担当のみ操作できます。一覧の「席決めを任せる」で、そのメンバーにも座席確保を任せられます。</p>
              <div className="mt-2 max-w-md">
                <Screenshot src="/help/members-01-permission.png" caption="「メンバー管理」ボタンを押すと開く、席決め権限の一覧" />
              </div>
            </Section>

            <Section title="メンバーへの座席確保">
              <p>四半期が「座席割当済み」になると、「メンバーへの座席確保」から操作できます。</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>座席は必ずフロアマップから割り当てます。「座席表から選ぶ」でフロアマップへ移動し、座席の島の中の空き座席をクリックして相手を選びます。曜日ごとに座席が異なるプロジェクトは、曜日タブを切り替えて曜日ごとに選びます。「この内容で確保する」で確定します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/assign-01-table.png" caption="メンバーへの座席確保（座席の確保状況・変更先・不要）" />
                  </div>
                </li>
                <li>複数プロジェクト分をまとめて確保したいときは「座席表からまとめて確保する」を使います（未確保メンバーがいるプロジェクトがあるときのみ表示）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/assign-02-bulk.png" caption="座席表からまとめて確保する（複数プロジェクトの未確保メンバーを1画面でまとめて確保）" />
                  </div>
                </li>
                <li>確保済みのメンバーも「変更先を選択」から別の座席や「在宅勤務」に変更できます。他の人の座席を選ぶと入れ替わります。</li>
              </ol>
            </Section>

            <Section title="複数人の代理予約（フリー座席）">
              <p>座席の島を経由せず、フリー座席を複数メンバーへその場で代理予約する機能です。「複数人の代理予約（PJメンバー）」から操作します。</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>対象プロジェクト・対象メンバーを選び、「フロアマップで座席を選ぶ」に進みます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/proxybulk-01-members.png" caption="複数人の代理予約：対象プロジェクト・対象メンバーの選択" />
                  </div>
                </li>
                <li>空いている座席をクリックし、割り当てる相手を選びます。「繰り返し予約にする」で曜日パターンもまとめて指定できます。</li>
                <li>他のメンバーにも続けて割り当ててから、「この内容で確保する」でまとめて確定します。</li>
              </ol>
              <Note>座席の島の割当が済んでいる場合は前項の「メンバーへの座席確保」を使ってください。</Note>
            </Section>

            <Section title="座席が不要なメンバーの設定">
              <p>ずっと在宅勤務のメンバーは、一覧の「不要」にチェックを入れます。</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>必要座席数の算出から除外されます。</li>
                <li>確保済みの行は先に取消してからチェックしてください。</li>
                <li>全員が不要になると、アンケート・座席の島の割当自体が不要になります。</li>
              </ul>
            </Section>

            <Section title="固定座席保有者・前回サイクルの参照">
              <p>固定座席保有者は名前の横に「固定座席あり」と表示されますが、プロジェクト座席も別途確保できます。</p>
              <div>
                <p>「前回分を見る」で前サイクルの確定曜日・座席割当を参照できます。</p>
                <div className="mt-2 max-w-md">
                  <Screenshot src="/help/previouscycle-01-panel.png" caption="前回サイクルの確定曜日・座席割当（参照専用）" />
                </div>
              </div>
            </Section>
          </>
        )}

        {tab === 'admin' && (
          <>
            <Section title="プロジェクト座席の運用">
              <p>管理メニューの「プロジェクト座席（エリア担当）」から開きます。管理部はエリア責任者指定の有無にかかわらず操作できます。</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>計画データとアンケートは自動的に用意されます。「座席期間を新規設定する」から期間の新規設定・追加をまとめて行えます。個別に直す場合は一覧の「期間を修正」を使います。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-02-matrix.png" caption="期間タブ・絞り込み（曜日・状態・エリア・プロジェクト名）・曜日調整表" />
                  </div>
                </li>
                <li>「曜日で絞り込み」「状態」「エリア」「プロジェクト名」は3つの一覧すべてに効く絞り込みです。「備考の内容を表示」でPM/PLの備考を全文表示できます（既定はバッジ表示）。</li>
                <li>「曜日調整表」で出社曜日を確定します。「仮の座席割り当てを作成する」でいったん仮の状態にしてから、内容を確認して「この内容で本当に曜日を確定する」で正式に確定・通知します。</li>
                <li>確定・割当済みのプロジェクトは「確定した出社曜日」表で確認・編集できます。「プロジェクトの確定を取り消す」で曜日確定前に戻せます。</li>
                <li>各プロジェクトの状態・担当者・必要座席数は「座席割り当て」一覧で確認できます。「リマインドを送る」で未回答者へ催促できます。曜日ごとに座席が異なるプロジェクトには🔀が付きます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-01-list.png" caption="座席割り当て一覧（🔀は曜日によって座席の島が異なるプロジェクトの目印）" />
                  </div>
                </li>
                <li>座席の島の割当は一覧の「座席の島を割り当てる」からフロアマップで行います。「曜日で絞り込み」で1曜日だけ選んでいる間は、その曜日だけ例外的に別の座席へ変更できます。必要数を選んで「この内容で割り当てる」で確定します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-03-floormap.png" caption="座席の島の編集（曜日で座席状況を切り替え・選択中の座席数）" />
                  </div>
                </li>
                <li>複数プロジェクトをまとめて割り当てる場合は「座席の島の割当をまとめて行う」を使います。</li>
              </ol>
            </Section>

            <Section title="固定座席の指定">
              <ol className="list-decimal space-y-3 pl-5">
                <li>「固定座席の指定」で対象者を検索し、「この人に固定座席を指定する」からフロアマップへ移動します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/fixedseat-01-picking.png" caption="固定座席の指定：対象者を選ぶとフロアマップで枠付きの座席をクリックできる" />
                  </div>
                </li>
                <li>枠付きの座席をクリックし、無期限か期限を指定して「指定する」で完了です。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/fixedseat-02-modal.png" caption="固定座席の指定確認（無期限／期限の選択）" />
                  </div>
                </li>
              </ol>
              <Note>固定座席保有者もフリー座席・プロジェクト座席を別途予約できます。複数保有中はフロアマップ上で赤く表示されます。</Note>
            </Section>

            <Section title="代理予約・取消">
              <p>固定座席・プロジェクトメンバーのいずれにも該当しない利用者への一時的な代理予約・取消はここから行います。</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>対象者を検索し、「この人を代理予約する」からフロアマップで座席をクリックします。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/proxy-01-candidates.png" caption="代理予約・取消：対象者の検索と、座席×日付の一覧からの取消・変更" />
                  </div>
                </li>
                <li>座席×日付の一覧のセルをクリックすると取消・変更ダイアログが開きます。</li>
                <li>「氏名・期間でまとめて取り消す」で複数日をまとめて取り消せます。</li>
              </ol>
            </Section>

            <Section title="座席マスタ管理">
              <ul className="list-disc space-y-2 pl-5">
                <li>「＋座席を追加」（1件ずつ）・「＋まとめて追加」（連番）で登録します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatmaster-01-list.png" caption="座席マスタ管理：座席の一覧" />
                  </div>
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatmaster-02-addform.png" caption="座席の追加フォーム（座席番号・所属エリア・座席タイプ）" />
                  </div>
                </li>
                <li>「廃止」は状態の切替、「削除」は完全消去です（履歴が残る座席は削除不可）。</li>
                <li>「座席表の配置を編集する」で座席配置モードに入り、フロアマップ上をクリックして新しい座席を配置・ドラッグで位置変更できます。</li>
              </ul>
            </Section>

            <Section title="権限・PJ管理">
              <ul className="list-disc space-y-2 pl-5">
                <li><strong>利用者ロール管理:</strong> 役割・氏名・雇用形態・在籍状況、エリア責任者の指定など。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/roles-01-users.png" caption="利用者ロール管理タブ" />
                  </div>
                </li>
                <li><strong>プロジェクト・PM管理:</strong> プロジェクトの追加・編集・削除、PM／PL／SL・PJ席決担当の設定（実権限はPJ席決担当のみ）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/roles-02-projects.png" caption="プロジェクト・PM管理タブ（PJ席決担当と作成者は別の項目）" />
                  </div>
                </li>
                <li><strong>通知設定:</strong> Slack通知先の設定、通知の種類ごとのオン・オフ。</li>
              </ul>
            </Section>

          </>
        )}

        {tab === 'feedback' && <FeedbackForm />}
      </div>
    </div>
  )
}
