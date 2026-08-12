/**
 * 통합 WAL **복구 판정**(#251 PR3c · 스펙 §W-7 「복구 판정」) — 순수 함수 · 무변이 관찰 · git 변이 0.
 *
 * ## 이것은 first-match 표가 아니라 **계층**이다
 *
 * ```text
 * ① 권위 fresh read                       ⑤ anchor gate  ← 여기까지 변이 0
 * ② 결과 ref 전수 열거·문법·identity·OID    ⑥ 귀속·전이 불변식 재검증
 * ③ 저널 전수 열거·schemaVersion·identity   ⑦ repo 락 + 리스 아래 fresh read·재열거   ← 소비자(PR5·PR7)
 * ④ ref↔저널 설명 관계 **순수 분류**         ⑧ 조건 유지 시에만 resume-composed-cas CAS ← 소비자
 * ```
 *
 * 저널은 앵커 **앞에서 읽되 읽기·검증만** 한다(계획 정정 200) — 안전 목표는 「앵커보다 먼저 저널을
 * **변이**하지 않는다」이지 「읽지 않는다」가 아니었다. 안 읽으면 **정상 크래시와 롤백을 구분할 정보가
 * ⑤ 에 없다.**
 *
 * ## 앵커 = `refRevision > record.revision`
 *
 * 정렬 키가 권위 `revision` 인 이유(계획 정정 190): CAS 마다 정확히 `+1` 이라 단조가 **이미 기계
 * 집행**된다. ULID 사전순은 같은 ms 20,000건 중 **50.1% 역전**이라 정렬 키로 부적격이었고,
 * `integrationGeneration` 은 `prepared` 마다만 +1 이라 통합 시도 **사이**의 롤백에 침묵한다.
 *
 * 「권위 레코드의 어느 txnId 에도 귀속되지 않는 ref = reconciliation」식은 **폐기**됐다(정정 191):
 * 포기는 결과 ref 를 **보존**하고 §3-T29 는 형제 시도 ref 의 영구 공존을 정상으로 요구하므로 그 식은
 * **영구 오탐**이었다. revision 비교로 바꾸면 보존된 과거 ref 의 revision 은 항상 현재 이하라 그 모순이
 * 구조적으로 사라진다.
 *
 * ⚠ **`durability` 값으로 게이트하지 않는다**(구현 중 확정). 발화가 필요한 표면은 `file-only`(C3)이지만
 * 그 값은 **롤백 대상인 권위 파일 안에** 있다 — 검사의 활성화 조건을 검사 대상과 같은 매체에서 읽으면
 * 독립성이 그 지점에서 조용히 끊긴다(계획 정정 199 2R 교훈의 동형). 판정은 **항상** 돌고, `file+dir`
 * 표면에서는 정상 프로토콜상 발화 입력 자체가 만들어지지 않는다.
 *
 * ## 이 PR 에서 **하지 않는** 것 (정직 표기 · 계획 정정 137 의 규율)
 *
 * - **행동 단언 0.** 「복구기가 인가를 막는다」(§3-T80)·「게이트 전 변이 0건」(T91)·「CAS 후 revision
 *   일치」(T93)·「CAS 실패 시 ref 보존」(T94)·「락 아래 fresh 재검증」(T81·T92)의 **행동** 연언은
 *   생산자(PR5 시퀀서 · PR7 부팅)가 없어 이 PR 에서 **vacuous** 하다. 여기 있는 것은 그 행동이 딛고 설
 *   판정 계층과 **증거 봉인 seam**(`ResumeEvidence.evidenceDigest`)뿐이다.
 * - **열거를 하지 않는다.** ref 열거는 `GitRepo.listRefs`(PR3a), 저널 디렉터리 순회는 PR3d 소관이고
 *   이 모듈은 **주어진 관측**만 본다. 「열거가 있다」로 읽지 말 것.
 */

import { createHash } from 'node:crypto'

import {
  type BenchAuthorityDraft,
  type BenchAuthorityIdentity,
  type BenchAuthorityRecord,
  checkTransitionInvariants,
} from './authority'
import {
  digestAuthorityDraft,
  digestJournalRecord,
  isActiveJournalStage,
  type IntegrationTxnRecord,
  type JournalReadResult,
  WAL_STAGE_ORDER,
} from './journal'
import { parseResultRef, RESULT_REF_ROOT } from './result-ref'

/* ================================================================================================
 * 관측 입력 — **실패도 값**이다(§3-T78)
 * ============================================================================================= */

export type AuthorityObservation =
  | { readonly kind: 'found'; readonly record: BenchAuthorityRecord }
  /** 레코드 부재 = 비교 기준 revision `0`. 「판정 없음」이 아니다(§3-T77). */
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly detail?: string }

export interface ObservedRef {
  readonly ref: string
  readonly oid: string
}

export type RefObservation =
  | { readonly kind: 'ok'; readonly refs: readonly ObservedRef[] }
  /** git 실패를 **빈 집합으로 축소하지 않는다** — 「발행된 ref 없음」과 정반대 판정을 낸다. */
  | { readonly kind: 'failed'; readonly detail?: string }

export interface ObservedJournalEntry {
  readonly txnId: string
  /** PR3b 의 읽기 결과를 **그대로** 싣는다 — 버전 스큐·손상·IO 실패가 각각 다른 사실로 남는다. */
  readonly read: JournalReadResult
}

export type JournalObservation =
  | { readonly kind: 'ok'; readonly entries: readonly ObservedJournalEntry[] }
  | { readonly kind: 'failed'; readonly detail?: string }

