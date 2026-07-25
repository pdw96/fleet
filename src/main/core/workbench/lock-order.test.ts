import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createFakeLockBackend, type FakeLockBackend } from './__testing__/lock-backend-fake'
import { createOrderedLocks, type OrderedLocks } from './lock-order'
import { createLockScope, endpointFor, type LockKeySpec } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR1b T6 — 락 서열(L-3) · `r → <benchId> → slot`.
 *
 * **왜 런타임 가드가 1차 방어인가**(계획 정정 ㉑ · 최고 심각도): phantom 레벨만 두면 **루트 재민팅 한 줄**로
 * 서열이 무력화된다(실측: slot 보유 중 `withRepoLock(root())` = tsc 에러 0). 콜백 인자를 무시하고 루트를
 * 새로 만들면 역순이 타입상 완전 합법이므로, 타입 핀은 「스레딩 사고 방지」이고 실제 falsifier 는
 * `AsyncLocalStorage` 기반 런타임 가드다. 모듈 전역 변수로 추적하면 **안 된다** — §W-12 가 동시 bench
 * 2개 이상을 강제하므로 전역 추적기는 무관한 bench 사이에 허위 위반을 던진다(아래 격리 행이 그 falsifier).
 */

const orderedWith = (
  backend: FakeLockBackend,
): { ordered: OrderedLocks; backend: FakeLockBackend; digest: string } => {
  const digest = randomBytes(16).toString('hex')
  return { ordered: createOrderedLocks(createLockScope({ digest, backend })), backend, digest }
}

const occupy = (backend: FakeLockBackend, digest: string, spec: LockKeySpec): void => {
  const ep = endpointFor(digest, spec)
  if (ep.status !== 'ok') throw new Error('픽스처 오류')
  backend.occupy(ep.endpoint)
}

describe('정상 서열 — 설계가 의도한 경로가 타입·런타임 모두 통과한다', () => {
  it('r → bench → slot 전체 중첩', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    const r = await ordered.withRepoLock(ordered.root(), (repoCtx) =>
      ordered.withBenchLease(repoCtx, newUlid(), (_lease, benchCtx) =>
        ordered.trySlot(benchCtx, 0, () => Promise.resolve('깊이3')),
      ),
    )
    expect(r).toEqual({
      status: 'ran',
      value: { status: 'ran', value: { status: 'ran', value: '깊이3' } },
    })
  })

  // bench 리스를 `r` 없이 획득하는 것은 스펙 자신의 정상 상태다(계획 감사 L4-5) — 중첩 강제 형태였다면
  // 이 행이 타입 에러가 된다.
  it('r 없이 bench 리스만 획득(정상 상태)', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    const r = await ordered.withBenchLease(ordered.root(), newUlid(), (lease) => {
      expect(lease.revalidate()).toEqual({ kind: 'owned' })
      return Promise.resolve(1)
    })
    expect(r.status).toBe('ran')
  })

  it('아무 락도 없이 슬롯만 try(정상 상태)', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    expect((await ordered.trySlot(ordered.root(), 1, () => Promise.resolve(1))).status).toBe('ran')
  })

  it('구간을 정상 종료하면 락이 풀린다(같은 키 재획득 가능)', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await ordered.withRepoLock(ordered.root(), () => Promise.resolve(1))
    expect((await ordered.withRepoLock(ordered.root(), () => Promise.resolve(2))).status).toBe(
      'ran',
    )
  })

  it('콜백이 throw 해도 락이 풀리고 예외는 호출자로 전파된다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.withRepoLock(ordered.root(), () => Promise.reject(new Error('안쪽 실패'))),
    ).rejects.toThrow('안쪽 실패')
    expect((await ordered.withRepoLock(ordered.root(), () => Promise.resolve(1))).status).toBe(
      'ran',
    )
  })
})

