export interface ReviewVerdict {
  approved: boolean
  feedback: string
}

/** 구현 작업 프롬프트 (선택적 이전 피드백 반영, 선택적 파일 아티팩트 형식 요청). */
export function buildImplementPrompt(
  goal: string,
  taskTitle: string,
  taskDescription: string,
  feedback?: string,
  wantsArtifacts = false,
): string {
  const parts = [
    `프로젝트 목표:\n${goal}`,
    `\n담당 작업: ${taskTitle}\n${taskDescription}`,
    '\n이 작업을 수행하고 산출물을 구체적으로 제시하라.',
  ]
  if (wantsArtifacts) {
    parts.push(
      '\n파일을 생성/수정하려면 각 파일을 다음 형식의 코드펜스로 출력하라(워크스페이스 상대경로):\n```file:상대/경로.ext\n<파일 전체 내용>\n```',
    )
  }
  if (feedback && feedback.trim()) {
    parts.push(`\n이전 검토 피드백을 반드시 반영하라:\n${feedback.trim()}`)
  }
  return parts.join('\n')
}

/** 교차 리뷰 프롬프트 (다른 LLM 이 산출물을 검토). */
export function buildReviewPrompt(taskTitle: string, taskDescription: string, output: string): string {
  return [
    '다음 작업 산출물을 비판적으로 검토하라.',
    `작업: ${taskTitle}`,
    `설명: ${taskDescription}`,
    '',
    '산출물:',
    output,
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