export interface RecoveryObservation {
  /**
   * **관측 대상의 identity 를 호출자가 독립으로 싣는다**(Codex PR#289 P1). 초안은 `benchId` 만 받고
   * 레포 identity 는 **권위 레코드에서** 가져다 저널과 대조했는데, 그러면 권위가 부재·손상일 때 대조가
   * 통째로 사라져 **다른 레포에서 복사된 저널**(같은 benchId · 영역 통째 복사)이 재준비 적격으로
   * 통과한다. 권위가 없을수록 더 엄격해야 하고, 대조 기준은 롤백 가능한 매체 밖에 있어야 한다.
   */
  readonly identity: BenchAuthorityIdentity
  readonly authority: AuthorityObservation
  /** 접두 `refs/fleet/integrated/<benchId>/` 열거. */
  readonly prefixRefs: RefObservation
  /**
   * **정확 이름** `refs/fleet/integrated/<benchId>` 질의(계획 정정 157 · 실측). 접두 질의는 bare 부모를
   * **0건**으로 답하므로 접두만 쓰면 D/F 충돌 bench 가 「발행된 ref 없음」과 구분되지 않아 최우선
   * 분기가 **도달 불가**가 된다. ⚠ 이 질의는 자식 ref 도 함께 답하므로 **이름이 정확히 같은 항목만** 본다.
   */
  readonly exactRefs: RefObservation
  readonly journal: JournalObservation
}

/* ================================================================================================
 * 판정 출력 — 어휘는 **kebab 통일**(계획 정정 141)
 * ============================================================================================= */

export type RecoveryBlockerKind =
  /** 최우선 fail-closed — 다른 사유에 가려지지 않도록 목록의 **맨 앞**에 온다. */
  | 'ref-namespace-conflict'
  | 'ref-enumeration-failed'
  | 'ref-syntax-invalid'
  | 'ref-foreign-bench'
  | 'authority-unreadable'
  | 'authority-identity-mismatch'
  | 'journal-enumeration-failed'
  | 'journal-unreadable'
  | 'journal-identity-mismatch'
  /** 권위가 저널보다 앞섰다 — WAL 선기록 위반(저널 단독 롤백·손상). */
  | 'journal-behind-authority'
  /** 저널이 권위보다 두 단계 이상 앞섰다 — 정정 204 불변식 ① 위반. */
  | 'journal-too-far-ahead'
  /** stage 는 맞는데 revision·결과 증거·세대·draft 결속이 어긋났다(같은 단계 손상 쌍). */
  | 'journal-authority-binding'
  /** 저널이 든 `resultRef` 이름 자체가 문법·bench·txn·revision 결속을 깬다(git ref 유무와 무관). */
  | 'journal-result-ref-invalid'
  /** 활성·진행 stage 인데 종결 증거(`abandonedAt`·`abandonReason`)를 들고 있다(모순 레코드). */
  | 'journal-terminal-evidence'
  /** 설명되지 않는 `refRevision > record.revision` — 앵커 발화. */
  | 'anchor-rollback'
  | 'result-ref-mismatch'
  /** ref 발행 이후의 상태(post-CAS composed·published·finalized)인데 그 ref 가 없다. */
  | 'result-ref-missing'
  // ⚠ `expected-revision-mismatch` 는 blocker 종별에서 **삭제**했다(로컬 적대 리뷰 P3 · 정정 234) —
  //    생산자가 0 이었고, 진단은 `anchor-rollback.reasons` 가 진다. 같은 파일이 `arithmetic-binding` 을
  //    지운 잣대를 여기에도 적용한다.
  | 'current-txn-journal-missing'
  /** 완결 귀속 txn 의 저널이 `finalized` 가 아니다(활성·published·abandoned 전부 손상 증거). */
  | 'completed-txn-journal-unfinalized'
  | 'orphan-active-journal'

/** 앵커 후보가 **면제**에 실패한 조건(계획 정정 199ⓒ). 전수를 싣는다 — 첫 사유만 남기면 진단이 좁아진다. */
export type ExemptionFailure =
  | 'authority-unavailable'
  | 'journal-missing'
  | 'stage-not-composed'
  | 'terminal-evidence-present'
  | 'ref-name-mismatch'
  | 'oid-mismatch'
  // ⚠ `arithmetic-binding` 은 **폐기**했다(Codex PR#289 4R P1 의 연쇄) — ③ 저널 검증이 `composed`
  //    저널의 `resultRef` 이름에 `= expected + 1` 을 강제하고 ④ 가 관측 ref 를 그 이름에 묶으므로
  //    이 자리의 산술 재검사는 **생산자가 없다**. 어휘만 남기면 「검사한다」로 읽힌다.
  | 'expected-revision-mismatch'
  | 'stage-binding-mismatch'
  | 'transition-illegal'
  | 'digest-mismatch'

export interface RecoveryBlocker {
  readonly kind: RecoveryBlockerKind
  /** 앵커 후보의 면제 실패 사유 전수. 다른 종별에서는 빈 배열이다. */
  readonly reasons: readonly ExemptionFailure[]
  /** 진단 앵커(ref 이름 · txnId · 관측 단서). **판정 동치성에 쓰지 않는다.** */
  readonly subject: string
}

/**
 * ⑦⑧ 이 재검증할 **봉인된 증거**. 소비자는 락·리스 아래에서 다시 관측해 `classifyRecovery` 를 돌리고,
 * 여전히 `resume-composed-cas` 이며 `isSameRecoveryEvidence` 가 참일 때만 CAS 한다(§3-T81·T92).
 */
export interface ResumeEvidence {
  readonly txnId: string
  readonly refName: string
  readonly resultOid: string
  readonly expectedAuthorityRevision: number
  readonly resultingRevision: number
  /** 관측 전체(권위 revision · ref 집합 · 저널 결속)의 봉인. 하나라도 바뀌면 값이 바뀐다. */
  readonly evidenceDigest: string
}

export type RecoveryVerdict =
  /** 포기·재준비 적격. 디스크에 되돌릴 것도 이어갈 것도 없다. */
  | { readonly kind: 'no-mutation' }
  /** 차단 아님(C6) — 정상 진행 중이거나 이미 반영된 상태다. */
  | { readonly kind: 'normal-wait' }
  /** `finalized`·`abandoned` 잔존의 **멱등 종결**(삭제 아님 · §W-7 「복구 중 삭제 금지」). */
  | { readonly kind: 'idempotent-cleanup' }
  /**
   * 저널이 **이미 선기록한 `composed` 권위 CAS** 를 재개한다.
   *
   * ⚠ 이름이 계약이다(계획 정정 203). 폐기된 `promote-published` 는 「composed CAS 를 **건너뛰고**
   * 곧바로 published 권위를 기록」하는 구현도 이름상 허용해 결속 필드를 통째로 무력화했다.
   */
  | { readonly kind: 'resume-composed-cas'; readonly resume: ResumeEvidence }
  | { readonly kind: 'reconciliation-required'; readonly blockers: readonly RecoveryBlocker[] }

