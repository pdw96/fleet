import { randomBytes } from 'node:crypto'

import type { BenchAuthorityIdentity } from './authority'
// `endpointDigest` 는 **값** import 다(형제 3종은 타입). 순수 sha256 이라 L-6 「판정에 디스크 I/O 0」과
// 무관하고, 아래 구조 단언(fs·path 직접 import 금지)도 그대로 성립한다. 여기서 다시 구현하지 않는 이유는
// digest 산식이 두 곳에 있으면 **드리프트가 곧 배타성 붕괴**이기 때문이다 — 같은 레포가 서로 다른 이름으로
// 갈리면 두 인스턴스가 서로를 보지 못한다.
import { endpointDigest, type LockBackendKind } from './coord-area'
import { isUlid } from './ulid'

/**
 * 자문 락 코어 (#251 · 스펙 §W-3) — **커널 네임스페이스 endpoint** 단독 판정.
 *
 * ```text
 * listen() 성공   = 소유자 부재 증명 → 획득
 * EADDRINUSE      = 소유자 생존      → held(정상 대기)
 * 그 외 오류       = unavailable(fail-closed)
 * ```
 *
 * **왜 파일시스템 pathname 소켓이 폐기됐는가**: 3라운드에 걸쳐 같은 층에서 P1 이 반복된 궤적(①이중 소유
 * 허용 ②그걸 막다 영구 고착 ③전수 probe 의 부정 판정 fail-open)은 전부 뿌리가 하나였다 — **삭제 가능한
 * pathname 을 소유권 증거로 삼음.** 추상 네임스페이스는 pathname 이 없어 그 뿌리를 제거한다.
 *
 * **이 파일은 플랫폼 무관 계약이다.** 실 추상 소켓 어댑터는 `lock-backend-uds.ts`(Linux 전용 · 얇게)에
 * 있고, 여기서는 `LockBackend` 주입 seam 뒤에서만 그것을 본다 — 그래서 판정·서열·리스 계약 전량이
 * **양 OS 에서 페이크로 실행**된다(계획 §3.1 커버리지 대응 ⓐ).
 *
 * ⚠ **위협 모델(§W-2-a 연장 · 명시 비목표)**: 추상 네임스페이스에는 **파일 권한이 없다.** 같은 network
 * namespace 의 비특권 프로세스(= Fleet 이 spawn 하는 CLI 자식은 같은 컨테이너 안이다)가 endpoint 를 먼저
 * bind 하면 이쪽은 EADDRINUSE 를 관측하고, L-1 이 연령·pid·`connect` 를 금지하므로 「형제 엔진이 보유」와
 * 「자식이 스쿼팅」을 **구분할 정보가 0** 이다. 이는 은폐하지 않는 알려진 한계이며 악의적 변조 방어는
 * 이 계약의 목표가 아니다(§W-2-a 가 이미 같은 신뢰 도메인을 전제). ttyd 는 compose `fleet-net`(bridge)의
 * **별개 net ns** 라 현재 범위 밖이지만, 향후 `network_mode: host` 전환은 추상 이름공간을 호스트 전역으로
 * 만들어 이 성질을 바꾼다.
 *
 * ⚠ **반대 방향의 경계가 더 중요하다**: 배타 범위는 **network namespace** 인데 레포 공유 범위는
 * **파일시스템**이다. 두 축이 어긋나면 — 같은 레포 볼륨을 마운트한 **서로 다른 net ns** 의 두 인스턴스가
 * 서로의 endpoint 를 보지 못해 **양쪽 다 획득에 성공**한다(이중 소유 = fail-open). 이 슬라이스가 그것을
 * 막지 못한다는 사실을 은폐하지 않는다 — 「한 영역에 살아있는 인스턴스는 하나」를 만드는 것은
 * **인스턴스 배타**(§W-2-b `active-instance.json` · PR1c)이며, 그것이 이 락 층의 **전제**다.
 * ⚠ 단 그 전제도 **같은 net namespace 안에서만** 런타임으로 집행된다 — cross-ns 구간의 근거는 배포 계약
 * (compose `container_name`)이고, 런타임 층은 그 구간을 차단하지 않고 증거 등급으로 기록만 한다(ADR-0013).
 */

