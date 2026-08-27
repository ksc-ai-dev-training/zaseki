# zaseki

本社座席予約システム。新人社員向けAI開発研修の題材プロジェクト。設計ドキュメント一式は `docs/`、検討資料は `検討資料/` を参照（詳細は `CLAUDE.md`）。

## 開発環境の起動方法

前提: Python 3.12+ / Node.js 22+ / PostgreSQL（Docker とローカルインストールのどちらでもよい）

**かんたん起動**: リポジトリルートの `start.bat` を実行すると、DB・バックエンド・フロントエンドが順に起動する。設定はルートの `.env` で変更できる（初回実行時に `.env.example` から自動生成）。

初回のみ、事前に依存のインストールが必要:

```powershell
cd backend && python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
cd frontend && npm install
```

Vite が表示するURL（既定 http://localhost:5180 、使用中なら別ポート）を開き、ログイン画面の「開発用ログイン」からアカウントを選択する（Google OAuth は未接続。ローカルはダミー認証で代替）。

画面は1つずつ実装していく方針のため、現時点で動くのは S-01（ログイン）のみ。