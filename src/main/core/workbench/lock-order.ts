import { AsyncLocalStorage } from 'node:async_hooks'

import type { BenchLeaseToken, LockHandle, LockScope } from './locks'

/**
 * 락 서열 (#251 PR1b T6 · 스펙 §W-3 L-3) — `r` → `<benchId>` → 슬롯. **역순 금지.**
 *
 * 방어가 3층인 이유(계획 정정 ㉑ · 최고 심각도): phantom 레벨만으로는 **루트 재민팅 한 줄**에 무력화된다.
 * 콜백 인자를 무시하고 루트를 새로 만들면 역순이 tsc 상 완전 합법이고(실측: 에러 0건), `as unknown as`·
 * `as never`·`Parameters<>`·`keyof` 우회 4종도 통과한다. 따라서
 *
 *   ① **런타임 서열 가드**(이 파일 · `AsyncLocalStorage`) = 1차 방어 · 유일하게 RED 를 만들 수 있는 형태
 *   ② 루트 민팅 진입점 단일화 + 구조 단언(export 집합 · raw 이름 스캔)
 *   ③ phantom 레벨 = **스레딩 사고 방지 + 문서화**(「tsc 가 역순을 막는다」는 과장이었다)
 *
 * ⚠ 레벨 추적은 **비동기 컨텍스트 스코프여야 한다.** 모듈 전역 변수로 두면 §W-12 가 강제하는 동시 bench
 * 2개 이상에서 무관한 bench 사이에 **허위 위반**을 던진다(bench A 가 슬롯 보유 중 bench B 의 `r` 획득).
 * `AsyncLocalStorage` 는 그 스코프를 정확히 준다.
 *
 * ⚠ **L-5a 는 이 PR 에 착지하지 않는다**(계획 정정 ㉜). 「`r` 보유 중 bench 리스 대기 금지 → 즉시 해제 후
 * 백오프 재시도」는 **합성 층** 제약이고, L-2 가 성립하는 한 프리미티브 층에는 「대기」 상태 자체가 없어
 * 관측 대상이 없다(항진). 재시도 정책의 소비자가 생기는 **PR5 T21** 이 단독 귀속한다.
 */

/**
 * 서열 레벨. 값이 클수록 나중에 획득해야 한다. 획득 규칙은 단일 술어로 표현된다 —
 * **현재 레벨 ≥ 목표 레벨이면 위반**(역순과 동일 레벨 중첩을 동시에 막는다).
 */
export const LOCK_LEVEL = { none: 0, repo: 1, bench: 2, slot: 3 } as const

type LevelName = keyof typeof LOCK_LEVEL

const LEVEL_NAME: Record<number, LevelName> = {
  0: 'none',
  1: 'repo',
  2: 'bench',
  3: 'slot',
}

/**
 * 브랜드 심볼 **미export** — 외부에서 이 키를 가진 객체를 만들 수 없다. 문자열/숫자 프로퍼티 브랜드로
 * 강등하면 `{ __level: 0 }` 리터럴 한 개로 위조된다(실측) — 그래서 `unique symbol` 은 장식이 아니라 하중이다.
 */
declare const HELD_LEVEL: unique symbol

/** 「현재 레벨 L 을 보유한 구간」 증거. 런타임 값은 없다(타입 전용 브랜드). */
export interface Held<L extends number> {
  readonly [HELD_LEVEL]: L
}

/** 서열 위반은 운영 조건이 아니라 **프로그래밍 오류**다 — 값으로 보고하지 않고 던진다. */
export class LockOrderViolationError extends Error {
  constructor(current: number, target: number) {
    super(
      `lock-order-violation: ${LEVEL_NAME[current] ?? current}(레벨 ${current}) 보유 중 ` +
        `${LEVEL_NAME[target] ?? target}(레벨 ${target}) 획득 시도 — 서열은 repo → bench → slot 이다`,
    )
    this.name = 'LockOrderViolationError'
  }
}

