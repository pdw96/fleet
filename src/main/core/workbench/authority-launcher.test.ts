import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AuthorityCommit,
  BenchAuthorityDraft,
  BenchSpawnOptions,
  CasResult,
} from './authority'
import { createBenchAuthorityStore, createBenchLauncher } from './authority'
import { createFakeDurableFs } from './__testing__/durable-fs-fake'
import { createFakeLockBackend } from './__testing__/lock-backend-fake'
import { type BenchLeaseToken, createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR2c T10 — `BenchLauncher` 브랜드 · 커밋 원장 · 단일 사용(§W-4 계약 4항 · §3-T16b).
 *
 * ⚠ **이 PR 에 런처 소비자는 없다**(폐포 핀이 workbench 의 데스크톱 유입을 0 으로 강제하므로 배선은
 * PR7 T30b). 그래서 §3-T17f(「spawn 이 최종 acknowledged durability 이후」)와 CAS1→CAS2 시퀀서는
 * **여기서 쓰지 않는다** — 소비자가 없으면 테스트가 스스로 배열한 순서를 단언하게 되어 「프로덕션이
 * 순서를 지키는가」를 증명하지 못한다(계획 정정 102·PR7 이월). 이 파일이 고정하는 것은 **크레덴셜
 * 판정**이며 그것은 소비자 없이도 전부 관측 가능하다.
 */

const COMMON_GIT_DIR = '/repo/.git'
const BENCH_ROOT = '/workbenches'
const AUTHORITY_DIR = join('/repo/.git/fleet', 'authority')
const AT = 1_700_000_000_000
const ACTIVITY_ID = 'act-launch-1'

/**
 * 형제 두 스위트와 같은 **기록형**이다(CodeRabbit) — throw 로 두면 그 오류가 CAS `catch` 에서
 * `io-failure` 로 재라벨돼 무신호를 만든다(자가 적대 리뷰 F5 가 실측한 계열). 지금은 실패 주입이
 * 없어 발동하지 않지만, 훗날 이 스위트에 주입 행이 붙는 순간 같은 함정이 재발한다.
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

/** spawn 산출물 — 이 모듈은 자식을 **전달만** 하므로 최소 구조로 충분하다. */
const fakeChild = { pid: 4242 } as unknown as ChildProcess

interface SpawnSpy {
  readonly calls: { cmd: string; args: readonly string[]; opts: BenchSpawnOptions }[]
  readonly fn: (cmd: string, args: readonly string[], opts: BenchSpawnOptions) => ChildProcess
}

const spawnSpy = (): SpawnSpy => {
  const calls: { cmd: string; args: readonly string[]; opts: BenchSpawnOptions }[] = []
  return {
    calls,
    fn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return fakeChild
    },
  }
}

const mintLease = async (benchId: string): Promise<BenchLeaseToken> => {
  const scope = createLockScope({
    identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT },
    backend: createFakeLockBackend(),
  })
  const r = await scope.tryAcquireBenchLease(benchId)
  if (r.status !== 'acquired') throw new Error(`리스 획득 실패: ${r.status}`)
  return r.lease
}

/**
 * 실 CAS 로 커밋을 얻는다 — **커밋을 지어내지 않는 것이 이 하네스의 계약**이다. 브랜드는 미export 라
 * 테스트가 캐스트로 만들 수도 있지만, 그러면 원장 검사가 통째로 vacuous 해진다.
 */
const commitFor = async (
  execGate: 'gated' | 'running',
  over: Partial<BenchAuthorityDraft> = {},
): Promise<{ commit: AuthorityCommit; benchId: string; sourceGeneration: number }> => {
  const benchId = newUlid()
  const lease = await mintLease(benchId)
  const store = createBenchAuthorityStore(createFakeDurableFs(), {
    authorityDir: AUTHORITY_DIR,
    durability: 'file-only',
    now: () => AT,
    sleep: neverSleeps,
  })
  const sourceGeneration = 5
  const result: CasResult = await store.withAuthority(lease, async (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent') throw new Error('absent 예상')
    return tx.compareAndSwap(read.read, {
      schemaVersion: 1,
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
      lifecycle: 'open',
      sourceGeneration,
      activeActivity: {
        activityId: ACTIVITY_ID,
        kind: 'run',
        generation: sourceGeneration,
        ownerToken: lease.ownerToken,
        execGate,
        startedAt: AT,
      },
      ...over,
    })
  })
  if (result.kind !== 'committed') throw new Error(`커밋 실패: ${result.kind}`)
  return { commit: result.commit, benchId, sourceGeneration }
}

