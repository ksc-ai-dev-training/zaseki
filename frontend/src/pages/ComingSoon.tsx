import { Link } from 'react-router'

interface ComingSoonProps {
  id: string
  name: string
}

// 画面は1つずつ実装していく方針のため、まだ着手していない画面への導線の遷移先
export default function ComingSoon({ id, name }: ComingSoonProps) {
  return (
    <div>
      <header className="flex items-baseline gap-2 border-b border-slate-200 bg-white px-8 py-4">
        <h1 className="text-xl font-bold">{name}</h1>
        <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-slate-400">{id}</span>
      </header>
      <div className="flex flex-col items-center gap-3 p-16 text-center text-slate-500">
        <p>この画面は準備中です。</p>
        <Link to="/" className="text-sm text-blue-800 hover:underline">空き状況・予約に戻る</Link>
      </div>
    </div>
  )
}
