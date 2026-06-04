import { describe, expect, it } from 'vitest'
import { createSessionManager } from '../session/manager'
import type { LlmSession } from '../session/types'
import { createMemoryStore } from '../store/memory'
import { createChatController } from './room'

function recordingSession(
  id: string,
  displayName: string,
  reply: string,
  stateful = false,
): { session: LlmSession; prompts: string[] } {
  const prompts: string[] = []
  const session: LlmSession = {
    id,
    descriptor: { id, kind: 'api', displayName, ref: id, model: '' },
    stateful,
    async send(prompt) {
      prompts.push(prompt)
      return reply
    },
    async dispose() {},
  }
  return { session, prompts }
}

function deterministic() {
  let n = 0
  return { idGen: () => `id-${++n}`, now: () => 1000 + n }
}

function setup() {
  const store = createMemoryStore(deterministic())
  const sessions = createSessionManager()
  const room = store.createRoom({ title: '작업방' })
  const ctrl = createChatController({ store, sessions, roomId: room.id })
  return { store, sessions, ctrl }
}

describe('ChatController', () => {
  it('posts user and system messages to the persisted log', () => {
    const { ctrl } = setup()
    ctrl.postUser('안녕')
    ctrl.postSystem('규칙: 한국어')
    const h = ctrl.history()
    expect(h).toHaveLength(2)
    expect(h[0].author).toEqual({ type: 'user' })
    expect(h[1].author).toEqual({ type: 'system' })
  })

  it('asks a specific LLM, showing it the transcript, and records role', async () => {
    const { sessions, ctrl } = setup()
    const a = recordingSession('a', 'A모델', '제 의견은...')
    sessions.add(a.session)
    ctrl.postUser('이 설계 어때?')

    const msg = await ctrl.askLlm('a', { role: 'critic', instruction: '비판적으로 검토하라' })

    expect(msg.author).toEqual({ type: 'llm', llmId: 'a' })
    expect(msg.role).toBe('critic')
    expect(msg.content).toBe('제 의견은...')
    // LLM 이 받은 프롬프트에 대화 기록 + 역할 + 지시가 포함
    expect(a.prompts[0]).toContain('이 설계 어때?')
    expect(a.prompts[0]).toContain('critic')
    expect(a.prompts[0]).toContain('비판적으로 검토하라')
  })

  it('lets multiple LLMs discuss so each sees prior turns (rebuttal)', async () => {
    const { sessions, ctrl } = setup()
    const a = recordingSession('a', 'A모델', 'A의 주장')
    const b = recordingSession('b', 'B모델', 'B의 반박')
    sessions.add(a.session)
    sessions.add(b.session)

    const msgs = await ctrl.discuss('주제: 아키텍처', ['a', 'b'], 1)

    expect(msgs).toHaveLength(2)
    // B 는 A 의 발언을 본 뒤 발언한다
    expect(b.prompts[0]).toContain('A의 주장')
    expect(b.prompts[0]).toContain('주제: 아키텍처')
    // 전체 로그: 사용자 주제 + A + B
    expect(ctrl.history()).toHaveLength(3)
  })

  it('스테이트풀 세션에는 지난 자기 발언 이후의 새 메시지(델타)만 전달한다', async () => {
    const { sessions, ctrl } = setup()
    const a = recordingSession('a', 'A모델', 'A응답', true)
    sessions.add(a.session)

    ctrl.postUser('첫 질문')
    await ctrl.askLlm('a') // 첫 턴: 그 시점 전체 맥락(첫 질문 포함)
    ctrl.postUser('둘째 질문')
    await ctrl.askLlm('a') // 둘째 턴: 델타(둘째 질문)만, 첫 질문은 재전송 안 함

    expect(a.prompts[0]).toContain('첫 질문')
    expect(a.prompts[1]).toContain('둘째 질문')
    expect(a.prompts[1]).not.toContain('첫 질문')
  })

  it('throws when asking an unknown LLM', async () => {
    const { ctrl } = setup()
    await expect(ctrl.askLlm('nope')).rejects.toThrow('세션')
  })
})