/** 락 endpoint 이름 접두 — 레포 무관 고정. */
export const ENDPOINT_PREFIX = 'fleet.wb.'

/** 레포 변이 락 키(§W-3). */
export const REPO_LOCK_KEY = 'r'

/**
 * 인스턴스 배타 키(§W-2-b · PR1c). **락 키가 아니다** — 서열(L-3) 밖이고 `LockScope` 로 획득되지 않으며,
 * 소유자는 `active-instance.ts` 가 주입 백엔드로 **직접** bind 한다.
 *
 * 왜 전용 키인가(계획 정정 ㊲): 인스턴스 생존 판정은 **부팅부터 종료까지 계속 보유되는** endpoint 를
 * 요구하는데, 락 키 3종은 전부 변이 구간에만 잡혔다 풀리는 **일시 보유**다(서열 합성의 `finally` 가 해제).
 * 그중 하나를 생존 비콘으로 재사용하면 「락을 쥐지 않은 idle 인스턴스」가 사망으로 오판돼 회수되고
 * (이중 인스턴스 = fail-open), 반대로 `r` 을 인스턴스 수명 내내 쥐면 모든 레포 변이가 정지한다.
 */
export const INSTANCE_LOCK_KEY = 'i'

/**
 * 슬롯 키 인덱스 상한(배타) — §W-12 의 `WORKBENCH_MAX_ACTIVE` **절대 상한 4**.
 * ⚠ 이 상수는 **키 문법의 상한**이고 실제 허용 슬롯 개수가 아니다. 개수는 `area.json` 이 소유하며
 * 이 모듈은 **어디서도 개수를 읽지 않는다**(호출자가 인덱스를 준다 — 슬롯 집행은 PR7/T29).
 */
export const SLOT_INDEX_MAX = 4

/**
 * 추상 소켓 이름 상한 = **선행 NUL 을 포함한 총 UTF-8 바이트**.
 *
 * Linux `sizeof(sockaddr_un.sun_path)` = 108 이고 libuv `uv_pipe_bind2` 는 `namelen` 에 **선행 NUL 을
 * 포함**시킨다(`docs/src/pipe.rst`). 이 상한을 **우리가** 집행하는 이유는 위임 결과가 런타임 메이저마다
 * 다르기 때문이다(Docker 실측):
 *   - Node 24.18 : 총 109B → `EINVAL`
 *   - Node 22.22.3(`.nvmrc` · **필수 CI 게이트**) : 총 109B → **성공 + 107B 로 무성 절단**
 *     → 앞 107B 를 공유하는 서로 다른 두 키가 **같은 endpoint 로 붕괴**(EADDRINUSE)
 * 즉 위임하면 게이트 런타임에서 「서로 다른 bench 가 같은 락을 공유」가 조용히 성립한다. 초과는 값으로
 * 보고하고(throw 아님 — 스펙 §W-2 문면 정정) 호출자는 fail-closed 로 분기한다.
 */
export const ABSTRACT_NAME_MAX_BYTES = 108

/** digest = `endpointDigest()` 산출물(32 hex) — 이름공간 스코프 성분. */
const DIGEST_RE = /^[0-9a-f]{32}$/

/**
 * endpoint 키 4종. 앞 3종이 자문 락(§W-3)이고 `instance` 는 **락이 아니라 인스턴스 배타**(§W-2-b)다 —
 * 이름 유도만 여기서 공유한다(예산 preflight 를 우회하는 두 번째 이름 조립 경로를 만들지 않기 위해).
 * 슬롯 개수·bench 목록을 이 모듈이 알 필요는 없다.
 */
