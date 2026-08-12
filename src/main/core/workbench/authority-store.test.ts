import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AuthorityReadResult,
  BenchActivityRecord,
  BenchAuthorityDraft,
  BenchAuthorityRecord,
  CasResult,
  FreshReadToken,
} from './authority'
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

/** 유출된 tx 를 담는 최소 형태 — `AuthorityTx` 를 그대로 쓰면 유출 자체가 타입상 자연스러워 보인다. */
interface AuthorityTxLike {
  readFresh(): AuthorityReadResult
}

const COMMON_GIT_DIR = '/repo/.git'
const BENCH_ROOT = '/workbenches'
const AUTHORITY_DIR = join('/repo/.git/fleet', 'authority')

/** 고정 시계 — 픽스처 시계 규율(이 레포가 C1 에서 확립). `writtenBy.at` 이 관측 대상이다. */
const AT = 1_700_000_000_000

/**
 * 이 스위트는 **재시도 경로를 타지 않는다** — 여기서 백오프가 발동하면 그것이 회귀다.
 * §3-T16 의 실패 주입은 `code` 가 없어(=재시도 비대상) 즉시 실패 경로이고, 재시도 계약 자체는
 * `authority-retry.test.ts`(#251 PR2c T9) 소관이다.
 *
 * ⚠ **던지지 않는다**(자가 적대 리뷰 F5 · 실측): 원안은 `throw` 였는데 그러면 그 오류가 CAS 의
 * `catch` 에 잡혀 `io-failure{step:'rename'}` 로 **재라벨**돼 기대값과 우연히 일치한다 — 그 결과
 * 「모든 오류를 재시도」 뮤턴트가 이 스위트에서 GREEN 이 됐다(정확히 이 헬퍼가 막으려던 회귀다).
 * 흐름을 바꾸지 않고 **기록만** 한 뒤 `afterEach` 에서 단언하면 둘 다 얻는다.
 */
const sleepCalls: number[] = []
const neverSleeps = (ms: number): Promise<void> => {
  sleepCalls.push(ms)
  return Promise.resolve()
}

