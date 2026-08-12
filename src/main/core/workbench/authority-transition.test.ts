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
    expect(checkTransitionInvariants(prev, draft({ lifecycle: 'open' }))).toEqual([
      expect.stringContaining('완결 귀속'),
    ])
  })
})

describe('전이 불변식 — 최초 레코드', () => {
  it('이전 레코드 부재(최초 생성)에서는 전이 검사가 침묵한다', () => {
    expect(checkTransitionInvariants(undefined, draft())).toEqual([])
    // 단 최초 레코드가 곧바로 미종결 통합을 들고 태어나는 것은 막지 않는다 — 그것은 단일 레코드
    // 불변식(③ 계열)의 소관이며, 여기서 이중으로 잡으면 **같은 종별을 두 방어가 공유**해 가림이 생긴다
    // (PR3b 정정 189 가 실측한 형태).
    expect(
      checkTransitionInvariants(
        undefined,
        draft({
          currentIntegrationTxnId: T1,
          currentIntegrationStage: 'composed',
          currentIntegrationTxnGeneration: 3,
          currentIntegrationResultOid: 'a'.repeat(40),
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
