import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BenchAuthorityDraft, BenchAuthorityRecord, CasResult } from './authority'
import { createBenchAuthorityStore } from './authority'
import { createFakeDurableFs, type FakeDurableFs, type FakeOp } from './__testing__/durable-fs-fake'
import { createFakeLockBackend } from './__testing__/lock-backend-fake'
import { type BenchLeaseToken, createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR2b T8 — 권위 CAS 코어(§W-4)의 **행동층**.
 *
 * 전량 주입 페이크 위에서 돌므로 **양 OS 에서 같은 행을 실행**한다(§3.1 대응 ⓐ). 3면 실측상 이 슬라이스의
 * 하중 프리미티브(JSON 왕복·복사 연산·마이크로태스크 순서)는 **플랫폼 대칭**이라 게이트가 필요 없다 —
 * PR2a 의 `DurableFs` 가 3면에서 정확히 반대였던 것과 대조된다(계획 정정 61 vs PR2b 실측표).
 */

const COMMON_GIT_DIR = '/repo/.git'
const BENCH_ROOT = '/workbenches'
const AUTHORITY_DIR = join('/repo/.git/fleet', 'authority')

/** 고정 시계 — 픽스처 시계 규율(이 레포가 C1 에서 확립). `writtenBy.at` 이 관측 대상이다. */
const AT = 1_700_000_000_000

interface Fixture {
  readonly fs: FakeDurableFs
  readonly lease: BenchLeaseToken
  readonly benchId: string
  readonly path: string
  readonly tmpPath: string
  readonly store: ReturnType<typeof createBenchAuthorityStore>
}

/** 핸들도 함께 돌려준다 — L-6 재검증 분기를 조작화하려면 리스를 **잃게** 만들 수단이 필요하다. */
const acquire = async (
  benchId: string,
  benchRoot = BENCH_ROOT,
  commonGitDir = COMMON_GIT_DIR,
): Promise<{ lease: BenchLeaseToken; release: () => void }> => {
  const scope = createLockScope({
    identity: { commonGitDir, benchRoot },
    backend: createFakeLockBackend(),
  })
  const r = await scope.tryAcquireBenchLease(benchId)
  if (r.status !== 'acquired') throw new Error(`리스 획득 실패: ${r.status}`)
  return { lease: r.lease, release: () => r.handle.release() }
}

const mintLease = async (
  benchId: string,
  benchRoot = BENCH_ROOT,
  commonGitDir = COMMON_GIT_DIR,
): Promise<BenchLeaseToken> => (await acquire(benchId, benchRoot, commonGitDir)).lease

const setup = async (
  initial: Readonly<Record<string, string>> = {},
  durability: 'file+dir' | 'file-only' = 'file-only',
): Promise<Fixture> => {
  const benchId = newUlid()
  const fs = createFakeDurableFs({ initial })
  const lease = await mintLease(benchId)
  const store = createBenchAuthorityStore(fs, {
    authorityDir: AUTHORITY_DIR,
    durability,
    now: () => AT,
  })
  return {
    fs,
    lease,
    benchId,
    path: join(AUTHORITY_DIR, `${benchId}.json`),
    tmpPath: join(AUTHORITY_DIR, `${benchId}.json.${lease.ownerToken}.tmp`),
    store,
  }
}

/** 정상 레코드 — 불변식 9종을 전부 만족하는 최소형. */
const validRecord = (benchId: string, over: Partial<BenchAuthorityRecord> = {}): unknown => ({
  schemaVersion: 1,
  identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
  revision: 1,
  lifecycle: 'open',
  sourceGeneration: 1,
  writtenBy: { ownerToken: 'prev-owner', at: AT - 1000, durability: 'file-only' },
  ...over,
})

const draft = (benchId: string, over: Partial<BenchAuthorityDraft> = {}): BenchAuthorityDraft => ({
  schemaVersion: 1,
  identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
  lifecycle: 'open',
  sourceGeneration: 1,
  ...over,
})

/* ================================================================================================
 * 진입 · 임계 구역 수명 (계획 정정 93·94 · §3-T17d)
 * ============================================================================================= */

describe('withAuthority 진입 — 리스 출처를 먼저 본다(정정 93)', () => {
  /**
   * **복제 토큰은 캐스트 0개로 컴파일된다**(locks.ts:421-432 실측). 그 복제본은 원본의 살아있는
   * `revalidate` 를 들고 있어 `owned` 를 답하고, `ownerToken` 도 같아서 `foreign-owner` 검사를 통과한다 —
   * 즉 `isMintedLease` 가 **유일한 방어**다. 이것이 없으면 A 의 리스로 B 의 권위 파일을 변이한다.
   */
  it('복제 토큰이면 어떤 파일시스템 프리미티브도 호출하지 않는다', async () => {
    const { fs, lease, store } = await setup()
    const otherId = newUlid()
    // 캐스트 0 — TS 가 스프레드에서 미export 브랜드 멤버를 보존한다(그것이 위험의 근원이다).
    const cloned: BenchLeaseToken = {
      ...lease,
      identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId: otherId },
    }

    const seen = await store.withAuthority(cloned, (tx) => Promise.resolve(tx.readFresh()))

    expect(seen).toEqual({ kind: 'lease-invalid', reason: 'stolen' })
    expect(fs.calls).toEqual([])
  })

  it('복제 토큰이면 compareAndSwap 도 값으로 거부한다(throw 아님)', async () => {
    const { fs, lease, store, benchId } = await setup()
    const cloned: BenchLeaseToken = {
      ...lease,
      identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId: newUlid() },
    }

    const r = await store.withAuthority(cloned, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent' && read.kind !== 'found') {
        // 읽기가 이미 거부됐으므로 토큰이 없다 — CAS 를 부를 방법 자체가 없음을 확인한다.
        return read
      }
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    expect(r).toEqual({ kind: 'lease-invalid', reason: 'stolen' })
    expect(fs.calls).toEqual([])
  })
})