afterEach(() => {
  const seen = sleepCalls.splice(0)
  expect(seen, '이 스위트에서 백오프가 발동했다 — 재시도는 authority-retry.test.ts 소관').toEqual(
    [],
  )
})

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
    sleep: neverSleeps,
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
      sleep: neverSleeps,
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
    // ⚠ **`String(unknown)` 이 TypeError 를 던지는 바이트**(자체 적대 리뷰 F8). own `toString` 이 비호출
    // 가능이면 `String()` 이 OrdinaryToPrimitive 에서 `valueOf` 까지 실패해 던진다 — 최상위
    // `__proto__`/`constructor` 검사는 중첩을 보지 않으므로 **도달 가능**하고, throw 는 총체성을 깨
    // 뮤텍스 누수 = hang 이 된다. 위반 메시지는 반드시 `show()` 로 만들어야 한다.
    [
      'lifecycle 이 비호출 toString 객체',
      '{"schemaVersion":1,"identity":{},"writtenBy":{},"revision":1,"lifecycle":{"toString":0}}',
    ],
    [
      'durability 가 비호출 toString 객체',
      '{"schemaVersion":1,"identity":{"commonGitDir":"/repo/.git","benchRoot":"/workbenches","benchId":"x"},' +
        '"revision":1,"lifecycle":"open","sourceGeneration":1,' +
        '"writtenBy":{"ownerToken":"o","at":1,"durability":{"toString":0}}}',
    ],
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

  /**
   * **identity → 불변식 경계**(자체 적대 리뷰 TP-10). ⑨ 행은 `validRecord` 기반이라 불변식 9종을 전부
   * 만족한 채 identity 만 다르므로 **순서를 증명하지 않는다**. 둘을 **동시에** 위반해야 어느 검사가 먼저
   * 발화하는지가 관측된다 — 뒤집힌 구현은 `invalid` 를 답한다.
   */
  it('identity 불일치 ∧ 불변식 위반이 동시면 identity-mismatch 가 먼저다', async () => {
    const { store, lease, fs, path, benchId } = await setup()
    fs.setFile(
      path,
      JSON.stringify(
        validRecord(benchId, {
          identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId },
          archivedBranch: 'preserved', // 불변식 ① 위반(lifecycle 은 'open')
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
  /**
   * ⚠ **셋업이 계약이다**(계획 정정 80 → Codex PR#266 2R P1 로 재정정). 원안은 두 임계 구역에서 토큰을
   * 각각 받아 **세 번째** 구역에서 제출했는데, 그것은 §W-4 가 규정한 「**같은** 임계 구역에서 발급된
   * 미사용 토큰」 계약을 위반한다(이제 `foreign-owner` 로 거부된다).
   *
   * 실제 위협 모델은 **다른 프로세스가 그 사이에 썼다**이므로(§W-2-a 동일 신뢰 도메인) 한 임계 구역 안에서
   * 그것을 재현한다 — readFresh 뒤 외부가 디스크를 전진시키고, CAS 의 rename 직전 재독이 그것을 본다.
   * 이 형태가 문면에도 충실하고 반증력도 더 강하다(토큰 재사용이 아니라 **재독 자체**를 검증한다).
   */
  it('ⓐ readFresh 뒤 외부가 디스크를 전진시키면 CAS 가 revision-mismatch', async () => {
    const { store, lease, benchId, fs, path } = await setup()
    fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: 1 })))

    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'found') throw new Error(`found 예상: ${read.kind}`)
      // **다른 프로세스**가 커밋했다 — 리스 없이도 이 영역에 쓸 수 있는 신뢰 도메인이다.
      fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: 2, sourceGeneration: 9 })))
      return tx.compareAndSwap(read.read, draft(benchId, { sourceGeneration: 3 }))
    })

    expect(r.kind).toBe('revision-mismatch')
    expect(r.kind === 'revision-mismatch' && r.expected).toBe(1)
    expect(r.kind === 'revision-mismatch' && r.observed.revision).toBe(2)
    // 자동 병합·LWW 가 없다 = 디스크는 외부가 쓴 그대로다(계약 6항).
    const onDisk: BenchAuthorityRecord = JSON.parse(fs.readRaw(path) ?? '{}')
    expect([onDisk.revision, onDisk.sourceGeneration]).toEqual([2, 9])
  })

  /**
   * ⓑ **LWW 가 발현하는 자리는 옵셔널뿐이다**(정정 81). `{...prev, ...draft2}` 는 draft2 가 값을 준
   * 필드에서 정답과 관측이 같으므로, draft1 이 세우고 **draft2 가 생략한** 옵셔널만이 판별한다.
   * lifecycle 은 무변으로 고정한다 — 전이시키면 불변식 ⑥⑦ 이 **우연히** 잡아 반증력이 흐려진다.
   */
  it('ⓑ 첫 draft 가 세운 옵셔널이 두 번째 커밋에 살아남지 않는다(LWW 병합이면 RED)', async () => {
    const { store, lease, benchId, fs, path } = await setup()

    // 4필드를 전부 세우려면 `composed` 가 필요한데(`prepared` 는 `resultOid` 를 실을 수 없다 ·
    // 불변식 ③c), **최초 레코드는 `prepared` 로만 시작할 수 있다**(Codex PR#289 P1). 그래서 두 단계로
    // 올라간 뒤 4필드가 전부 선 상태를 만든다 — 지름길이 막힌 것이지 시나리오가 바뀐 것은 아니다.
    await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(
        read.read,
        draft(benchId, {
          currentIntegrationTxnId: 'T1',
          currentIntegrationStage: 'prepared',
          currentIntegrationTxnGeneration: 1,
        }),
      )
    })

    await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'found') throw new Error('found 예상')
      return tx.compareAndSwap(
        read.read,
        draft(benchId, {
          currentIntegrationTxnId: 'T1',
          currentIntegrationStage: 'composed',
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
  // `skip` = 같은 프리미티브를 앞서 쓰는 차례를 통과시키는 횟수.
  // ⚠ `file+dir` 의 **첫 CAS** 는 부모 디렉터리 fsync 를 먼저 한다(Codex 3R P1-1) — 그래서 각각 +1 이다:
  // openDir(부모) · fsync(부모, 파일) · close(부모, tmp).
  const postCommit: readonly (readonly [FakeOp, string, number])[] = [
    ['openDir', 'open-dir', 1],
    ['fsync', 'fsync-dir', 2],
    ['close', 'close-dir', 2],
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
        sleep: neverSleeps,
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

  /**
   * ⚠ `io-failure{step:'rename'}` 이 **아니다**(자체 적대 리뷰 F2 · 5렌즈 수렴). 재독은 `mkdir` 보다도
   * 앞이라 그 시점에 디스크는 한 바이트도 바뀌지 않았는데, rename 이 반쯤 갔다고 증언하면 복구 판정이
   * 「tmp 잔재가 있을 수 있다」로 잘못 분기한다. `step` 은 `PreCommitStep` 이라 재독을 표현할 값이 없다.
   */
  it('재독이 IO 실패면 fail-closed 이고 rename 단계로 오라벨하지 않는다', async () => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      fx.fs.failNext('statKind', new Error('주입: 재독 실패'))
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })

    expect(r.kind).toBe('invariant-violation')
    // **오라벨 falsifier**: `step:'rename'` 으로 사상하는 구현이면 여기서 RED 다.
    expect(r.kind === 'invariant-violation' && r.violations.join()).toContain('재독')
    expect(fx.fs.countOf('rename')).toBe(0)
    expect(fx.fs.countOf('mkdirRecursive')).toBe(0)
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
      sleep: neverSleeps,
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
      sleep: neverSleeps,
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

/* ================================================================================================
 * 자가 적대 리뷰 반영 — 뮤테이션 실측(35 뮤턴트)이 「지워도 GREEN」으로 드러낸 방어들
 * ============================================================================================= */

/**
 * **§3-T61 CAS 표면**(계획 정정 83 이 요구한 2표 중 둘째 · 자체 적대 리뷰 F3·TP-1·DYN-01).
 *
 * read 표면 표만 있으면 쓰기 경로의 불변식 게이트는 **지워도 전 테스트가 GREEN** 이다(뮤턴트 M15 실측:
 * `checkInvariants(record)` 두 줄 제거 → 479/479 pass). 그리고 그 게이트가 유일하게 막는 결과는
 * 「이 모듈이 커밋한 레코드를 이 모듈이 못 읽는」 **브릭**이다.
 *
 * ⚠ 표면마다 관측이 다르다: ⑧(revision)은 draft 에 그 키가 없어 CAS 표면에서 **도달 불가**이고,
 * ⑨는 read 가 `identity-mismatch`·CAS 가 `lease-invalid{identity-mismatch}` 로 **종별이 다르다**.
 */
describe('§3-T61 불변식 — CAS(쓰기) 표면', () => {
  const casWith = async (over: Partial<BenchAuthorityDraft>): Promise<CasResult> => {
    const fx = await setup()
    return fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(fx.benchId, over))
    })
  }
  const act = (over: Partial<BenchActivityRecord> = {}): BenchActivityRecord => ({
    activityId: 'A1',
    kind: 'run',
    generation: 1,
    ownerToken: 'o',
    execGate: 'gated',
    startedAt: AT,
    ...over,
  })

  it.each([
    ['1 archivedBranch 존재 · lifecycle!==archived', { archivedBranch: 'preserved' as const }],
    ['1 lifecycle=archived · archivedBranch 부재', { lifecycle: 'archived' as const }],
    [
      '2 completedIntegrationTxnId 존재 · lifecycle!==integrated',
      { completedIntegrationTxnId: 'T1' },
    ],
    ['2 lifecycle=integrated · 부재', { lifecycle: 'integrated' as const }],
    ['3 Stage 존재 · TxnId 부재', { currentIntegrationStage: 'prepared' as const }],
    ['3 ResultOid 존재 · TxnId 부재(정정 98)', { currentIntegrationResultOid: 'oid' }],
    [
      // 4 단독 위반 — 3 이 먼저 발화하지 않도록 통합 **4필드를 전부** 채운다(자체 적대 리뷰 TP-3).
      '4 TxnGeneration > sourceGeneration(단독)',
      {
        currentIntegrationTxnId: 'T1',
        currentIntegrationStage: 'prepared' as const,
        currentIntegrationTxnGeneration: 9,
        currentIntegrationResultOid: 'oid',
        sourceGeneration: 1,
      },
    ],
    [
      '5 activeActivity.generation !== sourceGeneration',
      { activeActivity: act({ generation: 5 }) },
    ],
    [
      '6 integrated · activeActivity',
      { lifecycle: 'integrated' as const, completedIntegrationTxnId: 'T1', activeActivity: act() },
    ],
    [
      '7 archived · activeActivity',
      {
        lifecycle: 'archived' as const,
        archivedBranch: 'deleted' as const,
        activeActivity: act(),
      },
    ],
  ])('%s -> invariant-violation(커밋되지 않는다)', async (_label, over) => {
    const r = await casWith(over)
    expect(r.kind).toBe('invariant-violation')
  })

  it('8 revision 은 CAS 표면에서 도달 불가다 — draft 에 그 키가 없다(정정 83)', async () => {
    // 키를 억지로 실으면 8 이 아니라 **사전조건 거부**가 먼저 온다(정정 99b). 그것이 계약이다.
    const r = await casWith({ revision: 3 } as Partial<BenchAuthorityDraft>)
    expect(r.kind).toBe('invariant-violation')
    expect(r.kind === 'invariant-violation' && r.violations.join()).toContain('revision')
  })

  it('9 draft identity 가 리스와 다르면 lease-invalid{identity-mismatch}(뮤턴트 M25)', async () => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, {
        ...draft(fx.benchId),
        identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId: fx.benchId },
      })
    })
    expect(r).toEqual({ kind: 'lease-invalid', reason: 'identity-mismatch' })
    expect(fx.fs.countOf('rename')).toBe(0)
  })

  it('음성 통제: 9종을 만족하는 draft 는 커밋된다', async () => {
    const r = await casWith({ sourceGeneration: 1 })
    expect(r.kind).toBe('committed')
  })
})

