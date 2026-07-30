import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AuthorityCommit,
  BenchAuthorityDraft,
  FreshReadToken,
  IntegrationStage,
} from './authority'
import { createBenchAuthorityStore } from './authority'
import { createFakeDurableFs, errno, type FakeDurableFs } from './__testing__/durable-fs-fake'
import { createFakeLockBackend } from './__testing__/lock-backend-fake'
import type { IntegrationTxnDraft, IntegrationTxnRecord } from './journal'
import {
  canAdvanceStage,
  classifyJournalFileName,
  createJournalStore,
  digestAuthorityDraft,
  isActiveJournalStage,
  journalEntryPath,
  selectJournalTxnIds,
  SUPPORTED_JOURNAL_SCHEMA,
} from './journal'
import { type BenchLeaseToken, createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR3b T13a′ — 통합 WAL 저널 코어(§W-7 「저널 매체 계약」).
 *
 * 대응 §3 행: **T64**(배치·tmp 문법) · **T65**(열거 7종) · **T66**(전이 전수) · **T67**(버전 스큐) ·
 * **T68**(rename 재시도) · **T69**(크레덴셜) · **T70**(리스) · **T71**(불변 필드·조건부 결속).
 *
 * 전량 주입 페이크 위에서 돌아 **양 OS 가 같은 행을 실행**한다(§3.1 대응 ⓐ · fs mock 금지 = §1 전제 5).
 */

const COMMON_GIT_DIR = '/repo/.git'
const BENCH_ROOT = '/workbenches'
const JOURNAL_DIR = join('/repo/.git/fleet', 'journal')
const AUTHORITY_DIR = join('/repo/.git/fleet', 'authority')
const AT = 1_700_000_000_000
const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

const STAGES: readonly IntegrationStage[] = [
  'prepared',
  'composed',
  'published',
  'finalized',
  'abandoned',
]

/**
 * 이 스위트의 기본 시나리오는 **재시도를 타지 않는다** — 여기서 백오프가 발동하면 회귀다.
 * 재시도 계약 자체는 아래 「§3-T68」 절이 `sleepCalls` 를 **직접 소비**해 단언한다(형제
 * `authority-store.test.ts:49-60` 규율 — 던지지 않고 기록만 한다).
 */
const sleepCalls: number[] = []
const recordingSleep = (ms: number): Promise<void> => {
  sleepCalls.push(ms)
  return Promise.resolve()
}
/** 소비하지 않은 백오프를 다음 테스트로 흘리지 않는다. */
const takeSleeps = (): number[] => sleepCalls.splice(0)

/** 기본 임계 구역 생존 신호 — 닫힌 구역 경로는 아래 전용 테스트가 따로 본다(Codex PR#269 P1). */
const alive = (): boolean => true

afterEach(() => {
  expect(sleepCalls.splice(0), '백오프가 발동했는데 그 테스트가 소비하지 않았다').toEqual([])
})

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

const authorityDraft = (benchId: string): BenchAuthorityDraft => ({
  schemaVersion: SUPPORTED_JOURNAL_SCHEMA,
  identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
  lifecycle: 'open',
  sourceGeneration: 1,
})

/**
 * 실 `AuthorityCommit` 을 얻는 유일한 경로 = **실제 CAS 를 돌린다**. 페이크 fs 를 저널과 **분리**하는
 * 이유는 관측면 오염이다 — 같은 fs 를 쓰면 §3-T64 의 「저널 디렉터리 밖 파일 0」 스냅숏에 권위 파일이 섞인다.
 */
const mintCommitFor = async (lease: BenchLeaseToken, benchId: string): Promise<AuthorityCommit> => {
  const store = createBenchAuthorityStore(createFakeDurableFs(), {
    authorityDir: AUTHORITY_DIR,
    durability: 'file-only',
    now: () => AT,
    sleep: recordingSleep,
  })
  const commit = await store.withAuthority(lease, async (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent') throw new Error(`예상 밖 읽기 결과: ${read.kind}`)
    const cas = await tx.compareAndSwap(read.read, authorityDraft(benchId))
    if (cas.kind !== 'committed') throw new Error(`CAS 실패: ${cas.kind}`)
    return cas.commit
  })
  return commit
}

/** 같은 형태로 얻는 `FreshReadToken` — 첫 단계 크레덴셜이다(정정 175). */
const mintReadFor = async (lease: BenchLeaseToken): Promise<FreshReadToken> => {
  const store = createBenchAuthorityStore(createFakeDurableFs(), {
    authorityDir: AUTHORITY_DIR,
    durability: 'file-only',
    now: () => AT,
    sleep: recordingSleep,
  })
  return store.withAuthority(lease, (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent') throw new Error(`예상 밖 읽기 결과: ${read.kind}`)
    return Promise.resolve(read.read)
  })
}

interface Fixture {
  readonly fs: FakeDurableFs
  readonly lease: BenchLeaseToken
  readonly release: () => void
  readonly benchId: string
  readonly txnId: string
  readonly path: string
  readonly tmpPath: string
  readonly store: ReturnType<typeof createJournalStore>
  readonly read: FreshReadToken
}

const setup = async (
  initial: Readonly<Record<string, string>> = {},
  durability: 'file+dir' | 'file-only' = 'file-only',
): Promise<Fixture> => {
  const benchId = newUlid()
  const txnId = newUlid()
  const fs = createFakeDurableFs({ initial })
  const { lease, release } = await acquire(benchId)
  const store = createJournalStore(fs, {
    journalDir: JOURNAL_DIR,
    durability,
    sleep: recordingSleep,
  })
  const path = join(JOURNAL_DIR, benchId, `${txnId}.json`)
  return {
    fs,
    lease,
    release,
    benchId,
    txnId,
    path,
    tmpPath: `${path}.${lease.ownerToken}.tmp`,
    store,
    read: await mintReadFor(lease),
  }
}

const draftOf = (
  f: Pick<Fixture, 'benchId' | 'txnId'>,
  over: Partial<IntegrationTxnDraft> = {},
): IntegrationTxnDraft => ({
  txnId: f.txnId,
  benchId: f.benchId,
  repoCommonGitDir: COMMON_GIT_DIR,
  benchRoot: BENCH_ROOT,
  sourceBranch: `fleet/bench-${f.benchId}`,
  sourceSnapshot: OID_A,
  sourceGeneration: 1,
  targetBranch: 'main',
  targetHeadBeforeIntegration: OID_B,
  resultRef: `refs/fleet/integrated/${f.benchId}/${f.txnId}`,
  startedAt: AT,
  ownerEngineId: 'engine-1',
  stage: 'prepared',
  expectedAuthorityRevision: 0,
  nextAuthorityStage: 'prepared',
  integrationGeneration: 1,
  draftDigest: 'a'.repeat(64),
  ...over,
})

/** 디스크에 놓을 기존 엔트리(문자열). `over` 로 형태 위반을 주입한다. */
const serialized = (
  f: Pick<Fixture, 'benchId' | 'txnId'>,
  over: Record<string, unknown> = {},
): string => JSON.stringify({ schemaVersion: SUPPORTED_JOURNAL_SCHEMA, ...draftOf(f), ...over })

describe('저널 배치·tmp 문법 (§3-T64)', () => {
  it('엔트리는 <journalDir>/<benchId>/<txnId>.json 에만 생기고 tmp 는 같은 디렉터리에 만든다', async () => {
    const f = await setup()
    const before = f.fs.paths()
    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r.kind).toBe('written')
    expect(f.fs.paths()).toEqual([...before, f.path].sort())
    // tmp 는 대상과 같은 디렉터리 · rename 성공 후 부재(정정 165ⓐ·ⓑ)
    const tmpArgs = f.fs.calls.filter((c) => c.op === 'openExclusive').map((c) => c.args[0])
    expect(tmpArgs).toEqual([f.tmpPath])
    expect(f.fs.paths()).not.toContain(f.tmpPath)
    // 「<benchId> 디렉터리 밖에 어떤 저널 파일도 만들지 않는다」 — flat 배치 구현이 RED
    expect(f.fs.paths().filter((p) => !before.includes(p))).toEqual([
      join(JOURNAL_DIR, f.benchId, `${f.txnId}.json`),
    ])
    expect(f.fs.calls.filter((c) => c.op === 'mkdirRecursive').map((c) => c.args[0])).toEqual([
      join(JOURNAL_DIR, f.benchId),
    ])
  })

  it('경로 유도 헬퍼는 ULID 문법 위반을 거부한다(경로 성분 주입 차단)', () => {
    const benchId = newUlid()
    const txnId = newUlid()
    expect(journalEntryPath(JOURNAL_DIR, benchId, txnId)).toBe(
      join(JOURNAL_DIR, benchId, `${txnId}.json`),
    )
    expect(journalEntryPath(JOURNAL_DIR, '../evil', txnId)).toBeUndefined()
    expect(journalEntryPath(JOURNAL_DIR, benchId, '..')).toBeUndefined()
    expect(journalEntryPath(JOURNAL_DIR, benchId, benchId.toLowerCase())).toBeUndefined()
  })

  it('내구 쓰기 단계 순서를 고정한다 · file-only 는 디렉터리 fsync 0(음성 통제)', async () => {
    const f = await setup()

    expect((await f.store.append(f.lease, draftOf(f), f.read, alive)).kind).toBe('written')

    // 순서가 바뀌면(예: fsync 전에 rename) 내구성이 사라지는데 결과 종별은 그대로다 — 그래서 **순서
    // 자체**를 관측한다(형제 스위트가 `steps` 를 단언하는 이유).
    expect(f.fs.steps.filter((s) => s !== 'statKind')).toEqual([
      'mkdirRecursive',
      'openExclusive',
      'writeAll',
      'fsync',
      'close',
      'rename',
    ])
    // `file-only` 에서 디렉터리 내구화를 시도하면 **갖지 않은 내구성을 주장**하는 것이다(U4 의 쌍대).
    expect(f.fs.countOf('openDir')).toBe(0)
  })

  it('초과 키를 실은 draft 를 써도 디스크에는 재구성물만 나간다', async () => {
    const f = await setup()
    // own enumerable `constructor` 는 구조적 서브타이핑으로 실려 온다(`Omit` 의 초과 프로퍼티 검사는
    // 객체 리터럴에만 걸린다). 그대로 직렬화하면 그 파일은 자기 `read()` 에서 프로토타입 오염으로
    // `invalid` 이 되어 **이후 모든 append 가 `existing-unreadable` 로 고착**한다.
    const polluted = Object.assign({}, draftOf(f), { constructor: 'x' })

    const r = await f.store.append(f.lease, polluted, f.read, alive)

    expect(r.kind).toBe('written')
    if (r.kind === 'written') expect(Object.keys(r.record)).not.toContain('constructor')
    expect(f.fs.readRaw(f.path) ?? '').not.toContain('constructor')
    // 자기 파서가 그 파일을 다시 읽고, 후속 전이도 가능해야 한다(고착 부재의 종단 증거).
    expect(f.store.read(f.benchId, f.txnId).kind).toBe('found')
    const commit = await mintCommitFor(f.lease, f.benchId)
    const next = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision,
      }),
      commit,
      alive,
    )
    expect(next.kind).toBe('written')
  })

  it('호출자의 권위 임계 구역이 닫히면 rename 하지 않는다(유출된 쓰기 차단)', async () => {
    const f = await setup()
    // 백오프가 이 모듈의 첫 await 다 — 그 사이 호출자가 `withAuthority` 콜백을 끝내면 뮤텍스가 풀리고,
    // **리스는 여전히 유효**하므로 L-6 재검증으로는 못 막는다(Codex PR#269 P1).
    f.fs.failSequence('rename', [errno('EPERM'), null])
    // 호출 1 = 변이 직전 게이트 · 호출 2 = 1회차 rename · 호출 3 = 백오프 후 재시도(그때 구역이 닫혔다).
    let calls = 0
    const closingSection = (): boolean => (calls += 1) <= 2

    const r = await f.store.append(f.lease, draftOf(f), f.read, closingSection)

    expect(r).toEqual({ kind: 'section-closed' })
    expect(f.fs.countOf('rename')).toBe(1)
    expect(f.fs.paths()).toEqual([]) // 자기 tmp 는 치웠고 엔트리는 게시되지 않았다
    expect(takeSleeps()).toEqual([10])
  })

  it('임계 구역이 이미 닫혀 있으면 파일시스템을 만지지 않는다', async () => {
    const f = await setup()

    const r = await f.store.append(f.lease, draftOf(f), f.read, () => false)

    expect(r).toEqual({ kind: 'section-closed' })
    expect(f.fs.countOf('openExclusive')).toBe(0)
    expect(f.fs.countOf('mkdirRecursive')).toBe(0)
  })

  it('같은 tmp 경로의 append 가 겹치면 두 번째를 거부한다(서로의 tmp 를 지우는 사슬 차단)', async () => {
    const f = await setup()
    // 첫 append 가 rename EPERM 으로 **백오프에서 양보**하는 순간이 그 창이다(형제 authority.ts 가
    // Codex P1 으로 닫은 사슬 — 겹치면 B 의 `finally` 가 A 의 tmp 를 지운다).
    f.fs.failSequence('rename', [errno('EPERM'), null])

    const first = f.store.append(f.lease, draftOf(f), f.read, alive)
    const second = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(second.kind).toBe('invariant-violation')
    expect((await first).kind).toBe('written')
    expect(f.fs.paths()).toEqual([f.path])
    expect(takeSleeps()).toEqual([10])
  })

  it('id 문법 위반이면 파일시스템을 만지기 전에 거부한다', async () => {
    const f = await setup()
    const r = await f.store.append(f.lease, draftOf(f, { txnId: 'not-a-ulid' }), f.read, alive)

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.calls).toEqual([])
  })
})

