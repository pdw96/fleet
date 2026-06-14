import { useEffect, useRef, useState } from 'react'
import { APPROVAL_TIMEOUT_MS } from '../../shared/types'
import type { ApprovalRequest, RiskLevel } from '../../shared/types'

const RISK_LABEL: Record<RiskLevel, string> = {
  safe: '안전',
  caution: '주의',
  destructive: '위험',
}

/** 승인 종류별 모달 제목. apply-diff 는 작업 변경 적용 승인. */
const KIND_TITLE: Record<ApprovalRequest['kind'], string> = {
  'file-write': '위험 작업 승인',
  'file-delete': '위험 작업 승인',
  shell: '위험 작업 승인',
  'apply-diff': '변경 적용 승인',
  'tool-call': '도구 호출 승인',
}

/** destructive 작업 승인 모달. App 레벨에 상시 마운트되어 메인의 승인 요청을 큐로 순차 처리한다. */
export function ApprovalModal() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const [remaining, setRemaining] = useState(0)
  const rejectRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // 승인 요청 구독 — 마운트 1회. 들어온 요청을 큐 뒤에 적재.
  useEffect(() => {
    const unsub = window.fleet.onApprovalRequest((req) => setQueue((prev) => [...prev, req]))
    return unsub
  }, [])

  const current = queue[0]

  const decide = (approved: boolean): void => {
    if (!current) return
    void window.fleet.respondApproval(current.id, approved)
    setQueue((prev) => prev.slice(1))
  }

  // 현재 요청 전환 시 카운트다운 리셋(시각 표시 전용 — 실제 자동 거부는 메인 측 권위).
  useEffect(() => {
    if (!current) return
    setRemaining(Math.ceil(APPROVAL_TIMEOUT_MS / 1000))
    const iv = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000)
    return () => clearInterval(iv)
  }, [current?.id])

  // 모달 열림·큐 전진(다음 요청)마다 거부 버튼에 초기 포커스 — Enter 가 거부로 떨어져 destructive 오승인 방지.
  useEffect(() => {
    if (current) rejectRef.current?.focus()
  }, [current?.id])

  // 키보드 트랩(document 레벨): Escape=거부 + Tab/Shift+Tab 을 모달 내 버튼(거부↔승인)으로 가둔다.
  // document 에 거는 이유 — overlay 에 건 핸들러는 포커스가 overlay 밖(배경/body)으로 새면 발화하지 않아
  // 배경으로의 Tab 탈출을 못 막는다(Codex P2). document 리스너는 포커스 위치와 무관하게 Tab 을 잡아,
  // 포커스가 모달 밖이면(!card.contains) 내부로 복귀시킨다.
  useEffect(() => {
    if (!current) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        decide(false) // 거부 — 자동거부 백스톱과 일관한 안전 방향
        return
      }
      if (e.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const focusables = Array.from(card.querySelectorAll<HTMLElement>('button'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!card.contains(active)) {
        e.preventDefault()
        first.focus() // 포커스가 모달 밖으로 샜으면 내부(첫 버튼)로 복귀
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [current?.id])

  if (!current) return null

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      aria-describedby="approval-summary approval-target"
    >
      <div className="panel modal-card" ref={cardRef}>
        <div className="panel-head">
          <span className="eyebrow">승인 필요</span>
          <h2 className="panel-title" id="approval-title">
            {KIND_TITLE[current.kind]}
          </h2>
          <div className="right">
            <span className="chip" style={{ color: 'var(--bad)', borderColor: 'currentColor' }}>
              {RISK_LABEL[current.risk]}
            </span>
          </div>
        </div>
        <p className="modal-summary" id="approval-summary">
          {current.summary}
        </p>
        <p className="modal-target" id="approval-target">
          {current.target}
        </p>
        <div className="modal-actions">
          <span className="modal-countdown">{remaining}s 후 자동 거부</span>
          <button ref={rejectRef} className="btn btn-danger" onClick={() => decide(false)}>
            거부
          </button>
          <button className="btn" onClick={() => decide(true)}>
            승인
          </button>
        </div>
        {queue.length > 1 && <p className="modal-pending">대기 중 {queue.length - 1}건</p>}
      </div>
    </div>
  )
}