/**
 * **왕복 검증**(자체 적대 리뷰 F1 · 메인 루프 실측 확정). 쓰기 경로가 읽기 경로보다 약하면 커밋한 레코드를
 * 자기가 못 읽는 브릭이 된다 — `invalid` 은 `read` 토큰을 싣지 않아 이 모듈 API 로는 탈출 불가다.
 */
describe('왕복 검증 — 쓴 것은 읽힌다(정정 88 d · F1)', () => {
  const casRaw = async (over: Record<string, unknown>): Promise<{ r: CasResult; fx: Fixture }> => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, { ...draft(fx.benchId), ...over } as BenchAuthorityDraft)
    })
    return { r, fx }
  }

  it.each([
    ['NaN(stringify 가 null 로 바꾼다)', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['정수 아님', 1.5],
    ['안전 정수 초과', 2 ** 53],
  ])('sourceGeneration 이 %s 면 커밋하지 않는다', async (_label, sourceGeneration) => {
    const { r, fx } = await casRaw({ sourceGeneration })
    expect(r.kind).toBe('invariant-violation')
    // 디스크를 만지지 않았다 = 브릭이 애초에 생기지 않는다.
    expect(fx.fs.countOf('rename')).toBe(0)
    expect(fx.fs.paths()).toEqual([])
  })

  it('유니온 밖 lifecycle 도 커밋하지 않는다', async () => {
    const { r } = await casRaw({ lifecycle: 'zzz' })
    expect(r.kind).toBe('invariant-violation')
    expect(r.kind === 'invariant-violation' && r.violations.join()).toContain('왕복 검증 실패')
  })

  it('상한 초과 레코드도 커밋하지 않는다(정정 96 을 쓰기 편으로 대칭화 · perf-3)', async () => {
    const { r, fx } = await casRaw({ currentIntegrationTxnId: 'x'.repeat(70_000) })
    expect(r.kind).toBe('invariant-violation')
    expect(r.kind === 'invariant-violation' && r.violations.join()).toContain('크기 상한')
    expect(fx.fs.paths()).toEqual([])
  })

  /** 종단 성질 — 커밋된 것은 **반드시** 다시 읽힌다. 이 행이 F1 계열 전체의 회귀 가드다. */
  it('커밋에 성공한 레코드는 항상 다시 found 로 읽힌다', async () => {
    const fx = await setup()
    const committed = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })
    expect(committed.kind).toBe('committed')
    const back = await fx.store.withAuthority(fx.lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(back.kind).toBe('found')
  })
})

describe('내구 쓰기 권한 인자 — 0700/0600 이 전달된다(뮤턴트 M34)', () => {
  it('mkdir 은 0o700 · tmp 는 0o600 으로 만든다', async () => {
    const fx = await setup()
    await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })
    // 실 권한이 아니라 **계약 전달**을 본다(win32 는 mode 를 무시한다 — 정정 67).
    expect(fx.fs.calls.find((c) => c.op === 'mkdirRecursive')?.args).toEqual([AUTHORITY_DIR, 0o700])
    expect(fx.fs.calls.find((c) => c.op === 'openExclusive')?.args).toEqual([fx.tmpPath, 0o600])
  })
})

/**
 * **중첩·분리 호출은 전부 큐잉된다 — 재진입 가드를 철회했다**(Codex PR#266 3R P1-2).
 *
 * DYN-06 이 찾은 「같은 bench 중첩 `await` = 영구 hang」은 사실이고, 그것을 throw 로 바꾸는 가드를 넣었다가
 * **되돌렸다**. 가드가 거짓 양성 3종을 연달아 냈기 때문이다 — ⓐ첫 구역이 `await` 중일 때 도착한 무관한
 * 호출 ⓑ구역 종료 후에도 상속된 ALS 컨텍스트 ⓒ`finally` 보다 먼저 도는 분리 마이크로태스크
 * (실측: `queueMicrotask` 후속이 해제 이전에 실행된다). 거짓 양성은 **정당한 fire-and-forget 후속을
 * unhandled rejection 으로 만들어 프로세스를 죽일 수 있고**, 참 양성은 개발 시점에 즉시 드러나는 hang 이다.
 * 비용이 비대칭이라 **항상 큐잉**으로 되돌렸고, 중첩 `await` 위험은 `withAuthority` 계약 주석에 명시했다.
 */
describe('중첩·분리 호출은 전부 큐잉된다(Codex 3R P1-2)', () => {
  it('queueMicrotask 로 띄운 분리 후속이 throw 하지 않는다(3R P1-2 의 정확한 시나리오)', async () => {
    const fx = await setup()
    let followUp: Promise<string> | undefined
    await fx.store.withAuthority(fx.lease, () => {
      // `finally` 가 돌기 **전에** 실행되는 마이크로태스크 — 가드가 있으면 여기서 unhandled rejection.
      queueMicrotask(() => {
        followUp = fx.store.withAuthority(fx.lease, () => Promise.resolve('후속'))
      })
      return Promise.resolve('바깥')
    })
    await expect(followUp).resolves.toBe('후속')
  })

  it('setTimeout 으로 띄운 분리 후속도 진입한다', async () => {
    const fx = await setup()
    const later = await new Promise<string>((resolve) => {
      void fx.store.withAuthority(fx.lease, () => {
        setTimeout(() => {
          resolve(fx.store.withAuthority(fx.lease, () => Promise.resolve('나중')))
        }, 5)
        return Promise.resolve('바깥')
      })
    })
    expect(later).toBe('나중')
  })

  it('다른 bench 중첩은 진입한다(뮤텍스 키가 분리돼 있다)', async () => {
    const a = await setup()
    const otherLease = await mintLease(newUlid())
    const r = await a.store.withAuthority(a.lease, () =>
      a.store.withAuthority(otherLease, () => Promise.resolve('다른 bench')),
    )
    expect(r).toBe('다른 bench')
  })
})

