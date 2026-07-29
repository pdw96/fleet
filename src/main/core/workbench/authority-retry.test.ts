import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { BenchActivityRecord, BenchAuthorityDraft, BenchAuthorityRecord } from './authority'
import {
  classifyStaleActivity,
  createBenchAuthorityStore,
  realBackoffSleep,
  reclaimDraft,
  RENAME_BACKOFF_MS,
} from './authority'
import { createFakeDurableFs, errno, type FakeDurableFs } from './__testing__/durable-fs-fake'
import { createFakeLockBackend, type FakeLockBackend } from './__testing__/lock-backend-fake'
import { type BenchLeaseToken, createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR2c T9 — rename 재시도(C4) · per-retry L-6 · gated-orphan **분류**(§3-T17·T17b·T17c·T17e·T17g).
 *
 * `authority-store.test.ts` 와 **파일을 나눈 이유**는 리뷰 가능성이다(그 파일은 이미 1,800행 초과이고,
 * 계획 §3 이 「T9 종료 시 프로덕션 물리행 >230 → T10 을 PR2c′ 로」를 사전 확정했으므로 파일 경계가
 * PR 경계와 일치하면 분리 비용이 0 이 된다). 픽스처는 **의도적으로 지역 정의**한다 — 공유 모듈을
 * `__testing__/` 에 두면 그 파일이 프로덕션으로 집계돼 구조 가드 4종과 캐스트 0 규율이 새로 걸린다.
 */

const COMMON_GIT_DIR = '/repo/.git'
const BENCH_ROOT = '/workbenches'
const AUTHORITY_DIR = join('/repo/.git/fleet', 'authority')
const AT = 1_700_000_000_000

interface Fixture {
  readonly fs: FakeDurableFs
  readonly backend: FakeLockBackend
  readonly lease: BenchLeaseToken
  readonly benchId: string
  readonly path: string
  readonly tmpPath: string
  readonly store: ReturnType<typeof createBenchAuthorityStore>
  /** 주입 `sleep` 이 받은 지연 — §3-T17g 의 유일한 관측면. */
  readonly delays: number[]
  /** 이 리스가 쥔 endpoint — `forceLose` 로 **탈취**(해제가 아니라)를 만든다. */
  readonly endpoint: string
  /**
   * 프리미티브 **직전** 훅을 나중에 건다 — 훅 본문이 픽스처 자신을 참조해야 하는데(예: 「1회차 rename
   * 직후 이 리스를 탈취한다」) 페이크의 `before` 는 생성 시점에 고정되기 때문이다.
   */
  onOp(fn: (op: string) => void): void
}

const setup = async (
  initial: Readonly<Record<string, string>> = {},
  durability: 'file+dir' | 'file-only' = 'file-only',
): Promise<Fixture> => {
  const benchId = newUlid()
  let hook: ((op: string) => void) | undefined
  const fs = createFakeDurableFs({ initial, before: (op) => hook?.(op) })
  const backend = createFakeLockBackend()
  const scope = createLockScope({
    identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT },
    backend,
  })
  const r = await scope.tryAcquireBenchLease(benchId)
  if (r.status !== 'acquired') throw new Error(`리스 획득 실패: ${r.status}`)
  const binds = backend.calls.filter((c) => c.op === 'bind')
  const endpoint = binds[binds.length - 1]?.endpoint
  if (endpoint === undefined) throw new Error('bind 기록 없음')

  const delays: number[] = []
  const store = createBenchAuthorityStore(fs, {
    authorityDir: AUTHORITY_DIR,
    durability,
    now: () => AT,
    // 실시간 대기 0 — 그리고 **지연 값 자체가 관측 대상**이 된다(fake timer 로는 수열 단언이 번거롭다).
    //
    // ⚠ **`Promise.resolve()` 로 두면 실물보다 느슨하다**(이 파일을 쓰다 실측으로 잡았다): 실 구현
    // `realBackoffSleep` 은 `setTimeout` = **매크로태스크** 경계를 만드는데 즉시 resolve 는 마이크로태스크
    // 라, 재시도 루프가 `withAuthority` 의 `finally`(=`live=false`)보다 **먼저** 재개된다. 그러면 정정 109
    // 의 유출 tx 봉쇄가 페이크 위에서만 무력해져 「방어가 없는 구현」과 구별되지 않는다. 대기 시간은
    // 0 으로 두되 **태스크 경계는 실물과 같게** 만든다(형제 `lock-backend-fake` 의 「실물보다 느슨하면
    // 안 된다」 규율).
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        delays.push(ms)
        setTimeout(resolve, 0)
      }),
  })
  return {
    fs,
    backend,
    lease: r.lease,
    benchId,
    path: join(AUTHORITY_DIR, `${benchId}.json`),
    tmpPath: join(AUTHORITY_DIR, `${benchId}.json.${r.lease.ownerToken}.tmp`),
    store,
    delays,
    endpoint,
    onOp: (fn) => void (hook = fn),
  }
}

