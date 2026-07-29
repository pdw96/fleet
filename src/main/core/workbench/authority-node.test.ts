import { execFileSync } from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BenchAuthorityDraft, BenchAuthorityRecord, CasResult } from './authority'
import { classifyStaleActivity, createBenchAuthorityStore, reclaimDraft } from './authority'
import { createNodeDurableFs, probeDurability } from './durable-fs'
import { createFakeLockBackend } from './__testing__/lock-backend-fake'
import { type BenchLeaseToken, createLockScope } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR2b — 권위 CAS 를 **실 파일시스템**에 대고 검증한다.
 *
 * ⚠ **이 파일이 없으면 이 슬라이스 전체가 페이크 위에서만 선다.** `authority-store.test.ts` 는 계약·판정을
 * 주입 페이크로 양 OS 에서 돌리는데(§3.1 대응 ⓐ), 그것은 「우리가 정한 규칙이 지켜지는가」만 증명하고
 * 「Node/libuv 가 실제로 그렇게 동작하는가」는 증명하지 않는다. PR1b 가 확립한 2층 규율
 * (페이크 = 양 OS 판정 · 실물 = 플랫폼 성질)을 store 층에도 적용한다.
 *
 * 여기서만 잡히는 것: ⓐ실 `rename` 이 정말 원자적 교체인가 ⓑ`wx` create-only 가 tmp 잔재와 실제로
 * 충돌하는가 ⓒPOSIX 에서 dir fsync 가 성공하는가(win32 는 `'file-only'` 로 강등되어 그 경로 자체가 없다)
 * ⓓ0600/0700 이 실제 inode 에 걸리는가.
 *
 * 플랫폼 비대칭은 `describe.skipIf` 로 분리한다 — 조기 `return` 형 게이트는 skip 이 아니라 **PASSED 로
 * 집계**되어 「Linux 행이 건너뛰어졌다」를 요약에서 확인할 수 없다(계획 정정 ㉚ⓐ).
 */

const IS_WIN = process.platform === 'win32'

/**
 * 실 FS 위에서도 **백오프는 발동하지 않아야 한다** — 이 스위트의 rename 대상은 아무도 열고 있지 않다.
 * 발동하면 그 자체가 신호다(win32 EPERM 이 실제로 났다 = 픽스처가 핸들을 남겼거나 외부 간섭).
 * 재시도 계약의 실 FS 조작화는 `describe.skipIf` 로 분리된 win32 전용 행이 따로 가진다.
 *
 * ⚠ 형제 스위트와 같은 이유로 **던지지 않고 기록한다**(자가 적대 리뷰 F5) — throw 는 CAS 의 `catch` 에
 * 잡혀 `io-failure` 로 재라벨되고, 그 재라벨이 다른 방어를 덮는다.
 */
const sleepCalls: number[] = []
const neverSleeps = (ms: number): Promise<void> => {
  sleepCalls.push(ms)
  return Promise.resolve()
}

let root: string
let authorityDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-auth-'))
  authorityDir = join(root, 'fleet', 'authority')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  const seen = sleepCalls.splice(0)
  expect(seen, '실 FS 스위트에서 백오프가 발동했다 — 열린 핸들이 남아 있다').toEqual([])
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

const draftFor = (
  lease: BenchLeaseToken,
  over: Partial<BenchAuthorityDraft> = {},
): BenchAuthorityDraft => ({
  schemaVersion: 1,
  identity: lease.identity,
  lifecycle: 'open',
  sourceGeneration: 1,
  ...over,
})

/** 실 어댑터를 주입한 store — **프로덕션 조합**이다(페이크 0). */
const realStore = (
  durability: 'file+dir' | 'file-only',
): ReturnType<typeof createBenchAuthorityStore> =>
  createBenchAuthorityStore(createNodeDurableFs(), {
    authorityDir,
    durability,
    now: () => 1_700_000_000_000,
    sleep: neverSleeps,
  })

const commit = (
  store: ReturnType<typeof createBenchAuthorityStore>,
  lease: BenchLeaseToken,
  over: Partial<BenchAuthorityDraft> = {},
): Promise<CasResult> =>
  store.withAuthority(lease, async (tx) => {
    const read = tx.readFresh()
    if (read.kind !== 'absent' && read.kind !== 'found') throw new Error(`예상 밖: ${read.kind}`)
    return tx.compareAndSwap(read.read, draftFor(lease, over))
  })