describe('판정 순서 · tx 수명 보강(뮤턴트 M3 · M29 · DYN-05)', () => {
  /**
   * **토큰 소진이 리스 검사보다 앞이다**(계획 정정 80 첫째). 두 검사를 맞바꾼 뮤턴트 M3 는 479/479 GREEN
   * 이었다 — 둘을 **동시에** 위반하는 입력이 스위트에 없었기 때문이다. 여기서 그 입력을 만든다.
   */
  it('소진된 토큰을 남의 리스로 제출하면 read-token-spent 가 이긴다', async () => {
    const benchId = newUlid()
    const a = await acquire(benchId)
    const b = await acquire(benchId)
    const fs = createFakeDurableFs()
    const store = createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
      sleep: neverSleeps,
    })
    const token = await store.withAuthority(a.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      await tx.compareAndSwap(read.read, draft(benchId)) // 여기서 소진된다
      return read.read as never
    })
    // 이 토큰은 **소진됐고 동시에 남의 것**이다 — 순서가 뒤집히면 foreign-owner 가 나온다.
    const r = await store.withAuthority(b.lease, (tx) => tx.compareAndSwap(token, draft(benchId)))
    expect(r.kind).toBe('read-token-spent')
  })

  it('유출된 tx 의 readFresh 도 죽는다(뮤턴트 M29 — 절반만 핀돼 있었다)', async () => {
    const fx = await setup()
    const captured: AuthorityTxLike[] = []
    await fx.store.withAuthority(fx.lease, (tx) => {
      captured.push(tx)
      return Promise.resolve(null)
    })
    const leaked = captured[0]
    const before = fx.fs.calls.length
    expect(leaked?.readFresh()).toEqual({ kind: 'lease-invalid', reason: 'released' })
    expect(fx.fs.calls.length).toBe(before)
  })

  /** 복제 토큰 경로가 **실제로 `compareAndSwap` 을 부른다**(DYN-05: 원안은 조기 return 으로 vacuous 였다). */
  it('복제 토큰의 compareAndSwap 은 정품 토큰을 들고 와도 거부한다', async () => {
    const fx = await setup()
    const token = await fx.store.withAuthority(fx.lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return Promise.resolve(read.read as never)
    })
    const cloned: BenchLeaseToken = {
      ...fx.lease,
      identity: { commonGitDir: '/other/.git', benchRoot: '/other', benchId: newUlid() },
    }
    const before = fx.fs.calls.length
    const r = await fx.store.withAuthority(cloned, (tx) =>
      tx.compareAndSwap(token, draft(fx.benchId)),
    )
    expect(r).toEqual({ kind: 'lease-invalid', reason: 'stolen' })
    expect(fx.fs.calls.length).toBe(before)
  })
})

describe('직렬화 완결성 보강(뮤턴트 M20 · M32 · M33 · TP-6 · TP-7 · F4)', () => {
  it('activeActivity 를 실은 커밋은 commit.activityId 를 발급한다(TP-6)', async () => {
    const fx = await setup()
    const activity: BenchActivityRecord = {
      activityId: 'ACT-1',
      kind: 'run',
      generation: 1,
      ownerToken: 'owner-x',
      execGate: 'gated',
      startedAt: AT,
    }
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(fx.benchId, { activeActivity: activity }))
    })
    expect(r.kind === 'committed' && r.commit.activityId).toBe('ACT-1')
    // **F4**: 참조 통과가 아니라 6필드 재조립이어야 한다 — 초과 키가 디스크에 새지 않는다.
    const onDisk: BenchAuthorityRecord = JSON.parse(fx.fs.readRaw(fx.path) ?? '{}')
    expect(Object.keys(onDisk.activeActivity ?? {}).sort()).toEqual([
      'activityId',
      'execGate',
      'generation',
      'kind',
      'ownerToken',
      'startedAt',
    ])
    expect(r.kind === 'committed' && r.record.activeActivity).not.toBe(activity)
  })

  it('draft 의 초과 키는 디스크에 기록되지 않는다(F4 · 명시 재구성)', async () => {
    const fx = await setup()
    await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, {
        ...draft(fx.benchId),
        몰래끼운키: '유출',
      } as BenchAuthorityDraft)
    })
    expect(fx.fs.readRaw(fx.path)).not.toContain('몰래끼운키')
  })

  it('두 임계 구역의 최종 상태가 FIFO 순서를 증언한다(TP-7)', async () => {
    const fx = await setup()
    const run = (gen: number): Promise<CasResult> =>
      fx.store.withAuthority(fx.lease, async (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'absent' && read.kind !== 'found') throw new Error('예상 밖')
        await Promise.resolve()
        return tx.compareAndSwap(read.read, draft(fx.benchId, { sourceGeneration: gen }))
      })
    const [a, b] = await Promise.all([run(1), run(2)])
    // revision 이 1·2 로 순서대로 배정되고 최종 디스크는 **나중 것**이다 — LIFO 면 여기서 RED 다.
    expect([
      a.kind === 'committed' && a.record.revision,
      b.kind === 'committed' && b.record.revision,
    ]).toEqual([1, 2])
    const onDisk: BenchAuthorityRecord = JSON.parse(fx.fs.readRaw(fx.path) ?? '{}')
    expect(onDisk.sourceGeneration).toBe(2)
    expect(onDisk.revision).toBe(2)
  })

  it('발급된 토큰은 동결돼 있다(뮤턴트 M32 · M33)', async () => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      expect(Object.isFrozen(read.read)).toBe(true)
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })
    expect(r.kind === 'committed' && Object.isFrozen(r.commit)).toBe(true)
  })

  /**
   * **뮤텍스 키 = 자원 도메인**(뮤턴트 M20 · perf-7). 키를 `authorityDir`+`benchId` 로 맞춘 이유는
   * `pathFor` 가 그 두 성분으로만 경로를 만들기 때문이다 — 키가 자원보다 세밀하면 같은 파일을 두 임계
   * 구역이 동시에 변이할 수 있고, 거칠면 무관한 bench 가 서로를 막는다.
   *
   * ⚠ **정직**: 원안(identity 3필드)의 「세밀함」이 만드는 fail-open 은 **도달 불가**다 — 아래가 그 이유를
   * 고정한다. `benchRoot` 만 다른 두 리스가 같은 파일을 노리면 불변식 9(identity 정확 일치)가 **레코드
   * 수준에서** 서로를 거부한다. 그래서 이 변경은 보안 수정이 아니라 「직렬화 도메인과 자원 도메인을
   * 일치시킨다」는 정합 수정이고, 그 사실을 여기 적어 둔다(과장 금지).
   */
  it('benchRoot 만 다른 리스는 불변식 9 가 레코드 수준에서 거부한다(키 입도 차이는 도달 불가)', async () => {
    const benchId = newUlid()
    const a = await acquire(benchId, '/wb-a')
    const b = await acquire(benchId, '/wb-b')
    const fs = createFakeDurableFs()
    const store = createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
      sleep: neverSleeps,
    })
    const commit = async (lease: BenchLeaseToken, benchRoot: string): Promise<CasResult> =>
      store.withAuthority(lease, async (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'absent' && read.kind !== 'found') {
          // 두 번째 리스는 여기로 온다 — 그것이 이 테스트의 요지다.
          return { kind: 'lease-invalid', reason: 'identity-mismatch' } as CasResult
        }
        return tx.compareAndSwap(read.read, {
          ...draft(benchId),
          identity: { commonGitDir: COMMON_GIT_DIR, benchRoot, benchId },
        })
      })

    expect((await commit(a.lease, '/wb-a')).kind).toBe('committed')
    // 같은 파일을 다른 benchRoot 로 노리면 읽기가 identity-mismatch 라 CAS 에 도달조차 못 한다.
    const second = await commit(b.lease, '/wb-b')
    expect(second).toEqual({ kind: 'lease-invalid', reason: 'identity-mismatch' })
    // 첫 커밋이 덮이지 않았다.
    const onDisk: BenchAuthorityRecord = JSON.parse(
      fs.readRaw(join(AUTHORITY_DIR, `${benchId}.json`)) ?? '{}',
    )
    expect(onDisk.identity.benchRoot).toBe('/wb-a')
    expect(onDisk.revision).toBe(1)
  })
})

