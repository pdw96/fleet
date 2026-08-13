import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type BenchAuthorityDraft,
  type BenchAuthorityRecord,
  checkTransitionInvariants,
  createBenchAuthorityStore,
} from './authority'
import { createFakeDurableFs } from './__testing__/durable-fs-fake'
import { createFakeLockBackend } from './__testing__/lock-backend-fake'
import { createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * §3-T82 — **신·구 레코드 전이 불변식 계층**(계획 정정 195·204).
 *
 * 현행 `checkInvariants` 는 **단일 레코드 전용**이라(authority.ts) 권위 CAS 는 신 레코드만 검사한다.
 * 그래서 `published → prepared` 역행이나 `abandoned` 이후 부활이 **어느 층에서도 차단되지 않는다**
 * (계획 정정 142 가 저널 쪽에만 세운 전이 강제를 권위 쪽에 세우는 것이 이 계층이다).
 *
 * ⚠ 이 계층이 없으면 정정 204 의 불변식 ①③⑤(단계 커밋 전진 금지 · pending 중 새 시도 금지 ·
 * CAS 실패는 published 전진의 인가가 아님)가 **문면으로만** 존재한다.
 */

const IDENTITY = {
  commonGitDir: '/repo/.git',
  benchRoot: '/repo/../.fleet-wb',
  benchId: '01J8Z4T7K9QW3M5N7P9R1S3T5V',
} as const

const T1 = '01J8Z4T7K9QW3M5N7P9R1S3T5W'
const T2 = '01J8Z4T7K9QW3M5N7P9R1S3T5X'

const base = (over: Partial<BenchAuthorityRecord> = {}): BenchAuthorityRecord =>
  ({
    schemaVersion: 1,
    identity: IDENTITY,
    revision: 5,
    lifecycle: 'open',
    sourceGeneration: 3,
    writtenBy: { ownerToken: 'ow', at: 1, durability: 'process-durable' },
    ...over,
  }) as BenchAuthorityRecord

const draft = (over: Partial<BenchAuthorityDraft> = {}): BenchAuthorityDraft => {
  const { revision: _r, writtenBy: _w, ...rest } = base()
  return { ...rest, ...over } as BenchAuthorityDraft
}

describe('전이 불변식 — 통합 stage', () => {
  it('부재 → prepared 는 새 트랜잭션의 정상 시작이다', () => {
    const prev = base()
    const next = draft({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([])
  })

  it('prepared → composed → published → finalized 는 전진이다', () => {
    const pairs = [
      ['prepared', 'composed'],
      ['composed', 'published'],
      ['published', 'finalized'],
    ] as const
    for (const [from, to] of pairs) {
      const prev = base({
        currentIntegrationTxnId: T1,
        currentIntegrationStage: from,
        currentIntegrationTxnGeneration: 3,
        ...(from === 'prepared' ? {} : { currentIntegrationResultOid: 'a'.repeat(40) }),
      })
      const next = draft({
        currentIntegrationTxnId: T1,
        currentIntegrationStage: to,
        currentIntegrationTxnGeneration: 3,
        currentIntegrationResultOid: 'a'.repeat(40),
      })
      expect(checkTransitionInvariants(prev, next)).toEqual([])
    }
  })

  it('역행을 거부한다 — 이것이 이 계층의 존재 이유다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'published',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    // ⚠ 증거를 그대로 들고 역행시킨다 — 증거를 함께 떨어뜨리면 **동결 위반까지 같이 발화**해서
    // 이 행이 「역행을 잡았다」가 아니라 「둘 중 뭔가 잡았다」가 된다(축 분리).
    const next = draft({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([
      '전이: stage 역행 금지(published → prepared)',
    ])
  })

  it('단계 건너뛰기를 거부한다 — prepared → published 는 composed CAS 를 삼킨다', () => {
    // 정정 203 이 verdict 이름을 바꾼 바로 그 위험의 기계 방어다: 이름이 허용하던 「composed 를
    // 건너뛰고 published 를 직접 기록」이 여기서 **컴파일은 되지만 커밋되지 않는다**.
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    const next = draft({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'published',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([
      expect.stringContaining('단계 건너뛰기'),
    ])
  })

  it('통합 축을 건드리지 않는 CAS 는 그 축의 no-op 이다 — 자기 전이가 아니다', () => {
    // gated-orphan 회수(`reclaimDraft`)·활동 시작/종료·lifecycle 변경은 통합 4필드를 **보존한 채**
    // 커밋된다. 「stage 가 같다 = 자기 전이」로 읽으면 그 정상 경로가 전부 거부된다 — 실제로 기존
    // 무회귀 핀(`authority-node.test.ts` 의 commit-uncertain 회수 행)이 내 초안을 그렇게 잡았다.
    const integration = {
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    } as const
    const prev = base({
      ...integration,
      activeActivity: {
        activityId: 'act',
        kind: 'run',
        generation: 3,
        ownerToken: 'ow',
        execGate: 'gated',
        startedAt: 1,
      },
    })
    expect(checkTransitionInvariants(prev, draft({ ...integration }))).toEqual([])
  })

  it('권위 레코드는 `abandoned` 를 가질 수 없다 — 포기는 4필드 소거로 표현된다(정정 177)', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    const next = draft({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'abandoned',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([expect.stringContaining('abandoned')])
  })

  /**
   * **Codex PR#289 4R P1** — 파서는 `abandoned` 권위 레코드를 **여전히 읽을 수 있는데**(레거시·손상)
   * `AUTHORITY_STAGE_ORDER.indexOf('abandoned')` 가 **-1** 이라 `abandoned → prepared` 가
   * `fi=-1 · ti=0` 으로 역행·건너뛰기 두 검사를 **모두 통과**해 포기된 txn 을 부활시켰다.
   */
  it('abandoned 권위 상태에서 같은 txn 을 되살릴 수 없다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'abandoned',
      currentIntegrationTxnGeneration: 3,
    })
    for (const to of ['prepared', 'composed', 'published', 'finalized'] as const) {
      const next = draft({
        currentIntegrationTxnId: T1,
        currentIntegrationStage: to,
        currentIntegrationTxnGeneration: 3,
        ...(to === 'prepared' ? {} : { currentIntegrationResultOid: 'a'.repeat(40) }),
      })
      expect(checkTransitionInvariants(prev, next), to).toEqual([
        expect.stringContaining('abandoned 는 종결'),
      ])
    }
    // 소거(청소 복구)는 그대로 허용된다 — 막다른 길을 만들지 않는다.
    expect(checkTransitionInvariants(prev, draft())).toEqual([])
  })

  it('소거(포기)는 어느 단계에서나 허용된다', () => {
    for (const from of ['prepared', 'composed', 'published'] as const) {
      const prev = base({
        currentIntegrationTxnId: T1,
        currentIntegrationStage: from,
        currentIntegrationTxnGeneration: 3,
        ...(from === 'prepared' ? {} : { currentIntegrationResultOid: 'a'.repeat(40) }),
      })
      expect(checkTransitionInvariants(prev, draft())).toEqual([])
    }
  })

  /**
   * **Codex PR#289 8R P1** — 소거 arm 이 **목적지 lifecycle 에 아무 제약도 걸지 않았다.** 그래서 한 CAS 가
   * 미종결 통합을 지우면서 동시에 bench 를 종결(`archived`·`integrated`)시킬 수 있고, 단일 레코드
   * 검사와 lifecycle 단조 검사는 그것을 받아들인다. 그러면 보존된 그 txn 의 저널이 **종결 bench 위의
   * 활성 고아**가 되어 복구가 즉시 `reconciliation-required` 를 답한다.
   *
   * 6R 정정 232 가 복구 쪽에서 잡던 상태를 **전이 검증기 자신이 제조**할 수 있다는 것이 새 증거다.
   * 대칭 규칙은 이미 있다 — 「새 통합 txn 은 open bench 에서만 시작한다」(정정 228). 그 역방향으로
   * 「미종결 통합의 소거는 lifecycle 을 전진시킬 수 없다」를 세운다(포기는 포기대로 먼저 착지시켜라).
   */
  it('미종결 통합의 소거는 lifecycle 을 전진시킬 수 없다', () => {
    for (const from of ['prepared', 'composed', 'published'] as const) {
      const prev = base({
        currentIntegrationTxnId: T1,
        currentIntegrationStage: from,
        currentIntegrationTxnGeneration: 3,
        ...(from === 'prepared' ? {} : { currentIntegrationResultOid: 'a'.repeat(40) }),
      })
      const terminalize = draft({ lifecycle: 'archived', archivedBranch: 'preserved' })
      expect(checkTransitionInvariants(prev, terminalize), from).toEqual([
        expect.stringContaining('미종결 통합의 소거'),
      ])
    }
    // 음성 통제 ⓐ — lifecycle 을 그대로 두는 소거(정상 포기)는 계속 허용된다.
    const pending = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    expect(checkTransitionInvariants(pending, draft())).toEqual([])
    // 음성 통제 ⓑ — **종결된**(`finalized`) txn 의 소거는 종결화와 함께여도 정상이다(완결·보관 경로).
    const finalized = base({
      lifecycle: 'integrated',
      completedIntegrationTxnId: T1,
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'finalized',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    expect(
      checkTransitionInvariants(
        finalized,
        draft({ lifecycle: 'archived', archivedBranch: 'preserved' }),
      ),
    ).toEqual([])
  })
})

describe('전이 불변식 — pending 중 새 시도 금지 (정정 204 불변식 ③)', () => {
  it('미종결 txn 위에 다른 txnId 를 얹는 것을 거부한다', () => {
    for (const from of ['prepared', 'composed', 'published'] as const) {
      const prev = base({
        currentIntegrationTxnId: T1,
        currentIntegrationStage: from,
        currentIntegrationTxnGeneration: 3,
        ...(from === 'prepared' ? {} : { currentIntegrationResultOid: 'a'.repeat(40) }),
      })
      const next = draft({
        currentIntegrationTxnId: T2,
        currentIntegrationStage: 'prepared',
        currentIntegrationTxnGeneration: 3,
      })
      expect(checkTransitionInvariants(prev, next)).toEqual([expect.stringContaining('미종결 txn')])
    }
  })

  /**
   * **Codex PR#289 3R P1** — stage 종결만 보면 **종결된 bench 가 다시 열린다.** `lifecycle==='integrated'`
   * ∧ current stage `finalized` 인 레코드는 pending 검사를 통과하는데, 스펙 §5 는 「lifecycle 회귀(재개)
   * 없음 · `integrated` 후 추가 작업은 **새 bench**」다. 시작 인가를 stage 가 아니라 lifecycle 에 건다.
   */
  it('integrated·archived bench 에서는 새 txn 을 시작할 수 없다', () => {
    for (const lifecycle of ['integrated', 'archived'] as const) {
      const prev = base({
        lifecycle,
        ...(lifecycle === 'integrated'
          ? { completedIntegrationTxnId: T1 }
          : { archivedBranch: 'preserved' as const }),
        currentIntegrationTxnId: T1,
        currentIntegrationStage: 'finalized',
        currentIntegrationTxnGeneration: 3,
        currentIntegrationResultOid: 'a'.repeat(40),
      })
      const next = draft({
        lifecycle,
        ...(lifecycle === 'integrated'
          ? { completedIntegrationTxnId: T1 }
          : { archivedBranch: 'preserved' as const }),
        currentIntegrationTxnId: T2,
        currentIntegrationStage: 'prepared',
        currentIntegrationTxnGeneration: 3,
      })
      expect(checkTransitionInvariants(prev, next)).toEqual([
        expect.stringContaining('새 통합 txn 은 open bench 에서만 시작한다'),
      ])
    }
  })

  /**
   * **Codex PR#289 6R P1** — `prev` 만 보면 **한 CAS 가** T2 를 시작하면서 동시에 bench 를
   * `integrated` 로 넘길 수 있고, 그 뒤의 같은-T2 단계 전이는 이 게이트를 **아예 지나지 않는다**.
   */
  it('새 txn 을 시작하면서 동시에 bench 를 종결시킬 수 없다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'finalized',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    const next = draft({
      lifecycle: 'integrated',
      completedIntegrationTxnId: T1,
      currentIntegrationTxnId: T2,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    expect(checkTransitionInvariants(prev, next)).toContain(
      '전이: 새 통합 txn 은 open bench 에서만 시작한다(open → integrated)',
    )
  })

  it('finalized 뒤에는 새 txn 을 시작할 수 있다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'finalized',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    const next = draft({
      currentIntegrationTxnId: T2,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([])
  })
})

describe('전이 불변식 — 증거·세대 동결', () => {
  it('같은 txn 안에서 resultOid 교체를 거부한다 — 한 번 나타나면 동결', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    const next = draft({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'published',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'b'.repeat(40),
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([
      '전이: currentIntegrationResultOid 는 한 번 나타나면 동결이다(증거 교체 금지)',
    ])
  })

  it('같은 txn 안에서 txnGeneration 변경을 거부한다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    const next = draft({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 2,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([
      '전이: 같은 txn 안에서 currentIntegrationTxnGeneration 변경 금지',
    ])
  })

  it('sourceGeneration 감소를 거부한다 — 세대는 단조다', () => {
    expect(checkTransitionInvariants(base(), draft({ sourceGeneration: 2 }))).toEqual([
      expect.stringContaining('sourceGeneration'),
    ])
    expect(checkTransitionInvariants(base(), draft({ sourceGeneration: 4 }))).toEqual([])
  })

  it('완결 귀속(`completedIntegrationTxnId`)의 교체·소거를 거부한다', () => {
    const prev = base({ lifecycle: 'integrated', completedIntegrationTxnId: T1 })
    expect(
      checkTransitionInvariants(
        prev,
        draft({ lifecycle: 'integrated', completedIntegrationTxnId: T2 }),
      ),
    ).toEqual([expect.stringContaining('완결 귀속')])
    // ⚠ `integrated → open` 은 이제 **두 사유**가 함께 발화한다(완결 귀속 소거 + lifecycle 회귀 ·
    //    Codex PR#289 5R P1). 축이 다르므로 둘 다 남기고, 이 행은 **완결 귀속 축**만 단언한다.
    expect(checkTransitionInvariants(prev, draft({ lifecycle: 'open' }))).toContain(
      '전이: 완결 귀속(completedIntegrationTxnId)의 교체·소거 금지',
    )
  })

  /**
   * **Codex PR#289 3R P1** — 초안은 **이미 귀속이 있을 때만** 돌아서 **첫 도입이 무제한**이었다.
   * current 가 T1 인 레코드를 `completedIntegrationTxnId: T2` 로 커밋해도 단일 레코드·전이 검사가
   * 둘 다 통과했고, 무관한 txn 이 완결로 기록되면서 **부분 통합이 숨는다.** 스펙 §W-8 은 「완결은
   * **권위 시도만** · 관측 CAS 는 **txn 동일**」이다.
   */
  it('완결 귀속의 도입은 직전 레코드의 current txn 이어야 한다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'published',
      currentIntegrationTxnGeneration: 3,
      currentIntegrationResultOid: 'a'.repeat(40),
    })
    const complete = (completedIntegrationTxnId: string) =>
      draft({
        lifecycle: 'integrated',
        completedIntegrationTxnId,
        currentIntegrationTxnId: T1,
        currentIntegrationStage: 'published',
        currentIntegrationTxnGeneration: 3,
        currentIntegrationResultOid: 'a'.repeat(40),
      })
    expect(checkTransitionInvariants(prev, complete(T2))).toEqual([
      expect.stringContaining('완결 귀속은 직전 레코드의 current txn'),
    ])
    expect(checkTransitionInvariants(prev, complete(T1))).toEqual([])
  })

  /**
   * **Codex PR#289 5R P1** — txn 이 같다는 것만으로는 부족하다. `prepared` 상태의 T1 을 그대로
   * `integrated` + `completed: T1` 로 커밋해도 두 층이 통과해 **결과가 존재한 적 없는 bench 가
   * 완결로 기록**된다. §W-8 의 완결 정의(`resultOid` 의 base 도달성)는 결과 증거를 전제한다.
   */
  it('결과 증거 없는 txn 은 완결로 기록할 수 없다', () => {
    const prev = base({
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    const next = draft({
      lifecycle: 'integrated',
      completedIntegrationTxnId: T1,
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 3,
    })
    expect(checkTransitionInvariants(prev, next)).toEqual([
      expect.stringContaining('결과 증거 없는 txn'),
    ])
  })

  /**
   * **Codex PR#289 5R P1** — 통합 축을 건드리지 않는 CAS 는 통합 검사를 통째로 건너뛰므로,
   * archived 를 `archivedBranch` 만 떼고 `open` 으로 되돌리는 제출이 **어느 층에도 걸리지 않았다.**
   */
  it('lifecycle 은 회귀하지 않는다(archived → open · integrated → open)', () => {
    const archived = base({ lifecycle: 'archived', archivedBranch: 'preserved' })
    expect(checkTransitionInvariants(archived, draft({ lifecycle: 'open' }))).toEqual([
      expect.stringContaining('lifecycle 회귀 금지'),
    ])
    expect(checkTransitionInvariants(archived, draft({ lifecycle: 'integrated' }))).toContain(
      '전이: lifecycle 회귀 금지(archived → integrated)',
    )
    // 전진은 허용된다 — open → integrated · open → archived · 같은 값 유지.
    expect(checkTransitionInvariants(base(), draft({ lifecycle: 'open' }))).toEqual([])
    expect(
      checkTransitionInvariants(
        archived,
        draft({ lifecycle: 'archived', archivedBranch: 'preserved' }),
      ),
    ).toEqual([])
  })

  /**
   * **Codex PR#289 P1** — 이 규칙의 초안은 보관 워크플로를 통째로 막았다. 단일 레코드 불변식 ②가
   * 「`completedIntegrationTxnId` 존재 ⟺ `lifecycle==='integrated'`」이므로 `integrated → archived` 는
   * **반드시 그 필드를 소거**해야 하는데, 「소거 금지」가 그 정상 전이를 `invariant-violation` 으로 답했다.
   */
  it('보관 전이(integrated → archived)의 완결 귀속 소거는 허용한다', () => {
    const prev = base({ lifecycle: 'integrated', completedIntegrationTxnId: T1 })
    expect(
      checkTransitionInvariants(
        prev,
        draft({ lifecycle: 'archived', archivedBranch: 'preserved' }),
      ),
    ).toEqual([])
    // 보관이 아닌 소거는 여전히 거부다 — 예외는 lifecycle 에 결속한다.
    expect(checkTransitionInvariants(prev, draft({ lifecycle: 'integrated' }))).toEqual([
      expect.stringContaining('완결 귀속'),
    ])
  })
})

describe('전이 불변식 — 최초 레코드', () => {
  it('이전 레코드 부재(최초 생성)에서 통합 없는 레코드는 통과한다', () => {
    expect(checkTransitionInvariants(undefined, draft())).toEqual([])
  })

  /**
   * **Codex PR#289 P1** — 초안은 「최초 레코드가 미종결 통합을 들고 태어나는 것은 단일 레코드 불변식
   * ③ 계열의 소관」이라고 적고 침묵했는데, **그 주장이 거짓이었다.** `checkInvariants` 의 ③·③b·③c·③d
   * 어디에도 「최초 stage 는 `prepared`」가 없어서, 첫 CAS 가 `composed`·`published`·`finalized` 로
   * 곧바로 태어나 **WAL 의 `prepared` 단계와 그 크래시 안전 순서를 통째로 건너뛸 수 있었다**.
   *
   * 「다른 층이 막는다」는 검증 없는 안전 주장이 코드 주석으로 착지한 형태(PR#266 교훈)의 재발이다.
   */
  /**
   * **Codex PR#289 6R P1** — 이 early return 이 아래 완결 귀속 검사들을 **통째로 건너뛴다.** 그래서
   * `lifecycle: 'integrated'` + 임의의 `completedIntegrationTxnId` 를 든 **첫 CAS** 가 두 층을 다
   * 통과해 **트랜잭션도 결과도 없이 완결을 주장하는 종결 bench** 를 만들 수 있었다.
   */
  it('최초 레코드의 lifecycle 은 open 이어야 한다', () => {
    for (const lifecycle of ['integrated', 'archived'] as const) {
      const next = draft({
        lifecycle,
        ...(lifecycle === 'integrated'
          ? { completedIntegrationTxnId: T2 }
          : { archivedBranch: 'preserved' as const }),
      })
      expect(checkTransitionInvariants(undefined, next), lifecycle).toEqual([
        expect.stringContaining('최초 레코드의 lifecycle 은 open'),
      ])
    }
  })

  it('최초 레코드는 prepared 로만 통합을 시작할 수 있다', () => {
    for (const stage of ['composed', 'published', 'finalized'] as const) {
      expect(
        checkTransitionInvariants(
          undefined,
          draft({
            currentIntegrationTxnId: T1,
            currentIntegrationStage: stage,
            currentIntegrationTxnGeneration: 3,
            currentIntegrationResultOid: 'a'.repeat(40),
          }),
        ),
      ).toEqual([expect.stringContaining('prepared')])
    }
    expect(
      checkTransitionInvariants(
        undefined,
        draft({
          currentIntegrationTxnId: T1,
          currentIntegrationStage: 'prepared',
          currentIntegrationTxnGeneration: 3,
        }),
      ),
    ).toEqual([])
  })
})

/**
 * **배선 단언**(§3-T82 의 프로덕션 관통 층).
 *
 * ⚠ 위 스위트는 전부 **순수 함수**만 부른다. 순수 테스트만 두면 `compareAndSwap` 안의 호출부 한 줄을
 * 지워도 전 게이트가 GREEN 이고, 그러면 「선언했으나 실재하지 않는 방어」가 된다 — PR0 이 `bootServer`
 * 에서, PR1b 가 eslint 룰·raw 획득 스캔에서 각각 실측한 형태다.
 */
describe('전이 불변식 — CAS 관통 배선', () => {
  const COMMON_GIT_DIR = '/repo/.git'
  const BENCH_ROOT = '/workbenches'
  const AUTHORITY_DIR = join('/repo/.git/fleet', 'authority')

  it('역행 draft 는 저장소 CAS 에서 거부된다 — 디스크 무변이', async () => {
    const benchId = newUlid()
    const txn = newUlid()
    const path = join(AUTHORITY_DIR, `${benchId}.json`)
    const seeded: BenchAuthorityRecord = {
      schemaVersion: 1,
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
      revision: 4,
      lifecycle: 'open',
      sourceGeneration: 2,
      currentIntegrationTxnId: txn,
      currentIntegrationStage: 'published',
      currentIntegrationTxnGeneration: 2,
      currentIntegrationResultOid: 'a'.repeat(40),
      writtenBy: { ownerToken: 'seed', at: 1, durability: 'file-only' },
    }
    const fs = createFakeDurableFs({ initial: { [path]: JSON.stringify(seeded) } })
    const scope = createLockScope({
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT },
      backend: createFakeLockBackend(),
    })
    const acquired = await scope.tryAcquireBenchLease(benchId)
    if (acquired.status !== 'acquired') throw new Error(`리스 획득 실패: ${acquired.status}`)
    const store = createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => 1_700_000_000_000,
      sleep: () => Promise.resolve(),
    })

    const result = await store.withAuthority(acquired.lease, (tx) => {
      const fresh = tx.readFresh()
      if (fresh.kind !== 'found') throw new Error('found 예상')
      const { revision: _r, writtenBy: _w, ...rest } = fresh.record
      const backward: BenchAuthorityDraft = { ...rest, currentIntegrationStage: 'prepared' }
      return Promise.resolve(tx.compareAndSwap(fresh.read, backward))
    })

    expect(result.kind).toBe('invariant-violation')
    expect(result.kind === 'invariant-violation' && result.violations).toEqual([
      '전이: stage 역행 금지(published → prepared)',
    ])
    // 디스크 무변이 — revision 이 전진하지 않았다.
    const after = JSON.parse(fs.readRaw(path) ?? '{}') as BenchAuthorityRecord
    expect(after.revision).toBe(4)
    expect(after.currentIntegrationStage).toBe('published')
  })
})