/* ================================================================================================
 * 내부 표현
 * ============================================================================================= */

interface ParsedRef {
  readonly refName: string
  readonly oid: string
  readonly resultingRevision: number
  readonly txnId: string
}

const blocker = (
  kind: RecoveryBlockerKind,
  subject: string,
  reasons: readonly ExemptionFailure[] = [],
): RecoveryBlocker => ({ kind, reasons, subject })

/**
 * 전수화 강제 — **이 모듈 전용**이다(형제 `authority.ts` 와 같은 근거). 공용 `assertNever` 는
 * `Unhandled ContentBlock variant: …` 를 던져 복구 판정에서 발화하면 진단이 **엉뚱한 층**을 가리킨다.
 * eslint `no-restricted-syntax` selector 가 `assertNever` **이름**을 요구하므로 이름은 유지한다.
 */
function assertNever(x: never): never {
  throw new Error(`복구 판정: 미처리 판별 종별 ${JSON.stringify(x)}`)
}

/** 권위 레코드에서 CAS 가 배정한 두 필드를 떼어낸 **draft 투영**. `draftDigest` 대조의 정의역이다. */
const toDraft = (record: BenchAuthorityRecord): BenchAuthorityDraft => {
  const { revision: _revision, writtenBy: _writtenBy, ...rest } = record
  return rest as BenchAuthorityDraft
}

/**
 * 후속 CAS 가 제출할 draft 의 **재구성**(면제 조건 ⑧ 을 **전 stage 로 일반화** · Codex PR#289 6R P1).
 * 현재 권위 레코드 위에 저널이 선기록한 의도를 얹는다 — `nextAuthorityStage` 부재는 **포기**이므로
 * 통합 4필드를 소거한다(계획 정정 177).
 */
const reconstructNextDraft = (
  record: BenchAuthorityRecord,
  journal: IntegrationTxnRecord,
): BenchAuthorityDraft => {
  const base = toDraft(record)
  if (journal.nextAuthorityStage === undefined) {
    const {
      currentIntegrationTxnId: _t,
      currentIntegrationStage: _s,
      currentIntegrationTxnGeneration: _g,
      currentIntegrationResultOid: _o,
      ...cleared
    } = base
    return cleared as BenchAuthorityDraft
  }
  return {
    ...base,
    currentIntegrationTxnId: journal.txnId,
    currentIntegrationStage: journal.nextAuthorityStage,
    currentIntegrationTxnGeneration: journal.integrationGeneration,
    ...(journal.resultOid === undefined ? {} : { currentIntegrationResultOid: journal.resultOid }),
  } as BenchAuthorityDraft
}

/**
 * 면제 조건 ①~⑨ 의 **전수 평가**(⑩ 은 아래 `classifyRecovery` 가 「통과 후보가 정확히 하나」로 본다).
 *
 * ⚠ **면제 판정의 입력을 권위 파일 하나로 좁히지 않는다**(계획 정정 199ⓐ · §3-T89). 「현재 txn 이니
 * 면제」는 T1 완료 → 권위가 T2 로 전진 → 파일 롤백으로 current 가 **다시 T1** 인 사슬에서 **롤백을
 * 증명하는 가장 높은 ref 를 바로 그 이유로 숨긴다.** 면제는 독립 매체 두 개(ref + 저널)의 교차검증으로만
 * 서고, 「그 txn 이 현재 txn 인가」는 별도 조건이 아니라 **전이 불변식 계층**(§3-T82)이 답한다.
 */
const evaluateExemption = (
  ref: ParsedRef,
  record: BenchAuthorityRecord | undefined,
  journals: ReadonlyMap<string, IntegrationTxnRecord>,
): readonly ExemptionFailure[] => {
  if (record === undefined) return ['authority-unavailable']
  const j = journals.get(ref.txnId)
  if (j === undefined) return ['journal-missing'] // ① 대응 저널 존재 · ② 런타임 검증 통과

  const failures: ExemptionFailure[] = []
  if (j.stage !== 'composed') failures.push('stage-not-composed') // ③
  // ⑨ 종결 증거 — **여기서 보지 않는다**(로컬 적대 리뷰 P3 · 정정 234).
  //    ⓐ`abandonedAt`·`abandonReason` 은 ③ 저널 검증이 **admitted 전수**에 본다(6R 정정 229).
  //    ⓑ`publishedAt` 은 `prepared`·`composed` 에서 **형태 층이 이미 거부**한다 —
  //       `journal.ts` 의 「stage=… 인데 publishedAt 이 있다(게시 전 게시 시각)」 규칙(T71 · Codex
  //       PR#269 6R). 그래서 `stage === 'composed'` 전제 위에서 그 값을 든 관측은 **표현 불가**이고,
  //       다른 stage 후보에서는 ③ 의 `stage-not-composed` 와 **항상 동반**으로만 실렸다.
  //    측정 결과 이 줄을 지워도 어떤 판정도 바뀌지 않았다 → `arithmetic-binding` 과 같은 처분.
  if (j.resultRef !== ref.refName) failures.push('ref-name-mismatch') // ④
  if (j.resultOid !== ref.oid) failures.push('oid-mismatch') // ⑤
  // ⑥ 산술 결속(`refRevision === expected + 1`)은 **여기 없다** — ③ 저널 검증이 `composed` 저널의
  //    `resultRef` **이름 자체**에 그 등식을 이미 강제하고, ④ 가 관측 ref 이름을 그것과 동일하게
  //    묶으므로 이 자리의 재검사는 **완전히 가려진다**(뮤테이션으로 확인 · 정정 189·183 의 규율).
  //    강제자가 사라지면 이름 검증 쪽이 RED 가 된다.
  if (j.expectedAuthorityRevision !== record.revision) failures.push('expected-revision-mismatch') // ⑦

  // ⑧ 결속 4필드가 **현재 권위에서 재구성되는 후속 전이**와 일치하는가.
  if (
    j.previousAuthorityStage !== record.currentIntegrationStage ||
    j.nextAuthorityStage !== 'composed' ||
    j.integrationGeneration !== record.currentIntegrationTxnGeneration
  ) {
    failures.push('stage-binding-mismatch')
  }
  const draft = reconstructNextDraft(record, j)
  if (checkTransitionInvariants(record, draft).length > 0) failures.push('transition-illegal')
  if (digestAuthorityDraft(draft) !== j.draftDigest) failures.push('digest-mismatch')

  return failures
}

