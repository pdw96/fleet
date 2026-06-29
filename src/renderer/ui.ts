import type { CSSProperties } from 'react'

/**
 * 시각 시스템은 styles.css(디자인 토큰·컴포넌트 클래스)가 소유한다.
 * 여기서는 className 으로 표현하기 어려운 '동적 색상'(상태별·에이전트별)만 다룬다.
 */

/** 클래스명 조건 결합. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** CSS 커스텀 프로퍼티(예: --hue)를 인라인 스타일로 주입. */
export function vars(map: Record<string, string>): CSSProperties {
  return map as CSSProperties
}

/** 작업/프로젝트 상태 → CSS 변수 색상. */
export function statusColor(status: string): string {
  switch (status) {
    case 'done':
      return 'var(--ok)'
    case 'partial':
      // 부분 완료 — done(초록)/failed(빨강)과 구분되는 진행 톤(앰버). (#166)
      return 'var(--warn)'
    case 'failed':
      return 'var(--bad)'
    case 'running':
    case 'review':
    case 'executing':
    case 'verifying':
      return 'var(--warn)'
    case 'skipped':
      // 건너뜀 — 실패(빨강)와 구분되는 muted 톤. pending(기본 --dim)보다 한 단계 더 흐리게.
      return 'var(--faint)'
    default:
      return 'var(--dim)'
  }
}

/** 채팅 참여자(LLM)별 고유 색상 — 멀티 LLM 대화를 시각적으로 분간. */
const AGENT_HUES = ['#ffc24b', '#4fe0c0', '#9d8bff', '#ff9e7a', '#7ec8ff', '#f7768e']

export function agentHue(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AGENT_HUES[h % AGENT_HUES.length]
}
