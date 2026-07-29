import { dirname, join } from 'node:path'

import type { BenchLifecycle } from '../../../shared/types'
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
 * 값 구현(`createBenchAuthorityStore`·`withAuthority`)과 **`commit-uncertain` 반환**은 PR2b(계획 정정 77 이
 * 선이관), rename **재시도**·per-retry L-6·gated-orphan 회수는 PR2c, 엔진 배선은 PR7 이다. 타입이 먼저 서는 이유는 계약 사슬의 척추이기 때문이다 — 어느 실패 종별이
 * 존재하는지가 정해져야 그 각각을 RED 로 만들 수 있다.
 *
 * **레이아웃 = bench 당 파일 1개** `<area>/authority/<benchId>.json`. 단일 파일을 기각한 근거는
 * ⓐ무관 bench 간 revision 충돌로 fail-closed 폭증 ⓑ활동 경로가 레포-전역 직렬화를 획득해 락 서열(L-3)
 * 위반 ⓒN bench 마다 O(N) 전량 재직렬화다. 기존 `createJsonFileStore` 를 **쓰지 않는 것도 계약**이다 —
 * 전체 스냅숏 tmp→rename 덮어쓰기라 두 프로세스가 붙으면 last-writer-wins 로 상대 세대가 조용히
 * 소멸한다(`store/json-file.ts:29,50-57`).
 *
 * ## `ApprovalGate` 를 거치지 않는 이유 (명시 예외 · AGENTS.md 「안전 우선」이 요구하는 문서화 · Codex PR#266 4R)
 *
 * 이 모듈은 CAS 경로에서 `mkdir`·`openExclusive`·`writeAll`·`rename`·`unlinkIfExists` 를 **직접 조율**한다
 * (실행은 주입 `DurableFs` 가 하지만 **무엇을 어디에 쓸지 정하는 것은 여기다**). 그럼에도 승인 게이트 밖인
 * 근거는 형제 선례와 같다 — 게이트의 범위는 «LLM 변이·툴 실행·프로세스 spawn»이고(소비자 = `engine`·
 * `orchestrator`·`mcp/host`·`tools/loop`), **엔진 인프라 쓰기**는 전부 게이트 밖이라는 선례가 이미 있다
 * (`store/json-file.ts` · `workspace/ignored-baseline.ts` · `workbench/coord-area.ts` · `active-instance.ts` ·
 * `durable-fs.ts`). 소비 경로도 **부팅·CAS 임계 구역**이라 승인자가 존재하지 않고, §W-3 **L-5**(승인 대기 중
 * 락 보유 금지)와 방향이 정면으로 충돌한다 — 게이트를 걸면 리스를 쥔 채 사람을 기다리게 된다.
 *
 * **그래서 destructive 조작을 막는 것은 게이트가 아니라 아래 넷이다**(AGENTS.md 가 요구하는 「소유 확인 ·
 * create-only 경합」의 이 모듈판):
 * 1. **리스 출처 확인** — `withAuthority` 진입 시 `isMintedLease`. 실패하면 파일시스템을 **만지지 않는다**.
 * 2. **변이 직전 리스 재검증(L-6)** — `compareAndSwap` 이 쓰기 전에 커널 endpoint 소유를 다시 본다.
 * 3. **create-only 경합** — tmp 는 `openExclusive`(`wx`)로만 만들고 이름에 `ownerToken` 을 실어 타 보유자와
 *    충돌하지 않는다. 대상 경로는 **호출자가 준 `authorityDir` + `benchId`** 로만 유도한다(경로를 지어내지 않는다).
 * 4. **identity 3중 대조** — 리스·읽은 레코드·제출 draft 가 모두 같은 bench 를 가리켜야 한다.
 *
 * ⚠ 남는 경계도 적는다: `authorityDir` 의 **정준화·검증은 호출자 책임**(PR7)이므로, 이 모듈은 잘못된
 * 디렉터리를 받으면 그 안에서 성실히 파괴적 쓰기를 한다. 그 방어는 배선 지점에 있다.
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
 *
 * ⚠ **이 필드들을 CAS 가 신뢰하지 않는다**(Codex PR#266 P1). 스프레드 복제는 브랜드를 보존하면서 새
 * 객체가 되므로, 토큰의 `observedRevision` 을 그대로 쓰면 **공격자가 고른 숫자**와 디스크를 비교하게 되고
 * 「재독이 백스톱」은 성립하지 않는다(자체 적대 리뷰 F6 의 refuter 가 바로 그렇게 잘못 판정했다 —
 * 실측: 복제 토큰이 rev 2→3 커밋에 성공하며 통합 4필드를 지웠다). 그래서 판정·값 모두 모듈 스코프
 * **`MINTED_READS` 원장**에서 온다. 여기 필드는 진단·호출자 편의용이다.
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
  /**
   * 리스를 이 임계 구역에서 쓸 수 없다 — throw 는 「판별 유니온 반환」 원칙과 충돌하므로 값으로 보고한다.
   *
   * ⚠ **실제 생산자를 정확히 적는다**(자체 적대 리뷰 SEC-7 · 원안은 「진입 시점에 유실」이라고만 썼다):
   * ⓐ`'stolen'` = 비민팅/복제 리스(`isMintedLease` 실패 · 진입 전) ⓑ`'released'` = 임계 구역이 **끝난 뒤**
   * 유출된 tx 사용. **진입 시점의 커널 재검증은 하지 않는다** — `MINTED_LEASES` 는 해제된 리스도 계속
   * 담으므로, 이미 해제된 리스로 진입해 읽고 토큰을 민팅하는 것이 가능하다. 그 창은 **CAS 의 변이 직전
   * 재검증(L-6)이 닫는다**(쓰기는 절대 나가지 않는다). 읽기만 하고 버리는 것은 무해하므로 이 경계를 택했다.
   */
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
  /**
   * rename **성공 전** 실패(재시도 소진 포함) = 디스크 무변이.
   *
   * ⚠ **정직**(계획 정정 78ⓒ 이행 · 자체 적대 리뷰 perf-4·DYN-08): 원안은 「tmp 만 잔존 · **다음 CAS 가
   * 회수**」였는데 그 회수는 **두 갈래 모두에서 존재하지 않는다**. 같은 리스에서는 이 CAS 의 `finally` 가
   * 이미 자기 tmp 를 치웠으므로 회수할 대상이 없고(vacuous), **크래시 잔재**는 tmp 이름이 `ownerToken`
   * 스코프인데 다음 획득이 새 `ownerToken` 을 받으므로 이름을 알 수 없다 — 게다가 `DurableFs` 에 디렉터리
   * 열거 프리미티브가 없어 seam 위에서 표현조차 못 한다. **고아 tmp 수확기는 미착지**(PR3 이월)이며,
   * 그때까지 크래시 잔재는 누적된다. 이 사실을 은폐하지 않는다.
   */
  | {
      readonly kind: 'io-failure'
      readonly step: PreCommitStep
      readonly path: string
      readonly cause: unknown
    }
  /**
   * rename **성공 후** 내구 단계 실패 = **디스크 revision 은 이미 전진**했는데 커밋 토큰은 발급하지 않는다.
   * 「쓰기 실패·상태 무변」과 반드시 구분한다(Codex 체크포인트 2 P1-5).
   *
   * ⚠ **미착지 기제를 현재형으로 쓰지 않는다**(자체 적대 리뷰 FRAME-07): 「커밋 토큰이 없으므로 CLI 는
   * 실행되지 않는다」는 **런처가 존재할 때** 성립할 성질이고 런처는 PR2c·배선은 PR7 이다. 「디스크에 남은
   * `activeActivity{execGate:'gated'}` 가 다음 부팅의 회수 근거가 된다」의 **회수 코드도 미착지**(PR2c).
   * 지금 이 종별이 실제로 보장하는 것은 **커밋 토큰을 발급하지 않는다**는 것 하나뿐이다.
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
  /**
   * **항상 디스크에서 읽는다.**
   *
   * ⚠ 반증 수단은 **두 축**이다(계획 정정 79 · 원안 문면은 이 PR 이 반증했다): `found` 경로에서
   * `readFileUtf8` 정확히 1회 · **전 경로**에서 `statKind` 정확히 1회. 「호출 1회당 `readFileUtf8` 1회」를
   * 전 경로에 걸면 **부재 경로에서 정답 구현이 RED** 다 — `statKind` 가 `'missing'` 을 답하면 읽기는 0회다.
   */
  readFresh(): AuthorityReadResult
  /** `read` 는 **같은 임계 구역**에서 발급된 미사용 토큰. 성공 시에만 `AuthorityCommit` 을 발급한다. */
  compareAndSwap(read: FreshReadToken, next: BenchAuthorityDraft): Promise<CasResult>
}

