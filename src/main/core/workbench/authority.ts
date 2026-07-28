import { join } from 'node:path'

import type { BenchLifecycle } from '../../../shared/types'
import { assertNever } from '../providers/types'
import type { DurabilityLevel, DurableFs } from './durable-fs'
import { isMintedLease } from './locks'
/**
 * `locks.ts` 가 민팅하는 리스 크레덴셜. 여기서 **재선언하지 않는다** — `unique symbol` 은 선언마다 별개
 * 타입이라 재선언하면 라이브 핸들이 민팅한 토큰이 이 모듈의 동명 타입에 **대입되지 않는다**(계획 정정 55).
 * 스펙 §W-4 코드블록이 3종을 다시 싣고 있으나 소유는 `locks.ts`(PR1b 랜딩)다.
 *
 * ⚠ **top-level `import type` 이어야 한다**(인라인 `import('./locks').X` 금지 · 자체 적대 리뷰 R1-6):
 * brain 추출기(`scripts/brain/extract.mjs`)는 `ImportTypeNode` 를 방문하지 않아 인라인 표기면 이 간선이
 * 구조 지도에서 **통째로 사라진다**. `verbatimModuleSyntax`(tsconfig.base.json)라 방출은 어느 쪽이든 0 이다.
 */
import type { BenchLeaseToken } from './locks'

/**
 * 공유 권위 레코드 · revision-CAS (#251 · 스펙 §W-4) — **타입 층**(PR2a T6b).
 *
 * 값 구현(`createBenchAuthorityStore`·`withAuthority`)은 PR2b, rename 재시도·`commit-uncertain` 은 PR2c,
 * 엔진 배선은 PR7 이다. 타입이 먼저 서는 이유는 계약 사슬의 척추이기 때문이다 — 어느 실패 종별이
 * 존재하는지가 정해져야 그 각각을 RED 로 만들 수 있다.
 *
 * **레이아웃 = bench 당 파일 1개** `<area>/authority/<benchId>.json`. 단일 파일을 기각한 근거는
 * ⓐ무관 bench 간 revision 충돌로 fail-closed 폭증 ⓑ활동 경로가 레포-전역 직렬화를 획득해 락 서열(L-3)
 * 위반 ⓒN bench 마다 O(N) 전량 재직렬화다. 기존 `createJsonFileStore` 를 **쓰지 않는 것도 계약**이다 —
 * 전체 스냅숏 tmp→rename 덮어쓰기라 두 프로세스가 붙으면 last-writer-wins 로 상대 세대가 조용히
 * 소멸한다(`store/json-file.ts:29,50-57`).
 *
 * ⚠ **`'file-only'` 표면의 안전 논증은 이 파일 안에서 완결되지 않는다**(계획 정정 70). win32 는 디렉터리
 * 엔트리 내구성이 없어 머신 크래시 시 `revision` 단조성이 깨질 수 있고, 그 탐지는 **git ref 열거**
 * (§W-7 ref-앵커 재조정 · PR3 T13)에 의존한다 — 권위 파일 안에 앵커를 두면 롤백 시 함께 되돌아가
 * 발화하지 않기 때문이다. PR2 단독으로는 미완결임을 은폐하지 않는다.
 */

/**
 * 이 코드베이스가 읽을 수 있는 권위 레코드 스키마 상한. 초과 = `incompatible-version`(≠ invalid · I12).
 * 레코드의 `schemaVersion` 은 이 값에서 **타입으로 유도**한다 — 두 곳에 리터럴을 두면 상한만 올리고
 * 기록값은 그대로 두는(또는 그 반대) 변경이 조용히 성립한다(자체 적대 리뷰 R6-8).
 */
export const SUPPORTED_AUTHORITY_SCHEMA = 1

/**
 * 레코드가 자기가 어느 레포·어느 bench 의 것인지 스스로 증언하는 3쌍. **대조 전용**이며 경로 유도에
 * 쓰지 않는다. 앞 두 값은 정준화된 절대 경로여야 하는데, **정준화·검증은 호출자 책임**이다(PR7) —
 * 이 모듈도 `locks.ts` 도 파일시스템을 만지지 않는다.
 */
export interface BenchAuthorityIdentity {
  readonly commonGitDir: string
  readonly benchRoot: string
  readonly benchId: string
}

/**
 * 통합 WAL 단계(§0.1 C7). 여기 두는 이유는 `BenchAuthorityRecord` 가 필드로 참조하기 때문이다 —
 * 정의를 §W-7 소유 모듈(PR3)에 두면 **PR2 가 PR3 타입에 의존하는 순환**이 된다(계획 정정 56).
 * 어휘 자체는 C7 이 이미 확정했으므로 창작이 아니다. PR3 의 저널 모듈이 이 타입을 import 한다.
 */
export type IntegrationStage = 'prepared' | 'composed' | 'published' | 'finalized' | 'abandoned'

/**
 * 진행 중인 활동 1건. `kind` 는 D1 이 정한 두 종류다 — bench 안에서 도는 것은 **오케 런**과
 * **단일 세션 대화** 둘뿐이고, 스펙이 값을 명시하지 않아 여기서 확정한다(계획 감사 L1-13).
 *
 * `execGate` 의 전이 시점이 계약이다(§W-4 「execGate 전이 시점 = 활동 시작 순서 고정」): `gated` 로 먼저 커밋하고, `running` 으로 두 번째
 * CAS 를 커밋한 **뒤에야** spawn 한다. 순서를 뒤집으면 「commit → spawn → 크래시」 창이 **살아있는 자식 +
 * 디스크 `gated`** 를 만들고, gated-orphan 회수가 그 자식을 「0줄 실행」으로 오분류해 변이한다(fail-open).
 */
export interface BenchActivityRecord {
  readonly activityId: string
  readonly kind: 'run' | 'chat'
  /** 시작 시점의 `sourceGeneration`. 불변식 ⑤가 동치를 요구한다. */
  readonly generation: number
  readonly ownerToken: string
  readonly execGate: 'gated' | 'running'
  readonly startedAt: number
}