/** 관측 전체의 봉인. 순서 의존을 없애려고 ref 집합은 **정렬해** 싣는다. */
const sealEvidence = (
  benchId: string,
  refs: readonly ParsedRef[],
  ref: ParsedRef,
  journal: IntegrationTxnRecord,
): string => {
  const parts = [
    'fleet-recovery-evidence/1',
    benchId,
    // ⚠ `observedRevision` 은 **싣지 않는다**(로컬 적대 리뷰 P3 · 정정 234): 면제가 성립한 관측은
    //   면제 조건 ⑦ 이 `expected === record.revision` 을 강제하고 그 `expected` 는 아래
    //   `digestJournalRecord` 가 이미 덮는다 — 측정에서도 제거가 어떤 테스트도 깨지 않았다.
    ref.refName,
    ref.oid,
    ref.txnId,
    String(journal.expectedAuthorityRevision),
    // ⚠ `draftDigest` 는 **권위 draft 투영**만 덮는다(Codex PR#289 4R P1). 저널의 통합 입력
    //    (`sourceSnapshot`·`targetBranch`·`targetHeadBeforeIntegration`·`resultTree` …)은 그 투영 밖이라,
    //    그것만 실으면 **바뀐 통합 의도가 같은 증거로** 재검증을 통과한다. 레코드 **전체**를 봉인한다.
    digestJournalRecord(journal),
    ...refs.map((r) => `${r.refName} ${r.oid}`).sort(),
  ]
  // 구분자는 **필드 경계**다 — 붙여 이으면 `["ab","c"]` 와 `["a","bc"]` 가 같은 다이제스트를 낸다.
  // ⚠ 정직 표기(측정): 이 구분자를 제거해도 **테스트가 잡지 못한다.** 봉인에 실리는 값이 전부 고정
  //   길이·고정 문법(ULID 26 · OID 40 hex · sha256 64 hex · `refs/…` 접두)이라 유효 입력으로는 경계
  //   충돌을 **구성할 수 없다** — 즉 이 방어는 미래에 가변 길이 필드가 추가될 때를 위한 것이고 현재
  //   독립 반증력은 0 이다. 어휘·검사를 삭제하지 않는 이유는 그 추가가 **조용히** 일어나기 때문이다.
  // ref 이름·OID·다이제스트 어디에도 나타날 수 없는 C0 제어문자를 쓰되 **이스케이프 표기로 적는다** —
  // raw 제어문자는 소스에서 보이지 않고, 이 PR 이 실제로 그 오염을 두 번 만들었다(U+0000 · U+0001).
  return createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex')
}

/** ⑦ 재검증의 판정 계층 — 「같은 증거인가」는 봉인값의 동치다. */
export function isSameRecoveryEvidence(a: ResumeEvidence, b: ResumeEvidence): boolean {
  return a.evidenceDigest === b.evidenceDigest
}

/* ================================================================================================
 * 판정
 * ============================================================================================= */

