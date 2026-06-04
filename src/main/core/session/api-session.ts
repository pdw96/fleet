import type { LlmDescriptor } from '../../../shared/types'
import type { ApiProvider, ChatTurn } from '../providers/types'
import type { LlmSession, SendOptions } from './types'

/**
 * API 기반 LLM 세션. 대화 히스토리를 누적하여 멀티턴을 지원한다.
 * (요구사항 2B → 동일 오케스트레이션 계층에서 사용)
 */
export function createApiSession(
  descriptor: LlmDescriptor,
  provider: ApiProvider,
  opts: { system?: string } = {},
): LlmSession {
  const history: ChatTurn[] = []
  if (opts.system) history.push({ role: 'system', content: opts.system })

  return {
    id: descriptor.id,
    descriptor,
    async send(prompt: string, sendOpts: SendOptions = {}): Promise<string> {
      if (sendOpts.fresh) {
        // 독립 1회 호출: 누적 history 를 참조하지도 변경하지도 않는다(오케스트레이터 독립성).
        const turns: ChatTurn[] = opts.system
          ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }]
          : [{ role: 'user', content: prompt }]
        const reply = await provider.chat(turns, { signal: sendOpts.signal })
        sendOpts.onChunk?.(reply)
        return reply
      }
      history.push({ role: 'user', content: prompt })
      const reply = await provider.chat(history, { signal: sendOpts.signal })
      history.push({ role: 'assistant', content: reply })
      sendOpts.onChunk?.(reply)
      return reply
    },
    async dispose(): Promise<void> {
      history.length = 0
    },
  }
}