export interface BenchAuthorityRecord {
  readonly schemaVersion: typeof SUPPORTED_AUTHORITY_SCHEMA
  readonly identity: BenchAuthorityIdentity
  /**
   * 단조. 최초 1. CAS 성공마다 정확히 +1.
   * ⚠ `durability==='file-only'` 표면(win32)에서는 머신 크래시 시 디렉터리 엔트리 유실로 단조성이
   * 보장되지 않는다(C3). 그 표면의 안전 논증은 revision 이 아니라 §W-7 **ref-앵커 재조정**에 의존한다 —
   * git ref 는 권위 파일과 독립 매체라 동시 롤백이 불가능하다(파일 머리말 참조).
   */
  readonly revision: number
  readonly lifecycle: BenchLifecycle
  readonly archivedBranch?: 'preserved' | 'deleted'
  /** 활동 시작마다 +1. 완결 관측이 「어느 세대의 결과인가」를 판정하는 근거다. */
  readonly sourceGeneration: number
  readonly currentIntegrationTxnId?: string
  /** 저장되는 것은 **WAL 단계뿐**이다 — 파생 표시 상태는 §W-18 이 소유하며 영속하지 않는다. */
  readonly currentIntegrationStage?: IntegrationStage
  readonly currentIntegrationTxnGeneration?: number
  readonly currentIntegrationResultOid?: string
  /** `lifecycle==='integrated'` 일 때만 존재한다(불변식 ②). */
  readonly completedIntegrationTxnId?: string
  readonly activeActivity?: BenchActivityRecord
  readonly writtenBy: {
    readonly ownerToken: string
    readonly at: number
    readonly durability: DurabilityLevel
  }
}

/**
 * 호출자가 제출하는 것. `revision`·`writtenBy` 는 **저장소만 배정**한다(§W-4 「revision 은 저장소만 배정」).
 *
 * ⚠ **타입은 이 규칙을 완전히 강제하지 못한다**(계획 정정 73): `Omit` 의 초과 프로퍼티 검사는 객체
 * 리터럴에만 걸리므로 `const r: BenchAuthorityRecord = …; cas(read, r)` 는 구조적 서브타이핑으로 통과한다.
 * 따라서 `compareAndSwap` 은 **런타임에서 두 키의 존재 자체를 거부**한다(PR2b `invariant-violation`).
 * 여기 타입 핀은 「스레딩 사고 방지」이지 보안 경계가 아니다.
 */
export type BenchAuthorityDraft = Omit<BenchAuthorityRecord, 'revision' | 'writtenBy'>

/**
 * 내구 쓰기 단계 — **rename 을 경계로 둘로 쪼갠다**(계획 정정 53).
 *
 * 하나의 유니온이면 `io-failure{step:'fsync-dir'}` 가 **타입상 합법**이 되어, 「쓰기 실패·상태 무변」과
 * 「디스크 revision 은 전진했는데 커밋 토큰 미발급」이 같은 종별로 뭉개진다 — Codex 체크포인트 2 P1-5 가
 * 이미 닫은 구분이다. 타입이 그 오답을 거부하게 만드는 것이 이 분할의 목적이다.
 */
export type PreCommitStep = 'mkdir' | 'open-tmp' | 'write' | 'fsync-file' | 'close-tmp' | 'rename'
export type PostCommitStep = 'open-dir' | 'fsync-dir' | 'close-dir'
export type DurableWriteStep = PreCommitStep | PostCommitStep

/**
 * 브랜드 심볼 **미export** — 민팅은 이 모듈의 CAS 경로에서만 일어난다.
 * 미export 가 위조를 완전히 막지 못한다는 것은 PR1b 가 실측했으므로(4종 우회가 tsc 통과), 기계 강제는
 * eslint `@typescript-eslint/no-unsafe-type-assertion`(워크벤치 프로덕션 전체 옵트인)이 담당한다.
 */
declare const FRESH_READ: unique symbol

/**
 * 「이 임계 구역에서 방금 디스크를 읽었다」는 증거. **단일 사용**이 계약이라 `readSeq` 를 싣는다 —
 * 같은 토큰 재제출은 `read-token-spent` 다.
 */
export interface FreshReadToken {
  readonly [FRESH_READ]: true
  readonly identity: BenchAuthorityIdentity
  /** 부재 레코드 = 0. */
  readonly observedRevision: number
  readonly leaseOwnerToken: string
  readonly readSeq: number
}

declare const AUTHORITY_COMMIT: unique symbol

/**
 * CAS 성공 시에만 존재하는 증거(§W-4 계약 4항).
 *
 * ⚠ **이 타입 혼자서는 아무것도 강제하지 못한다.** 「CAS 를 건너뛴 코드가 컴파일되지 않는다」가 성립하려면
 * 세 조각이 더 필요한데 **전부 미착지**다: 런처 팩토리(`createBenchLauncher(commit)`) = PR2c ·
 * spawn 관문 배선 = PR7 · 우회 차단 eslint 가드 = PR7(계획 정정 52·64). 현재형으로 쓰면 있지도 않은
 * 방어를 있다고 읽히게 한다(자체 적대 리뷰 R5-9).
 */
export interface AuthorityCommit {
  readonly [AUTHORITY_COMMIT]: true
  readonly identity: BenchAuthorityIdentity
  readonly revision: number
  readonly sourceGeneration: number
  readonly activityId?: string
  readonly durability: DurabilityLevel
}

export type AuthorityReadResult =
  | { readonly kind: 'found'; readonly record: BenchAuthorityRecord; readonly read: FreshReadToken }
  | { readonly kind: 'absent'; readonly read: FreshReadToken }
  | { readonly kind: 'invalid'; readonly path: string; readonly violations: readonly string[] }
  /** 문법 위반과 버전 스큐는 다른 사실이다 — 섞으면 구 버전이 신 버전 권위를 삭제한다(I12). */
  | {
      readonly kind: 'incompatible-version'
      readonly path: string
      readonly found: number
      readonly supported: number
    }
  | {
      readonly kind: 'identity-mismatch'
      readonly expected: BenchAuthorityIdentity
      readonly found: BenchAuthorityIdentity
    }
  /** 임계 구역 진입 시점에 리스가 이미 유실된 경우 — throw 는 「판별 유니온 반환」 원칙과 충돌한다. */
  | { readonly kind: 'lease-invalid'; readonly reason: 'released' | 'stolen' }
  | {
      readonly kind: 'io-failure'
      readonly step: 'read'
      readonly path: string
      readonly cause: unknown
    }