export type LockKeySpec =
  | { readonly kind: 'repo' }
  | { readonly kind: 'bench'; readonly benchId: string }
  | { readonly kind: 'slot'; readonly index: number }
  | { readonly kind: 'instance' }

export type EndpointResult =
  /** `endpoint` = **선행 NUL 을 포함한** 전체 소켓 이름(그대로 `listen({path})` 에 넘긴다). */
  | { readonly status: 'ok'; readonly endpoint: string; readonly key: string }
  /** 키·digest 문법 위반 — 정규화하지 않고 거부한다(§W-1 단사 계약). */
  | { readonly status: 'invalid'; readonly detail: string }
  | { readonly status: 'name-too-long'; readonly bytes: number; readonly max: number }

export type NameBudgetResult =
  | { readonly status: 'ok'; readonly bytes: number }
  | { readonly status: 'name-too-long'; readonly bytes: number; readonly max: number }

/**
 * 이름 예산 판정(순수) — **단위는 문자 수가 아니라 UTF-8 바이트**다(한글 1자 = 3바이트).
 * `String.length` 로 재는 구현은 멀티바이트 이름에서 초과를 통과시킨다.
 *
 * ⚠ **정직**: 현행 성분(32 hex digest + 최장 키 ULID 26자)에서 최댓값은 69바이트이므로 이 판정이
 * `name-too-long` 을 내는 경로는 **프로덕션에서 도달 불가**하다. 그럼에도 존재하는 이유는 미래 변경
 * (digest 길이 상향 · 새 키 종류 · 접두 개명)이 **조용한 이름 붕괴**가 아니라 fail-closed 가 되게 하는
 * 것이고, 그 회귀를 실제로 잡는 것은 아래 「정규 최악값」 구조 단언이다.
 */
export function nameBudget(endpoint: string): NameBudgetResult {
  const bytes = Buffer.byteLength(endpoint, 'utf8')
  return bytes > ABSTRACT_NAME_MAX_BYTES
    ? { status: 'name-too-long', bytes, max: ABSTRACT_NAME_MAX_BYTES }
    : { status: 'ok', bytes }
}

const keyOf = (spec: LockKeySpec): { key: string } | { detail: string } => {
  switch (spec.kind) {
    case 'repo':
      return { key: REPO_LOCK_KEY }
    case 'bench':
      // ULID 검증은 「정규화 금지」다 — `sanitize` 계열은 비단사라 두 id 가 같은 이름으로 붕괴한다(§0.1 C12).
      return isUlid(spec.benchId)
        ? { key: spec.benchId }
        : { detail: `benchId 가 ULID 문법 위반: ${JSON.stringify(spec.benchId)}` }
    case 'slot':
      return Number.isInteger(spec.index) && spec.index >= 0 && spec.index < SLOT_INDEX_MAX
        ? { key: `slot-${spec.index}` }
        : { detail: `슬롯 인덱스가 [0,${SLOT_INDEX_MAX}) 정수 범위 밖: ${spec.index}` }
    case 'instance':
      return { key: INSTANCE_LOCK_KEY }
  }
}

/**
 * 락 endpoint 이름 유도 — **이름을 만드는 유일한 경로**(예산 preflight 포함).
 *
 * 이름 성분이 `endpointDigest`(레포 스코프) + 키뿐인 이유: 추상 네임스페이스는 net ns **전역**이라
 * 디렉터리 같은 자연 스코프가 없다. pid·시각·난수를 섞지 않는 것도 계약이다 — 재시작·컨테이너 교체 후
 * **같은 레포가 같은 이름**으로 수렴해야 배타성이 성립한다(L-1: 연령·pid 는 소유 근거가 아니다).
 */
