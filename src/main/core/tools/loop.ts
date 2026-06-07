import type {
  ApiCallOptions,
  ApiProvider,
  ChatResult,
  ChatTurn,
  ContentBlock,
  ToolResultBlock,
} from '../providers/types'
import type { ToolLoopDeps } from './types'

const DEFAULT_MAX_ITERATIONS = 8

const NOOP_AUDIT = (): void => {}

/**
 * provider.chat 를 도구 호출이 끝날 때까지 반복한다. turns 를 in-place 로 확장
 * (assistant tool_use + user tool_result)하고 최종 ChatResult 를 반환한다.
 * 최대 반복을 넘겨도 여전히 tool_use 면 미완성 응답을 성공으로 위장하지 않고 throw 한다(#7).
 * 도구 목록(registry.list())은 루프 시작 시 1회 스냅샷한다 — 한 send 동안 도구 집합은 불변이다.
 * 주의: tools 동봉 요청은 대부분 provider 가 버퍼링(비스트리밍)하므로 opts.onToken 은 도구 루프
 * 중에는 호출되지 않을 수 있다(최종 비-tool_use 응답에서만 흐를 수 있음).
 */
export async function runToolLoop(
  provider: ApiProvider,
  turns: ChatTurn[],
  opts: ApiCallOptions,
  deps: ToolLoopDeps,
): Promise<ChatResult> {
  const max = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const audit = deps.onAudit ?? NOOP_AUDIT
  const tools = deps.registry.list()

  for (let iter = 0; iter < max; iter++) {
    const result = await provider.chat(turns, { ...opts, tools, toolChoice: 'auto' })
    if (result.finishReason !== 'tool_use' || result.toolCalls.length === 0) return result

    // 어시스턴트 턴 재구성: (텍스트 있으면) + tool_use 블록들.
    const assistant: ContentBlock[] = []
    if (result.text) assistant.push({ type: 'text', text: result.text })
    assistant.push(...result.toolCalls)
    turns.push({ role: 'assistant', content: assistant })

    const results: ToolResultBlock[] = []
    for (const call of result.toolCalls) {
      const tool = deps.registry.get(call.name)
      if (!tool) {
        // 미존재 도구 — 게이트 통과 없이 즉시 에러 회신
        audit('tool.failed', { name: call.name, reason: 'unknown' })
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

      const decision = await deps.gate.request({
        kind: 'tool-call',
        summary: `도구 호출: ${call.name}`,
        target: call.name,
        risk,
      })
      if (decision !== 'approved') {
        audit('tool.failed', { name: call.name, reason: 'rejected' })
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          name: call.name,
          content: `승인 거부됨: ${call.name}`,
          isError: true,
        })
        continue
      }

      try {
        const content = await tool.execute(call.input, { signal: opts.signal })
        audit('tool.executed', { name: call.name })
        results.push({ type: 'tool_result', toolUseId: call.id, name: call.name, content })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        audit('tool.failed', { name: call.name, reason: message })
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

  throw new Error(
    `도구 루프가 최대 ${max}회 반복을 초과했습니다(모델이 여전히 도구 호출을 요청).`,
  )
}
