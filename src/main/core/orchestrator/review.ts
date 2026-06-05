import type { VerificationResult } from '../../../shared/types'

export interface ReviewVerdict {
  approved: boolean
  feedback: string
}

/** 구현 작업 프롬프트 (선택적 이전 피드백 반영). 에이전트가 워크스페이스를 직접 편집한다. */
export function buildImplementPrompt(
  goal: string,
  taskTitle: string,
  taskDescription: string,
  feedback?: string,
): string {
  const parts = [
    `프로젝트 목표:\n${goal}`,
    `\n담당 작업: ${taskTitle}\n${taskDescription}`,
    '\n현재 워크스페이스(작업 디렉터리)에서 이 작업을 직접 수행하라. 필요한 파일을 만들거나 수정하라.',
    '작업 범위 밖의 파일은 건드리지 마라. 완료 후 무엇을 왜 변경했는지 한 단락으로 요약하라.',
  ]
  if (feedback && feedback.trim()) {
    parts.push(`\n이전 검토 피드백을 반드시 반영하라:\n${feedback.trim()}`)
  }
  return parts.join('\n')
}

/** 교차 리뷰 프롬프트 (다른 LLM 이 워크스페이스 변경 diff 를 검토). */
export function buildReviewPrompt(taskTitle: string, taskDescription: string, diff: string): string {
  return [
    '다음은 한 작업으로 발생한 워크스페이스 변경(diff)이다. 비판적으로 검토하라.',
    `작업: ${taskTitle}`,
    `설명: ${taskDescription}`,
    '',
    '변경(diff):',
    diff || '(변경 없음)',
    '',
    '승인하면 첫 줄에 "APPROVE" 만 쓰라. 수정이 필요하면 첫 줄에 "REVISE" 를 쓰고',
    '다음 줄부터 무엇을 어떻게 고칠지 구체적으로 작성하라.',
  ].join('\n')
}

/** 리뷰 출력 파싱: 첫 토큰 APPROVE/REVISE + 피드백. */
export function parseReviewVerdict(text: string): ReviewVerdict {
  // 앞쪽의 마크다운 강조·인용부호·리스트 마커·공백을 벗겨 판정 토큰을 노출시킨다
  // (예: "**APPROVE**", '"APPROVE"', "- APPROVE" 도 승인으로 인식). 'APPROVED' 변형도 허용.
  const normalized = text.trim().replace(/^[\s*_`"'>•-]+/, '')
  const approved = /^APPROVED?\b/i.test(normalized)
  const feedback = normalized.replace(/^(APPROVED?|REVISE[DS]?)\b[:\s]*/i, '').trim()
  return { approved, feedback }
}

/** 최종 요약/누락 점검 프롬프트 (요구사항 5: 원래 요구사항과 비교). */
export function buildSummaryPrompt(
  goal: string,
  tasks: ReadonlyArray<{ title: string; status: string }>,
): string {
  const lines = tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n')
  return [
    `프로젝트 목표:\n${goal}`,
    '',
    '수행된 작업:',
    lines,
    '',
    '최종 결과가 원래 목표를 충족하는지 평가하고, 누락되거나 미흡한 부분을 구체적으로 지적하라.',
  ].join('\n')
}

const FIX_DETAIL_CAP = 2_000

/**
 * verify 실패 → 에이전트 수정 프롬프트.
 * 실패한 검증의 분석(없으면 stderr)을 실어, 워크스페이스에서 직접 수정하도록 요청한다.
 */
export function buildVerifyFixPrompt(goal: string, failures: ReadonlyArray<VerificationResult>): string {
  const failBlock = failures
    .map((f) => `- [${f.kind}] ${f.command}\n  ${(f.analysis ?? f.stderr ?? '').slice(0, FIX_DETAIL_CAP).replace(/\n/g, '\n  ')}`)
    .join('\n')
  return [
    `프로젝트 목표:\n${goal}`,
    '',
    '검증(verify)이 실패했다. 현재 워크스페이스에서 아래 실패를 모두 직접 고쳐라:',
    failBlock,
    '',
    '필요한 파일을 직접 수정하라. 완료 후 변경 요약을 한 단락으로 작성하라.',
  ].join('\n')
}