export function endpointFor(digest: string, spec: LockKeySpec): EndpointResult {
  if (!DIGEST_RE.test(digest)) {
    return { status: 'invalid', detail: `digest 가 32 hex 가 아님: ${JSON.stringify(digest)}` }
  }
  const k = keyOf(spec)
  if ('detail' in k) return { status: 'invalid', detail: k.detail }
  const endpoint = `\0${ENDPOINT_PREFIX}${digest}.${k.key}`
  const budget = nameBudget(endpoint)
  if (budget.status !== 'ok') return budget
  return { status: 'ok', endpoint, key: k.key }
}

/**
 * 이 플랫폼에서 실제로 bind 가능한 백엔드 집합 — `openCoordinationArea({supportedBackends})` 의 생산자.
 *
 * 순수 판정만 떼어낸 이유는 `ownerMismatch`(coord-area.ts)와 같다: 실 플랫폼에서는 한쪽 결과만 관측되므로
 * 규칙 자체는 어느 OS 에서도 검증되지 않는다. 호출부(부팅 배선)는 PR7 범위다.
 *
 * win32·macOS 가 빈 배열인 근거는 추측이 아니라 실측이다 — win32 에서 `listen({path:'\0x'})` 는
 * **EINVAL**(조용한 성공·파일 생성 없음), macOS 는 추상 네임스페이스 자체가 없다.
 */
export function availableLockBackends(platform: NodeJS.Platform): readonly LockBackendKind[] {
  return platform === 'linux' ? ['uds-abstract'] : []
}

/* ------------------------------------------------------------------------------------------------
 * 백엔드 주입 seam
 * ---------------------------------------------------------------------------------------------- */

/**
 * bind 된 커널 endpoint. **로컬 상태만** 노출한다 — L-6 이 「디스크 I/O 0」을 요구하므로 보유 판정이
 * 파일시스템·네트워크를 건드릴 여지를 타입에서 없앤다.
 */
export interface BoundEndpoint {
  readonly name: string
  /** 커널이 여전히 이 이름을 이 핸들에 배타 할당하고 있는가(로컬 판정). */
  isBound(): boolean
  /** 즉시 해제. **`'close'` 이벤트를 기다리지 않는다**(아래 `release` 주석). */
  close(): void
}

export type BindOutcome =
  | { readonly status: 'bound'; readonly endpoint: BoundEndpoint }
  /** EADDRINUSE — 소유자 생존. 오류가 아니라 **정상 대기 상태**다. */
  | { readonly status: 'in-use' }
  | { readonly status: 'error'; readonly code?: string; readonly detail: string }

/**
 * 락 백엔드 — 실 어댑터(`lock-backend-uds.ts` · Linux)와 페이크(`__testing__/lock-backend-fake.ts`)가
 * 같은 계약을 만족한다. 이 seam 이 있어야 판정·서열·리스 계약이 **양 OS 에서** 실행된다(§3.1 대응 ⓐ).
 *
 * ⚠ **재시도 금지**: `bind` 는 단 한 번 시도하고 결과를 그대로 답한다(L-2). 백오프·폴링·대기는 이 층의
 * 책임이 아니며(그 합성은 PR5 T21), 「bind 시도 정확히 1회」가 계약 테스트의 주 falsifier 다.
 *
 * ⚠ **테스트 훅이 계약의 일부다**: 페이크는 `forceLose(endpoint)` 로 «`release()` 를 거치지 않은 소유권
 * 상실»을 만든다. 실 어댑터에서는 소유자 생존 중 외부가 endpoint 를 없앨 수 없어(§W-3 L-6 주) 이 상태가
 * 원리적으로 도달 불가하므로, `LeaseCheck.reason==='stolen'` 은 **페이크 전용 경로**다(PR2 T17c 재사용).
 */
export interface LockBackend {
  readonly kind: LockBackendKind
  bind(endpoint: string): Promise<BindOutcome>
}

/* ------------------------------------------------------------------------------------------------
 * 리스 · 핸들
 * ---------------------------------------------------------------------------------------------- */

