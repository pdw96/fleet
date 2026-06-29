import type { VerificationResult } from '../../../shared/types'

export interface ReviewVerdict {
  approved: boolean
  feedback: string
  /**
   * verdict 가 인식된 형식(JSON {approved} 또는 APPROVE/REVISE 토큰)에서 나왔는지(#162).
   * false = 리뷰어가 유효한 verdict 를 내지 않음(빈/거부 산문) → 폴백 default approved:false 와
   * 구분한다. accept-with-warnings 는 parsed=true(실제 리뷰 거부)일 때만 적용해 미검토 채택을 막는다.
   */
  parsed: boolean
}

/** reviewer 구조화 출력 스키마. */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'feedback'],
  properties: {
    approved: { type: 'boolean' },
    feedback: { type: 'string' },
  },
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

/**
 * 교차 리뷰 프롬프트 (다른 LLM 이 워크스페이스 변경 diff 를 검토).
 *
 * 승인/거부 기준을 대칭적·구체적으로 명시한다(#162). "비판적으로 검토하라" 식 framing 은
 * 어떤 LLM 이든 "개선 여지"를 "거부 사유"로 승격시켜 올바른 첫 시도조차 거의 무조건 거부하게
 * 만들었다(격리 재현: claude/codex 둘 다 3줄짜리 올바른 add() 를 approved:false). 작업을
 * 실질적으로 달성하면 개선 여지가 있어도 승인하고, 실제 결함·요구사항 위반·미완성만 거부한다.
 */
export function buildReviewPrompt(
  taskTitle: string,
  taskDescription: string,
  diff: string,
): string {
  return [
    '다음은 한 작업으로 발생한 워크스페이스 변경(diff)이다. 작업 기준으로 검토하라.',
    `작업: ${taskTitle}`,
    `설명: ${taskDescription}`,
    '',
    '변경(diff):',
    diff || '(변경 없음)',
    '',
    '승인(approved:true) — 아래를 모두 만족하면 승인하라:',
    '- 변경이 작업 설명을 실질적으로 달성한다.',
    '- 명백한 버그·요구사항 위반·런타임/타입/테스트 실패 가능성이 없다.',
    '- 잘못된 파일이나 범위 밖 변경이 없다.',
    '추가 테스트·더 넓은 입력 검증·스타일 개선·리팩터 제안은 feedback 에 적을 수 있으나,',
    '그 개선 여지 자체는 거부 사유가 아니다(개선 여지 ≠ 거부).',
    '',
    '거부(approved:false) — 아래 중 하나라도 해당할 때만 거부하라:',
    '- 작업이 미완성이다(요구된 것을 하지 않았다).',
    '- 변경이 요구사항과 충돌한다.',
    '- 구체적인 런타임/타입/테스트 실패 가능성이 있다.',
    '- 잘못된 파일이나 범위 밖 변경이 있다.',
    '',
    '반드시 아래 형식의 JSON 객체만 출력하라(설명/마크다운 금지):',
    '{"approved": true 또는 false, "feedback": "거부면 무엇을 어떻게 고칠지 구체적으로; 승인이어도 advisory 개선 제안을 적을 수 있다"}',
  ].join('\n')
}

/** 리뷰 출력 파싱: 구조화 JSON {approved,feedback} 우선, 실패 시 APPROVE/REVISE 토큰 폴백. */
export function parseReviewVerdict(text: string): ReviewVerdict {
  // 코드펜스(```json … ```)로 감싼 출력은 본문만 떼어 파싱한다(CLI 폴백 견고화 — planner 경로와 대칭).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fence ? fence[1] : text).trim()
  try {
    const parsed = JSON.parse(candidate) as unknown
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>
      if (typeof o.approved === 'boolean') {
        return {
          approved: o.approved,
          feedback: typeof o.feedback === 'string' ? o.feedback : '',
          parsed: true,
        }
      }
    }
  } catch {
    // 깨끗한 JSON 이 아니면(CLI 산문/토큰 등) 폴백으로 진행
  }
  // 폴백: 앞쪽 마크다운/인용/리스트 마커를 벗기고 첫 토큰 APPROVE/REVISE 를 인식.
  const normalized = candidate.replace(/^[\s*_`"'>•-]+/, '')
  // 인식된 토큰(APPROVE/REVISE)으로 시작하면 parsed=true. 그 외(빈/임의 산문)는 parsed=false
  // → 리뷰어가 유효한 verdict 를 내지 않음(accept-with-warnings 비대상).
  const recognized = /^(APPROVED?|REVISE[DS]?)\b/i.test(normalized)
  const approved = /^APPROVED?\b/i.test(normalized)
  const feedback = normalized.replace(/^(APPROVED?|REVISE[DS]?)\b[:\s]*/i, '').trim()
  return { approved, feedback, parsed: recognized }
}

/** 최종 요약/누락 점검 프롬프트 (요구사항 5: 원래 요구사항과 비교). */
export function buildSummaryPrompt(
  goal: string,
  tasks: ReadonlyArray<{ title: string; status: string; changedFiles?: readonly string[] }>,
): string {
  // 산출물(변경 파일)을 프롬프트에 직접 실어 평가한다 — reviewer 가 diff 를 프롬프트로 받는 것과 동일.
  // 요약 에이전트가 파일시스템을 재탐색하지 않게 해 cwd/샌드박스/어댑터(코덱스·제미나이·API) 차이에
  // 의존하지 않는다(#164: cwd 재탐색이 엉뚱한 디렉터리를 평가하던 원인 / #165 codex 리뷰: 어댑터 fragility).
  const lines = tasks
    .map((t) => {
      // 변경 파일은 done(승인·커밋) 작업만 권위 있다 — 실패/스킵 작업의 changedFiles 는 revert 됐을 수
      // 있어(리뷰/keep 실패 시 워크스페이스 되돌림) rolled-back 파일을 산출물로 오기재하지 않는다(#165 P2).
      const files =
        t.status === 'done' && t.changedFiles?.length
          ? ` — 변경 파일: ${t.changedFiles.join(', ')}`
          : ''
      return `- [${t.status}] ${t.title}${files}`
    })
    .join('\n')
  return [
    `프로젝트 목표:\n${goal}`,
    '',
    '수행된 작업(상태·변경 파일):',
    lines,
    '',
    '위 작업 상태와 변경 파일만을 근거로 최종 산출물이 원래 목표를 충족하는지 평가하고, 누락·미흡한 부분을 구체적으로 지적하라.',
    '파일시스템을 직접 탐색하지 말 것 — 위 목록이 권위 있는 근거다.',
  ].join('\n')
}

export const FIX_DETAIL_CAP = 2_000

/**
 * verify 실패 → 에이전트 수정 프롬프트.
 * 실패한 검증의 분석(없으면 stderr)을 실어, 워크스페이스에서 직접 수정하도록 요청한다.
 */
export function buildVerifyFixPrompt(
  goal: string,
  failures: ReadonlyArray<VerificationResult>,
): string {
  const failBlock = failures
    .map(
      (f) =>
        `- [${f.kind}] ${f.command}\n  ${(f.analysis ?? f.stderr ?? '').slice(0, FIX_DETAIL_CAP).replace(/\n/g, '\n  ')}`,
    )
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