describe('임계 구역 수명 — tx 는 반환 후 죽는다(정정 94)', () => {
  it('유출된 tx 로 compareAndSwap 하면 lease-invalid{released}', async () => {
    const { store, lease, benchId, fs } = await setup()
    let leaked: {
      compareAndSwap: (r: never, d: BenchAuthorityDraft) => Promise<CasResult>
    } | null = null
    let token: never | null = null

    await store.withAuthority(lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind === 'absent') token = read.read as never
      leaked = tx as never
      return Promise.resolve(null)
    })

    const before = fs.calls.length
    const r = await leaked!.compareAndSwap(token!, draft(benchId))
    expect(r).toEqual({ kind: 'lease-invalid', reason: 'released' })
    // 유출 경로는 **디스크를 만지지 않는다** — 반환값만 보고 통과시키면 무신호다.
    expect(fs.calls.length).toBe(before)
  })

  it('fn 이 throw 해도 뮤텍스가 풀려 다음 호출이 진입한다', async () => {
    const { store, lease } = await setup()
    await expect(
      store.withAuthority(lease, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')

    const ok = await store.withAuthority(lease, () => Promise.resolve('진입함'))
    expect(ok).toBe('진입함')
  })
})

/* ================================================================================================
 * §3-T17d — 같은 bench 의 두 임계 구역은 겹치지 않는다 (계획 정정 82)
 * ============================================================================================= */

