import { useEffect, useState } from 'react'

// Tailwindのsmブレークポイント（640px）未満をスマホ幅とみなす（useFloorZoomのMOBILE_BREAKPOINTと同じ基準）
const MOBILE_MEDIA_QUERY = '(max-width: 639px)'

// スマホ幅かどうかを判定する（2026-09-03追加。「S-02の期間ビューが見づらいのでスマホ版限定で
// 予約数と曜日の表示をなくしてほしい」との要望を受けた）。リサイズ・画面回転でブレークポイントを
// またいだ場合も再レンダリングされるようmatchMediaの変化を購読する
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches
  )

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
