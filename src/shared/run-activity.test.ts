import { describe, expect, it } from 'vitest'

import { hasLegacyRun, type RunActivity } from './types'

/**
 * `RunActivity` 스코프 계약(#251 PR0 · 스펙 §W-10 불변식 R-1/R-2).
 *
 * 두 불변식이 **같은 스냅숏의 서로 다른 필드**를 권위로 삼는다는 것이 이 계약의 요지다:
 *   - R-1 (드레인 권위): 전 스코프 런(레거시 + bench)은 `activeProjectIds` 에 나타난다.
 *     `waitForRunDrain`(boot.ts)이 이 필드만 보므로, bench 런을 빼면 SIGTERM 시 무성 절단된다.
 *   - R-2 (레거시 스코프): `workspace:set` 차단·`ProjectPanel` running 잠금은 **benchId 부재 런만** 센다.
 *     bench 런까지 세면 bench 하나가 도는 동안 메인 워크스페이스 조작이 통째로 잠긴다.
 *
 * 두 불변식이 한 필드로 붕괴하지 않음을 아래 «비붕괴» 케이스가 고정한다 — 이것이 이 파일의 존재 이유다.
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

describe('R-1 · R-2 비붕괴 (드레인 권위 ≠ 레거시 잠금)', () => {
  /**
   * bench 런만 도는 스냅숏에서 두 판정이 **반대 방향**이어야 한다.
   * 하나라도 다른 필드로 구현하면(예: hasLegacyRun 이 activeProjectIds 를 보거나, 드레인이 activeRuns
   * 의 레거시분만 보면) 이 단언 쌍 중 하나가 반드시 RED 다.
   */
  it('bench 런만 있는 스냅숏: 드레인은 대기(activeProjectIds 비지 않음) · 레거시 잠금은 해제', () => {
    const a: RunActivity = {
      activeProjectIds: ['p1'],
      activeRuns: [{ projectId: 'p1', benchId: 'b1' }],
    }
    // R-1: 드레인 판정식(boot.ts:298·312)이 보는 필드 — 비어 있지 않아야 SIGTERM 이 기다린다.
    expect(a.activeProjectIds.length).toBeGreaterThan(0)
    // R-2: 같은 스냅숏에서 레거시 잠금은 걸리지 않는다.
    expect(hasLegacyRun(a)).toBe(false)
  })

  it('두 필드는 같은 런 집합을 가리킨다(projectId 집합 일치)', () => {
    const a: RunActivity = {
      activeProjectIds: ['p1', 'p2'],
      activeRuns: [{ projectId: 'p1', benchId: 'b1' }, { projectId: 'p2' }],
    }
    expect(a.activeRuns.map((r) => r.projectId).sort()).toEqual([...a.activeProjectIds].sort())
  })
})