/** §W-4 채택 어휘. 소비 측 매핑(`lease-invalid`)은 PR2 T8 귀속 — 여기서 새 어휘를 만들지 않는다. */
export type LeaseCheck =
  { readonly kind: 'owned' } | { readonly kind: 'lost'; readonly reason: 'released' | 'stolen' }

/**
 * 브랜드 심볼 **미export** — 민팅은 이 모듈의 **라이브 핸들에서만** 일어난다(§W-4).
 *
 * ⚠ 미export 는 위조를 **완전히** 막지 못한다(실측 · 계획 정정 ㉑): `Parameters<typeof …>`·`keyof` 로
 * 타입을 구조적으로 재획득할 수 있고 `as unknown as`·`as never` 도 tsc 를 통과한다. 그래서 기계 강제는
 * eslint `@typescript-eslint/no-unsafe-type-assertion`(이 파일 한정 옵트인)이 담당하고, 브랜드는
 * **문자열 프로퍼티가 아니라 `unique symbol` 이어야** 한다 — `{__level:0}` 형 리터럴 위조가 실측으로
 * 통과했기 때문이다.
 */
declare const BENCH_LEASE: unique symbol

/**
 * bench 활동 리스 크레덴셜(§W-4).
 *
 * `identity` 는 권위 CAS 가 **대조**에 쓴다(§W-4 불변식 ⑨ · `lease-invalid{identity-mismatch}`).
 * 크레덴셜이 자기 신원을 함께 나르는 이유는, 리스와 레코드가 서로 다른 레포·bench 를 가리키는 조합을
 * **호출자가 조립할 수 없게** 하기 위해서다 — 두 값을 따로 넘기면 그 불일치가 정상 컴파일된다.
 */
export interface BenchLeaseToken {
  readonly [BENCH_LEASE]: true
  readonly identity: BenchAuthorityIdentity
  readonly ownerToken: string
  /**
   * L-6 per-retry 재검증 수단. 클로저를 **락 모듈이 소유**한다 — 반대로 하면 `authority.ts → locks.ts`
   * 의존 역전이 강제된다(§W-4 각주).
   */
  revalidate(): LeaseCheck
}

export interface LockHandle {
  readonly key: string
  /** 이 획득의 소유 증거. PR2 권위 레코드의 `writtenBy.ownerToken` 이 이 값을 쓴다. */
  readonly ownerToken: string
  revalidate(): LeaseCheck
  /**
   * 해제. `close()` 는 fd 를 **동기 해제**하지만 `'close'` 이벤트는 커넥션이 남아 있으면 발화하지
   * 않는다(실측: 커넥션 1개 → 150ms 내 미발화). 따라서 **`'close'` 를 기다리지 않는다** — 기다리면
   * 누군가 endpoint 에 connect 해 둔 동안 종료가 영구 지연되고 C3 graceful drain 이 상한까지 끌려간다.
   */
  release(): void
}

export type AcquireOutcome =
  | { readonly status: 'acquired'; readonly handle: LockHandle }
  /** 소유자 생존 — 정상 대기. */
  | { readonly status: 'held' }
  /** 모호는 전부 fail-closed(L-2). */
  | { readonly status: 'unavailable'; readonly detail: string }

export type BenchLeaseOutcome =
  | {
      readonly status: 'acquired'
      readonly handle: LockHandle
      readonly lease: BenchLeaseToken
    }
  | { readonly status: 'held' }
  | { readonly status: 'unavailable'; readonly detail: string }

/** 획득 가능한 키 중 bench 를 제외한 것 — bench 는 리스 크레덴셜을 함께 민팅하므로 전용 진입점을 쓴다. */
export type PlainLockSpec = Extract<LockKeySpec, { kind: 'repo' } | { kind: 'slot' }>