describe('저널 열거 필터 7종 (§3-T65)', () => {
  const txnId = newUlid()

  it.each([
    [`${txnId}.json`, 'entry'],
    [`${txnId}.json.OWNERTOKEN.tmp`, 'ignored'],
    [`${txnId}.json.tmp`, 'ignored'],
    [`${txnId}.jsonx`, 'ignored'],
    [`${txnId}`, 'ignored'],
    [`${txnId.toLowerCase()}.json`, 'ignored'],
    ['not-a-ulid.json', 'ignored'],
    [`${txnId}extra.json`, 'ignored'],
    ['.json', 'ignored'],
  ])('%s → %s', (name, kind) => {
    expect(classifyJournalFileName(name).kind).toBe(kind)
  })

  it('tmp 잔재는 txnId 로 오독되지 않는다(필터 부재 구현이 RED)', () => {
    const residue = `${txnId}.json.OWNER.tmp`
    expect(selectJournalTxnIds([`${txnId}.json`, residue, 'README'])).toEqual([txnId])
    const verdict = classifyJournalFileName(residue)
    expect(verdict).toEqual({ kind: 'ignored', reason: 'tmp-residue' })
  })

  it('비정규 노드는 읽기 전에 거부한다(FIFO readFileUtf8 무기한 블록 차단)', async () => {
    const f = await setup()
    f.fs.setOther(f.path)

    const r = f.store.read(f.benchId, f.txnId)

    expect(r.kind).toBe('invalid')
    expect(f.fs.countOf('readFileUtf8')).toBe(0)
  })

  it('내부 txnId·benchId 가 경로와 어긋나면 invalid 다', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f, { txnId: newUlid() }))
    expect(f.store.read(f.benchId, f.txnId).kind).toBe('invalid')

    const g = await setup()
    g.fs.setFile(g.path, serialized(g, { benchId: newUlid() }))
    expect(g.store.read(g.benchId, g.txnId).kind).toBe('invalid')
  })
})