describe('§3-T17d 직렬화 — 단계 타임라인이 인터리브되지 않는다', () => {
  /**
   * ⚠ **랑데부 배리어를 쓰지 않는다**(계획 정정 82). 상호배제가 성립하면 두 번째 `fn` 은 첫 `fn` 이
   * 끝나기 전에 랑데부에 **도달할 수 없으므로**, 문면대로 조작화하면 **정답 구현이 deadlock** 한다.
   * 관측면은 「주입 `DurableFs` 단계 타임라인」이다.
   */
  /**
   * ⚠ **`statKind` 를 세면 안 된다** — 한 임계 구역이 그것을 **두 번** 부른다(호출자의 `readFresh` 1회 +
   * CAS 가 rename 직전에 하는 디스크 재독 1회). 그 재독은 정답 구현의 필수 동작이므로 세면 정답이 RED 다.
   *
   * 관측면은 **쓰기 블록의 중첩**이다: 각 임계 구역은 `mkdirRecursive` 1회와 `rename` 1회를 정확히 한 번씩
   * 내므로, 직렬화됐다면 `m₀ < r₀ < m₁ < r₁` 로 **완전히 분리**된다. 겹치면 이 순서가 깨진다.
   */
  const interleaved = (steps: readonly FakeOp[]): boolean => {
    const at = (op: FakeOp): number[] => steps.flatMap((s, i) => (s === op ? [i] : []))
    const [m0, m1] = at('mkdirRecursive')
    const [r0, r1] = at('rename')
    if (m0 === undefined || m1 === undefined || r0 === undefined || r1 === undefined) return true
    return !(m0 < r0 && r0 < m1 && m1 < r1)
  }

  it('두 withAuthority 를 동시에 시작해도 타임라인이 분리된다', async () => {
    const { store, lease, benchId, fs } = await setup()
    const run = (gen: number): Promise<CasResult> =>
      store.withAuthority(lease, async (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'absent' && read.kind !== 'found')
          throw new Error(`예상 밖: ${read.kind}`)
        await Promise.resolve() // 양보 지점 — 뮤텍스가 없으면 여기서 상대가 끼어든다.
        return tx.compareAndSwap(read.read, draft(benchId, { sourceGeneration: gen }))
      })

    const [a, b] = await Promise.all([run(1), run(2)])

    expect(interleaved(fs.steps)).toBe(false)
    // 직렬화됐으므로 **둘 다 성공**한다(각자 fresh read 를 한다).
    expect([a.kind, b.kind]).toEqual(['committed', 'committed'])
  })

  /**
   * **자기검사**(계획 정정 68 이 필수화). 위 단언이 vacuous 가 아님을 보이려면 「뮤텍스가 없으면 실제로
   * 인터리브가 관측된다」를 같은 술어로 증명해야 한다. 대조 구현은 **테스트 안에만** 둔다 — 프로덕션에
   * 직렬화 우회 스위치를 만들면 그 스위치 자체가 새 공격면이다.
   *
   * 실측: 이 인터리브는 3면(win32 24.16.0 · linux 22.22.3 · 24.18.0) **200회 전부 동일**이라 flake 가 없다.
   */
  it('앵커: 뮤텍스 없는 대조 구현에서는 같은 술어가 인터리브를 잡는다', async () => {
    const steps: FakeOp[] = []
    // 프로덕션과 **같은 두 마커**를 낸다 — 술어가 공유돼야 위 단언이 vacuous 가 아님이 증명된다.
    const noMutex = async (): Promise<void> => {
      steps.push('mkdirRecursive')
      await Promise.resolve() // 양보 — 뮤텍스가 없으므로 여기서 상대가 진입한다.
      steps.push('rename')
    }
    await Promise.all([noMutex(), noMutex()])

    // 실측: 이 인터리브는 3면 200회 전부 동일하다(flake 없음).
    expect(steps).toEqual(['mkdirRecursive', 'mkdirRecursive', 'rename', 'rename'])
    expect(interleaved(steps)).toBe(true)

    // 음성 통제 — 직렬 타임라인은 같은 술어가 통과시킨다.
    expect(interleaved(['mkdirRecursive', 'rename', 'mkdirRecursive', 'rename'])).toBe(false)
  })
})

/* ================================================================================================
 * §3-T14 — fresh read (계획 정정 79)
 * ============================================================================================= */

describe('§3-T14 fresh read — 읽기 카운터는 두 축이다(정정 79)', () => {
  it('found 경로에서 readFileUtf8 이 정확히 1회', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const path = join(AUTHORITY_DIR, `${benchId}.json`)
    const fs = createFakeDurableFs({ initial: { [path]: JSON.stringify(validRecord(benchId)) } })
    const store = createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
    })

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(r.kind).toBe('found')
    expect(fs.countOf('readFileUtf8')).toBe(1)
    expect(fs.countOf('statKind')).toBe(1)
  })

  /**
   * **정답 구현이 원안 문면에서 RED 였다**(정정 79). `statKind` 선검사가 `'missing'` 을 답하면
   * `readFileUtf8` 은 **0회**다 — 「readFresh 1회당 정확히 1회」를 전 경로에 걸면 부재 경로가 거짓이 된다.
   */
  it('부재 경로에서는 readFileUtf8 이 0회이고 statKind 만 1회', async () => {
    const { store, lease, fs } = await setup()
    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(r.kind).toBe('absent')
    expect(fs.countOf('readFileUtf8')).toBe(0)
    expect(fs.countOf('statKind')).toBe(1)
  })

  it('정규 파일이 아니면 invalid 이고 자동 삭제하지 않는다', async () => {
    const { store, lease, fs, path } = await setup()
    fs.setOther(path) // FIFO·symlink — 실물에서 읽으면 무기한 블록되거나 영역 밖이 권위가 된다.

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(r.kind).toBe('invalid')
    expect(fs.countOf('readFileUtf8')).toBe(0)
    expect(fs.countOf('unlinkIfExists')).toBe(0)
    expect(fs.paths()).toContain(path)
  })

  it('캐시 구현이면 RED — 외부 교체 후 다음 readFresh 가 새 revision 을 준다', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: 1 })))

    const first = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: 7 })))
    const second = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(first.kind === 'found' && first.record.revision).toBe(1)
    expect(second.kind === 'found' && second.record.revision).toBe(7)
  })

  it('같은 FreshReadToken 재사용은 read-token-spent', async () => {
    const { store, lease, benchId } = await setup()
    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      await tx.compareAndSwap(read.read, draft(benchId))
      return tx.compareAndSwap(read.read, draft(benchId, { sourceGeneration: 2 }))
    })
    expect(r.kind).toBe('read-token-spent')
  })
})

