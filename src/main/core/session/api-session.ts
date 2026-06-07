import type { LlmDescriptor } from '../../../shared/types'
import type { ApiCallOptions, ApiProvider, ChatResult, ChatTurn } from '../providers/types'
import { runToolLoop } from '../tools/loop'
import type { ToolLoopDeps } from '../tools/types'
import type { LlmSession, SendOptions } from './types'

/**
 * ChatResult 를 레거시 string send() 계약으로 환원한다.
 * 텍스트도 도구호출도 없는데 콘텐츠/안전 필터로 차단된 경우(과거 조용히 '' 로 흡수되던 케이스)는
 * 명확한 에러로 표면화한다 — silent truncation/refusal 방지(#7).
 */
function unwrap(provider: string, result: ChatResult): string {
  if (result.text === '' && result.toolCalls.length === 0 && result.finishReason === 'content_filter') {
    throw new Error(`[${provider}] 응답이 콘텐츠/안전 필터로 차단되었습니다 (finish=${result.rawFinishReason ?? 'unknown'}).`)
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
  opts: { system?: string; toolDeps?: () => ToolLoopDeps | undefined } = {},
): LlmSession {
  const history: ChatTurn[] = []
  if (opts.system) history.push({ role: 'system', content: opts.system })

  // 도구 의존성이 활성이면 루프, 아니면 단발 chat. turns 는 루프가 in-place 확장(도구 왕복 턴).
  const runChat = (turns: ChatTurn[], callOpts: ApiCallOptions): Promise<ChatResult> => {
    const deps = opts.toolDeps?.()
    return deps ? runToolLoop(provider, turns, callOpts, deps) : provider.chat(turns, callOpts)
  }

  return {
    id: descriptor.id,
    descriptor,
    async send(prompt: string, sendOpts: SendOptions = {}): Promise<string> {
      // onChunk 가 있으면 provider 의 토큰 델타를 그대로 전달(스트리밍). 호출 여부를 추적해
      // 스트리밍된 경우 끝에서 중복 방출하지 않고, 비스트리밍이면 최종 텍스트를 1회 방출한다.
      // (도구 루프 경로는 tools 동봉으로 provider 가 버퍼링하므로 onToken 이 호출되지 않음 → 최종 1회.)
      let streamed = false
      const onToken = sendOpts.onChunk
        ? (delta: string): void => {
            streamed = true
            sendOpts.onChunk!(delta)
          }
        : undefined
      const callOpts: ApiCallOptions = { signal: sendOpts.signal, onToken }
      const emit = (reply: string): string => {
        if (sendOpts.onChunk && !streamed) sendOpts.onChunk(reply)
        return reply
      }

      if (sendOpts.fresh) {
        // 독립 1회 호출: 누적 history 를 참조하지도 변경하지도 않는다(오케스트레이터 독립성).
        const turns: ChatTurn[] = opts.system
          ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }]
          : [{ role: 'user', content: prompt }]
        return emit(unwrap(provider.provider, await runChat(turns, callOpts)))
      }
      history.push({ role: 'user', content: prompt })
      const reply = unwrap(provider.provider, await runChat(history, callOpts))
      history.push({ role: 'assistant', content: reply })
      return emit(reply)
    },
    async dispose(): Promise<void> {
      history.length = 0
    },
  }
}