describe('WAL 전이 술어 전수 (§3-T66)', () => {
  const LEGAL: ReadonlySet<string> = new Set([
    'undefined→prepared',
    'prepared→composed',
    'composed→published',
    'published→finalized',
    'prepared→abandoned',
    'composed→abandoned',
    'published→abandoned',
    'finalized→abandoned',
    'abandoned→abandoned',
  ])

  it('초기 진입 5값 + 5×5 전수 = 합법 9쌍만 통과한다', () => {
    const froms: readonly (IntegrationStage | undefined)[] = [undefined, ...STAGES]
    const actual: string[] = []
    for (const from of froms) {
      for (const to of STAGES) {
        if (canAdvanceStage(from, to)) actual.push(`${String(from)}→${to}`)
      }
    }
    expect(actual.sort()).toEqual([...LEGAL].sort())
  })

  it('역행·부활·자기 전이를 거부한다', () => {
    expect(canAdvanceStage('published', 'prepared')).toBe(false)
    expect(canAdvanceStage('abandoned', 'composed')).toBe(false)
    expect(canAdvanceStage('composed', 'composed')).toBe(false)
    expect(canAdvanceStage(undefined, 'composed')).toBe(false)
  })

  it('활성 저널 집합은 {prepared, composed} 뿐이다(C6 · spec §W-7)', () => {
    expect(STAGES.filter((s) => isActiveJournalStage(s))).toEqual(['prepared', 'composed'])
  })

  it('append 가 전이를 강제한다 — 디스크의 현재 엔트리와 비교한다(정정 178)', async () => {
    const f = await setup()
    f.fs.setFile(
      f.path,
      serialized(f, {
        stage: 'published',
        publishedAt: AT,
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'published',
      }),
    )
    const commit = await mintCommitFor(f.lease, f.benchId)

    const r = await f.store.append(
      f.lease,
      draftOf(f, { stage: 'prepared', expectedAuthorityRevision: commit.revision }),
      commit,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('rename')).toBe(0)
    expect(f.fs.readRaw(f.path)).toContain('"stage":"published"')
  })

  it('엔트리 부재에서 prepared 가 아니면 거부한다', async () => {
    const f = await setup()
    const commit = await mintCommitFor(f.lease, f.benchId)
    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision,
      }),
      commit,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('openExclusive')).toBe(0)
  })
})

