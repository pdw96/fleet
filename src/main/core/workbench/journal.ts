import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import type {
  BenchAuthorityDraft,
  IntegrationStage,
  PostCommitStep,
  PreCommitStep,
} from './authority'
import { isRetryableRenameError, projectAuthorityDraft, RENAME_BACKOFF_MS } from './authority'
import type { DurabilityLevel, DurableFs } from './durable-fs'
import type { BenchLeaseToken } from './locks'
import { isMintedLease } from './locks'
import { isUlid } from './ulid'

/**
 * 통합 WAL 저널 (#251 PR3b · 스펙 §W-7 「저널 매체 계약」) — **레코드·파서·전이 술어·내구 쓰기**.
 *
 * **레이아웃 = txn 당 파일 1개** `<area>/journal/<benchId>/<txnId>.json`. 단계 전진은 append 가 아니라
 * **같은 파일 덮어쓰기**이고(계획 정정 178), 그래서 전이 술어의 비교 대상은 인자가 아니라 **디스크의
 * 현재 엔트리**다 — 인자로 받으면 호출자가 「내가 방금 뭘 썼다고 생각하는지」를 근거로 전진하게 되어
 * 크래시 후 재개에서 실제 디스크와 어긋난다.
 *
 * ## 이 PR 에서 **하지 않는** 것(정직 표기 — 미착지 기제를 현재형으로 쓰지 않는다)
 *
 * - **복구 판정·회수 어휘는 여기 없다**(계획 정정 159·173 → PR3c). 판정 함수가 자기 입력의 생산자보다
 *   먼저 착지하는 배치 자체가 `anchor-unavailable` 같은 유령 상태를 만든다는 것이 그 정정의 근거다.
 * - **디렉터리 열거를 하지 않는다** — `DurableFs` 에 순회 프리미티브가 없고 그 신설은 PR3d 다. 여기 있는
 *   것은 **주어진 이름 목록에 대한 순수 필터**(`classifyJournalFileName`)뿐이며, 「열거가 있다」로 읽지 말 것.
 * - **크레덴셜·임계 구역 결속이 여기 없다**(계획 정정 187 → PR3c). 「직전 단계 CAS 의 증거」·「호출자
 *   구역 생존」을 저널이 인가하려면 authority 가 **구역 capability 를 민팅**하고 **크레덴셜이 관측된
 *   통합 상태(txn·stage·세대)를 실어야** 하는데, 그 필드 계약은 PR3c 소유이고 유일한 소비자(시퀀서)는
 *   PR5 다. Codex 4라운드가 이 축에서만 P1 을 반복 산출한 것이 그 배치가 틀렸다는 증거였고, 정정 159 가
 *   복구 판정을 옮긴 것과 **같은 기준**으로 이관했다.
 * - 그 결과 이 모듈이 세우는 인가는 **리스뿐**이다. 정정 167 의 결속 5필드는 **기록되지만 대조되지
 *   않는다** — 대조자가 PR3c 다. 「검사한다」로 읽히지 않게 적는다.
 * - **소비자가 0 이다.** 통합 트랜잭션 시퀀서(PR5 T18)·부팅 복구(PR7)가 붙기 전까지 이 모듈은 프로덕션
 *   경로에서 도달 불가다.
 *
 * ## `ApprovalGate` 를 거치지 않는 이유 (명시 예외 · 형제 `authority.ts` 와 동형 · AGENTS.md 「안전 우선」)
 *
 * 이 모듈도 CAS 경로와 같은 **엔진 인프라 쓰기**다 — 소비 지점이 부팅·리스 임계 구역이라 승인자가 없고
 * §W-3 **L-5**(승인 대기 중 락 보유 금지)와 방향이 충돌한다. destructive 조작을 막는 것은 게이트가 아니라
 * ⓐ**리스 출처 확인**(`isMintedLease`) ⓑ**변이 직전·재시도 회차마다 재검증**(L-6) ⓒ**create-only tmp**
 * (이름에 리스의 `ownerToken` 을 실어 타 보유자와 충돌하지 않는다) ⓓ**identity 3중 대조** ⓔ**심링크
 * 거부**(`mkdirRecursive` 가 따라가는 것을 쓰기 전에 막는다)다.
 * 경로는 주입된 `journalDir` + 검증된 ULID 2개로만 유도한다 — 이 모듈은 코디네이션 영역을 재유도하지 않는다.
 */

/**
 * 이 코드베이스가 읽을 수 있는 저널 스키마 상한. 초과 = `incompatible-version`(≠ invalid · I12).
 * 형제 `SUPPORTED_AUTHORITY_SCHEMA` 와 같은 규율로 **레코드 필드를 이 값에서 타입 유도**한다.
 *
 * ⚠ 필드 이름이 스펙 원문의 `schema` 가 아니라 `schemaVersion` 인 것은 **의도된 통일**이다(계획 정정 141):
 * 두 매체가 다른 이름을 쓰면 「최우선 검사」 규율이 한쪽에서만 지켜져도 무신호가 된다.
 */
export const SUPPORTED_JOURNAL_SCHEMA = 1

/**
 * 저널 1건의 크기 상한. **읽기 전에** 본다(형제 authority.ts 와 같은 규율) — 상한을 읽은 뒤에 보면
 * 적대적 크기의 파일이 이미 메모리에 올라간 뒤다.
 */
export const MAX_JOURNAL_BYTES = 64 * 1024

const ENTRY_SUFFIX = '.json'
const TMP_SUFFIX = '.tmp'
const JOURNAL_DIR_MODE = 0o700
const JOURNAL_FILE_MODE = 0o600
/** `digestAuthorityDraft` 산출 형식. 임의 문자열을 저장하지 못하게 **형식을 계약으로 고정**한다. */
const DIGEST_RE = /^[0-9a-f]{64}$/

/** §W-7 C7. 스펙 3값 그대로이며 여기서 창작하지 않는다. */
export type AbandonReason = 'user-abandon' | 'superseded' | 'stale-attempt'

/**
 * 통합 트랜잭션 WAL 레코드(§W-7).
 *
 * 뒤쪽 5필드는 **권위 CAS 결속**이다(Codex 3R · 계획 정정 167). 저널이 **선기록**이므로 「무엇을 기대하고
 * 썼는지」를 함께 남겨야 복구가 「자동 승격 가능」과 「`reconciliation-required`」를 가를 수 있다.
 */
