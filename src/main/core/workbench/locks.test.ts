import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakeLockBackend, type FakeLockBackend } from './__testing__/lock-backend-fake'
import { endpointDigest } from './coord-area'
import {
  ABSTRACT_NAME_MAX_BYTES,
  availableLockBackends,
  createLockScope,
  ENDPOINT_PREFIX,
  endpointFor,
  type BenchLeaseToken,
  type LockHandle,
  type LockScope,
  INSTANCE_LOCK_KEY,
  nameBudget,
  REPO_LOCK_KEY,
  SLOT_INDEX_MAX,
  withLeaseGuard,
} from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR1b — 자문 락 코어(커널 endpoint 층) · 플랫폼 무관 계약.
 *
 * 실 추상 소켓 어댑터의 계약은 `lock-backend-uds.test.ts`(Linux 게이트)가 본다. 이 파일은 **양 OS 에서
 * 전량 실행**되며, 페이크 백엔드로 판정·서열·리스 계약을 검증한다(계획 §3.1 대응 ⓐ).
 */

const DIGEST = 'a'.repeat(32)

describe('endpointFor — 이름 유도 · 예산 preflight(순수 · 양 OS)', () => {
  it('추상 네임스페이스 이름은 코드포인트 0 으로 시작한다(pathname 소켓 구현이면 RED)', () => {
    const r = endpointFor(DIGEST, { kind: 'repo' })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.endpoint.codePointAt(0)).toBe(0)
    expect(r.endpoint.slice(1)).toBe(`${ENDPOINT_PREFIX}${DIGEST}.${REPO_LOCK_KEY}`)
  })

  /**
   * ⚠ **인스턴스 키가 락 키와 충돌하면 안 된다**(#251 PR1c · 계획 정정 ㊲). 인스턴스 배타는 부팅부터
   * 종료까지 endpoint 를 **계속 보유**하는데, 그 이름이 `r`(레포 변이 락)과 같으면 인스턴스가 살아 있는
   * 동안 모든 레포 변이가 정지한다. 반대로 락 키 중 하나를 인스턴스 생존 probe 로 재사용하면 **락을 쥐지
   * 않은 idle 인스턴스가 「사망」으로 판정**돼 회수된다(이중 인스턴스 = fail-open). 이름 분리가 그 두
   * 오작동의 공통 전제를 없앤다.
   */
  it('키 4종이 서로 다른 endpoint 로 간다(레포·bench·슬롯·인스턴스)', () => {
    const id = newUlid()
    const names = [
      endpointFor(DIGEST, { kind: 'repo' }),
      endpointFor(DIGEST, { kind: 'bench', benchId: id }),
      endpointFor(DIGEST, { kind: 'slot', index: 0 }),
      endpointFor(DIGEST, { kind: 'instance' }),
    ].map((r) => (r.status === 'ok' ? r.endpoint : r.status))
    expect(new Set(names).size).toBe(4)
  })

  it('인스턴스 키는 INSTANCE_LOCK_KEY 이고 레포 락 키와 다르다', () => {
    const r = endpointFor(DIGEST, { kind: 'instance' })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.key).toBe(INSTANCE_LOCK_KEY)
    expect(INSTANCE_LOCK_KEY).not.toBe(REPO_LOCK_KEY)
  })

  it('서로 다른 레포(digest)는 서로 다른 endpoint — 추상 이름공간은 net ns 전역이라 유일한 스코프 수단', () => {
    const a = endpointFor('a'.repeat(32), { kind: 'repo' })
    const b = endpointFor('b'.repeat(32), { kind: 'repo' })
    expect(a.status === 'ok' && b.status === 'ok' && a.endpoint !== b.endpoint).toBe(true)
  })

  // 반증력: 정규 최악값이 예산을 넘으면 「부팅 성공 + 기능 영구 사망」이다. 여유를 수치로 고정한다.
  it('정규 최악값(digest 32 + ULID 26)이 예산 안에 여유를 두고 들어간다', () => {
    const r = endpointFor(DIGEST, { kind: 'bench', benchId: newUlid() })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // 'fleet.wb.'(9) + digest(32) + '.'(1) + ULID(26) = 68 · 선행 NUL 포함 69
    expect(Buffer.byteLength(r.endpoint, 'utf8')).toBe(69)
    expect(69).toBeLessThan(ABSTRACT_NAME_MAX_BYTES)
  })

  /**
   * 예산 경계는 **순수 함수로만** 검증한다. 실 소켓으로 109바이트를 단언하면 런타임 메이저마다 결과가
   * 갈린다(실측 · 계획 정정 ⑭): Node 22.22.3(=`.nvmrc` · **필수 CI 게이트**)은 109B 를 **성공시키고
   * 107B 로 무성 절단**하며 앞 107B 를 공유하는 다른 키와 **EADDRINUSE 로 충돌**한다. Node 24 는 EINVAL.
   * 즉 libuv 에 예산 집행을 위임하면 게이트 런타임에서 이름 붕괴가 조용히 성립한다 — 가드는 우리 것이어야 한다.
   */
  describe('예산 경계(총 바이트 · 선행 NUL 포함) — libuv 가 아니라 우리 preflight 가 집행한다', () => {
    it.each([
      [ABSTRACT_NAME_MAX_BYTES - 1, 'ok'],
      [ABSTRACT_NAME_MAX_BYTES, 'ok'],
      [ABSTRACT_NAME_MAX_BYTES + 1, 'name-too-long'],
      [ABSTRACT_NAME_MAX_BYTES + 2, 'name-too-long'],
    ])('총 %i바이트 → %s', (total, status) => {
      // 선행 NUL 1바이트 + 채움 = 총 바이트
      const r = nameBudget(`\0${'x'.repeat(total - 1)}`)
      expect(r.status).toBe(status)
      expect(r.bytes).toBe(total)
      if (r.status === 'name-too-long') expect(r.max).toBe(ABSTRACT_NAME_MAX_BYTES)
    })

    // 반증력: 상한을 `String.length` 로 재는 구현이 이 행에서만 RED 다(한글 1자 = 3바이트).
    it('상한 단위는 문자 수가 아니라 UTF-8 바이트다', () => {
      const wide = `\0${'가'.repeat(36)}` // 1 + 108 = 109바이트 · String.length 로는 37
      expect(wide.length).toBe(37)
      const r = nameBudget(wide)
      expect(r.status).toBe('name-too-long')
      expect(r.bytes).toBe(109)
    })

    // 스펙 §W-2 문면은 「초과면 throw」지만 실제 libuv 경로는 'error' 이벤트이고(정정 ⑰),
    // 우리 층은 판별 유니온 반환으로 통일한다 — 호출자가 fail-closed 로 분기할 수 있어야 한다.
    it('예산 위반은 throw 가 아니라 값으로 보고된다', () => {
      expect(() => nameBudget(`\0${'z'.repeat(200)}`)).not.toThrow()
    })

    /**
     * **이 행이 예산 가드의 진짜 falsifier 다.** 현행 성분에서 예산 초과는 도달 불가하므로(위 주석),
     * 실제로 잡아야 하는 회귀는 「미래에 성분이 커져 조용히 상한에 닿는 것」이다. 최악값과 여유를
     * 상수로부터 계산해 고정하면 digest 길이 상향·접두 개명·새 키 종류가 이 행에서 RED 가 된다.
     */
    it('정규 최악값과 상한 사이 여유를 상수로 고정한다(성분이 커지면 여기서 RED)', () => {
      const worst = endpointFor('f'.repeat(32), { kind: 'bench', benchId: newUlid() })
      expect(worst.status).toBe('ok')
      if (worst.status !== 'ok') return
      const bytes = Buffer.byteLength(worst.endpoint, 'utf8')
      expect(bytes).toBe(1 + ENDPOINT_PREFIX.length + 32 + 1 + 26) // = 69
      expect(ABSTRACT_NAME_MAX_BYTES - bytes).toBe(39) // 여유 39바이트
    })
  })

  describe('키 문법 — 통과 집합 안에서 단사(§W-1 · ULID 정규화 금지)', () => {
    it.each([
      ['소문자 ULID', 'aaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['25자', 'A'.repeat(25)],
      ['27자', 'A'.repeat(27)],
      ['경로 구분자', '../../etc/passwd'],
      ['점 2개', '..'],
      ['빈 문자열', ''],
      ['Crockford 제외 문자 I', `I${'A'.repeat(25)}`],
      ['제어문자', `A${'\u0000'}${'A'.repeat(24)}`],
    ])('benchId 가 ULID 문법 위반(%s)이면 endpoint 를 만들지 않는다', (_label, benchId) => {
      expect(endpointFor(DIGEST, { kind: 'bench', benchId }).status).toBe('invalid')
    })

    it('유효 ULID 는 통과한다(위 거부가 vacuous 가 아님을 보이는 앵커)', () => {
      expect(endpointFor(DIGEST, { kind: 'bench', benchId: newUlid() }).status).toBe('ok')
    })

    it.each([-1, 0.5, Number.NaN, SLOT_INDEX_MAX, SLOT_INDEX_MAX + 1, Number.MAX_SAFE_INTEGER])(
      '슬롯 인덱스 범위/정수 위반(%p)은 거부한다',
      (index) => {
        expect(endpointFor(DIGEST, { kind: 'slot', index }).status).toBe('invalid')
      },
    )

    it('슬롯 인덱스 0..SLOT_INDEX_MAX-1 은 통과한다(앵커)', () => {
      for (let i = 0; i < SLOT_INDEX_MAX; i++) {
        expect(endpointFor(DIGEST, { kind: 'slot', index: i }).status).toBe('ok')
      }
    })

    it('digest 문법(32 hex)을 어기면 거부한다 — 이름공간 스코프 성분이 오염되면 분리가 깨진다', () => {
      expect(endpointFor('short', { kind: 'repo' }).status).toBe('invalid')
      expect(endpointFor(`${'a'.repeat(31)}Z`, { kind: 'repo' }).status).toBe('invalid')
    })
  })
})

