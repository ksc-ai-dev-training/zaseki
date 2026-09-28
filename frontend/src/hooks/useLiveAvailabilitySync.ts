import { useEffect } from 'react'
import { mutate as globalMutate } from 'swr'

// A-89: 座席の空き状況の変更をWebSocketでほぼ即時に反映する（2026-09-28追加）。
// 「席の予約がされたときリアルタイムですぐに反映されるようになっているか」との質問を受け、
// 当初はuseAvailability・usePeriodAvailabilityの定期ポーリング（1秒間隔）で対応していたが、
// 続けて「もっとすぐに反映することは可能か」との質問を受け、ポーリングをWebSocketによる
// 即時プッシュに切り替える試験導入を行った。
//
// サーバー（ws_manager.py）から届くメッセージは「変わった」という合図のみで実データを含まない。
// このフックはメッセージを受け取るたびに、SWRのグローバルmutateでA-06・A-07（/api/seats/
// availability・/api/seats/availability/period）のキャッシュをまとめて再検証させるだけで、
// 実際のデータ取得は既存のREST APIにそのまま任せる。App.tsx（ログイン後の共通レイアウト配下）で
// 1回だけ呼び出し、画面遷移中も接続を維持する。
export function useLiveAvailabilitySync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const revalidateAvailability = () => {
      globalMutate((key) => typeof key === 'string' && key.startsWith('/api/seats/availability'))
    }

    const connect = () => {
      if (stopped) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/availability`)
      socket.onmessage = revalidateAvailability
      // 切断時（サーバー再起動、Fly.ioのautostop等）は3秒後に再接続を試みる。接続中に何度も
      // 貼り直さないよう、既存のタイマーがあれば張り直さない
      socket.onclose = () => {
        if (stopped || reconnectTimer) return
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 3000)
      }
      // onerrorの直後に必ずoncloseも発火するため、再接続はoncloseの一箇所に任せる
      socket.onerror = () => socket?.close()
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [enabled])
}
