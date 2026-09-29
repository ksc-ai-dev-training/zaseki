// SPA内のリンク遷移前に「保存されていない変更」の確認を行うための軽量な仕組み（2026-09-29新設）。
// 「座席配置の編集中、完了を押さなくても勝手に保存されてしまっている。保存していないままページ移動
// すると注意勧告が出て、気にせず移動すると編集データが吹き飛ぶ、というイメージがある」との要望を
// 受けて座席配置編集モード（S-07）を下書き方式に変更した際、あわせて導入した。
//
// react-routerのuseBlockerはデータルーター（createBrowserRouter等）専用で、このアプリは
// main.tsxで<BrowserRouter>（宣言的ルーティング）を使っているため使えない。ルーター自体を
// 差し替えるのは影響範囲が大きすぎるため、代わりにサイドバー（Sidebar.tsx）・スマホ版の
// 簡易上部バー（Layout.tsx）のリンク・ログアウトボタンのクリックハンドラから呼び出す、
// グローバルな単一のガード関数を用意した。
//
// ブラウザの戻る/進む・タブを閉じる・URLを直接入力する等（SPA外へ実際にページが遷移する操作）は
// このガードでは検知できないため、window.beforeunloadイベント（呼び出し側で個別に登録する）で
// 別途扱う。
let guard: (() => boolean) | null = null

/** 変更のあるコンポーネントが、離脱前に確認したい間だけ登録する。falseを返すと離脱を中止する */
export function setNavigationGuard(fn: (() => boolean) | null) {
  guard = fn
}

/** true: 遷移してよい（ガード未登録、またはユーザーが確認ダイアログで続行を選んだ） */
export function confirmNavigation(): boolean {
  return guard === null || guard()
}
