import { describe, expect, it } from 'vitest'
import { createSessionManager } from '../session/manager'
import type { LlmSession, SendOptions } from '../session/types'
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

/** send 시 주어진 청크를 onChunk 으로 흘리는 세션(스트리밍 코어 대역). */
function streamingSession(id: string, displayName: string, chunks: string[]): LlmSession {
  return {
    id,
    descriptor: { id, kind: 'cli', displayName, ref: id, model: '' },
    async send(_prompt, opts) {
      for (const c of chunks) opts?.onChunk?.(c)
      return chunks.join('')
    },
    async dispose() {},
  }
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

  it('onToken 을 지정하면 session.send 의 onChunk 로 연결돼 토큰 델타를 받는다', async () => {
    const { sessions, ctrl } = setup()
    sessions.add(streamingSession('s', 'S모델', ['안', '녕']))
    ctrl.postUser('hi')

    const tokens: string[] = []
    const msg = await ctrl.askLlm('s', { onToken: (d) => tokens.push(d) })

    expect(tokens).toEqual(['안', '녕']) // 델타 순차 수신
    expect(msg.content).toBe('안녕') // 최종 합산 텍스트가 영속 메시지로
  })

  it('onToken 미지정 시 send 에 onChunk 를 전달하지 않는다(버퍼링 보존)', async () => {
    const { sessions, ctrl } = setup()
    let seen: SendOptions | undefined
    const session: LlmSession = {
      id: 's',
      descriptor: { id: 's', kind: 'api', displayName: 'S', ref: 's', model: '' },
      async send(_prompt, opts) {
        seen = opts
        return 'ok'
      },
      async dispose() {},
    }
    sessions.add(session)

    await ctrl.askLlm('s')
    expect(seen?.onChunk).toBeUndefined() // 스트리밍 미요청 → 기존 동작
  })

  it('onToolStep 을 지정하면 session.send 의 onToolStep 으로 연결한다 (#10 SP3)', async () => {
    const { sessions, ctrl } = setup()
    const session: LlmSession = {
      id: 's',
      descriptor: { id: 's', kind: 'api', displayName: 'S', ref: 's', model: '' },
      async send(_prompt, opts) {
        opts?.onToolStep?.({ id: 't1', name: 'read_file', phase: 'running' })
        return 'ok'
      },
      async dispose() {},
    }
    sessions.add(session)

    const steps: string[] = []
    await ctrl.askLlm('s', { onToolStep: (s) => steps.push(`${s.name}:${s.phase}`) })
    expect(steps).toEqual(['read_file:running'])
  })

  it('opts.signal 을 session.send 로 그대로 전달한다(채팅 취소 배선)', async () => {
    const { sessions, ctrl } = setup()
    let seen: SendOptions | undefined
    const session: LlmSession = {
      id: 's',
      descriptor: { id: 's', kind: 'api', displayName: 'S', ref: 's', model: '' },
      async send(_prompt, opts) {
        seen = opts
        return 'ok'
      },
      async dispose() {},
    }
    sessions.add(session)

    const { signal } = new AbortController()
    await ctrl.askLlm('s', { signal })
    expect(seen?.signal).toBe(signal) // 하위 session.send 의 취소 신호로 전달돼야 한다
  })

  it('discuss 는 signal 을 각 발언에 전달하고 abort 시 남은 턴을 건너뛴다', async () => {
    const { sessions, ctrl } = setup()
    const seenSignals: (AbortSignal | undefined)[] = []
    const ac = new AbortController()
    const mk = (id: string): LlmSession => ({
      id,
      descriptor: { id, kind: 'api', displayName: id, ref: id, model: '' },
      async send(_prompt, opts) {
        seenSignals.push(opts?.signal)
        ac.abort() // 첫 발언 직후 취소 → 둘째 발언은 시작되지 않아야 한다
        return `${id}응답`
      },
      async dispose() {},
    })
    sessions.add(mk('a'))
    sessions.add(mk('b'))

    const out = await ctrl.discuss('주제', ['a', 'b'], 1, ac.signal)

    expect(seenSignals).toEqual([ac.signal]) // 첫 발언만 실행 + signal 전달
    expect(out).toHaveLength(1) // 둘째 발언(b)은 abort 로 건너뜀
  })

  it('discuss 는 시작 전 이미 abort 된 signal 이면 어떤 발언도 시작하지 않는다', async () => {
    const { sessions, ctrl } = setup()
    let calls = 0
    const session: LlmSession = {
      id: 'a',
      descriptor: { id: 'a', kind: 'api', displayName: 'A', ref: 'a', model: '' },
      async send() {
        calls++
        return '응답'
      },
      async dispose() {},
    }
    sessions.add(session)

    const ac = new AbortController()
    ac.abort() // 사전 취소
    const out = await ctrl.discuss('주제', ['a'], 1, ac.signal)

    expect(calls).toBe(0)
    expect(out).toHaveLength(0)
  })
})