/* ================================================================================================
 * 읽기 검증 계층 (계획 정정 86·87·88·89·96)
 * ============================================================================================= */

describe('읽기 검증 — schemaVersion → 형태 → identity → 불변식(정정 86·87)', () => {
  /**
   * **I12 의 핵심.** 신 버전 레코드는 이 코드가 모르는 필드를 갖는다 — 문법 검사를 먼저 하면
   * `invalid` 로 오분류되고, 그러면 **구 버전이 신 버전 권위를 삭제**한다.
   */
  it('신 버전 ∧ 문법 위반 동시면 incompatible-version 이 이긴다', async () => {
    const { store, lease, fs, path } = await setup()
    fs.setFile(path, JSON.stringify({ schemaVersion: 99, lifecycle: 42, identity: null }))

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(r.kind).toBe('incompatible-version')
    expect(r.kind === 'incompatible-version' && r.found).toBe(99)
    expect(r.kind === 'incompatible-version' && r.supported).toBe(1)
  })

  it('유니온 밖 lifecycle 은 invalid — 불변식은 관계만 보므로 형태 검사가 필요하다(정정 87)', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    // ①②⑥⑦ 을 vacuously 만족하면서 lifecycle 만 유니온 밖.
    fs.setFile(path, JSON.stringify(validRecord(benchId, { lifecycle: 'zzz' as never })))

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('invalid')
  })

  it('__proto__ own 키를 가진 레코드는 invalid(정정 88)', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    const hostile = `{"__proto__":{"polluted":true},${JSON.stringify(validRecord(benchId)).slice(1)}`
    fs.setFile(path, hostile)

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(r.kind).toBe('invalid')
    // 오염이 실제로 일어나지 않았음도 함께 본다(구현이 Object.assign 을 썼다면 여기서 잡힌다).
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it.each([
    ['정수 아님', 1.5],
    ['NaN 왕복 산물', null],
    ['안전 정수 초과', 2 ** 53],
    ['문자열', '1'],
    ['0 이하', 0],
  ])('revision 이 %s 이면 invalid(정정 88ⓓ)', async (_label, revision) => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: revision as never })))

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('invalid')
  })

  it('identity 가 리스와 다르면 identity-mismatch', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(
      path,
      JSON.stringify(
        validRecord(benchId, {
          identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId },
        }),
      ),
    )

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('identity-mismatch')
  })

  /** **총체성**(정정 89) — 어떤 바이트에도 throw 하지 않는다. throw 는 뮤텍스 누수 = hang 이다. */
  it.each([
    ['잘린 JSON', '{"schemaVersion":1,'],
    ['배열', '[]'],
    ['null', 'null'],
    ['문자열', '"권위"'],
    ['숫자', '42'],
    ['빈 문자열', ''],
    ['중첩 타입 오류', '{"schemaVersion":1,"identity":"문자열","revision":1}'],
  ])('적대 바이트(%s)에도 throw 하지 않고 판별 유니온을 반환한다', async (_label, raw) => {
    const { store, lease, fs, path } = await setup()
    fs.setFile(path, raw)

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(['invalid', 'incompatible-version']).toContain(r.kind)
  })

  it('상한 초과 크기는 읽지도 않고 invalid(정정 96)', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    const padded = JSON.stringify(validRecord(benchId, { lifecycle: 'open' })).replace(
      '"open"',
      `"open","pad":"${'x'.repeat(70_000)}"`,
    )
    fs.setFile(path, padded)

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(r.kind).toBe('invalid')
    // 상한은 `statKind().size` 로 **읽기 전에** 건다 — 읽고 나서 재면 이미 늦다.
    expect(fs.countOf('readFileUtf8')).toBe(0)
  })
})

/* ================================================================================================
 * §3-T61 — 조건부 스키마 불변식 (계획 정정 83·98)
 * ============================================================================================= */