/**
 * **TOCTOU — `statKind` 와 `readFileUtf8` 사이**(자체 적대 리뷰 perf-1 · SEC-8 · TP-11). 페이크의 `before`
 * 훅은 이 창을 재현하려고 신설됐는데 소비자가 0 이었다. 상한·종류 검사가 그 창에서 우회 가능함을
 * **정직하게** 고정한다 — 방어가 완전하다고 주장하지 않고, 무엇이 남았는지를 테스트가 증언한다.
 */
describe('TOCTOU 잔여 창 — 정직 고정(perf-1 · SEC-8)', () => {
  const storeOn = (fs: FakeDurableFs): ReturnType<typeof createBenchAuthorityStore> =>
    createBenchAuthorityStore(fs, {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
      sleep: neverSleeps,
    })

  it('statKind 이후 파일이 사라지면 io-failure{step:read} 로 fail-closed 한다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const path = join(AUTHORITY_DIR, `${benchId}.json`)
    // 훅이 페이크를 참조해야 하는데 페이크가 훅을 받는다 — 전방 참조를 **const 홀더**로 끊는다.
    const hook: { onRead?: () => void } = {}
    const fs = createFakeDurableFs({
      initial: { [path]: JSON.stringify(validRecord(benchId)) },
      // statKind 는 통과시키고, 그 직후 읽기 **직전**에 외부가 지운다.
      before: (op) => {
        if (op === 'readFileUtf8') hook.onRead?.()
      },
    })
    hook.onRead = () => fs.remove(path)
    const r = await storeOn(fs).withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(r.kind).toBe('io-failure')
    expect(r.kind === 'io-failure' && r.step).toBe('read')
  })

  it('statKind 이후 교체되면 상한·종류 검사가 우회된다 — 잔여 창을 은폐하지 않는다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const path = join(AUTHORITY_DIR, `${benchId}.json`)
    const hook: { onRead?: () => void } = {}
    let swapped = false
    const fs = createFakeDurableFs({
      initial: { [path]: JSON.stringify(validRecord(benchId)) },
      before: (op) => {
        if (op === 'readFileUtf8' && !swapped) {
          swapped = true
          hook.onRead?.()
        }
      },
    })
    hook.onRead = () => fs.setFile(path, JSON.stringify(validRecord(benchId, { revision: 2 })))
    const r = await storeOn(fs).withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    // 교체본을 읽는다 = 상한·종류 검사는 statKind 시점 값이다. **이 창은 PR2b 가 닫지 않는다**(정직 선언).
    expect(r.kind === 'found' && r.record.revision).toBe(2)
  })
})

/* ================================================================================================
 * Codex PR#266 P1 x3 + CodeRabbit 수렴 — 전부 실측 확정 후 반영
 * ============================================================================================= */

/**
 * **P1-1 — 늦게 도착한 독립 호출은 큐잉된다**(Codex + CodeRabbit 독립 수렴).
 *
 * 재진입 가드의 판정 근거가 모듈 전역 「실행 중」 집합이면, 첫 임계 구역이 `await` 하는 사이 도착한
 * **무관한 호출**(다음 tick 의 IPC 핸들러 등)까지 throw 해 정당한 동시성이 죽는다 — 뮤텍스가 「같은 tick 에
 * 함께 시작한 호출」에만 작동하게 된다. 기존 §3-T17d·FIFO 행이 이것을 놓친 이유는 **두 호출을 같은 tick 에
 * 시작**하기 때문이다(그 시점엔 보유 집합이 비어 있다). 판정은 `AsyncLocalStorage` 로 한다.
 */