export interface BenchAuthorityStore {
  /**
   * **유일한 public 진입점.** bench identity 별 in-process 뮤텍스를 보유한 채
   * `readFresh → 불변식 검사 → compareAndSwap 완료(내구 확정)` 전체를 하나의 임계 구역으로 실행한다.
   * **리스 = 프로세스 간, 뮤텍스 = 프로세스 안.**
   *
   * ⚠⚠ **같은 bench 로 중첩 호출하고 그것을 `await` 하면 영구 교착한다** — 안쪽이 바깥의 꼬리를 기다리고
   * 바깥은 안쪽을 기다린다. 이것은 **호출자 계약**이며 런타임이 막지 않는다. 막으려 시도했다가 되돌린
   * 이력을 남긴다(정직): `AsyncLocalStorage` 기반 재진입 가드를 넣었더니 **거짓 양성 3종**이 연달아
   * 나왔다 — ⓐ첫 구역이 `await` 중일 때 도착한 무관한 호출 ⓑ구역 종료 후에도 상속된 컨텍스트
   * ⓒ`finally` 보다 먼저 도는 분리 마이크로태스크(실측: `queueMicrotask` 후속이 `holding.live` 해제
   * 이전에 실행된다). 거짓 양성은 **정당한 fire-and-forget 후속을 unhandled rejection 으로 만들어
   * 프로세스를 죽일 수 있고**, 참 양성은 **개발 시점에 즉시 드러나는 hang** 이다. 비용이 비대칭이라
   * 가드를 철회하고 **항상 큐잉**한다(Codex PR#266 3R). 분리 후속·늦은 동시 호출은 전부 정상 동작한다.
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
  /**
   * rename 재시도 백오프 대기(#251 PR2c · C4). **`now` 와 같은 이유로 주입**이다 — 주입이 없으면
   * 「백오프 0ms」·「순서 역전」·「고정값」 구현이 §3-T17·T17b·T17c 를 **전부 GREEN** 으로 통과해
   * C4 의 존재 이유(상대 핸들이 닫히기를 기다리는 시간 창)가 미검증 출하된다(계획 정정 107).
   *
   * ⚠ **선택적이 아니라 필수**다(형제 `providers/resilient.ts:9` 는 선택적 + 기본값). 이 store 는
   * PR2c 시점에 **소비자가 0** 이라, 기본값을 두면 그 기본 구현이 어떤 게이트도 거치지 않고 착지한다.
   * 프로덕션 구현은 아래 `realBackoffSleep` 이며 PR7 배선이 그것을 주입한다.
   */
  readonly sleep: (ms: number) => Promise<void>
}

/**
 * rename 재시도 백오프(ms · §W-4 C4). **원소 개수 = 재시도 횟수**이고 총 시도는 `1 + length` 다.
 * 문면의 「4회」가 총 시도인지 재시도인지 미정이었고, 백오프 원소 4개를 전부 소비하는 해석으로
 * 확정했다(계획 정정 108 · 총 대기 150ms).
 */
export const RENAME_BACKOFF_MS: readonly number[] = Object.freeze([10, 20, 40, 80])

/**
 * 재시도 대상 errno(§W-4 C4).
 *
 * ⚠ **3면 실측(win32 24.16 / linux 22.22.3 · 24.18)이 말해 주는 정직한 한계**(계획 「PR2c 착수 전 실측
 * 정정」): 이 집합에서 **일시성이 확인된 것은 win32 EPERM(대상에 열린 핸들) 하나**다. 같은 win32 EPERM 이
 * 「대상이 디렉터리」·「대상이 읽기 전용」에서도 나오는데 그 둘은 **영구 실패**이고 errno 로는 구분되지
 * 않는다 — 그 경우 150ms 를 소진한 뒤 `io-failure` 로 끝난다. 영구/일시 판별을 시도하지 않는 이유는
 * **비용 비대칭**이다: 판별자가 틀리면 일시적 실패를 영구로 오분류해 **정상 커밋을 잃는다**(150ms 지연
 * 보다 훨씬 비싸다). `EACCES` 는 POSIX 에서 부모 권한 문제라 역시 영구이며, **`EBUSY` 는 3면 어디서도
 * 재현되지 않았다** — 방어적으로 유지하되 그 근거가 관측이 아님을 여기 명기한다(미검증 근거를 검증된
 * 것처럼 쓰지 않는다).
 *
 * `switch` 가 아니라 `Set` 인 것도 계약이다 — 워크벤치 전수 assertNever selector(`eslint.config.mjs`)는
 * `switch` 마다 `default: assertNever` 를 요구하는데 errno 는 판별 유니온이 아니라 열린 문자열이다.
 */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])