export interface LockScope {
  /** 레포 변이 락·슬롯 획득(논블로킹). */
  tryAcquire(spec: PlainLockSpec): Promise<AcquireOutcome>
  /** bench 활동 리스 획득(논블로킹) — 성공 시 `BenchLeaseToken` 을 민팅한다. */
  tryAcquireBenchLease(benchId: string): Promise<BenchLeaseOutcome>
}

export interface LockScopeOptions {
  /**
   * 이 스코프가 대표하는 레포·bench 홈. **정준화·검증은 호출자 책임**이다(배선 = PR7) — 이 모듈은
   * 파일시스템을 알지 못하므로 문자열을 받기만 한다.
   *
   * ⚠ **digest 를 따로 받지 않는 것이 계약이다**(계획 정정 54). 둘을 각각 받으면 「digest 는 레포 A ·
   * identity 는 레포 B」인 스코프가 정상 컴파일되고, 그런 스코프는 **A 의 endpoint 를 잡은 채 B 의 권위
   * 파일을 변이**한다 — 배타와 대조가 서로 다른 레포를 가리키는 fail-open 이다.
   */
  readonly identity: Omit<BenchAuthorityIdentity, 'benchId'>
  readonly backend: LockBackend
}

/**
 * 락 스코프 — 한 코디네이션 영역(=한 레포)에 대한 획득 진입점.
 *
 * ⚠ **정직**: 이 함수가 노출하는 `tryAcquire`/`tryAcquireBenchLease` 는 **서열 가드를 거치지 않는다**.
 * 서열(L-3)은 `withRepoLock`/`withBenchLease`/`trySlot` 합성이 집행하며, 그 합성만이 소비자에게 인가된
 * 경로다(현재 소비자 0 — PR7 이 배선). 이 잔여 구멍은 은폐하지 않고 구조 단언으로 관리한다:
 * 「락 모듈 export 집합 exact 동치」 + 「raw 획득 이름이 모듈 밖 소스에 0건」.
 */
