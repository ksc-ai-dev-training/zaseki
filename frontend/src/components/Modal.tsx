import type { ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}

// 予約確認・取消確認等で使う共通モーダル（S-02の座席予約モーダル等）
export default function Modal({ title, onClose, children, footer }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* 2026-09-14修正: 「ポップアップが出てくるとき横幅がなさすぎて文字がわかりづらい」との
          指摘を受け、max-w-sm（384px）からmax-w-xl（576px）へ広げた。全画面共通コンポーネントの
          ためこの1箇所の変更で全てのモーダルに反映される。スマホ幅（外側のp-4を差し引いた幅が
          576pxを下回る画面）ではw-fullが優先されるため、この変更による影響はない */}
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg bg-white shadow-lg">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-400 px-5 py-3">
          <div className="font-semibold">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-lg leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {/* flex-wrapなしだと、S-11の固定座席解除モーダル（ボタン4個）のように長いラベルの
            ボタンが並ぶ場合、1行に収めようとして各ボタンが極端に狭く潰れ、日本語が1文字ずつ
            改行される見た目になっていた（2026-09-11修正）。折り返しを許可し、幅が足りなければ
            複数行に分けることで、各ボタンが不自然に潰れないようにする */}
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-400 px-5 py-3">{footer}</div>
      </div>
    </div>
  )
}