describe('§3-T61 불변식 1~9 — read 표면', () => {
  const cases: readonly (readonly [string, Partial<BenchAuthorityRecord>])[] = [
    ['① archivedBranch 존재 ∧ lifecycle≠archived', { archivedBranch: 'preserved' }],
    ['① lifecycle=archived ∧ archivedBranch 부재', { lifecycle: 'archived' }],
    [
      '② completedIntegrationTxnId 존재 ∧ lifecycle≠integrated',
      { completedIntegrationTxnId: 'T1' },
    ],
    ['② lifecycle=integrated ∧ completedIntegrationTxnId 부재', { lifecycle: 'integrated' }],
    ['③ Stage 존재 ∧ TxnId 부재', { currentIntegrationStage: 'prepared' }],
    ['③ Generation 존재 ∧ TxnId 부재', { currentIntegrationTxnGeneration: 1 }],
    // 계획 정정 98 — 원안 ③ 은 4필드 중 3개만 덮어 고아 resultOid 가 통과했다.
    ['③ ResultOid 존재 ∧ TxnId 부재(정정 98)', { currentIntegrationResultOid: 'abc123' }],
    [
      '④ TxnGeneration > sourceGeneration',
      {
        currentIntegrationTxnId: 'T1',
        currentIntegrationStage: 'prepared',
        currentIntegrationTxnGeneration: 9,
        sourceGeneration: 1,
      },
    ],
    [
      '⑤ activeActivity.generation ≠ sourceGeneration',
      {
        activeActivity: {
          activityId: 'A1',
          kind: 'run',
          generation: 5,
          ownerToken: 'o',
          execGate: 'gated',
          startedAt: AT,
        },
        sourceGeneration: 1,
      },
    ],
    [
      '⑥ integrated ∧ activeActivity',
      {
        lifecycle: 'integrated',
        completedIntegrationTxnId: 'T1',
        activeActivity: {
          activityId: 'A1',
          kind: 'run',
          generation: 1,
          ownerToken: 'o',
          execGate: 'gated',
          startedAt: AT,
        },
      },
    ],
    [
      '⑦ archived ∧ activeActivity',
      {
        lifecycle: 'archived',
        archivedBranch: 'deleted',
        activeActivity: {
          activityId: 'A1',
          kind: 'run',
          generation: 1,
          ownerToken: 'o',
          execGate: 'gated',
          startedAt: AT,
        },
      },
    ],
    ['⑧ revision < 1', { revision: 0 }],
  ]

  it.each(cases)('%s → invalid', async (_label, over) => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(path, JSON.stringify(validRecord(benchId, over)))

    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('invalid')
  })

  it('⑨ identity 불일치는 invalid 가 아니라 identity-mismatch(종별이 다르다)', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(
      path,
      JSON.stringify(
        validRecord(benchId, {
          identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: '/다른곳', benchId },
        }),
      ),
    )
    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('identity-mismatch')
  })

  it('음성 통제: 9종을 전부 만족하는 레코드는 found 다', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(path, JSON.stringify(validRecord(benchId)))
    const r = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('found')
  })
})

/* ================================================================================================
 * §3-T13 · CAS 판정 순서 (계획 정정 80·81·99b)
 * ============================================================================================= */