export function createLockScope(opts: LockScopeOptions): LockScope {
  // **생성 시점 스냅샷**(Codex PR#264 P1). `readonly` 는 참조된 객체를 얼리지 않으므로, 호출자가 평범한
  // 객체를 넘기면 이 함수가 반환된 뒤에도(또는 `bind()` 를 await 하는 동안) 필드를 바꿀 수 있다.
  // digest 는 원본에서 유도되는데 민팅이 변형본을 읽으면 **레포 B 토큰이 레포 A endpoint 로 뒷받침**된다.
  const identity = Object.freeze({
    commonGitDir: opts.identity.commonGitDir,
    benchRoot: opts.identity.benchRoot,
  })
  const digest = endpointDigest(identity.commonGitDir)
  const acquire = async (
    spec: LockKeySpec,
  ): Promise<
    | { status: 'acquired'; key: string; bound: BoundEndpoint; ownerToken: string }
    | { status: 'held' }
    | { status: 'unavailable'; detail: string }
  > => {
    const ep = endpointFor(digest, spec)
    if (ep.status === 'invalid') {
      // 부수효과 이전에 막는다 — 이 경로에서는 어떤 bind 도 시도하지 않는다.
      return { status: 'unavailable', detail: `락 키 무효: ${ep.detail}` }
    }
    if (ep.status === 'name-too-long') {
      return {
        status: 'unavailable',
        detail: `endpoint 이름이 예산 초과(${ep.bytes}B > ${ep.max}B) — 이름 성분을 줄일 것`,
      }
    }
    const outcome = await opts.backend.bind(ep.endpoint)
    switch (outcome.status) {
      case 'bound':
        return {
          status: 'acquired',
          key: ep.key,
          bound: outcome.endpoint,
          ownerToken: randomBytes(16).toString('hex'),
        }
      case 'in-use':
        return { status: 'held' }
      case 'error':
        return {
          status: 'unavailable',
          detail: `bind 실패(code=${outcome.code ?? '미지'}): ${outcome.detail}`,
        }
    }
  }

  const makeHandle = (
    key: string,
    bound: BoundEndpoint,
    ownerToken: string,
    // 리스 민팅이 `handle.revalidate` 를 **떼어내지 않도록** 클로저를 함께 반환한다 — 메서드 참조를
    // 분리하면 `unbound-method` 위반이고, 무엇보다 핸들과 크레덴셜이 같은 클로저를 공유해야
    // 「둘이 같은 커널 endpoint 를 증언한다」가 구조적으로 보장된다.
  ): { handle: LockHandle; revalidate: () => LeaseCheck } => {
    /** `release()` 를 우리가 불렀는지 — `'released'` 와 `'stolen'` 을 구분하는 유일한 성분. */
    let releasedByUs = false
    const revalidate = (): LeaseCheck => {
      // 판정 근거는 **커널 상태**(로컬 조회)다. 자체 불리언만 보면 out-of-band 무효화를 놓친다.
      if (bound.isBound()) return { kind: 'owned' }
      return { kind: 'lost', reason: releasedByUs ? 'released' : 'stolen' }
    }
    /**
     * ⚠ **이미 잃은 리스에 대해서는 아무것도 기록하지 않는다.** 순진하게 `releasedByUs = true` 를 먼저
     * 세우면, out-of-band 로 상실된(=`stolen`) 리스가 나중에 `release()` 를 거치는 순간 판정이
     * **`released` 로 덮어써진다**. 그리고 서열 합성(`lock-order.ts`)의 `finally` 가 **모든 경로에서**
     * `release()` 를 부르므로 그 덮어쓰기는 예외가 아니라 **기본 경로**가 된다 — PR2 T17c(재시도 중 탈취)가
     * 사후에 원인을 구분하지 못하게 된다. 소유 중일 때만 「내가 놓았다」로 기록한다.
     */
    const release = (): void => {
      if (!bound.isBound()) return
      releasedByUs = true
      bound.close()
    }
    return { handle: { key, ownerToken, revalidate, release }, revalidate }
  }

  /**
   * 리스 민팅 — **라이브 핸들에서만** 일어난다(§W-4 「브랜드 심볼 미export · 민팅은 라이브 핸들에서만」). `revalidate` 클로저를 그대로 넘겨주므로
   * 크레덴셜과 핸들이 **같은 커널 endpoint 를 증언**한다(둘이 갈리면 「해제된 락의 유효한 리스」가 생긴다).
   */
  const mintLease = (
    ownerToken: string,
    revalidate: () => LeaseCheck,
    benchId: string,
  ): BenchLeaseToken =>
    // **바깥 객체까지 얼린다**(Codex PR#264 2R P1). 중첩 `identity` 만 얼리면
    // `Object.assign(lease, { identity: B })` 가 캐스트 없이 통과하는데, 그것은 **같은 객체**라
    // 원장에 그대로 남아 `isMintedLease` 가 true 를 답한다 — 배타는 A · 변이는 B 가 된다.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 브랜드(`BENCH_LEASE`)는 런타임 값이 없는 타입 전용 심볼이라 캐스트로만 민팅된다. 이곳이 §W-4 가 요구하는 「라이브 핸들에서만 민팅」의 유일한 forge 지점이며, 3번째 캐스트는 이 룰이 RED 로 만든다.
    Object.freeze({
      identity: Object.freeze({ ...identity, benchId }),
      ownerToken,
      revalidate,
    }) as BenchLeaseToken

  return {
    async tryAcquire(spec) {
      const r = await acquire(spec)
      if (r.status !== 'acquired') return r
      return { status: 'acquired', handle: makeHandle(r.key, r.bound, r.ownerToken).handle }
    },
    async tryAcquireBenchLease(benchId) {
      const r = await acquire({ kind: 'bench', benchId })
      if (r.status !== 'acquired') return r
      const { handle, revalidate } = makeHandle(r.key, r.bound, r.ownerToken)
      const lease = mintLease(r.ownerToken, revalidate, benchId)
      MINTED_LEASES.add(lease)
      return { status: 'acquired', handle, lease }
    },
  }
}

