import type { ChatTurn, ContentBlock, ContextManagementPolicy, ToolResultBlock } from '../providers/types'

/**
 * default-on 도구루프 context management 기본 정책(보수값). engine 미지정 시 loop 가 적용.
 * 트리거 100k: 비-native 메인스트림 윈도(gpt-4o·gpt-4o-mini 128k 등) 아래로 잡아 client-side prune 이
 * 컨텍스트 초과 에러 전에 발화하게 한다(150k 면 128k 모델이 prune 전에 초과 — Codex P2). 더 작은
 * 윈도(로컬·openai-compatible)나 dense 토큰 모델은 ToolLoopDeps.contextPolicy 로 하향 필요. 모델-인지
 * 임계(윈도 조회)는 #13(capability API) 후속. native(anthropic)는 서버 실측 토큰을 쓰므로 100k 가 정밀.
 */
export const DEFAULT_CONTEXT_POLICY: ContextManagementPolicy = {
  triggerInputTokens: 100_000,
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
 * 미전송 fresh tool_result 배치의 크기. **마지막 턴**이 tool_result 턴이면 = 직전 도구루프 iter 가 방금
 * 추가했고 아직 모델에 전송되지 않은 배치이므로 그 결과 수를 반환한다. 마지막 턴이 user 프롬프트·assistant
 * (새 send 시작·응답 후)면 직전 tool_result 는 이미 전송된 과거 것이라 0 을 반환한다(=fresh 아님).
 * client 가지치기는 이 배치를 정리에서 제외하고, native 는 keep 을 이 크기 이상으로 올려 server clear 가
 * 모델이 보기 전 fresh 배치를 클립하지 못하게 한다(Codex P2). "마지막 *턴*" 한정이 핵심 — 라운드1 의
 * "마지막 tool_result 턴 무조건 제외" 는 새 send 의 *이미 전송된* 과거 배치까지 보호해 prune 불능이 되던
 * 걸 정밀화한다(api-session history 는 항상 assistant 턴으로 끝나 새 send 첫 prune 엔 마지막 턴=user → fresh 0).
 */
export function freshToolResultBatchSize(turns: ChatTurn[]): number {
  const last = turns[turns.length - 1]
  if (!last || typeof last.content === 'string') return 0
  let n = 0
  for (const b of last.content) if (b.type === 'tool_result') n++
  return n
}

/**
 * client-side context management(native 미지원 provider 용). 추정 입력토큰이 trigger 를 넘으면
 * 오래된 tool_result 의 content 를 PRUNE_STUB 으로 치환한다 — **블록 제거가 아니라 content 축약**이라
 * tool_use↔tool_result 페어링·블록 순서·thinking 서명이 불변(3사 wire 유효성 보존).
 *
 * 두 보존 규칙: ① **미전송 fresh 배치**(마지막 턴이 tool_result 턴일 때만 — 직전 iter 가 추가, 다음 chat
 * 에서 처음 전송)는 통째로 보존한다 — 한 어시스턴트 턴이 keep 보다 많은 병렬 도구를 호출하면 그 배치의
 * 일부가 모델이 보기 전에 stub 돼 명시 요청한 출력 없이 답하게 되는 걸 막는다(Codex P2). 새 send 의 이미
 * 전송된 과거 배치는 마지막 턴이 아니므로(뒤에 user 프롬프트가 옴) 제외하지 않는다. ② 그 앞(이미 전송된)
 * 결과 중 최근 keepRecentToolUses 개는 보존한다.
 *
 * **copy-on-write**: stub 시 공유된 history 블록을 직접 변이하지 않고 턴·content 배열·블록을 클론해
 * turns 슬롯에만 반영한다 — api-session 의 `working=[...history]` 는 블록 객체를 공유하므로 in-place
 * 변이는 미커밋 send(throw)에도 history 를 손상시킨다(원자 커밋 위반, Codex P2). 클론이면 성공 시
 * 커밋(history=working)으로 pruned 상태가 영속되고 실패 시 history 는 무손상이다. 이미 stub 은 건너뛴다(idempotent).
 *
 * 의도된 비범위(native clear_tool_uses 시맨틱과 동일): keep/미전송 보존 윈도 안의 단일 거대 tool_result
 * 와 비-tool_result content(text·thinking·user 입력)는 정리하지 않는다 → 그 경우 turns 가 예산 위로 남을
 * 수 있다. 이 슬라이스의 범위는 누적되는 오래된 tool_result 경계다.
 *
 * `overheadTokens`: 매 요청에 동봉되는 turns 외 입력(도구 정의 등)의 추정 토큰. 트리거 판단을 실제 요청
 * 크기(turns + overhead)로 해 큰 MCP 스키마가 단독으로 윈도를 채우는데 prune 이 안 도는 갭을 막는다(Codex P2).
 */
export function pruneToolResults(
  turns: ChatTurn[],
  policy: ContextManagementPolicy,
  overheadTokens = 0,
): void {
  if (approxTokens(turns) + overheadTokens <= policy.triggerInputTokens) return
  // 미전송 fresh 배치(마지막 턴이 tool_result 일 때만)는 제외하고, 이미 모델이 본 결과만 (turnIndex, blockIndex)로 수집.
  const excludeIdx = freshToolResultBatchSize(turns) > 0 ? turns.length - 1 : -1
  const slots: Array<[number, number]> = []
  for (let i = 0; i < turns.length; i++) {
    if (i === excludeIdx) continue
    const c = turns[i].content
    if (typeof c === 'string') continue
    for (let j = 0; j < c.length; j++) if (c[j].type === 'tool_result') slots.push([i, j])
  }
  // 최근 keep 개는 보존 → 그 앞(오래된)만 정리 대상.
  const prunable = slots.slice(0, Math.max(0, slots.length - policy.keepRecentToolUses))
  for (const [i, j] of prunable) {
    const content = turns[i].content as ContentBlock[]
    const block = content[j] as ToolResultBlock
    if (block.content === PRUNE_STUB) continue // idempotent
    // 이미 stub 길이 이하면 치환이 외려 프롬프트를 키운다 → 건너뛴다(Codex P2). 작은 결과는 정리 이득 0.
    if (block.content.length <= PRUNE_STUB.length) continue
    // copy-on-write: 원본(공유) 객체를 변이하지 않도록 턴·content·블록을 클론해 turns 슬롯만 교체한다.
    const newBlock: ToolResultBlock = { ...block, content: PRUNE_STUB }
    delete newBlock.isError // stale 한 에러 표식 제거
    const newContent = [...content]
    newContent[j] = newBlock
    turns[i] = { ...turns[i], content: newContent }
    // 한 건 정리할 때마다 재추정한다(현 컨텍스트 크기에선 무시 가능 — 매우 큰 도구 이력이면 delta 추적 최적화 여지).
    if (approxTokens(turns) + overheadTokens <= policy.triggerInputTokens) return
  }
}