/**
 * `availableLockBackends` — 「판정만 떼어내 양 OS 에서 검증」(`ownerMismatch` 선례와 동형).
 * 호출부(부팅 배선)는 PR7 이며 이 PR 은 순수 함수만 착지한다(계획 정정 ㉛).
 */
describe('availableLockBackends — 플랫폼 가용 백엔드 판정(순수)', () => {
  it('linux 에서만 추상 소켓 백엔드가 가용하다', () => {
    expect(availableLockBackends('linux')).toEqual(['uds-abstract'])
  })

  it.each<NodeJS.Platform>(['win32', 'darwin', 'aix', 'freebsd', 'sunos'])(
    '%s 는 빈 배열 = 기능 비활성(fail-closed) — 추상 네임스페이스 부재',
    (platform) => {
      expect(availableLockBackends(platform)).toEqual([])
    },
  )
})

/**
 * ---------------------------------------------------------------------------------------------
 * T3 판정 매핑 · L-2 논블로킹 (페이크 백엔드 · 양 OS)
 * ---------------------------------------------------------------------------------------------
 */

const scopeWith = (backend: FakeLockBackend): { scope: LockScope; digest: string } => {
  // 추상 이름공간은 net ns **전역**이라 파일 순차화가 아니라 **이름 무작위화**가 올바른 격리 수단이다
  // (§3.2 의 「mkdtemp 격리」는 pathname 시절 유물 · 계획 정정 ㉖).
  const commonGitDir = `/repo-${randomBytes(8).toString('hex')}/.git`
  return {
    scope: createLockScope({ identity: { commonGitDir, benchRoot: '/wb' }, backend }),
    digest: endpointDigest(commonGitDir),
  }
}

