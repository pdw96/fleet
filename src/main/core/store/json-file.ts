import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemoryStore } from './memory'
import type { Store, StoreOptions, StoreState } from './types'

const EMPTY: StoreState = {
  projects: [],
  tasks: [],
  rooms: [],
  messages: [],
  events: [],
  sessions: [],
}

/**
 * 디스크 영속 저장소. 초기 로드 후 매 변경마다 JSON 스냅샷을 동기 기록한다.
 * Electron 에서는 app.getPath('userData') 하위 디렉토리를 dir 로 주입한다.
 *
 * - 원자적 기록: 임시 파일에 쓴 뒤 rename → 부분 쓰기/크래시 시 원본 파일이 보존된다.
 * - 손상 복구: 로드 시 JSON 파싱 실패하면 원본을 `.corrupt` 로 백업해 데이터 손실을 가시화한 뒤 빈 상태로 시작.
 * - 쓰기 실패(디스크 풀/권한)는 로깅 후 격리 → IPC 핸들러 전체를 중단시키지 않는다.
 *
 * ## `ApprovalGate` 를 거치지 않는 이유 (명시 예외 · AGENTS.md 「안전 우선」)
 *
 * 이 모듈은 `writeFileSync`·`renameSync` 로 파일을 덮어쓴다 — 형태만 보면 destructive 다. 그럼에도
 * 승인 게이트 밖인 근거는 **유발자**가 다르기 때문이다: 게이트의 범위는 «LLM 변이·툴 실행·프로세스
 * spawn»이고(소비자 = `engine`·`orchestrator`·`mcp/host`·`tools/loop`), 여기 쓰기를 부르는 것은
 * 에이전트가 아니라 **엔진 자신의 상태 전이**(프로젝트 추가·이벤트 append)다. 게다가 최초 로드는
 * **부팅 경로**라 승인자가 아직 존재하지 않는다.
 *
 * destructive 조작을 막는 것은 게이트가 아니라 **대상 고정**이다 — 쓰기가 닿는 경로는 주입된 `dir`
 * 아래 `fleet-store.json`(과 그 `.tmp`·`.corrupt`) 뿐이고, 호출자는 무엇을 쓸지 고를 수 없다.
 */
export function createJsonFileStore(
  dir: string,
  opts: Omit<StoreOptions, 'initial' | 'persist'> = {},
): Store {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'fleet-store.json')
  const tmp = `${file}.tmp`

  let initial: StoreState = EMPTY
  if (existsSync(file)) {
    try {
      // 결측 최상위 키를 EMPTY 기본값으로 보강(구버전 파일·부분 손상 방어).
      initial = { ...EMPTY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreState>) }
    } catch {
      // 손상 파일을 덮어쓰기 전에 백업해 원본을 보존한다(조용한 데이터 손실 방지).
      try {
        renameSync(file, `${file}.corrupt`)
      } catch {
        /* 백업 실패는 무시하고 빈 상태로 진행 */
      }
      initial = EMPTY
    }
  }

  return createMemoryStore({
    ...opts,
    initial,
    persist: (state) => {
      try {
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
        renameSync(tmp, file) // 원자적 교체
      } catch (err) {
        console.error('[fleet] 상태 영속화 실패:', err)
      }
    },
  })
}