export type CasResult =
  | {
      readonly kind: 'committed'
      readonly record: BenchAuthorityRecord
      readonly commit: AuthorityCommit
    }
  | {
      readonly kind: 'revision-mismatch'
      readonly expected: number
      readonly observed: BenchAuthorityRecord
    }
  /**
   * `released`·`stolen` 은 리스 자신의 어휘(`LeaseCheck`)에서 온다. `foreign-owner`·`identity-mismatch` 는
   * **이 층이 생산**한다(감사 L1-3: 스펙이 생산 조건을 서술하지 않아 여기서 고정).
   *
   * - `identity-mismatch` — 레코드 identity 가 리스 identity 와 어긋난다.
   * - `foreign-owner` — 제출된 `FreshReadToken.leaseOwnerToken` 이 **지금 CAS 를 수행하는 리스의
   *   `ownerToken` 과 다르다**. 즉 「남의 임계 구역에서 발급된 읽기 토큰을 들고 왔다」는 뜻이다.
   *
   * ⚠ **레코드의 `writtenBy.ownerToken` 과 비교하는 것이 아니다**(Codex PR#264 P1). 획득은 매번 새
   * `ownerToken` 을 만들므로, 리스 A 가 커밋하고 해제한 뒤 정당한 리스 B 가 읽으면 `writtenBy` 는 **항상**
   * A 다 — 그 비교를 쓰면 **모든 후속 CAS 가 `lease-invalid`** 가 되어 정상 활동도, 문서화된 고아 상태
   * 회수도 불가능해진다. `writtenBy` 는 **진단·감사 기록**이지 인가 술어가 아니다.
   */
  | {
      readonly kind: 'lease-invalid'
      readonly reason: 'released' | 'foreign-owner' | 'identity-mismatch' | 'stolen'
    }
  | { readonly kind: 'read-token-spent'; readonly readSeq: number }
  | { readonly kind: 'invariant-violation'; readonly violations: readonly string[] }
  /** rename **성공 전** 실패(재시도 소진 포함) = 디스크 무변이(tmp 만 잔존 · 다음 CAS 가 회수). */
  | {
      readonly kind: 'io-failure'
      readonly step: PreCommitStep
      readonly path: string
      readonly cause: unknown
    }
  /**
   * rename **성공 후** 내구 단계 실패 = **디스크 revision 은 이미 전진**했는데 커밋 토큰은 발급하지 않는다.
   * 「쓰기 실패·상태 무변」과 반드시 구분한다(Codex 체크포인트 2 P1-5). 커밋 토큰이 없으므로 CLI 는
   * 실행되지 않고, 디스크에 남은 `activeActivity{execGate:'gated'}` 가 다음 부팅의 회수 근거가 된다.
   */
  | {
      readonly kind: 'commit-uncertain'
      readonly step: PostCommitStep
      readonly advancedRevision: number
      readonly cause: unknown
    }

/**
 * 임계 구역 안에서만 존재하는 핸들. 리스는 **클로저 캡처**라 인자로 다시 받지 않는다.
 *
 * 두 메서드가 store 가 아니라 여기 있는 이유(§W-4 「인터페이스 정정(계획 체크포인트)」): 셋 다 store public 이면 **뮤텍스 밖에서
 * `readFresh()` 를 부르는 코드가 정상 컴파일**되어 직렬화 경계가 타입이 아니라 규약으로 강등된다.
 */
export interface AuthorityTx {
  /** **항상 디스크에서 읽는다.** 반증 수단 = 주입 `DurableFs.readFileUtf8` 호출 카운트(1회당 정확히 1회). */
  readFresh(): AuthorityReadResult
  /** `read` 는 **같은 임계 구역**에서 발급된 미사용 토큰. 성공 시에만 `AuthorityCommit` 을 발급한다. */
  compareAndSwap(read: FreshReadToken, next: BenchAuthorityDraft): Promise<CasResult>
}

export interface BenchAuthorityStore {
  /**
   * **유일한 public 진입점.** bench identity 별 in-process 뮤텍스를 보유한 채
   * `readFresh → 불변식 검사 → compareAndSwap 완료(내구 확정)` 전체를 하나의 임계 구역으로 실행한다.
   * **리스 = 프로세스 간, 뮤텍스 = 프로세스 안.**
   */
  withAuthority<T>(lease: BenchLeaseToken, fn: (tx: AuthorityTx) => Promise<T>): Promise<T>
}

/* ================================================================================================
 * 값 구현 (PR2b T8) — 아래부터
 * ============================================================================================= */

/**
 * store 가 **주입받아야만 하는** 것(계획 정정 76). 스펙 §W-5 는 이 자리를 문자 그대로 `{...}` 로 비워
 * 두었는데, 그러면 권위 경로·내구 등급·시계의 출처가 **하나도 없다**.
 *
 * 셋 다 「호출자가 준다」인 이유가 각각 다르다:
 * - `authorityDir` — 이 모듈은 코디네이션 영역을 **재유도하지 않는다**. `<area>` 유도는 `coord-area.ts`
 *   단일 지점이고 그 산출물은 `realpathSync.native` 로 정준화돼 있다. 여기서 다시 만들면 「정준 root ≠
 *   store root」가 성립해 배타와 쓰기가 다른 경로를 가리킨다(형제 `LockScopeOptions` 와 같은 규율).
 * - `durability` — **프로브가 유일 권위**이고 쓰기 경로는 그 값을 소비만 한다(§W-5). 여기서
 *   `process.platform` 을 보면 판정자가 둘이 되어 「갖지 않은 내구성을 레코드가 주장」하거나 「매 CAS 가
 *   `commit-uncertain`」이 된다. 프로브 호출자는 부팅(PR7)이다.
 * - `now` — 픽스처 시계 규율. `writtenBy.at` 이 관측 대상이므로 주입 없이는 결정론이 없다.
 */
export interface BenchAuthorityStoreOptions {
  /** `<area>/authority` — **이미 정준화된** 절대 경로. 검증은 호출자 책임(PR7). */
  readonly authorityDir: string
  /** `probeDurability()` 산출물. 이 모듈은 플랫폼을 알지 못한다. */
  readonly durability: DurabilityLevel
  readonly now: () => number
}

