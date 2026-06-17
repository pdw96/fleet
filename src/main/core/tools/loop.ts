import type {
  ApiCallOptions,
  ApiProvider,
  ChatResult,
  ChatTurn,
  ContentBlock,
  TokenUsage,
  ToolResultBlock,
} from '../providers/types'
import type { ToolLoopDeps } from './types'
import { DEFAULT_CONTEXT_POLICY, freshToolResultBatchSize, pruneToolResults } from './context'

const DEFAULT_MAX_ITERATIONS = 8

const NOOP_AUDIT = (): void => {}

/**
 * 도구 루프가 최대 반복을 초과해도 여전히 도구 호출을 요청할 때 던진다. 그때까지 누적한 usage 를
 * 실어 호출자(api-session)가 unwrap-throw 와 동일하게 소비 토큰을 집계할 수 있게 한다 — 최대
 * 반복 경로는 가장 비싼 경로라 미집계 시 실 지출의 최대 누락이 된다(usage-accounting).
 */
export class ToolLoopExceededError extends Error {
  constructor(
    max: number,
    readonly usage: TokenUsage | undefined,
  ) {
    super(`도구 루프가 최대 ${max}회 반복을 초과했습니다(모델이 여전히 도구 호출을 요청).`)
    this.name = 'ToolLoopExceededError'
  }
}

/**
 * 두 TokenUsage 를 필드별로 합산한다(usage-accounting). 한쪽만 있으면 있는 값만,
 * 양쪽 다 미설정인 필드는 결과에서도 생략한다 → 전 구간 usage 가 없으면 결과도 undefined
 * (무회귀). 도구루프가 매 iter 의 비용을 누적하는 데 쓴다.
 */
function addUsage(
  acc: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return acc
  if (!acc) return { ...next }
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  const merged: TokenUsage = {}
  const input = sum(acc.inputTokens, next.inputTokens)
  if (input !== undefined) merged.inputTokens = input
  const output = sum(acc.outputTokens, next.outputTokens)
  if (output !== undefined) merged.outputTokens = output
  const cacheCreation = sum(acc.cacheCreationInputTokens, next.cacheCreationInputTokens)
  if (cacheCreation !== undefined) merged.cacheCreationInputTokens = cacheCreation
  const cacheRead = sum(acc.cacheReadInputTokens, next.cacheReadInputTokens)
  if (cacheRead !== undefined) merged.cacheReadInputTokens = cacheRead
  return merged
}

/** 도구 입력을 승인 요청에 보여줄 짧은 문자열로 요약한다(안전 절단, 최대 200자). */
function previewInput(input: unknown): string {
  if (input == null) return ''
  let s: string
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    return ''
  }
  if (!s || s === '{}') return ''
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