const draft = (benchId: string, over: Partial<BenchAuthorityDraft> = {}): BenchAuthorityDraft => ({
  schemaVersion: 1,
  identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
  lifecycle: 'open',
  sourceGeneration: 1,
  ...over,
})

/** 한 번의 `withAuthority` 안에서 read → CAS 를 수행하는 최소 호출자. */
const casOnce = async (
  f: Fixture,
  next: BenchAuthorityDraft = draft(f.benchId),
): ReturnType<typeof f.store.withAuthority<import('./authority').CasResult>> =>
  f.store.withAuthority(f.lease, async (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent' && read.kind !== 'found') {
      throw new Error(`예상 밖 읽기: ${read.kind}`)
    }
    return tx.compareAndSwap(read.read, next)
  })

const EPERM = (): Error => errno('EPERM')

/* ================================================================================================
 * §3-T17 — 재시도 소진 · 재시도 대상/범위
 * ============================================================================================= */

describe('§3-T17 rename 재시도 — 소진 · 대상 · 범위', () => {
  it('대상 코드가 계속 실패하면 총 5회 시도 후 io-failure{rename} · 디스크 무변이', async () => {
    const f = await setup()
    // 초기 1회 + 재시도 4회 = 5. 여유분(6번째)까지 주입해 「6회 시도」 구현도 잡는다.
    f.fs.failSequence('rename', [EPERM(), EPERM(), EPERM(), EPERM(), EPERM(), EPERM()])

    const r = await casOnce(f)

    expect(r.kind).toBe('io-failure')
    expect(r.kind === 'io-failure' && r.step).toBe('rename')
    expect(f.fs.countOf('rename')).toBe(5)
    expect(f.delays).toEqual([10, 20, 40, 80])
    // 커밋되지 않았다 — 권위 파일 부재 · 자기 tmp 정리 · fd 누수 0.
    expect(f.fs.readRaw(f.path)).toBeUndefined()
    expect(f.fs.paths()).not.toContain(f.tmpPath)
    expect(f.fs.openFdCount()).toBe(0)
  })

  it('재시도 대상이 아닌 코드는 즉시 실패한다 — rename 1회 · 대기 0', async () => {
    for (const code of ['ENOENT', 'EISDIR', 'ENOSPC', 'EXDEV']) {
      const f = await setup()
      f.fs.failSequence('rename', [errno(code), null])

      const r = await casOnce(f)

      expect(r.kind, code).toBe('io-failure')
      expect(f.fs.countOf('rename'), code).toBe(1)
      expect(f.delays, code).toEqual([])
    }
  })

  it('`code` 가 없는 오류도 즉시 실패한다(기존 §3-T16 관용구 보호)', async () => {
    const f = await setup()
    // ⚠ 이 행이 없으면 `authority-store.test.ts` §3-T16 의 code-less 주입을 복사한 테스트가
    //    zero-retry 구현을 GREEN 으로 통과시킨다 — 그 파일에서는 code 부재가 **의도된 정답**이다.
    f.fs.failSequence('rename', [new Error('code 없음'), null])

    const r = await casOnce(f)

    expect(r.kind).toBe('io-failure')
    expect(f.fs.countOf('rename')).toBe(1)
    expect(f.delays).toEqual([])
  })

  it('재시도는 rename 단계에만 적용된다 — 앞선 단계는 1회만 시도한다', async () => {
    // 「쓰기 전체를 감싸 재시도」 구현의 유일한 falsifier. EPERM 은 **재시도 대상 코드**이므로
    // 코드로는 구분되지 않는다 — 단계로만 구분된다.
    for (const op of ['mkdirRecursive', 'openExclusive', 'writeAll', 'fsync'] as const) {
      const f = await setup()
      f.fs.failSequence(op, [EPERM(), null, null, null, null, null])

      const r = await casOnce(f)

      expect(r.kind, op).toBe('io-failure')
      expect(f.fs.countOf(op), op).toBe(1)
      expect(f.fs.countOf('rename'), op).toBe(0)
      expect(f.delays, op).toEqual([])
    }
  })
})

/* ================================================================================================
 * §3-T17b — 재시도 끝에 성공
 * ============================================================================================= */