describe('실 파일시스템 위의 CAS — 프로덕션 조합', () => {
  it('첫 커밋이 실제 파일을 만들고 tmp 를 남기지 않는다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const r = await commit(realStore('file-only'), lease)

    expect(r.kind).toBe('committed')
    const path = join(authorityDir, `${benchId}.json`)
    const onDisk: BenchAuthorityRecord = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.revision).toBe(1)
    expect(onDisk.identity.benchId).toBe(benchId)
    // tmp 는 rename 으로 소멸했다 — 실 rename 이 원자적 교체임을 여기서만 확인한다.
    expect(() => statSync(join(authorityDir, `${benchId}.json.${lease.ownerToken}.tmp`))).toThrow()
  })

  it('연속 CAS 가 revision 을 단조 증가시키고 디스크가 최신을 보인다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const store = realStore('file-only')
    for (const gen of [1, 2, 3]) {
      const r = await commit(store, lease, { sourceGeneration: gen })
      expect(r.kind === 'committed' && r.record.revision).toBe(gen)
    }
    const onDisk: BenchAuthorityRecord = JSON.parse(
      readFileSync(join(authorityDir, `${benchId}.json`), 'utf8'),
    )
    expect([onDisk.revision, onDisk.sourceGeneration]).toEqual([3, 3])
  })

  /**
   * **tmp 잔재 회수**(계획 정정 78). tmp 이름은 리스 수명 동안 고정이므로, 앞선 크래시가 남긴 잔재가
   * 있으면 `openExclusive`(`wx`)가 EEXIST 로 자기잠금한다 — 그 create-only 성질이 실물에서 정말
   * 그렇게 동작하는지는 여기서만 증명된다.
   */
  it('앞선 잔재 tmp 가 있으면 첫 CAS 가 io-failure 이고 그 다음은 성공한다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const store = realStore('file-only')
    // 크래시 잔재를 실물로 만든다.
    execFileSync(process.execPath, [
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(authorityDir)},{recursive:true});` +
        `require('fs').writeFileSync(${JSON.stringify(
          join(authorityDir, `${benchId}.json.${lease.ownerToken}.tmp`),
        )},'잔재')`,
    ])

    const first = await commit(store, lease)
    expect(first.kind).toBe('io-failure')
    expect(first.kind === 'io-failure' && first.step).toBe('open-tmp')

    // `finally` 가 자기 tmp 를 치웠으므로 다음 CAS 는 성공한다(자기잠금 부재).
    const second = await commit(store, lease)
    expect(second.kind).toBe('committed')
  })

  it('읽기가 실 디스크의 외부 변경을 본다(캐시 없음)', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const store = realStore('file-only')
    await commit(store, lease, { sourceGeneration: 1 })

    // 외부 프로세스가 교체한다 — 같은 신뢰 도메인(§W-2-a)의 실제 시나리오.
    const path = join(authorityDir, `${benchId}.json`)
    const raw: BenchAuthorityRecord = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...raw, revision: 7, sourceGeneration: 9 }))

    const seen = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(seen.kind === 'found' && seen.record.revision).toBe(7)
  })

  it('정규 파일이 아니면 invalid 이고 자동 삭제하지 않는다(실 디렉터리로 재현)', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const path = join(authorityDir, `${benchId}.json`)
    execFileSync(process.execPath, [
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(path)},{recursive:true})`,
    ])

    const seen = await realStore('file-only').withAuthority(lease, (tx) =>
      Promise.resolve(tx.readFresh()),
    )
    expect(seen.kind).toBe('invalid')
    expect(statSync(path).isDirectory()).toBe(true) // 지우지 않았다
  })
})

/**
 * **POSIX 전용 — 프로덕션 내구 경로.** 서버는 컨테이너(Linux)에서 돌므로 `file+dir` 이 **실제 출하 경로**다.
 * win32 는 `probeDurability` 가 `'file-only'` 로 상한 고정하므로(계획 정정 60·61) 이 경로 자체가 없다.
 */