const endpointOf = (digest: string, spec: Parameters<typeof endpointFor>[1]): string => {
  const ep = endpointFor(digest, spec)
  if (ep.status !== 'ok') throw new Error(`픽스처 오류: ${ep.status}`)
  return ep.endpoint
}

/** setImmediate 턴 카운터 — 해소까지 몇 개의 check 페이즈 콜백이 끼어들었는가. */
const withTurnCount = async <T>(op: () => Promise<T>): Promise<{ value: T; turns: number }> => {
  let turns = 0
  let done = false
  const tick = (): void => {
    if (done) return
    turns++
    setImmediate(tick)
  }
  setImmediate(tick)
  const value = await op()
  done = true
  return { value, turns }
}

describe('tryAcquire — 판정 매핑(§W-3) · 모호는 전부 fail-closed', () => {
  it('bind 성공 = 소유자 부재 증명 → acquired', async () => {
    const { scope } = scopeWith(createFakeLockBackend())
    const r = await scope.tryAcquire({ kind: 'repo' })
    expect(r.status).toBe('acquired')
    if (r.status !== 'acquired') return
    expect(r.handle.key).toBe(REPO_LOCK_KEY)
    expect(r.handle.ownerToken).toMatch(/^[0-9a-f]{32}$/)
  })

  it('EADDRINUSE = 소유자 생존 → held(정상 대기 · 오류가 아니다)', async () => {
    const backend = createFakeLockBackend()
    const { scope, digest } = scopeWith(backend)
    backend.occupy(endpointOf(digest, { kind: 'repo' }))
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('held')
  })

  it.each([['EACCES'], ['EINVAL'], ['ENOENT'], [undefined]])(
    '그 외 오류(code=%s)는 unavailable = fail-closed — 미지 errno 를 성공으로 오해하지 않는다',
    async (code) => {
      const backend = createFakeLockBackend()
      const { scope } = scopeWith(backend)
      backend.failNextBind(code)
      expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('unavailable')
    },
  )

  it('키 문법 위반은 bind 를 시도하지 않고 unavailable — 부수효과 이전에 막는다', async () => {
    const backend = createFakeLockBackend()
    const { scope } = scopeWith(backend)
    expect((await scope.tryAcquireBenchLease('not-a-ulid')).status).toBe('unavailable')
    expect(backend.calls.filter((c) => c.op === 'bind')).toHaveLength(0)
  })

  it('같은 키를 두 번 획득할 수 없다(같은 프로세스에서도 커널 배타성이 적용된다)', async () => {
    const { scope } = scopeWith(createFakeLockBackend())
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('acquired')
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('held')
  })

  it('서로 다른 키는 동시 보유할 수 있다', async () => {
    const { scope } = scopeWith(createFakeLockBackend())
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('acquired')
    expect((await scope.tryAcquireBenchLease(newUlid())).status).toBe('acquired')
    expect((await scope.tryAcquire({ kind: 'slot', index: 0 })).status).toBe('acquired')
  })

  it('release 후 같은 키를 즉시 재획득할 수 있다(대기·폴링 없이)', async () => {
    const { scope } = scopeWith(createFakeLockBackend())
    const first = await scope.tryAcquire({ kind: 'repo' })
    if (first.status !== 'acquired') throw new Error('픽스처 오류')
    first.handle.release()
    const { value, turns } = await withTurnCount(() => scope.tryAcquire({ kind: 'repo' }))
    expect(value.status).toBe('acquired')
    expect(turns).toBe(0)
  })
})

