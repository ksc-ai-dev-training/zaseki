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
      <div className="w-full max-w-sm rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
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
        <div className="px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>
      </div>
    </div>
  )
}
