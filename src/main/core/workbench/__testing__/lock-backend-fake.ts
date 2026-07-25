import type { BindOutcome, BoundEndpoint, LockBackend } from '../locks'

/**
 * 락 백엔드 페이크 (#251 PR1b · 테스트 전용 · **실행되지 않고 import 만 된다**).
 *
 * 존재 이유는 커버리지 대응 ⓐ다(계획 §3.1): 실 추상 소켓은 Linux 전용이라 판정·서열·리스 계약을 실
 * 어댑터로만 검증하면 그 계약 전부가 win32 로컬에서 skip 된다. 백엔드를 주입 seam 뒤에 두고 이 페이크로
 * **양 OS 에서** 계약을 돌린다. 실 어댑터가 페이크와 같은 계약을 만족하는지는 `lock-backend-uds.test.ts`
 * (Linux 게이트)가 본다.
 *
 * `owners` 는 **커널 추상 이름공간의 시늉**이다 — 키 존재 = 점유, 값 = **그 점유의 신원 토큰**.
 * 두 페이크 인스턴스에 같은 Map 을 주면 「같은 커널을 보는 두 엔진 인스턴스」가 되고, 서로 다른 Map 을
 * 주면 별개 net namespace 가 된다.
 *
 * ⚠ **신원 토큰이 계약이다**(자체 적대 리뷰 실측): 값 없이 「이름이 점유됐는가」만 모델링하면, 해제된
 * 핸들이 **다른 소유자의 재획득 후 `owned` 로 부활**한다(실측: `isBound()` 가 true 로 되살아남). 실
 * 어댑터는 자기 `server.listening` 을 보므로 그런 부활이 없다 — 페이크가 실물보다 느슨하면 PR2 의
 * 잘못된 구현이 이 페이크 위에서 GREEN 을 받는다.
 *
 * ⚠ `forceLose` 도 **계약의 일부**다(계획 정정 ⑲) — `release()` 를 거치지 않고 밑단 endpoint 만
 * 무효화하는 경로가 없으면, 「`isBound()`(커널 상태)를 읽는 구현」과 「자체 `released` 불리언을 읽는
 * 구현」이 **어떤 단언으로도 구분되지 않는다**. 실 어댑터에서는 소유자 생존 중 외부가 endpoint 를 없앨 수
 * 없어 이 상태가 원리적으로 도달 불가하므로(§W-3 L-6 주), `reason:'stolen'` 검증은 이 훅 전용이다.
 * PR2 T17c(재시도 중 리스 탈취)가 그대로 재사용한다.
 */

export type FakeCall =
  | { readonly op: 'bind'; readonly endpoint: string }
  | { readonly op: 'isBound'; readonly endpoint: string }
  | { readonly op: 'close'; readonly endpoint: string }

export interface FakeLockBackend extends LockBackend {
  /** 호출 로그 — 「판정 경로에서 백엔드 조회 외 호출 0」·「bind 시도 정확히 1회」 단언용. */
  readonly calls: FakeCall[]
  /** 다른 프로세스가 점유한 상태를 만든다(우리 핸들 없이). */
  occupy(endpoint: string): void
  vacate(endpoint: string): void
  /** 다음 bind 1회를 지정 errno 로 실패시킨다(미지 errno → `unavailable` 경로). */
  failNextBind(code: string | undefined, detail?: string): void
  /** out-of-band 무효화 — 위 주석 참조. */
  forceLose(endpoint: string): void
}

/** 커널 이름공간 시늉 — endpoint → 그 점유의 신원 토큰. */
export type FakeNamespace = Map<string, symbol>

export function createFakeLockBackend(owners: FakeNamespace = new Map()): FakeLockBackend {
  const calls: FakeCall[] = []
  let nextFailure: { code: string | undefined; detail: string } | undefined

  return {
    kind: 'uds-abstract',
    calls,
    occupy: (endpoint) => void owners.set(endpoint, Symbol('외부 점유자')),
    vacate: (endpoint) => void owners.delete(endpoint),
    failNextBind: (code, detail = `주입 실패(${String(code)})`) => {
      nextFailure = { code, detail }
    },
    forceLose: (endpoint) => void owners.delete(endpoint),
    // 실 어댑터가 async 이므로 계약을 맞춘다(페이크는 즉시 해소 — 재시도·대기 금지가 계약이다).
    bind(endpoint: string): Promise<BindOutcome> {
      calls.push({ op: 'bind', endpoint })
      if (nextFailure) {
        const f = nextFailure
        nextFailure = undefined
        return Promise.resolve({ status: 'error', code: f.code, detail: f.detail })
      }
      if (owners.has(endpoint)) return Promise.resolve({ status: 'in-use' })

      // 이 bind 의 신원. 이후 판정은 전부 「이 토큰이 아직 그 이름의 소유자인가」다.
      const token = Symbol('이 bind 의 소유 토큰')
      owners.set(endpoint, token)
      const bound: BoundEndpoint = {
        name: endpoint,
        isBound: () => {
          calls.push({ op: 'isBound', endpoint })
          return owners.get(endpoint) === token
        },
        close: () => {
          calls.push({ op: 'close', endpoint })
          // 내가 여전히 소유자일 때만 비운다 — 남의 점유를 해제하지 않는다.
          if (owners.get(endpoint) === token) owners.delete(endpoint)
        },
      }
      return Promise.resolve({ status: 'bound', endpoint: bound })
    },
  }
}
