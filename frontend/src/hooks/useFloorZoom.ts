import { useEffect, useRef } from 'react'
import type { AreaFilter } from './useAvailability'

const MOBILE_DEFAULT_SCALE = 0.45
const PINCH_MIN = MOBILE_DEFAULT_SCALE
const PINCH_MAX = 3
const PINCH_HIDE_TAG_BELOW = 0.6
const MOBILE_BREAKPOINT = 640

// S-02フロアマップのスマホ表示（FR-02-1、画面モックアップのpinch-zoom実装を移植）。
// スマホ幅では2本指ピンチで拡大・縮小でき、全体表示では最初にEAST/WESTエリアが
// 見えるようスクロールする（NORTHが最初に映ってしまうとの要望への対応）。
export function useFloorZoom(areaFilter: AreaFilter, ready: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const overview = overviewRef.current
    if (!viewport || !overview) return

    const currentScale = () =>
      parseFloat(getComputedStyle(overview).getPropertyValue('--pinch-scale')) || 1

    const clampScale = (scale: number) => Math.min(PINCH_MAX, Math.max(PINCH_MIN, scale))

    const applyPinchScale = (scale: number) => {
      const clamped = clampScale(scale)
      overview.style.setProperty('--pinch-scale', String(clamped))
      overview.classList.toggle('zoomed-out', clamped < PINCH_HIDE_TAG_BELOW)
    }

    const scrollToEastWestIfAll = () => {
      if (areaFilter !== 'all') {
        viewport.scrollLeft = 0
        return
      }
      const stack = overview.querySelector('.floor-overview-stack')
      stack?.scrollIntoView({ inline: 'start', block: 'nearest' })
    }

    const resetPinchZoom = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) return
      applyPinchScale(MOBILE_DEFAULT_SCALE)
      scrollToEastWestIfAll()
    }

    resetPinchZoom()
    // モバイルはスクロール中にアドレスバーの出入りで高さだけが変わるresizeが連発する。
    // 幅が変わっていないのに毎回リセットするとスクロール位置が巻き戻ってカクつくため、
    // 幅が実際に変化したときだけ反応させる（2026-09-04追加）。
    let lastWidth = window.innerWidth
    const onResize = () => {
      const width = window.innerWidth
      if (width === lastWidth) return
      lastWidth = width
      resetPinchZoom()
    }
    window.addEventListener('resize', onResize)
    const timer = window.setTimeout(resetPinchZoom, 300)

    let pinchStartDist = 0
    let pinchStartScale = 1
    const touchDistance = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX
      const dy = touches[0].clientY - touches[1].clientY
      return Math.sqrt(dx * dx + dy * dy)
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchStartDist = touchDistance(e.touches)
        pinchStartScale = currentScale()
      }
    }
    // ズームの中心を常に左上ではなく2本指の中間点にする（2026-09-07追加。「必ず左上の部分が
    // ズームされてしまうのでどの位置でもズームできるようにしてほしい」との報告を受けた）。
    // zoomプロパティはtransform:scaleと異なりレイアウトサイズ自体を拡縮するため、スクロール位置
    // も拡縮後の座標系になる。画面上の指の位置（renderedPos）を拡縮前後で一定に保つように、
    // 「(スクロール位置＋画面上の位置) × 新倍率/旧倍率 − 画面上の位置」でスクロール位置を補正する。
    // 拡大方向では新しいスクロール位置が拡大前のスクロール可能範囲の上限を超えるため、先に
    // スクロールを補正してからapplyPinchScaleを呼ぶと補正値がその場でクランプされて効かない
    // （常に拡大前に表示できていた左上寄りの範囲に戻ってしまう）。必ず拡縮を先に適用し、
    // レイアウトが更新された後でスクロール位置を補正する順序にする。
    // 横方向はviewport（floor-zoom-viewport、幅が画面幅で制限されているため自身がスクロール
    // コンテナになる）のscrollLeftで補正できるが、縦方向はこの要素の高さがコンテンツに合わせて
    // 伸びるだけ（overflow-yが実際には発生しない）で、実際にスクロールしているのはページ全体
    // （window）のため、縦方向はwindow.scrollYを補正する（最初の修正で左上に戻ってしまっていた
    // 原因はこの縦方向の取り違え）。
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault()
        const oldScale = currentScale()
        const newScale = clampScale(pinchStartScale * (touchDistance(e.touches) / pinchStartDist))
        if (newScale === oldScale) return
        const rect = viewport.getBoundingClientRect()
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
        const midYClient = (e.touches[0].clientY + e.touches[1].clientY) / 2
        const oldScrollLeft = viewport.scrollLeft
        const oldScrollY = window.scrollY
        const ratio = newScale / oldScale
        applyPinchScale(newScale)
        viewport.scrollLeft = (oldScrollLeft + midX) * ratio - midX
        window.scrollTo(window.scrollX, (oldScrollY + midYClient) * ratio - midYClient)
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchStartDist = 0
    }
    viewport.addEventListener('touchstart', onTouchStart, { passive: true })
    viewport.addEventListener('touchmove', onTouchMove, { passive: false })
    viewport.addEventListener('touchend', onTouchEnd)

    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer)
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('touchmove', onTouchMove)
      viewport.removeEventListener('touchend', onTouchEnd)
    }
  }, [areaFilter, ready])

  return { viewportRef, overviewRef }
}