export interface IntegrationTxnRecord {
  readonly schemaVersion: typeof SUPPORTED_JOURNAL_SCHEMA
  readonly txnId: string
  readonly benchId: string
  /** 대조 전용 — 경로 유도에 쓰지 않는다(형제 `BenchAuthorityIdentity` 와 같은 규율). */
  readonly repoCommonGitDir: string
  readonly benchRoot: string
  readonly sourceBranch: string
  /** auto-keep OID. */
  readonly sourceSnapshot: string
  readonly sourceGeneration: number
  readonly targetBranch: string
  readonly targetHeadBeforeIntegration: string
  /**
   * ⚠ **문법 소유는 PR3c 다**(계획 정정 174). 정정 166 채택으로 C1 문법에 통합 세대가 결속되는 것이
   * 확정 사항이라, 여기서 문법을 파싱·조립하면 다음 PR 이 곧바로 그것을 수술한다. 이 모듈은 **비어 있지
   * 않은 문자열**까지만 본다 — 「검증을 안 한다」가 아니라 「문법 축이 이 PR 의 계약이 아니다」이다.
   */
  readonly resultRef: string
  readonly startedAt: number
  /** 진단용. */
  readonly ownerEngineId: string
  readonly stage: IntegrationStage
  /** `stage ∈ {composed, published, finalized}` 필수. `prepared` 에는 **없어야** 한다. */
  readonly resultTree?: string
  readonly resultOid?: string
  /** `stage ∈ {published, finalized}` 필수. */
  readonly publishedAt?: number
  readonly abandonedAt?: number
  readonly abandonReason?: AbandonReason
  /** 이 저널에 이어질 권위 CAS 가 맞출 revision(부재 레코드 = 0). **대조자는 PR3c** — 여기서는 형태만 본다. */
  readonly expectedAuthorityRevision: number
  /** 부재 = 진행 중 통합이 없다(트랜잭션 **첫 단계**). */
  readonly previousAuthorityStage?: IntegrationStage
  /**
   * 부재 = 후속 CAS 가 권위의 통합 필드를 **소거**한다(포기 · 계획 정정 177). 포기는 권위 레코드에
   * `abandoned` 를 남기지 않고 4필드를 함께 지우므로(`reclaimDraft` 선례), 「소거」를 표현할 어휘를
   * 새로 만들지 않고 **부재**로 표현한다.
   */
  readonly nextAuthorityStage?: IntegrationStage
  /** 발행자는 PR3c(`prepared` 마다 +1). 이 PR 에서는 값을 검증만 하고 소비하지 않는다. */
  readonly integrationGeneration: number
  /** 제출될 권위 draft 의 정준 JSON sha256(`digestAuthorityDraft`). */
  readonly draftDigest: string
}

/**
 * 호출자가 제출하는 것. `schemaVersion` 은 **store 만 배정**한다 — 호출자가 찍게 두면 지원 범위 밖 버전을
 * 기록하는 경로가 열리고, 그 파일은 이후 자기 자신에게 `incompatible-version` 이 된다.
 */
export type IntegrationTxnDraft = Omit<IntegrationTxnRecord, 'schemaVersion'>

/** 이름 하나에 대한 판정. 이 PR 은 **순회하지 않는다** — 이름 목록의 출처는 호출자(PR3d)다. */
export type JournalFileVerdict =
  | { readonly kind: 'entry'; readonly txnId: string }
  | {
      readonly kind: 'ignored'
      readonly reason: 'tmp-residue' | 'not-json' | 'basename-not-ulid'
    }

export type JournalReadResult =
  | { readonly kind: 'found'; readonly record: IntegrationTxnRecord }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'invalid'
      readonly path?: string
      readonly violations: readonly string[]
    }
  /** 문법 위반과 버전 스큐는 다른 사실이다 — 섞으면 구 버전이 신 버전 저널을 지운다(I12). */
  | {
      readonly kind: 'incompatible-version'
      readonly path: string
      readonly found: number
      readonly supported: number
    }
  | {
      readonly kind: 'io-failure'
      readonly step: 'stat' | 'read'
      readonly path: string
      readonly cause: unknown
    }

export type JournalWriteResult =
  | { readonly kind: 'written'; readonly record: IntegrationTxnRecord; readonly path: string }
  | { readonly kind: 'invariant-violation'; readonly violations: readonly string[] }
  | {
      readonly kind: 'lease-invalid'
      readonly reason: 'released' | 'stolen' | 'identity-mismatch'
    }
  /**
   * 현재 엔트리를 **읽지 못했다** — 그래서 덮어쓰지 않는다. 구 버전이 신 버전 저널을 지우는 I12 의
   * 저널 표면이자, 손상 파일을 조용히 정상 파일로 갈아치우는 경로의 차단이다.
   */
  | { readonly kind: 'existing-unreadable'; readonly existing: JournalReadResult }
  /** rename **성공 전** 실패(재시도 소진 포함) = 디스크 무변이. */
  | {
      readonly kind: 'io-failure'
      readonly step: PreCommitStep
      readonly path: string
      readonly cause: unknown
    }
  /**
   * rename **성공 후** 디렉터리 내구 단계 실패 = 엔트리는 **이미 게시**됐다. 「쓰기 실패·무변이」와 반드시
   * 구분한다(형제 `commit-uncertain` 과 같은 구분 · Codex 체크포인트 2 P1-5).
   */
  | {
      readonly kind: 'write-uncertain'
      readonly step: PostCommitStep
      readonly path: string
      readonly cause: unknown
    }

export interface JournalStoreOptions {
  /** `<area>/journal` — **이미 정준화된** 절대 경로. 검증은 호출자 책임(PR7). */
  readonly journalDir: string
  /** `probeDurability()` 산출물. 이 모듈은 플랫폼을 알지 못한다. */
  readonly durability: DurabilityLevel
  /** rename 재시도 백오프 대기. **선택적이 아니라 필수**다(형제 store 와 같은 근거 — 소비자 0 이라 기본값을 두면 그 구현이 어떤 게이트도 거치지 않고 착지한다). */
  readonly sleep: (ms: number) => Promise<void>
}

export interface JournalStore {
  /** 디스크에서 **항상** 읽는다(캐시 없음 · D-9 즉시-close). */
  read(benchId: string, txnId: string): JournalReadResult
  /**
   * 단계 전진 1회 = (전이 검사, 내구 쓰기).
   *
   * ⚠ **크레덴셜 인자가 없다** — 「직전 단계 CAS 의 증거」와 「호출자 임계 구역 생존」 결속은 **PR3c 로
   * 이관**됐다(계획 정정 187). 그 축은 ⓐ소비자(시퀀서)가 PR5 라 이 PR 에서 전부 vacuous 하고 ⓑ Codex
   * 4라운드가 매 라운드 **직전 라운드의 방어 자체**에서 구멍을 찾았으며(원장 부재 → 동일성 키 우회 →
   * store 스코프 우회 → capability 미인증) ⓒ남은 처방이 **authority 계약 확장**(구역 capability 민팅 ·
   * 크레덴셜에 관측 통합 상태 결속)을 요구하는데 그 필드 계약은 PR3c 소유다. 정정 159 가 복구 판정을
   * 옮긴 것과 **같은 기준**의 적용이다.
   *
   * 그래서 이 PR 이 세우는 인가는 **리스뿐**이다(출처 확인 + 변이 직전·회차별 재검증). 저널 레코드의
   * 결속 필드(`expectedAuthorityRevision` 등)는 **기록되지만 대조자가 없다** — 그 대조가 PR3c 다.
   *
   * **비용 예산**(자가 적대 리뷰 정량화): 정상 경로 `file-only` = IO 프리미티브 **7**(statKind·
   * readFileUtf8·mkdir·openExclusive·writeAll·fsync·close·rename 중 부재 시 read 생략) ·
   * `file+dir` 최초 = **+4**(부모 2 + post-commit openDir/fsync/close). 최악 = rename 4회 재시도로
   * **+4 호출 + 총 150ms 대기**(백오프 `[10,20,40,80]`). 이 값이 바뀌면 §3-T68 의 exact 계수가 RED 다.
   */
  append(lease: BenchLeaseToken, draft: IntegrationTxnDraft): Promise<JournalWriteResult>
}