/**
 * L-2 — `tryAcquire` 는 절대 블로킹하지 않는다.
 *
 * 계획 원문의 「`setImmediate` 턴 0 이 블로킹 재시도를 RED 로 만드는 **유일한** 형태」는 반증됐다
 * (정정 ⑯): bind 결과는 `process.nextTick` 경유이고 nextTick 큐는 check 페이즈보다 **먼저** 드레인되므로
 * nextTick·마이크로태스크 재시도 루프는 턴 0 을 그대로 통과한다. 그래서 **3중**으로 조작화한다.
 * ①②는 fake timers 가 `setImmediate` 를 페이크하므로 같은 `it` 에 합칠 수 없다.
 */
describe('L-2 논블로킹 — 3중 조작화', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('① held 판정에 bind 시도가 정확히 1회 — 어떤 재시도 루프도 ≥2 가 된다(주 falsifier)', async () => {
    const backend = createFakeLockBackend()
    const { scope, digest } = scopeWith(backend)
    backend.occupy(endpointOf(digest, { kind: 'repo' }))
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('held')
    expect(backend.calls.filter((c) => c.op === 'bind')).toHaveLength(1)
  })

  it('② 해소 후 예약된 타이머가 0 — 타이머 기반 백오프 구현이 RED', async () => {
    vi.useFakeTimers()
    const backend = createFakeLockBackend()
    const { scope, digest } = scopeWith(backend)
    backend.occupy(endpointOf(digest, { kind: 'repo' }))
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('held')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('③ held 판정이 check 페이즈를 한 번도 넘기지 않는다(보조 관측)', async () => {
    const backend = createFakeLockBackend()
    const { scope, digest } = scopeWith(backend)
    backend.occupy(endpointOf(digest, { kind: 'repo' }))
    const { value, turns } = await withTurnCount(() => scope.tryAcquire({ kind: 'repo' }))
    expect(value.status).toBe('held')
    expect(turns).toBe(0)
  })
})

/**
 * ---------------------------------------------------------------------------------------------
 * T4 — L-6 보유자 재검증 (`LeaseCheck` · 로컬 판정 · 디스크 I/O 0)
 * ---------------------------------------------------------------------------------------------
 */
describe('T4/§3-T10b — 보유자 재검증(L-6)', () => {
  const acquireLease = async (): Promise<{
    backend: FakeLockBackend
    handle: LockHandle
    lease: BenchLeaseToken
    endpoint: string
  }> => {
    const backend = createFakeLockBackend()
    const { scope, digest } = scopeWith(backend)
    const benchId = newUlid()
    const r = await scope.tryAcquireBenchLease(benchId)
    if (r.status !== 'acquired') throw new Error('픽스처 오류')
    return {
      backend,
      handle: r.handle,
      lease: r.lease,
      endpoint: endpointOf(digest, { kind: 'bench', benchId }),
    }
  }

  it('보유 중에는 owned', async () => {
    const { handle } = await acquireLease()
    expect(handle.revalidate()).toEqual({ kind: 'owned' })
  })

  it('release() 후에는 lost/released — 해제된 핸들로 변이 불가', async () => {
    const { handle } = await acquireLease()
    handle.release()
    expect(handle.revalidate()).toEqual({ kind: 'lost', reason: 'released' })
  })

  /**
   * **out-of-band 무효화** — 이 행이 T4 의 진짜 falsifier 다(계획 정정 ⑲).
   * `release()` 를 거치지 않고 밑단 endpoint 만 무효화하면 「자체 `released` 불리언을 읽는 구현」은
   * 여전히 `owned` 를 답한다(RED). 커널 상태를 읽는 구현만 통과한다.
   */
  it('release() 없이 밑단 endpoint 가 무효화되면 lost/stolen(내부 플래그 구현이면 RED)', async () => {
    const { backend, handle, endpoint } = await acquireLease()
    backend.forceLose(endpoint)
    expect(handle.revalidate()).toEqual({ kind: 'lost', reason: 'stolen' })
  })

  it('release() 는 여러 번 호출해도 안전하다(종료 경로 중복 호출 무해)', async () => {
    const { handle } = await acquireLease()
    handle.release()
    handle.release()
    expect(handle.revalidate()).toEqual({ kind: 'lost', reason: 'released' })
  })

  describe('판정에 디스크 I/O 0 — 구조(소스 스캔) + 행동(호출 계측) 2층', () => {
    it('revalidate 는 백엔드 보유 조회만 한다(bind·close 추가 호출 0)', async () => {
      const { backend, handle } = await acquireLease()
      backend.calls.length = 0
      handle.revalidate()
      expect(backend.calls.map((c) => c.op)).toEqual(['isBound'])
    })

    // 양성 통제 — 같은 스위트에서 그 더블이 실제로 호출되는 형제 행. 이게 없으면 seam 미배선(백엔드를
    // 아예 안 부르는 구현)이 위 「추가 호출 0」을 GREEN 으로 위장한다.
    it('양성 통제 — 같은 더블이 release 경로에서는 실제로 호출된다', async () => {
      const { backend, handle } = await acquireLease()
      backend.calls.length = 0
      handle.release()
      expect(backend.calls.map((c) => c.op)).toContain('close')
    })
  })

  describe('withLeaseGuard — 리스가 유효할 때만 변이가 실행된다', () => {
    it('owned 면 변이를 실행하고 값을 돌려준다', async () => {
      const { lease } = await acquireLease()
      expect(await withLeaseGuard(lease, () => Promise.resolve(42))).toEqual({
        kind: 'ran',
        value: 42,
      })
    })

    it.each([
      ['released', 'release'],
      ['stolen', 'forceLose'],
    ] as const)(
      '리스 상실(%s) 시 변이 함수를 **호출하지 않고** fail-closed',
      async (reason, how) => {
        const { backend, handle, lease, endpoint } = await acquireLease()
        if (how === 'release') handle.release()
        else backend.forceLose(endpoint)
        let called = 0
        const r = await withLeaseGuard(lease, () => {
          called++
          return Promise.resolve(1)
        })
        expect(called).toBe(0)
        expect(r).toEqual({ kind: 'lost', reason })
      },
    )
  })
})

/**
 * ---------------------------------------------------------------------------------------------
 * 자체 적대 리뷰가 낸 결함의 회귀 가드 (2026-07-26)
 * ---------------------------------------------------------------------------------------------
 */

describe('§W-12 상한 — 절대값 고정', () => {
  /**
   * 기존 슬롯 범위 행들은 전부 `SLOT_INDEX_MAX` 에 **상대적**이라, 상수를 64 로 올려도 전 게이트가
   * GREEN 이었다(자체 적대 리뷰 실측) — 그러면 §W-12 가 메모리 실측으로 구속한 절대 상한 4 의 키 층
   * fail-closed 가 조용히 소멸한다. 절대값을 못 박는다.
   */
  it('슬롯 인덱스 상한은 4 다(상향은 이 행에서 RED)', () => {
    expect(SLOT_INDEX_MAX).toBe(4)
    expect(endpointFor(DIGEST, { kind: 'slot', index: 3 }).status).toBe('ok')
    expect(endpointFor(DIGEST, { kind: 'slot', index: 4 }).status).toBe('invalid')
  })
})

describe('턴 카운터 양성 통제 — 카운터가 실제로 증가한다', () => {
  /**
   * L-2 의 「턴 0」 단언 4곳은 전부 `toBe(0)` 이라, 카운터가 **아예 증가하지 않는** 형태로 망가지면
   * 전부 vacuous GREEN 이 된다. 같은 계측 수단이 실제로 턴을 세는지 먼저 보인다.
   */
  it('의도적으로 한 턴 뒤에 해소하면 카운터가 0 이 아니다', async () => {
    const { turns } = await withTurnCount(
      () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve))),
    )
    expect(turns).toBeGreaterThan(0)
  })
})