/**
 * 권위 레코드 크기 상한. 형제 `active-instance.ts` 가 같은 축에 이미 실측 상한을 출하했고, 근거도 같다 —
 * 이 영역은 ttyd 셸·CLI 에이전트와 **같은 신뢰 도메인**(§W-2-a)이라 누구든 거대 파일을 놓을 수 있고,
 * 그 읽기는 **뮤텍스와 리스를 쥔 채** 동기로 일어나 이벤트 루프를 막는다. 정상 레코드는 활동 1건까지
 * 합쳐도 1KiB 미만이므로 64KiB 는 정상 사용을 전혀 건드리지 않는다(계획 정정 96).
 */
const MAX_AUTHORITY_BYTES = 64 * 1024

/** 권위 디렉터리·파일 권한. 형제 `coord-area.ts` 와 같다(win32 에서 무시되는 것은 §3-T59 가 흡수). */
const AUTHORITY_DIR_MODE = 0o700
const AUTHORITY_FILE_MODE = 0o600

/**
 * **모듈 스코프**여야 하는 상태 셋(§W-4 「모듈 내부 단조」 · 계획 정정 95).
 *
 * store-지역으로 두면 §3-T19 가 세운 논증(「`vi.resetModules()` 2회 import 로 인스턴스를 격리한다」)이
 * 무너진다 — 같은 프로세스에 store 를 두 번 만들면 seq 공간과 소비 원장이 갈려 A 가 발급한 미사용 토큰을
 * B 가 「처음 보는 토큰」으로 수락하고, 단일 사용 계약이 프로세스 단위로 깨진다. 그리고 그 결함은
 * PR2b 게이트를 **전부 통과**한 뒤 PR6 에서야 RED 가 된다.
 */
let readSeqCounter = 0
const SPENT_READS = new WeakSet<FreshReadToken>()
/** identity 별 임계 구역 꼬리. 같은 bench 의 `withAuthority` 호출을 FIFO 로 직렬화한다. */
const MUTEX_TAILS = new Map<string, Promise<unknown>>()

/**
 * 뮤텍스 키 — **JSON 배열**이다. 3필드를 구분자로 이어 붙이면 경로에 그 구분자가 들어갈 때 서로 다른
 * identity 가 같은 키로 붕괴한다(실측: `['a','b c','d']` 와 `['a','b','c d']` 가 공백 결합에서 동일).
 * 붕괴 방향은 과직렬화(안전)지만, 반대로 **정준화되지 않은 경로**가 오면 같은 파일이 두 키로 갈려
 * 직렬화가 소멸한다(fail-open) — 그 방어는 호출자의 정준화 책임이며 여기 주석이 그 경계를 명시한다.
 */
const mutexKey = (id: BenchAuthorityIdentity): string =>
  JSON.stringify([id.commonGitDir, id.benchRoot, id.benchId])

/** `unknown` 을 캐스트 없이 들여다본다 — `Reflect.get` 은 own 여부를 묻지 않으므로 `hasOwn` 과 짝짓는다. */
const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? Reflect.get(o, k) : undefined)

const isPlainObject = (v: unknown): v is object =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * 위반 메시지에 값을 싣는다. `String(unknown)` 은 객체에서 `[object Object]` 가 되어 진단이 무의미해지고
 * eslint `no-base-to-string` 이 그것을 막는다 — 적대 입력이므로 **어떤 값이 와도 던지지 않아야** 한다
 * (`JSON.stringify` 는 순환 참조에서 던진다).
 */
const show = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? typeof v
  } catch {
    return typeof v
  }
}

/** revision·generation 공통 술어. 실측상 `1.5`·`NaN`·`Infinity`·`2**53`·`'1'`·`null`·`true` 를 전부 거부한다. */
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const LIFECYCLES: readonly BenchLifecycle[] = ['open', 'integrated', 'archived']
const STAGES: readonly IntegrationStage[] = [
  'prepared',
  'composed',
  'published',
  'finalized',
  'abandoned',
]

const isLifecycle = (v: unknown): v is BenchLifecycle => LIFECYCLES.some((x) => x === v)

const isStage = (v: unknown): v is IntegrationStage => STAGES.some((x) => x === v)

/**
 * 형태 검증 — **불변식보다 앞선다**(계획 정정 87).
 *
 * 스펙의 조건부 불변식 9종은 **관계**만 본다(⑧ 만이 수치 도메인이다). 유니온 밖 `lifecycle:'zzz'` 를 가진
 * 레코드는 ①②⑥⑦ 을 **vacuously 만족**하며 `found` 로 통과하는데, 그 값은 이후 전 소비자의 switch 를
 * 조용히 빠져나간다. 그래서 관계 검사 앞에 형태 검사를 둔다.
 *
 * 반환은 **필드 명시 재구성**이다 — 캐스트로 좁히면 `__proto__`·`constructor`·초과 키가 레코드에 실려
 * CAS 왕복으로 **디스크에 재기록**된다(계획 정정 88ⓒ · 형제 `coord-area.ts` 가 같은 이유로 재조립한다).
 */