/* ================================================================================================
 * 순수 술어 — 소비자(PR3c·PR5·PR7)보다 먼저 서는 부분
 * ============================================================================================= */

const STAGE_ORDER: readonly IntegrationStage[] = ['prepared', 'composed', 'published', 'finalized']

/**
 * 합법 전이 그래프(계획 정정 142). 타입·스펙·코드 어디에도 없어 **역행·부활이 어느 층에서도 차단되지
 * 않던** 축이다 — 권위 CAS 는 신 레코드를 단독으로만 검사하므로(authority.ts `checkInvariants`)
 * `published → prepared` 를 막지 못한다.
 *
 * 합법: 부재 → `prepared` · `prepared → composed → published → finalized` · **임의 단계 → `abandoned`**.
 * 그 외 전부 거부한다. **자기 전이 중 `abandoned → abandoned` 만 합법**인데(위 「임의 단계」에 포함),
 * 그것이 스펙 §W-7 이 규정한 「청소 복구(**멱등**)」의 형태이기 때문이다 — 「저널 기록 후 권위 CAS 전
 * 크래시」의 재시도가 막다른 길이 되면 안 된다. 나머지 자기 전이 4개(`composed → composed` 등)는 거부다.
 *
 * 권위 레코드 쪽 전이 불변식 계층은 **PR3c** 다(같은 비가역 축을 두 PR 로 쪼개지 않는다).
 */
export function canAdvanceStage(from: IntegrationStage | undefined, to: IntegrationStage): boolean {
  if (to === 'abandoned') return from !== undefined
  if (from === undefined) return to === 'prepared'
  const i = STAGE_ORDER.indexOf(from)
  return i >= 0 && STAGE_ORDER[i + 1] === to
}

/**
 * 활성 저널 집합 = {`prepared`,`composed`} (§W-7 · C6). **함수 1개로 통일**한다(계획 정정 164) —
 * 「stage 단독」과 「귀속 필요」 두 정의가 공존하면 소비자마다 다른 게이트를 쓰게 된다. 귀속 조건을
 * 더하는 것은 그 어휘를 신설하는 **PR3c** 의 일이며, 그때 spec I11·§3-T33 문면을 같은 커밋에서 고친다.
 *
 * ⚠ `published` 는 **활성이 아니다** — integration-ready bench 의 `delete-record`·`abandon` 이 허용되는
 * 근거가 이 사실이고, `abandoned` 는 **보존하되 활성에서 제외**한다(계획 정정 135 · 감사 목적).
 */
export function isActiveJournalStage(stage: IntegrationStage): boolean {
  return stage === 'prepared' || stage === 'composed'
}

/**
 * 파일 이름 1개 판정(§3-T65). **tmp 를 먼저 거른다** — 실측상 접미 필터가 없으면 크래시 tmp 잔재가
 * `txnId = "<ULID>.json.<ownerToken>"` 인 엔트리로 **오독**된다.
 */
export function classifyJournalFileName(name: string): JournalFileVerdict {
  if (name.endsWith(TMP_SUFFIX)) return { kind: 'ignored', reason: 'tmp-residue' }
  if (!name.endsWith(ENTRY_SUFFIX)) return { kind: 'ignored', reason: 'not-json' }
  const base = name.slice(0, -ENTRY_SUFFIX.length)
  if (!isUlid(base)) return { kind: 'ignored', reason: 'basename-not-ulid' }
  return { kind: 'entry', txnId: base }
}

/** 이름 목록 → 저널 txnId 목록. 순회는 호출자(PR3d)가 한다. */
export function selectJournalTxnIds(names: readonly string[]): readonly string[] {
  const out: string[] = []
  for (const name of names) {
    const verdict = classifyJournalFileName(name)
    if (verdict.kind === 'entry') out.push(verdict.txnId)
  }
  return out
}

/**
 * 엔트리 경로 유도. **문법 위반이면 `undefined`** — 두 id 는 경로 성분이 되므로 정규화하지 않고 거부하는
 * 것이 단사 계약의 집행이다(§W-1 `isUlid` 와 같은 규율). ULID 알파벳에는 `/`·`.` 가 없어 통과 집합에서
 * 경로 탈출이 **표현 불가**하다.
 */
export function journalEntryPath(
  journalDir: string,
  benchId: string,
  txnId: string,
): string | undefined {
  if (!isUlid(benchId) || !isUlid(txnId)) return undefined
  return join(journalDir, benchId, `${txnId}${ENTRY_SUFFIX}`)
}

/* ================================================================================================
 * 정준 직렬화 · 다이제스트
 * ============================================================================================= */

/** `unknown` 을 캐스트 없이 들여다본다(형제 authority.ts 와 같은 관용구). */
const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? Reflect.get(o, k) : undefined)

const isPlainObject = (v: unknown): v is object =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * 위반 메시지에 값을 싣는다 — **적대 입력이므로 어떤 값이 와도 던지지 않아야 한다**(형제 authority.ts:722
 * 와 같은 근거: own `toString` 이 비호출 가능이면 `String()` 이 TypeError 를 던져 파서가 총체성을 잃는다).
 */
const show = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? typeof v
  } catch {
    return typeof v
  }
}

/**
 * 키 순서에 무관한 정준 JSON. `JSON.stringify` 는 **삽입 순서**를 그대로 쓰므로 같은 내용의 draft 가 다른
 * 다이제스트를 낼 수 있고, 그러면 복구의 「digest 불일치 = 다른 의도」 판정(정정 167)이 오탐을 낸다.
 */