describe('T4 보강 — 상실 사유는 사후에 덮어써지지 않는다', () => {
  const acquire = async (): Promise<{
    backend: FakeLockBackend
    handle: LockHandle
    endpoint: string
  }> => {
    const backend = createFakeLockBackend()
    const { scope, digest } = scopeWith(backend)
    const benchId = newUlid()
    const r = await scope.tryAcquireBenchLease(benchId)
    if (r.status !== 'acquired') throw new Error('픽스처 오류')
    return { backend, handle: r.handle, endpoint: endpointOf(digest, { kind: 'bench', benchId }) }
  }

  /**
   * 서열 합성의 `finally` 는 **모든 경로에서** `release()` 를 부른다. 따라서 「release 가 무조건
   * `releasedByUs` 를 세우는」 구현에서는 out-of-band 상실(`stolen`)이 **기본 경로로** `released` 로
   * 덮어써지고, PR2 T17c(재시도 중 탈취)가 사후에 원인을 구분하지 못한다.
   */
  it('탈취된 리스를 나중에 release() 해도 사유가 stolen 으로 유지된다', async () => {
    const { backend, handle, endpoint } = await acquire()
    backend.forceLose(endpoint)
    expect(handle.revalidate()).toEqual({ kind: 'lost', reason: 'stolen' })
    handle.release() // 합성의 finally 가 하는 일
    expect(handle.revalidate()).toEqual({ kind: 'lost', reason: 'stolen' })
  })

  it('정상 해제 사유는 released 로 유지된다(위 행이 stolen 을 항진시키지 않음)', async () => {
    const { handle } = await acquire()
    handle.release()
    expect(handle.revalidate()).toEqual({ kind: 'lost', reason: 'released' })
  })

  /**
   * 페이크 충실도 — 신원 토큰이 없으면 해제된 핸들이 **다른 소유자의 재획득 후 `owned` 로 부활**한다
   * (자체 적대 리뷰 실측). 실 어댑터는 자기 `server.listening` 을 보므로 부활이 없다. 페이크가 실물보다
   * 느슨하면 PR2 의 잘못된 구현이 이 페이크 위에서 GREEN 을 받는다.
   */
  it('해제된 핸들은 다른 소유자가 같은 이름을 재획득해도 부활하지 않는다', async () => {
    const backend = createFakeLockBackend()
    const { scope } = scopeWith(backend)
    const first = await scope.tryAcquire({ kind: 'repo' })
    if (first.status !== 'acquired') throw new Error('픽스처 오류')
    first.handle.release()

    const second = await scope.tryAcquire({ kind: 'repo' })
    expect(second.status).toBe('acquired')
    // 첫 핸들은 여전히 상실 상태여야 한다(부활하면 fail-open).
    expect(first.handle.revalidate()).toEqual({ kind: 'lost', reason: 'released' })
  })
})