describe('§3-T13 revision-CAS', () => {
  /**
   * ⓐ **셋업이 계약이다**(정정 80): 「readFresh 1회 → CAS 2회」로 쓰면 정답은 `read-token-spent` 라
   * 「항상 revision-mismatch」가 거짓이 된다. **두 번의 독립 readFresh** 여야 두 토큰이 같은 revision 을
   * 관측한다.
   */
  it('ⓐ 두 상충 draft 를 순차 CAS 하면 두 번째가 revision-mismatch', async () => {
    const { store, lease, benchId, fs, path } = await setup()
    fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: 1 })))

    const readOnce = async (): Promise<never> =>
      store.withAuthority(lease, (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'found') throw new Error(`found 예상: ${read.kind}`)
        return Promise.resolve(read.read as never)
      })

    const t1 = await readOnce()
    const t2 = await readOnce()

    const first = await store.withAuthority(lease, (tx) =>
      tx.compareAndSwap(t1, draft(benchId, { sourceGeneration: 2 })),
    )
    const second = await store.withAuthority(lease, (tx) =>
      tx.compareAndSwap(t2, draft(benchId, { sourceGeneration: 3 })),
    )

    expect(first.kind).toBe('committed')
    expect(second.kind).toBe('revision-mismatch')
    expect(second.kind === 'revision-mismatch' && second.expected).toBe(1)
    expect(second.kind === 'revision-mismatch' && second.observed.revision).toBe(2)
  })

  /**
   * ⓑ **LWW 가 발현하는 자리는 옵셔널뿐이다**(정정 81). `{...prev, ...draft2}` 는 draft2 가 값을 준
   * 필드에서 정답과 관측이 같으므로, draft1 이 세우고 **draft2 가 생략한** 옵셔널만이 판별한다.
   * lifecycle 은 무변으로 고정한다 — 전이시키면 불변식 ⑥⑦ 이 **우연히** 잡아 반증력이 흐려진다.
   */
  it('ⓑ 첫 draft 가 세운 옵셔널이 두 번째 커밋에 살아남지 않는다(LWW 병합이면 RED)', async () => {
    const { store, lease, benchId, fs, path } = await setup()

    await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(
        read.read,
        draft(benchId, {
          currentIntegrationTxnId: 'T1',
          currentIntegrationStage: 'prepared',
          currentIntegrationTxnGeneration: 1,
          currentIntegrationResultOid: 'oid-1',
        }),
      )
    })

    await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'found') throw new Error('found 예상')
      // 통합 4필드를 **전부 생략**한 draft — 병합 구현이면 이전 값이 살아남는다.
      return tx.compareAndSwap(read.read, draft(benchId, { sourceGeneration: 1 }))
    })

    const onDisk: Record<string, unknown> = JSON.parse(fs.readRaw(path) ?? '{}')
    for (const k of [
      'currentIntegrationTxnId',
      'currentIntegrationStage',
      'currentIntegrationTxnGeneration',
      'currentIntegrationResultOid',
    ]) {
      expect(Object.hasOwn(onDisk, k)).toBe(false)
    }
  })

  /**
   * ⓒ 런타임 키 거부(정정 73 · 99b). ⚠ `{revision: undefined}` 는 `in`·`hasOwn`·`Object.keys` 에
   * **전부 잡히지만** 값 검사는 통과한다(3면 실측) — 그래서 이 케이스가 판별자를 고정한다.
   */
  it.each([
    ['revision 실값', { revision: 99 }],
    ['revision undefined 값', { revision: undefined }],
    ['writtenBy 실값', { writtenBy: { ownerToken: 'x', at: 1, durability: 'file-only' } }],
    ['writtenBy undefined 값', { writtenBy: undefined }],
  ])('ⓒ draft 에 %s 가 있으면 invariant-violation', async (_label, extra) => {
    const { store, lease, benchId } = await setup()
    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, { ...draft(benchId), ...extra } as BenchAuthorityDraft)
    })
    expect(r.kind).toBe('invariant-violation')
  })
})

/* ================================================================================================
 * §3-T15 · §3-T16 — 내구 순서와 단계별 실패 (계획 정정 77·78)
 * ============================================================================================= */

describe('§3-T15 내구 쓰기 순서', () => {
  it('file-only 면 mkdir → open-tmp → write → fsync → close → rename 이고 dir fsync 가 없다', async () => {
    const { store, lease, benchId, fs, path, tmpPath } = await setup({}, 'file-only')

    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    expect(r.kind).toBe('committed')
    expect(fs.steps.filter((s) => s !== 'statKind' && s !== 'unlinkIfExists')).toEqual([
      'mkdirRecursive',
      'openExclusive',
      'writeAll',
      'fsync',
      'close',
      'rename',
    ])
    expect(fs.countOf('openDir')).toBe(0)
    expect(fs.paths()).toEqual([path])
    expect(fs.paths()).not.toContain(tmpPath)
    expect(fs.openFdCount()).toBe(0)
  })

  it('file+dir 면 rename 뒤에 openDir → fsync → close 가 온다', async () => {
    const { store, lease, benchId, fs } = await setup({}, 'file+dir')

    await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    const after = fs.steps.slice(fs.steps.indexOf('rename'))
    expect(after).toEqual(['rename', 'openDir', 'fsync', 'close'])
    expect(fs.openFdCount()).toBe(0)
  })

  it('커밋된 레코드가 revision·writtenBy 를 저장소 권위로 채운다', async () => {
    const { store, lease, benchId, fs, path } = await setup({}, 'file-only')

    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    expect(r.kind === 'committed' && r.record.revision).toBe(1)
    expect(r.kind === 'committed' && r.record.writtenBy).toEqual({
      ownerToken: lease.ownerToken,
      at: AT,
      durability: 'file-only',
    })
    // §3-T18 — 등급이 **레코드에 기록**되고 조용히 스킵되지 않는다.
    const onDisk: BenchAuthorityRecord = JSON.parse(fs.readRaw(path) ?? '{}')
    expect(onDisk.writtenBy.durability).toBe('file-only')
    expect(r.kind === 'committed' && r.commit.durability).toBe('file-only')
  })
})