describe('§3-T11 역순 금지 — 타입 핀 + 런타임 가드', () => {
  it('bench 리스 보유 중 레포 락은 거부된다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.withBenchLease(ordered.root(), newUlid(), (_lease, benchCtx) =>
        // @ts-expect-error 서열 핀: 레벨 2 컨텍스트는 레벨 0 을 요구하는 withRepoLock 에 넘길 수 없다
        ordered.withRepoLock(benchCtx, () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/lock-order-violation/)
  })

  it('슬롯 보유 중 레포 락은 거부된다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.trySlot(ordered.root(), 0, (slotCtx) =>
        // @ts-expect-error 서열 핀: 레벨 3 컨텍스트는 레벨 0 을 요구하는 withRepoLock 에 넘길 수 없다
        ordered.withRepoLock(slotCtx, () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/lock-order-violation/)
  })

  it('슬롯 보유 중 bench 리스는 거부된다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.trySlot(ordered.root(), 0, (slotCtx) =>
        // @ts-expect-error 서열 핀: 레벨 3 컨텍스트는 레벨 0|1 을 요구하는 withBenchLease 에 넘길 수 없다
        ordered.withBenchLease(slotCtx, newUlid(), () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/lock-order-violation/)
  })

  it('같은 레벨 중첩(bench 안에서 또 다른 bench)도 거부된다 — 대기 간선이 생기면 사이클이 가능하다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.withBenchLease(ordered.root(), newUlid(), (_lease, benchCtx) =>
        // @ts-expect-error 서열 핀: 레벨 2 컨텍스트는 레벨 0|1 을 요구하는 withBenchLease 에 넘길 수 없다
        ordered.withBenchLease(benchCtx, newUlid(), () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/lock-order-violation/)
  })

  /**
   * **이 행이 서열 가드의 진짜 falsifier 다.** 타입은 완전히 통과한다(루트를 새로 민팅하므로) —
   * 런타임 가드가 없으면 GREEN 이 되고 서열은 한 줄로 무력화된다.
   */
  it('루트 재민팅으로 우회할 수 없다(타입은 통과 · 런타임이 거부)', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.trySlot(ordered.root(), 0, () =>
        ordered.withRepoLock(ordered.root(), () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/lock-order-violation/)
  })

  it('위반 메시지는 어느 레벨에서 어느 레벨로 갔는지 싣는다(운영자·개발자 진단)', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.trySlot(ordered.root(), 0, () =>
        ordered.withRepoLock(ordered.root(), () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/slot.*repo|repo.*slot/)
  })
})

/**
 * ALS 격리 — 서로 다른 비동기 컨텍스트는 서로의 레벨을 보지 않는다.
 * 모듈 전역 변수로 레벨을 추적하는 구현이 **이 행에서만** RED 다(§W-12 하한 = 동시 bench 2개).
 */
describe('동시 bench 2개 — 서열 추적이 비동기 컨텍스트 스코프다', () => {
  /**
   * **모듈 전역 추적 구현이 이 행에서만 RED 다.** A 가 레벨 3(슬롯)을 실제로 보유하고 있는 **그 시각에**
   * 형제 체인 B 가 레벨 1(레포 락)을 획득한다 — 전역 카운터라면 「slot 보유 중 repo 획득」으로 보여
   * 허위 위반을 던진다. 핸드셰이크로 시각을 고정했으므로 우연 의존이 아니다.
   */
  it('A 가 레벨 3 보유 중인 그 시각에 형제 체인 B 가 레벨 1 을 획득한다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    let announceAHolds = (): void => {}
    let letAFinish = (): void => {}
    const aHolds = new Promise<void>((resolve) => (announceAHolds = resolve))
    const aMayFinish = new Promise<void>((resolve) => (letAFinish = resolve))

    const a = ordered.withBenchLease(ordered.root(), newUlid(), (_lease, benchCtx) =>
      ordered.trySlot(benchCtx, 0, async () => {
        announceAHolds()
        await aMayFinish // 보유를 유지한 채 B 가 완주하기를 기다린다
        return 'A'
      }),
    )

    await aHolds
    // B 는 **테스트의 컨텍스트**에서 시작한다(A 의 콜백 안이 아니다) = 형제 체인.
    const b = await ordered.withRepoLock(ordered.root(), (repoCtx) =>
      ordered.withBenchLease(repoCtx, newUlid(), () => Promise.resolve('B')),
    )
    letAFinish()

    expect(b).toEqual({ status: 'ran', value: { status: 'ran', value: 'B' } })
    expect((await a).status).toBe('ran')
  })

  /**
   * 대칭 정직성: **보유 구간 안에서 다른 bench 의 체인을 시작하는 것은 거부된다.** 이는 버그가 아니라
   * 의도된 fail-closed 다 — 임계 구역 안에서 다른 bench 의 서열을 처음부터 타면 대기 간선이 생겨 L-3 의
   * 「사이클 불가」 논증이 깨진다. 올바른 호출 형태는 위 행처럼 **형제 체인**이다.
   */
  it('보유 구간 안에서 다른 bench 체인을 시작하는 것은 거부된다(의도된 fail-closed)', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    await expect(
      ordered.withBenchLease(ordered.root(), newUlid(), () =>
        ordered.withRepoLock(ordered.root(), () => Promise.resolve(1)),
      ),
    ).rejects.toThrow(/lock-order-violation/)
  })

  it('두 체인을 Promise.all 로 겹쳐도 서로의 레벨이 새지 않는다', async () => {
    const { ordered } = orderedWith(createFakeLockBackend())
    const chain = (slot: number): Promise<unknown> =>
      ordered.withBenchLease(ordered.root(), newUlid(), (_lease, benchCtx) =>
        ordered.trySlot(benchCtx, slot, () => Promise.resolve(slot)),
      )
    const [x, y] = await Promise.all([chain(0), chain(1)])
    expect([x, y].map((r) => (r as { status: string }).status)).toEqual(['ran', 'ran'])
  })
})