const canonicalJson = (value: unknown): string => {
  // ⚠ **배열 전용 경로를 두지 않는다**: 권위 draft 계약에 배열이 없어 그 arm 은 도달 불가이고, 도달 불가
  // arm 은 커버리지에 잡히지 않으면서 「처리한다」는 인상만 준다(이 PR 이 왕복 파싱을 지운 것과 같은 규율).
  //
  // ⚠ **정직**: `isPlainObject` 는 배열을 **제외**하므로(위 술어) 배열이 오면 아래 일반 객체 경로가 아니라
  // **native `JSON.stringify`** 로 빠진다 — 원소가 원시값이면 결정론적이지만 **배열 안의 객체는 키 정렬을
  // 받지 못한다**. 즉 미래에 배열 필드가 생기면 이 함수는 조용히 정준성을 잃는다. 그때 전용 경로와
  // 단언을 **함께** 추가해야 한다(지금 추가하면 그 arm 이 도달 불가다).
  if (!isPlainObject(value)) return JSON.stringify(value) ?? 'null'
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const v = own(value, key)
    if (v === undefined) continue // `JSON.stringify` 와 같은 규칙 — 부재와 undefined 를 같게 본다.
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * 저널이 결속하는 `draftDigest` 의 **유일한 생산자**(계획 정정 167). 여기 두지 않으면 생산자(PR5)와
 * 대조자(PR3c)가 각자 다른 정준화를 만들어 「불일치」가 상시 참이 된다.
 */
export function digestAuthorityDraft(draft: BenchAuthorityDraft): string {
  // ⚠ **CAS 가 실제로 기록할 투영을 해시한다**(Codex PR#269 3R P1). 호출자 draft 를 그대로 해시하면
  // 구조적 서브타이핑으로 실려 온 **초과 키**가 값에 섞이는데, 정작 CAS 는 필드 명시 재조립을 기록한다 —
  // 그러면 같은 의도의 트랜잭션이 「다른 증거」로 보여 복구가 정상 CAS 를 reconciliation 으로 오분류한다.
  return createHash('sha256')
    .update(canonicalJson(projectAuthorityDraft(draft)), 'utf8')
    .digest('hex')
}

/* ================================================================================================
 * 파서 — `schemaVersion` 최우선
 * ============================================================================================= */

const STAGES: readonly IntegrationStage[] = [
  'prepared',
  'composed',
  'published',
  'finalized',
  'abandoned',
]
const REASONS: readonly AbandonReason[] = ['user-abandon', 'superseded', 'stale-attempt']

const isStage = (v: unknown): v is IntegrationStage => STAGES.some((s) => s === v)
const isReason = (v: unknown): v is AbandonReason => REASONS.some((r) => r === v)

/** 단계가 바뀌어도 **같아야 하는** 필드. 「전이는 합법인데 내용이 통째로 바뀐」 레코드를 막는다. */
const IMMUTABLE_FIELDS = [
  'txnId',
  'benchId',
  'repoCommonGitDir',
  'benchRoot',
  'sourceBranch',
  'sourceSnapshot',
  'sourceGeneration',
  'targetBranch',
  'targetHeadBeforeIntegration',
  'resultRef',
  'startedAt',
  'ownerEngineId',
  // 통합 세대는 **시도에 배정**된다(정정 166: prepared 마다 +1) — 단계 전진에서 바뀌면 그 시도의
  // 권위 결속이 소멸하고 복구가 다른 세대를 근거로 추론한다(Codex PR#269 4R P1).
  'integrationGeneration',
] as const

/**
 * **한 번 나타나면 얼어붙는 결과 증거**(Codex PR#269 3R P1). 불변 12필드와 다른 점은 **처음 등장이
 * 정상**이라는 것이다 — 단계가 값을 들여오는 것은 계약이고, 이미 들어온 값을 바꾸는 것이 금지다.
 */
const EVIDENCE_FIELDS = ['resultTree', 'resultOid', 'publishedAt'] as const

/**
 * 형태 + 조건부 결속 검증(§3-T71). **관계 검사보다 형태가 앞선다**(형제 authority.ts 와 같은 순서) —
 * 유니온 밖 `stage` 는 조건부 규칙을 vacuously 만족하며 통과한 뒤 전 소비자의 분기를 조용히 빠져나간다.
 *
 * 산출은 **필드 명시 재구성**이다 — 캐스트로 좁히면 초과 키·`__proto__` 가 레코드에 실려 다음 쓰기에서
 * 디스크로 되돌아간다.
 */
const parseRecordShape = (
  o: object,
):
  | { readonly ok: true; readonly record: IntegrationTxnRecord }
  | { readonly ok: false; readonly violations: string[] } => {
  const v: string[] = []
  const str = (k: string): string => {
    const raw = own(o, k)
    if (!isNonEmptyString(raw)) {
      v.push(`${k} 가 비어 있지 않은 문자열이 아니다: ${show(raw)}`)
      return ''
    }
    return raw
  }
  const num = (k: string): number => {
    const raw = own(o, k)
    if (!isCount(raw)) {
      v.push(`${k} 가 0 이상의 안전 정수가 아니다: ${show(raw)}`)
      return 0
    }
    return raw
  }
  const optStr = (k: string): string | undefined => {
    const raw = own(o, k)
    if (raw === undefined) return undefined
    if (!isNonEmptyString(raw)) {
      v.push(`${k} 가 비어 있지 않은 문자열이 아니다: ${show(raw)}`)
      return undefined
    }
    return raw
  }
  const optNum = (k: string): number | undefined => {
    const raw = own(o, k)
    if (raw === undefined) return undefined
    if (!isCount(raw)) {
      v.push(`${k} 가 0 이상의 안전 정수가 아니다: ${show(raw)}`)
      return undefined
    }
    return raw
  }
  const optStage = (k: string): IntegrationStage | undefined => {
    const raw = own(o, k)
    if (raw === undefined) return undefined
    if (!isStage(raw)) {
      v.push(`${k} 가 IntegrationStage 유니온 밖이다: ${show(raw)}`)
      return undefined
    }
    return raw
  }

  const txnId = str('txnId')
  const benchId = str('benchId')
  if (txnId !== '' && !isUlid(txnId)) v.push(`txnId 가 ULID 문법이 아니다: ${show(txnId)}`)
  if (benchId !== '' && !isUlid(benchId)) v.push(`benchId 가 ULID 문법이 아니다: ${show(benchId)}`)

  const stageRaw = own(o, 'stage')
  if (!isStage(stageRaw)) {
    // 이후 조건부 규칙 전체가 stage 에 걸려 있으므로 **즉시 반환**한다(수집하면 뒤 규칙이 무의미해진다).
    v.push(`stage 가 IntegrationStage 유니온 밖이다: ${show(stageRaw)}`)
    return { ok: false, violations: v }
  }

  const reasonRaw = own(o, 'abandonReason')
  if (reasonRaw !== undefined && !isReason(reasonRaw)) {
    v.push(`abandonReason 이 유니온 밖이다: ${show(reasonRaw)}`)
  }

  const record: IntegrationTxnRecord = {
    schemaVersion: SUPPORTED_JOURNAL_SCHEMA,
    txnId,
    benchId,
    repoCommonGitDir: str('repoCommonGitDir'),
    benchRoot: str('benchRoot'),
    sourceBranch: str('sourceBranch'),
    sourceSnapshot: str('sourceSnapshot'),
    sourceGeneration: num('sourceGeneration'),
    targetBranch: str('targetBranch'),
    targetHeadBeforeIntegration: str('targetHeadBeforeIntegration'),
    resultRef: str('resultRef'),
    startedAt: num('startedAt'),
    ownerEngineId: str('ownerEngineId'),
    stage: stageRaw,
    resultTree: optStr('resultTree'),
    resultOid: optStr('resultOid'),
    publishedAt: optNum('publishedAt'),
    abandonedAt: optNum('abandonedAt'),
    abandonReason: isReason(reasonRaw) ? reasonRaw : undefined,
    expectedAuthorityRevision: num('expectedAuthorityRevision'),
    previousAuthorityStage: optStage('previousAuthorityStage'),
    nextAuthorityStage: optStage('nextAuthorityStage'),
    integrationGeneration: num('integrationGeneration'),
    draftDigest: str('draftDigest'),
  }

  if (record.draftDigest !== '' && !DIGEST_RE.test(record.draftDigest)) {
    v.push(`draftDigest 가 sha256 hex 64 형식이 아니다: ${show(record.draftDigest)}`)
  }

  // ── 조건부 결속(§3-T71) ──
  const composedOrLater =
    record.stage === 'composed' || record.stage === 'published' || record.stage === 'finalized'
  if (composedOrLater && (record.resultOid === undefined || record.resultTree === undefined)) {
    v.push(`stage=${record.stage} 인데 resultOid·resultTree 가 없다`)
  }
  if (
    record.stage === 'prepared' &&
    (record.resultOid !== undefined || record.resultTree !== undefined)
  ) {
    // 형제 권위 불변식 ③c 와 같은 방향 — `prepared` 는 정의상 결과가 없고, 있으면 이후 판정이
    // 「값 비교」를 시도해 성립하지 않는 분기로 들어간다.
    v.push('stage=prepared 인데 resultOid·resultTree 가 있다')
  }
  if (
    (record.stage === 'published' || record.stage === 'finalized') &&
    record.publishedAt === undefined
  ) {
    v.push(`stage=${record.stage} 인데 publishedAt 이 없다`)
  }
  if (record.stage === 'abandoned') {
    if (record.abandonedAt === undefined || record.abandonReason === undefined) {
      v.push('stage=abandoned 인데 abandonedAt·abandonReason 이 없다')
    }
    if (record.nextAuthorityStage !== undefined) {
      v.push('포기 엔트리에는 nextAuthorityStage 가 없어야 한다(후속 CAS 가 통합 필드를 소거한다)')
    }
  } else if (record.nextAuthorityStage !== record.stage) {
    v.push(
      `nextAuthorityStage(${show(record.nextAuthorityStage)}) 가 stage(${record.stage}) 와 다르다`,
    )
  }

  return v.length > 0 ? { ok: false, violations: v } : { ok: true, record }
}

/**
 * 바이트 → 레코드. **`schemaVersion` 을 문법보다 먼저** 본다(I12) — 그 순서를 뒤집으면 구 버전이 신 버전
 * 저널을 `invalid` 로 오분류하고, 이 모듈의 쓰기 경로는 `invalid` 를 덮어쓸 수 있게 되어 **상위 버전이
 * 만든 진행 중 트랜잭션이 지워진다**.
 */
const parseJournalJson = (
  raw: string,
  path: string,
  expected: { readonly benchId: string; readonly txnId: string },
): JournalReadResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { kind: 'invalid', path, violations: [`JSON 파싱 실패: ${show(cause)}`] }
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'invalid', path, violations: ['최상위가 객체가 아니다'] }
  }

  // ⚠ **버전 판정이 다른 어떤 검사보다도 앞선다**(Codex PR#269 3R P1 — 「최우선」을 문면으로만 지키고
  // 있었다): 오염 키 검사를 먼저 두면 `schemaVersion: 2` + `constructor` 인 파일이 `invalid` 로 분류되고,
  // `invalid` 는 broken·삭제 처리로 흘러갈 수 있는 반면 `incompatible-version` 은 **파괴적 조치를
  // 차단해야 하는** 종별이다(I12). 이 바이너리가 해석할 수 없는 스키마는 **무엇이 더 들어 있든**
  // 상위 버전이다. `own` 은 `Object.hasOwn` + `Reflect.get` 이라 오염 키가 있어도 안전하게 읽는다.
  const sv = own(parsed, 'schemaVersion')
  if (!isCount(sv) || sv < 1) {
    return { kind: 'invalid', path, violations: [`schemaVersion 형태 오류: ${show(sv)}`] }
  }
  if (sv > SUPPORTED_JOURNAL_SCHEMA) {
    return { kind: 'incompatible-version', path, found: sv, supported: SUPPORTED_JOURNAL_SCHEMA }
  }

  // 지원 버전에만 스키마별 키 검증을 적용한다.
  if (Object.hasOwn(parsed, '__proto__') || Object.hasOwn(parsed, 'constructor')) {
    return { kind: 'invalid', path, violations: ['프로토타입 오염 키가 있다'] }
  }

  const shape = parseRecordShape(parsed)
  if (!shape.ok) return { kind: 'invalid', path, violations: shape.violations }

  // 경로와 내용의 대조(§3-T65 ⓒⓓ) — 이름만 믿으면 복사된 엔트리가 남의 txn 으로 행세한다.
  const mismatch: string[] = []
  if (shape.record.txnId !== expected.txnId) mismatch.push('내부 txnId 가 파일 이름과 다르다')
  if (shape.record.benchId !== expected.benchId) {
    mismatch.push('내부 benchId 가 상위 디렉터리와 다르다')
  }
  if (mismatch.length > 0) return { kind: 'invalid', path, violations: mismatch }

  return { kind: 'found', record: shape.record }
}

