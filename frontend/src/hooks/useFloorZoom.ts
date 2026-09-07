import { useEffect, useRef } from 'react'
import type { AreaFilter } from './useAvailability'

const MOBILE_DEFAULT_SCALE = 0.45
const MOBILE_BREAKPOINT = 640

// S-02フロアマップのスマホ表示（FR-02-1）。スマホ幅では全体が収まる縮小率で表示し、
// 全体表示では最初にEAST/WESTエリアが見えるようスクロールする（NORTHが最初に映って
// しまうとの要望への対応）。
//
// 独自の2本指ピンチズーム機能は2026-09-07に撤去した。「ズームすると常に左上に寄る」
// 「震える」という報告を受けて複数の方式（scrollLeft/scrollTopの直接補正、rAFでの間引き、
// transform:scaleによる見た目だけのプレビュー）を試したが、実機でどれも改善しないか、
// 別の位置ズレを新たに生んでしまい、「一旦ズーム機能をなくしてほしい」との要望を受けた。
// この要素のtouch-actionはpan-x pan-y（パン方向のみブラウザに許可、pinch-zoomは含めない）
// のままだと2本指ズームの手段が一切なくなってしまうため、ブラウザ標準のピンチズーム
// （ページ全体が対象になる）を使えるようtouch-actionの制限自体を外す。
export function useFloorZoom(areaFilter: AreaFilter, ready: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const overview = overviewRef.current
    if (!viewport || !overview) return

    const scrollToEastWestIfAll = () => {
      if (areaFilter !== 'all') {
        viewport.scrollLeft = 0
        return
      }
      const stack = overview.querySelector('.floor-overview-stack')
      stack?.scrollIntoView({ inline: 'start', block: 'nearest' })
    }

    const applyDefaultScale = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) return
      overview.style.setProperty('--pinch-scale', String(MOBILE_DEFAULT_SCALE))
      scrollToEastWestIfAll()
    }

    applyDefaultScale()
    // モバイルはスクロール中にアドレスバーの出入りで高さだけが変わるresizeが連発する。
    // 幅が変わっていないのに毎回リセットするとスクロール位置が巻き戻ってカクつくため、
    // 幅が実際に変化したときだけ反応させる（2026-09-04追加）。
    let lastWidth = window.innerWidth
    const onResize = () => {
      const width = window.innerWidth
      if (width === lastWidth) return
      lastWidth = width
      applyDefaultScale()
    }
    window.addEventListener('resize', onResize)
    const timer = window.setTimeout(applyDefaultScale, 300)

    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer)
    }
  }, [areaFilter, ready])

  return { viewportRef, overviewRef }
}
