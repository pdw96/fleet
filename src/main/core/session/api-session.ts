import type { LlmDescriptor } from '../../../shared/types'
import type {
  ApiCallOptions,
  ApiProvider,
  ChatResult,
  ChatTurn,
  TokenUsage,
} from '../providers/types'
import { runToolLoop, ToolLoopExceededError } from '../tools/loop'
import type { ToolLoopDeps } from '../tools/types'
import { settleOrAbort } from './abort'
import type { LlmSession, SendOptions } from './types'

/**
 * 실제 토큰 데이터가 하나라도 있는지. provider buffer 경로는 API 가 usage 를 안 줘도 빈 객체
 * (모든 필드 undefined)를 만들 수 있어, 단순 존재검사로는 내용 없는 'usage' 이벤트가 샌다 —
 * 적어도 한 필드가 채워졌을 때만 집계한다('usage 없으면 미발화' 계약).
 */
function hasTokenData(usage: TokenUsage | undefined): usage is TokenUsage {
  return (
    !!usage &&
    (usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.cacheCreationInputTokens !== undefined ||
      usage.cacheReadInputTokens !== undefined)
  )
}

/**
 * ChatResult 를 레거시 string send() 계약으로 환원한다.
 * 잘림(length)·거부(content_filter)·미상 종료(other)는 **부분 텍스트가 있어도** 완전한 응답으로
 * 위장하지 않고 명확한 에러로 표면화한다 — silent truncation/refusal 방지(#7 · #190 확장:
 * 과거엔 빈-응답일 때만 표면화해 부분 텍스트가 있는 잘린/거부 응답이 조용히 통과했다).
 *
 * 인터랙티브 소비자(채팅룸)만 `allowTruncation` 으로 **순수 truncation(length)** 을 opt-out 해
 * 스트리밍으로 이미 사용자에게 노출된 부분 텍스트를 보존한다. 안전/무결성 신호인 `content_filter`
 * (거부)·`other`(미상)는 opt-out 불가 — 인터랙티브에서도 항상 표면화한다(Codex 설계 리뷰).
 */
function unwrap(provider: string, result: ChatResult, allowTruncation = false): string {
  // 콘텐츠/안전 필터 거부: 부분 텍스트가 있어도, allowTruncation 과 무관하게 항상 표면화한다
  // (부분 거부를 정상 답으로 위장하면 안전 신호가 소실된다).
  if (result.finishReason === 'content_filter') {
    throw new Error(
      `[${provider}] 응답이 콘텐츠/안전 필터로 차단되었습니다 (finish=${result.rawFinishReason ?? 'unknown'}).`,
    )
  }
  // 매핑되지 않은 종료 사유('other': Gemini MALFORMED_FUNCTION_CALL·UNEXPECTED_TOOL_CALL,
  // anthropic model_context_window_exceeded 등)는 정상 완료로 신뢰할 수 없어 표면화한다 —
  // allowTruncation 과 무관(미상 종료는 truncation 이 아니다).
  // ⚠️ 유일한 '정당한 other' = anthropic `pause_turn`(server-side tool 의 장기 턴 일시정지·재개 가능)인데,
  // Fleet 은 Anthropic server tools(web_search 등)를 전혀 전송 안 해(client-side input_schema tools 만) 현재
  // 미도달이라 throw 가 안전(Codex 적대리뷰 P2). 향후 server tools 도입 시 pause_turn 의 resume 처리를 선행할 것.
  if (result.finishReason === 'other') {
    throw new Error(
      `[${provider}] 모델이 비정상 종료했습니다 (finish=${result.rawFinishReason ?? 'unknown'}). 재시도하거나 입력/도구 정의를 조정하세요.`,
    )
  }
  // 토큰 한도 truncation(length): 기본 표면화. 단 부분 텍스트가 있는 인터랙티브 경로만 allowTruncation
  // 으로 보존한다(이미 스트리밍으로 사용자에게 노출됨). 빈-텍스트 truncation 은 보존할 부분이 없어
  // opt-out 여부와 무관하게 표면화한다(#7 유지).
  if (result.finishReason === 'length' && !(allowTruncation && result.text !== '')) {
    throw new Error(
      `[${provider}] 응답이 토큰 한도로 잘렸습니다 (finish=${result.rawFinishReason ?? 'unknown'}). max_tokens 를 늘리세요.`,
    )
  }
  // 사고(thinking)만 하고 가시 답변/도구호출이 없는 경우 — includeThoughts 응답에서 발생 가능(Gemini 가
  // thought 파트만 방출). finishReason 이 stop 이어도 무성 빈 응답이 되므로 표면화한다(#7, silent blank 방지).
  // (가시 출력 부재 전용이라 빈-텍스트 조건 유지 — 위 length/refusal/other 가 이미 걸러진 뒤 도달한다.)
  if (result.text === '' && result.toolCalls.length === 0) {
    if (result.content?.some((b) => b.type === 'thinking')) {
      throw new Error(
        `[${provider}] 모델이 사고(thinking)만 하고 가시 답변을 생성하지 않았습니다 (finish=${result.rawFinishReason ?? 'unknown'}). max_tokens 를 늘리거나 재시도하세요.`,
      )
    }
  }
  return result.text
}