describe('늦게 도착한 동시 호출은 큐잉된다(Codex P1-1 · CodeRabbit 수렴)', () => {
  it('첫 콜백이 실행 중일 때 외부 호출이 도착해도 throw 하지 않고 진입한다', async () => {
    const fx = await setup()
    const first = fx.store.withAuthority(fx.lease, async () => {
      await new Promise((r) => setTimeout(r, 0))
      return 'a'
    })
    await Promise.resolve() // 첫 구역이 실행에 들어간 뒤
    const second = fx.store.withAuthority(fx.lease, () => Promise.resolve('b'))
    expect(await Promise.all([first, second])).toEqual(['a', 'b'])
  })

  it('타이머 경계를 넘어 도착해도 큐잉된다(진입 상태가 유지되는 동안)', async () => {
    const fx = await setup()
    let firstDone = false
    const a = fx.store.withAuthority(fx.lease, async () => {
      await new Promise((r) => setTimeout(r, 30))
      firstDone = true
      return 'A'
    })
    await new Promise((r) => setTimeout(r, 10))
    const b = await fx.store.withAuthority(fx.lease, () => Promise.resolve('B'))
    expect(b).toBe('B')
    expect(firstDone).toBe(true) // B 가 A 를 앞지르지 않았다.
    expect(await a).toBe('A')
  })
})

/**
 * **P1-2 — 커밋 identity 는 깊게 동결된다**(Codex P1).
 *
 * `Object.freeze` 는 얕다. `mintCommit` 이 `record.identity` 를 **참조로** 실으면
 * `Object.assign(result.record.identity, {benchId: 다른bench})` 가 **커밋의 identity 까지 바꾼다** —
 * 바깥 객체는 동결·유효한 채로 남으므로 런처가 그 크레덴셜을 소비하면 **한 bench 용 커밋이 다른 bench 로
 * 재조준**된다(CAS 없이). 실측으로 확정됐고, 형제 `locks.ts` 는 리스 민팅에서 같은 이유로 중첩까지 얼린다.
 */
describe('커밋 크레덴셜은 재조준되지 않는다(Codex P1-2)', () => {
  const commit = async (): Promise<{ fx: Fixture; r: CasResult }> => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })
    return { fx, r }
  }

  it('record.identity·commit.identity 가 둘 다 동결돼 있다', async () => {
    const { r } = await commit()
    expect(r.kind).toBe('committed')
    if (r.kind !== 'committed') return
    expect(Object.isFrozen(r.record.identity)).toBe(true)
    expect(Object.isFrozen(r.commit.identity)).toBe(true)
  })

  it('record.identity 를 변조해도 commit.identity 가 따라 바뀌지 않는다(별칭 아님)', async () => {
    const { fx, r } = await commit()
    if (r.kind !== 'committed') throw new Error('committed 예상')
    // 두 객체가 **다른 참조**여야 한다 — 같으면 한쪽 변조가 다른 쪽에 전파된다.
    expect(r.commit.identity).not.toBe(r.record.identity)
    expect(r.commit.identity.benchId).toBe(fx.benchId)
    // 동결이므로 변조 시도 자체가 실패한다(ESM = strict mode).
    expect(() => Object.assign(r.record.identity, { benchId: 'RETARGETED' })).toThrow(TypeError)
    expect(r.commit.identity.benchId).toBe(fx.benchId)
  })
})

/**
 * **P1-3 — CAS 는 토큰의 필드를 신뢰하지 않는다**(Codex P1 · 가장 무거운 건).
 *
 * 스프레드 복제 `{...read, observedRevision: 현재값}` 은 미export 브랜드를 보존하면서 **새 객체**라
 * 소진 원장에 없고 `leaseOwnerToken` 검사도 통과한다. 그리고 CAS 의 디스크 재독은 그 **공격자가 고른**
 * `observedRevision` 과 디스크를 비교하므로 백스톱이 되지 못한다.
 *
 * ⚠ **실측 확정**: 수정 전에는 소진된 옛 토큰의 복제로 `committed` 를 받아 디스크가 rev 2→3 으로 전진하며
 * **실제 읽기 이후 추가된 통합 4필드가 지워졌다**. 자체 적대 리뷰(F6)가 이 벡터를 찾았으나 refuter 가
 * 「재독이 백스톱」이라며 P3 로 강등했고 **그 근거가 틀렸다** — Codex 가 정정했다. 그래서 판정·값 모두
 * 모듈 스코프 `MINTED_READS` 원장에서 온다(형제 `MINTED_LEASES` 와 같은 규율).
 */
describe('읽기 토큰 출처 검증 — 필드를 신뢰하지 않는다(Codex P1-3)', () => {
  /**
   * ⚠ **같은 임계 구역 안에서** 위조한다. Codex 2R P1-B 로 토큰이 발급 tx 에 결속됐으므로 교차 구역
   * 제출은 `foreign-owner` 가 **먼저** 잡는다 — 원장 방어를 격리 검증하려면 tx 결속을 통과시켜야 한다.
   * (교차 구역 거부는 아래 별도 행이 본다.)
   */
  it('스프레드 복제 + observedRevision 위조로 stale 덮어쓰기가 되지 않는다', async () => {
    const fx = await setup()
    fx.fs.setFile(
      fx.path,
      JSON.stringify(
        validRecord(fx.benchId, {
          revision: 2,
          currentIntegrationTxnId: 'T2',
          currentIntegrationStage: 'composed',
          currentIntegrationTxnGeneration: 1,
          currentIntegrationResultOid: 'oid2',
        }),
      ),
    )

    const attack = await fx.store.withAuthority(fx.lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'found') throw new Error('found 예상')
      // **위조** — 캐스트 0개로 컴파일된다(브랜드가 스프레드에서 보존된다).
      const forged: FreshReadToken = { ...read.read, observedRevision: 2 }
      return tx.compareAndSwap(forged, draft(fx.benchId, { sourceGeneration: 1 }))
    })

    expect(attack).toEqual({ kind: 'lease-invalid', reason: 'stolen' })
    // 디스크가 **한 바이트도** 바뀌지 않았다 — 통합 필드 보존이 이 행의 핵심이다.
    const after: BenchAuthorityRecord = JSON.parse(fx.fs.readRaw(fx.path) ?? '{}')
    expect([after.revision, after.currentIntegrationTxnId]).toEqual([2, 'T2'])
    expect(after.currentIntegrationResultOid).toBe('oid2')
    expect(fx.fs.countOf('rename')).toBe(0)
  })

  it('필드를 그대로 베낀 복제도 거부한다(원장 부재)', async () => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      const cloned: FreshReadToken = { ...read.read }
      return tx.compareAndSwap(cloned, draft(fx.benchId))
    })
    expect(r).toEqual({ kind: 'lease-invalid', reason: 'stolen' })
    expect(fx.fs.countOf('rename')).toBe(0)
  })

  /**
   * **발급 tx 결속**(Codex PR#266 2R P1-B). 미사용 정품 토큰을 밖으로 내보내 **다음** 임계 구역에서
   * 제출하면 §W-4 의 「같은 임계 구역」 계약이 깨지고 뮤텍스 밖에서 상태 의존 draft 를 조립할 수 있다.
   */
  it('미사용 정품 토큰도 다른 임계 구역에서는 거부된다', async () => {
    const fx = await setup()
    const escaped = await fx.store.withAuthority(fx.lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return Promise.resolve(read.read) // 소진하지 않고 유출
    })
    const r = await fx.store.withAuthority(fx.lease, (tx) =>
      tx.compareAndSwap(escaped, draft(fx.benchId)),
    )
    expect(r).toEqual({ kind: 'lease-invalid', reason: 'foreign-owner' })
    expect(fx.fs.countOf('rename')).toBe(0)
  })

  it('정품 토큰은 그대로 통과한다(가드가 과차단하지 않는다)', async () => {
    const fx = await setup()
    const r = await fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(fx.benchId))
    })
    expect(r.kind).toBe('committed')
  })
})