const parseRecordShape = (
  o: object,
):
  | { readonly ok: true; readonly record: BenchAuthorityRecord }
  | { readonly ok: false; readonly violations: string[] } => {
  const v: string[] = []
  const identityRaw = own(o, 'identity')
  const revision = own(o, 'revision')
  const lifecycle = own(o, 'lifecycle')
  const sourceGeneration = own(o, 'sourceGeneration')
  const writtenByRaw = own(o, 'writtenBy')

  // ⚠ **필수 5필드는 수집이 아니라 즉시 반환**이다 — 한 번에 모아 검사하면 이후 코드가 좁혀진 타입을
  // 얻지 못해 캐스트를 부르고, 그러면 정정 88ⓒ 의 「필드 명시 재구성」이 무너진다.
  if (!isPlainObject(identityRaw)) return { ok: false, violations: ['identity 가 객체가 아니다'] }
  if (!isPlainObject(writtenByRaw)) return { ok: false, violations: ['writtenBy 가 객체가 아니다'] }
  if (!isCount(revision) || revision < 1) {
    return { ok: false, violations: ['revision 이 1 이상의 안전 정수가 아니다'] }
  }
  if (!isLifecycle(lifecycle)) {
    return { ok: false, violations: [`lifecycle 이 유니온 밖이다: ${String(lifecycle)}`] }
  }
  if (!isCount(sourceGeneration)) {
    return { ok: false, violations: ['sourceGeneration 이 안전 정수가 아니다'] }
  }

  const commonGitDir = own(identityRaw, 'commonGitDir')
  const benchRoot = own(identityRaw, 'benchRoot')
  const benchId = own(identityRaw, 'benchId')
  if (
    !isNonEmptyString(commonGitDir) ||
    !isNonEmptyString(benchRoot) ||
    !isNonEmptyString(benchId)
  ) {
    return { ok: false, violations: ['identity 3필드가 비어 있지 않은 문자열이 아니다'] }
  }

  const wbOwner = own(writtenByRaw, 'ownerToken')
  const wbAt = own(writtenByRaw, 'at')
  const wbDur = own(writtenByRaw, 'durability')
  if (!isNonEmptyString(wbOwner) || !isCount(wbAt)) {
    return { ok: false, violations: ['writtenBy.ownerToken·at 형태 오류'] }
  }
  if (wbDur !== 'file+dir' && wbDur !== 'file-only') {
    return { ok: false, violations: [`writtenBy.durability 가 유니온 밖이다: ${String(wbDur)}`] }
  }

  const optString = (k: string): string | undefined => {
    const raw = own(o, k)
    if (raw === undefined) return undefined
    if (!isNonEmptyString(raw)) {
      v.push(`${k} 가 비어 있지 않은 문자열이 아니다`)
      return undefined
    }
    return raw
  }
  const optCount = (k: string): number | undefined => {
    const raw = own(o, k)
    if (raw === undefined) return undefined
    if (!isCount(raw)) {
      v.push(`${k} 가 안전 정수가 아니다`)
      return undefined
    }
    return raw
  }

  const archivedRaw = own(o, 'archivedBranch')
  if (archivedRaw !== undefined && archivedRaw !== 'preserved' && archivedRaw !== 'deleted') {
    return { ok: false, violations: [`archivedBranch 가 유니온 밖이다: ${show(archivedRaw)}`] }
  }
  const stageRaw = own(o, 'currentIntegrationStage')
  if (stageRaw !== undefined && !isStage(stageRaw)) {
    return {
      ok: false,
      violations: [`currentIntegrationStage 가 유니온 밖이다: ${show(stageRaw)}`],
    }
  }

  const currentIntegrationTxnId = optString('currentIntegrationTxnId')
  const currentIntegrationTxnGeneration = optCount('currentIntegrationTxnGeneration')
  const currentIntegrationResultOid = optString('currentIntegrationResultOid')
  const completedIntegrationTxnId = optString('completedIntegrationTxnId')

  const activityRaw = own(o, 'activeActivity')
  let activeActivity: BenchActivityRecord | undefined
  if (activityRaw !== undefined) {
    if (!isPlainObject(activityRaw)) {
      v.push('activeActivity 가 객체가 아니다')
    } else {
      const activityId = own(activityRaw, 'activityId')
      const kind = own(activityRaw, 'kind')
      const generation = own(activityRaw, 'generation')
      const ownerToken = own(activityRaw, 'ownerToken')
      const execGate = own(activityRaw, 'execGate')
      const startedAt = own(activityRaw, 'startedAt')
      if (
        !isNonEmptyString(activityId) ||
        (kind !== 'run' && kind !== 'chat') ||
        !isCount(generation) ||
        !isNonEmptyString(ownerToken) ||
        (execGate !== 'gated' && execGate !== 'running') ||
        !isCount(startedAt)
      ) {
        v.push('activeActivity 필드 형태 오류')
      } else {
        activeActivity = { activityId, kind, generation, ownerToken, execGate, startedAt }
      }
    }
  }

  if (v.length > 0) return { ok: false, violations: v }

  return {
    ok: true,
    record: {
      schemaVersion: SUPPORTED_AUTHORITY_SCHEMA,
      identity: { commonGitDir, benchRoot, benchId },
      revision,
      lifecycle,
      sourceGeneration,
      ...(archivedRaw === undefined ? {} : { archivedBranch: archivedRaw }),
      ...(currentIntegrationTxnId === undefined ? {} : { currentIntegrationTxnId }),
      ...(stageRaw === undefined ? {} : { currentIntegrationStage: stageRaw }),
      ...(currentIntegrationTxnGeneration === undefined ? {} : { currentIntegrationTxnGeneration }),
      ...(currentIntegrationResultOid === undefined ? {} : { currentIntegrationResultOid }),
      ...(completedIntegrationTxnId === undefined ? {} : { completedIntegrationTxnId }),
      ...(activeActivity === undefined ? {} : { activeActivity }),
      writtenBy: { ownerToken: wbOwner, at: wbAt, durability: wbDur },
    },
  }
}

/**
 * 조건부 스키마 불변식 ①~⑧ (§W-4 「조건부 스키마 불변식」). ⑨(identity 대조)는 **별도 종별**이라 여기 없다.
 *
 * ⚠ ③ 은 스펙 원문이 통합 **4필드 중 3개만** 덮어 `currentIntegrationResultOid` 가 어디에도 등장하지
 * 않았다 — txnId 없는 **고아 resultOid** 가 정상 커밋됐다(계획 정정 98). 여기서 4필드 전체로 확장한다.
 */
const checkInvariants = (r: BenchAuthorityRecord): string[] => {
  const v: string[] = []
  const has = (x: unknown): boolean => x !== undefined

  if (has(r.archivedBranch) !== (r.lifecycle === 'archived')) {
    v.push('①: archivedBranch 존재 ⟺ lifecycle==="archived"')
  }
  if (has(r.completedIntegrationTxnId) !== (r.lifecycle === 'integrated')) {
    v.push('②: completedIntegrationTxnId 존재 ⟺ lifecycle==="integrated"')
  }
  const txn = has(r.currentIntegrationTxnId)
  if (
    has(r.currentIntegrationStage) !== txn ||
    has(r.currentIntegrationTxnGeneration) !== txn ||
    has(r.currentIntegrationResultOid) !== txn
  ) {
    v.push(
      '③: 통합 4필드(Stage·Generation·ResultOid)는 TxnId 와 함께 존재하거나 함께 부재해야 한다',
    )
  }
  if (
    r.currentIntegrationTxnGeneration !== undefined &&
    r.currentIntegrationTxnGeneration > r.sourceGeneration
  ) {
    v.push('④: currentIntegrationTxnGeneration <= sourceGeneration')
  }
  if (r.activeActivity !== undefined && r.activeActivity.generation !== r.sourceGeneration) {
    v.push('⑤: activeActivity.generation === sourceGeneration')
  }
  if (r.lifecycle === 'integrated' && r.activeActivity !== undefined) {
    v.push('⑥: lifecycle==="integrated" ∧ activeActivity 금지')
  }
  if (r.lifecycle === 'archived' && r.activeActivity !== undefined) {
    v.push('⑦: lifecycle==="archived" ∧ activeActivity 금지')
  }
  if (!Number.isSafeInteger(r.revision) || r.revision < 1) v.push('⑧: revision >= 1 ∧ 정수')
  return v
}