describe('§3-T17b 재시도 끝에 성공 — 정확히 1회 커밋', () => {
  it('첫 3회 EPERM · 4회차 성공 → committed · revision +1 · tmp 재생성 없음', async () => {
    const f = await setup()
    f.fs.failSequence('rename', [EPERM(), EPERM(), EPERM(), null])

    const r = await casOnce(f)

    expect(r.kind).toBe('committed')
    expect(r.kind === 'committed' && r.record.revision).toBe(1)
    expect(f.fs.countOf('rename')).toBe(4)
    expect(f.delays).toEqual([10, 20, 40])
    // **정확히 1회 커밋**의 관측면 두 축: 디스크 revision 이 1(2 가 아니다) · tmp 를 다시 만들지 않았다
    // (`openExclusive` 1회 = 재시도가 쓰기 전체를 되감지 않았다는 직접 증거).
    const raw = f.fs.readRaw(f.path)
    expect(raw).toBeDefined()
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ revision: 1 })
    expect(f.fs.countOf('openExclusive')).toBe(1)
    expect(f.fs.paths()).not.toContain(f.tmpPath)
    expect(f.fs.openFdCount()).toBe(0)
  })

  it('성공 후에는 남은 백오프를 쓰지 않는다 — 마지막 시도 뒤 대기 없음', async () => {
    const f = await setup()
    f.fs.failSequence('rename', [EPERM(), null])

    await casOnce(f)

    // 대기는 **실패와 다음 시도 사이**에만 있다. `[10,20]` 이면 성공 뒤에도 잤다는 뜻이다.
    expect(f.delays).toEqual([10])
  })
})

/* ================================================================================================
 * §3-T17c — 재시도 중 리스 탈취(per-retry L-6)
 * ============================================================================================= */

describe('§3-T17c per-retry L-6 — 재시도 중 리스를 잃으면 이후 rename 이 없다', () => {
  it('첫 시도 실패 후 탈취 → rename 총 1회 · lease-invalid{stolen}', async () => {
    const f = await setup()
    // 1회차는 실패시키고, 그 **직전** 훅에서 리스를 탈취한다. 재검증이 매 시도 직전에 돌지 않으면
    // 2회차가 그대로 성공해 `committed` 가 되고 이 행이 RED 다.
    f.fs.failSequence('rename', [EPERM(), null, null, null, null])
    f.onOp((op) => {
      if (op === 'rename') f.backend.forceLose(f.endpoint)
    })

    const r = await casOnce(f)

    expect(r.kind).toBe('lease-invalid')
    expect(r.kind === 'lease-invalid' && r.reason).toBe('stolen')
    expect(f.fs.countOf('rename')).toBe(1)
    // 리스를 잃은 뒤에도 **자기 tmp 는 치운다**(다음 소유자의 파일은 건드리지 않는다).
    expect(f.fs.paths()).not.toContain(f.tmpPath)
    expect(f.fs.readRaw(f.path)).toBeUndefined()
  })

  it('임계 구역이 끝난 뒤에는 재시도가 이어지지 않는다(유출 tx 봉쇄 · 정정 109)', async () => {
    // 재시도가 이 모듈의 **첫 `await`** 를 만든다 — 그 전까지 CAS 는 동기 구간이라 임계 구역 밖으로
    // 샐 수 없었다. `fn` 이 CAS 를 await 하지 않고 반환하면 뮤텍스 꼬리와 `live` 가 먼저 해소되고,
    // 재시도 루프가 그 뒤에도 계속 돌면 **직렬화 경계 밖에서** 파일시스템을 변이한다.
    const f = await setup()
    f.fs.failSequence('rename', [EPERM(), null, null, null, null])

    let leaked: Promise<import('./authority').CasResult> | undefined
    await f.store.withAuthority(f.lease, (tx) => {
      const read = tx.readFresh()
      if (read.kind !== 'absent') throw new Error('absent 예상')
      leaked = tx.compareAndSwap(read.read, draft(f.benchId)) // ⚠ 의도적으로 await 하지 않는다
      return Promise.resolve()
    })

    const r = await leaked
    expect(r?.kind).toBe('lease-invalid')
    expect(r?.kind === 'lease-invalid' && r.reason).toBe('released')
    expect(f.fs.countOf('rename')).toBe(1)
    expect(f.fs.readRaw(f.path)).toBeUndefined()
  })

  it('첫 rename **이전**에 이미 잃었으면 rename 을 한 번도 하지 않는다', async () => {
    const f = await setup()
    f.backend.forceLose(f.endpoint)

    const r = await casOnce(f)

    expect(r.kind).toBe('lease-invalid')
    expect(f.fs.countOf('rename')).toBe(0)
  })
})

/* ================================================================================================
 * §3-T17g — 백오프 스케줄 · 실 sleep 구현
 * ============================================================================================= */