const isRetryableRenameError = (cause: unknown): boolean => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(형제 `durable-fs.ts:134`·`active-instance.ts:160`). 캐스트를 리뷰에 보이게 두는 것이 이 룰의 목적이다.
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RENAME_RETRY_CODES.has(code)
}

/**
 * 프로덕션 백오프 대기. 소비자는 **PR7 부팅 배선**이다(이 PR 시점에 호출부 0).
 *
 * `AbortSignal` 을 받지 않는 것이 형제 `providers/resilient.ts` 와의 의도적 차이다 — 이 대기는
 * **리스와 뮤텍스를 쥔 채** 도는 유계 구간(총 150ms)이고, 중간에 끊으면 tmp 정리 책임이 두 갈래로
 * 갈린다. 취소는 상위(활동 취소)가 소유한다.
 */
export const realBackoffSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 활동 잔재의 종별(§W-4 「`commit-uncertain` 복구」 · #251 PR2c T9c).
 *
 * `gated-orphan` = **게이트가 해제된 적 없음 = 사용자 코드 0줄 실행**의 증거다. `commit-uncertain`
 * (rename 성공 후 dir fsync 실패)은 커밋 토큰을 발급하지 않으므로 CLI 가 뜨지 못하는데 디스크에는
 * `execGate:'gated'` 가 남을 수 있고, 그 항목은 리스 보유자가 정리해도 안전하다.
 *
 * `live-activity`(=`execGate:'running'`)는 **회수 대상이 아니다** — 살아있는 자식이 있을 수 있고
 * 그것을 「0줄 실행」으로 오분류해 변이하면 스펙이 스스로 fail-open 이라 부른 상태가 된다. 그 판정은
 * §W-16 해제 판정(자식 트리 사망 증거)의 소관이다.
 */
export type StaleActivity =
  | { readonly kind: 'none' }
  | { readonly kind: 'gated-orphan'; readonly activityId: string }
  | { readonly kind: 'live-activity'; readonly activityId: string }

/**
 * 활동 잔재 **판정만** 한다 — 이 함수는 아무것도 변이하지 않고 회수 CAS 는 호출자(PR7 T30b) 소관이다.
 *
 * 회수를 store 메서드로 만들지 않은 이유가 계약이다(계획 정정 100): 「`activeActivity` 를 뺀 draft 를
 * CAS 한다」는 **이미 되는 일**이라 store 에 넣어도 새 보장이 없고, 반대로 「`running` 은 회수 불가」를
 * CAS 층 불변식으로 넣으면 **정상 활동 종료**(spawn 실패 시 활동 종결 CAS — §W-4)까지 봉쇄돼 사용자가
 * 고착된다. 판정과 집행을 분리하면 둘 다 피한다.
 *
 * ⚠ **`ownerToken` 을 보지 않는다.** 「이 gated 를 내 획득이 썼는가」는 판정을 바꾸지 않는다 — 누가
 * 썼든 게이트가 열린 적 없다는 사실이 그대로 0줄 실행의 증거다. 판정을 바꾸지 않는 정보를 유니온에
 * 실으면 소비자가 거기에 잘못된 의미(「내 것만 안전」)를 부여한다.
 */
export function classifyStaleActivity(record: BenchAuthorityRecord): StaleActivity {
  const activity = record.activeActivity
  if (activity === undefined) return { kind: 'none' }
  return activity.execGate === 'gated'
    ? { kind: 'gated-orphan', activityId: activity.activityId }
    : { kind: 'live-activity', activityId: activity.activityId }
}

/**
 * 회수 CAS 에 그대로 넘길 draft — **`activeActivity` 만 소멸**하고 나머지는 전부 그대로다.
 *
 * 보존 계약(계획 정정 101 · 지금까지 어느 문서에도 없었다): `sourceGeneration` **무변**(되돌리면 §W-8
 * 완결 관측의 세대 귀속이 조용히 깨진다) · `lifecycle`·`schemaVersion`·`identity`·통합 4필드·
 * `archivedBranch` 전부 무변.
 *
 * **rest 구조분해**로 쓰는 것이 규범이다(필드 명시 재조립은 새 필드가 늘 때마다 누락 표면을 신설한다 —
 * `serialize` 가 6필드를 명시 재조립하는 것은 **호출자 객체의 초과 키를 막기 위해서**이고 목적이 다르다).
 * `revision`·`writtenBy` 를 함께 떼는 이유는 `compareAndSwap` 의 사전조건이 그 두 키의 **존재 자체**를
 * `invariant-violation` 으로 거부하기 때문이다(저장소만 배정) — 즉 이 산출물은 그대로 CAS 인자가 된다.
 */
export function reclaimDraft(record: BenchAuthorityRecord): BenchAuthorityDraft {
  const { activeActivity: _reclaimed, revision: _revision, writtenBy: _writtenBy, ...rest } = record
  return rest
}

/**
 * 권위 레코드 크기 상한. 형제 `active-instance.ts` 가 같은 축에 이미 실측 상한을 출하했고, 근거도 같다 —
 * 이 영역은 ttyd 셸·CLI 에이전트와 **같은 신뢰 도메인**(§W-2-a)이라 누구든 거대 파일을 놓을 수 있고,
 * 그 읽기는 **뮤텍스와 리스를 쥔 채** 동기로 일어나 이벤트 루프를 막는다. 정상 레코드는 활동 1건까지
 * 합쳐도 1KiB 미만이므로 64KiB 는 정상 사용을 전혀 건드리지 않는다(계획 정정 96).
 */
const MAX_AUTHORITY_BYTES = 64 * 1024

/**
 * 권위 디렉터리·파일 권한(win32 에서 무시되는 것은 §3-T59 가 흡수).
 *
 * ⚠ **형제와 동형이 아니다**(자체 적대 리뷰 SEC-6 · 원안 주석은 「같다」고 썼는데 거짓이었다):
 * `mkdirRecursive` 의 mode 는 **새로 만들 때만** 적용되고 **선존재 디렉터리에는 no-op** 이다. 형제
 * `coord-area.ts` 는 uid 검사 + `chmodSync` 로 기존 모드까지 강제하는데, 여기서는 `DurableFs` 에
 * `chmod`·`stat-uid` 프리미티브가 없어 **주입 seam 위에서 표현 자체가 불가**하다. 즉 이 상수가 보장하는
 * 것은 「우리가 만든 디렉터리」뿐이며, 누군가 0777 로 미리 만들어 둔 경우는 **PR7 부팅 경로**가
 * (형제와 같은 방식으로) 봐야 한다. 프리미티브 추가는 어댑터 두께 상한과 함께 그때 판단한다.
 */
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
/**
 * **민팅 원장**(Codex PR#266 P1). `FreshReadToken` 의 **필드를 신뢰하지 않는다** — 스프레드 복제
 * `{...read, observedRevision: 현재값}` 은 미export 브랜드를 보존하면서 **새 객체**라 `SPENT_READS` 에
 * 없고 `leaseOwnerToken` 검사도 통과한다. 그리고 CAS 의 디스크 재독은 그 **공격자가 고른**
 * `observedRevision` 과 디스크를 비교하므로 백스톱이 되지 못한다.
 *
 * ⚠ 이것이 실측으로 확정된 공격이다: 소진된 옛 토큰을 복제해 `observedRevision` 만 현재 revision 으로
 * 바꾸면 CAS 가 `committed` 를 답하고, **실제 읽기 이후 바뀐 필드가 지워진다**(rev 2→3 · 통합 4필드 소멸).
 * 자체 적대 리뷰(F6)는 이 벡터를 찾았으나 refuter 가 「재독이 백스톱」이라며 P3 로 강등했고 **그 근거가
 * 틀렸다** — Codex 가 정정했다.
 *
 * 그래서 판정과 값 모두 **원장에서** 온다(형제 `locks.ts` 의 `MINTED_LEASES` 와 같은 규율).
 * `WeakMap` 인 이유도 같다: 토큰 수명을 붙잡지 않는다.
 */
const MINTED_READS = new WeakMap<
  FreshReadToken,
  {
    readonly observedRevision: number
    readonly leaseOwnerToken: string
    readonly identity: BenchAuthorityIdentity
    readonly readSeq: number
    /**
     * **발급한 임계 구역**(Codex PR#266 2R P1). 이것이 없으면 콜백이 미사용 정품 토큰을 밖으로 내보내고
     * **다음** 임계 구역에서 제출할 수 있다 — `AuthorityTx.compareAndSwap` 이 「**같은** 임계 구역에서
     * 발급된 토큰」이라고 규정한 계약이 깨지고, 뮤텍스 밖에서 상태에 의존해 draft 를 조립하는 창이 열린다.
     */
    readonly tx: object
  }
>()
/** identity 별 임계 구역 꼬리. 같은 bench 의 `withAuthority` 호출을 FIFO 로 직렬화한다. */
const MUTEX_TAILS = new Map<string, Promise<unknown>>()

/**
 * 뮤텍스 키 — **직렬화 도메인은 자원 도메인과 정확히 같아야 한다**(자체 적대 리뷰 perf-7·DYN-11).
 *
 * 원안은 identity **3필드**였는데 권위 파일 경로는 `authorityDir` + `benchId` 로만 유도된다(`pathFor`).
 * 키가 자원보다 **세밀하면** 같은 파일을 두 임계 구역이 동시에 변이할 수 있고(fail-open), 반대로 자원보다
 * **거칠면** 무관한 bench 가 서로를 막는다(과직렬화). 그래서 키를 경로 유도와 **같은 성분**으로 맞춘다 —
 * 뮤테이션 실측에서 키를 `benchId` 단독으로 붕괴시킨 M20 이 생존한 것도 이 정합이 미핀이었기 때문이다.
 *
 * **JSON 배열**인 이유는 구분자 충돌이다: 문자열 결합은 `['a','b c']` 와 `['a b','c']` 를 같은 키로
 * 붕괴시킨다(3면 실측). 경로에는 공백이 정상적으로 들어간다.
 *
 * ⚠ 정준화는 여전히 **호출자 책임**이다(PR7) — 같은 파일을 가리키는 두 비정준 경로가 오면 키가 갈려
 * 직렬화가 소멸한다. 이 모듈은 파일시스템을 모르므로 그것을 여기서 막을 수단이 없다.
 */
const mutexKey = (authorityDir: string, benchId: string): string =>
  JSON.stringify([authorityDir, benchId])

/** `unknown` 을 캐스트 없이 들여다본다 — `Reflect.get` 은 own 여부를 묻지 않으므로 `hasOwn` 과 짝짓는다. */
const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? Reflect.get(o, k) : undefined)

