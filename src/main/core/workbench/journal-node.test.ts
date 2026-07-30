import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AuthorityCommit, FreshReadToken } from './authority'
import { createBenchAuthorityStore } from './authority'
import { createNodeDurableFs } from './durable-fs'
import type { IntegrationTxnDraft } from './journal'
import { createJournalStore } from './journal'
import { createFakeLockBackend } from './__testing__/lock-backend-fake'
import { type BenchLeaseToken, createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR3b — 저널 쓰기를 **실 파일시스템**에 대고 검증한다(형제 `authority-node.test.ts` 와 같은 2층 규율:
 * 페이크 = 양 OS 판정 · 실물 = 플랫폼 성질).
 *
 * ⚠ **형제 스위트가 이것을 대체하지 못하는 이유**는 저널만의 축이 셋 있기 때문이다:
 * ⓐ권위는 **단일 레벨** 디렉터리인데 저널은 `journal/<benchId>/` **중첩**이다 — `mkdirRecursive` 의 mode 가
 * 중간 디렉터리에도 걸리는지는 실 inode 로만 확인된다 ⓑ단계 전진이 **같은 파일 덮어쓰기**라 실 `rename` 의
 * 교체 의미론에 의존한다 ⓒC4(win32 rename EPERM) **상속**이 저널 호출부에서도 실제로 성립하는지는
 * 이 파일에서만 관측된다.
 *
 * 플랫폼 비대칭은 `describe.skipIf` 로 분리한다 — 조기 `return` 형 게이트는 skip 이 아니라 PASSED 로
 * 집계돼 요약에서 확인할 수 없다.
 */

const IS_WIN = process.platform === 'win32'
const AT = 1_700_000_000_000
const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

/** 실 FS 에서도 기본 시나리오는 백오프를 타지 않는다 — 발동하면 그 자체가 신호(열린 핸들 잔존). */
const sleepCalls: number[] = []
const neverSleeps = (ms: number): Promise<void> => {
  sleepCalls.push(ms)
  return Promise.resolve()
}

/** 기본 임계 구역 생존 신호(주입 필수 seam — 생산자는 PR5 시퀀서다). */
const alive = (): boolean => true

let root: string
let journalDir: string
let authorityDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-journal-'))
  journalDir = join(root, 'fleet', 'journal')
  authorityDir = join(root, 'fleet', 'authority')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  expect(
    sleepCalls.splice(0),
    '실 FS 스위트에서 백오프가 발동했다 — 열린 핸들이 남아 있다',
  ).toEqual([])
})

const mintLease = async (benchId: string): Promise<BenchLeaseToken> => {
  const scope = createLockScope({
    identity: { commonGitDir: join(root, '.git'), benchRoot: root },
    backend: createFakeLockBackend(),
  })
  const r = await scope.tryAcquireBenchLease(benchId)
  if (r.status !== 'acquired') throw new Error(`리스 획득 실패: ${r.status}`)
  return r.lease
}

/** 실 어댑터를 주입한 저널 store — **프로덕션 조합**이다(페이크 0). */
const realJournal = (
  durability: 'file+dir' | 'file-only' = 'file-only',
): ReturnType<typeof createJournalStore> =>
  createJournalStore(createNodeDurableFs(), { journalDir, durability, sleep: neverSleeps })

const authorityStore = (): ReturnType<typeof createBenchAuthorityStore> =>
  createBenchAuthorityStore(createNodeDurableFs(), {
    authorityDir,
    durability: 'file-only',
    now: () => AT,
    sleep: neverSleeps,
  })

const mintRead = (lease: BenchLeaseToken): Promise<FreshReadToken> =>
  authorityStore().withAuthority(lease, (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent') throw new Error(`예상 밖 읽기 결과: ${read.kind}`)
    return Promise.resolve(read.read)
  })

const mintCommit = (lease: BenchLeaseToken): Promise<AuthorityCommit> =>
  authorityStore().withAuthority(lease, async (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent') throw new Error(`예상 밖 읽기 결과: ${read.kind}`)
    const cas = await tx.compareAndSwap(read.read, {
      schemaVersion: 1,
      identity: lease.identity,
      lifecycle: 'open',
      sourceGeneration: 1,
    })
    if (cas.kind !== 'committed') throw new Error(`CAS 실패: ${cas.kind}`)
    return cas.commit
  })

const draftOf = (
  lease: BenchLeaseToken,
  txnId: string,
  over: Partial<IntegrationTxnDraft> = {},
): IntegrationTxnDraft => ({
  txnId,
  benchId: lease.identity.benchId,
  repoCommonGitDir: lease.identity.commonGitDir,
  benchRoot: lease.identity.benchRoot,
  sourceBranch: 'fleet/bench-x',
  sourceSnapshot: OID_A,
  sourceGeneration: 1,
  targetBranch: 'main',
  targetHeadBeforeIntegration: OID_B,
  resultRef: `refs/fleet/integrated/${lease.identity.benchId}/${txnId}`,
  startedAt: AT,
  ownerEngineId: 'engine-1',
  stage: 'prepared',
  expectedAuthorityRevision: 0,
  nextAuthorityStage: 'prepared',
  integrationGeneration: 1,
  draftDigest: 'a'.repeat(64),
  ...over,
})