/** 도구 단계 요지를 짧게 절단한다(라이브 UI 용, 최대 200자). */
function shortText(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

/**
 * provider.chat 를 도구 호출이 끝날 때까지 반복한다. turns 를 in-place 로 확장
 * (assistant tool_use + user tool_result)하고 최종 ChatResult 를 반환한다.
 * 최대 반복을 넘겨도 여전히 tool_use 면 미완성 응답을 성공으로 위장하지 않고 throw 한다(#7).
 * 도구 목록(registry.list())은 루프 시작 시 1회 스냅샷한다 — 한 send 동안 도구 집합은 불변이다.
 * 참고: tools 동봉 요청도 onToken 이 있으면 SSE 스트리밍하므로(SP3) 도구 루프 중에도 텍스트 델타가
 * onToken 으로 라이브로 흐른다. 도구 실행 단계는 opts.onToolStep(running→ok/error)으로 방출한다.
 */
export async function runToolLoop(
  provider: ApiProvider,
  turns: ChatTurn[],
  opts: ApiCallOptions,
  deps: ToolLoopDeps,
): Promise<ChatResult> {
  const max = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const audit = deps.onAudit ?? NOOP_AUDIT
  const onToolStep = opts.onToolStep
  const tools = deps.registry.list()
  // context management 정책: undefined → 기본(default-on), null → 비활성.
  const policy = deps.contextPolicy === undefined ? DEFAULT_CONTEXT_POLICY : deps.contextPolicy
  // 도구 정의는 매 요청에 동봉돼 입력 토큰을 차지한다(큰 MCP 스키마). client prune 트리거 판단이 이를
  // 빠뜨리면 turns 는 임계 이하인데 turns+tools 가 윈도를 넘겨 prune 미발화·초과할 수 있다 → 예산에 포함(Codex P2).
  // 도구 집합은 send 동안 불변이라 1회만 추정한다. stringify 실패는 0 으로(blockChars 와 대칭, 추정 보수화).
  let toolsTokens = 0
  if (tools.length > 0) {
    try {
      toolsTokens = Math.ceil(JSON.stringify(tools).length / 4)
    } catch {
      toolsTokens = 0
    }
  }
  // 매 iter 의 비용을 누적한다 — 도구 왕복(최대 max 라운드)의 chat 호출이 각각 토큰을 소모하므로
  // 마지막 응답만 반환하면 이전 라운드 비용이 통째로 누락된다(usage-accounting).
  let usageAcc: TokenUsage | undefined

  for (let iter = 0; iter < max; iter++) {
    // provider 분기 없이 capability 플래그만 본다: native(anthropic)는 wire 위임, 그 외는 client-side
    // 가지치기. 둘 다 chat 직전에 적용해 매 라운드 누적을 경계한다. loop 가 contextManagement 소유권을
    // 가진다(caller opts 값은 무시) — native 는 서버가 context 를 직접 관리하므로 local turns 가 무제한
    // 성장하는 게 정상(의도된 설계)이고, client 경로만 turns 를 가지치기한다.
    const chatOpts: ApiCallOptions = { ...opts, tools, toolChoice: 'auto' }
    delete chatOpts.contextManagement // loop 가 소유 — caller 가 실어보낸 값은 쓰지 않는다(누출 차단)
    if (policy) {
      if (provider.nativeContextManagement) {
        // server clear_tool_uses 는 "가장 최근 keep 개 tool_use"를 유지한다(블록 단위·턴 경계 무시 — 1차출처).
        // client 가지치기는 미전송 fresh 배치 전체 + 그 앞 keepRecentToolUses 개를 보존하므로, native 도 동일
        // 보존을 위해 keep 을 fresh + policy.keep 으로 올린다(요청 한정) — fresh 배치가 모델 전송 전 클립되는
        // 것 방지 + 직전 kept 결과 패리티(max 면 fresh>keep 일 때 직전 kept 를 잃음, Codex P2). fresh=0(새 send)
        // 이면 keep=policy.keep 그대로다.
        const fresh = freshToolResultBatchSize(turns)
        chatOpts.contextManagement = {
          ...policy,
          keepRecentToolUses: fresh + policy.keepRecentToolUses,
        }
      } else pruneToolResults(turns, policy, toolsTokens)
    }
    const result = await provider.chat(turns, chatOpts)
    usageAcc = addUsage(usageAcc, result.usage)
    // 종료는 finishReason 가 아니라 toolCalls 유무로 판단한다 — Gemini 는 functionCall 응답에도
    // finishReason 를 'stop'(STOP)으로 주므로 finishReason 게이팅은 Gemini 도구호출을 통째로 건너뛴다.
    if (result.toolCalls.length === 0) return { ...result, usage: usageAcc }

    // 어시스턴트 턴 재구성: provider 가 ordered content(순서·서명)를 보존했으면 그대로 사용하고
    // (thinking→text→tool_use 순서·providerMeta 유지), 아니면 (텍스트 있으면) + tool_use 로 재구성한다.
    let assistant: ContentBlock[]
    if (result.content && result.content.length > 0) {
      assistant = result.content
    } else {
      assistant = []
      if (result.text) assistant.push({ type: 'text', text: result.text })
      assistant.push(...result.toolCalls) // ToolUseBlock.providerMeta 는 스프레드로 자동 보존
    }
    turns.push({ role: 'assistant', content: assistant })

    const results: ToolResultBlock[] = []
    for (const [i, call] of result.toolCalls.entries()) {
      // 칩 식별자(표시 전용): tool_use id, 없으면 `도구명-인덱스`. 한 단계의 running→ok/error 가 같은
      // id 로 갱신된다. 인덱스를 섞어 빈 id(Gemini 2.x) 병렬 동일함수 호출의 칩 충돌을 막는다(#17-P2).
      // 이는 칩 상관 전용 — wire 회신(tool_result.toolUseId)에는 여전히 call.id(빈 값)를 써서 합성
      // id 를 provider 로 보내지 않는다.
      const stepId = call.id || `${call.name}-${i}`
      const tool = deps.registry.get(call.name)
      if (!tool) {
        // 미존재 도구 — 게이트 통과 없이 즉시 에러 회신
        audit('tool.failed', { name: call.name, reason: 'unknown' })
        onToolStep?.({ id: stepId, name: call.name, phase: 'error', summary: '알 수 없는 도구' })
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          name: call.name,
          content: `알 수 없는 도구: ${call.name}`,
          isError: true,
        })
        continue
      }

      const risk = tool.classify(call.input)
      audit('tool.requested', { name: call.name, risk })
      const argPreview = previewInput(call.input)
      const decision = await deps.gate.request({
        kind: 'tool-call',
        summary: argPreview ? `도구 호출: ${call.name} ${argPreview}` : `도구 호출: ${call.name}`,
        target: argPreview || call.name,
        risk,
      })
      if (decision !== 'approved') {
        audit('tool.failed', { name: call.name, reason: 'rejected' })
        onToolStep?.({ id: stepId, name: call.name, phase: 'error', summary: '승인 거부됨' })
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          name: call.name,
          content: `승인 거부됨: ${call.name}`,
          isError: true,
        })
        continue
      }

      // 승인 후 실행 직전 running 칩을 띄운다(인자 요약 포함).
      onToolStep?.({
        id: stepId,
        name: call.name,
        phase: 'running',
        risk,
        summary: argPreview || undefined,
      })
      try {
        const content = await tool.execute(call.input, { signal: opts.signal })
        audit('tool.executed', { name: call.name })
        onToolStep?.({ id: stepId, name: call.name, phase: 'ok' })
        results.push({ type: 'tool_result', toolUseId: call.id, name: call.name, content })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        audit('tool.failed', { name: call.name, reason: message })
        onToolStep?.({ id: stepId, name: call.name, phase: 'error', summary: shortText(message) })
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          name: call.name,
          content: message,
          isError: true,
        })
      }
    }
    turns.push({ role: 'user', content: results })
  }

  // 가장 비싼 경로 — 그때까지 누적한 usage 를 에러에 실어 호출자가 집계하게 한다(미집계 방지).
  throw new ToolLoopExceededError(max, usageAcc)
}
