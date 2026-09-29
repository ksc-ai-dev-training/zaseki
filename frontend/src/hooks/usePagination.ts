import { useState } from 'react'

// 表示件数の選択肢（2026-09-29新設。AskUserQuestionで確認、全画面共通）
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const

/**
 * 一覧表のクライアント側ページングを行う共通フック。座席マスタ管理（SeatMaster.tsx）に
 * あった独自のページング・ページ番号ロジックを切り出し、表示件数（PAGE_SIZE_OPTIONS）を
 * 選べるようにしたうえで、利用者ロール管理・プロジェクト・PM管理・固定座席利用者一覧にも
 * 展開した（2026-09-29。「座席マスタ管理のみページングされているのが気になる、他の表も
 * 同様にページングできてもいい。10件ごとは使いにくいので全体的に表示件数指定ができても
 * いい」との要望を受けた）。各画面のAPIは元々全件を返す設計のため、あくまで既に取得済みの
 * 配列をクライアント側で切り出すだけで、サーバー側のページング（limit/offset）は行わない。
 * 検索・絞り込み条件を変えたときは、呼び出し側がsetPage(1)を呼んで1ページ目に戻す
 * （SeatMaster.tsx等の既存の使い方を踏襲、このフック自身はitemsの中身までは見ていないため）
 */
export function usePagination<T>(items: T[], initialPageSize: number = PAGE_SIZE_OPTIONS[0]) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState<number>(initialPageSize)

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  // 表示件数を変えたら1ページ目に戻す（例: 10件表示の3ページ目を見ている状態から100件表示へ
  // 変えると全件が1ページに収まり、3ページ目という位置に意味がなくなるため）
  const setPageSize = (size: number) => {
    setPageSizeState(size)
    setPage(1)
  }

  return { page: currentPage, setPage, pageSize, setPageSize, totalPages, pageItems, totalCount: items.length }
}

// ページ番号ボタンの並び（先頭2件・末尾2件・現在ページの前後1件のみを表示し、間は省略記号にする）
export function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set([1, 2, total - 1, total, current - 1, current, current + 1])
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const result: (number | '…')[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - (sorted[i - 1] as number) > 1) result.push('…')
    result.push(p)
  })
  return result
}
