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

    // ズームの中心を常に左上ではなく2本指の中間点にする（2026-09-07追加）。確定時（指を離した
    // 瞬間）に実際のzoom値とスクロール位置を計算する式は次の通り: 横方向はviewport
    // （floor-zoom-viewport、幅が画面幅で制限されているため自身がスクロールコンテナになる）の
    // scrollLeftを「(スクロール位置＋要素内の位置)×新倍率/旧倍率−要素内の位置」で補正する。
    // 縦方向はこの要素の高さがコンテンツに合わせて伸びるだけ（overflow-yが実際には発生しない）で
    // 実際にスクロールしているのはページ全体（window）であり、かつこの要素より上にヘッダー・
    // タブなど拡縮されない部分があるため、横方向と同じ式は使えない。「要素の上端から指の位置
    // までの距離（＝拡縮される範囲内でのローカル位置）」だけを新倍率/旧倍率した差分をscrollYに
    // 加える（ローカル位置×(新倍率−旧倍率)/旧倍率）。この式自体は指を離した時点の位置が
    // 合うことを確認済み。
    //
    // 指がまだ画面に触れている間（ジェスチャー中）は、この確定処理を毎フレーム呼ばない。
    // zoomプロパティの変更はフロアマップ全体のレイアウト再計算を伴い、window.scrollToも
    // 同期的な再描画を強制するため、rAFで1フレームに1回に間引いてもなお目に見える震えが
    // 残った（2026-09-07に2回試して両方とも解消しなかった）。かわりに、ジェスチャー中は
    // viewport（スクロールコンテナ自身。zoomが掛かっているoverviewではなくこちら）に
    // transform:scale＋transform-originだけを使った見た目だけのプレビューを表示する。
    // transformはレイアウトに影響しないためGPU合成だけで完結し、震えが起きない。zoomが
    // 掛かっていない要素にtransformを重ねるので、zoomとtransformの座標系の食い違い
    // （前回transformをoverview自身に重ねたときにズーム中心がずれた原因と思われる）も
    // 起きない。指を離した瞬間だけ、このプレビューを消して上記の確定処理を1回だけ行う。
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
      viewport.style.transformOrigin = `${lastMidX - rect.left}px ${lastMidY - rect.top}px`
      viewport.style.transform = `scale(${lastTargetScale / pinchStartScale})`
    }

    const commitGesture = () => {
      if (pinchStartDist === 0) return
      pinchStartDist = 0
      viewport.style.transform = ''
      viewport.style.transformOrigin = ''
      viewport.style.willChange = ''
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
        viewport.style.willChange = 'transform'
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