describe('저널 버전 스큐 (§3-T67)', () => {
  it('지원 초과 schemaVersion 은 문법 위반보다 먼저 판정된다', async () => {
    const f = await setup()
    // 초과 버전 **∧** 형태 위반 — 문법을 먼저 보는 구현은 invalid 를 답해 RED 다.
    f.fs.setFile(f.path, JSON.stringify({ schemaVersion: 2, txnId: 3 }))

    const r = f.store.read(f.benchId, f.txnId)

    expect(r).toMatchObject({
      kind: 'incompatible-version',
      found: 2,
      supported: SUPPORTED_JOURNAL_SCHEMA,
    })
  })

  it('읽을 수 없는 기존 엔트리는 덮어쓰지 않는다(I12 — 구 버전이 신 버전을 지우는 경로 차단)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, JSON.stringify({ schemaVersion: 99, txnId: f.txnId }))

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r.kind).toBe('existing-unreadable')
    expect(f.fs.countOf('rename')).toBe(0)
    expect(f.fs.countOf('unlinkIfExists')).toBe(0)
    expect(f.fs.readRaw(f.path)).toContain('"schemaVersion":99')
  })

  it('schemaVersion 형태 오류는 invalid 다(버전 스큐가 아니다)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, JSON.stringify({ ...JSON.parse(serialized(f)), schemaVersion: '1' }))
    expect(f.store.read(f.benchId, f.txnId).kind).toBe('invalid')
  })

  it.each(['__proto__', 'constructor'])(
    '%s 오염 키를 거부한다 — 나머지가 완전히 정상인 바이트로 단언한다',
    async (key) => {
      const f = await setup()
      // ⚠ 「깨진 JSON + 오염 키」로 단언하면 **형태 검사가 대신 잡아** 오염 키 검사를 지워도 GREEN 이다
      //   (뮤테이션 자기검사 실측). 그래서 **그 키 하나만** 다른 정상 레코드를 쓴다.
      f.fs.setFile(f.path, `{${JSON.stringify(key)}:{"polluted":true},${serialized(f).slice(1)}`)

      expect(f.store.read(f.benchId, f.txnId).kind).toBe('invalid')
    },
  )

  it('크기 상한 초과는 읽기 전에 거부한다', async () => {
    const f = await setup()
    f.fs.setFile(f.path, JSON.stringify({ pad: 'x'.repeat(70_000) }))

    const r = f.store.read(f.benchId, f.txnId)

    expect(r.kind).toBe('invalid')
    expect(f.fs.countOf('readFileUtf8')).toBe(0)
  })
})

describe('저널 rename 유한 재시도 (§3-T68 · C4 상속)', () => {
  it('EPERM 3연속 후 4회차 성공 — exact 호출 계수와 백오프 순서', async () => {
    const f = await setup()
    f.fs.failSequence('rename', [errno('EPERM'), errno('EPERM'), errno('EPERM'), null])

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r.kind).toBe('written')
    expect(f.fs.countOf('rename')).toBe(4)
    expect(takeSleeps()).toEqual([10, 20, 40])
    expect(f.fs.openFdCount()).toBe(0)
  })

  it('백오프 소진은 io-failure{step:rename} 이고 디스크는 무변이다', async () => {
    const f = await setup()
    f.fs.failNext('rename', errno('EPERM'), 5)

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r).toMatchObject({ kind: 'io-failure', step: 'rename', path: f.tmpPath })
    // exact 계수(초기 1 + 재시도 4)를 함께 고정한다 — 대기 시퀀스만 보면 「쓰기 전체를 감싸 재시도」
    // 하거나 상한을 다르게 센 구현이 통과한다(CodeRabbit PR#269).
    expect(f.fs.countOf('rename')).toBe(5)
    expect(takeSleeps()).toEqual([10, 20, 40, 80])
    expect(f.fs.paths()).not.toContain(f.path)
    expect(f.fs.paths()).not.toContain(f.tmpPath)
    expect(f.fs.openFdCount()).toBe(0)
  })

  it('비대상 errno 와 code 부재 오류는 재시도 0 이다', async () => {
    const f = await setup()
    f.fs.failNext('rename', errno('ENOENT'))
    expect((await f.store.append(f.lease, draftOf(f), f.read, alive)).kind).toBe('io-failure')
    expect(f.fs.countOf('rename')).toBe(1)
    expect(takeSleeps()).toEqual([])

    const g = await setup()
    g.fs.failNext('rename', new Error('code 없는 실패'))
    expect((await g.store.append(g.lease, draftOf(g), g.read, alive)).kind).toBe('io-failure')
    expect(g.fs.countOf('rename')).toBe(1)
    expect(takeSleeps()).toEqual([])
  })

  it('rename 전 실패는 io-failure 이고 자기 tmp 만 치운다', async () => {
    const f = await setup()
    f.fs.failNext('writeAll', errno('ENOSPC'))

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r).toMatchObject({ kind: 'io-failure', step: 'write', path: f.tmpPath })
    expect(f.fs.paths()).not.toContain(f.tmpPath)
    expect(f.fs.openFdCount()).toBe(0)
  })

  it('file+dir 에서 rename 후 디렉터리 내구 실패는 write-uncertain 이다(파일은 이미 게시됨)', async () => {
    const f = await setup({}, 'file+dir')
    // fsync 순서 = [영역 루트, journalDir, tmp 파일, **benchDir(post-commit)**] — 마지막만 실패시킨다.
    f.fs.failSequence('fsync', [null, null, null, errno('EIO')])

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r).toMatchObject({ kind: 'write-uncertain', step: 'fsync-dir' })
    expect(f.fs.paths()).toContain(f.path)
    expect(f.fs.openFdCount()).toBe(0)
  })
})

