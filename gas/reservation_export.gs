/**
 * 座席予約システム（Zaseki）障害時バックアップ用の自動反映スクリプト。詳細設計書3.14節参照。
 * Zaseki側のAPI（GET /api/export/reservations）を定期的に呼び出し、エリア（NORTH／EAST／WEST、
 * S-02のフロアマップ表示と同じ区分）ごとに分けたタブへ結果を書き込む（毎回クリアしてから
 * 書き直す、DB→スプレッドシートの一方向・読み取り専用の反映）。タブは2種類×3エリア＝計6枚できる。
 *   「Zaseki_NORTH」等: 縦軸に座席番号、横軸に日付を並べたマス目形式（旧・本社座席予約表の
 *     運用に近い形）。本日から月末（または来月末）まで複数日分を一度に見られる。
 *   「Zaseki_フロアマップ_NORTH」等: 本日1日分のみを、実際のフロアマップ（S-02画面）に近い
 *     座席の配置で並べたもの（会議室・ロッカー・柱などの装飾、色分けは含まない、座席番号と
 *     利用者名の配置のみ）。
 * どちらのタブも、セルにはその日の利用者名のみが入る（プロジェクト座席であってもプロジェクト名は
 * 併記しない、空欄はその日空いていることを表す）。
 *
 * このスクリプトはスプレッドシートの所有者自身のGoogleアカウント権限で動作するため、
 * Zaseki側にサービスアカウント等を別途共有する必要が一切ない（会社のGoogle Workspace規定で
 * 外部アカウントへの編集者共有ができないことが判明したため、サービスアカウントでZaseki側から
 * 直接書き込む「push」方式から、この「pull」方式に変更した）。
 *
 * セットアップ手順:
 * 1. 反映先にしたいスプレッドシートを開き、メニュー「拡張機能」→「Apps Script」を開く
 * 2. 既定で開かれるコードエディタの中身をすべて削除し、このファイルの内容を貼り付けて保存
 * 3. 左側の歯車アイコン「プロジェクトの設定」→「スクリプト プロパティ」で以下の2つを追加する
 *      API_URL   … 例: https://zaseki-kogasoftware.fly.dev/api/export/reservations
 *      API_TOKEN … Zaseki側の環境変数 EXPORT_API_TOKEN と同じ値（Zaseki担当者から受け取る）
 * 4. 関数選択を「exportReservations」にして一度手動実行し（上部の実行ボタン）、
 *    初回の権限承認ダイアログで「許可」する（このスプレッドシート自体への書き込み権限のみで、
 *    外部アカウントとのやり取りは発生しない）
 * 5. 左側の時計アイコン「トリガー」→右下「トリガーを追加」で以下を設定する
 *      実行する関数: exportReservations
 *      イベントのソース: 時間主導型
 *      時間ベースのトリガーのタイプ: 日付ベースのタイマー
 *      時刻: 午前3時〜4時（Zaseki側も毎日03:00 JSTに合わせて更新しているため、その後の時間帯を推奨）
 */
function exportReservations() {
  const props = PropertiesService.getScriptProperties();
  const apiUrl = props.getProperty('API_URL');
  const apiToken = props.getProperty('API_TOKEN');
  if (!apiUrl || !apiToken) {
    throw new Error('スクリプトプロパティに API_URL・API_TOKEN を設定してください（ファイル先頭のコメント参照）');
  }

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'get',
    headers: { 'X-Export-Token': apiToken },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Zaseki APIの呼び出しに失敗しました: ' + response.getResponseCode() + ' ' + response.getContentText());
  }
  const data = JSON.parse(response.getContentText());
  const rows = data.rows;
  const floorSheets = data.floor_sheets || {};
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (rows.length > 0) {
    // APIが返す行は [エリア, 座席番号, 日付1, 日付2, ...] 形式（1行目が見出し）。
    // エリア列（列0）で振り分け、書き込み先のタブごとにはエリア列自体は不要になるため落とす。
    const header = rows[0].slice(1);
    const dataRows = rows.slice(1);
    ['NORTH', 'EAST', 'WEST'].forEach((area) => {
      const areaRows = dataRows.filter((row) => row[0] === area).map((row) => row.slice(1));
      // 複数日分のマス目表は横に長いため、1行目（日付見出し）・左1列（座席番号）を固定する
      writeAreaSheet(spreadsheet, 'Zaseki_' + area, [header].concat(areaRows), true);
    });
  }

  Object.keys(floorSheets).forEach((area) => {
    // フロアマップ風の表は1行目が全体の見出しではない（ブロックの見出しが飛び飛びに入る）ため、
    // 固定表示はしない
    writeAreaSheet(spreadsheet, 'Zaseki_フロアマップ_' + area, floorSheets[area], false);
  });
}

/** 1枚分の表（rows）を、指定した名前のタブへ書き込む。freezeHeaderがtrueの場合のみ、
 * 1行目・左1列を固定表示する */
function writeAreaSheet(spreadsheet, sheetName, rows, freezeHeader) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  sheet.clearContents();
  if (rows.length === 0) {
    return;
  }

  // 念のため、万一行によって列数がずれていてもsetValues()が要求する長方形の配列に
  // なるよう、最大列数に合わせて空文字で埋めてから書き込む
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const padded = rows.map((row) => {
    const copy = row.slice();
    while (copy.length < maxCols) copy.push('');
    return copy;
  });
  sheet.getRange(1, 1, padded.length, maxCols).setValues(padded);
  if (freezeHeader) {
    // 1行目（日付の見出し）と左1列（座席番号）を固定し、横に長い表でも見出しが見える状態を保つ
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
  } else {
    sheet.setFrozenRows(0);
    sheet.setFrozenColumns(0);
  }
}