describe('§3-T16 단계별 실패 주입 — rename 성공 전(계획 정정 53·78)', () => {
  const preCommit: readonly (readonly [FakeOp, string])[] = [
    ['mkdirRecursive', 'mkdir'],
    ['openExclusive', 'open-tmp'],
    ['writeAll', 'write'],
    ['fsync', 'fsync-file'],
    ['close', 'close-tmp'],
    ['rename', 'rename'],
  ]

  it.each(preCommit)('%s 실패 → io-failure{step:%s} · 디스크 무변이', async (op, step) => {
    const { store, lease, benchId, fs, path } = await setup({}, 'file-only')
    fs.failNext(op, new Error(`주입 실패: ${op}`))

    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    expect(r.kind).toBe('io-failure')
    expect(r.kind === 'io-failure' && r.step).toBe(step)
    // 권위 파일은 생기지 않았고, 열린 fd 도 남지 않았다(try/finally 규율).
    expect(fs.readRaw(path)).toBeUndefined()
    expect(fs.openFdCount()).toBe(0)
  })

  /**
   * **EEXIST 자기잠금 falsifier**(계획 정정 78). tmp 이름은 `ownerToken` 스코프이고 `ownerToken` 은
   * **획득당 1회** 민팅이라(locks.ts:343) 한 리스의 모든 CAS 가 같은 tmp 경로를 쓴다. `finally` 정리가
   * 없으면 다음 CAS 의 `openExclusive`(create-only)가 EEXIST 로 **영구 실패**한다.
   */
  it('실패 직후 같은 리스로 재-CAS 하면 성공한다(tmp 자기잠금 부재)', async () => {
    const { store, lease, benchId, fs, tmpPath } = await setup({}, 'file-only')
    fs.failNext('fsync', new Error('첫 시도만 실패'))

    const attempt = (): Promise<CasResult> =>
      store.withAuthority(lease, async (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'absent' && read.kind !== 'found') throw new Error('예상 밖')
        return tx.compareAndSwap(read.read, draft(benchId))
      })

    const first = await attempt()
    expect(first.kind).toBe('io-failure')
    expect(fs.paths()).not.toContain(tmpPath) // finally 가 자기 tmp 를 치웠다.

    const second = await attempt()
    expect(second.kind).toBe('committed')
  })
})

describe('post-commit 실패 → commit-uncertain (계획 정정 77)', () => {
  /**
   * PR2b 가 **실행하는** 단계의 실패는 PR2b 가 **분류**해야 한다. 이 행이 없으면 throw·삼킴·
   * `commit-uncertain` 세 구현이 전부 GREEN 이다(4렌즈 수렴 지적).
   */
  const postCommit: readonly (readonly [FakeOp, string, number])[] = [
    // `skip` = 같은 프리미티브의 **파일 차례**를 통과시키는 횟수(fsync-file · close-tmp).
    ['openDir', 'open-dir', 0],
    ['fsync', 'fsync-dir', 1],
    ['close', 'close-dir', 1],
  ]

  it.each(postCommit)(
    '%s 실패 → commit-uncertain{step:%s} · 디스크 revision 은 전진',
    async (op, step, skip) => {
      const { store, lease, benchId, fs, path } = await setup({}, 'file+dir')
      fs.failNext(op, new Error(`주입: ${op}`), 1, skip)

      const r = await store.withAuthority(lease, async (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'absent') throw new Error('absent 예상')
        return tx.compareAndSwap(read.read, draft(benchId))
      })

      expect(r.kind).toBe('commit-uncertain')
      expect(r.kind === 'commit-uncertain' && r.step).toBe(step)
      expect(r.kind === 'commit-uncertain' && r.advancedRevision).toBe(1)
      // **디스크 revision 은 이미 전진했다** — 「쓰기 실패·상태 무변」과 반드시 구분된다.
      const onDisk: BenchAuthorityRecord = JSON.parse(fs.readRaw(path) ?? '{}')
      expect(onDisk.revision).toBe(1)
      expect(fs.openFdCount()).toBe(0)
    },
  )
})

/* ================================================================================================
 * 모듈 스코프 원장 (계획 정정 95)
 * ============================================================================================= */

describe('readSeq·소비 원장은 모듈 스코프다(정정 95)', () => {
  it('한 store 가 발급한 토큰을 다른 store 에 제출하면 read-token-spent', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const fs = createFakeDurableFs()
    const mk = (): ReturnType<typeof createBenchAuthorityStore> =>
      createBenchAuthorityStore(fs, {
        authorityDir: AUTHORITY_DIR,
        durability: 'file-only',
        now: () => AT,
      })
    const a = mk()
    const b = mk()

    const token = await a.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      await tx.compareAndSwap(read.read, draft(benchId))
      return read.read as never
    })

    const r = await b.withAuthority(lease, (tx) => tx.compareAndSwap(token, draft(benchId)))
    expect(r.kind).toBe('read-token-spent')
  })
})

/* ================================================================================================
 * CAS 재독 창 — readFresh 와 rename 사이에 디스크가 바뀌면 (계획 정정 80 ④ · concurrency-10)
 * ============================================================================================= */

