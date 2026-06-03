import type { AgentRole, ChatMessage } from '../../../shared/types'
import type { SessionManager } from '../session/manager'
import type { Store } from '../store/types'

export interface AskOptions {
  /** 이 발언에 부여할 역할 */
  role?: AgentRole
  /** 추가 지시 (예: "비판적으로 검토하라") */
  instruction?: string
}

/**
 * 멀티 LLM 라이브 채팅방 컨트롤러 (요구사항 3).
 * 여러 LLM 이 하나의 방에서 서로의 발언(대화 기록)을 보고 토론/반박/검증하며,
 * 사용자가 개입하거나 특정 LLM 을 지목하고 역할을 부여할 수 있다.
 * 모든 메시지는 store 에 영속되어 저장·재로딩된다.
 */
export interface ChatController {
  readonly roomId: string
  postUser(content: string): ChatMessage
  postSystem(content: string): ChatMessage
  /** 특정 LLM 을 지목해 대화 기록을 보여주고 다음 발언을 받는다. */
  askLlm(llmId: string, opts?: AskOptions): Promise<ChatMessage>
  /** 여러 LLM 이 주제에 대해 rounds 회 순차 토론. */
  discuss(topic: string, llmIds: readonly string[], rounds?: number): Promise<ChatMessage[]>
  history(): ChatMessage[]
}

export interface ChatControllerDeps {
  store: Store
  sessions: SessionManager
  roomId: string
}

export function createChatController(deps: ChatControllerDeps): ChatController {
  const { store, sessions, roomId } = deps

  const nameFor = (llmId: string): string => sessions.get(llmId)?.descriptor.displayName ?? llmId

  const renderTranscript = (): string =>
    store
      .listMessages(roomId)
      .map((m) => {
        const who =
          m.author.type === 'user' ? '사용자' : m.author.type === 'system' ? '시스템' : nameFor(m.author.llmId)
        return `${who}: ${m.content}`
      })
      .join('\n')

  const controller: ChatController = {
    roomId,

    postUser(content) {
      return store.appendMessage({ roomId, author: { type: 'user' }, content })
    },

    postSystem(content) {
      return store.appendMessage({ roomId, author: { type: 'system' }, content })
    },

    async askLlm(llmId, opts = {}) {
      const session = sessions.get(llmId)
      if (!session) throw new Error(`세션을 찾을 수 없습니다: ${llmId}`)

      const transcript = renderTranscript()
      const roleLine = opts.role ? `당신의 역할: ${opts.role}\n` : ''
      const instruction = opts.instruction ? `${opts.instruction}\n` : ''
      const prompt =
        `${roleLine}다음은 작업방의 대화 기록이다. 다른 참여자의 의견을 검토하고 토론/반박/검증에 참여하라.\n\n` +
        `${transcript || '(아직 발언 없음)'}\n\n` +
        `${instruction}당신(${session.descriptor.displayName})의 다음 발언:`

      const reply = await session.send(prompt)
      return store.appendMessage({ roomId, author: { type: 'llm', llmId }, role: opts.role, content: reply })
    },

    async discuss(topic, llmIds, rounds = 1) {
      controller.postUser(topic)
      const out: ChatMessage[] = []
      for (let r = 0; r < rounds; r++) {
        for (const id of llmIds) {
          out.push(await controller.askLlm(id))
        }
      }
      return out
    },

    history() {
      return store.listMessages(roomId)
    },
  }

  return controller
}