const sameIdentity = (a: BenchAuthorityIdentity, b: BenchAuthorityIdentity): boolean =>
  a.commonGitDir === b.commonGitDir && a.benchRoot === b.benchRoot && a.benchId === b.benchId

/**
 * 디스크에 나갈 바이트. **draft 만으로** 만든다 — 이전 레코드와 병합하지 않는 것이 계약 6항이고,
 * 그 성질은 여기서 구조적으로 보장된다(병합 코드가 존재할 자리가 없다).
 */
const serialize = (
  draft: BenchAuthorityDraft,
  revision: number,
  writtenBy: BenchAuthorityRecord['writtenBy'],
): BenchAuthorityRecord => ({
  schemaVersion: SUPPORTED_AUTHORITY_SCHEMA,
  identity: {
    commonGitDir: draft.identity.commonGitDir,
    benchRoot: draft.identity.benchRoot,
    benchId: draft.identity.benchId,
  },
  revision,
  lifecycle: draft.lifecycle,
  sourceGeneration: draft.sourceGeneration,
  ...(draft.archivedBranch === undefined ? {} : { archivedBranch: draft.archivedBranch }),
  ...(draft.currentIntegrationTxnId === undefined
    ? {}
    : { currentIntegrationTxnId: draft.currentIntegrationTxnId }),
  ...(draft.currentIntegrationStage === undefined
    ? {}
    : { currentIntegrationStage: draft.currentIntegrationStage }),
  ...(draft.currentIntegrationTxnGeneration === undefined
    ? {}
    : { currentIntegrationTxnGeneration: draft.currentIntegrationTxnGeneration }),
  ...(draft.currentIntegrationResultOid === undefined
    ? {}
    : { currentIntegrationResultOid: draft.currentIntegrationResultOid }),
  ...(draft.completedIntegrationTxnId === undefined
    ? {}
    : { completedIntegrationTxnId: draft.completedIntegrationTxnId }),
  ...(draft.activeActivity === undefined ? {} : { activeActivity: draft.activeActivity }),
  writtenBy,
})

/**
 * 권위 저장소 — **`withAuthority` 만 public** 이다(§W-4 「인터페이스 정정」).
 *
 * ⚠ **이 store 는 코디네이션 영역도 플랫폼도 알지 못한다.** `authorityDir`·`durability` 를 주입받기만
 * 하며, 그 사실을 `authority-structure.test.ts` 가 구조 단언으로 집행한다(계획 정정 76).
 */
