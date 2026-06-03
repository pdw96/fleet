import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemoryStore } from './memory'
import type { Store, StoreOptions, StoreState } from './types'

const EMPTY: StoreState = { projects: [], tasks: [], rooms: [], messages: [], events: [] }

/**
 * 디스크 영속 저장소. 초기 로드 후 매 변경마다 JSON 스냅샷을 동기 기록한다.
 * Electron 에서는 app.getPath('userData') 하위 디렉토리를 dir 로 주입한다.
 */
export function createJsonFileStore(dir: string, opts: Omit<StoreOptions, 'initial' | 'persist'> = {}): Store {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'fleet-store.json')

  let initial: StoreState = EMPTY
  if (existsSync(file)) {
    try {
      initial = JSON.parse(readFileSync(file, 'utf8')) as StoreState
    } catch {
      initial = EMPTY
    }
  }

  return createMemoryStore({
    ...opts,
    initial,
    persist: (state) => writeFileSync(file, JSON.stringify(state, null, 2), 'utf8'),
  })
}
