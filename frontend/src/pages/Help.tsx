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
    <div className="rounded border border-slate-200 bg-white p-5">
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
    <figure className="overflow-hidden rounded border border-slate-200">
      <img src={src} alt={caption} className="block w-full" />
      <figcaption className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
        {caption}
      </figcaption>
    </figure>
  )
}

// フィードバックの送信フォーム（A-59、FR-09-2）。分類＋自由記述のみのシンプルな構成。
// 送信されたフィードバックは管理部向け一覧画面（S-14、A-60）で確認する
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
      <p>操作方法のわかりにくさ、不具合、改善してほしい点など、気づいたことを送ってください。管理部が確認します。</p>
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
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
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
export default function Help() {
  const [tab, setTab] = useState<Tab>('common')

  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">ヘルプ（操作マニュアル）</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">S-13</span>
      </header>

      <div className="border-b border-slate-200 bg-white px-6">
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
                <li>ログイン画面で「Googleでログイン」ボタンを押します（会社の許可されたドメインのアカウントを使用）。</li>
                <li>初回ログイン時は、Googleアカウントの氏名から姓・名が自動的に登録されます。氏名に誤りがある場合は管理部に連絡してください（権限・役割管理から訂正できます）。</li>
              </ol>
            </Section>

            <Section title="マイプロフィールの設定">
              <p>サイドバーの「マイプロフィール」から、自分のアイコン画像・生年月日（月日のみ）を登録できます（任意項目）。</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>アイコンを設定すると、座席表の座席タイルに氏名とあわせて表示されます。未設定の間は氏名の頭文字のアバターが表示されます。</li>
                <li>生年月日（月日）が本日と一致する日は、自分が使用している座席タイルに誕生日バッジ（🎂）が表示されます。</li>
                <li>いずれもいつでも変更・削除できます。</li>
              </ul>
            </Section>

            <Section title="座席の予約・取消（フロアマップ表示）">
              <ol className="list-decimal space-y-3 pl-5">
                <li>サイドバーの「空き状況・予約」（トップ画面）を開きます。上部の日付選択（前日／翌日／今日ボタン、または直接入力）で予約したい日を、表示モードタブ（全体表示／NORTH／EAST／WEST）でエリアを選びます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-01-floormap.png" caption="空き状況・予約画面。白い枠の座席が空き、色付きの座席は使用中・固定座席など" />
                  </div>
                </li>
                <li>空いている（白い枠の）座席をクリックすると、予約確認ダイアログが開きます。日付を確認し「予約する」を押します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-02-modal.png" caption="座席をクリックすると開く予約確認ダイアログ" />
                  </div>
                </li>
                <li>予約が完了すると、その座席が自分の色（濃い青）に変わり「（自分）」と表示されます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-03-done.png" caption="予約完了後、座席が自分の予約として表示される" />
                  </div>
                </li>
                <li>複数日を確保したい場合は、予約確認ダイアログで「繰り返し予約にする」にチェックし、繰り返しパターンと適用終了日を指定します。</li>
                <li>予約した内容は、座席表の下にある「自分の予約」一覧（今後の予約／過去の予約）からいつでも確認できます。「変更」（該当日のフロアマップへ移動）・「取消」ボタンで操作します。自分の予約の座席を直接クリックしても取消確認ダイアログに切り替わります。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/reserve-04-mylist.png" caption="座席状況の凡例と「自分の予約」一覧" />
                  </div>
                </li>
              </ol>
              <Note>
                使用中・固定座席・自分の予約・プロジェクト座席（個人確定済み）は座席番号ではなく姓を表示します。同じフロア・同じ日に同じ姓の人が複数いるときだけ「姓（名の頭文字）」形式で自動的に区別されます（例: 岩崎（遼）・岩崎（弘））。
              </Note>
              <Note>
                既にその日の座席を予約している状態で別の空いている座席をクリックすると、既定では現在の予約が自動的に取り消されてその座席に変更されます（先に取り消す必要はありません）。ダイアログの「両方予約する（現在の予約はそのまま残す）」を押せば、現在の予約を残したままその座席も追加で予約できます。同じ日に複数の座席を保有する状態になると、画面上部に警告が表示され、フロアマップ上でも該当する座席が赤色で目立つように表示されます。
              </Note>
            </Section>

            <Section title="空き状況を一覧で確認する（期間ビュー）">
              <ol className="list-decimal space-y-1 pl-5">
                <li>フロアマップ表示の上にある「期間ビュー」タブに切り替えます。</li>
                <li>表示期間を指定すると、日付×座席のグリッド形式で空き状況をまとめて確認できます。</li>
                <li>各セルの「空き」ボタンから、その日・その座席を直接予約できます。</li>
              </ol>
            </Section>

            <Section title="自分の予約の確認・変更・取消">
              <p>座席表の下の「自分の予約」一覧から、「今後の予約」「過去の予約」タブで切り替え、各行の「変更」（該当日のフロアマップへスクロール）・「取消」ボタンで操作できます。</p>
            </Section>
          </>
        )}

        {tab === 'pmpl' && (
          <>
            <Note>
              プロジェクトの作成者、および「席決め」権限を付与されたメンバーが行う操作です（2026-09-09変更。従来はPM・PL本人に限られていましたが、プロジェクトを作成した人が行う方式になりました。作成者は既定でPMとして登録されます）。サイドバーの「プロジェクト座席」から開きます。複数プロジェクトを兼務している場合は、プロジェクトごとにセクションが分かれます。画面上部の「新しいプロジェクトを作成」から、誰でも新しいプロジェクトを作成できます。
            </Note>

            <Section title="出社曜日アンケートへの回答">
              <ol className="list-decimal space-y-1 pl-5">
                <li>「出社曜日アンケートの回答」があれば、第一希望・第二希望（それぞれ曜日を2つ）を選んで回答します（同じ曜日を両方に含めても構いません）。</li>
                <li>備考（管理部・エリア責任者への伝達事項）と、必要座席数の変更希望（任意）もあわせて入力できます。変更希望は自動的に必要座席数へ反映されます。</li>
                <li>回答後は折りたたみ表示になります。「表示する」「非表示にする」「回答を修正する」で切り替えられます（曜日確定までは何度でも修正可）。</li>
              </ol>
            </Section>

            <Section title="メンバー管理（席決め権限）">
              <p>プロジェクトの作成者のみが操作できます（2026-09-09変更、従来はPM・PL本人）。メンバー一覧の「席決めを任せる」チェックを入れると、そのメンバーにも下記の座席確保操作を任せられます（管理部の承認は不要）。</p>
            </Section>

            <Section title="メンバーへの座席確保">
              <p>座席の島の割当が完了した四半期に限り、プロジェクトの作成者または席決め権限を持つメンバーが操作できます（2026-09-09変更、従来はPJ席決担当）。</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>「割り当てる座席」列のプルダウンから座席を選び、「この内容で一括確保する」でまとめて確保します。</li>
                <li>座席表を見ながら選びたい場合は「座席表から選ぶ」からフロアマップへ移動し、座席をクリックして割り当てる相手を選びます。複数名を選んでから「この内容で確保する」で確定します。</li>
                <li>同じ座席を複数人に指定した場合、その組み合わせだけが確保対象から除外されます。</li>
              </ol>
            </Section>

            <Section title="複数人の代理予約（フリー座席）">
              <p>座席の島の割当を経由せず、通常のフリー座席を複数のメンバーへその場で代理予約したい場合に使います。空き状況・予約（S-02）のフロアマップ表示上部にある「複数人の代理予約（PJメンバー）」ボタンから操作します（プロジェクトの作成者、または「席決めを任せる」を有効にされたメンバーに表示されます。2026-09-09変更、従来はPJ席決担当）。</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>ボタンを押し、対象プロジェクトと対象メンバー（複数選択可）を選んで「フロアマップで座席を選ぶ」を押します。</li>
                <li>空いているフリー座席をクリックし、割り当てる相手・曜日パターン（毎週の曜日、または毎日）・終了日を選んで「この内容で追加する」を押します。1回の操作でその人の期間全体（複数日分）がまとめて確保されます。</li>
                <li>他のメンバーにも続けて座席を割り当てたい場合は、別の座席をクリックして同じ手順を繰り返します。</li>
                <li>選択済みの一覧が画面下部に表示されるので、内容を確認して「この内容で確保する」を押すと、まとめて予約が確定します。</li>
              </ol>
              <Note>人によって日付ごとに違う座席を割り当てたい場合は、案内文の「日付ごとに違う座席を選びたい場合はこちら」から、1クリック＝1人・1日・1座席の個別選択モードに切り替えられます（曜日パターンで一括登録するより手間がかかるため、必要な場合のみお使いください）。</Note>
              <Note>座席の島の割当が完了しているプロジェクトのメンバーへ座席を確保する場合は、上記の「メンバーへの座席確保」を使ってください（このボタンはそれとは別の、島の範囲に縛られない代理予約です）。</Note>
            </Section>

            <Section title="在宅のため座席が不要なメンバーの設定">
              <p>ずっと在宅勤務でプロジェクト座席が不要なメンバーは、一覧の「在宅のため不要」チェックを入れます。</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>確保対象・未確保者数、および必要座席数の算出から除外されます。</li>
                <li>既に座席を確保済みの行はチェックボックスが非活性になります。先に予約を取り消してから設定してください。</li>
                <li>メンバー全員が在宅のため不要になったプロジェクトは、管理部・エリア責任者側で「座席不要」と表示され、アンケート送信〜座席の島の割当自体が不要になります。</li>
              </ul>
            </Section>

            <Section title="固定座席保有者・前回サイクルの参照">
              <p>固定座席を既に持つメンバーには名前の横に「固定座席あり」と表示されますが、他のメンバーと同じように座席を確保することもできます（固定座席との併用可）。「前回分を見る」から直近1サイクル（3か月）前の座席割当を参照専用で確認できます。</p>
            </Section>
          </>
        )}

        {tab === 'admin' && (
          <>
            <Section title="プロジェクト座席の運用">
              <p>サイドバーの「プロジェクト座席（エリア担当）」、または管理メニューから開きます。管理部（role='admin'）であればエリア責任者への指定を問わず操作できます。</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>四半期計画データはシステムが自動的に作成するため、開始操作は不要です。</li>
                <li>必要座席数は、固定座席保有者・在宅のため不要なメンバーを除いた人数から自動算出されます。例外的に上書きしたい場合のみ「人数を修正」を使います。</li>
                <li>「アンケートを送る」で出社曜日アンケートの回答を依頼します（送信すると共通Slackチャンネルへ通知）。未回答が残っていれば任意のタイミングでリマインドを送れます。</li>
                <li>出社曜日の確定は「曜日×プロジェクト」のマトリクス表で行います。希望外の曜日をチェックすると「例外」バッジが付きます。確定すると通知が送られます。</li>
                <li>確定後・割当後のプロジェクトは、直後の「確定した出社曜日」表（参照専用）で確認できます。</li>
                <li>座席の島の割当は「座席の島を割り当てる」からフロアマップへ移動して行います（初期表示日は対象四半期の開始日）。ブロックのラベルの「この島を割り当てる」でまとめて選ぶこともできます。</li>
                <li>割当済みの座席の島は「座席を編集」から選び直せます。</li>
              </ol>
            </Section>

            <Section title="固定座席の指定">
              <p>管理メニューから開き、対象者を選んでフロアマップで座席を選びます。「無期限にする」（既定）か期限を指定でき、期限を過ぎると自動的に空き席になります。</p>
              <Note>固定座席を持つ利用者も、フリー座席・プロジェクト座席を同時に予約できます。同じ日に複数の座席を保有する状態になった場合、本人には予約時に画面上で警告が表示され、フロアマップ（空き状況・予約）上でも該当する座席が赤色で目立つように表示されます。</Note>
            </Section>

            <Section title="代理予約・取消">
              <p>固定座席・プロジェクトメンバーのいずれにも該当しない利用者への一時的な代理予約はここから行います。既存の予約・割当（フリー座席・固定座席・プロジェクト座席）を代理で取消／解除することもできます。</p>
            </Section>

            <Section title="座席マスタ管理">
              <ul className="list-disc space-y-1 pl-5">
                <li>座席の追加・編集（座席番号、所属エリア、座席タイプ）を行います。</li>
                <li>「廃止」は状態を切り替えるだけ、「削除」は完全に消す操作です（予約履歴・固定座席の割当が残る座席は削除不可）。</li>
                <li>「座席表に配置する」から座席配置モードでフロアマップ上に新しい座席を配置できます。</li>
              </ul>
            </Section>

            <Section title="権限・役割管理">
              <ul className="list-disc space-y-1 pl-5">
                <li><strong>利用者ロール管理:</strong> 役割・氏名・雇用形態・在籍状況の設定、エリア責任者・副責任者の指定など。</li>
                <li><strong>プロジェクト・PM管理:</strong> プロジェクトの追加・編集・削除、PM／PL／SL・PJ席決担当・作成者の設定（2026-09-09、作成者欄を追加。アンケート回答・メンバーへの座席確保を実際に行えるのは作成者のみで、PJ席決担当は表示用の項目）。</li>
                <li><strong>通知設定:</strong> 出社曜日アンケート関連のSlack通知先（Webhook URL）を設定。</li>
              </ul>
            </Section>

          </>
        )}

        {tab === 'feedback' && <FeedbackForm />}
      </div>
    </div>
  )
}
