import type { LlmDescriptor } from '../../../shared/types'
import type { LlmSession } from './types'

/**
 * 등록된 LLM 세션을 연결 종류와 무관하게 통합 관리한다 (요구사항 2,4).
 * 오케스트레이터/채팅방은 이 매니저를 통해 세션을 다룬다.
 */
export interface SessionManager {
  add(session: LlmSession): void
  get(id: string): LlmSession | undefined
  list(): LlmSession[]
  descriptors(): LlmDescriptor[]
  has(id: string): boolean
  remove(id: string): Promise<void>
  disposeAll(): Promise<void>
}

export function createSessionManager(): SessionManager {
  const sessions = new Map<string, LlmSession>()

  return {
    add(session) {
      sessions.set(session.id, session)
    },
    get(id) {
      return sessions.get(id)
    },
    list() {
      return [...sessions.values()]
    },
    descriptors() {
      return [...sessions.values()].map((s) => s.descriptor)
    },
    has(id) {
      return sessions.has(id)
    },
    async remove(id) {
      const s = sessions.get(id)
      if (s) {
        await s.dispose()
        sessions.delete(id)
      }
    },
    async disposeAll() {
      await Promise.all([...sessions.values()].map((s) => s.dispose()))
      sessions.clear()
    },
  }
}