describe('held·unavailable 전파 · 데드락 부재(§3-T11 후반)', () => {
  it('키가 점유돼 있으면 held 를 돌려주고 콜백을 실행하지 않는다', async () => {
    const backend = createFakeLockBackend()
    const { ordered, digest } = orderedWith(backend)
    occupy(backend, digest, { kind: 'repo' })
    let called = 0
    const r = await ordered.withRepoLock(ordered.root(), () => {
      called++
      return Promise.resolve(1)
    })
    expect(r).toEqual({ status: 'held' })
    expect(called).toBe(0)
  })

  it('bind 오류는 unavailable 로 전파되고 콜백을 실행하지 않는다(fail-closed)', async () => {
    const backend = createFakeLockBackend()
    const { ordered } = orderedWith(backend)
    backend.failNextBind('EACCES')
    let called = 0
    const r = await ordered.withRepoLock(ordered.root(), () => {
      called++
      return Promise.resolve(1)
    })
    expect(r.status).toBe('unavailable')
    expect(called).toBe(0)
  })

  /**
   * 「데드락 부재」(§3-T11 원문 후반 · 계획에서 탈락했던 절) 의 관측형: 3키가 전부 점유된 최악 상태에서도
   * 합성 호출이 **대기하지 않고** 즉시 `held` 를 답한다. 슬롯이 비대기 try-acquire 전용이라 대기 간선이
   * 없다는 L-3 의 안전 논증을 행동으로 뒷받침한다.
   */
  it('3키 전부 점유 상태에서 합성 호출이 대기 없이 held 로 끝난다', async () => {
    const backend = createFakeLockBackend()
    const { ordered, digest } = orderedWith(backend)
    const benchId = newUlid()
    occupy(backend, digest, { kind: 'repo' })
    occupy(backend, digest, { kind: 'bench', benchId })
    occupy(backend, digest, { kind: 'slot', index: 0 })

    let turns = 0
    let done = false
    const tick = (): void => {
      if (done) return
      turns++
      setImmediate(tick)
    }
    setImmediate(tick)
    const results = [
      await ordered.withRepoLock(ordered.root(), () => Promise.resolve(1)),
      await ordered.withBenchLease(ordered.root(), benchId, () => Promise.resolve(1)),
      await ordered.trySlot(ordered.root(), 0, () => Promise.resolve(1)),
    ]
    done = true
    expect(results.map((r) => r.status)).toEqual(['held', 'held', 'held'])
    expect(turns).toBe(0)
  })
})

/**
 * 위조 타입 핀 — **실행되지 않는다.** 판정자는 `npm run typecheck` 이며(vitest 는 타입을 검사하지 않는다),
 * `@ts-expect-error` 는 에러가 사라지면 「Unused directive」로 그 자체가 컴파일 에러가 된다.
 *
 * 브랜드를 문자열 프로퍼티(`{__level:0}`)로 강등하면 두 번째 핀이 TS2578 로 RED 가 된다 — 즉 이 함수가
 * **브랜드 형태 회귀의 falsifier** 다(역순 핀은 브랜드 형태에 무신호 · 감사 refuter 정정).
 */
export async function __forgeryTypePins(ordered: OrderedLocks): Promise<void> {
  // @ts-expect-error 위조 핀: 빈 객체에는 미export 브랜드가 없다
  await ordered.withRepoLock({}, () => Promise.resolve(1))
  // @ts-expect-error 위조 핀: 문자열 프로퍼티 브랜드는 이 설계의 브랜드가 아니다(unique symbol 필수)
  await ordered.withRepoLock({ __level: 0 }, () => Promise.resolve(1))
  // @ts-expect-error 위조 핀: 임의 심볼 키는 미export unique symbol 과 동일하지 않다
  await ordered.withRepoLock({ [Symbol('level')]: 0 }, () => Promise.resolve(1))
  // @ts-expect-error 위조 핀: 슬롯 레벨 컨텍스트를 만들어낼 공개 수단이 없다
  await ordered.trySlot({ level: 2 }, 0, () => Promise.resolve(1))
}
