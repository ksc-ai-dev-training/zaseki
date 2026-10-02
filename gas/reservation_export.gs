/**
 * 座席予約システム（Zaseki）障害時バックアップ用の自動反映スクリプト。詳細設計書3.14節参照。
 * Zaseki側のAPI（GET /api/export/reservations）を定期的に呼び出し、エリア（NORTH／EAST／WEST、
 * S-02のフロアマップ表示と同じ区分）ごとに分けたタブへ結果を書き込む（毎回クリアしてから
 * 書き直す、DB→スプレッドシートの一方向・読み取り専用の反映）。縦軸に座席番号、横軸に日付を
 * 並べたマス目形式（旧・本社座席予約表の運用に近い形）で、セルにその日の利用者名のみが入る
 * （プロジェクト座席であってもプロジェクト名は併記しない、空欄はその日空いていることを表す）。
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
  const rows = JSON.parse(response.getContentText()).rows;
  if (rows.length === 0) {
    return;
  }

  // APIが返す行は [エリア, 座席番号, 日付1, 日付2, ...] 形式（1行目が見出し）。
  // エリア列（列0）で振り分け、書き込み先のタブごとにはエリア列自体は不要になるため落とす。
  const header = rows[0].slice(1);
  const dataRows = rows.slice(1);
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  ['NORTH', 'EAST', 'WEST'].forEach((area) => {
    const areaRows = dataRows.filter((row) => row[0] === area).map((row) => row.slice(1));
    writeAreaSheet(spreadsheet, area, [header].concat(areaRows));
  });
}

/** エリア1つ分の表（rows）を、"Zaseki_<エリア名>"という名前のタブへ書き込む */
function writeAreaSheet(spreadsheet, areaName, rows) {
  const sheetName = 'Zaseki_' + areaName;
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
  // 1行目（日付の見出し）と左1列（座席番号）を固定し、横に長い表でも見出しが見える状態を保つ
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
}