const expectedFor = (
  benchId: string,
  sourceGeneration: number,
): {
  identity: { commonGitDir: string; benchRoot: string; benchId: string }
  sourceGeneration: number
  activityId: string
} => ({
  identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
  sourceGeneration,
  activityId: ACTIVITY_ID,
})

describe('T10 런처 — 정상 경로', () => {
  it('게이트가 해제된 커밋이면 spawn 하고 자식을 그대로 돌려준다', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()
    const launch = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: expectedFor(benchId, sourceGeneration),
    })

    const r = launch('codex', ['--version'], { cwd: '/workbenches/a' })

    expect(r.kind).toBe('spawned')
    expect(r.kind === 'spawned' && r.child).toBe(fakeChild)
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]).toMatchObject({ cmd: 'codex', args: ['--version'] })
    expect(spy.calls[0]?.opts.cwd).toBe('/workbenches/a')
  })
})

describe('T10 런처 — 크레덴셜 거부(전부 spawn 0회)', () => {
  it('원장에 없는 커밋(복제·위조)은 commit-not-minted', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()
    // ⚠ **캐스트 0개로 컴파일된다** — 브랜드 `unique symbol` 은 스프레드에서 보존되고 결과는 새 객체다.
    //    읽기 토큰에서 실측 확정된 것과 같은 벡터이며, 단일 사용 WeakSet 만으로는 잡히지 않는다.
    const cloned: AuthorityCommit = { ...commit }
    const launch = createBenchLauncher({
      spawn: spy.fn,
      commit: cloned,
      expected: expectedFor(benchId, sourceGeneration),
    })

    const r = launch('codex', [], {})

    expect(r.kind).toBe('refused')
    expect(r.kind === 'refused' && r.reason).toBe('commit-not-minted')
    expect(spy.calls).toHaveLength(0)
  })

  it('한 커밋으로 두 번 띄울 수 없다 — 두 번째는 commit-spent', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()
    const launch = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: expectedFor(benchId, sourceGeneration),
    })

    expect(launch('codex', [], {}).kind).toBe('spawned')
    const second = launch('codex', [], {})

    expect(second.kind).toBe('refused')
    expect(second.kind === 'refused' && second.reason).toBe('commit-spent')
    expect(spy.calls).toHaveLength(1)
  })

  it('같은 커밋으로 팩토리를 다시 만들어도 소진은 유지된다(원장은 모듈 스코프)', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()
    const deps = { spawn: spy.fn, commit, expected: expectedFor(benchId, sourceGeneration) }

    expect(createBenchLauncher(deps)('codex', [], {}).kind).toBe('spawned')
    const again = createBenchLauncher(deps)('codex', [], {})

    // 소진을 팩토리-지역 플래그로 구현하면 이 행이 RED 다 — 「한 커밋 = 한 자식」이 깨진다.
    expect(again.kind === 'refused' && again.reason).toBe('commit-spent')
    expect(spy.calls).toHaveLength(1)
  })

  it('게이트가 열리지 않은 커밋(CAS1)은 gate-not-released', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('gated')
    const spy = spawnSpy()
    const launch = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: expectedFor(benchId, sourceGeneration),
    })

    const r = launch('codex', [], {})

    // 이 행이 없으면 §W-4 의 「launcher 에 넘기는 것은 commit2」가 **관례로만** 존재한다 — 배선자가
    // commit1 을 넘겨도 전 게이트 GREEN 인 채 「디스크 gated + 살아있는 자식」이 만들어진다.
    expect(r.kind === 'refused' && r.reason).toBe('gate-not-released')
    expect(spy.calls).toHaveLength(0)
  })

  it('활동이 없는 커밋(회수 CAS 등)도 gate-not-released', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const store = createBenchAuthorityStore(createFakeDurableFs(), {
      authorityDir: AUTHORITY_DIR,
      durability: 'file-only',
      now: () => AT,
      sleep: neverSleeps,
    })
    const result = await store.withAuthority(lease, async (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      return tx.compareAndSwap(read.read, {
        schemaVersion: 1,
        identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
        lifecycle: 'open',
        sourceGeneration: 5,
      })
    })
    if (result.kind !== 'committed') throw new Error('커밋 실패')
    const spy = spawnSpy()

    const r = createBenchLauncher({
      spawn: spy.fn,
      commit: result.commit,
      expected: expectedFor(benchId, 5),
    })('codex', [], {})

    expect(r.kind === 'refused' && r.reason).toBe('gate-not-released')
    expect(spy.calls).toHaveLength(0)
  })

  it.each([
    [
      'identity-mismatch',
      (b: string, g: number) => ({
        ...expectedFor(b, g),
        identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId: newUlid() },
      }),
    ],
    [
      'activity-mismatch',
      (b: string, g: number) => ({ ...expectedFor(b, g), activityId: 'act-다른것' }),
    ],
    [
      'generation-mismatch',
      (b: string, g: number) => ({ ...expectedFor(b, g), sourceGeneration: g + 1 }),
    ],
  ] as const)('expected 가 어긋나면 %s — 커밋 재조준 차단', async (reason, mutate) => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()

    const r = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: mutate(benchId, sourceGeneration),
    })('codex', [], {})

    expect(r.kind === 'refused' && r.reason).toBe(reason)
    expect(spy.calls).toHaveLength(0)
  })

  it('거부된 커밋은 소진되지 않는다 — 올바른 expected 로 다시 만들면 뜬다', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()

    const wrong = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: { ...expectedFor(benchId, sourceGeneration), activityId: '틀린-활동' },
    })('codex', [], {})
    expect(wrong.kind).toBe('refused')

    const right = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: expectedFor(benchId, sourceGeneration),
    })('codex', [], {})

    // 거부가 커밋을 태워버리면 정상 재시도가 불가능해진다(소진은 **spawn 직전**에만).
    expect(right.kind).toBe('spawned')
    expect(spy.calls).toHaveLength(1)
  })
})

