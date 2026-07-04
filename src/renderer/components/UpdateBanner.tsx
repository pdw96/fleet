import { useEffect, useRef, useState } from 'react'
import type { UpdateEvent } from '../../shared/types'

/**
 * 비차단 자동 업데이트 배너. App 레벨에 상시 마운트(탭 전환에 언마운트 안 됨, ApprovalModal 동형).
 * main(currentState)이 권위 — 구독 먼저 건 뒤 getUpdateState 로 하이드레이트하되, 그 사이 라이브
 * 이벤트가 오면 스냅샷으로 덮어쓰지 않는다(라이브 우선). 닫기/나중에는 main dismiss 로 권위 정리.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateEvent>({ kind: 'idle' })
  // 하이드레이션 레이스 가드: 스냅샷 resolve 전 라이브를 받았으면 스냅샷 무시(라이브 우선).
  const liveReceivedRef = useRef(false)

  useEffect(() => {
    const unsub = window.fleet.onUpdateEvent((e) => {
      liveReceivedRef.current = true
      setState(e)
    })
    void window.fleet
      .getUpdateState()
      .then((snap) => {
        if (!liveReceivedRef.current) setState(snap)
      })
      .catch(() => undefined) // IPC/전송 실패 — idle 유지(#197 B4 reject audit)
    return unsub
  }, [])

  const dismiss = (): void => {
    void window.fleet.dismissUpdate().catch(() => undefined)
    setState({ kind: 'idle' })
  }

  if (state.kind === 'available') {
    return (
      <div className="update-banner" role="status">
        <span>새 버전 {state.version} 사용 가능</span>
        <button
          className="btn"
          onClick={() => void window.fleet.downloadUpdate().catch(() => undefined)}
        >
          다운로드
        </button>
      </div>
    )
  }
  if (state.kind === 'progress') {
    return (
      <div className="update-banner" role="status">
        <span>업데이트 다운로드 중… {state.percent}%</span>
      </div>
    )
  }
  if (state.kind === 'downloaded') {
    return (
      <div className="update-banner" role="status">
        <span>버전 {state.version} 다운로드 완료 — 재시작해 적용</span>
        <button
          className="btn"
          onClick={() => void window.fleet.installUpdate().catch(() => undefined)}
        >
          지금
        </button>
        <button className="btn btn-ghost" onClick={dismiss}>
          나중에
        </button>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="update-banner update-banner-error" role="status">
        <span>업데이트 확인 실패</span>
        <button className="btn btn-ghost" onClick={dismiss}>
          닫기
        </button>
      </div>
    )
  }
  return null // idle · checking · not-available · unsupported
}