/**
 * CAS 는 rename **직전에 디스크를 다시 읽는다** — 토큰의 `observedRevision` 만 믿는 구현은 in-process
 * 시나리오에서만 맞고 크로스 프로세스(재시작·컨테이너 교체)에서 틀린다. 그 재독이 무엇을 보든 **fail-closed**
 * 여야 하고, 각 종별이 CAS 어휘로 어떻게 사상되는지가 계약이다.
 *
 * 이 영역은 §W-2-a 상 ttyd 셸·CLI 에이전트와 **같은 신뢰 도메인**이라 이 창에서 남이 파일을 바꾸는 것이
 * 실제로 가능하다 — 그래서 이 행들은 이론적 방어가 아니다.
 */
describe('CAS 재독 창 — 읽기와 쓰기 사이의 변화는 전부 fail-closed', () => {
  /** readFresh 직후·CAS 직전에 디스크를 조작하고 결과 종별을 본다. */
  const casAfterMutation = async (
    mutate: (fx: Fixture) => void,
    seed?: (fx: Fixture) => void,
  ): Promise<CasResult> => {
    const fx = await setup()
    seed?.(fx)
    return fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent' && read.kind !== 'found') throw new Error(`예상 밖: ${read.kind}`)
      mutate(fx)
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })
  }

  it('권위 파일이 사라졌으면 커밋하지 않는다', async () => {
    const r = await casAfterMutation(
      (fx) => fx.fs.remove(fx.path),
      (fx) => fx.fs.setFile(fx.path, JSON.stringify(validRecord(fx.benchId, { revision: 3 }))),
    )
    expect(r.kind).toBe('invariant-violation')
  })

  it('손상 레코드로 교체되면 invariant-violation', async () => {
    const r = await casAfterMutation((fx) => fx.fs.setFile(fx.path, '{"schemaVersion":1,'))
    expect(r.kind).toBe('invariant-violation')
  })

  it('신 버전 레코드로 교체되면 커밋하지 않는다(구 버전이 신 권위를 덮지 않는다)', async () => {
    const r = await casAfterMutation((fx) =>
      fx.fs.setFile(fx.path, JSON.stringify({ schemaVersion: 99 })),
    )
    expect(r.kind).toBe('invariant-violation')
    expect(r.kind === 'invariant-violation' && r.violations.join()).toContain('99')
  })

  it('다른 레포의 레코드로 교체되면 lease-invalid{identity-mismatch}', async () => {
    const r = await casAfterMutation((fx) =>
      fx.fs.setFile(
        fx.path,
        JSON.stringify(
          validRecord(fx.benchId, {
            identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId: fx.benchId },
          }),
        ),
      ),
    )
    expect(r).toEqual({ kind: 'lease-invalid', reason: 'identity-mismatch' })
  })

  it('재독이 IO 실패면 io-failure 이고 디스크를 건드리지 않는다', async () => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      fx.fs.failNext('statKind', new Error('주입: 재독 실패'))
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })

    expect(r.kind).toBe('io-failure')
    expect(fx.fs.countOf('rename')).toBe(0)
    expect(fx.fs.paths()).toEqual([])
  })

  /**
   * **L-6 — 변이 직전 재검증**(계획 정정 concurrency-10). 리스를 잃은 뒤에는 rename 이 **실행되지 않는다**.
   * 이 행이 없으면 `lease-invalid{released|stolen}` 분기가 도달 불가로 착지한다.
   */
  it('리스를 잃으면 rename 을 실행하지 않는다', async () => {
    const benchId = newUlid()
    const { lease, release } = await acquire(benchId)
    const fs = createFakeDurableFs()
    const store = createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
    })

    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      release() // 변이 직전에 리스 상실 — 커널 endpoint 가 풀린다.
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    expect(r).toEqual({ kind: 'lease-invalid', reason: 'released' })
    expect(fs.countOf('rename')).toBe(0)
    expect(fs.countOf('openExclusive')).toBe(0)
  })

  it('남의 임계 구역에서 발급된 읽기 토큰은 foreign-owner 다', async () => {
    const benchId = newUlid()
    const a = await acquire(benchId)
    const b = await acquire(benchId)
    const fs = createFakeDurableFs()
    const store = createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
    })

    const token = await store.withAuthority(a.lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return Promise.resolve(read.read as never)
    })
    const r = await store.withAuthority(b.lease, (tx) => tx.compareAndSwap(token, draft(benchId)))

    expect(r).toEqual({ kind: 'lease-invalid', reason: 'foreign-owner' })
    expect(fs.countOf('rename')).toBe(0)
  })
})