describe.skipIf(IS_WIN)('POSIX 내구 경로 — file+dir 이 실물에서 성립한다', () => {
  it('프로브가 실 디렉터리에서 file+dir 을 답한다', () => {
    execFileSync(process.execPath, [
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(authorityDir)},{recursive:true})`,
    ])
    expect(probeDurability(createNodeDurableFs(), authorityDir, process.platform)).toBe('file+dir')
  })

  it('file+dir 커밋이 성공하고 레코드에 등급이 기록된다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const r = await commit(realStore('file+dir'), lease)

    expect(r.kind).toBe('committed')
    const onDisk: BenchAuthorityRecord = JSON.parse(
      readFileSync(join(authorityDir, `${benchId}.json`), 'utf8'),
    )
    expect(onDisk.writtenBy.durability).toBe('file+dir')
  })

  it('권위 디렉터리 0700 · 레코드 0600 이 실 inode 에 걸린다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    await commit(realStore('file+dir'), lease)

    expect(statSync(authorityDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(authorityDir, `${benchId}.json`)).mode & 0o777).toBe(0o600)
  })

  it('부모 디렉터리도 실재한다(생성 경로가 실물에서 완주한다)', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    await commit(realStore('file+dir'), lease)
    expect(statSync(dirname(authorityDir)).isDirectory()).toBe(true)
  })
})

/**
 * **§3.2 크래시 도달 가능성 — 실 프로세스 행**(계획 정정 71 이 재기술한 형태).
 *
 * 복구 판정을 순수 함수로 만들고 상태를 **직접 구성**하면 「각 단계 직후 실제로 죽었을 때 디스크가 그
 * 상태가 되는가」(구성 가능 상태 vs **도달 가능** 상태)를 아무도 검증하지 않는다. 그래서 최소 1행을 실
 * 프로세스로 만든다.
 *
 * ⚠ **무엇이 프로덕션이고 무엇이 픽스처인가**(정직성 · 정정 71 이 요구한 헤더):
 * - **자식(`node -e`) = 픽스처**다. 내구 순서를 JS 로 재현해 「그 단계 직후의 디스크 상태」를 만들고
 *   `process.kill(자기 자신)` 으로 즉사한다. 자식이 프로덕션 코드를 실행하지 않는 이유는 `.ts` 자식 실행
 *   수단이 이 레포에 없기 때문이다(`tsx`/`ts-node` devDep 0 · `out/` 은 verify 체인상 vitest 뒤).
 * - **부모 = 프로덕션**이다. 자식이 남긴 실제 디스크 상태에 대고 **프로덕션 `readFresh` 와 복구 판정**을
 *   실행한다. 즉 검증 대상은 「그 상태를 우리 코드가 어떻게 읽는가」이고, 자식은 그 상태가 **도달
 *   가능함**을 증명하는 역할만 한다.
 */
describe('크래시 도달 가능성 — 자식이 만든 실제 상태를 프로덕션이 읽는다(§3.2 · 정정 71)', () => {
  /** 자식을 띄워 지정 단계까지만 수행하고 **즉사**시킨다. 반환은 자식이 실제로 죽었는지. */
  const crashAt = (
    benchId: string,
    stage: 'after-tmp-write' | 'after-fsync' | 'before-rename',
    payload: string,
  ) => {
    // ⚠ **판정 리스와 같은 benchId 여야 한다**(CodeRabbit). 고정 이름을 쓰고 다른 benchId 로 읽으면
    // `pathFor(lease.identity.benchId)` 가 잔재를 **아예 들여다보지 않아** 「무관한 파일은 absent」라는
    // 자명한 사실만 확인하는 vacuous 테스트가 된다.
    const tmp = join(authorityDir, `${benchId}.json.owner.tmp`)
    const target = join(authorityDir, `${benchId}.json`)
    const script = [
      `const fs=require('fs');`,
      `fs.mkdirSync(${JSON.stringify(authorityDir)},{recursive:true,mode:0o700});`,
      `const fd=fs.openSync(${JSON.stringify(tmp)},'wx',0o600);`,
      `fs.writeSync(fd,Buffer.from(${JSON.stringify(payload)},'utf8'),0,Buffer.byteLength(${JSON.stringify(payload)}));`,
      stage === 'after-tmp-write' ? `` : `fs.fsyncSync(fd);`,
      stage === 'before-rename' ? `fs.closeSync(fd);` : ``,
      // 여기서 **즉사** — rename 은 절대 실행되지 않는다.
      `process.kill(process.pid,'SIGKILL');`,
    ].join('')
    let died = false
    try {
      execFileSync(process.execPath, ['-e', script], { stdio: 'ignore' })
    } catch {
      died = true // SIGKILL 로 죽으면 non-zero
    }
    return { died, tmp, target }
  }

  it.each(['after-tmp-write', 'after-fsync', 'before-rename'] as const)(
    '%s 에서 죽으면 권위 파일은 부재이고 tmp 만 남는다 — 프로덕션이 absent 로 읽는다',
    async (stage) => {
      const benchId = newUlid()
      const { died, tmp, target } = crashAt(benchId, stage, '{"schemaVersion":1}')
      expect(died).toBe(true)

      // **도달 가능성 증거**: 그 단계 직후의 디스크가 실제로 이 모양이다.
      expect(statSync(tmp).isFile()).toBe(true)
      expect(() => statSync(target)).toThrow() // rename 전이므로 권위 파일 없음

      // **프로덕션 판정**: 이 상태를 우리 코드가 어떻게 읽는가. **같은 benchId** 로 읽어야 잔재를 본다.
      const lease = await mintLease(benchId)
      const seen = await createBenchAuthorityStore(createNodeDurableFs(), {
        authorityDir,
        durability: 'file-only',
        now: () => 1,
        sleep: neverSleeps,
      }).withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

      // 자기 bench 의 tmp 잔재가 **바로 옆에 있는데도** 권위 파일이 없으므로 `absent` 다 —
      // 잔재를 권위로 오독하는 구현이면 여기서 RED 다(그것이 이 행의 반증력이다).
      expect(seen.kind).toBe('absent')
    },
  )

  /**
   * rename **직후** 죽은 상태 — 권위 파일은 존재하고 tmp 는 없다. 프로덕션이 그것을 정상 `found` 로
   * 읽어야 한다(= 커밋은 rename 시점에 확정된다는 계약의 실물 확인).
   */
  it('rename 직후 죽으면 권위 파일이 존재하고 프로덕션이 found 로 읽는다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const target = join(authorityDir, `${benchId}.json`)
    const tmp = `${target}.owner.tmp`
    const rec = {
      schemaVersion: 1,
      identity: lease.identity,
      revision: 1,
      lifecycle: 'open',
      sourceGeneration: 1,
      writtenBy: { ownerToken: 'crashed', at: 1, durability: 'file-only' },
    }
    const script = [
      `const fs=require('fs');`,
      `fs.mkdirSync(${JSON.stringify(authorityDir)},{recursive:true,mode:0o700});`,
      `const fd=fs.openSync(${JSON.stringify(tmp)},'wx',0o600);`,
      `const b=Buffer.from(${JSON.stringify(JSON.stringify(rec))},'utf8');`,
      `fs.writeSync(fd,b,0,b.length); fs.fsyncSync(fd); fs.closeSync(fd);`,
      `fs.renameSync(${JSON.stringify(tmp)},${JSON.stringify(target)});`,
      `process.kill(process.pid,'SIGKILL');`,
    ].join('')
    try {
      execFileSync(process.execPath, ['-e', script], { stdio: 'ignore' })
    } catch {
      /* SIGKILL 로 죽는 것이 정상 */
    }

    expect(statSync(target).isFile()).toBe(true)
    expect(() => statSync(tmp)).toThrow()

    const seen = await createBenchAuthorityStore(createNodeDurableFs(), {
      authorityDir,
      durability: 'file-only',
      now: () => 1,
      sleep: neverSleeps,
    }).withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))

    expect(seen.kind).toBe('found')
    expect(seen.kind === 'found' && seen.record.revision).toBe(1)
  })
})

/**
 * §3-T17 **실 FS 조작화**(#251 PR2c · win32 전용).
 *
 * C4 의 근거는 「win32 는 대상에 열린 핸들이 하나라도 있으면 rename 이 EPERM」이고, 3면 실측이 그것을
 * 확인했다(win32 EPERM ×3 → close → 4회차 성공 / linux 는 애초에 성공). 페이크 위 재시도 테스트는
 * **주입한 오류를 되돌려받는** 반면 이 행은 **실 커널이 EPERM 을 낸다** — 「방어를 만든 근거」와
 * 「방어가 동작함」을 한 곳에서 묶는다(PR2a 교훈 ①).
 *
 * ⚠ **벽시계로 핸들을 닫지 않는다**(예: `setTimeout(close, 25)`). 백오프 총합이 150ms 라 CI 부하에서
 * 순서가 뒤집혀 **정답 구현이 flake 로 RED** 가 된다. 대신 실 어댑터를 **카운팅 데코레이터로 감싸**
 * 「n회차 rename 직전에 닫는다」를 사건 순서로 고정한다(주입 seam 이 이미 그 수단이다).
 */
describe.skipIf(!IS_WIN)('§3-T17 실 FS — win32 rename EPERM 재시도', () => {
  it('열린 핸들이 3회 EPERM 을 만들고, 닫히면 4회차에 커밋된다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const target = join(authorityDir, `${benchId}.json`)

    // 1) 먼저 정상 커밋으로 대상 파일을 만든다(열 대상이 있어야 EPERM 을 낼 수 있다).
    expect((await commit(realStore('file-only'), lease)).kind).toBe('committed')

    // 2) 그 파일을 연다 — 이 순간부터 win32 는 rename 을 EPERM 으로 거절한다.
    let held: number | undefined = openSync(target, 'r')
    const delays: number[] = []
    let renames = 0
    const real = createNodeDurableFs()
    const counting: typeof real = {
      ...real,
      rename: (from, to) => {
        renames += 1
        // 3회차까지는 핸들이 열린 채 — 4회차 **직전**에 닫는다.
        if (renames === 4 && held !== undefined) {
          closeSync(held)
          held = undefined
        }
        real.rename(from, to)
      },
    }

    const store = createBenchAuthorityStore(counting, {
      authorityDir,
      durability: 'file-only',
      now: () => 1_700_000_000_001,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    try {
      const r = await commit(store, lease, { sourceGeneration: 2 })

      expect(r.kind).toBe('committed')
      expect(renames).toBe(4)
      expect(delays).toEqual([10, 20, 40])
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({
        revision: 2,
        sourceGeneration: 2,
      })
    } finally {
      if (held !== undefined) closeSync(held)
    }
  })

  it('핸들이 끝까지 열려 있으면 5회 시도 후 io-failure{rename} — 대상 내용 불변', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const target = join(authorityDir, `${benchId}.json`)
    expect((await commit(realStore('file-only'), lease)).kind).toBe('committed')
    const before = readFileSync(target, 'utf8')

    const held = openSync(target, 'r')
    let renames = 0
    const real = createNodeDurableFs()
    const counting: typeof real = {
      ...real,
      rename: (from, to) => {
        renames += 1
        real.rename(from, to)
      },
    }
    const store = createBenchAuthorityStore(counting, {
      authorityDir,
      durability: 'file-only',
      now: () => 1_700_000_000_002,
      sleep: () => Promise.resolve(),
    })

    try {
      const r = await commit(store, lease, { sourceGeneration: 3 })

      expect(r.kind).toBe('io-failure')
      expect(r.kind === 'io-failure' && r.step).toBe('rename')
      expect(renames).toBe(5)
      // 커밋되지 않았다 = 대상 내용이 그대로다. tmp 도 남지 않는다(finally 규율).
      expect(readFileSync(target, 'utf8')).toBe(before)
      expect(() =>
        statSync(join(authorityDir, `${benchId}.json.${lease.ownerToken}.tmp`)),
      ).toThrow()
    } finally {
      closeSync(held)
    }
  })
})

/**
 * §W-4 「`commit-uncertain` 복구」 **종단**(#251 PR2c · 실 프로세스).
 *
 * 이 슬라이스의 각 조각은 페이크로 검증됐지만, 사슬 전체 — 「post-commit 실패로 디스크에만 남은
 * `execGate:'gated'` 를 **다른 프로세스**가 gated-orphan 으로 분류해 회수한다」 — 는 어디서도 이어
 * 붙지 않았다. 조각만 맞으면 「선언한 회귀를 실제로 못 잡는 테스트」가 되는 계열이라(PR2b 교훈 ⑤)
 * 여기서 실 프로세스 급사로 잔재를 만들고 이 프로세스가 복구자 역할을 한다.
 *
 * 자식이 **fs 로 직접** 레코드를 쓰는 이유는 그것이 정확히 `commit-uncertain` 이 남기는 디스크 상태이기
 * 때문이다(rename 은 성공했고 dir fsync 만 실패했다 = 파일은 제자리, 커밋 토큰은 미발급). 자식이
 * 모듈을 import 할 수는 없다(빌드 산출물이 아니다) — 형제 크래시 행이 확립한 패턴 그대로다.
 */
describe('commit-uncertain 잔재 → 다른 프로세스가 gated-orphan 으로 회수한다', () => {
  it('급사가 남긴 gated 활동을 분류해 회수하고, 세대·통합 필드는 보존한다', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const target = join(authorityDir, `${benchId}.json`)
    const crashed: BenchAuthorityRecord = {
      schemaVersion: 1,
      identity: lease.identity,
      revision: 3,
      lifecycle: 'open',
      sourceGeneration: 4,
      currentIntegrationTxnId: 'txn-보존',
      currentIntegrationStage: 'prepared',
      currentIntegrationTxnGeneration: 1,
      activeActivity: {
        activityId: 'act-crash',
        kind: 'run',
        generation: 4,
        ownerToken: 'crashed-owner',
        execGate: 'gated',
        startedAt: 1,
      },
      writtenBy: { ownerToken: 'crashed-owner', at: 1, durability: 'file+dir' },
    }
    const payload = JSON.stringify(JSON.stringify(crashed))
    const script = [
      `const fs=require('fs');`,
      `fs.mkdirSync(${JSON.stringify(authorityDir)},{recursive:true,mode:0o700});`,
      // rename 까지는 성공한 상태를 만든다 — post-commit(dir fsync)만 실패한 것이 commit-uncertain 이다.
      `fs.writeFileSync(${JSON.stringify(target)},Buffer.from(${payload},'utf8'),{mode:0o600});`,
      `process.kill(process.pid,'SIGKILL');`,
    ].join('')
    let died = false
    try {
      execFileSync(process.execPath, ['-e', script], { stdio: 'ignore' })
    } catch {
      died = true
    }
    expect(died).toBe(true) // 정리 훅이 돌지 않았음의 증거
    expect(statSync(target).isFile()).toBe(true)

    // ── 여기부터 「재시작한 프로세스」 역할 ──
    const store = realStore('file-only')
    const seen = await store.withAuthority(lease, (tx) => Promise.resolve(tx.readFresh()))
    expect(seen.kind).toBe('found')
    if (seen.kind !== 'found') return

    const verdict = classifyStaleActivity(seen.record)
    expect(verdict.kind).toBe('gated-orphan')
    expect(verdict.kind === 'gated-orphan' && verdict.activityId).toBe('act-crash')

    const reclaimed = await store.withAuthority(lease, async (tx) => {
      const fresh = tx.readFresh()
      if (fresh.kind !== 'found') throw new Error('found 예상')
      return tx.compareAndSwap(fresh.read, reclaimDraft(fresh.record))
    })
    expect(reclaimed.kind).toBe('committed')

    const after: BenchAuthorityRecord = JSON.parse(readFileSync(target, 'utf8'))
    expect(after.activeActivity).toBeUndefined()
    expect(after.revision).toBe(4)
    // **세대와 통합 필드는 회수가 건드리지 않는다**(정정 101) — 되돌리면 §W-8 완결 관측의 귀속이 깨진다.
    expect(after.sourceGeneration).toBe(4)
    expect(after.currentIntegrationTxnId).toBe('txn-보존')
    expect(after.currentIntegrationStage).toBe('prepared')
    // 회수는 멱등 방향이다 — 한 번 치우면 더 이상 대상이 아니다.
    expect(classifyStaleActivity(after).kind).toBe('none')
  })

  it('`running` 잔재는 같은 경로에서 회수 대상이 아니다(fail-open 음성 통제)', async () => {
    const benchId = newUlid()
    const lease = await mintLease(benchId)
    const target = join(authorityDir, `${benchId}.json`)
    const live: BenchAuthorityRecord = {
      schemaVersion: 1,
      identity: lease.identity,
      revision: 1,
      lifecycle: 'open',
      sourceGeneration: 1,
      activeActivity: {
        activityId: 'act-live',
        kind: 'run',
        generation: 1,
        ownerToken: 'other-owner',
        execGate: 'running',
        startedAt: 1,
      },
      writtenBy: { ownerToken: 'other-owner', at: 1, durability: 'file+dir' },
    }
    const payload = JSON.stringify(JSON.stringify(live))
    execFileSync(process.execPath, [
      '-e',
      `const fs=require('fs');fs.mkdirSync(${JSON.stringify(authorityDir)},{recursive:true,mode:0o700});` +
        `fs.writeFileSync(${JSON.stringify(target)},Buffer.from(${payload},'utf8'),{mode:0o600});`,
    ])

    const seen = await realStore('file-only').withAuthority(lease, (tx) =>
      Promise.resolve(tx.readFresh()),
    )
    expect(seen.kind).toBe('found')
    if (seen.kind !== 'found') return
    // **살아있는 자식이 있을 수 있다** — 그것을 「0줄 실행」으로 오분류해 변이하면 스펙이 스스로
    // fail-open 이라 부른 상태가 된다. 판정은 §W-16 해제 판정 소관이다.
    expect(classifyStaleActivity(seen.record).kind).toBe('live-activity')
  })
})