/**
 * 민팅 원장 — **이 모듈이 실제로 발급한 토큰만** 담는다(Codex PR#264 P1).
 *
 * 브랜드 `unique symbol` 은 위조를 막지 못한다: `const forged: BenchLeaseToken = {...lease, identity: B}`
 * 는 **캐스트 0개**로 컴파일된다(TS 가 스프레드에서 미export 심볼 멤버를 보존하고, 민팅된 런타임 객체에는
 * 브랜드 **값**이 아예 없다). 그런 복제본은 A 의 살아있는 `revalidate` 를 든 채 B 를 가리키므로
 * 「배타는 A · 변이는 B」라는 cross-repo fail-open 이 된다 — 정확히 정정 54 가 타입에서 없앤 그 구멍이
 * 런타임으로 되돌아온 형태다. 타입으로 막을 수 없으니 **출처를 런타임에 확인**한다.
 *
 * `WeakSet` 인 이유: 토큰 수명을 붙잡지 않는다(리스가 GC 되면 원장에서도 사라진다).
 */
const MINTED_LEASES = new WeakSet<BenchLeaseToken>()

/** 이 프로세스의 `LockScope` 가 발급한 정품 토큰인가. 복제·수작업 조립은 false. */
export function isMintedLease(lease: BenchLeaseToken): boolean {
  return MINTED_LEASES.has(lease)
}

export type LeaseGuardResult<T> =
  | { readonly kind: 'ran'; readonly value: T }
  | { readonly kind: 'lost'; readonly reason: 'released' | 'stolen' }

/**
 * L-6 집행 — 리스가 인가하는 **변이 직전**에 재검증하고, 상실이면 **변이 함수를 호출하지 않는다**.
 *
 * PR2 의 `withAuthority` 가 이것을 임계 구역 안에서 per-retry 로 재사용한다. 반환이 판별 유니온인 이유는
 * §W-4 와 같다 — throw 는 「판별 유니온 반환」 원칙과 충돌하고 호출자의 fail-closed 분기를 흐린다.
 *
 * ⚠ **보장 범위는 「변이 직전」이다**(L-6 문면 그대로). `mutate()` **실행 중**에 리스를 잃는 것은 이
 * 함수가 관측하지 않으므로, `{kind:'ran'}` 은 「변이가 인가된 상태에서 시작됐다」는 뜻이지 「끝까지
 * 유효했다」가 아니다. 그래서 PR2 는 rename 재시도 **매 회차마다** 이 검증을 다시 태우고(§3-T17c),
 * 긴 변이는 그 재검증 지점 사이로 쪼개는 것이 계약이다.
 */
export async function withLeaseGuard<T>(
  lease: BenchLeaseToken,
  mutate: () => Promise<T>,
): Promise<LeaseGuardResult<T>> {
  // **출처 먼저**(Codex PR#264 P1). 복제 토큰은 원본의 살아있는 `revalidate` 를 그대로 들고 있어
  // `owned` 를 답한다 — 즉 재검증만으로는 「A 의 리스로 B 를 변이」를 구분하지 못한다.
  // `stolen` 으로 분류하는 이유: 「이 크레덴셜은 이 프로세스가 인가한 보유를 대표하지 않는다」가
  // `released`(내가 놓았다)보다 정확하고, 소비자의 fail-closed 분기가 이미 그 어휘를 처리한다.
  if (!isMintedLease(lease)) return { kind: 'lost', reason: 'stolen' }
  const check = lease.revalidate()
  if (check.kind === 'lost') return { kind: 'lost', reason: check.reason }
  return { kind: 'ran', value: await mutate() }
}
