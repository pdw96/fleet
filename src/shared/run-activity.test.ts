import { describe, expect, it } from 'vitest'

import { hasLegacyRun, type RunActivity } from './types'

/**
 * `RunActivity` 스코프 계약(#251 PR0 · 스펙 §W-10 불변식 R-1/R-2).
 *
 * 두 불변식이 **같은 스냅숏의 서로 다른 필드**를 권위로 삼는다는 것이 이 계약의 요지다:
 *   - R-1 (드레인 권위): 전 스코프 런(레거시 + bench)은 `activeProjectIds` 에 나타난다.
 *     `waitForRunDrain`(boot.ts)이 이 필드만 보므로, bench 런을 빼면 SIGTERM 시 무성 절단된다.
 *   - R-2 (레거시 스코프): 레거시 잠금은 **benchId 부재 런만** 센다. bench 런까지 세면 bench 하나가
 *     도는 동안 메인 워크스페이스 조작이 통째로 잠긴다. **현재 이 술어를 쓰는 소비자는 `workspace:set`
 *     차단 양면(IPC·WS)뿐이다** — `ProjectPanel` running 잠금은 아직 `activeProjectIds` 를 읽으며,
 *     bench 런은 P-BENCHID 가 봉쇄해 관측 차이가 0이므로 전환을 #253(UI 표면)으로 유예했다.
 *
 * **범위 정직성**: 이 파일은 `hasLegacyRun` 만 다룬다(R-2 측). R-1 측 반증력은 여기 있지 않다 —
 * 드레인이 실제로 bench 런을 기다리는지는 `waitForRunDrain` 을 **실행**하는 `boot-drain.test.ts` 의
 * «R-1» describe 가, 두 필드가 같은 집합에서 파생되는지는 `engine.test.ts` 의 `toStrictEqual` 핀이
 * 유일하게 잡는다. 여기서 리터럴 스냅숏의 두 필드를 서로 비교하면 항진명제라 어떤 구현도 죽이지 못한다
 * (자체 적대 리뷰 실측 — 초안의 «비붕괴» 블록이 그 함정이었고 삭제했다).
 */
describe('hasLegacyRun (R-2 레거시 스코프 판정)', () => {
  it('진행 중 런이 없으면 false', () => {
    expect(hasLegacyRun({ activeProjectIds: [], activeRuns: [] })).toBe(false)
  })

  it('benchId 부재 런이 있으면 true', () => {
    const a: RunActivity = { activeProjectIds: ['p1'], activeRuns: [{ projectId: 'p1' }] }
    expect(hasLegacyRun(a)).toBe(true)
  })

  // 반증력: `activeProjectIds.length > 0`(현행 판정식)으로 구현하면 이 케이스가 RED 다.
  it('bench 런만 있으면 false — bench 하나가 메인 워크스페이스 조작을 잠그지 않는다', () => {
    const a: RunActivity = {
      activeProjectIds: ['p1'],
      activeRuns: [{ projectId: 'p1', benchId: 'b1' }],
    }
    expect(hasLegacyRun(a)).toBe(false)
  })

  // 반증력: `activeRuns.length > 0` 으로 구현해도 위 케이스는 RED. 혼재는 true 여야 한다.
  it('레거시와 bench 가 혼재하면 true', () => {
    const a: RunActivity = {
      activeProjectIds: ['p1', 'p2'],
      activeRuns: [{ projectId: 'p1', benchId: 'b1' }, { projectId: 'p2' }],
    }
    expect(hasLegacyRun(a)).toBe(true)
  })

  // 와이어 왕복(JSON)은 `benchId: undefined` 키를 소멸시킨다 — 명시 undefined 와 키 부재가 같은
  // 판정을 내야 데스크톱(IPC 구조화 복제)과 웹(JSON)의 스코프 판정이 갈리지 않는다.
  it('benchId 가 명시 undefined 여도 레거시로 센다(JSON 왕복 후 키 부재와 동형)', () => {
    const a: RunActivity = {
      activeProjectIds: ['p1'],
      activeRuns: [{ projectId: 'p1', benchId: undefined }],
    }
    expect(hasLegacyRun(a)).toBe(true)
    expect(hasLegacyRun(JSON.parse(JSON.stringify(a)) as RunActivity)).toBe(true)
  })

  // 빈 문자열 benchId 는 «bench 를 지정했다»가 아니라 오염된 입력이다 — 레거시로 세면 bench 런이
  // 레거시 잠금을 유발하고, bench 로 세면 잠금이 조용히 풀린다. 후자가 더 위험하므로 레거시로 센다.
  it('benchId 가 빈 문자열이면 레거시로 센다(fail-closed)', () => {
    const a: RunActivity = {
      activeProjectIds: ['p1'],
      activeRuns: [{ projectId: 'p1', benchId: '' }],
    }
    expect(hasLegacyRun(a)).toBe(true)
  })
})
