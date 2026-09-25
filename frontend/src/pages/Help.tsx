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
                <li>ログイン画面で「Googleでログイン」ボタンを押します（会社の許可されたドメインのアカウントを使用）。</li>
                <li>初回ログイン時は、Googleアカウントの氏名から姓・名が自動的に登録されます。氏名に誤りがある場合は管理部に連絡してください（権限・PJ管理から訂正できます）。</li>
              </ol>
            </Section>

            <Section title="マイプロフィールの設定">
              <ol className="list-decimal space-y-3 pl-5">
                <li>サイドバーの「マイプロフィール」を開きます。自分のアイコン画像・生年月日（月日のみ）・趣味を登録できます（いずれも任意項目）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/profile-01-page.png" caption="マイプロフィール画面（アイコンの登録・生年月日・趣味の設定）" />
                  </div>
                </li>
                <li>「画像を選択」から画像ファイルを選ぶと、位置・拡大率を調整するダイアログが開きます。円形の枠内に表示したい範囲を合わせて「適用する」を押し、最後に画面下の「保存する」を押してください（適用しただけでは保存されません）。</li>
                <li>生年月日は年を持たず、月・日をプルダウンで選ぶだけで登録できます。「未設定に戻す」「画像を削除する」からいつでも変更・削除できます。</li>
                <li>趣味は200文字以内の自由記述です（2026-09-25追加）。座席表から他の利用者が自分のプロフィールを見たときに表示されます。</li>
              </ol>
              <ul className="list-disc space-y-1 pl-5">
                <li>アイコンを設定すると、座席表の座席タイルに氏名とあわせて表示されます。未設定の間は氏名の頭文字のアバターが表示されます。</li>
                <li>生年月日（月日）が本日と一致する日は、自分が使用している座席タイルに誕生日バッジ（🎂）が表示されます。</li>
                <li>座席表で他の利用者の氏名が表示されている座席（使用中・固定座席・プロジェクト座席で個人が確定している座席）をクリックすると、その利用者のプロフィール（氏名・所属〔参加しているプロジェクト名の一覧〕・生年月日・趣味）を見ることができます（2026-09-25追加）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/profile-02-view.png" caption="氏名が表示されている座席をクリックすると開くプロフィール" />
                  </div>
                </li>
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
                既にその日の座席を予約している状態で別の空いている座席をクリックすると、既定では現在の予約が自動的に取り消されてその座席に変更されます（先に取り消す必要はありません）。ダイアログの「複数座席 予約」を押せば、現在の予約を残したままその座席も追加で予約できます。同じ日に複数の座席を保有する状態になると、画面上部に警告が表示され、フロアマップ上でも該当する座席が赤色で目立つように表示されます。
              </Note>
            </Section>

            <Section title="空き状況を一覧で確認する（期間ビュー）">
              <ol className="list-decimal space-y-3 pl-5">
                <li>フロアマップ表示の上にある「期間ビュー」タブに切り替えます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/periodview-01-grid.png" caption="期間ビュー（日付×座席のグリッド）" />
                  </div>
                </li>
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
              プロジェクトのPJ席決担当、および「席決め」権限を付与されたメンバーが行う操作です（プロジェクトを作成した人が既定でPJ席決担当・PMとして登録されます）。サイドバーの「プロジェクト座席」から開きます。複数プロジェクトを兼務している場合は、プロジェクトごとにセクションが分かれます。画面上部の「新しいプロジェクトを作成」から、誰でも新しいプロジェクトを作成できます。
            </Note>

            <Section title="出社曜日アンケートへの回答">
              <ol className="list-decimal space-y-3 pl-5">
                <li>「プロジェクト座席」画面の対象プロジェクトに「出社曜日アンケートの回答」があれば、第一希望・第二希望（それぞれ曜日を2つ）にチェックを入れて回答します（同じ曜日を両方に含めても構いません）。前回サイクルの計画があるプロジェクトでは「前回の回答をコピーする」で前回の内容を読み込み、必要な部分だけ直して回答することもできます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/pmsurvey-01-form.png" caption="出社曜日アンケートの回答フォーム（第一希望・第二希望）" />
                  </div>
                </li>
                <li>備考（管理部・エリア責任者への伝達事項）と、必要座席数の変更希望（任意）もあわせて入力できます。変更希望は自動的に必要座席数へ反映されます。</li>
                <li>回答後は折りたたみ表示になります。「表示する」「非表示にする」「回答を修正する」で切り替えられます（曜日確定までは何度でも修正可）。</li>
              </ol>
            </Section>

            <Note>
              「メンバー管理」「メンバーへの座席確保」は、それぞれのボタンを押すと表の部分が開きます（もう一度押すと閉じます）。2つのボタンは独立していて、片方を開いてももう片方は閉じません。両方同時に開くこともできます（2026-09-25変更。以前は常に両方の表を並べて表示していましたが、縦に長くなりすぎるため開閉式に改めました）。
            </Note>

            <Section title="メンバー管理（席決め権限）">
              <p>プロジェクトのPJ席決担当のみが操作できます。「メンバー管理」ボタンを押すと開く一覧の「席決めを任せる」チェックを入れると、そのメンバーにも下記の座席確保操作を任せられます（管理部の承認は不要）。自分自身の行にはチェックが表示されません（PJ席決担当は常に操作できるため）。</p>
              <div className="mt-2 max-w-md">
                <Screenshot src="/help/members-01-permission.png" caption="「メンバー管理」ボタンを押すと開く、席決め権限の一覧" />
              </div>
            </Section>

            <Section title="メンバーへの座席確保">
              <p>座席の島の割当が完了した四半期（状態が「座席割当済み」）に限り、プロジェクトのPJ席決担当または席決め権限を持つメンバーが「メンバーへの座席確保」ボタンから操作できます。</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>座席の確保はすべて座席表（フロアマップ）から行います。未確保のメンバーの行には「座席表から確保してください」と表示されるので、表の下の「座席表から選ぶ」を押してフロアマップへ移動し、座席の島の範囲内・未確定の座席をクリックして割り当てる相手を選びます。曜日によって座席の島が異なるプロジェクトでは、画面上部の曜日タブを切り替えながら曜日ごとに別々の座席を選べます（同じメンバーでも曜日ごとに違う座席にできます）。複数名を選んでから「この内容で確保する」で確定します。固定座席あり・不要のメンバーも同じ表に表示され、確保状況を一目で確認できます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/assign-01-table.png" caption="メンバーへの座席確保（座席の確保状況・変更先・不要）" />
                  </div>
                </li>
                <li>複数のプロジェクトをまたいでまとめて座席を確保したい場合は、プロジェクト座席画面の上部に表示される「座席表からまとめて確保する」ボタンを使います（対象四半期に座席割当済み・未確保メンバーがいるプロジェクトが1件以上あるときに表示されます）。フロアマップの右側に曜日タブ・対象プロジェクト一覧・選択中プロジェクトの詳細（必要座席数・割り当てられた島・未確保のメンバー）が表示され、プロジェクトと曜日を切り替えながら複数プロジェクト分をまとめて選び、「この内容で確保する」で確定します（座席の島の一括割当と同じ考え方の画面です）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/assign-02-bulk.png" caption="座席表からまとめて確保する（複数プロジェクトの未確保メンバーを1画面でまとめて確保）" />
                  </div>
                </li>
                <li>同じ座席を複数人に指定した場合、その組み合わせだけが確保対象から除外されます。</li>
                <li>確保済みのメンバーも、行の「変更先を選択」から別の座席（座席の島の範囲内）や「在宅勤務」への変更ができます。既に別のメンバーが使っている座席を選ぶと、その相手と座席を交換します（曜日によって座席が異なるプロジェクトでは、全確定曜日に共通する座席のみ選べます）。</li>
              </ol>
            </Section>

            <Section title="複数人の代理予約（フリー座席）">
              <p>座席の島の割当を経由せず、通常のフリー座席を複数のメンバーへその場で代理予約したい場合に使います。空き状況・予約のフロアマップ表示上部にある「複数人の代理予約（PJメンバー）」ボタンから操作します（プロジェクトのPJ席決担当、または「席決めを任せる」を有効にされたメンバーに表示されます）。</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>ボタンを押し、対象プロジェクトと対象メンバー（複数選択可）を選んで「フロアマップで座席を選ぶ」を押します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/proxybulk-01-members.png" caption="複数人の代理予約：対象プロジェクト・対象メンバーの選択" />
                  </div>
                </li>
                <li>通常のフリー座席予約と同じように、上部の日付を選んでから空いている座席をクリックし、割り当てる相手を選びます。</li>
                <li>「この内容で追加する」を押すとその1日だけ確保されます。同じ人に複数の期間・曜日パターンでまとめて確保したい場合は、「繰り返し予約にする」にチェックを入れ、曜日パターン（毎週の曜日、または毎日）・終了日を指定してから追加します。</li>
                <li>他のメンバーにも続けて座席を割り当てたい場合は、別の座席をクリックして同じ手順を繰り返します（日付ごとに違う座席にしたい場合は、上部の日付を変えて単発の確保を繰り返してください）。</li>
                <li>選択済みの一覧が画面下部に表示されるので、内容を確認して「この内容で確保する」を押すと、まとめて予約が確定します。</li>
              </ol>
              <Note>座席の島の割当が完了しているプロジェクトのメンバーへ座席を確保する場合は、上記の「メンバーへの座席確保」を使ってください（このボタンはそれとは別の、島の範囲に縛られない代理予約です）。</Note>
            </Section>

            <Section title="在宅のため座席が不要なメンバーの設定">
              <p>ずっと在宅勤務でプロジェクト座席が不要なメンバーは、「メンバーへの座席確保」ボタンを押すと開く一覧にある「不要」チェックを入れます。</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>確保対象・未確保者数、および必要座席数の算出から除外されます。</li>
                <li>既に座席を確保済みの行はチェックボックスが非活性になります。先に予約を取り消してから設定してください。</li>
                <li>メンバー全員が不要になったプロジェクトは、管理部・エリア責任者側で「座席不要」と表示され、アンケート送信〜座席の島の割当自体が不要になります。</li>
              </ul>
            </Section>

            <Section title="固定座席保有者・前回サイクルの参照">
              <p>固定座席を既に持つメンバーには名前の横に「固定座席あり」と表示されますが、他のメンバーと同じように座席を確保することもできます（固定座席との併用可、「メンバーへの座席確保」の表で確認できます）。</p>
              <div>
                <p>「前回分を見る」から直近1サイクル（3か月）前の確定曜日・座席割当を参照専用で確認できます。メンバーごとに確保していた座席番号が一覧で表示されます。</p>
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
              <p>管理メニューの「プロジェクト座席（エリア担当）」から開きます。管理部（role='admin'）であればエリア責任者への指定を問わず操作できます。</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>四半期計画データと出社曜日アンケートはシステムが自動的に作成・受付開始されるため、開始操作は不要です。ページ冒頭の「期間」の「座席期間を新規設定する」から、まだ期間が設定されていないプロジェクトへの新規設定と、既存プロジェクトへの次サイクル分の期間追加をまとめて行えます。個別のプロジェクトの期間だけを後から直したい場合は、下の「座席割り当て」一覧にある行ごとの「期間を修正」を使います。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-02-matrix.png" caption="期間タブ・絞り込み（曜日・状態・エリア・プロジェクト名）・曜日調整表" />
                  </div>
                </li>
                <li>期間が複数あるときは期間タブで対象を切り替えられます。その下の「曜日で絞り込み」「状態」「エリア」「プロジェクト名」は、曜日調整表・確定した出社曜日・座席割り当ての3つの一覧すべてに共通して効く絞り込みです（「曜日で絞り込み」は絞り込みに加えて、後述する座席の島の例外編集の対象曜日の指定にも使います）。「備考の内容を表示」にチェックを入れると、PM/PLがアンケート回答時に入力した備考の全文を、プロジェクト名の隣に3つの一覧すべてでそのまま表示できます（既定はオフで、このときは「備考あり」というオレンジ色のバッジのみを表示し、カーソルを合わせると全文が読めます）。表示のみの切り替えで、備考の内容自体は変わりません。曜日調整表・確定した出社曜日の各行にある備考の入力欄（管理部・エリア責任者自身が入力する別のメモ）はこのチェックの対象外です。</li>
                <li>出社曜日の確定は「曜日調整表」（曜日×プロジェクトのマトリクス表）で行います。希望外の曜日をチェックすると「例外」バッジが付き、必要に応じて「AI提案を生成する」で仮の曜日案を作成することもできます。内容を確認して「仮の座席割り当てを作成する」を押すと、その時点のチェック状態のまま次項の座席の島の割当画面に進みます。この時点ではまだ対外的な確定・Slack通知は行われず、曜日のチェック状態も座席の島も自由にやり直せる「仮」の状態です。実際にその曜日・座席で問題ないことを確認できたら、仮の座席割り当て済みのプロジェクトが1件以上あるときに表示される「この内容で本当に曜日を確定する」を押して、初めて確定・通知されます。</li>
                <li>曜日調整表と確定した出社曜日の間には、座席割当済み・仮の座席割り当て中のプロジェクトについて、実際のフロアマップ上に座席の島をプロジェクト名付きで曜日ごとに並べたプレビューが常に表示されます（現在の絞り込み条件に連動します）。曜日確定の際に確認する画面と同じ表示で、割り当てた後もこの位置でいつでも見返せます。固定座席の利用者も紫色であわせて表示されるため、プロジェクト座席と固定座席を含めたフロア全体の状況を一度に確認できます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-04-weekday-preview.png" caption="曜日調整表と確定した出社曜日の間に常時表示される、曜日ごとのフロアマップ（紫は固定座席）" />
                  </div>
                </li>
                <li>確定後・割当後のプロジェクトは、続く「確定した出社曜日」表で確認できます。この表はチェックボックスで直接編集できる表でもあり（変更後は「この内容で変更する」で保存）、「プロジェクトの確定を取り消す」から曜日確定前に戻すこともできます。「割当済み」には実際に割り当てられた座席番号もあわせて表示されます。</li>
                <li>各プロジェクトの状態（アンケート回答受付中・仮の座席割り当て中・曜日確定済み・座席割当済み）や席決め担当、必要座席数などは「座席割り当て」の一覧でまとめて確認できます。未回答のプロジェクトが残っている場合は、一覧の「リマインドを送る」から任意のタイミングで催促を送れます（共通Slackチャンネルへ通知）。必要座席数は、固定座席保有者・不要なメンバーを除いた人数から自動算出されるので、例外的に上書きしたい場合のみ「人数を修正」を使います（ただし実際に座席の島を割り当てる際は、その時点の実際のメンバー構成が優先されます）。曜日によって座席の島が異なるプロジェクトはプロジェクト名の隣に🔀が表示され、カーソルを合わせると曜日ごとの内訳を確認できます。誤って確定・割当してしまった場合は同じ行の「取り消す」でその場で取り消せます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-01-list.png" caption="座席割り当て一覧（🔀は曜日によって座席の島が異なるプロジェクトの目印）" />
                  </div>
                </li>
                <li>座席の島の割当は、一覧の「座席の島を割り当てる」（仮の座席割り当て後・割当済み後は「座席を編集」）からフロアマップへ移動して行います（初期表示日は対象四半期の開始日）。「曜日で絞り込み」が「すべて」のときは全確定曜日に共通の座席の島を一括で割り当て・編集します。特定の曜日だけ別の座席にしたい場合は、先に「曜日で絞り込み」でその曜日を選んでから同じ操作を行うと、その1日だけ例外的に別の座席へ変更できます（他の曜日の割当はそのまま残ります）。フロアマップ側にも「曜日で座席状況を切り替え」ボタンがあり、他の確定曜日にこのプロジェクトが使っている座席を破線で確認しながら選べます。必要座席数分の座席をクリックして選び、「この内容で割り当てる（更新する）」で確定します。ブロックのラベルの「この島を割り当てる」でまとめて選ぶこともできます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatops-03-floormap.png" caption="座席の島の編集（曜日で座席状況を切り替え・選択中の座席数）" />
                  </div>
                </li>
                <li>複数プロジェクトをまとめて割り当てたい場合は、「座席割り当て」一覧の下に表示される「座席の島の割当をまとめて行う」（割当が必要なプロジェクトが1件以上あるときのみ表示）を使います。単一プロジェクトの画面と同じフロアマップ左・操作パネル右のレイアウトで、右側の対象プロジェクト一覧・曜日タブを切り替えながら複数プロジェクト分を続けて選べます（1プロジェクトずつ「〇曜日の分だけまとめて保存する」で保存でき、保存後も画面に留まれます）。前回サイクルの実績があるプロジェクトを選択中は、詳細欄のプロジェクト名の横に🕐アイコンが表示され、カーソルを合わせると前回の確定曜日・座席の島を確認できます。</li>
              </ol>
            </Section>

            <Section title="固定座席の指定">
              <ol className="list-decimal space-y-3 pl-5">
                <li>管理メニューの「固定座席の指定」を開き、対象者を氏名で検索します（既に固定座席を持つ利用者はここには出ません。座席を変更したい場合は下側の「固定座席利用者」一覧の「座席を変更する」を使います）。「この人に固定座席を指定する」を押すとフロアマップへ移動します。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/fixedseat-01-picking.png" caption="固定座席の指定：対象者を選ぶとフロアマップで枠付きの座席をクリックできる" />
                  </div>
                </li>
                <li>枠の付いた（当日空いている）座席をクリックすると確認ダイアログが開きます。開始日を確認し、「無期限にする」（既定）か期限を指定して「指定する」で確定します。期限を過ぎると自動的に空き席に戻ります。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/fixedseat-02-modal.png" caption="固定座席の指定確認（無期限／期限の選択）" />
                  </div>
                </li>
              </ol>
              <Note>固定座席を持つ利用者も、フリー座席・プロジェクト座席を同時に予約できます。同じ日に複数の座席を保有する状態になった場合、本人には予約時に画面上で警告が表示され、フロアマップ（空き状況・予約）上でも該当する座席が赤色で目立つように表示されます。</Note>
            </Section>

            <Section title="代理予約・取消">
              <p>固定座席・プロジェクトメンバーのいずれにも該当しない利用者への一時的な代理予約はここから行います。既存の予約・割当（フリー座席・固定座席・プロジェクト座席）を代理で取消／解除することもできます。</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>上段の「代理予約する対象者を選ぶ」で氏名を検索し、「この人を代理予約する」からフロアマップへ移動して空いている座席をクリックします。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/proxy-01-candidates.png" caption="代理予約・取消：対象者の検索と、座席×日付の一覧からの取消・変更" />
                  </div>
                </li>
                <li>下段の座席×日付の一覧では、氏名が表示されているセルをクリックすると取消・変更ダイアログが開きます。固定座席は「この日だけ取り消す」（1日だけの解除）と「割当を解除する（全期間）」を選べます。</li>
                <li>「氏名・期間でまとめて取り消す」を使うと、氏名・座席種別・期間を指定してフリー座席の予約をまとめて取り消せます。</li>
              </ol>
            </Section>

            <Section title="座席マスタ管理">
              <ul className="list-disc space-y-2 pl-5">
                <li>座席の追加・編集（座席番号、所属エリア、座席タイプ）を行います。「＋座席を追加」から1件ずつ、「＋まとめて追加」から連番でまとめて追加できます。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatmaster-01-list.png" caption="座席マスタ管理：座席の一覧" />
                  </div>
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/seatmaster-02-addform.png" caption="座席の追加フォーム（座席番号・所属エリア・座席タイプ）" />
                  </div>
                </li>
                <li>「廃止」は状態を切り替えるだけ、「削除」は完全に消す操作です（予約履歴・固定座席の割当が残る座席は削除不可）。</li>
                <li>「座席表の配置を編集する」から座席配置モードに入り、フロアマップの空いている位置をクリックして新しい座席を配置できます。既存の座席（まだ配置図に反映されていない「追加座席」一覧のものを含む）もドラッグして位置を変更できます。</li>
              </ul>
            </Section>

            <Section title="権限・PJ管理">
              <ul className="list-disc space-y-2 pl-5">
                <li><strong>利用者ロール管理:</strong> 役割・氏名・雇用形態・在籍状況の設定、エリア責任者・副責任者の指定など。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/roles-01-users.png" caption="利用者ロール管理タブ" />
                  </div>
                </li>
                <li><strong>プロジェクト・PM管理:</strong> プロジェクトの追加・編集・削除、PM／PL／SL・PJ席決担当・作成者の設定（アンケート回答・メンバーへの座席確保を実際に行えるのはPJ席決担当のみで、作成者は表示用の項目）。
                  <div className="mt-2 max-w-md">
                    <Screenshot src="/help/roles-02-projects.png" caption="プロジェクト・PM管理タブ（PJ席決担当と作成者は別の項目）" />
                  </div>
                </li>
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