describe('T10 런처 — spawn 실패', () => {
  it('spawn 이 던져도 커밋은 이미 소진됐다(같은 근거로 재시도 불가)', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    let attempts = 0
    const failing = (): ChildProcess => {
      attempts += 1
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    const launch = createBenchLauncher({
      spawn: failing,
      commit,
      expected: expectedFor(benchId, sourceGeneration),
    })

    // 오류는 **전파**한다 — 런처는 크레덴셜 판정자이지 spawn 오류 처리자가 아니다.
    // 실패 후 활동 종결 CAS 는 §W-4 가 호출자에게 지운 책임이고 배선은 PR7 T30b 다.
    //
    // ⚠ **실 seam 의 지배적 실패 형태는 이것이 아니다**(정직 표기 · 자가 적대 리뷰 F4): cross-spawn 은
    // 대개 자식 객체를 돌려준 뒤 **비동기 `'error'` 이벤트**로 ENOENT 를 알린다. 여기서 고정하는 것은
    // 「spawn 이 동기로 던지는 경우에도 커밋이 이미 소진돼 있다」는 소진 시점 계약이며, 비동기 실패의
    // 관측·활동 종결은 시퀀서(PR7)의 몫이다. 라벨을 ENOENT 로 둔 것은 형태가 아니라 사유의 예시다.
    expect(() => launch('없는명령', [], {})).toThrow(/ENOENT/)
    expect(attempts).toBe(1)

    // 소진을 spawn **이후**로 미루면 이 행이 GREEN 이 되어 「한 커밋 = 한 자식」이 무한 재시도로 샌다.
    const retry = createBenchLauncher({
      spawn: failing,
      commit,
      expected: expectedFor(benchId, sourceGeneration),
    })('없는명령', [], {})

    expect(retry.kind === 'refused' && retry.reason).toBe('commit-spent')
    expect(attempts).toBe(1)
  })
})

describe('T10 런처 — 스냅숏 규율', () => {
  it('팩토리 생성 뒤 deps 를 바꿔도 대조가 무력화되지 않는다', async () => {
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()
    const expected = { ...expectedFor(benchId, sourceGeneration), activityId: '틀린-활동' }
    const launch = createBenchLauncher({ spawn: spy.fn, commit, expected })

    // 팩토리가 참조를 계속 읽으면 이 한 줄이 대조를 통과시킨다.
    expected.activityId = ACTIVITY_ID
    const r = launch('codex', [], {})

    expect(r.kind === 'refused' && r.reason).toBe('activity-mismatch')
    expect(spy.calls).toHaveLength(0)
  })

  it('`expected.identity` 도 스냅숏이다 — 중첩 객체를 참조로 들면 RED', async () => {
    // 위 행은 **최상위 한 필드**(`activityId`)만 덮어 `identity` 를 참조로 들고 있는 구현이 통과했다
    // (자가 적대 리뷰 DYN4-04). 형제 `mintCommit` 이 중첩까지 얼리는 것과 같은 이유다.
    const { commit, benchId, sourceGeneration } = await commitFor('running')
    const spy = spawnSpy()
    const identity = { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId: newUlid() }
    const launch = createBenchLauncher({
      spawn: spy.fn,
      commit,
      expected: { ...expectedFor(benchId, sourceGeneration), identity },
    })

    identity.benchId = benchId // 팩토리가 참조를 들고 있으면 이 한 줄이 대조를 통과시킨다.
    const r = launch('codex', [], {})

    expect(r.kind === 'refused' && r.reason).toBe('identity-mismatch')
    expect(spy.calls).toHaveLength(0)
  })
})
