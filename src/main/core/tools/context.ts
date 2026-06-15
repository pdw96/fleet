import type { ChatTurn, ContentBlock, ContextManagementPolicy, ToolResultBlock } from '../providers/types'

/** default-on 도구루프 context management 기본 정책(보수값). engine 미지정 시 loop 가 적용. */
export const DEFAULT_CONTEXT_POLICY: ContextManagementPolicy = {
  triggerInputTokens: 150_000,
  keepRecentToolUses: 3,
}

/** 정리된 tool_result content 를 대체하는 표식(idempotent 검사에도 쓰임). */
export const PRUNE_STUB = '[이전 도구 결과 정리됨 — 컨텍스트 관리]'

/** 블록 1개의 대략 문자수(추정 토큰의 입력). 미지 variant 는 0(안전). */
function blockChars(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return b.text.length
    case 'tool_result':
      return b.content.length
    case 'tool_use':
      try {
        return JSON.stringify(b.input ?? {}).length
      } catch {
        return 0
      }
    case 'thinking':
      return b.text.length
    case 'image':
      return b.data.length
    default:
      return 0
  }
}

/**
 * turns 전체의 대략 입력 토큰을 추정한다(정밀 토크나이저 없음 → chars/4). 코드/JSON 은 실토큰이 더
 * 빽빽해 이 추정이 낮게 나오므로 트리거가 늦게(보수적으로) 발화한다 — 안전 방향.
 */
export function approxTokens(turns: ChatTurn[]): number {
  let chars = 0
  for (const t of turns) {
    if (typeof t.content === 'string') chars += t.content.length
    else for (const b of t.content) chars += blockChars(b)
  }
  return Math.ceil(chars / 4)
}

/**
 * client-side context management(native 미지원 provider 용). 추정 입력토큰이 trigger 를 넘으면
 * 오래된 tool_result 의 content 를 PRUNE_STUB 으로 치환한다 — **블록 제거가 아니라 content 축약**이라
 * tool_use↔tool_result 페어링·블록 순서·thinking 서명이 불변(3사 wire 유효성 보존). 최근
 * keepRecentToolUses 개는 보존한다. turns 를 in-place 변이한다(history 영속 → send 간 누적 경계).
 * 이미 stub 인 것은 건너뛴다(idempotent).
 */
export function pruneToolResults(turns: ChatTurn[], policy: ContextManagementPolicy): void {
  if (approxTokens(turns) <= policy.triggerInputTokens) return
  const results: ToolResultBlock[] = []
  for (const t of turns) {
    if (typeof t.content === 'string') continue
    for (const b of t.content) if (b.type === 'tool_result') results.push(b)
  }
  // 최근 keep 개는 보존 → 그 앞(오래된)만 정리 대상.
  const prunable = results.slice(0, Math.max(0, results.length - policy.keepRecentToolUses))
  for (const r of prunable) {
    if (r.content === PRUNE_STUB) continue // idempotent
    r.content = PRUNE_STUB
    delete r.isError // stale 한 에러 표식 제거
    if (approxTokens(turns) <= policy.triggerInputTokens) return
  }
}