describe('저널 쓰기 크레덴셜 (§3-T69)', () => {
  it('첫 단계는 FreshReadToken 으로 쓸 수 있다', async () => {
    const f = await setup()
    expect((await f.store.append(f.lease, draftOf(f), f.read, alive)).kind).toBe('written')
  })

  it('첫 단계가 아니면 FreshReadToken 을 거부한다(직전 CAS 증거를 요구)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))

    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
      }),
      f.read,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('openExclusive')).toBe(0)
  })

  it('expectedAuthorityRevision 이 직전 커밋 revision 과 어긋나면 거부한다', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)

    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision + 1,
      }),
      commit,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('rename')).toBe(0)
  })

  it('직전 커밋 증거가 있으면 다음 단계를 쓴다', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)

    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision,
      }),
      commit,
      alive,
    )

    expect(r.kind).toBe('written')
    expect(f.fs.readRaw(f.path)).toContain('"stage":"composed"')
  })

  it('타 bench 의 커밋은 거부한다', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const other = await acquire(newUlid())
    const foreign = await mintCommitFor(other.lease, other.lease.identity.benchId)

    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: foreign.revision,
      }),
      foreign,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
  })

  it('타입을 우회한 빈 객체 크레덴셜도 **값으로** 거부한다(던지지 않는다)', async () => {
    const f = await setup()
    // 이 모듈은 실패를 전부 값으로 답하는 계약이다 — 여기서 던지면 호출자의 임계 구역이 리스를 쥔 채
    // 풀린다(CodeRabbit PR#269 지적).
    // @ts-expect-error — 브랜드 없는 객체. 컴파일 거부가 1차 방어이고 이 행은 그 **백스톱**을 본다.
    const r = await f.store.append(f.lease, draftOf(f), {}, alive)

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.calls).toEqual([])
  })

  it('크레덴셜 없이는 타입 수준에서 호출할 수 없다', async () => {
    const f = await setup()
    // @ts-expect-error — `prev` 인자 누락. **컴파일이 이 행의 단언**이고(직전 CAS 증거 없이 저널을 쓰는
    // 코드는 서지 않는다), 런타임 폴백도 값으로 거부하는지 함께 본다(타입 우회 경로의 백스톱).
    const r = await f.store.append(f.lease, draftOf(f), alive)

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.calls).toEqual([])
  })
})

describe('저널 쓰기는 bench 리스 아래에서만 (§3-T70)', () => {
  it('비민팅(복제) 리스면 파일시스템에 손대지 않는다', async () => {
    const f = await setup()
    const cloned: BenchLeaseToken = { ...f.lease }

    const r = await f.store.append(cloned, draftOf(f), f.read, alive)

    expect(r).toEqual({ kind: 'lease-invalid', reason: 'stolen' })
    expect(f.fs.calls).toEqual([])
  })

  it.each([
    ['benchRoot', { benchRoot: '/elsewhere' }],
    ['repoCommonGitDir', { repoCommonGitDir: '/other/.git' }],
    // ⚠ benchId 축이 가장 위험하다 — 통과하면 **A 의 리스로 B 의 디렉터리에 쓴다**(경로가 draft 에서
    // 유도되기 때문). 위 두 축만 단언하면 이 절이 그 구멍을 못 잡는다(뮤테이션 자기검사 실측).
    ['benchId', { benchId: newUlid() }],
  ])('리스 identity 와 레코드의 %s 가 어긋나면 거부한다', async (_name, over) => {
    const f = await setup()
    const r = await f.store.append(f.lease, draftOf(f, over), f.read, alive)

    expect(r).toEqual({ kind: 'lease-invalid', reason: 'identity-mismatch' })
    expect(f.fs.calls).toEqual([])
  })

  it('해제된 리스는 **변이 전에** 거부된다(tmp 잔재를 만들지 않는다)', async () => {
    const f = await setup()
    f.release()

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r).toMatchObject({ kind: 'lease-invalid', reason: 'released' })
    expect(f.fs.countOf('openExclusive')).toBe(0)
    expect(f.fs.countOf('mkdirRecursive')).toBe(0)
    expect(f.fs.paths()).toEqual([])
  })

  it('재시도 회차 중간에 리스를 잃으면 그 뒤 rename 을 시도하지 않는다(L-6 동형)', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const { lease, release } = await acquire(benchId)
    let renames = 0
    // 1회차 rename 이 **실패하는 그 순간** 리스를 잃게 만든다 — 재검증이 루프 밖에 한 번만 있는
    // 구현은 2회차에 성공해 「남의 리스 아래에서 게시」한다(authority.ts:1360-1367 과 같은 축).
    const fs = createFakeDurableFs({
      before: (op) => {
        if (op !== 'rename') return
        renames += 1
        if (renames === 1) release()
      },
    })
    const store = createJournalStore(fs, {
      journalDir: JOURNAL_DIR,
      durability: 'file-only',
      sleep: recordingSleep,
    })
    fs.failNext('rename', errno('EPERM'), 1)
    const read = await mintReadFor(lease)

    const out = await store.append(lease, draftOf({ benchId, txnId }), read, alive)

    expect(out).toMatchObject({ kind: 'lease-invalid' })
    expect(renames).toBe(1)
    expect(takeSleeps()).toEqual([10])
    expect(fs.paths()).toEqual([])
  })

  it('tmp 이름의 ownerToken 은 리스에서만 온다', async () => {
    const f = await setup()
    f.fs.failNext('rename', errno('ENOENT'))

    await f.store.append(f.lease, draftOf(f), f.read, alive)

    const opened = f.fs.calls.find((c) => c.op === 'openExclusive')?.args[0]
    expect(opened).toBe(`${f.path}.${f.lease.ownerToken}.tmp`)
  })
})