/* ================================================================================================
 * Codex PR#266 2R P1 x5 — 전부 실측·스펙 확인 후 반영
 * ============================================================================================= */

/**
 * **2R P1-D — 디렉터리 생성은 부모를 변경한다.**
 *
 * `mkdirRecursive` 로 권위 디렉터리를 만들면 새 엔트리는 **부모** 디렉터리에 생긴다. 그 부모를 fsync 하지
 * 않으면 전원 손실 시 `durability:'file+dir'` 로 `committed` 를 답했는데도 **권위 디렉터리 자체가 사라진다**
 * — 파일과 디렉터리는 내구화했지만 그것을 담은 엔트리는 아직 저널에 없기 때문이다.
 */
describe('디렉터리 생성 내구성(Codex 2R P1-D · 3R P1-1)', () => {
  interface Fresh {
    fs: FakeDurableFs
    store: ReturnType<typeof createBenchAuthorityStore>
    lease: BenchLeaseToken
    benchId: string
  }

  const freshStore = async (durability: 'file+dir' | 'file-only'): Promise<Fresh> => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const fs = createFakeDurableFs()
    return {
      fs,
      lease,
      benchId,
      store: createBenchAuthorityStore(fs, {
        authorityDir: AUTHORITY_DIR,
        durability,
        now: () => AT,
        sleep: neverSleeps,
      }),
    }
  }

  const commitOn = (h: Fresh, gen = 1): Promise<CasResult> =>
    h.store.withAuthority(h.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent' && read.kind !== 'found') throw new Error('예상 밖')
      return tx.compareAndSwap(read.read, draft(h.benchId, { sourceGeneration: gen }))
    })

  it('file+dir 첫 CAS 는 부모 디렉터리를 tmp 열기 전에 fsync 한다', async () => {
    const h = await freshStore('file+dir')
    expect((await commitOn(h)).kind).toBe('committed')
    const steps = h.fs.steps
    expect(steps.indexOf('mkdirRecursive')).toBeLessThan(steps.indexOf('openDir'))
    expect(steps.indexOf('openDir')).toBeLessThan(steps.indexOf('openExclusive'))
    expect(h.fs.calls.find((c) => c.op === 'openDir')?.args).toEqual([dirname(AUTHORITY_DIR)])
    expect(h.fs.countOf('openDir')).toBe(2) // 부모 + 권위 디렉터리
    expect(h.fs.openFdCount()).toBe(0)
  })

  it('두 번째 CAS 는 부모를 다시 fsync 하지 않는다', async () => {
    const h = await freshStore('file+dir')
    await commitOn(h, 1)
    const before = h.fs.countOf('openDir')
    await commitOn(h, 2)
    expect(h.fs.countOf('openDir')).toBe(before + 1) // 권위 디렉터리만
  })

  it('file-only 면 부모 fsync 를 하지 않는다(등급이 유일 권위)', async () => {
    const h = await freshStore('file-only')
    expect((await commitOn(h)).kind).toBe('committed')
    expect(h.fs.countOf('openDir')).toBe(0)
  })

  it('부모 fsync 실패는 커밋 전이라 io-failure{mkdir} 다(디스크 무변이)', async () => {
    const h = await freshStore('file+dir')
    h.fs.failNext('fsync', new Error('주입: 부모 fsync'))
    const r = await commitOn(h)
    expect(r.kind).toBe('io-failure')
    expect(r.kind === 'io-failure' && r.step).toBe('mkdir')
    // **대상 경로까지 핀한다**(CodeRabbit): step 만 보면 부모/권위 어느 쪽을 실어도 GREEN 이라
    // 「단계별로 실제 대상을 싣는다」는 이 경로의 규율이 새 단계에서 무신호로 깨진다.
    expect(r.kind === 'io-failure' && r.path).toBe(dirname(AUTHORITY_DIR))
    expect(h.fs.countOf('rename')).toBe(0)
    expect(h.fs.openFdCount()).toBe(0)
  })

  /**
   * **3R P1-1**: 판정이 「이번에 만들었는가」이면 생성 성공 + 부모 fsync 실패 조합에서 디렉터리는 남고,
   * 다음 CAS 는 「이미 있음」을 보고 건너뛴 채 `committed{file+dir}` 을 반환한다 — 부모가 미내구인데
   * `file+dir` 을 주장한다. store-지역 플래그는 **성공할 때까지** 재시도하므로 그 구멍이 닫힌다.
   */
  it('부모 fsync 가 실패하면 다음 CAS 가 다시 시도한다', async () => {
    const h = await freshStore('file+dir')
    h.fs.failNext('fsync', new Error('주입: 첫 시도만'))
    expect((await commitOn(h, 1)).kind).toBe('io-failure')

    const r = await commitOn(h, 2)
    expect(r.kind).toBe('committed')
    // 재시도가 실제로 **부모**를 향했다 — 첫 CAS 1회 + 둘째 CAS 1회.
    const parentSyncs = h.fs.calls.filter(
      (c) => c.op === 'openDir' && c.args[0] === dirname(AUTHORITY_DIR),
    )
    expect(parentSyncs).toHaveLength(2)
  })
})

/**
 * **2R P1-C — opts 는 생성 시점에 스냅샷된다**(형제 `locks.ts` 가 PR#264 P1 으로 확립한 규율).
 *
 * `readonly` 는 참조 객체를 얼리지 않는다. 클로저가 각 단계에서 다시 읽으면 뮤텍스·경로가 한 디렉터리를
 * 가리키는 동안 `mkdirRecursive` 나 dir fsync 가 **다른 디렉터리**를 향할 수 있다.
 */