export function classifyRecovery(obs: RecoveryObservation): RecoveryVerdict {
  /** 최우선 종별 전용 버킷 — 다른 사유와 같은 배열에 섞으면 순서가 우연에 맡겨진다. */
  const conflicts: RecoveryBlocker[] = []
  const blockers: RecoveryBlocker[] = []

  // ① 권위 fresh read. **부재는 revision `0`** 이고 「판정 없음」이 아니다.
  const record = obs.authority.kind === 'found' ? obs.authority.record : undefined
  const observedRevision = record?.revision ?? 0
  if (obs.authority.kind === 'unreadable') {
    blockers.push(blocker('authority-unreadable', obs.authority.detail ?? 'authority'))
  }
  if (
    record !== undefined &&
    (record.identity.benchId !== obs.identity.benchId ||
      record.identity.commonGitDir !== obs.identity.commonGitDir ||
      record.identity.benchRoot !== obs.identity.benchRoot)
  ) {
    blockers.push(blocker('authority-identity-mismatch', record.identity.benchId))
  }

  // ② 결과 ref 전수 열거·문법·identity. 정확 이름 질의는 **이름이 정확히 같은 항목만** 본다.
  const bare = `${RESULT_REF_ROOT}/${obs.identity.benchId}`
  if (obs.exactRefs.kind === 'failed') {
    blockers.push(blocker('ref-enumeration-failed', obs.exactRefs.detail ?? 'exact'))
  } else if (obs.exactRefs.refs.some((r) => r.ref === bare)) {
    conflicts.push(blocker('ref-namespace-conflict', bare))
  }

  const parsedRefs: ParsedRef[] = []
  if (obs.prefixRefs.kind === 'failed') {
    blockers.push(blocker('ref-enumeration-failed', obs.prefixRefs.detail ?? 'prefix'))
  } else {
    for (const entry of obs.prefixRefs.refs) {
      const parsed = parseResultRef(entry.ref)
      switch (parsed.kind) {
        case 'ok':
          if (parsed.benchId !== obs.identity.benchId) {
            blockers.push(blocker('ref-foreign-bench', entry.ref))
            break
          }
          parsedRefs.push({
            refName: entry.ref,
            oid: entry.oid,
            resultingRevision: parsed.resultingRevision,
            txnId: parsed.txnId,
          })
          break
        case 'namespace-conflict':
          conflicts.push(blocker('ref-namespace-conflict', entry.ref))
          break
        case 'invalid':
          // 문법 위반을 **무시하지 않는다** — 「해석할 수 없는 이름」은 「없음」이 아니다(§3-T78).
          blockers.push(blocker('ref-syntax-invalid', entry.ref))
          break
        default:
          assertNever(parsed)
      }
    }
  }

  // ③ 저널 전수 열거·schemaVersion·identity. 읽기 실패·버전 스큐는 **각각 다른 사실**로 남는다.
  const journals = new Map<string, IntegrationTxnRecord>()
  if (obs.journal.kind === 'failed') {
    blockers.push(blocker('journal-enumeration-failed', obs.journal.detail ?? 'journal'))
  } else {
    for (const entry of obs.journal.entries) {
      if (entry.read.kind !== 'found') {
        blockers.push(blocker('journal-unreadable', `${entry.txnId}:${entry.read.kind}`))
        continue
      }
      const j = entry.read.record
      // ⚠ 대조 기준은 **관측자가 실어온 identity** 다 — 권위 레코드가 아니다(Codex PR#289 P1).
      // 권위에서 가져오면 권위 부재·손상 시 대조가 통째로 사라진다.
      const identityOk =
        j.txnId === entry.txnId &&
        j.benchId === obs.identity.benchId &&
        j.repoCommonGitDir === obs.identity.commonGitDir &&
        j.benchRoot === obs.identity.benchRoot
      if (!identityOk) {
        blockers.push(blocker('journal-identity-mismatch', entry.txnId))
        continue
      }
      // **저널이 든 `resultRef` 이름 자체를 검증한다**(Codex PR#289 4R P1). PR3b 는 「비어 있지 않은
      // 문자열」까지만 봤고 문법 소유가 이 PR 로 넘어왔는데, 초안은 **관측된 git ref** 만 파싱하고
      // 저널이 든 이름은 한 번도 보지 않았다 — 그 값은 **불변 필드**라, 아직 ref 가 없는 `prepared`
      // 저널의 잘못된 이름이 `no-mutation` 을 타고 살아남아 나중에 **그대로 발행**된다.
      const named = parseResultRef(j.resultRef)
      const nameBound =
        named.kind === 'ok' && named.benchId === obs.identity.benchId && named.txnId === j.txnId
      // **revision 산술은 stage 마다 다르지만 stage 전수에 고정된다**(Codex PR#289 5R P1 이 4R 의
      // 내 부분 수용을 좁혔다 — 「composed 에서만」이 아니라 **stage 별 정확한 식**이 있다).
      //
      // `resultRef` 는 불변 필드이고 ref 는 **composed CAS 앞**에서 딱 한 번 발행된다. 단계가 전진할
      // 때마다 `expectedAuthorityRevision` 만 `+1` 되므로, 기준 revision 을 `R0`(prepared 저널의
      // expected)라 하면 **ref = R0 + 2** 로 고정이고 `expected = R0 + stageIndex` 다:
      //
      //   prepared(0) → ref = expected + 2 · composed(1) → +1 · published(2) → +0 · finalized(3) → -1
      //
      // ⚠ `abandoned` 는 **정의역 밖**이다 — 어느 단계에서 포기했는지에 따라 expected 가 달라져 식이
      //    하나로 고정되지 않는다(포기 시점의 관측 revision 을 싣는다).
      // **종결 증거는 모든 admitted 저널에서 본다**(Codex PR#289 6R P1). 초안은 이 검사를 **앵커
      // 면제 평가 안에만** 뒀는데, post-CAS `composed` 저널의 ref 는 revision 이 권위와 같아 후보가
      // 되지 않으므로 그 경로에 **영영 도달하지 않는다** — `abandonedAt`·`abandonReason` 을 든 채
      // `normal-wait` 이 나왔다. 파서는 그 필드를 abandoned 밖에서도 허용하므로 여기서 형태로 막는다.
      const terminalEvidence =
        j.stage !== 'abandoned' && (j.abandonedAt !== undefined || j.abandonReason !== undefined)
      // ⚠ **`finalized` 는 등식이 아니라 상한이다**(로컬 적대 리뷰 P1 · 정정 233). `prepared`·
      //   `composed`·`published` 저널은 **창이 닫힌 동안**(활성 저널 = 실행 차단) 기록되므로 단계마다
      //   revision 이 정확히 +1 이고 등식이 성립한다. 그런데 `finalized` 저널은 **외부 소비자 머지 관측
      //   이후**에 기록되고 그 사이의 활동·회수·보관 CAS 가 `expected` 를 올리므로, 불변 필드인
      //   `resultRef` 의 revision 은 `expected` **이하**로만 보장된다.
      const stageIndex = WAL_STAGE_ORDER.indexOf(j.stage)
      const revisionBound =
        stageIndex < 0 ||
        (named.kind === 'ok' &&
          (j.stage === 'finalized'
            ? named.resultingRevision <= j.expectedAuthorityRevision
            : named.resultingRevision === j.expectedAuthorityRevision + 2 - stageIndex))
      if (!nameBound || !revisionBound) {
        blockers.push(blocker('journal-result-ref-invalid', entry.txnId))
        continue
      }
      if (terminalEvidence) {
        blockers.push(blocker('journal-terminal-evidence', entry.txnId))
        continue
      }
      journals.set(j.txnId, j)
    }
  }

  // ④⑤ ref↔저널 설명 관계 분류 → anchor gate. **현재 이하의 ref 는 정상 보존**이다(§3-T76·T90).
  const candidates = parsedRefs.filter((r) => r.resultingRevision > observedRevision)
  const evaluated = candidates.map((ref) => ({
    ref,
    reasons: evaluateExemption(ref, record, journals),
  }))
  const promotable = evaluated.filter((c) => c.reasons.length === 0)
  // **정확히 하나**(조건 ⑩)일 때만 면제한다. `0` 과 `≥2` 는 같은 처분 — 후보 전부가 blocker 다.
  //
  // ⚠ **정직 표기(뮤테이션 자기검사 실측)**: 이 `=== 1` 을 `>= 1` 로 바꿔도 **테스트가 잡지 못한다.**
  // 조건 ⑧(전이 불변식)이 「composed 는 새 txn 을 시작할 수 없다」를 강제하므로 통과 후보는 **현재 txn
  // 하나**로 이미 좁혀져 `≥2` 가 도달 불가이기 때문이다. 그래도 남겨 두는 이유는 조건 ⑩ 이 승인된 계약
  // 조항(계획 정정 199ⓒ)이고, ⑧ 이 약해지는 미래 편집에서 **이 줄이 마지막 방어**가 되기 때문이다 —
  // 대신 「이 PR 에서 독립 반증력 0」임을 숨기지 않는다. 복수 주장(§3-T88)의 **관측 가능한** 계약은
  // 이 줄이 아니라 「면제되지 않은 모든 후보가 blocker」라는 아래 루프가 진다.
  const exempt = promotable.length === 1 ? promotable[0]?.ref : undefined
  for (const c of evaluated) {
    if (c.ref !== exempt) blockers.push(blocker('anchor-rollback', c.ref.refName, c.reasons))
  }

  // ⑥ 귀속. 정의역은 **현재 txn 1건**이고, 권위가 가리키지 않는 활성 엔트리는 고아 저널이다.
  const currentTxnId = record?.currentIntegrationTxnId
  const current = currentTxnId === undefined ? undefined : journals.get(currentTxnId)
  // WAL 은 **선기록**이다 — 권위가 가리키는 txn 에 저널이 없다는 것은 매체 하나가 사라졌다는 뜻이다.
  // ⚠ 열거 자체가 실패했을 때는 발화하지 않는다(그 사실은 이미 `journal-enumeration-failed` 다).
  if (obs.journal.kind === 'ok' && currentTxnId !== undefined && current === undefined) {
    blockers.push(blocker('current-txn-journal-missing', currentTxnId))
  }
  // **권위 stage ≤ 저널 stage ≤ 권위 stage + 1**(Codex PR#289 P1). 앞의 부등식은 WAL 선기록에서,
  // 뒤의 부등식은 정정 204 불변식 ①(「stage S 의 권위 커밋이 확인되기 전 S+1 저널 기록 금지」)에서
  // 나온다. 초안은 **저널 stage 만 보고 분기**해서, 권위가 앞선 관측(= 저널 단독 롤백·손상)이
  // `no-mutation` 으로 통과했다 — 손상 위에서 포기·재준비가 인가되는 경로였다.
  // ⚠ 저널 `abandoned` 는 종결 기록이라 순서 결속의 정의역 밖이다(포기 CAS 가 pending 일 뿐이다).
  const authorityStage = record?.currentIntegrationStage
  if (current !== undefined && current.stage !== 'abandoned' && authorityStage !== undefined) {
    const jIdx = WAL_STAGE_ORDER.indexOf(current.stage)
    const aIdx = WAL_STAGE_ORDER.indexOf(authorityStage)
    if (aIdx > jIdx) blockers.push(blocker('journal-behind-authority', current.txnId))
    else if (jIdx > aIdx + 1) blockers.push(blocker('journal-too-far-ahead', current.txnId))
  }

  // **stage 가 같아도 결속은 따로 본다**(Codex PR#289 3R P1). 위 검사는 **순서(인덱스)만** 비교하므로
  // 「둘 다 `composed` 인데 `resultOid`·expected revision·세대가 어긋난」 손상 쌍이 그대로 통과해,
  // ref 가 없을 때 복구표가 `no-mutation`(= 포기·재준비 적격)을 답했다. 결속은 **두 배치 중 하나**를
  // 만족해야 한다 — ⓐ**CAS 전**(권위가 아직 `previousAuthorityStage` · `expected === revision`)
  // ⓑ**CAS 후**(권위가 `nextAuthorityStage` · `revision === expected + 1`). 그 외는 전부 손상이다.
  let binding: 'pre-cas' | 'post-cas' | undefined
  if (record !== undefined && current !== undefined) {
    // ⚠ **열린 창에서는 전역 revision·전체 draft 로 결속하지 않는다**(로컬 적대 리뷰 P1 · 정정 233).
    //
    // `revision` 은 **모든 CAS** 가 +1 하는 전역 카운터이고(`authority.ts` 의 유일 배정 지점), 통합
    // 4필드를 보존하는 CAS(활동 시작/종료·gated-orphan 회수·lifecycle 변경)는 전이 검사의 **no-op**
    // 으로 통과한다. 스펙은 그 개입을 **요구**한다 — C6(「`published` 저널은 소비자 완결까지 무기한
    // 열려 있는 정상 상태 … 문자대로 구현하면 모든 integration-ready bench 가 즉시 차단」) ·
    // §3-T33(그 창에서 **실행** 가능) · I8(`archived ∧ integration-ready` 도 정상).
    //
    // ⓐ**닫힌 창**(`prepared`·`composed`)에서는 tight 하게 결속한다 — 그 stage 는 **활성 저널**이라
    //   실행이 차단되고, 복구 판정은 **모든 권위 CAS 보다 먼저** 돈다(정정 197ⓐ). 그래서 저널 선기록과
    //   그 CAS 사이에 개입 CAS 가 들어올 수 없고, `resultRef` 가 prepare 시점에 revision 을 실을 수
    //   있다는 정정 196 의 전제도 이 사실 위에 선다.
    // ⓑ**열린 창**(`published`·`finalized`)의 **post-CAS** 는 방향으로만 결속한다 — 그 CAS 가 커밋된
    //   뒤로는 개입이 정상이므로 `revision === expected + 1` 은 정상 상태를 손상으로 오분류한다.
    // ⓒ그 창의 **draft 전체 digest 대조는 폐기**한다(정직 표기): 4R 정정 218 이 그것으로 잡으려던
    //   「`lifecycle`·`sourceGeneration`·`activeActivity` 롤백」은 무기한 창에서 **정상 변화와 구분
    //   불가**다. 그 자리에는 통합 축 결속(txn·stage·세대·`resultOid`)과 앵커만 남는다.
    const openWindow = current.stage === 'published' || current.stage === 'finalized'
    const preCas =
      record.currentIntegrationStage === current.previousAuthorityStage &&
      current.expectedAuthorityRevision === record.revision
    const postCas =
      record.currentIntegrationStage === current.nextAuthorityStage &&
      (openWindow
        ? record.revision >= current.expectedAuthorityRevision + 1
        : record.revision === current.expectedAuthorityRevision + 1)
    // CAS 가 이미 커밋됐다면 권위는 저널이 증언한 **그 결과**를 들고 있어야 하고, **draft 전체**가
    // 저널이 선기록한 의도와 같아야 한다(Codex PR#289 4R P1). stage·revision·세대·resultOid 만 보면
    // `lifecycle`·`sourceGeneration`·`activeActivity` 처럼 **draft 투영 안의 나머지 필드**가 롤백·손상
    // 돼도 통과해, 결과 ref 까지 맞는 상태에서 `normal-wait` 이 나온다. `draftDigest` 는 저널이 이미
    // 들고 있는 값이므로 **추가 입력 없이** 그 구멍을 닫는다.
    // **pre-CAS 도 결과·draft 결속을 본다**(Codex PR#289 6R P1). 초안은 `!postCas` 가지에서 **세대만**
    // 봐서, 「결과 A 를 든 composed 권위 + 결과 B 를 든 published 저널·같은 revision ref」가 순서·산술·
    // ref 대조를 전부 통과해 `normal-wait` 이 나왔다 — **같은 txn 이 불변 결과를 갈아치운** 것이다.
    // ⓐ**결과 상속**: 권위가 이미 든 결과가 있으면 저널의 증언과 같아야 한다(둘 다 있을 때)
    // ⓑ**draft 결속**: post-CAS 는 권위 draft 투영 자체를, pre-CAS 는 **저널이 낼 다음 draft 의
    //   재구성**을 `draftDigest` 와 대조한다(면제 조건 ⑧ 을 전 stage 로 일반화한 것이다).
    const draftBound =
      openWindow && postCas
        ? true // ⓒ — 폐기 근거는 위 주석. 통합 축은 아래 `resultInherited`·세대·stage 가 계속 진다.
        : postCas
          ? digestAuthorityDraft(toDraft(record)) === current.draftDigest
          : digestAuthorityDraft(reconstructNextDraft(record, current)) === current.draftDigest
    const resultInherited =
      record.currentIntegrationResultOid === undefined ||
      current.resultOid === undefined ||
      record.currentIntegrationResultOid === current.resultOid
    const evidenceOk =
      record.currentIntegrationTxnGeneration === current.integrationGeneration &&
      resultInherited &&
      draftBound
    if ((!preCas && !postCas) || !evidenceOk) {
      blockers.push(blocker('journal-authority-binding', current.txnId))
    } else {
      binding = postCas ? 'post-cas' : 'pre-cas'
    }
  }

  // 미종결 txn 이 있으면 **새 txn 의 저널 자체가 쓰이지 말았어야 한다**(전이 불변식이 그 시작을
  // 금지한다). 그래서 benign 창은 「권위에 pending 통합이 없을 때」에만 열린다(Codex PR#289 P1).
  // **현재 txn 의 ref 는 stage·경로와 무관하게 저널의 증언과 같아야 한다**(Codex PR#289 4R P1 +
  // 로컬 적대 리뷰 P2 · 정정 235). 4R 은 이 대조를 「표 앞」으로 올렸는데 그 「앞」이 **면제 반환 뒤**
  // 였다 — 승격(`resume-composed-cas`) 경로에서만 같은 txn 의 여분·손상 ref 가 무검사로 통과했고,
  // 그 상태가 `sealEvidence` 봉인에 실려 **손상이 정당한 증거로 고정**됐다. blocker 수집 구간으로
  // 올려 「한 곳에서만 판정한다」를 실제로 만족시킨다(T80 blocker 지배와도 통일).
  // ⚠ OID 대조는 **저널이 결과를 증언할 때만** 성립한다 — `prepared` 는 `resultOid` 가 아직 없다.
  if (current !== undefined) {
    for (const r of parsedRefs.filter((x) => x.txnId === current.txnId)) {
      if (
        r.refName !== current.resultRef ||
        (current.resultOid !== undefined && r.oid !== current.resultOid)
      ) {
        blockers.push(blocker('result-ref-mismatch', r.refName))
      }
    }
  }

  const authorityPending = authorityStage !== undefined && authorityStage !== 'finalized'

  // ⚠ **완결 귀속 검사는 활성 게이트 밖이다**(로컬 적대 리뷰 P3 · 정정 234). 스펙 §W-7 은 「완결된
  // txn 의 저널은 정상 상태에서 `finalized` 다」인데, 초안은 이 검사를 **활성 stage 루프 안**에 둬서
  // 그 txn 의 저널이 `published`·`abandoned` 로 남은 경우를 놓쳤다 — 6R 정정 229 가 지적한 「검사의
  // 위치가 곧 정의역」의 같은 형태다. 종별도 그 사실에 맞춰 개명한다.
  const completedTxnId = record?.completedIntegrationTxnId
  if (completedTxnId !== undefined) {
    const completedJournal = journals.get(completedTxnId)
    if (completedJournal !== undefined && completedJournal.stage !== 'finalized') {
      blockers.push(blocker('completed-txn-journal-unfinalized', completedTxnId))
    }
  }

  for (const j of journals.values()) {
    if (!isActiveJournalStage(j.stage)) continue
    if (j.txnId === currentTxnId || j.txnId === completedTxnId) continue
    // (A) 프로토콜상 **정상 크래시 창은 하나뿐**이다 — 저널 선기록 후 `prepared` CAS 전. 그 창의
    // 엔트리는 결과 ref 를 가질 수 없으므로, ref 를 동반한 고아·`composed` 고아는 전부 reconciliation 이다
    // (계획 정정 194 의 2분 — 활성 집합의 **정의**는 stage 단독으로 유지한다).
    // ⚠ **종결 bench 에는 benign 창이 없다**(Codex PR#289 6R P1): `integrated`·`archived` 권위는
    //   current txn 이 없어 `authorityPending` 이 거짓이지만, 그 위에서는 새 txn 을 **시작할 수 없으므로**
    //   (전이 불변식) 그 저널이 애초에 쓰일 수 없었다. stage 의 pending 여부만 보면 그 사실을 놓친다.
    const benign =
      j.stage === 'prepared' &&
      !authorityPending &&
      record?.lifecycle === 'open' &&
      !parsedRefs.some((r) => r.txnId === j.txnId)
    if (!benign) blockers.push(blocker('orphan-active-journal', j.txnId))
  }

  if (conflicts.length > 0 || blockers.length > 0) {
    return { kind: 'reconciliation-required', blockers: [...conflicts, ...blockers] }
  }

  if (exempt !== undefined) {
    const j = journals.get(exempt.txnId)
    // 면제가 성립했다는 것은 저널이 있다는 뜻이다(조건 ①). 타입 폭을 좁히는 것 이상은 하지 않는다.
    if (j !== undefined) {
      return {
        kind: 'resume-composed-cas',
        resume: {
          txnId: exempt.txnId,
          refName: exempt.refName,
          resultOid: exempt.oid,
          expectedAuthorityRevision: j.expectedAuthorityRevision,
          resultingRevision: exempt.resultingRevision,
          evidenceDigest: sealEvidence(obs.identity.benchId, parsedRefs, exempt, j),
        },
      }
    }
  }

  // 현재 txn 이 없으면(또는 권위 자체가 없으면) 복구표의 정의역이 비어 있다 = 무변이 적격.
  if (record === undefined || current === undefined) return { kind: 'no-mutation' }

  const ownRefs = parsedRefs.filter((r) => r.txnId === current.txnId)

  // **ref 발행 이후의 상태는 ref 를 요구한다**(Codex PR#289 5R P1). 발행은 composed CAS **앞**이므로
  // ⓐpost-CAS composed ⓑ`published` ⓒ`finalized` 에서 ref 가 **사라진 것**은 프로토콜상 불가능하고,
  // 그것을 `no-mutation`(= 포기·재준비 적격)으로 답하면 **ref 롤백·손상이 그대로 숨는다**.
  // ⚠ `abandoned` 는 제외한다 — `prepared` 에서 포기하면 ref 는 애초에 존재한 적이 없다.
  // ⚠ `abandoned` 를 **통째로** 면제하면 안 된다(Codex PR#289 6R P1): `previousAuthorityStage` 가
  //   `composed` 이상인 포기는 **이미 ref 가 발행된 뒤**라 그 부재는 손상이고, 청소 CAS 가 남은 통합
  //   상태를 지우면서 **사라진 불변 결과를 숨긴다**. 면제는 「`prepared` 에서의 포기」에만 준다.
  // ⚠ 조건은 **하나**다(로컬 적대 리뷰 P2 · 정정 234): 증거 동결(`journal.ts` `EVIDENCE_FIELDS`)상
  //   `previousAuthorityStage` 가 `composed` 이상이면 `resultOid` 존재가 **함의**되므로, 두 조건을
  //   `||` 로 두면 둘을 분리 반증하는 **합법 픽스처가 존재하지 않는다**(측정: 어느 쪽을 지워도 초록).
  const abandonedAfterCompose = current.stage === 'abandoned' && current.resultOid !== undefined
  const refRequired =
    current.stage === 'published' ||
    current.stage === 'finalized' ||
    abandonedAfterCompose ||
    (current.stage === 'composed' && binding === 'post-cas')
  if (refRequired && ownRefs.length === 0) {
    return {
      kind: 'reconciliation-required',
      blockers: [blocker('result-ref-missing', current.resultRef)],
    }
  }

  switch (current.stage) {
    case 'prepared':
      // (A) 에서 결과 ref 는 **composed 저널 뒤**에만 발행된다 — `prepared` 상태의 ref 는 설명되지 않는다.
      //
      // ⚠ 그 상태를 위한 **전용 arm 은 두지 않는다**(도달 불가 · Codex PR#289 5R 의 연쇄): `prepared`
      //   저널이 현재 txn 을 가리키려면 결속이 post-CAS 여야 하고(`revision = expected + 1`), 그 저널의
      //   ref 는 `expected + 2 = revision + 1` 이라 **항상 앵커 후보**다. 이름이 다르면 그건 위의
      //   mismatch 축이 답한다. 복구표가 요구하는 **결과**(reconciliation)는 앵커가 그대로 보장한다.
      return { kind: 'no-mutation' }
    case 'composed':
      // ref 발행 전(pre-CAS) 크래시 = 되돌릴 것이 없다. 그 외는 **완료 확인**이다(정정 204ⓑ).
      //
      // ⚠ **이름·OID·산술 대조가 여기 없는 것은 누락이 아니라 배치다**(Codex PR#289 4R P1):
      // ⓐ이름·OID 는 **stage 와 무관하게** 위에서 대조했다(`published` 분기가 그것을 빠뜨렸던 것이
      //   4R 지적이다) ⓑ산술은 **③ 저널 검증**이 `resultRef` 이름 자체에 stage 별 식으로 강제하고
      //   ⓐ 가 관측 ref 를 그 이름에 묶으므로 재검사는 가려진다.
      return ownRefs.length === 0 ? { kind: 'no-mutation' } : { kind: 'normal-wait' }
    case 'published':
      // C6 — `published` 는 활성이 아니고 차단하지 않는다. 다음 단계 전진은 시퀀서의 정상 경로다.
      return { kind: 'normal-wait' }
    case 'finalized':
    case 'abandoned':
      // `finalized`·`abandoned` 잔존 = **멱등 종결**이지 삭제가 아니다(§W-7 「복구 중 삭제 금지」).
      return { kind: 'idempotent-cleanup' }
    default:
      return assertNever(current.stage)
  }
}