describe('§3-T17g 백오프 스케줄', () => {
  it('상수가 계약값이다', () => {
    expect([...RENAME_BACKOFF_MS]).toEqual([10, 20, 40, 80])
  })

  it('`realBackoffSleep` 은 타이머 하나를 예약하고 그 시간에 해소된다', async () => {
    // 프로덕션 기본 구현이 「즉시 resolve」로 착지하는 것을 막는 유일한 행이다(소비자는 PR7).
    vi.useFakeTimers()
    try {
      let done = false
      const p = realBackoffSleep(40).then(() => void (done = true))
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(39)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

/* ================================================================================================
 * §3-T17e 회수분 — gated-orphan **분류**(회수 CAS 호출부는 PR7 T30b)
 * ============================================================================================= */

const activity = (over: Partial<BenchActivityRecord> = {}): BenchActivityRecord => ({
  activityId: 'act-1',
  kind: 'run',
  generation: 3,
  ownerToken: 'owner-1',
  execGate: 'gated',
  startedAt: AT,
  ...over,
})

const record = (over: Partial<BenchAuthorityRecord> = {}): BenchAuthorityRecord => ({
  schemaVersion: 1,
  identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId: newUlid() },
  revision: 7,
  lifecycle: 'open',
  sourceGeneration: 3,
  writtenBy: { ownerToken: 'owner-1', at: AT, durability: 'file-only' },
  ...over,
})

describe('§3-T17e classifyStaleActivity — 판정만 하고 아무것도 변이하지 않는다', () => {
  it.each([
    ['활동 부재', undefined, 'none'],
    ['execGate: gated', activity({ execGate: 'gated' }), 'gated-orphan'],
    ['execGate: running', activity({ execGate: 'running' }), 'live-activity'],
  ] as const)('%s → %s', (_label, act, expected) => {
    const r = classifyStaleActivity(record(act === undefined ? {} : { activeActivity: act }))
    expect(r.kind).toBe(expected)
  })

  it('`running` 을 회수 적격으로 답하면 안 된다(fail-open 음성 통제)', () => {
    // 이 한 행이 T9(c) 의 존재 이유다: `running` 은 **살아있는 자식**을 뜻하고, 그것을 「0줄 실행」으로
    // 오분류해 변이하면 스펙이 스스로 fail-open 이라 부른 상태가 된다(§W-4 execGate 전이 시점).
    const r = classifyStaleActivity(record({ activeActivity: activity({ execGate: 'running' }) }))
    expect(r.kind).not.toBe('gated-orphan')
    expect(r.kind === 'live-activity' && r.activityId).toBe('act-1')
  })
})

describe('§3-T17e reclaimDraft — activeActivity 만 소멸한다', () => {
  it('나머지 전 필드가 바이트 동일하게 생존한다', () => {
    const before = record({
      activeActivity: activity(),
      archivedBranch: 'preserved',
      currentIntegrationTxnId: 'txn-9',
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 2,
      currentIntegrationResultOid: 'a'.repeat(40),
      completedIntegrationTxnId: 'txn-8',
    })

    const after = reclaimDraft(before)

    expect(after.activeActivity).toBeUndefined()
    // **세대는 되돌리지 않는다** — §W-8 완결 관측의 귀속이 sourceGeneration 에 걸려 있다.
    expect(after.sourceGeneration).toBe(before.sourceGeneration)
    expect(after.lifecycle).toBe(before.lifecycle)
    // 통합 4필드 + archivedBranch + schemaVersion + identity 가 **한 번에** 생존함을 바이트로 고정한다.
    // 필드별 단언으로 쪼개면 새 필드가 늘 때 누락이 무신호가 된다.
    const { activeActivity: _drop, revision: _r, writtenBy: _w, ...rest } = before
    expect(JSON.stringify(after)).toBe(JSON.stringify(rest))
  })

  it('저장소 배정 필드(revision·writtenBy)는 draft 에 실리지 않는다', () => {
    // 실으면 `compareAndSwap` 의 `hasOwn` 사전조건이 `invariant-violation` 으로 거부한다 —
    // 즉 이 함수의 산출물이 **그대로 CAS 인자로 쓰일 수 있어야** 한다.
    const after = reclaimDraft(record({ activeActivity: activity() }))
    expect(Object.hasOwn(after, 'revision')).toBe(false)
    expect(Object.hasOwn(after, 'writtenBy')).toBe(false)
  })

  it('산출물을 그대로 CAS 하면 커밋되고 활동만 사라진다(왕복)', async () => {
    const f = await setup()
    const seeded = record({
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId: f.benchId },
      revision: 1,
      activeActivity: activity({ generation: 3 }),
      sourceGeneration: 3,
    })
    f.fs.setFile(f.path, JSON.stringify(seeded))

    const r = await casOnce(f, reclaimDraft(seeded))

    expect(r.kind).toBe('committed')
    expect(r.kind === 'committed' && r.record.activeActivity).toBeUndefined()
    expect(r.kind === 'committed' && r.record.sourceGeneration).toBe(3)
    expect(r.kind === 'committed' && r.record.revision).toBe(2)
  })
})
