import type { BenchLifecycle } from '../../../shared/types'
import type { DurabilityLevel } from './durable-fs'
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
   * **이 층이 생산**한다 — 전자는 레코드의 `writtenBy.ownerToken` 이 현 리스와 다를 때, 후자는 레코드
   * identity 가 리스 identity 와 어긋날 때다(감사 L1-3: 스펙이 생산 조건을 서술하지 않아 여기서 고정).
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
