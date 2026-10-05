/**
 * 座席予約システム（Zaseki）障害時バックアップ用の自動反映スクリプト。詳細設計書3.14節参照。
 * Zaseki側のAPI（GET /api/export/reservations）を定期的に呼び出し、エリア（NORTH／EAST／WEST、
 * S-02のフロアマップ表示と同じ区分）ごとに分けたタブへ結果を書き込む（毎回クリアしてから
 * 書き直す、DB→スプレッドシートの一方向・読み取り専用の反映）。タブは2種類×3エリア＋設定用1枚
 * ＝計7枚できる。
 *   「Zaseki_NORTH」等: 縦軸に座席番号、横軸に日付を並べたマス目形式（旧・本社座席予約表の
 *     運用に近い形）。本日から月末（または来月末）まで複数日分を一度に見られる。日付選択の
 *     対象ではなく、常に本日から複数日分（固定）。
 *   「Zaseki_フロアマップ_NORTH」等: 指定した1日分のみを、実際のフロアマップ（S-02画面）に近い
 *     座席の配置で並べたもの（会議室・ロッカー・柱などの装飾は含まない、座席番号と利用者名の
 *     配置のみ）。ブロックごとに背景色を分け、使用中の座席はさらに濃い色で強調する。対象日は
 *     「Zaseki_設定」タブのB1セルで選べる（2026-10-05追加、下記参照）。
 * どちらの表も、セルにはその日の利用者名のみが入る（プロジェクト座席であってもプロジェクト名は
 * 併記しない、空欄はその日空いていることを表す）。
 *
 * 「Zaseki_設定」タブ: B1セルに日付を入力すると、その日付のフロアマップ風シートだけを
 * 再取得・再描画する（複数日分のマス目表（Zaseki_NORTH等）は対象外、翌日の自動反映で本日に戻る）。
 * 予約可能期間外の日付を入力した場合は本日にフォールバックし、B2セルにその旨を表示する。
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
 * 5. 左側の時計アイコン「トリガー」→右下「トリガーを追加」で以下を2つとも設定する
 *      (a) 複数日分のマス目表・フロアマップ風シートの毎日の自動更新用
 *          実行する関数: exportReservations / イベントのソース: 時間主導型
 *          時間ベースのトリガーのタイプ: 日付ベースのタイマー
 *          時刻: 午前3時〜4時（Zaseki側も毎日03:00 JSTに合わせて更新しているため、その後の時間帯を推奨）
 *      (b) 「Zaseki_設定」タブで日付を選んだときにフロアマップ風シートだけ再取得するための設定
 *          （2026-10-05追加。これが無いと日付を変えてもシートが更新されない）
 *          実行する関数: onEditHandler / イベントのソース: スプレッドシートから
 *          イベントの種類: 編集時
 */
function exportReservations() {
  const data = fetchExportData(null);
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  writeDateMatrixSheets(spreadsheet, data.rows);
  writeFloorSheets(spreadsheet, data.floor_sheets);
  ensureSettingsSheet(spreadsheet, data.floor_sheets_date);
}

/** Zaseki側のAPI（GET /api/export/reservations）を呼び出し、JSONをパースして返す。
 * dateStrを渡すとfloor_sheetsの対象日をその日付にする（nullなら省略＝本日）。 */
function fetchExportData(dateStr) {
  const props = PropertiesService.getScriptProperties();
  const apiUrl = props.getProperty('API_URL');
  const apiToken = props.getProperty('API_TOKEN');
  if (!apiUrl || !apiToken) {
    throw new Error('スクリプトプロパティに API_URL・API_TOKEN を設定してください（ファイル先頭のコメント参照）');
  }
  const url = dateStr ? apiUrl + '?date=' + encodeURIComponent(dateStr) : apiUrl;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-Export-Token': apiToken },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Zaseki APIの呼び出しに失敗しました: ' + response.getResponseCode() + ' ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

/** 複数日分の座席×日付マス目表（rows）を、エリアごとに「Zaseki_<エリア名>」タブへ書き込む */
function writeDateMatrixSheets(spreadsheet, rows) {
  if (!rows || rows.length === 0) {
    return;
  }
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

/** 1日分のフロアマップ風の表（floorSheets、build_floor_sheets()のエリア名→{rows,kinds}）を、
 * エリアごとに「Zaseki_フロアマップ_<エリア名>」タブへ書き込み、色分けも適用する */
function writeFloorSheets(spreadsheet, floorSheets) {
  Object.keys(floorSheets || {}).forEach((area) => {
    // フロアマップ風の表は1行目が全体の見出しではない（ブロックの見出しが飛び飛びに入る）ため、
    // 固定表示はしない
    const sheet = writeAreaSheet(spreadsheet, 'Zaseki_フロアマップ_' + area, floorSheets[area].rows, false);
    if (sheet) {
      applyFloorColors(sheet, floorSheets[area].kinds);
    }
  });
}

const SETTINGS_SHEET_NAME = 'Zaseki_設定';

/** 「Zaseki_設定」タブが無ければ作り、B1（対象日）・B2（状態表示）の見出し・値を整える。
 * actualDateIsoを渡すと、B1をその日付に（既存の値があっても）上書きし、
 * B2に「反映済み: ...」を表示する */
function ensureSettingsSheet(spreadsheet, actualDateIso) {
  let sheet = spreadsheet.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SETTINGS_SHEET_NAME);
    sheet.getRange('A1').setValue('表示する日付（右のセルに日付を入力）');
    sheet.getRange('A2').setValue('状態');
    const rule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build();
    sheet.getRange('B1').setDataValidation(rule);
  }
  if (actualDateIso) {
    // 毎日の自動更新では必ず本日の日付に戻す（表示中のセルの値と、実際にフロアマップ風シートに
    // 反映されている日付がずれたままにならないようにするため。この書き込み自体がonEditHandlerを
    // 再度呼ぶが、同じ日付への冪等な再取得になるだけなので実害はない）
    sheet.getRange('B1').setValue(isoStringToDate(actualDateIso));
    sheet.getRange('B2').setValue('反映済み: ' + actualDateIso);
  }
  return sheet;
}