describe('store 옵션은 생성 시점 스냅샷이다(Codex 2R P1-C)', () => {
  it('생성 후 opts 를 바꿔도 경로·등급이 따라 바뀌지 않는다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const fs = createFakeDurableFs()
    const mutable = {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only' as const,
      now: () => AT,
      sleep: neverSleeps,
    }
    const store = createBenchAuthorityStore(fs, mutable)

    // 호출자가 뒤에서 방향을 돌린다.
    Object.assign(mutable, { authorityDir: '/탈취된/경로', durability: 'file+dir' })

    const r = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, draft(benchId))
    })

    expect(r.kind).toBe('committed')
    // 원래 디렉터리에만 썼고, 등급도 생성 시점 값이다.
    expect(fs.paths()).toEqual([join(AUTHORITY_DIR, `${benchId}.json`)])
    expect(r.kind === 'committed' && r.commit.durability).toBe('file-only')
    expect(fs.countOf('openDir')).toBe(0) // file+dir 로 바뀌지 않았다
  })
})

/**
 * **2R P1-E — `resultOid` 는 stage >= composed 에서만 존재한다.**
 *
 * 정정 98 이 고아 resultOid 를 막으려고 통합 4필드를 무조건 묶었는데, `prepared` 단계에서는 resultOid 가
 * **아직 없다**(compose 에서 선기록된다 · 스펙 §W-7 `resultOid?: string // stage >= 'composed' 필수`).
 * 그래서 그 규칙은 **WAL 이 첫 단계에 진입조차 못 하게** 만들었다.
 */
describe('통합 WAL 단계별 resultOid 규칙(Codex 2R P1-E)', () => {
  const STAGE_PATH = ['prepared', 'composed', 'published', 'finalized'] as const

  /**
   * 목표 stage 까지 **WAL 순서대로 올라간 뒤** 마지막 draft 를 커밋한다.
   *
   * ⚠ 이전 판은 **첫 CAS 로 곧바로 목표 stage 를 만들었다**(픽스처 지름길). Codex PR#289 P1 이후
   * 「최초 레코드는 `prepared` 로만 통합을 시작한다」가 전이 불변식으로 서면서 그 지름길은 표현
   * 불가능해졌고, **지름길이 성립했다는 사실 자체가 결함**이었다 — 첫 CAS 가 `composed` 로 태어나면
   * WAL 의 `prepared` 단계와 그 크래시 안전 순서를 통째로 건너뛴다. 이 describe 가 검증하는 것은
   * **resultOid 규칙**이지 진입 경로가 아니므로, 경로만 합법으로 바꿔 의도를 보존한다.
   */
  const casWith = async (over: Partial<BenchAuthorityDraft>): Promise<CasResult> => {
    const fx = await setup()
    const target = over.currentIntegrationStage
    const climb =
      target === undefined || target === 'prepared' || target === 'abandoned'
        ? []
        : STAGE_PATH.slice(0, STAGE_PATH.indexOf(target))
    for (const stage of climb) {
      const step = await fx.store.withAuthority(fx.lease, async (tx) => {
        const read = tx.readFresh()
        if (read.kind !== 'absent' && read.kind !== 'found') throw new Error(read.kind)
        return tx.compareAndSwap(
          read.read,
          draft(fx.benchId, {
            currentIntegrationTxnId: 'T1',
            currentIntegrationStage: stage,
            currentIntegrationTxnGeneration: 1,
            ...(stage === 'prepared' ? {} : { currentIntegrationResultOid: 'oid1' }),
          }),
        )
      })
      if (step.kind !== 'committed') return step
    }
    return fx.store.withAuthority(fx.lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent' && read.kind !== 'found') throw new Error(read.kind)
      return tx.compareAndSwap(read.read, draft(fx.benchId, over))
    })
  }

  it('prepared 는 resultOid 없이 커밋된다(WAL 1단계 진입 가능)', async () => {
    const r = await casWith({
      currentIntegrationTxnId: 'T1',
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 1,
    })
    expect(r.kind).toBe('committed')
  })

  it.each(['composed', 'published', 'finalized'] as const)(
    '%s 는 resultOid 와 함께 커밋된다',
    async (stage) => {
      const r = await casWith({
        currentIntegrationTxnId: 'T1',
        currentIntegrationStage: stage,
        currentIntegrationTxnGeneration: 1,
        currentIntegrationResultOid: 'oid1',
      })
      expect(r.kind).toBe('committed')
    },
  )

  it.each(['composed', 'published', 'finalized'] as const)(
    '%s 인데 resultOid 가 없으면 invariant-violation(③d)',
    async (stage) => {
      const r = await casWith({
        currentIntegrationTxnId: 'T1',
        currentIntegrationStage: stage,
        currentIntegrationTxnGeneration: 1,
      })
      expect(r.kind).toBe('invariant-violation')
    },
  )

  it('prepared 인데 resultOid 가 있으면 invariant-violation(③c)', async () => {
    const r = await casWith({
      currentIntegrationTxnId: 'T1',
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 1,
      currentIntegrationResultOid: 'oid1',
    })
    expect(r.kind).toBe('invariant-violation')
  })

  it('TxnId 없는 고아 resultOid 는 여전히 거부된다(③b · 정정 98 의 원래 목적 보존)', async () => {
    const r = await casWith({ currentIntegrationResultOid: 'oid1' })
    expect(r.kind).toBe('invariant-violation')
  })

  /**
   * ⚠ **기대가 뒤집혔다**(Codex PR#289 P1 의 파급 · 은폐하지 않는다). 이전 판은 첫 CAS 로
   * `abandoned` 레코드를 만들어 「resultOid 를 요구하지 않는다」를 보였는데, 계획 정정 177 은
   * **권위 레코드가 `abandoned` 를 갖지 않는다**고 못박았다 — 포기는 단계를 남기는 게 아니라 통합
   * 4필드를 **소거**하는 것이다. 즉 이전 기대는 **어떤 생산자도 만들지 않는 상태**를 정상으로
   * 고정하고 있었고, 「최초는 prepared 로만」이 서면서 그 모순이 드러났다.
   */
  it('abandoned 는 권위 레코드가 가질 수 있는 단계가 아니다(정정 177)', async () => {
    const r = await casWith({
      currentIntegrationTxnId: 'T1',
      currentIntegrationStage: 'abandoned',
      currentIntegrationTxnGeneration: 1,
    })
    expect(r.kind).toBe('invariant-violation')
  })
})