export function createBenchAuthorityStore(
  fs: DurableFs,
  opts: BenchAuthorityStoreOptions,
): BenchAuthorityStore {
  const pathFor = (benchId: string): string => join(opts.authorityDir, `${benchId}.json`)
  /**
   * tmp 이름은 `ownerToken` 스코프다(§W-4). `ownerToken` 은 **획득당 1회** 민팅이므로 한 리스의 모든
   * CAS 가 **같은 tmp 경로**를 쓴다 — 그래서 실패 경로가 `finally` 로 자기 tmp 를 반드시 치워야 한다.
   * 치우지 않으면 다음 CAS 의 `openExclusive`(create-only)가 EEXIST 로 **영구 자기잠금**한다(정정 78).
   */
  const tmpFor = (benchId: string, ownerToken: string): string =>
    join(opts.authorityDir, `${benchId}.json.${ownerToken}.tmp`)

  const runCritical = <T>(
    lease: BenchLeaseToken,
    fn: (tx: AuthorityTx) => Promise<T>,
  ): Promise<T> => {
    const path = pathFor(lease.identity.benchId)
    const tmpPath = tmpFor(lease.identity.benchId, lease.ownerToken)
    /** 임계 구역 밖에서 tx 를 쓰는 것을 막는 유일한 수단(계획 정정 94). */
    let live = true

    const readFresh = (): AuthorityReadResult => {
      if (!live) return { kind: 'lease-invalid', reason: 'released' }
      let kind
      try {
        kind = fs.statKind(path)
      } catch (cause) {
        return { kind: 'io-failure', step: 'read', path, cause }
      }
      if (kind.kind === 'missing') return { kind: 'absent', read: mintRead(lease, 0) }
      if (kind.kind !== 'regular') {
        // **자동 삭제 금지.** FIFO 면 실물에서 `readFileUtf8` 이 무기한 블록되고(부팅 정지), symlink 면
        // 영역 밖 JSON 이 권위가 된다 — 둘 다 읽기 **전에** 막는다(형제 `coord-area.ts` 와 같은 규율).
        return { kind: 'invalid', path, violations: [`정규 파일이 아니다(${kind.kind})`] }
      }
      if (kind.size > MAX_AUTHORITY_BYTES) {
        // 상한은 **읽기 전에** 건다 — 읽고 나서 재면 이미 이벤트 루프를 막은 뒤다.
        return {
          kind: 'invalid',
          path,
          violations: [`크기 상한 초과(${kind.size}B > ${MAX_AUTHORITY_BYTES}B)`],
        }
      }

      let raw: string
      try {
        raw = fs.readFileUtf8(path)
      } catch (cause) {
        return { kind: 'io-failure', step: 'read', path, cause }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { kind: 'invalid', path, violations: ['JSON 파싱 실패'] }
      }
      if (!isPlainObject(parsed)) {
        return { kind: 'invalid', path, violations: ['최상위가 객체가 아니다'] }
      }
      // `JSON.parse` 는 `__proto__` 를 **own 데이터 프로퍼티**로 만든다(3면 실측) — 그 자체로는 오염이
      // 아니지만, 이후 어떤 소비자가 `Object.assign`·키 대입 루프를 쓰면 **그 지점에서** 오염된다(실측).
      // 판별은 `hasOwn` 이어야 한다 — `'__proto__' in o` 는 평범한 객체도 true 다(계획 정정 88).
      if (Object.hasOwn(parsed, '__proto__') || Object.hasOwn(parsed, 'constructor')) {
        return { kind: 'invalid', path, violations: ['금지된 own 키(__proto__·constructor)'] }
      }

      // **`schemaVersion` 이 최우선이다**(I12 · 계획 정정 86). 신 버전 레코드는 이 코드가 모르는 필드를
      // 가지므로 문법 검사를 먼저 하면 `invalid` 로 오분류되고, 그러면 구 버전이 신 버전 권위를 삭제한다.
      const sv = own(parsed, 'schemaVersion')
      if (typeof sv !== 'number' || !Number.isSafeInteger(sv) || sv < 1) {
        return { kind: 'invalid', path, violations: ['schemaVersion 형태 오류'] }
      }
      if (sv > SUPPORTED_AUTHORITY_SCHEMA) {
        return {
          kind: 'incompatible-version',
          path,
          found: sv,
          supported: SUPPORTED_AUTHORITY_SCHEMA,
        }
      }

      const shape = parseRecordShape(parsed)
      if (!shape.ok) return { kind: 'invalid', path, violations: shape.violations }

      if (!sameIdentity(shape.record.identity, lease.identity)) {
        return { kind: 'identity-mismatch', expected: lease.identity, found: shape.record.identity }
      }

      const violations = checkInvariants(shape.record)
      if (violations.length > 0) return { kind: 'invalid', path, violations }

      return { kind: 'found', record: shape.record, read: mintRead(lease, shape.record.revision) }
    }

    const compareAndSwap = async (
      read: FreshReadToken,
      next: BenchAuthorityDraft,
    ): Promise<CasResult> => {
      if (!live) return { kind: 'lease-invalid', reason: 'released' }

      // ① 토큰 소진이 가장 앞이다(계획 정정 80). 이 순서가 없으면 T13ⓐ 와 T14 가 같은 셋업에
      //    상반된 반환을 요구한다. 원장은 **모듈 스코프**라 store 를 두 번 만들어도 공유된다(정정 95).
      if (SPENT_READS.has(read)) return { kind: 'read-token-spent', readSeq: read.readSeq }
      if (read.leaseOwnerToken !== lease.ownerToken) {
        return { kind: 'lease-invalid', reason: 'foreign-owner' }
      }
      SPENT_READS.add(read)

      // ② **변이 직전** 리스 재검증(L-6). `withLeaseGuard` 의 보장 범위가 「변이 직전」이라는 문면 그대로,
      //    이 지점이 PR2b 의 유일한 재검증 지점이다(재시도가 생기는 PR2c 는 회차마다 다시 태운다).
      const check = lease.revalidate()
      if (check.kind === 'lost') return { kind: 'lease-invalid', reason: check.reason }

      // ③ draft 인자 사전조건. `Omit` 은 **객체 리터럴에만** 초과 프로퍼티 검사를 걸므로 타입만으로는
      //    막히지 않는다(계획 정정 73). ⚠ 판별자는 `hasOwn` 이다 — `{revision: undefined}` 는 값 검사를
      //    통과하지만 `JSON.stringify` 가 키를 지워 관측이 갈린다(3면 실측 · 정정 99b).
      const bad: string[] = []
      if (Object.hasOwn(next, 'revision'))
        bad.push('draft 는 revision 을 실을 수 없다(저장소만 배정)')
      if (Object.hasOwn(next, 'writtenBy'))
        bad.push('draft 는 writtenBy 를 실을 수 없다(저장소만 배정)')
      if (bad.length > 0) return { kind: 'invariant-violation', violations: bad }
      if (!sameIdentity(next.identity, lease.identity)) {
        return { kind: 'lease-invalid', reason: 'identity-mismatch' }
      }

      // ④ **디스크를 다시 읽는다.** 토큰의 `observedRevision` 만 믿는 구현은 in-process 시나리오에서만
      //    맞고 크로스 프로세스(재시작·컨테이너 교체)에서 틀린다 — `revision-mismatch` 가 `observed`
      //    레코드를 실어 반환한다는 타입 자체가 재독을 요구한다.
      const fresh = readFresh()
      switch (fresh.kind) {
        case 'found':
          if (fresh.record.revision !== read.observedRevision) {
            return {
              kind: 'revision-mismatch',
              expected: read.observedRevision,
              observed: fresh.record,
            }
          }
          break
        case 'absent':
          if (read.observedRevision !== 0) {
            // 권위 파일이 사라졌다. `revision-mismatch` 는 `observed` 레코드를 요구하는데 줄 것이 없다 —
            // 유니온에 이 경우의 자리가 없다는 것이 잔여 계약 공백이며(PR 본문 등재) fail-closed 로 답한다.
            return {
              kind: 'invariant-violation',
              violations: [
                `권위 파일이 CAS 직전에 사라졌다(기대 revision ${read.observedRevision})`,
              ],
            }
          }
          break
        case 'identity-mismatch':
          return { kind: 'lease-invalid', reason: 'identity-mismatch' }
        case 'lease-invalid':
          return { kind: 'lease-invalid', reason: fresh.reason }
        case 'invalid':
          return { kind: 'invariant-violation', violations: fresh.violations }
        case 'incompatible-version':
          return {
            kind: 'invariant-violation',
            violations: [`지원 범위 초과 스키마(${fresh.found} > ${fresh.supported})`],
          }
        case 'io-failure':
          return { kind: 'io-failure', step: 'rename', path: fresh.path, cause: fresh.cause }
        default:
          return assertNever(fresh)
      }

      const revision = read.observedRevision + 1
      const record = serialize(next, revision, {
        ownerToken: lease.ownerToken,
        at: opts.now(),
        durability: opts.durability,
      })
      const violations = checkInvariants(record)
      if (violations.length > 0) return { kind: 'invariant-violation', violations }

      return writeDurably(record, revision)
    }

    /**
     * 내구 쓰기(§W-4 계약 3항). rename 을 경계로 **반환 종별이 갈린다** — 그 전 실패는 `io-failure`
     * (디스크 무변이), 그 후 실패는 `commit-uncertain`(디스크 revision 은 이미 전진).
     */
    const writeDurably = (record: BenchAuthorityRecord, revision: number): CasResult => {
      const json = JSON.stringify(record)
      let step: PreCommitStep = 'mkdir'
      let fd: number | undefined
      let renamed = false
      try {
        fs.mkdirRecursive(opts.authorityDir, AUTHORITY_DIR_MODE)
        step = 'open-tmp'
        fd = fs.openExclusive(tmpPath, AUTHORITY_FILE_MODE)
        step = 'write'
        fs.writeAll(fd, json)
        step = 'fsync-file'
        fs.fsync(fd)
        step = 'close-tmp'
        fs.close(fd)
        fd = undefined
        step = 'rename'
        fs.rename(tmpPath, path)
        renamed = true
      } catch (cause) {
        return { kind: 'io-failure', step, path: step === 'rename' ? path : tmpPath, cause }
      } finally {
        // fd 가 남아 있다 = 어느 단계가 던졌다. 실물에서 열린 핸들은 **그 자체로 DoS 표면**이다 —
        // win32 는 대상에 열린 핸들이 하나라도 있으면 rename 이 EPERM 이고 그 rename 이 곧 CAS 커밋이다.
        if (fd !== undefined) {
          try {
            fs.close(fd)
          } catch {
            /* 이미 닫혔거나 close 자체가 실패한 경우 — 원인은 위에서 이미 반환됐다. */
          }
        }
        // **자기 tmp 만** 치운다(정정 78). rename 이 성공했으면 tmp 는 이미 없다.
        if (!renamed) {
          try {
            fs.unlinkIfExists(tmpPath)
          } catch {
            /* 정리 실패가 원래 원인을 덮지 않는다. */
          }
        }
      }

      // ── 여기부터 커밋됨. 실패해도 디스크 revision 은 전진해 있다. ──
      if (opts.durability === 'file+dir') {
        let post: PostCommitStep = 'open-dir'
        let dirFd: number | undefined
        try {
          dirFd = fs.openDir(opts.authorityDir)
          post = 'fsync-dir'
          fs.fsync(dirFd)
          post = 'close-dir'
          fs.close(dirFd)
          dirFd = undefined
        } catch (cause) {
          return { kind: 'commit-uncertain', step: post, advancedRevision: revision, cause }
        } finally {
          if (dirFd !== undefined) {
            try {
              fs.close(dirFd)
            } catch {
              /* 위와 같다. */
            }
          }
        }
      }

      return { kind: 'committed', record, commit: mintCommit(record, opts.durability) }
    }

    const tx: AuthorityTx = { readFresh, compareAndSwap }
    return (async () => {
      try {
        return await fn(tx)
      } finally {
        // 임계 구역을 벗어난 tx 는 죽는다 — 유출된 핸들로 뮤텍스·리스 재검증 창 **밖에서** CAS 가 도는
        // 것을 막는 유일한 수단이다(계획 정정 94). 새 실패 종별을 만들지 않고 `released` 를 재사용한다.
        live = false
      }
    })()
  }

  return {
    withAuthority(lease, fn) {
      // **출처를 뮤텍스보다 먼저 본다**(계획 정정 93). 복제 토큰(`{...lease, identity: B}`)은 캐스트 0개로
      // 컴파일되고 원본의 살아있는 `revalidate` 를 들고 있어 `owned` 를 답하며 `ownerToken` 도 같다 —
      // 즉 `foreign-owner`·`identity-mismatch` 어느 것도 잡지 못하고 `isMintedLease` 가 유일 방어다.
      // 여기서 걸리면 **뮤텍스도 잡지 않고 파일시스템도 만지지 않는다**.
      if (!isMintedLease(lease)) {
        const dead: AuthorityTx = {
          readFresh: () => ({ kind: 'lease-invalid', reason: 'stolen' }),
          compareAndSwap: () => Promise.resolve({ kind: 'lease-invalid', reason: 'stolen' }),
        }
        return fn(dead)
      }

      const key = mutexKey(lease.identity)
      const prev = MUTEX_TAILS.get(key) ?? Promise.resolve()
      // 앞 임계 구역의 성패와 무관하게 다음이 진입한다(실측: `then(fn, fn)` 이 FIFO 를 지키면서
      // 예외를 삼키지 않는다 — 예외는 `run` 쪽으로만 나가고 꼬리는 정상 진행한다).
      const run = prev.then(
        () => runCritical(lease, fn),
        () => runCritical(lease, fn),
      )
      const tail = run.then(
        () => undefined,
        () => undefined,
      )
      MUTEX_TAILS.set(key, tail)
      // 레지스트리 무한 누적 방지 — **내 꼬리일 때만** 지운다(형제 `locks.ts` 의 WeakSet 수명 규율 동형).
      void tail.then(() => {
        if (MUTEX_TAILS.get(key) === tail) MUTEX_TAILS.delete(key)
      })
      return run
    },
  }
}