describe('불변 필드·조건부 결속 (§3-T71)', () => {
  const advance = async (
    f: Fixture,
    over: Partial<IntegrationTxnDraft>,
  ): ReturnType<Fixture['store']['append']> => {
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)
    return f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision,
        ...over,
      }),
      commit,
      alive,
    )
  }

  // ⚠ **12필드 중 8개만 여기서 단언 가능**하다(정직 표기): `txnId`·`benchId`·`repoCommonGitDir`·
  // `benchRoot` 는 그 전에 **리스 identity 대조와 경로 유도**가 이미 고정하므로, 이 경로까지 「바뀐 채로」
  // 도달할 수 없다 — 즉 그 4행은 **구조적으로 구성 불가**이지 누락이 아니다.
  it.each([
    ['sourceSnapshot', { sourceSnapshot: OID_C }],
    ['sourceBranch', { sourceBranch: 'other' }],
    ['targetBranch', { targetBranch: 'other' }],
    ['targetHeadBeforeIntegration', { targetHeadBeforeIntegration: OID_C }],
    ['sourceGeneration', { sourceGeneration: 2 }],
    ['resultRef', { resultRef: 'refs/other' }],
    ['startedAt', { startedAt: AT + 1 }],
    ['ownerEngineId', { ownerEngineId: 'engine-2' }],
  ])('단계 전진에서 %s 가 바뀌면 거부한다', async (_name, over) => {
    const f = await setup()
    expect((await advance(f, over)).kind).toBe('invariant-violation')
  })

  it('불변 필드가 그대로면 통과한다(양성 대조 — 「무조건 거부」 뮤턴트 차단)', async () => {
    const f = await setup()
    expect((await advance(f, {})).kind).toBe('written')
  })

  /**
   * **전이가 합법인 상태를 만들어 놓고** 조건부 결속만 어긴다.
   *
   * ⚠ 이 헬퍼가 없으면 이 절이 **vacuous** 다(자가 적대 리뷰 CONFIRMED): 엔트리 부재에서 `composed`·
   * `published`·`abandoned` 를 제출하면 **전이 검사가 먼저** 거부하므로, 조건부 규칙 4개를 통째로
   * 지워도 전 스위트가 GREEN 이 된다. 두 방어가 같은 입력을 함께 잡는 전형적인 가림이다.
   */
  const seededAppend = async (
    existing: Record<string, unknown>,
    over: Partial<IntegrationTxnDraft>,
  ): Promise<{ f: Fixture; r: Awaited<ReturnType<Fixture['store']['append']>> }> => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f, existing))
    const commit = await mintCommitFor(f.lease, f.benchId)
    const r = await f.store.append(
      f.lease,
      draftOf(f, { expectedAuthorityRevision: commit.revision, ...over }),
      commit,
      alive,
    )
    return { f, r }
  }

  const COMPOSED_ENTRY = {
    stage: 'composed',
    resultOid: OID_C,
    resultTree: OID_A,
    nextAuthorityStage: 'composed',
    previousAuthorityStage: 'prepared',
  }

  it.each([
    [
      'composed 인데 resultOid 부재',
      {},
      { stage: 'composed', nextAuthorityStage: 'composed', previousAuthorityStage: 'prepared' },
    ],
    [
      'published 인데 publishedAt 부재',
      COMPOSED_ENTRY,
      {
        stage: 'published',
        nextAuthorityStage: 'published',
        previousAuthorityStage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
      },
    ],
    [
      'abandoned 인데 abandonReason 부재',
      {},
      {
        stage: 'abandoned',
        nextAuthorityStage: undefined,
        previousAuthorityStage: 'prepared',
        abandonedAt: AT,
      },
    ],
    [
      'abandoned 인데 nextAuthorityStage 존재',
      {},
      {
        stage: 'abandoned',
        nextAuthorityStage: 'abandoned' as IntegrationStage,
        previousAuthorityStage: 'prepared',
        abandonedAt: AT,
        abandonReason: 'user-abandon' as const,
      },
    ],
  ])('전이는 합법인데 조건부 결속 위반: %s', async (_name, existing, over) => {
    const { f, r } = await seededAppend(existing, over as Partial<IntegrationTxnDraft>)

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('rename')).toBe(0)
  })

  it('그 픽스처가 결속을 지키면 통과한다(양성 대조 — 「무조건 거부」 뮤턴트 차단)', async () => {
    const { r } = await seededAppend(COMPOSED_ENTRY, {
      stage: 'published',
      nextAuthorityStage: 'published',
      previousAuthorityStage: 'composed',
      resultOid: OID_C,
      resultTree: OID_A,
      publishedAt: AT,
    })

    expect(r.kind).toBe('written')
  })

  it.each([
    ['비-abandoned 인데 stage ≠ nextAuthorityStage', { nextAuthorityStage: 'finalized' }],
    // `prepared` 는 정의상 결과가 없다(형제 권위 불변식 ③c) — 있으면 이후 판정이 성립하지 않는
    // 「값 비교」 분기로 들어간다.
    ['prepared 인데 resultOid·resultTree 가 있다', { resultOid: OID_C, resultTree: OID_A }],
    ['draftDigest 가 빈 문자열', { draftDigest: '' }],
    ['resultRef 가 빈 문자열', { resultRef: '' }],
    ['expectedAuthorityRevision 이 음수', { expectedAuthorityRevision: -1 }],
  ])('조건부 결속 위반: %s', async (_name, over) => {
    const f = await setup()
    const r = await f.store.append(
      f.lease,
      draftOf(f, over as Partial<IntegrationTxnDraft>),
      f.read,
      alive,
    )
    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('rename')).toBe(0)
  })

  it('포기 엔트리는 nextAuthorityStage 부재로 기록된다(정정 177)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)

    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'abandoned',
        nextAuthorityStage: undefined,
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision,
        abandonedAt: AT,
        abandonReason: 'user-abandon',
      }),
      commit,
      alive,
    )

    expect(r.kind).toBe('written')
    const raw = f.fs.readRaw(f.path) ?? ''
    expect(raw).toContain('"stage":"abandoned"')
    expect(raw).not.toContain('nextAuthorityStage')
  })

  it('기록된 엔트리는 다시 읽힌다(왕복) · schemaVersion 은 store 가 찍는다', async () => {
    const f = await setup()
    await f.store.append(f.lease, draftOf(f), f.read, alive)

    const r = f.store.read(f.benchId, f.txnId)

    expect(r.kind).toBe('found')
    if (r.kind !== 'found') return
    const expected: IntegrationTxnRecord = {
      schemaVersion: SUPPORTED_JOURNAL_SCHEMA,
      ...draftOf(f),
    }
    expect(r.record).toEqual(expected)
  })

  it('draft 가 schemaVersion 을 실어 와도 store 배정을 덮어쓰지 못한다', async () => {
    const f = await setup()
    // `Omit` 의 초과 프로퍼티 검사는 **객체 리터럴에만** 걸리므로 구조적으로 실려 올 수 있다
    // (형제 계획 정정 73 과 같은 구멍). 조용히 버리지 않고 **거부**하는 것이 계약이다.
    const carrying = Object.assign({}, draftOf(f), { schemaVersion: 99 })

    const r = await f.store.append(f.lease, carrying, f.read, alive)

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('rename')).toBe(0)
  })

  it('직렬화가 크기 상한을 넘으면 쓰지 않는다(읽기가 거부할 것을 쓰지 않는다)', async () => {
    const f = await setup()
    const r = await f.store.append(
      f.lease,
      draftOf(f, { sourceBranch: 'x'.repeat(70_000) }),
      f.read,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('openExclusive')).toBe(0)
  })

  it('초과 키는 재구성에서 탈락한다(디스크 재기록 오염 차단)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f, { evil: 'x' }))

    const r = f.store.read(f.benchId, f.txnId)

    expect(r.kind).toBe('found')
    if (r.kind !== 'found') return
    expect(Object.keys(r.record)).not.toContain('evil')
  })
})