/**
 * ---------------------------------------------------------------------------------------------
 * PR2a T6b — 리스 크레덴셜의 신원(계획 정정 54 · 스펙 §W-4 「BenchLeaseToken.identity」)
 * ---------------------------------------------------------------------------------------------
 */

describe('BenchLeaseToken.identity — 권위 CAS 가 대조에 쓰는 3쌍', () => {
  it('민팅된 리스가 identity 3필드를 싣는다', async () => {
    const backend = createFakeLockBackend()
    const commonGitDir = `/repo-${randomBytes(8).toString('hex')}/.git`
    const benchRoot = '/workbenches'
    const scope = createLockScope({ identity: { commonGitDir, benchRoot }, backend })
    const benchId = newUlid()

    const r = await scope.tryAcquireBenchLease(benchId)
    if (r.status !== 'acquired') throw new Error(`픽스처 오류: ${r.status}`)
    expect(r.lease.identity).toEqual({ commonGitDir, benchRoot, benchId })
  })

  /**
   * **digest 를 호출자가 따로 주지 않는 것이 계약이다**(정정 54). 둘을 각각 받으면
   * 「digest 는 레포 A · identity 는 레포 B」인 스코프가 정상 컴파일되고, 그 스코프는 **A 의 endpoint 를
   * 잡은 채 B 의 권위 파일을 변이**한다 — 배타와 대조가 서로 다른 레포를 가리키는 fail-open 이다.
   */
  it('endpoint 이름이 identity.commonGitDir 에서 유도된다(불일치 창 부재)', async () => {
    const backend = createFakeLockBackend()
    const commonGitDir = `/repo-${randomBytes(8).toString('hex')}/.git`
    const scope = createLockScope({ identity: { commonGitDir, benchRoot: '/wb' }, backend })

    await scope.tryAcquire({ kind: 'repo' })
    expect(backend.calls).toEqual([
      { op: 'bind', endpoint: endpointOf(endpointDigest(commonGitDir), { kind: 'repo' }) },
    ])
  })
})