/* ================================================================================================
 * store — 내구 쓰기
 * ============================================================================================= */

/**
 * **크레덴셜 원장과 겹침 가드는 모듈 스코프**여야 한다(Codex PR#269 3R P1 · 형제 계획 정정 95 와 같은
 * 근거). store 지역이면 **같은 저널 디렉터리를 겨냥한 두 번째 store 를 만드는 것만으로** 「크레덴셜 1개 =
 * 전이 1개」와 tmp 겹침 가드가 통째로 우회된다 — A 로 `composed` 를 쓰고 B 로 같은 커밋을 재사용해
 * `published` 를 쓰면 두 검사 모두 빈 원장을 본다. 키가 크레덴셜 객체·tmp 경로라 store 간 오염은 없다.
 */
const APPENDS_IN_FLIGHT = new Set<string>()

export function createJournalStore(fs: DurableFs, opts: JournalStoreOptions): JournalStore {
  /**
   * **생성 시점 스냅숏**(Codex PR#269 3R P1). `readonly` 는 컴파일 타임 표기일 뿐이라, 평범한 가변 객체를
   * 넘긴 뒤 `journalDir` 를 바꾸면 **검증된 쓰기 경계 밖으로 인프라 쓰기가 재조준**되고 `durability` 를
   * 바꾸면 요구된 디렉터리 fsync 가 조용히 건너뛰어진다(형제 store 가 옵션을 동결하는 것과 같은 규율).
   */
  const cfg: JournalStoreOptions = Object.freeze({
    journalDir: opts.journalDir,
    durability: opts.durability,
    sleep: opts.sleep,
  })
  /**
   * 부모 디렉터리 엔트리를 내구화한 적이 있는가. **디렉터리 생성은 부모를 변경**하므로 그 부모를 fsync
   * 하지 않으면 전원 손실 시 파일·디렉터리는 살아남았는데 그것을 담은 엔트리가 사라질 수 있다
   * (형제 authority.ts 가 Codex PR#266 2R P1 로 닫은 축). **성공했을 때만** 기록해 실패 시 다음 쓰기가
   * 다시 시도하게 한다 — 「이번에 만들었는가」로 판정하면 실패 후 다음 쓰기가 건너뛴다.
   */
  const syncedParents = new Set<string>()

  const syncDirEntry = (dir: string): void => {
    const fd = fs.openDir(dir)
    try {
      fs.fsync(fd)
    } finally {
      fs.close(fd)
    }
  }

  const read = (benchId: string, txnId: string): JournalReadResult => {
    const path = journalEntryPath(cfg.journalDir, benchId, txnId)
    if (path === undefined) {
      return { kind: 'invalid', violations: ['benchId·txnId 가 ULID 문법이 아니다'] }
    }
    let kind
    try {
      kind = fs.statKind(path)
    } catch (cause) {
      return { kind: 'io-failure', step: 'stat', path, cause }
    }
    if (kind.kind === 'missing') return { kind: 'absent' }
    if (kind.kind !== 'regular') {
      // **읽기 전** 거부 — FIFO 면 `readFileUtf8` 이 무기한 블록해 부팅이 정지한다(§W-5 규율).
      return { kind: 'invalid', path, violations: ['정규 파일이 아니다(읽지 않았다)'] }
    }
    if (kind.size > MAX_JOURNAL_BYTES) {
      return { kind: 'invalid', path, violations: [`크기 상한 초과: ${kind.size}B`] }
    }
    let raw: string
    try {
      raw = fs.readFileUtf8(path)
    } catch (cause) {
      return { kind: 'io-failure', step: 'read', path, cause }
    }
    return parseJournalJson(raw, path, { benchId, txnId })
  }

  /**
   * rename 유한 재시도(C4 상속). 성공하면 `undefined`.
   *
   * **매 시도 직전에 둘을 다시 본다**:
   * - **L-6 리스 소유** — 재검증이 루프 밖에 한 번만 있으면 「1회차 실패 → 그 사이 탈취 → 2회차 성공」이
   *   통과해 **남의 리스 아래에서 게시**한다.
   * - **호출자 임계 구역 생존**(Codex PR#269 P1) — 백오프가 이 모듈의 첫 `await` 이고, 호출자가 이
   *   호출을 `await` 하지 않고 `withAuthority` 콜백을 끝내면 뮤텍스가 풀린 뒤에도 이 루프가 계속 돈다.
   *   그때 **리스는 여전히 유효**하므로 위 재검증은 통과하고, 다음 임계 구역이 갱신한 bench 위에
   *   rename 하게 된다. 형제 CAS 의 `live` 플래그와 같은 자리이며, 여기서는 주입으로 받는다.
   */
  const renameWithRetry = async (
    lease: BenchLeaseToken,
    from: string,
    to: string,
  ): Promise<JournalWriteResult | undefined> => {
    for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt += 1) {
      const check = lease.revalidate()
      if (check.kind === 'lost') return { kind: 'lease-invalid', reason: check.reason }
      try {
        fs.rename(from, to)
        return undefined
      } catch (cause) {
        const backoff = RENAME_BACKOFF_MS[attempt]
        // 재시도 비대상 코드와 백오프 소진은 반환이 같다(둘 다 디스크 무변이).
        if (backoff === undefined || !isRetryableRenameError(cause)) {
          return { kind: 'io-failure', step: 'rename', path: from, cause }
        }
        await cfg.sleep(backoff)
      }
    }
    // **유계 루프**의 도달 불가 꼬리 — 안전 실패로 닫는다(형제 authority.ts 와 같은 규율).
    return {
      kind: 'io-failure',
      step: 'rename',
      path: from,
      cause: new Error('rename 재시도 루프가 결과 없이 종료했다(상한과 백오프 길이 불일치)'),
    }
  }

  const append = async (
    lease: BenchLeaseToken,
    draft: IntegrationTxnDraft,
  ): Promise<JournalWriteResult> => {
    // ── ① 파일시스템 무접촉 구간: 리스·크레덴셜·형태 ──
    //
    // ⚠ **가장 먼저 제출물을 스냅숏한다**(Codex PR#269 4R P1). 호출자 객체는 평범한 타입으로도 **getter·
    // Proxy** 일 수 있어, 같은 프로퍼티를 여러 번 읽으면 **읽을 때마다 다른 값**을 줄 수 있다 — identity
    // 검사는 bench A 를 보고 경로 유도·재구성·디스크 읽기·`benchDir` 유도는 bench B 를 보는 조합이
    // 성립하면, A 의 리스·크레덴셜로 **B 아래에 파괴적 쓰기**가 인가된다. 스프레드는 각 프로퍼티를
    // **한 번만** 읽으므로 이 복사본 이후로는 호출자가 무엇을 하든 관측이 흔들리지 않는다.
    const submitted: IntegrationTxnRecord = { ...draft, schemaVersion: SUPPORTED_JOURNAL_SCHEMA }

    if (!isMintedLease(lease)) return { kind: 'lease-invalid', reason: 'stolen' }
    if (
      lease.identity.benchId !== submitted.benchId ||
      lease.identity.commonGitDir !== submitted.repoCommonGitDir ||
      lease.identity.benchRoot !== submitted.benchRoot
    ) {
      return { kind: 'lease-invalid', reason: 'identity-mismatch' }
    }

    const path = journalEntryPath(cfg.journalDir, submitted.benchId, submitted.txnId)
    if (path === undefined) {
      return {
        kind: 'invariant-violation',
        violations: ['benchId·txnId 가 ULID 문법이 아니다(경로를 만들지 않았다)'],
      }
    }

    const violations: string[] = []

    // ⚠ **스탬프가 스프레드보다 뒤에 온다**(순서가 계약이다): `Omit` 의 초과 프로퍼티 검사는 객체
    // 리터럴에만 걸리므로 `const r: IntegrationTxnRecord = …; append(lease, r, prev)` 가 구조적
    // 서브타이핑으로 통과한다(형제 계획 정정 73 과 같은 구멍). 스프레드가 뒤였다면 호출자가 실어 온
    // `schemaVersion: 99` 가 store 배정을 **덮어써** 자기 자신에게 `incompatible-version` 인 파일이 남는다.
    // 그래서 ⓐ스탬프를 뒤에 두어 구조적으로 이길 수 없게 하고 ⓑ그 키의 **존재 자체를 거부**한다
    // (조용히 버리면 호출자는 자기 값이 기록됐다고 믿는다).
    if (Object.hasOwn(draft, 'schemaVersion')) {
      violations.push('draft 가 schemaVersion 을 싣고 있다 — 그 필드는 store 만 배정한다')
    }
    const shape = parseRecordShape(submitted)
    if (!shape.ok) {
      violations.push(...shape.violations)
      return { kind: 'invariant-violation', violations }
    }
    if (violations.length > 0) return { kind: 'invariant-violation', violations }

    // ⚠ **이 아래로는 제출물이 아니라 재구성물만 쓴다**(자가 적대 리뷰 4렌즈 독립 수렴 · CONFIRMED).
    // 원본 스프레드를 그대로 직렬화하면 구조적 서브타이핑으로 실려 온 **초과 키**(own enumerable
    // `constructor` · 계산 키 `__proto__`)가 디스크로 나가고, 그 파일은 자기 `read()` 에서
    // 프로토타입 오염으로 `invalid` 이 되어 **이후 모든 append 가 `existing-unreadable` 로 고착**한다.
    // 형제 `authority.ts` 의 `serialize` 가 필드 명시 재조립인 것과 같은 이유이며, 위 `parseRecordShape`
    // 주석이 이미 그 취지를 적어 놓고 정작 쓰기가 재구성물을 버리고 있었다.
    const record = shape.record

    // ── ② 현재 엔트리와의 대조 — 읽지 못하면 **덮어쓰지 않는다** ──
    const existing = read(submitted.benchId, submitted.txnId)
    if (existing.kind !== 'found' && existing.kind !== 'absent') {
      return { kind: 'existing-unreadable', existing }
    }
    const from = existing.kind === 'found' ? existing.record.stage : undefined
    if (!canAdvanceStage(from, record.stage)) {
      return {
        kind: 'invariant-violation',
        violations: [`불법 전이: ${String(from)} → ${record.stage}`],
      }
    }

    if (existing.kind === 'found' && from === 'abandoned') {
      // **포기 재기록은 정확한 멱등 재생이어야 한다**(Codex PR#269 P1). `abandoned → abandoned` 를
      // 합법으로 둔 근거는 「저널 기록 후 권위 CAS 전 크래시」의 재시도가 막다른 길이 되면 안 된다는
      // 것뿐인데, 무조건 허용하면 `abandonedAt`·`abandonReason`·결속 필드가 **다른** 레코드로 종결
      // 기록을 덮어쓸 수 있다 — 파일이 하나라 **원본 감사 증거가 그 자리에서 소멸**하고 PR3c 는
      // 비교할 대상을 잃는다. `IMMUTABLE_FIELDS` 로는 부족해서(종결 필드가 그 목록에 없다) 전체를 본다.
      if (canonicalJson(existing.record) !== canonicalJson(record)) {
        return {
          kind: 'invariant-violation',
          violations: ['포기 엔트리는 정확히 같은 내용으로만 재기록할 수 있다(종결 기록 보존)'],
        }
      }
    } else if (record.previousAuthorityStage !== from) {
      // **주장한 직전 단계가 디스크와 일치해야 한다**(Codex PR#269 P1). 전이 검사는 「디스크 → 새 stage」만
      // 보므로, `previousAuthorityStage` 에 아무 값이나 실어도 통과해 **결속이 없던 전이를 증언**한다 —
      // 복구(PR3c)가 그 거짓 위에서 승격/reconciliation 을 가르게 된다.
      return {
        kind: 'invariant-violation',
        violations: [
          `previousAuthorityStage(${show(record.previousAuthorityStage)}) 가 디스크 단계(${String(from)}) 와 다르다`,
        ],
      }
    }

    if (existing.kind === 'found') {
      const changed = IMMUTABLE_FIELDS.filter(
        (k) => own(existing.record, k) !== own(record, k),
      ).map((k) => `단계 전진에서 불변 필드가 바뀌었다: ${k}`)
      // **결과 증거는 「그 값을 요구하는 단계」만 들여올 수 있고, 그 뒤로는 얼어붙는다**
      // (Codex PR#269 3R·5R P1). 두 규칙이 필요하다:
      // ⓐ이미 기록된 값을 **바꾸는** 것 — txn 당 파일이 하나뿐이라 그 순간 원본 증거가 소멸한다.
      // ⓑ**없던 값을 아무 단계나 들여오는** 것 — `prepared → abandoned` 가 임의의 `resultOid` 를
      //   실으면 **존재한 적 없는 결과**를 증언하는 포기 기록이 남는다(5R 이 짚은 구멍).
      // 그래서 도입은 그 필드를 **계약으로 요구하는 단계**에서만 허용한다.
      const introducer: Record<(typeof EVIDENCE_FIELDS)[number], IntegrationStage> = {
        resultTree: 'composed',
        resultOid: 'composed',
        publishedAt: 'published',
      }
      const replaced = EVIDENCE_FIELDS.filter((k) => {
        const before = own(existing.record, k)
        const after = own(record, k)
        if (before === after) return false
        // 값이 달라지는 것은 **도입 단계에서 처음 등장할 때만** 정상이다.
        return !(before === undefined && after !== undefined && record.stage === introducer[k])
      }).map((k) => `결과 증거가 허용되지 않은 단계에서 바뀌었다: ${k}`)
      const broken = [...changed, ...replaced]
      if (broken.length > 0) return { kind: 'invariant-violation', violations: broken }
    }

    // ── ③ 「읽기가 거부할 것을 쓰지 않는다」 — 크기 상한(형제 `verifySerialized` 의 이 PR 판) ──
    //
    // ⚠ **왕복 파싱은 두지 않는다**: 직렬화 대상이 **재구성물**이라 「형태 검사를 통과했는데 자기
    // 직렬화를 다시 읽으면 실패하는」 입력이 표현 불가하다(초과 키·프로토타입 키가 애초에 담기지 않고
    // `schemaVersion` 은 store 가 찍는다). 도달 불가 arm 을 남기면 커버리지에 잡히지 않으면서 「여기서도
    // 검증한다」는 거짓 인상을 준다(형제 authority.ts 가 rename catch 분기를 같은 이유로 삭제했다).
    // ⚠ 이 논거는 **재구성물을 쓴다는 사실에 의존**한다 — 위 `const record = shape.record` 를 되돌리면
    // 이 주석도 함께 거짓이 된다(그 형태가 실제로 착지했다가 자가 리뷰에서 CONFIRMED 로 잡혔다).
    // 크기 상한은 반대로 **도달 가능**하므로 남긴다.
    const json = JSON.stringify(record)
    const size = Buffer.byteLength(json, 'utf8')
    if (size > MAX_JOURNAL_BYTES) {
      return { kind: 'invariant-violation', violations: [`직렬화 크기 상한 초과: ${size}B`] }
    }

    // ── ④ 변이 구간 ──
    const preCheck = lease.revalidate()
    if (preCheck.kind === 'lost') return { kind: 'lease-invalid', reason: preCheck.reason }

    const benchDir = join(cfg.journalDir, submitted.benchId)

    // **심링크를 따라가지 않는다**(Codex PR#269 P1). `mkdirRecursive` 는 기존 심링크를 그대로 따라가므로
    // `<journalDir>/<benchId>` 가 심링크면 create-only tmp 와 rename 이 **영역 밖**에 떨어진다 — 「검증된
    // ULID 가 파괴적 인프라 쓰기를 영역 안에 가둔다」는 이 모듈의 주장이 그 지점에서 깨진다. 읽기 경로가
    // 「읽기 전에 종류를 본다」를 지키는 것과 같은 규율을 쓰기 경로에도 세운다.
    // ⚠ **조상은 호출자 계약**이다 — `journalDir` 는 이미 정준화된 절대 경로라는 것이 주입 계약이고
    // (형제 `authorityDir` 와 동형), 이 모듈이 유도하는 성분은 `<benchId>` 하나뿐이다.
    //
    // ⚠ **이 검사는 TOCTOU 를 닫지 않는다**(Codex PR#269 5R · 정직 표기): 경로 기반 `lstat` 과 이어지는
    // `mkdirRecursive`·`openExclusive` 사이에 **다른 프로세스가 디렉터리를 심링크로 바꿔치기**할 수 있다.
    // 그것을 구조적으로 막으려면 검증한 디렉터리 **핸들 위에서** 쓰는 `openat` 계열 프리미티브가 필요한데
    // `DurableFs` 에 없고 그 확장은 **PR3d 축**이다. 지금 이 검사가 닫는 것은 **지속적으로 존재하는**
    // 심링크(사고·잔재)이며, 경합하는 능동적 교체는 §W-2-a 위협 모델(「보장 범위 = 사고·경합이지 악의적
    // 변조가 아니다」) **밖**이다 — 「막는다」로 읽히지 않게 여기 적는다.
    const dirKind = fs.statKind(benchDir)
    if (dirKind.kind === 'symlink' || dirKind.kind === 'regular') {
      return {
        kind: 'invariant-violation',
        violations: [`저널 bench 디렉터리가 디렉터리가 아니다(${dirKind.kind}) — 따라가지 않는다`],
      }
    }
    const tmpPath = `${path}.${lease.ownerToken}${TMP_SUFFIX}`

    /**
     * **겹침 가드** — 형제 `authority.ts` 의 `casInFlight` 와 **같은 사슬**이고, 그 사슬은 Codex P1 으로
     * 이미 한 번 닫혔다: ⓐA 가 tmp 를 만들고 rename 이 EPERM 이라 백오프에서 양보 ⓑB 가 진입해
     * `openExclusive` 에서 EEXIST ⓒB 의 `finally` 가 「자기 tmp 정리」로 **A 의 tmp 를 unlink**
     * ⓓA 가 깨어나 rename 하면 ENOENT. 재시도만 했으면 성공했을 쓰기가 남의 정리에 파괴된다.
     *
     * 창을 여는 것은 재시도의 `await` 다. 키가 tmp 경로인 이유는 충돌 조건이 정확히 그것이기 때문이다 —
     * 같은 리스라도 **txnId 가 다르면 tmp 도 다르므로** 병렬이 안전하고, 막을 이유가 없다.
     *
     * ⚠ 이것은 **in-process** 가드다(store 스코프). 프로세스 간 배타는 리스가, 같은 bench 의 권위 쓰기
     * 직렬화는 호출자의 `withAuthority` 뮤텍스가 맡는다 — 그 둘을 대체하지 않는다.
     */
    if (APPENDS_IN_FLIGHT.has(tmpPath)) {
      return {
        kind: 'invariant-violation',
        violations: [
          '같은 tmp 경로의 저널 쓰기가 이미 진행 중이다 — 겹쳐 실행하면 두 쓰기가 서로의 tmp 를 지운다',
        ],
      }
    }
    APPENDS_IN_FLIGHT.add(tmpPath)
    try {
      return await writeDurably(lease, { benchDir, tmpPath, path, json, record })
    } finally {
      APPENDS_IN_FLIGHT.delete(tmpPath)
    }
  }

  /** 변이 구간 본체 — rename 을 경계로 반환 종별이 갈린다(그 전 = 무변이 / 그 후 = 게시됨). */
  const writeDurably = async (
    lease: BenchLeaseToken,
    target: {
      readonly benchDir: string
      readonly tmpPath: string
      readonly path: string
      readonly json: string
      readonly record: IntegrationTxnRecord
    },
  ): Promise<JournalWriteResult> => {
    const { benchDir, tmpPath, path, json, record } = target
    let step: PreCommitStep = 'mkdir'
    /** 부모 내구화 중이면 그 경로 — 실패 진단이 실제 대상을 싣게 한다. */
    let parentTarget: string | undefined
    let fd: number | undefined
    let renamed = false
    try {
      fs.mkdirRecursive(benchDir, JOURNAL_DIR_MODE)
      if (cfg.durability === 'file+dir') {
        // 새로 생긴 엔트리를 담은 **부모**를 내구화한다: `<area>` 가 `journal/` 을, `journal/` 이
        // `<benchId>/` 를 얻었다. bench 마다 다시 필요하므로 키를 디렉터리별로 둔다.
        for (const parent of [dirname(cfg.journalDir), cfg.journalDir]) {
          const key = parent === cfg.journalDir ? benchDir : parent
          if (syncedParents.has(key)) continue
          parentTarget = parent
          syncDirEntry(parent)
          syncedParents.add(key)
          parentTarget = undefined
        }
      }
      step = 'open-tmp'
      fd = fs.openExclusive(tmpPath, JOURNAL_FILE_MODE)
      step = 'write'
      fs.writeAll(fd, json)
      step = 'fsync-file'
      fs.fsync(fd)
      step = 'close-tmp'
      {
        // **소유권 이관** — close 가 던져도 `finally` 가 같은 fd 를 다시 닫지 않는다(형제 SEC-5).
        const toClose = fd
        fd = undefined
        fs.close(toClose)
      }
      step = 'rename'
      const failure = await renameWithRetry(lease, tmpPath, path)
      if (failure !== undefined) return failure
      renamed = true
    } catch (cause) {
      // 단계별 **실제 대상**을 싣는다. ⚠ 부모 내구화 실패도 `step` 은 `'mkdir'` 이다(CodeRabbit PR#269) —
      // `PreCommitStep` 에 그 값이 없고 **그 유니온은 착지 계약**이라 이 PR 이 개정하지 않는다(형제
      // authority.ts 가 같은 형태로, 구분은 `path` 가 진다: 부모 경로면 부모 내구화 실패다).
      const target = parentTarget ?? (step === 'mkdir' ? benchDir : tmpPath)
      return { kind: 'io-failure', step, path: target, cause }
    } finally {
      if (fd !== undefined) {
        try {
          fs.close(fd)
        } catch {
          /* 정리 실패가 원래 원인을 덮지 않는다. */
        }
      }
      // **자기 tmp 만** 치운다(이름에 자기 `ownerToken` 이 실려 있다). rename 이 성공했으면 이미 없다.
      if (!renamed) {
        try {
          fs.unlinkIfExists(tmpPath)
        } catch {
          /* 정리 실패가 원래 원인을 덮지 않는다. */
        }
      }
    }

    // ── 여기부터 엔트리는 게시됐다. 실패해도 디스크에는 남아 있다. ──
    if (cfg.durability === 'file+dir') {
      let post: PostCommitStep = 'open-dir'
      let dirFd: number | undefined
      try {
        dirFd = fs.openDir(benchDir)
        post = 'fsync-dir'
        fs.fsync(dirFd)
        post = 'close-dir'
        {
          const toClose = dirFd
          dirFd = undefined
          fs.close(toClose)
        }
      } catch (cause) {
        return { kind: 'write-uncertain', step: post, path, cause }
      } finally {
        if (dirFd !== undefined) {
          try {
            fs.close(dirFd)
          } catch {
            /* 위와 같다(이중 close 방지 동형). */
          }
        }
      }
    }

    return { kind: 'written', record, path }
  }

  return { read, append }
}