export type LockRun<T> =
  | { readonly status: 'ran'; readonly value: T }
  | { readonly status: 'held' }
  | { readonly status: 'unavailable'; readonly detail: string }

export interface OrderedLocks {
  /**
   * 서열 진입점 — **루트 컨텍스트를 만드는 유일한 경로**.
   * 재민팅 자체를 타입으로 막을 수는 없으므로(위 주석) 이 호출의 존재는 런타임 가드가 전제한다.
   */
  root(): Held<0>
  withRepoLock<T>(ctx: Held<0>, fn: (ctx: Held<1>) => Promise<T>): Promise<LockRun<T>>
  withBenchLease<T>(
    ctx: Held<0 | 1>,
    benchId: string,
    fn: (lease: BenchLeaseToken, ctx: Held<2>) => Promise<T>,
  ): Promise<LockRun<T>>
  /** 상한 슬롯 — **비대기 try-acquire 전용**(대기 간선을 추가하지 않으므로 사이클 불가 · L-3). */
  trySlot<T>(
    ctx: Held<0 | 1 | 2>,
    index: number,
    fn: (ctx: Held<3>) => Promise<T>,
  ): Promise<LockRun<T>>
}

const levelStore = new AsyncLocalStorage<number>()

/**
 * 브랜드는 타입에만 존재하므로(`declare const` = 런타임 값 없음) 토큰은 **캐스트로만** 만들 수 있다 —
 * phantom 브랜드 관용구의 불가피한 부분이다. 이것이 이 모듈의 **유일한 forge 지점**이며, 캐스트가
 * 2곳(여기 + `locks.ts` 의 리스 민팅)을 넘지 않는 것은 `locks-structure.test.ts` 가 exact 개수로 핀한다.
 */
const heldToken = <L extends number>(): Held<L> => Object.freeze({}) as Held<L>

export function createOrderedLocks(scope: LockScope): OrderedLocks {
  /**
   * 서열 구간 실행 — 획득 → (성공 시) 레벨을 올린 컨텍스트에서 콜백 → **finally 해제**.
   * 해제를 finally 에 두는 이유: 콜백이 throw 해도 락이 남으면 다음 획득이 영구 `held` 가 된다.
   */
  const inLevel = async <T>(
    target: number,
    acquire: () => Promise<
      | { status: 'acquired'; handle: LockHandle; lease?: BenchLeaseToken }
      | { status: 'held' }
      | { status: 'unavailable'; detail: string }
    >,
    run: (lease: BenchLeaseToken | undefined) => Promise<T>,
  ): Promise<LockRun<T>> => {
    const current = levelStore.getStore() ?? LOCK_LEVEL.none
    if (current >= target) throw new LockOrderViolationError(current, target)

    const got = await acquire()
    if (got.status === 'held') return { status: 'held' }
    if (got.status === 'unavailable') return { status: 'unavailable', detail: got.detail }
    try {
      const value = await levelStore.run(target, () => run(got.lease))
      return { status: 'ran', value }
    } finally {
      got.handle.release()
    }
  }

  return {
    root: () => heldToken<0>(),

    withRepoLock: (_ctx, fn) =>
      inLevel(
        LOCK_LEVEL.repo,
        () => scope.tryAcquire({ kind: 'repo' }),
        () => fn(heldToken<1>()),
      ),

    withBenchLease: (_ctx, benchId, fn) =>
      inLevel(
        LOCK_LEVEL.bench,
        () => scope.tryAcquireBenchLease(benchId),
        (lease) => {
          // 리스 없이 획득이 성공하는 경로는 없다 — 있으면 계약 위반이므로 조용히 넘기지 않는다.
          if (!lease) throw new Error('bench 리스 획득이 크레덴셜 없이 성공했다(계약 위반)')
          return fn(lease, heldToken<2>())
        },
      ),

    trySlot: (_ctx, index, fn) =>
      inLevel(
        LOCK_LEVEL.slot,
        () => scope.tryAcquire({ kind: 'slot', index }),
        () => fn(heldToken<3>()),
      ),
  }
}
