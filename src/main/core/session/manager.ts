import type { AgentRole, LlmDescriptor } from '../../../shared/types'
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
  /** 세션의 적합 역할을 갱신한다(라이브 descriptor 제자리 변경). 없으면 undefined. */
  setCapabilities(id: string, roles: readonly AgentRole[]): LlmDescriptor | undefined
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
    setCapabilities(id, roles) {
      const s = sessions.get(id)
      if (!s) return undefined
      // descriptor 객체를 제자리 변경한다(교체 금지) — descriptors()/listSessions 가 같은 참조를 돌려주므로 렌더러까지 반영된다.
      s.descriptor.capabilities = [...roles]
      return s.descriptor
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
