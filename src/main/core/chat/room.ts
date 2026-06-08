import type { AgentRole, ChatMessage, ToolStep } from '../../../shared/types'
import type { SessionManager } from '../session/manager'
import type { Store } from '../store/types'

export interface AskOptions {
  /** 이 발언에 부여할 역할 */
  role?: AgentRole
  /** 추가 지시 (예: "비판적으로 검토하라") */
  instruction?: string
  /**
   * 토큰 델타 콜백. 지정 시 session.send 의 onChunk 로 연결돼 스트리밍을 활성화한다.
   * 미지정 시 send 는 버퍼링(최종 1회) — 기존 비스트리밍 동작을 그대로 보존한다.
   */
  onToken?: (delta: string) => void
  /** 도구 단계 콜백. session.send 의 onToolStep 으로 연결돼 도구 실행 단계를 라이브로 흘린다(SP3). */
  onToolStep?: (step: ToolStep) => void
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

  const renderMessages = (messages: readonly ChatMessage[]): string =>
    messages
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

      const all = store.listMessages(roomId)
      let context: string
      let intro: string
      if (session.stateful) {
        // 스테이트풀 세션: CLI 가 자기 맥락을 보유 → 지난 자기 발언 이후의 '새 메시지'만 전달.
        // 첫 발언이면 그 시점까지의 전체 기록을 한 번 제공해 맥락을 심는다.
        let lastOwn = -1
        for (let i = 0; i < all.length; i++) {
          const a = all[i].author
          if (a.type === 'llm' && a.llmId === llmId) lastOwn = i
        }
        context = renderMessages(all.slice(lastOwn + 1)) || '(새 발언 없음)'
        intro =
          lastOwn >= 0
            ? '다음은 당신의 지난 발언 이후 추가된 새 메시지다. 이어서 토론/반박/검증에 참여하라.'
            : '다음은 작업방의 대화 기록이다. 다른 참여자의 의견을 검토하고 토론/반박/검증에 참여하라.'
      } else {
        context = renderMessages(all) || '(아직 발언 없음)'
        intro = '다음은 작업방의 대화 기록이다. 다른 참여자의 의견을 검토하고 토론/반박/검증에 참여하라.'
      }

      const roleLine = opts.role ? `당신의 역할: ${opts.role}\n` : ''
      const instruction = opts.instruction ? `${opts.instruction}\n` : ''
      const prompt =
        `${roleLine}${intro}\n\n` +
        `${context}\n\n` +
        `${instruction}당신(${session.descriptor.displayName})의 다음 발언:`

      // onToken 이 있으면 onChunk 로 연결돼 스트리밍 활성화(없으면 onChunk=undefined → 버퍼링).
      // onToolStep 은 API 세션 도구 루프의 라이브 도구 단계 싱크로 연결된다(CLI 세션은 무시).
      const reply = await session.send(prompt, { onChunk: opts.onToken, onToolStep: opts.onToolStep })
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