/** 「Zaseki_設定」タブのB1セル（対象日）が編集されたら、フロアマップ風シートだけをその日付で
 * 再取得・再描画する（2026-10-05追加。インストール型トリガーとして設定する必要がある、
 * ファイル先頭のセットアップ手順5-(b)参照）。複数日分のマス目表（Zaseki_NORTH等）はここでは
 * 更新しない（翌日の自動反映を待つ）。 */
function onEditHandler(e) {
  const range = e.range;
  if (range.getSheet().getName() !== SETTINGS_SHEET_NAME || range.getA1Notation() !== 'B1') {
    return;
  }
  const value = range.getValue();
  if (!(value instanceof Date)) {
    return; // 日付以外が入力された・消去された場合は何もしない
  }
  const dateStr = Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  const spreadsheet = range.getSheet().getParent();
  const data = fetchExportData(dateStr);
  writeFloorSheets(spreadsheet, data.floor_sheets);
  const settingsSheet = spreadsheet.getSheetByName(SETTINGS_SHEET_NAME);
  if (data.floor_sheets_date === dateStr) {
    settingsSheet.getRange('B2').setValue('反映済み: ' + data.floor_sheets_date);
  } else {
    // 指定した日付が予約可能期間外などの理由で本日にフォールバックされた場合に気づけるようにする
    settingsSheet.getRange('B2').setValue('指定した日付は表示できないため本日分を表示: ' + data.floor_sheets_date);
  }
}

function isoStringToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 1枚分の表（rows）を、指定した名前のタブへ書き込み、そのシートを返す（colsが空なら何もせず
 * nullを返す）。freezeHeaderがtrueの場合のみ、1行目・左1列を固定表示する */
function writeAreaSheet(spreadsheet, sheetName, rows, freezeHeader) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  sheet.clear(); // 値だけでなく、前回までの背景色等の書式も含めて消してから書き直す
  if (rows.length === 0) {
    return null;
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
  return sheet;
}

// フロアマップ風シートの配色（ブロック番号で循環使用）。seat=座席番号セル、free=空席の氏名セル
// （ごく薄い色）、occupied=使用中の氏名セル（濃い色、2026-10-02追加。「色があるとわかりやすい」
// との要望を受け、「ブロックごとに色を分ける」「空き・使用中を一目で分ける」の両方に対応した）
const FLOOR_BLOCK_PALETTE = [
  { seat: '#DCEEFB', free: '#F3FAFF', occupied: '#64B5F6' }, // 青
  { seat: '#E3F6E5', free: '#F5FCF6', occupied: '#81C784' }, // 緑
  { seat: '#FCE4EC', free: '#FFF5F8', occupied: '#F06292' }, // ピンク
  { seat: '#F3E8FD', free: '#FBF6FF', occupied: '#BA68C8' }, // 紫
  { seat: '#FFF0DB', free: '#FFFAF2', occupied: '#FFB74D' }, // 橙
  { seat: '#E0F7F7', free: '#F2FDFD', occupied: '#4DD0E1' }, // 水色
  { seat: '#FFF9DB', free: '#FFFDF2', occupied: '#FFD54F' }, // 黄
  { seat: '#ECEFF1', free: '#F8F9FA', occupied: '#90A4AE' }, // 灰
];
const FLOOR_LABEL_BG = '#E5E7EB';
const FLOOR_BLANK_BG = '#FFFFFF';

/** kinds（_build_floor_sheet()が返す区分の表、rowsと同じ形）をもとに、sheetの対応する範囲へ
 * 背景色・太字を設定する */
function applyFloorColors(sheet, kinds) {
  if (!kinds || kinds.length === 0) {
    return;
  }
  const numRows = kinds.length;
  const numCols = kinds.reduce((max, row) => Math.max(max, row.length), 1);
  const backgrounds = [];
  const fontWeights = [];
  for (let r = 0; r < numRows; r++) {
    const bgRow = [];
    const fwRow = [];
    for (let c = 0; c < numCols; c++) {
      const kind = (kinds[r] || [])[c] || '';
      if (kind === '') {
        bgRow.push(FLOOR_BLANK_BG);
        fwRow.push('normal');
      } else if (kind === 'label') {
        bgRow.push(FLOOR_LABEL_BG);
        fwRow.push('bold');
      } else {
        const [role, idxStr] = kind.split(':');
        const palette = FLOOR_BLOCK_PALETTE[Number(idxStr) % FLOOR_BLOCK_PALETTE.length];
        bgRow.push(palette[role] || FLOOR_BLANK_BG);
        fwRow.push(role === 'seat' || role === 'occupied' ? 'bold' : 'normal');
      }
    }
    backgrounds.push(bgRow);
    fontWeights.push(fwRow);
  }
  const range = sheet.getRange(1, 1, numRows, numCols);
  range.setBackgrounds(backgrounds);
  range.setFontWeights(fontWeights);
}