describe('Codex PR#269 P1 — 결속·보존·경로 방어', () => {
  it('주장한 previousAuthorityStage 가 디스크 단계와 다르면 거부한다', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)

    // 전이(prepared → composed)는 합법인데 **결속이 거짓**이다 — 전이 검사만으로는 통과한다.
    const r = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'published',
        expectedAuthorityRevision: commit.revision,
      }),
      commit,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('rename')).toBe(0)
  })

  it('첫 엔트리는 previousAuthorityStage 가 있으면 거부된다(부재 == 디스크 부재)', async () => {
    const f = await setup()

    const r = await f.store.append(
      f.lease,
      draftOf(f, { previousAuthorityStage: 'prepared' }),
      f.read,
      alive,
    )

    expect(r.kind).toBe('invariant-violation')
  })

  const abandonDraft = (
    f: Fixture,
    commitRevision: number,
    over: Partial<IntegrationTxnDraft> = {},
  ): IntegrationTxnDraft =>
    draftOf(f, {
      stage: 'abandoned',
      nextAuthorityStage: undefined,
      previousAuthorityStage: 'prepared',
      expectedAuthorityRevision: commitRevision,
      abandonedAt: AT,
      abandonReason: 'user-abandon',
      ...over,
    })

  it('포기 엔트리는 **정확히 같은 내용**으로만 재기록된다(종결 증거 보존)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)
    const first = await f.store.append(f.lease, abandonDraft(f, commit.revision), commit, alive)
    expect(first.kind).toBe('written')
    const written = f.fs.readRaw(f.path)

    // 같은 내용 재생 = 허용(크래시 후 재시도가 막다른 길이 되면 안 된다)
    const replay = await f.store.append(f.lease, abandonDraft(f, commit.revision), commit, alive)
    expect(replay.kind).toBe('written')
    expect(f.fs.readRaw(f.path)).toBe(written)

    // 사유·시각이 다른 재기록 = 거부(원본 감사 증거가 그 자리에서 소멸한다)
    const rewritten = await f.store.append(
      f.lease,
      abandonDraft(f, commit.revision, { abandonReason: 'superseded', abandonedAt: AT + 5 }),
      commit,
      alive,
    )
    expect(rewritten.kind).toBe('invariant-violation')
    expect(f.fs.readRaw(f.path)).toBe(written)
  })

  it('같은 크레덴셜을 다른 전이에 재사용하면 거부한다(저널이 권위를 앞서지 않는다)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)
    const composed = draftOf(f, {
      stage: 'composed',
      resultOid: OID_C,
      resultTree: OID_A,
      nextAuthorityStage: 'composed',
      previousAuthorityStage: 'prepared',
      expectedAuthorityRevision: commit.revision,
    })

    expect((await f.store.append(f.lease, composed, commit, alive)).kind).toBe('written')

    // **같은 커밋**으로 다음 단계까지 쓰면 저널이 권위를 두 단계 앞선다.
    const reused = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'published',
        resultOid: OID_C,
        resultTree: OID_A,
        publishedAt: AT,
        nextAuthorityStage: 'published',
        previousAuthorityStage: 'composed',
        expectedAuthorityRevision: commit.revision,
      }),
      commit,
      alive,
    )

    expect(reused.kind).toBe('invariant-violation')
  })

  it('같은 전이의 정확 재시도는 계속 허용한다(양성 대조)', async () => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    const commit = await mintCommitFor(f.lease, f.benchId)
    const composed = draftOf(f, {
      stage: 'composed',
      resultOid: OID_C,
      resultTree: OID_A,
      nextAuthorityStage: 'composed',
      previousAuthorityStage: 'prepared',
      expectedAuthorityRevision: commit.revision,
    })
    // 1회차는 rename 실패로 끝난다 — 그 뒤 같은 크레덴셜로 재시도하는 것이 정상 경로다.
    f.fs.failNext('rename', errno('ENOENT'))
    expect((await f.store.append(f.lease, composed, commit, alive)).kind).toBe('io-failure')

    expect((await f.store.append(f.lease, composed, commit, alive)).kind).toBe('written')
  })

  it('bench 디렉터리가 심링크면 따라가지 않고 거부한다', async () => {
    const f = await setup()
    f.fs.setSymlink(join(JOURNAL_DIR, f.benchId))

    const r = await f.store.append(f.lease, draftOf(f), f.read, alive)

    expect(r.kind).toBe('invariant-violation')
    expect(f.fs.countOf('mkdirRecursive')).toBe(0)
    expect(f.fs.countOf('openExclusive')).toBe(0)
  })
})

