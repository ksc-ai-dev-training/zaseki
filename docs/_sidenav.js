/*
 * 本社座席予約システム（Zaseki）設計ドキュメント サイドナビ共通スクリプト
 *
 * 各HTMLは <body> 直下に <script src="_sidenav.js"></script> を1行追加するだけ。
 * （03_画面モックアップ/ 配下から読み込む場合は <script src="../_sidenav.js"></script>）
 *
 * このファイルが:
 *   - サイドナビのHTMLを各ページに注入
 *   - サイドナビ用CSSを <head> に注入
 *   - 現在開いているページを location.pathname から判定して自動ハイライト
 *   - 本文の左マージンをサイドナビ分だけ確保
 *   - 印刷時はサイドナビを非表示にして本文を中央寄せに戻す
 *
 * 新しいドキュメントを追加するとき:
 *   下の DOCS 配列に { href, title } を追加するだけ。
 *   ※画面モックアップ本体（S-0x）は画面自体が固定サイドバーを持つため、
 *     サイドナビは読み込まない（リンクのみ張る）。
 *   ※グループに newWindow: true を付けると、その中のリンクは別ウィンドウで開く。
 *
 * 2026-08-25: Keirekiのdocsフォルダを本フォルダにコピーした際、同名の_sidenav.js・
 * mock.css・S-01_login.htmlがKeireki版で上書きされる事故が発生した（mock.css・
 * S-01_login.htmlは復元済み）。本ファイルはzaseki専用の内容に作り直したもの。
 */
(function () {
  const DOCS = [
    {
      group: '要求',
      docs: [
        { href: '座席予約システム_要求仕様書.html', title: '要求仕様書' },
        { href: '座席予約システム_要件定義書.html', title: '要件定義書' },
      ],
    },
    {
      group: '画面モックアップ',
      newWindow: true, // モックアップは実画面に近い見え方を確認するため別ウィンドウで開く
      docs: [
        { href: '03_画面モックアップ/S-01_login.html', title: 'S-01 ログイン' },
        { href: '03_画面モックアップ/S-02_availability.html', title: 'S-02 空き状況・予約' },
        { href: '03_画面モックアップ/S-04_project-seat-request.html', title: 'S-04 プロジェクト座席' },
        { href: '03_画面モックアップ/S-05_proxy-select.html', title: 'S-05 固定座席の指定' },
        { href: '03_画面モックアップ/S-06_admin-menu.html', title: 'S-06 管理メニュー' },
        { href: '03_画面モックアップ/S-07_seat-master.html', title: 'S-07 座席マスタ管理' },
        { href: '03_画面モックアップ/S-08_role-master.html', title: 'S-08 権限・役割管理' },
        { href: '03_画面モックアップ/S-09_project-seat-allocation.html', title: 'S-09 プロジェクト座席（エリア担当）' },
        { href: '03_画面モックアップ/S-10_seat-history.html', title: 'S-10 座席状況の履歴照会' },
        { href: '03_画面モックアップ/S-11_proxy-booking.html', title: 'S-11 代理予約・取消' },
      ],
    },
    {
      group: '設計',
      docs: [
        { href: '座席予約システム_基本設計書.html', title: '基本設計書' },
      ],
    },
    {
      group: '利用者向け',
      docs: [
        { href: '座席予約システム_操作マニュアル.html', title: '操作マニュアル' },
      ],
    },
  ];

  // ---- 現在位置の判定（docs/ 直下か 03_画面モックアップ/ 配下か） ----
  const path = decodeURIComponent(location.pathname);
  const inMockupDir = path.indexOf('03_画面モックアップ') !== -1;
  const prefix = inMockupDir ? '../' : '';
  const currentFile = (path.split('/').pop() || '').toLowerCase();

  // ---- CSS 注入 ----
  const css = `
.sidenav {
  position: fixed; top: 0; left: 0;
  width: 220px; height: 100vh;
  background: #fafbfc;
  border-right: 1px solid #e7eaee;
  padding: 16px 14px;
  overflow-y: auto;
  z-index: 100;
  font-size: 12px;
  font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Meiryo", sans-serif;
  box-sizing: border-box;
}
.sidenav-title {
  font-size: 13px; font-weight: 700; color: #1e3a8a;
  border-bottom: 2px solid #1e40af;
  padding-bottom: 6px; margin-bottom: 12px;
  line-height: 1.4;
}
.sidenav-group { margin-bottom: 14px; }
.sidenav-group-title {
  font-size: 10.5px; font-weight: 600; color: #8a8f98;
  letter-spacing: 0.04em;
  margin-bottom: 4px; padding-left: 4px;
}
.sidenav ul { list-style: none; margin: 0; padding: 0 0 0 4px; }
.sidenav li { margin: 1px 0; }
.sidenav a {
  color: #1a1d21; text-decoration: none;
  display: block; padding: 4px 8px; border-radius: 6px;
  line-height: 1.5;
}
.sidenav a:hover { background: #eff6ff; color: #1e3a8a; text-decoration: none; }
.sidenav li.current a { background: #1e40af; color: #fff; font-weight: 600; }
.sidenav a.external { display: flex; align-items: baseline; gap: 4px; }
.sidenav-ext { font-size: 9px; color: #9aa0a8; flex: none; }
.sidenav a:hover .sidenav-ext { color: #1e3a8a; }
.sidenav li.current a .sidenav-ext { color: #c7d2fe; }

/* 本文左マージン（サイドナビ幅 + 余白） */
body { margin-left: 240px; }
@media print {
  body { margin-left: auto; }
  .sidenav { display: none; }
}
`;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- nav HTML 構築 ----
  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  let html = '<nav class="sidenav">';
  html += '<div class="sidenav-title">Zaseki<br>設計ドキュメント</div>';
  for (const g of DOCS) {
    html += '<div class="sidenav-group">';
    html += '<div class="sidenav-group-title">' + escape(g.group) + '</div>';
    html += '<ul>';
    for (const d of g.docs) {
      const file = (d.href.split('/').pop() || '').toLowerCase();
      const isCurrent = file === currentFile;
      const cls = isCurrent ? ' class="current"' : '';
      const attrs = g.newWindow
        ? ' target="_blank" rel="noopener" class="external"'
        : '';
      const mark = g.newWindow ? '<span class="sidenav-ext">↗</span>' : '';
      html +=
        '<li' + cls + '><a href="' + escape(prefix + d.href) + '"' + attrs + '>' +
        escape(d.title) + mark + '</a></li>';
    }
    html += '</ul></div>';
  }
  html += '</nav>';

  // ---- DOM 挿入（script タグの直後） ----
  const inject = () => {
    const target = document.currentScript || document.body.firstElementChild;
    if (target && target.insertAdjacentHTML) {
      target.insertAdjacentHTML('afterend', html);
    } else {
      document.body.insertAdjacentHTML('afterbegin', html);
    }
  };

  if (document.currentScript) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }
})();