/**
 * 전수화 강제 — **이 모듈 전용**이다(CodeRabbit).
 *
 * `providers/types.ts` 의 `assertNever` 는 `Unhandled ContentBlock variant: …` 를 던지므로 권위 CAS 분기에서
 * 발화하면 진단이 **엉뚱한 층**을 가리킨다. 도달 자체가 프로그래밍 오류(새 종별 미처리)이니 그 순간의
 * 메시지가 정확해야 한다. eslint `no-restricted-syntax` selector 가 `assertNever` **이름**을 요구하므로
 * 이름은 유지한다.
 */
function assertNever(x: never): never {
  throw new Error(`권위 CAS: 미처리 판별 종별 ${JSON.stringify(x)}`)
}

const isPlainObject = (v: unknown): v is object =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * 위반 메시지에 값을 싣는다 — **적대 입력이므로 어떤 값이 와도 던지지 않아야 한다**.
 *
 * ⚠ `String(unknown)` 을 쓰면 안 되는 이유가 진단 품질이 아니라 **총체성**이다(자체 적대 리뷰 F8):
 * `{"lifecycle":{"toString":0}}` 처럼 own `toString` 이 **비호출 가능**이면 `String()` 이
 * OrdinaryToPrimitive 에서 `valueOf` 까지 실패해 **TypeError 를 던진다**. 그 바이트는 최상위
 * `__proto__`/`constructor` 검사를 통과하므로(중첩은 보지 않는다) 도달 가능하고, throw 가 `readFresh` 의
 * 「어떤 바이트에도 던지지 않는다」를 깨 뮤텍스 누수 = hang 이 된다.
 *
 * ⚠ **eslint 가 이것을 막지 않는다**: `no-base-to-string` 의 `checkUnknown` 옵션은 기본 비활성이고
 * 이 레포는 `recommendedTypeChecked` 만 확장하므로 `String(unknown)` 은 애초에 보고 대상이 아니다
 * (원안 주석은 「eslint 가 막는다」고 적었는데 거짓이었다 — 그래서 이 함수가 **규율**로 그 자리를 맡는다).
 * `JSON.stringify` 는 순환 참조에서 던지므로 try 로 감싼다.
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
    return { ok: false, violations: [`lifecycle 이 유니온 밖이다: ${show(lifecycle)}`] }
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
    return { ok: false, violations: [`writtenBy.durability 가 유니온 밖이다: ${show(wbDur)}`] }
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
  if (has(r.currentIntegrationStage) !== txn || has(r.currentIntegrationTxnGeneration) !== txn) {
    v.push('③: Stage·Generation 은 TxnId 와 함께 존재하거나 함께 부재해야 한다')
  }
  // ⚠ **`resultOid` 는 4필드 동시 존재가 아니다**(Codex PR#266 2R P1). `prepared` 단계에서는 txnId·
  // generation 이 있어도 resultOid 가 **아직 없다** — 그것은 `composed` 에서 선기록되는 값이다
  // (스펙 §W-7 `resultOid?: string // stage >= 'composed' 필수` · §0.1 C7 「composed 에서 resultOid 선기록」).
  // 정정 98 이 고아 resultOid 를 막으려고 4필드를 무조건 묶었는데, 그러면 **WAL 이 첫 단계에 진입조차
  // 못 한다**(prepared CAS 가 항상 `invariant-violation` → 문서화된 prepared 크래시 복구도 불가).
  // 고아 방지는 아래 두 방향 함의로 충분하다.
  const oidStage =
    r.currentIntegrationStage === 'composed' ||
    r.currentIntegrationStage === 'published' ||
    r.currentIntegrationStage === 'finalized'
  if (has(r.currentIntegrationResultOid) && !txn) {
    v.push('③b: currentIntegrationResultOid 는 TxnId 없이 존재할 수 없다(고아 resultOid)')
  }
  if (has(r.currentIntegrationResultOid) && !oidStage) {
    v.push('③c: currentIntegrationResultOid 는 stage >= composed 에서만 존재한다')
  }
  if (oidStage && !has(r.currentIntegrationResultOid)) {
    v.push('③d: stage >= composed 이면 currentIntegrationResultOid 가 필수다')
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
  // 동결한다 — 반환된 `committed.record.identity` 가 호출자 손에서 바뀌면 진단·감사 기록이 거짓이 되고,
  // `mintCommit` 이 같은 객체를 참조하던 시절에는 커밋 재조준까지 됐다(Codex PR#266 P1).
  identity: Object.freeze({
    commonGitDir: draft.identity.commonGitDir,
    benchRoot: draft.identity.benchRoot,
    benchId: draft.identity.benchId,
  }),
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
  // **6필드 명시 재조립**(자체 적대 리뷰 F4). 참조로 실으면 호출자 객체의 초과 키가 디스크에 기록되고
  // 반환 `committed.record` 가 호출자 객체의 **별칭**이 된다 — 읽기 경로는 이미 6필드로 재조립하므로
  // (`parseRecordShape`) 쓰기만 참조 통과면 규율이 비대칭이다.
  ...(draft.activeActivity === undefined
    ? {}
    : {
        activeActivity: {
          activityId: draft.activeActivity.activityId,
          kind: draft.activeActivity.kind,
          generation: draft.activeActivity.generation,
          ownerToken: draft.activeActivity.ownerToken,
          execGate: draft.activeActivity.execGate,
          startedAt: draft.activeActivity.startedAt,
        },
      }),
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
  options: BenchAuthorityStoreOptions,
): BenchAuthorityStore {
  // **생성 시점 스냅샷**(Codex PR#266 2R P1 · 형제 `locks.ts` 가 PR#264 P1 으로 확립한 규율).
  // `readonly` 는 참조된 객체를 얼리지 않으므로 호출자가 평범한 객체를 넘기면 store 생성 뒤에도 필드를
  // 바꿀 수 있다. 클로저들이 각 단계에서 **다시 읽으면** 뮤텍스·경로가 한 디렉터리를 가리키는 동안
  // `mkdirRecursive` 나 post-rename dir fsync 가 **다른 디렉터리**를 향할 수 있고, 기록되는 내구성 주장도
  // 커밋 도중에 바뀐다 — 파괴적 메타데이터 쓰기의 방향을 호출자가 뒤에서 돌릴 수 있게 된다.
  const opts: BenchAuthorityStoreOptions = Object.freeze({
    authorityDir: options.authorityDir,
    durability: options.durability,
    now: options.now,
    sleep: options.sleep,
  })
  /**
   * 권위 디렉터리의 **부모**가 이 store 수명 안에서 내구화됐는가(Codex PR#266 3R P1).
   * `false` 로 시작하므로 재시작 후 첫 CAS 도 한 번은 동기화한다 — 「이번에 만들었는가」로 판정하면
   * 생성 성공 + fsync 실패 조합에서 구멍이 영구히 남는다.
   */
  let parentDurable = false

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
    /** 이 tx 의 신원 — 발급 토큰을 여기 결속해 **다른 구역에서의 제출**을 거부한다(Codex 2R P1). */
    const txId = {}

    const readFresh = (): AuthorityReadResult => {
      if (!live) return { kind: 'lease-invalid', reason: 'released' }
      let kind
      try {
        kind = fs.statKind(path)
      } catch (cause) {
        return { kind: 'io-failure', step: 'read', path, cause }
      }
      if (kind.kind === 'missing') return { kind: 'absent', read: mintRead(lease, 0, txId) }
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

      return {
        kind: 'found',
        record: shape.record,
        read: mintRead(lease, shape.record.revision, txId),
      }
    }

    const compareAndSwap = async (
      read: FreshReadToken,
      next: BenchAuthorityDraft,
    ): Promise<CasResult> => {
      if (!live) return { kind: 'lease-invalid', reason: 'released' }

      // ⓪ **출처 먼저 — 토큰의 필드를 믿지 않는다**(Codex PR#266 P1). 원장에 없으면 이 모듈이 발급한
      //    토큰이 아니다(스프레드 복제·수작업 조립). `stolen` 으로 분류하는 이유는 형제
      //    `withLeaseGuard` 와 같다 — 「이 크레덴셜은 인가된 읽기를 대표하지 않는다」.
      const minted = MINTED_READS.get(read)
      if (minted === undefined) return { kind: 'lease-invalid', reason: 'stolen' }

      // ① 토큰 소진(계획 정정 80). 이 순서가 없으면 T13ⓐ 와 T14 가 같은 셋업에 상반된 반환을 요구한다.
      //    원장은 **모듈 스코프**라 store 를 두 번 만들어도 공유된다(정정 95).
      if (SPENT_READS.has(read)) return { kind: 'read-token-spent', readSeq: minted.readSeq }
      if (minted.leaseOwnerToken !== lease.ownerToken) {
        return { kind: 'lease-invalid', reason: 'foreign-owner' }
      }
      if (!sameIdentity(minted.identity, lease.identity)) {
        return { kind: 'lease-invalid', reason: 'identity-mismatch' }
      }
      // **같은 임계 구역에서 발급된 토큰만** 받는다(Codex PR#266 2R P1). `foreign-owner` 의 문면상 의미가
      // 정확히 「남의 임계 구역에서 발급된 읽기 토큰을 들고 왔다」이므로 같은 리스의 다른 구역도 여기 든다.
      if (minted.tx !== txId) return { kind: 'lease-invalid', reason: 'foreign-owner' }
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
          if (fresh.record.revision !== minted.observedRevision) {
            return {
              kind: 'revision-mismatch',
              expected: minted.observedRevision,
              observed: fresh.record,
            }
          }
          break
        case 'absent':
          if (minted.observedRevision !== 0) {
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
          // ⚠ **`io-failure{step:'rename'}` 으로 보고하지 않는다**(자체 적대 리뷰 F2·5렌즈 수렴). 이 지점은
          // ④재독이라 `mkdir` 보다도 **앞**이고 디스크는 한 바이트도 바뀌지 않았다 — rename 이 반쯤 갔다고
          // 증언하면 복구 판정이 「tmp 잔재가 있을 수 있다」로 잘못 분기한다. `step` 은 `PreCommitStep` 이라
          // 재독을 표현할 값 자체가 없다(위 `absent` 분기와 **같은 유니온 공백**) → 같은 방식으로
          // fail-closed 하고 공백을 문면에 남긴다(PR 본문 등재).
          return {
            kind: 'invariant-violation',
            violations: [`CAS 재독이 IO 실패했다(${fresh.path}) — 디스크 무변이`],
          }
        default:
          return assertNever(fresh)
      }

      const revision = minted.observedRevision + 1
      const record = serialize(next, revision, {
        ownerToken: lease.ownerToken,
        at: opts.now(),
        durability: opts.durability,
      })

      // ⑤ **왕복 검증 — 내가 쓴 것을 내가 읽을 수 있는가**(자체 적대 리뷰 F1·DYN-01 · 메인 루프 실측 확정).
      //
      // 쓰기 경로가 읽기 경로보다 약하면 이 모듈이 커밋한 레코드를 **이 모듈 자신이** 다음 `readFresh`
      // 에서 `invalid` 로 거부한다. `invalid` 은 `read` 토큰을 싣지 않으므로 **이 모듈의 API 로는 그
      // 상태를 벗어날 수 없다**(회수는 §W-18 `delete-record`·broken 경로 소관 = PR6 이며 PR2b 표면에 없다).
      //
      // 실측한 사슬: `sourceGeneration: NaN` → ⓐCAS 는 `committed` ⓑ`JSON.stringify` 가 그것을
      // **무성으로 `null` 로** 바꿔 디스크에 쓰고 ⓒ다음 읽기가 `invalid['sourceGeneration 이 안전 정수가
      // 아니다']`. 타입이 막을 것 같지만 막지 못한다 — `Omit` 의 초과 프로퍼티 검사는 객체 리터럴에만
      // 걸리고(정정 73), 그래서 계획 정정 88ⓓ 가 「쓰기 검증이 이 검사를 **먼저** 통과시켜야 한다」를
      // 명시 요구했다. 뮤테이션 실측: 이 블록 이전의 `checkInvariants` 단독 호출은 **지워도 479/479 GREEN**
      // 이었다(M15) = 무신호 방어였다.
      //
      // 술어를 새로 쓰지 않고 **직렬화 → 역직렬화 → 읽기 경로와 같은 검증**을 태우는 이유는, 두 벌을
      // 두면 그 둘이 갈리는 순간 같은 결함이 되돌아오기 때문이다. 이 형태는 「쓴 것은 읽힌다」를
      // **구조적으로** 보장한다(향후 필드가 늘어도 자동 유지된다).
      const json = JSON.stringify(record)
      const verdict = verifySerialized(json, lease.identity)
      if (verdict !== undefined) return verdict

      return writeDurably(json, record, revision)
    }

    /**
     * 왕복 검증 — 위반이면 `CasResult`, 통과면 `undefined`. **디스크를 만지기 전에** 판정한다.
     *
     * 크기 상한도 여기서 본다(자체 적대 리뷰 perf-3): 상한이 읽기 편측이면 초과 레코드를 커밋한 뒤
     * 모든 `readFresh` 가 `invalid` 를 답해 같은 브릭이 된다 — 읽기가 거부할 것을 쓰지 않는다가 계약이다.
     */
    const verifySerialized = (
      json: string,
      identity: BenchAuthorityIdentity,
    ): CasResult | undefined => {
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes > MAX_AUTHORITY_BYTES) {
        return {
          kind: 'invariant-violation',
          violations: [`레코드가 크기 상한 초과(${bytes}B > ${MAX_AUTHORITY_BYTES}B)`],
        }
      }
      let back: unknown
      try {
        back = JSON.parse(json)
      } catch {
        return { kind: 'invariant-violation', violations: ['직렬화 결과가 다시 파싱되지 않는다'] }
      }
      if (!isPlainObject(back)) {
        return { kind: 'invariant-violation', violations: ['직렬화 결과가 객체가 아니다'] }
      }
      const shape = parseRecordShape(back)
      if (!shape.ok) {
        // 「왕복 검증 실패」 접두를 붙인다 — 같은 문구가 읽기 경로에서도 나오므로 출처가 구분돼야 한다.
        return {
          kind: 'invariant-violation',
          violations: shape.violations.map((v) => `왕복 검증 실패: ${v}`),
        }
      }
      if (!sameIdentity(shape.record.identity, identity)) {
        return { kind: 'lease-invalid', reason: 'identity-mismatch' }
      }
      const violations = checkInvariants(shape.record)
      if (violations.length > 0) return { kind: 'invariant-violation', violations }
      return undefined
    }

    /**
     * 내구 쓰기(§W-4 계약 3항). rename 을 경계로 **반환 종별이 갈린다** — 그 전 실패는 `io-failure`
     * (디스크 무변이), 그 후 실패는 `commit-uncertain`(디스크 revision 은 이미 전진).
     */
    /**
     * rename 유한 재시도(§W-4 C4 · #251 PR2c T9). 성공하면 `undefined`, 실패하면 그대로 반환할 `CasResult`.
     *
     * **매 시도 직전에 두 가지를 재검사**한다:
     * - **L-6 리스 소유**(스펙 「각 rename 시도 직전에 … 유실 시 이후 재시도와 rename 을 중단」).
     *   재검증이 루프 밖에 한 번만 있으면 「1회차 실패 → 그 사이 탈취 → 2회차 성공」이 통과해 **남의
     *   리스 아래에서 커밋**한다.
     * - **`live`**(계획 정정 109). 재시도가 이 모듈의 **첫 `await`** 를 만든다 — 그 전까지 CAS 는 동기
     *   구간이라 임계 구역 밖으로 샐 수 없었다. `fn` 이 CAS 를 `await` 하지 않고 반환하면 뮤텍스 꼬리와
     *   `live=false` 가 먼저 해소되고, 그 뒤에도 이 루프가 계속 돌아 파일시스템을 변이할 수 있다.
     *   :「유출된 tx 는 쓰지 못한다」(정정 94)를 재시도 회차 단위로 유지한다.
     *
     * 재시도가 **CAS 결과 밖으로 새지 않는다**(acknowledged): 최종 성공/실패가 전부 반환값에 실린다.
     */
    const renameWithRetry = async (): Promise<CasResult | undefined> => {
      for (let attempt = 0; ; attempt += 1) {
        if (!live) return { kind: 'lease-invalid', reason: 'released' }
        const check = lease.revalidate()
        if (check.kind === 'lost') return { kind: 'lease-invalid', reason: check.reason }
        try {
          fs.rename(tmpPath, path)
          return undefined
        } catch (cause) {
          const backoff = RENAME_BACKOFF_MS[attempt]
          // 재시도 대상이 아닌 코드(ENOENT·EISDIR·`code` 부재 등)는 **즉시** 실패한다 — 그리고 소진도
          // 여기로 온다. 두 경우의 반환은 같다(디스크 무변이).
          if (backoff === undefined || !isRetryableRenameError(cause)) {
            return { kind: 'io-failure', step: 'rename', path, cause }
          }
          await opts.sleep(backoff)
        }
      }
    }

    const writeDurably = async (
      json: string,
      record: BenchAuthorityRecord,
      revision: number,
    ): Promise<CasResult> => {
      let step: PreCommitStep = 'mkdir'
      /** 부모 디렉터리 내구화 중이면 그 경로 — 실패 진단이 실제 대상을 싣게 한다(CodeRabbit). */
      let parentTarget: string | undefined
      let fd: number | undefined
      let renamed = false
      try {
        fs.mkdirRecursive(opts.authorityDir, AUTHORITY_DIR_MODE)
        // **디렉터리 생성은 부모를 변경한다**(Codex PR#266 2R P1). 그 부모를 fsync 하지 않으면 전원 손실 시
        // `durability:'file+dir'` 로 `committed` 를 답했는데도 **권위 디렉터리 자체가 사라질 수 있다** —
        // 파일과 디렉터리는 내구화했지만 그것을 담은 엔트리는 아직 저널에 없기 때문이다.
        //
        // ⚠ 판정 근거가 **「이번에 만들었는가」이면 안 된다**(Codex 3R P1): 만들었는데 부모 fsync 가
        // **실패하면** 디렉터리는 디스크에 남고, 다음 CAS 는 `mkdirRecursive` 가 「이미 있음」을 답해
        // 이 블록을 건너뛴 채 `committed` 를 반환한다 — 부모가 여전히 미내구인데 `file+dir` 을 주장한다.
        // 그래서 **성공할 때까지 재시도**하는 store-지역 플래그를 쓴다. 플래그가 `false` 로 시작하므로
        // **재시작 후 첫 CAS 도** 반드시 한 번 동기화한다(프로세스 교체로 구멍이 남지 않는다).
        //
        // 커밋 **전** 단계인 이유: 디렉터리는 우리가 의존을 시작하기 전에 내구해야 하고, 여기서 실패하면
        // 디스크 무변이라 `io-failure{step:'mkdir'}` 가 정확하다(post-commit 로 밀면 「revision 전진」이라는
        // 거짓 증언이 된다).
        if (opts.durability === 'file+dir' && !parentDurable) {
          // 이 구간의 실제 대상은 **부모**다 — 실패 시 진단이 권위 디렉터리를 가리키면 복구 판정이
          // 엉뚱한 경로를 본다(CodeRabbit). 아래 `target` 계산이 이 값을 우선한다.
          parentTarget = dirname(opts.authorityDir)
          const parentFd = fs.openDir(parentTarget)
          try {
            fs.fsync(parentFd)
          } finally {
            fs.close(parentFd)
          }
          parentDurable = true // 성공했을 때만 — 실패하면 catch 로 나가고 다음 CAS 가 다시 한다.
          parentTarget = undefined
        }
        step = 'open-tmp'
        fd = fs.openExclusive(tmpPath, AUTHORITY_FILE_MODE)
        step = 'write'
        fs.writeAll(fd, json)
        step = 'fsync-file'
        fs.fsync(fd)
        step = 'close-tmp'
        // **소유권 이관**(자체 적대 리뷰 SEC-5): `close` 를 부르기 **전에** 지역 소유권을 놓는다. 그래야
        // close 가 던져도 `finally` 가 같은 fd 를 다시 닫지 않는다 — POSIX 는 실패해도 fd 를 반납하므로
        // 재-close 는 그 틈에 같은 번호를 받은 **무관한 fd** 를 닫을 수 있다.
        {
          const toClose = fd // 모듈 헬퍼 `own(o,k)` 과 이름이 겹치지 않게(CodeRabbit)
          fd = undefined
          fs.close(toClose)
        }
        step = 'rename'
        // ⚠ **재시도는 이 한 단계에만** 걸린다(§3-T17 「재시도 범위 falsifier」). 앞 단계들을 함께
        // 감싸면 `openExclusive` 가 자기 tmp 에 EEXIST 로 자기잠금하고(정정 78), 부분 쓰기가 누적된다.
        const retryFailure = await renameWithRetry()
        if (retryFailure !== undefined) return retryFailure
        renamed = true
      } catch (cause) {
        // 단계별로 **실제 대상**을 싣는다(CodeRabbit): `mkdir` 은 디렉터리이고 `rename` 은 최종 경로다.
        // 전부 tmp 로 답하면 복구 판정이 **존재하지도 않는 tmp** 를 보게 된다.
        // `parentTarget` 이 우선이다(CodeRabbit) — 부모 내구화 구간의 실제 대상은 부모 디렉터리이고,
        // step 은 여전히 'mkdir' 이라 그것만으로는 권위 디렉터리가 실려 진단이 엉뚱한 경로를 가리킨다.
        const target =
          parentTarget ??
          (step === 'mkdir' ? opts.authorityDir : step === 'rename' ? path : tmpPath)
        return { kind: 'io-failure', step, path: target, cause }
      } finally {
        // fd 가 남아 있다 = 어느 단계가 던졌다. 실물에서 열린 핸들은 **그 자체로 DoS 표면**이다 —
        // win32 는 대상에 열린 핸들이 하나라도 있으면 rename 이 EPERM 이고 그 rename 이 곧 CAS 커밋이다.
        // 여기 도달 시 `fd` 가 남아 있다 = `close` **이전** 단계가 던졌다(close 자신은 위에서 소유권을
        // 넘겼으므로 이 자리에 오지 않는다). 실물에서 열린 핸들은 그 자체로 DoS 표면이다 — win32 는 대상에
        // 열린 핸들이 하나라도 있으면 rename 이 EPERM 이고 그 rename 이 곧 CAS 커밋이다.
        if (fd !== undefined) {
          try {
            fs.close(fd)
          } catch {
            /* 정리 실패가 원래 원인을 덮지 않는다. */
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
          {
            const toClose = dirFd // 소유권 이관(위와 동형)
            dirFd = undefined
            fs.close(toClose)
          }
        } catch (cause) {
          return { kind: 'commit-uncertain', step: post, advancedRevision: revision, cause }
        } finally {
          if (dirFd !== undefined) {
            try {
              fs.close(dirFd)
            } catch {
              /* 위와 같다(SEC-5 이중 close 방지 동형). */
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

      const key = mutexKey(opts.authorityDir, lease.identity.benchId)

      const prev = MUTEX_TAILS.get(key) ?? Promise.resolve()
      // 앞 임계 구역의 성패와 무관하게 다음이 진입한다. ⚠ **그 성질을 만드는 것은 아래 `tail` 이다**
      // (자체 적대 리뷰 F7·DYN-10). 원안은 `prev.then(fn, fn)` 으로 핸들러를 둘 두고 그것을 근거로
      // 서술했는데, `prev` 는 항상 예외를 흡수한 `tail` 이라 **결코 reject 하지 않으므로** 두 번째 핸들러는
      // 도달 불가 사문이었다. 핸들러를 하나로 줄여 실제 기제를 문면과 일치시킨다.
      //
      // 「사문을 보험으로 남기라」는 반론(꼬리를 `run` 으로 바꾸는 미래 편집 대비)은 **실측으로 기각**했다 —
      // 그 편집을 실제로 넣으면 「fn 이 throw 해도 다음 호출이 진입한다」·「중첩 실패 후 재진입」 **2행이
      // RED** 다. 보험은 사문이 아니라 그 행동 테스트가 들고 있다.
      const run = prev.then(() => runCritical(lease, fn))
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
const mintRead = (
  lease: BenchLeaseToken,
  observedRevision: number,
  txId: object,
): FreshReadToken => {
  const readSeq = ++readSeqCounter
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 브랜드(`FRESH_READ`)는 런타임 값이 없는 타입 전용 심볼이라 캐스트로만 민팅된다. 인가된 forge 2곳 중 하나이며 3번째는 구조 핀이 RED 로 만든다.
  const token = Object.freeze({
    identity: lease.identity,
    observedRevision,
    leaseOwnerToken: lease.ownerToken,
    readSeq,
  }) as FreshReadToken
  // **원장이 권위다**(Codex PR#266 P1) — CAS 는 토큰 필드가 아니라 여기 기록된 값을 읽는다.
  MINTED_READS.set(token, {
    observedRevision,
    leaseOwnerToken: lease.ownerToken,
    identity: lease.identity,
    readSeq,
    tx: txId,
  })
  return token
}

const mintCommit = (record: BenchAuthorityRecord, durability: DurabilityLevel): AuthorityCommit =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 위와 같다(인가된 forge 2곳 중 둘째).
  Object.freeze({
    // **복사 후 동결**(Codex PR#266 P1). `Object.freeze` 는 얕으므로 `record.identity` 를 참조로 실으면
    // `Object.assign(result.record.identity, {benchId: 다른bench})` 가 **커밋의 identity 까지 바꾼다** —
    // 바깥 객체는 동결·유효한 채로 남으므로 런처가 그 크레덴셜을 소비하면 **한 bench 용 커밋이 다른
    // bench 로 재조준**된다(실측 확정). 형제 `locks.ts` 가 리스 민팅에서 같은 이유로 중첩까지 얼린다.
    identity: Object.freeze({
      commonGitDir: record.identity.commonGitDir,
      benchRoot: record.identity.benchRoot,
      benchId: record.identity.benchId,
    }),
    revision: record.revision,
    sourceGeneration: record.sourceGeneration,
    ...(record.activeActivity === undefined
      ? {}
      : { activityId: record.activeActivity.activityId }),
    durability,
  }) as AuthorityCommit
