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

    // ジェスチャー中は毎フレームzoomプロパティ（レイアウトサイズそのものを変える、
    // transform:scaleと違いGPU合成だけでは済まない）とwindow.scrollToを直接更新するのをやめ、
    // 指を動かしている間はtransform:scale＋transform-originによる見た目だけのプレビューに
    // とどめ、指を離した瞬間に一度だけ実際のzoom値とスクロール位置を確定させる方式に変更した
    // （2026-09-07再修正。rAFで1フレーム1回に間引いても「プルプル震える」報告が直らなかった。
    // window.scrollToは指がまだ画面に触れている最中に呼ぶとブラウザ本体のタッチ・スクロール
    // 処理と競合しやすく、震えの実体はこの競合だったと考えられる。transform-originによる
    // 拡縮はブラウザが指定した点を中心に自動で見た目を維持してくれるため、スクロール位置の
    // 補正が一切不要になり、この競合そのものが起きなくなる）。
    let lastMidX = 0
    let lastMidY = 0
    let lastTargetScale = 1
    let pendingTouch: { x0: number; y0: number; x1: number; y1: number } | null = null
    let rafId: number | null = null

    const applyLivePreview = () => {
      rafId = null
      if (!pendingTouch || pinchStartDist === 0) return
      const { x0, y0, x1, y1 } = pendingTouch
      const dist = Math.sqrt((x0 - x1) ** 2 + (y0 - y1) ** 2)
      lastTargetScale = clampScale(pinchStartScale * (dist / pinchStartDist))
      lastMidX = (x0 + x1) / 2
      lastMidY = (y0 + y1) / 2
      const rect = viewport.getBoundingClientRect()
      // transform-originはoverview自身のボックス内でのローカル座標（zoom適用後のレイアウト
      // ピクセル）。横は自身がスクロールコンテナ（viewport.scrollLeft分ずれている）、縦は
      // window側がスクロールしているためrect.topに現在のスクロール位置が反映済み。
      const localX = viewport.scrollLeft + (lastMidX - rect.left)
      const localY = lastMidY - rect.top
      overview.style.transformOrigin = `${localX}px ${localY}px`
      overview.style.transform = `scale(${lastTargetScale / pinchStartScale})`
    }

    // ジェスチャー終了時、プレビューで見えていた見た目と同じ位置になるよう実際のzoom値と
    // スクロール位置を一度だけ確定させる（式はプレビュー導入前の確定処理と同じ考え方）。
    const commitGesture = () => {
      if (pinchStartDist === 0) return
      pinchStartDist = 0
      overview.style.transform = ''
      overview.style.transformOrigin = ''
      overview.style.willChange = ''
      const oldScale = pinchStartScale
      const newScale = lastTargetScale
      if (newScale === oldScale) return
      const rect = viewport.getBoundingClientRect()
      const midX = lastMidX - rect.left
      const midY = lastMidY - rect.top
      const oldScrollLeft = viewport.scrollLeft
      const oldScrollY = window.scrollY
      const ratio = newScale / oldScale
      applyPinchScale(newScale)
      viewport.scrollLeft = (oldScrollLeft + midX) * ratio - midX
      window.scrollTo(window.scrollX, oldScrollY + midY * (ratio - 1))
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchStartDist = touchDistance(e.touches)
        pinchStartScale = currentScale()
        lastTargetScale = pinchStartScale
        lastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2
        overview.style.willChange = 'transform'
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault()
        pendingTouch = {
          x0: e.touches[0].clientX, y0: e.touches[0].clientY,
          x1: e.touches[1].clientX, y1: e.touches[1].clientY,
        }
        if (rafId === null) rafId = requestAnimationFrame(applyLivePreview)
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pendingTouch = null
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        commitGesture()
      }
    }
    viewport.addEventListener('touchstart', onTouchStart, { passive: true })
    viewport.addEventListener('touchmove', onTouchMove, { passive: false })
    viewport.addEventListener('touchend', onTouchEnd)
    viewport.addEventListener('touchcancel', onTouchEnd)

    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer)
      if (rafId !== null) cancelAnimationFrame(rafId)
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('touchmove', onTouchMove)
      viewport.removeEventListener('touchend', onTouchEnd)
      viewport.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [areaFilter, ready])

  return { viewportRef, overviewRef }
}