/**
 * API 기반 LLM 세션. 대화 히스토리를 누적하여 멀티턴을 지원한다.
 * (요구사항 2B → 동일 오케스트레이션 계층에서 사용)
 *
 * opts.toolDeps 가 주어지고 호출 시점에 truthy 를 반환하면(워크스페이스 설정 등) provider.chat 대신
 * 도구 디스패치 루프(runToolLoop)로 처리한다. 클로저라 런타임 워크스페이스 변경을 추종한다.
 */
export function createApiSession(
  descriptor: LlmDescriptor,
  provider: ApiProvider,
  opts: {
    system?: string
    toolDeps?: () => ToolLoopDeps | undefined
    /**
     * 응답 토큰 사용량 sink(usage-accounting). 매 성공 chat 의 usage 를 흘린다 — 도구루프는
     * 전 라운드 합산값. unwrap 이 빈 응답으로 throw 하기 전에 호출해 소비 토큰을 빠짐없이 집계한다.
     * usage 가 없는 응답에선 호출하지 않는다. (엔진이 'usage' 이벤트로 소비.)
     */
    onUsage?: (usage: TokenUsage) => void
  } = {},
): LlmSession {
  const history: ChatTurn[] = []
  if (opts.system) history.push({ role: 'system', content: opts.system })
  // usage 를 sink 로 흘린다(실 토큰 데이터가 있을 때만). sink 는 순수 부수기록이라 throw 해도 주
  // 경로(성공 반환·history 커밋)를 깨면 안 되므로 격리한다 — 시끄럽게 로깅하되 전파하지 않는다.
  const emitUsage = (usage: TokenUsage | undefined): void => {
    if (!hasTokenData(usage)) return
    try {
      opts.onUsage?.(usage)
    } catch (err) {
      console.error('[fleet] onUsage sink 에서 예외 발생(집계만 무시, send 는 계속):', err)
    }
  }
  // chat 을 실행하고 usage 를 집계한다. 성공 응답은 물론, 도구 루프가 최대 반복 초과로 throw 할 때도
  // (가장 비싼 경로) 에러에 실린 누적 usage 를 집계한 뒤 재전파한다 — unwrap-throw 와 동일 원칙.
  const runChatReportingUsage = async (
    turns: ChatTurn[],
    callOpts: ApiCallOptions,
    bypassTools = false,
  ): Promise<ChatResult> => {
    try {
      const result = await runChat(turns, callOpts, bypassTools)
      emitUsage(result.usage)
      return result
    } catch (err) {
      if (err instanceof ToolLoopExceededError) emitUsage(err.usage)
      throw err
    }
  }
  // 비-fresh 누적 경로 직렬화 체인 — 같은 세션의 동시 send 가 history 를 읽기-수정-쓰기 레이스로
  // 덮어쓰지 않게 순서를 보장한다(cli-session 과 동일 패턴). fresh 경로는 history 불변이라 미적용.
  let chain: Promise<unknown> = Promise.resolve()

  // 도구 의존성이 활성이면 루프, 아니면 단발 chat. turns 는 루프가 in-place 확장(도구 왕복 턴).
  const runChat = (
    turns: ChatTurn[],
    callOpts: ApiCallOptions,
    bypassTools = false,
  ): Promise<ChatResult> => {
    const deps = bypassTools ? undefined : opts.toolDeps?.()
    return deps ? runToolLoop(provider, turns, callOpts, deps) : provider.chat(turns, callOpts)
  }

  return {
    id: descriptor.id,
    descriptor,
    async send(prompt: string, sendOpts: SendOptions = {}): Promise<string> {
      // onChunk 가 있으면 provider 의 토큰 델타를 그대로 전달(스트리밍). 호출 여부를 추적해
      // 스트리밍된 경우 끝에서 중복 방출하지 않고, 비스트리밍이면 최종 텍스트를 1회 방출한다.
      // (도구 루프 경로는 tools 동봉으로 provider 가 일반적으로 버퍼링하므로 onToken 이 대개 호출되지 않음 → 최종 1회.)
      let streamed = false
      const onToken = sendOpts.onChunk
        ? (delta: string): void => {
            streamed = true
            sendOpts.onChunk!(delta)
          }
        : undefined
      // onToolStep 은 provider 가 쓰지 않고 runToolLoop 이 도구 단계를 라이브로 흘리는 데 쓴다(SP3).
      const callOpts: ApiCallOptions = {
        signal: sendOpts.signal,
        onToken,
        onToolStep: sendOpts.onToolStep,
        responseSchema: sendOpts.responseSchema,
      }
      const emit = (reply: string): string => {
        if (sendOpts.onChunk && !streamed) sendOpts.onChunk(reply)
        return reply
      }

      if (sendOpts.fresh) {
        // 독립 1회 호출: 누적 history 를 참조하지도 변경하지도 않는다(오케스트레이터 독립성).
        const turns: ChatTurn[] = opts.system
          ? [
              { role: 'system', content: opts.system },
              { role: 'user', content: prompt },
            ]
          : [{ role: 'user', content: prompt }]
        const result = await runChatReportingUsage(turns, callOpts, sendOpts.bypassTools)
        return emit(unwrap(provider.provider, result, sendOpts.allowTruncation))
      }
      // 누적 경로: 직렬화 체인에 올려 동시 send 끼리 순서를 보장한다(앞 호출의 성공/실패와 무관하게
      // 순서만). 성공 시에만 history 에 원자적으로 커밋하므로 루프 중간 throw 가 history 를 부분 확장
      // 상태로 남기지 않는다(역할 시퀀스 오염 방지). 직렬화로 동시 호출의 read-modify-write 레이스도 제거.
      const prior = chain
      let started = false // 실제 provider 호출 진입 여부 — 이후의 abort 는 조기 거부하지 않고 provider 정착을 따른다.
      const link = (async (): Promise<string> => {
        await prior.catch(() => {})
        // 큐 대기 중 취소됐으면 실제 호출 없이 중단한다(낭비 방지·history 불변). 체인 순서는 보존되므로
        // 다음 send 는 여전히 이 링크의 정착을 기다린다(직렬화 유지). 취소 즉시성은 아래 settleOrAbort 가 담당.
        sendOpts.signal?.throwIfAborted()
        started = true
        const working: ChatTurn[] = [...history, { role: 'user', content: prompt }]
        const result = await runChatReportingUsage(working, callOpts, sendOpts.bypassTools)
        const reply = unwrap(provider.provider, result, sendOpts.allowTruncation)
        // provider 가 순서보존 content(thinking·서명된 파트 등)를 채웠으면 평문 reply 대신 그대로 history 에
        // 커밋한다 — 평문만 넣으면 다음 턴 요청에서 providerMeta(서명)가 사라져 멀티턴 왕복이 tool 루프 밖
        // (비-tool 누적 chat)에선 깨진다(Codex P2). 미설정이면 기존대로 평문(하위호환). LlmSession.send()
        // 반환값은 여전히 string(reply) — 소비자 계약 불변.
        const assistantContent =
          result.content && result.content.length > 0 ? result.content : reply
        working.push({ role: 'assistant', content: assistantContent })
        history.length = 0
        history.push(...working)
        return emit(reply)
      })()
      chain = link.catch(() => {}) // 체인은 에러로 끊기지 않게 흡수(순서만 보존)
      // 큐 대기 중에만 취소를 즉시 반영한다. 실행 시작 후의 취소는 provider 의 signal 처리(스트림 abort)를
      // 따른다 — 직렬화 링크는 위 chain 이 독립 보존한다.
      return settleOrAbort(link, sendOpts.signal, () => started)
    },
    async dispose(): Promise<void> {
      history.length = 0
    },
  }
}
