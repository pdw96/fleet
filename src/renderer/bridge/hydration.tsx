import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { hasEventGap } from '../../shared/transport/protocol'
import type { ConnectionState, WsBridge } from './ws-bridge'

/**
 * 재하이드레이션 컨텍스트(#197 B4) — ws-bridge 의 재접속 hello(onEventCursor)를 세대 카운터(nonce)로
 * 변환한다. 각 패널의 스냅샷 하이드레이션 effect 가 [nonce] deps 로 재실행되며, 스냅샷은 권위
 * (replace 시맨틱 — 끊긴 사이 끝난 실행/스트림/busy 를 내린다). 데스크톱은 bridge=null → nonce 영구 0
 * (마운트 1회 시맨틱 무회귀). 재하이드레이션은 항상 전체 — 증분 재생은 since-커서 API 부재로 서버 비용이
 * 동일해 비범위(커서·hasEventGap 은 rotation 손실 관측 용도).
 */
export interface HydrationState {
  /** 재하이드레이션 세대 — 0=최초 마운트, 재접속 hello 마다 +1. 스냅샷 effect 의 deps 로 쓴다. */
  nonce: number
  /** 웹 전송 상태(데스크톱=null — 배너 미표시). */
  connection: ConnectionState | null
  /**
   * 서버 graceful drain 중(#216 C3) — onServerDraining push 로 true. 「곧 재접속」 배너용. 재접속 hello
   * (nonce+1)에서 false 리셋한다 — drain 은 단일 종료 세대 신호이고 신서버 재접속은 종료 상태를 계승하지 않는다
   * (미리셋 시 재배포 후 건강한 새 연결에 배너 영구 표시 = C3 목표 훼손 · F4).
   */
  draining: boolean
}

export const HydrationContext = createContext<HydrationState>({
  nonce: 0,
  connection: null,
  draining: false,
})

export function useHydration(): HydrationState {
  return useContext(HydrationContext)
}

export function HydrationProvider({
  bridge,
  children,
}: {
  bridge: WsBridge | null
  children: ReactNode
}) {
  const [state, setState] = useState<HydrationState>({
    nonce: 0,
    connection: bridge ? bridge.connectionState() : null,
    draining: false,
  })

  useEffect(() => {
    if (!bridge) return
    // 클라이언트 이벤트 커서 — hello.maxEventSeq 와 라이브 영속 이벤트 seq 의 max 로 전진한다.
    // 마지막 hello 워터마크로 시드한다: 최초 hello 가 이 구독보다 먼저 도착하면(초기 로드 레이스) 커서가
    // null 로 남아 첫 재접속 hello 가 '최초 접속'으로 오분류돼 nonce 를 안 올리는 gap 을 닫는다(리뷰 [11]).
    let cursor: number | null = bridge.getEventCursor()?.maxEventSeq ?? null
    const offLive = bridge.fleet.onOrchestratorEvent((e) => {
      if (typeof e.seq === 'number' && (cursor === null || e.seq > cursor)) cursor = e.seq
    })
    const offCursor = bridge.onEventCursor((hello) => {
      if (cursor === null) {
        cursor = hello.maxEventSeq // 최초 접속 — 마운트 하이드레이션이 담당(이중 조회 방지)
        return
      }
      if (hasEventGap(cursor, hello)) {
        // rotation 으로 증분 불가 구간 — 어차피 전체 재하이드레이션이라 복구되지만 관측은 남긴다.
        console.warn(
          `fleet: 재접속 이벤트 gap 감지(커서 ${cursor} < 보존 최소 ${hello.minRetainedEventSeq})`,
        )
      }
      cursor = Math.max(cursor, hello.maxEventSeq)
      // 재접속 hello — 재하이드레이션 세대 전진 + draining 리셋(신서버 접속은 구서버 종료 상태 미계승 · F4).
      setState((s) => ({ ...s, nonce: s.nonce + 1, draining: false }))
    })
    const offState = bridge.onConnectionState((c) => setState((s) => ({ ...s, connection: c })))
    // 서버 graceful drain 통지(#216 C3) — 종료 시작 시 「곧 재접속」 배너. 소켓이 닫히면 자연히 reconnecting
    // 배너로 전이하고, 신서버 재접속 hello 가 draining 을 리셋한다.
    const offDraining = bridge.fleet.onServerDraining(() =>
      setState((s) => ({ ...s, draining: true })),
    )
    return () => {
      offLive()
      offCursor()
      offState()
      offDraining()
    }
  }, [bridge])

  return <HydrationContext.Provider value={state}>{children}</HydrationContext.Provider>
}

/** 전송 상태 배너(웹 전용) — App 상시 마운트. 재접속 완료 후엔 스냅숏 권위 통지를 잠시 띄운다. */
export function ConnectionBanner() {
  const { connection, nonce, draining } = useHydration()
  const [showRecovered, setShowRecovered] = useState(false)

  useEffect(() => {
    if (nonce === 0) return
    // 의도적 동기 setState: 재접속 세대 전환 통지의 즉시 표시(세대당 1회 추가 렌더·무해). 룰은 켜 두고 이 site 만 억제.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowRecovered(true)
    const t = setTimeout(() => setShowRecovered(false), 8000)
    return () => clearTimeout(t)
  }, [nonce])

  if (connection === null) return null // 데스크톱
  if (connection === 'reconnecting') {
    return (
      <div className="update-banner" role="status">
        서버 연결이 끊겼습니다 — 재접속 중…
      </div>
    )
  }
  if (connection === 'closed') {
    return (
      <div className="update-banner update-banner-error" role="status">
        서버 연결이 종료되었습니다 — 페이지를 새로고침하세요.
      </div>
    )
  }
  // 서버 graceful drain 중(#216 C3) — 연결은 아직 살아 있으나 곧 닫힌다. 소켓이 닫히면 위 reconnecting
  // 배너로 전이하고, 신서버 재접속 hello 가 draining 을 리셋한다(그때 아래 showRecovered 가 대신 표시).
  if (draining) {
    return (
      <div className="update-banner" role="status">
        서버 종료 중 — 곧 재접속됩니다.
      </div>
    )
  }
  if (showRecovered) {
    return (
      <div className="update-banner" role="status">
        재접속됨 — 실시간 진행 델타는 유실될 수 있으며 최종 상태는 스냅숏이 권위입니다.
      </div>
    )
  }
  return null
}
