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

    const applyPinchScale = (scale: number) => {
      const clamped = Math.min(PINCH_MAX, Math.max(PINCH_MIN, scale))
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
    window.addEventListener('resize', resetPinchZoom)
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
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault()
        applyPinchScale(pinchStartScale * (touchDistance(e.touches) / pinchStartDist))
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchStartDist = 0
    }
    viewport.addEventListener('touchstart', onTouchStart, { passive: true })
    viewport.addEventListener('touchmove', onTouchMove, { passive: false })
    viewport.addEventListener('touchend', onTouchEnd)

    return () => {
      window.removeEventListener('resize', resetPinchZoom)
      window.clearTimeout(timer)
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('touchmove', onTouchMove)
      viewport.removeEventListener('touchend', onTouchEnd)
    }
  }, [areaFilter, ready])

  return { viewportRef, overviewRef }
}