describe('실 파일시스템 위의 저널 쓰기 — 프로덕션 조합', () => {
  it('중첩 디렉터리를 만들고 엔트리 1개만 남긴다 · tmp 잔재 0 · 읽기 왕복', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const lease = await mintLease(benchId)

    const r = await realJournal().append(lease, draftOf(lease, txnId), await mintRead(lease), alive)

    expect(r.kind).toBe('written')
    expect(readdirSync(journalDir)).toEqual([benchId])
    expect(readdirSync(join(journalDir, benchId))).toEqual([`${txnId}.json`])
    const back = realJournal().read(benchId, txnId)
    expect(back).toMatchObject({ kind: 'found', record: { stage: 'prepared', txnId, benchId } })
  })

  it('단계 전진이 같은 파일을 덮어쓴다(실 rename 교체 · 파일 수 불변)', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const lease = await mintLease(benchId)
    const store = realJournal()
    expect(
      (await store.append(lease, draftOf(lease, txnId), await mintRead(lease), alive)).kind,
    ).toBe('written')

    const commit = await mintCommit(lease)
    const r = await store.append(
      lease,
      draftOf(lease, txnId, {
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
    expect(readdirSync(join(journalDir, benchId))).toEqual([`${txnId}.json`])
    const raw: unknown = JSON.parse(
      readFileSync(join(journalDir, benchId, `${txnId}.json`), 'utf8'),
    )
    expect(raw).toMatchObject({ stage: 'composed', resultOid: OID_C })
  })
})

describe.skipIf(IS_WIN)('POSIX — 모드·디렉터리 내구성이 실물에서 성립한다', () => {
  it('저널 디렉터리 0700 · 엔트리 0600 이 실 inode 에 걸린다(중첩 두 단계 모두)', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const lease = await mintLease(benchId)

    await realJournal().append(lease, draftOf(lease, txnId), await mintRead(lease), alive)

    expect(statSync(journalDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(journalDir, benchId)).mode & 0o777).toBe(0o700)
    expect(statSync(join(journalDir, benchId, `${txnId}.json`)).mode & 0o777).toBe(0o600)
  })

  it('bench 디렉터리가 **실제 심링크**면 따라가지 않고 거부한다(영역 밖 쓰기 차단)', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const lease = await mintLease(benchId)
    // 영역 **밖** 대상을 만들고 bench 디렉터리 자리에 심링크를 건다 — 페이크는 이 배치를 모델링만
    // 하지만, 「`mkdirRecursive` 가 따라간다」는 성질 자체는 실물에서만 확인된다.
    const outside = join(root, 'OUTSIDE')
    mkdirSync(outside, { recursive: true })
    mkdirSync(journalDir, { recursive: true })
    symlinkSync(outside, join(journalDir, benchId))

    const r = await realJournal().append(lease, draftOf(lease, txnId), await mintRead(lease), alive)

    expect(r.kind).toBe('invariant-violation')
    expect(readdirSync(outside)).toEqual([]) // 영역 밖에 아무것도 쓰지 않았다
  })

  it('file+dir 쓰기가 실 디렉터리 fsync 를 통과한다', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const lease = await mintLease(benchId)

    const r = await realJournal('file+dir').append(
      lease,
      draftOf(lease, txnId),
      await mintRead(lease),
      alive,
    )

    expect(r.kind).toBe('written')
  })
})

describe.skipIf(!IS_WIN)('win32 — C4 상속이 저널 호출부에서도 성립한다(§3-T68 실 FS)', () => {
  it('대상에 열린 핸들이 EPERM 을 만들고, 닫히면 재시도가 커밋한다', async () => {
    const benchId = newUlid()
    const txnId = newUlid()
    const lease = await mintLease(benchId)
    const target = join(journalDir, benchId, `${txnId}.json`)

    // 1) 먼저 정상 쓰기로 대상 파일을 만든다(열 대상이 있어야 EPERM 을 낼 수 있다).
    expect(
      (await realJournal().append(lease, draftOf(lease, txnId), await mintRead(lease), alive)).kind,
    ).toBe('written')

    // 2) 그 파일을 연다 — 이 순간부터 win32 는 rename 을 EPERM 으로 거절한다.
    let held: number | undefined = openSync(target, 'r')
    const delays: number[] = []
    let renames = 0
    const real = createNodeDurableFs()
    const counting: typeof real = {
      ...real,
      rename: (from, to) => {
        renames += 1
        if (renames === 3 && held !== undefined) {
          closeSync(held)
          held = undefined
        }
        real.rename(from, to)
      },
    }
    const store = createJournalStore(counting, {
      journalDir,
      durability: 'file-only',
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })
    const commit = await mintCommit(lease)

    try {
      const r = await store.append(
        lease,
        draftOf(lease, txnId, {
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
      expect(renames).toBe(3)
      expect(delays).toEqual([10, 20])
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ stage: 'composed' })
      // 실패한 두 회차의 tmp 가 남지 않는다(자기 tmp 만 치우는 `finally` 가 실물에서도 동작).
      expect(readdirSync(join(journalDir, benchId))).toEqual([`${txnId}.json`])
    } finally {
      if (held !== undefined) closeSync(held)
    }
  })
})
