import type { LlmDescriptor } from '../../../shared/types'
import type { ApiCallOptions, ApiProvider, ChatResult, ChatTurn, TokenUsage } from '../providers/types'
import { runToolLoop } from '../tools/loop'
import type { ToolLoopDeps } from '../tools/types'
import type { LlmSession, SendOptions } from './types'

/**
 * ChatResult 를 레거시 string send() 계약으로 환원한다.
 * 텍스트도 도구호출도 없는데 콘텐츠/안전 필터(content_filter)로 차단되거나 토큰 한도(length)로
 * 잘려 빈 응답이 된 경우(과거 조용히 '' 로 흡수되던 케이스)는 명확한 에러로 표면화한다
 * — silent truncation/refusal 방지(#7). 부분 텍스트가 있는 length 응답은 그대로 통과시킨다.
 */
function unwrap(provider: string, result: ChatResult): string {
  if (result.text === '' && result.toolCalls.length === 0) {
    if (result.finishReason === 'content_filter') {
      throw new Error(`[${provider}] 응답이 콘텐츠/안전 필터로 차단되었습니다 (finish=${result.rawFinishReason ?? 'unknown'}).`)
    }
    if (result.finishReason === 'length') {
      throw new Error(`[${provider}] 응답이 토큰 한도로 잘려 빈 응답이 되었습니다 (finish=${result.rawFinishReason ?? 'unknown'}). max_tokens 를 늘리세요.`)
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
  // chat 결과의 usage 를 sink 로 흘린다(있을 때만). unwrap throw 전에 호출해야 잘린/필터된 응답의
  // 소비 토큰도 누락 없이 집계된다.
  const reportUsage = (result: ChatResult): void => {
    if (result.usage) opts.onUsage?.(result.usage)
  }
  // 비-fresh 누적 경로 직렬화 체인 — 같은 세션의 동시 send 가 history 를 읽기-수정-쓰기 레이스로
  // 덮어쓰지 않게 순서를 보장한다(cli-session 과 동일 패턴). fresh 경로는 history 불변이라 미적용.
  let chain: Promise<unknown> = Promise.resolve()

  // 도구 의존성이 활성이면 루프, 아니면 단발 chat. turns 는 루프가 in-place 확장(도구 왕복 턴).
  const runChat = (turns: ChatTurn[], callOpts: ApiCallOptions, bypassTools = false): Promise<ChatResult> => {
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
          ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }]
          : [{ role: 'user', content: prompt }]
        const result = await runChat(turns, callOpts, sendOpts.bypassTools)
        reportUsage(result)
        return emit(unwrap(provider.provider, result))
      }
      // 누적 경로: 직렬화 체인에 올려 동시 send 끼리 순서를 보장한다(앞 호출의 성공/실패와 무관하게
      // 순서만). 성공 시에만 history 에 원자적으로 커밋하므로 루프 중간 throw 가 history 를 부분 확장
      // 상태로 남기지 않는다(역할 시퀀스 오염 방지). 직렬화로 동시 호출의 read-modify-write 레이스도 제거.
      const prior = chain
      const result = (async (): Promise<string> => {
        await prior.catch(() => {})
        const working: ChatTurn[] = [...history, { role: 'user', content: prompt }]
        const result = await runChat(working, callOpts, sendOpts.bypassTools)
        reportUsage(result)
        const reply = unwrap(provider.provider, result)
        working.push({ role: 'assistant', content: reply })
        history.length = 0
        history.push(...working)
        return emit(reply)
      })()
      chain = result.catch(() => {}) // 체인은 에러로 끊기지 않게 흡수
      return result
    },
    async dispose(): Promise<void> {
      history.length = 0
    },
  }
}