describe('읽기 실패 분류 · 파서 총체성', () => {
  it('ULID 문법 위반 id 로는 읽지 않는다', async () => {
    const f = await setup()
    const r = f.store.read('../evil', f.txnId)

    expect(r.kind).toBe('invalid')
    expect(f.fs.calls).toEqual([])
  })

  it.each([
    ['statKind', 'stat'],
    ['readFileUtf8', 'read'],
  ] as const)('%s 실패는 io-failure{step:%s} 로 분류된다', async (op, step) => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f))
    f.fs.failNext(op, errno('EACCES'))

    expect(f.store.read(f.benchId, f.txnId)).toMatchObject({ kind: 'io-failure', step })
  })

  it.each([
    ['깨진 JSON', '{'],
    ['최상위가 배열', '[]'],
    ['최상위가 문자열', '"x"'],
    ['최상위가 null', 'null'],
  ])('%s 은 invalid 다', async (_name, raw) => {
    const f = await setup()
    f.fs.setFile(f.path, raw)
    expect(f.store.read(f.benchId, f.txnId).kind).toBe('invalid')
  })

  it.each([
    ['publishedAt 이 숫자가 아니다', { publishedAt: 'x' }],
    ['previousAuthorityStage 가 유니온 밖', { previousAuthorityStage: 'zzz' }],
    ['resultTree 가 문자열이 아니다', { resultTree: 123 }],
    ['abandonReason 이 유니온 밖', { abandonReason: 'because' }],
    ['stage 가 유니온 밖', { stage: 'zzz' }],
    ['draftDigest 가 hex64 가 아니다', { draftDigest: 'ZZZ' }],
    ['sourceGeneration 이 음수', { sourceGeneration: -1 }],
  ])('필드 형태 위반: %s', async (_name, over) => {
    const f = await setup()
    f.fs.setFile(f.path, serialized(f, over))
    expect(f.store.read(f.benchId, f.txnId).kind).toBe('invalid')
  })

  it('적대 값(BigInt)이 와도 파서는 던지지 않고 값으로 거부한다', async () => {
    const f = await setup()
    // `JSON.stringify` 가 **던지는** 값이다 — 진단 문자열 생성이 총체적이지 않으면 파서가 예외를 내고
    // 그것은 RED 가 아니라 호출자의 hang·크래시가 된다(형제 authority.ts 의 `show` 와 같은 축).
    const hostile = Object.assign({}, draftOf(f), { startedAt: 1n })

    const r = await f.store.append(f.lease, hostile, f.read, alive)

    expect(r.kind).toBe('invariant-violation')
  })
})

describe('부모 디렉터리 엔트리 내구화 (file+dir)', () => {
  it('bench 마다 한 번씩만 부모를 fsync 한다(같은 bench 재쓰기는 건너뛴다)', async () => {
    const f = await setup({}, 'file+dir')
    const openDirs = (): unknown[] =>
      f.fs.calls.filter((c) => c.op === 'openDir').map((c) => c.args[0])

    expect((await f.store.append(f.lease, draftOf(f), f.read, alive)).kind).toBe('written')
    // 최초 = 영역 루트(`journal/` 엔트리) · journalDir(`<benchId>/` 엔트리) · post-commit benchDir
    expect(openDirs()).toEqual([dirname(JOURNAL_DIR), JOURNAL_DIR, join(JOURNAL_DIR, f.benchId)])

    const commit = await mintCommitFor(f.lease, f.benchId)
    const second = await f.store.append(
      f.lease,
      draftOf(f, {
        stage: 'composed',
        resultOid: OID_C,
        resultTree: OID_A,
        nextAuthorityStage: 'composed',
        previousAuthorityStage: 'prepared',
        expectedAuthorityRevision: commit.revision,
      }),
      commit,
      alive,
    )

    expect(second.kind).toBe('written')
    // 두 부모는 이미 내구화됐다 — post-commit benchDir 만 다시 본다.
    expect(openDirs()).toEqual([
      dirname(JOURNAL_DIR),
      JOURNAL_DIR,
      join(JOURNAL_DIR, f.benchId),
      join(JOURNAL_DIR, f.benchId),
    ])
  })

  it('다른 bench 는 journalDir 엔트리를 다시 내구화한다', async () => {
    const f = await setup({}, 'file+dir')
    await f.store.append(f.lease, draftOf(f), f.read, alive)

    const otherBench = newUlid()
    const other = await acquire(otherBench)
    const otherRead = await mintReadFor(other.lease)
    const before = f.fs.countOf('openDir')

    const r = await f.store.append(
      other.lease,
      draftOf({ benchId: otherBench, txnId: newUlid() }),
      otherRead,
      alive,
    )

    expect(r.kind).toBe('written')
    // journalDir(새 `<benchId>/` 엔트리) + post-commit benchDir = 2회. 영역 루트는 이미 했다.
    expect(f.fs.countOf('openDir') - before).toBe(2)
  })
})

describe('권위 draft 다이제스트 (정정 167)', () => {
  it('키 순서에 무관하게 같은 값을 낸다(정준 직렬화)', () => {
    const benchId = newUlid()
    const a: BenchAuthorityDraft = {
      schemaVersion: 1,
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
      lifecycle: 'open',
      sourceGeneration: 1,
    }
    const b: BenchAuthorityDraft = {
      sourceGeneration: 1,
      lifecycle: 'open',
      identity: { benchId, benchRoot: BENCH_ROOT, commonGitDir: COMMON_GIT_DIR },
      schemaVersion: 1,
    }
    expect(digestAuthorityDraft(a)).toBe(digestAuthorityDraft(b))
    expect(digestAuthorityDraft(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('undefined 옵셔널 필드는 부재와 같게 본다(JSON 규칙과 동형)', () => {
    const benchId = newUlid()
    const base: BenchAuthorityDraft = {
      schemaVersion: 1,
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
      lifecycle: 'open',
      sourceGeneration: 1,
    }

    expect(digestAuthorityDraft({ ...base, archivedBranch: undefined })).toBe(
      digestAuthorityDraft(base),
    )
  })

  it('값이 하나라도 다르면 달라진다', () => {
    const benchId = newUlid()
    const base: BenchAuthorityDraft = {
      schemaVersion: 1,
      identity: { commonGitDir: COMMON_GIT_DIR, benchRoot: BENCH_ROOT, benchId },
      lifecycle: 'open',
      sourceGeneration: 1,
    }
    expect(digestAuthorityDraft(base)).not.toBe(
      digestAuthorityDraft({ ...base, sourceGeneration: 2 }),
    )
  })
})