/**
 * 브랜드 민팅 — **인가된 forge 2곳**(`authority-structure.test.ts` 가 개수를 exact 로 핀한다).
 * 브랜드는 `declare const` 라 런타임 값이 없으므로 캐스트 외에 만들 방법이 없고, 그래서 이 두 함수가
 * 「CAS 성공 시에만 존재」·「같은 임계 구역에서 방금 읽었다」를 물리적으로 독점한다.
 */
const mintRead = (lease: BenchLeaseToken, observedRevision: number): FreshReadToken =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 브랜드(`FRESH_READ`)는 런타임 값이 없는 타입 전용 심볼이라 캐스트로만 민팅된다. 인가된 forge 2곳 중 하나이며 3번째는 구조 핀이 RED 로 만든다.
  Object.freeze({
    identity: lease.identity,
    observedRevision,
    leaseOwnerToken: lease.ownerToken,
    readSeq: ++readSeqCounter,
  }) as FreshReadToken

const mintCommit = (record: BenchAuthorityRecord, durability: DurabilityLevel): AuthorityCommit =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 위와 같다(인가된 forge 2곳 중 둘째).
  Object.freeze({
    identity: record.identity,
    revision: record.revision,
    sourceGeneration: record.sourceGeneration,
    ...(record.activeActivity === undefined
      ? {}
      : { activityId: record.activeActivity.activityId }),
    durability,
  }) as AuthorityCommit
