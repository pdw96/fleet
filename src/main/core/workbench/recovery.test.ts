import { describe, expect, it } from 'vitest'

import type { BenchAuthorityDraft, BenchAuthorityRecord } from './authority'
import { digestAuthorityDraft, type IntegrationTxnRecord } from './journal'
import {
  classifyRecovery,
  isSameRecoveryEvidence,
  type RecoveryObservation,
  type RecoveryVerdict,
} from './recovery'
import { formatResultRef } from './result-ref'

/**
 * §3-T73~T94 — **복구 판정 순수 함수**(#251 PR3c · 스펙 §W-7 「복구 판정」).
 *
 * 이 파일이 고정하는 것은 **계층**이다. 복구표는 first-match 표가 **아니고**(계획 정정 150ⓐ·197ⓑ),
 * 앵커 게이트가 승격 판정보다 **먼저** 답한다 — 순서를 뒤집으면 롤백된 stage 위에서 승격한다.
 *
 * ⚠ **행동 단언은 여기 없다**(정직 표기 · 계획 정정 137 의 규율): 「복구기가 인가를 막는다」(T80)·
 * 「변이가 게이트 뒤에 0건」(T91)·「CAS 후 revision 일치」(T93)·「CAS 실패 시 ref 보존」(T94)·
 * 「락 아래 fresh 재검증」(T81·T92)의 **행동** 연언은 생산자(PR5 시퀀서 · PR7 부팅)가 없으므로 이 PR
 * 에서 vacuous 다. 여기서 세우는 것은 그 행동이 **딛고 설** 판정 계층과 증거 봉인 seam 이다.
 */

const BENCH = '01J8Z4T7K9QW3M5N7P9R1S3T5V'
const T1 = '01J8Z4T7K9QW3M5N7P9R1S3T5W'
const T2 = '01J8Z4T7K9QW3M5N7P9R1S3T5X'
const TPREV = '01J8Z4T7K9QW3M5N7P9R1S3T5Y'

const IDENTITY = {
  commonGitDir: '/repo/.git',
  benchRoot: '/repo/../.fleet-wb',
  benchId: BENCH,
} as const

const OID = 'a'.repeat(40)
const OID2 = 'b'.repeat(40)
const TREE = 'c'.repeat(40)

/** 관측된 권위 revision. 결과 ref 는 `N+1`(= 아래 `R0 + 2`)을 이름에 싣는다(계획 정정 223·233). */
const N = 5

/**
 * **프로토콜이 실제로 만들 수 있는 저널**을 만든다(Codex PR#289 5R P1 이후 · 계획 정정 223).
 *
 * `resultRef` 는 불변이고 ref 는 composed CAS **앞**에서 한 번만 발행되므로, `prepared` 저널이 관측한
 * revision 을 `R0` 라 하면 **ref = R0 + 2** 로 고정이고 `expected = R0 + stageIndex` 다. 이 산술을
 * 픽스처마다 손으로 맞추면 **결속상 존재할 수 없는 쌍**이 정상으로 고정된다(4R·5R 에서 실제로 그랬다).
 *
 * 기본 레코드(`revision: N` · current T1 `prepared`)를 만든 저널의 `R0` 는 **`N - 1`** 이다 —
 * `prepared` CAS 가 `R0 → R0+1 = N` 으로 커밋했기 때문이다.
 */
const R0 = N - 1
const STAGE_IDX = { prepared: 0, composed: 1, published: 2, finalized: 3 } as const

const walBound = (stage: keyof typeof STAGE_IDX): Partial<IntegrationTxnRecord> => ({
  stage,
  expectedAuthorityRevision: R0 + STAGE_IDX[stage],
  resultRef: formatResultRef(BENCH, R0 + 2, T1),
  previousAuthorityStage: stage === 'prepared' ? undefined : WAL_ORDER[STAGE_IDX[stage] - 1],
  nextAuthorityStage: stage,
})

const WAL_ORDER = ['prepared', 'composed', 'published', 'finalized'] as const

const record = (over: Partial<BenchAuthorityRecord> = {}): BenchAuthorityRecord =>
  ({
    schemaVersion: 1,
    identity: IDENTITY,
    revision: N,
    lifecycle: 'open',
    sourceGeneration: 3,
    currentIntegrationTxnId: T1,
    currentIntegrationStage: 'prepared',
    currentIntegrationTxnGeneration: 3,
    writtenBy: { ownerToken: 'ow', at: 1, durability: 'file-only' },
    ...over,
  }) as BenchAuthorityRecord

/** 후속 CAS 가 제출할 draft 의 **재구성** — 면제 조건 ⑧ 이 대조하는 바로 그 값이다. */
const composedDraft = (r: BenchAuthorityRecord, txnId = T1, oid = OID): BenchAuthorityDraft => {
  const { revision: _rev, writtenBy: _w, ...rest } = r
  return {
    ...rest,
    currentIntegrationTxnId: txnId,
    currentIntegrationStage: 'composed',
    currentIntegrationTxnGeneration: r.currentIntegrationTxnGeneration,
    currentIntegrationResultOid: oid,
  } as BenchAuthorityDraft
}

/**
 * **post-CAS 픽스처의 draftDigest** — 권위가 이미 저널의 후속 단계를 커밋한 상태에서는 저널이 든
 * digest 가 **그 권위 레코드의 draft 투영**과 같아야 한다(Codex PR#289 4R P1). 이 헬퍼가 없으면
 * 픽스처가 「stage·revision 은 맞는데 draft 는 딴 것」이라는 **존재할 수 없는 쌍**이 된다.
 */
const draftDigestOf = (r: BenchAuthorityRecord): string => {
  const { revision: _rev, writtenBy: _w, ...rest } = r
  return digestAuthorityDraft(rest as BenchAuthorityDraft)
}

/**
 * **pre-CAS 픽스처의 draftDigest** — 저널이 낼 **다음 draft** 의 재구성(Codex PR#289 6R P1 이후
 * 전 stage 로 일반화됐다). `composedDraft` 는 그 특수 경우다.
 */
const nextDraftDigestOf = (
  r: BenchAuthorityRecord,
  stage: 'prepared' | 'composed' | 'published' | 'finalized',
  oid: string = OID,
): string => {
  const { revision: _rev, writtenBy: _w, ...rest } = r
  return digestAuthorityDraft({
    ...rest,
    currentIntegrationTxnId: T1,
    currentIntegrationStage: stage,
    currentIntegrationTxnGeneration: r.currentIntegrationTxnGeneration,
    currentIntegrationResultOid: oid,
  } as BenchAuthorityDraft)
}

/** **포기 CAS 가 제출할 draft** — 통합 4필드 소거(정정 177). pre-CAS 결속이 이것과 대조한다. */
const abandonDraftDigestOf = (r: BenchAuthorityRecord): string => {
  const {
    revision: _rev,
    writtenBy: _w,
    currentIntegrationTxnId: _t,
    currentIntegrationStage: _s,
    currentIntegrationTxnGeneration: _g,
    currentIntegrationResultOid: _o,
    ...rest
  } = r
  return digestAuthorityDraft(rest as BenchAuthorityDraft)
}

const journal = (over: Partial<IntegrationTxnRecord> = {}): IntegrationTxnRecord =>
  ({
    schemaVersion: 1,
    txnId: T1,
    benchId: BENCH,
    repoCommonGitDir: IDENTITY.commonGitDir,
    benchRoot: IDENTITY.benchRoot,
    sourceBranch: 'fleet/bench',
    sourceSnapshot: 'd'.repeat(40),
    sourceGeneration: 3,
    targetBranch: 'main',
    targetHeadBeforeIntegration: 'e'.repeat(40),
    resultRef: formatResultRef(BENCH, N + 1, T1),
    startedAt: 1,
    ownerEngineId: 'eng',
    stage: 'composed',
    resultTree: TREE,
    resultOid: OID,
    expectedAuthorityRevision: N,
    previousAuthorityStage: 'prepared',
    nextAuthorityStage: 'composed',
    integrationGeneration: 3,
    draftDigest: digestAuthorityDraft(composedDraft(record())),
    ...over,
  }) as IntegrationTxnRecord

const obs = (over: Partial<RecoveryObservation> = {}): RecoveryObservation => ({
  identity: IDENTITY,
  authority: { kind: 'found', record: record() },
  prefixRefs: { kind: 'ok', refs: [] },
  exactRefs: { kind: 'ok', refs: [] },
  journal: { kind: 'ok', entries: [] },
  ...over,
})

const entries = (...records: IntegrationTxnRecord[]): RecoveryObservation['journal'] => ({
  kind: 'ok',
  entries: records.map((r) => ({ txnId: r.txnId, read: { kind: 'found', record: r } })),
})

const refs = (
  ...pairs: readonly (readonly [string, string])[]
): RecoveryObservation['prefixRefs'] => ({
  kind: 'ok',
  refs: pairs.map(([ref, oid]) => ({ ref, oid })),
})

const REF_N1 = formatResultRef(BENCH, N + 1, T1)

const kinds = (v: RecoveryVerdict): readonly string[] =>
  v.kind === 'reconciliation-required' ? v.blockers.map((b) => b.kind) : []

const reasons = (v: RecoveryVerdict): readonly string[] =>
  v.kind === 'reconciliation-required' ? v.blockers.flatMap((b) => b.reasons) : []

/* ================================================================================================
 * T83 — 정상 crash window (인터리브 (A) · 계획 정정 202)
 * ============================================================================================= */

describe('T83 — 정상 crash window 는 전역 reconciliation 이 아니다', () => {
  /**
   * 확정 인터리브(계획 3R): ①권위 `N` fresh read → ②전이 불변식 선검증 → ③composed 저널
   * (`expected=N`) acknowledged → ④결과 ref `<N+1>-<txn>` create-only 발행 → ⑤**composed 권위 CAS
   * 직전 crash** → ⑦`권위 N` + `저널 composed expected N` + `matching ref N+1` 관측.
   */
  it('권위 N · composed 저널 expected N · matching ref N+1 → resume-composed-cas', () => {
    const v = classifyRecovery(
      obs({ prefixRefs: refs([REF_N1, OID]), journal: entries(journal()) }),
    )
    expect(v.kind).toBe('resume-composed-cas')
    if (v.kind !== 'resume-composed-cas') return
    expect(v.resume.txnId).toBe(T1)
    expect(v.resume.refName).toBe(REF_N1)
    expect(v.resume.resultOid).toBe(OID)
    expect(v.resume.expectedAuthorityRevision).toBe(N)
    expect(v.resume.resultingRevision).toBe(N + 1)
  })

  it('verdict 이름은 단계성을 보존한다 — 폐기 어휘 promote-published 는 재유입되지 않는다', () => {
    const v = classifyRecovery(
      obs({ prefixRefs: refs([REF_N1, OID]), journal: entries(journal()) }),
    )
    // 「published 권위를 곧바로 기록」하는 구현이 **이름상으로도** 성립하지 않아야 한다(정정 203).
    expect(JSON.stringify(v)).not.toContain('promote-published')
    expect(JSON.stringify(v)).not.toContain('published')
  })
})

/* ================================================================================================
 * T73·T74·T77 — 앵커 발화와 음성 통제
 * ============================================================================================= */

describe('T73 — 앵커 발화(권위 단독 롤백)', () => {
  it('저널이 composed 를 지나 published 인데 권위가 N 이면 롤백이 증명된다 → reconciliation', () => {
    // composed CAS 가 커밋(revision N+1)된 뒤 published 저널이 선기록됐고, 그다음 권위 파일만
    // 이전 세대로 되돌아간 상태. ref `N+1` 은 남아 있으므로 `refRevision > record.revision` 이 참이다.
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(
          journal({
            ...walBound('published'),
            publishedAt: 9,
            expectedAuthorityRevision: N + 1,
            previousAuthorityStage: 'composed',
            nextAuthorityStage: 'published',
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('anchor-rollback')
    expect(reasons(v)).toContain('stage-not-composed')
  })
})

describe('T74 — 음성 통제(오탐 0)', () => {
  it('권위가 이미 N+1 이고 composed 전이를 정확히 반영하면 정상 대기다(재실행 아님 · 정정 204ⓑ)', () => {
    const advanced = record({
      revision: N + 1,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: advanced },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal({ draftDigest: draftDigestOf(advanced) })),
      }),
    )
    expect(v.kind).toBe('normal-wait')
  })

  it('권위가 더 전진(published)해도 같은 ref 집합이 blocker 를 만들지 않는다', () => {
    const advanced = record({
      revision: N + 2,
      currentIntegrationStage: 'published',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: advanced },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(
          journal({
            ...walBound('published'),
            publishedAt: 9,
            expectedAuthorityRevision: N + 1,
            previousAuthorityStage: 'composed',
            nextAuthorityStage: 'published',
            draftDigest: draftDigestOf(advanced),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('normal-wait')
  })
})

describe('T77 — 권위 부재 + ref 잔존', () => {
  it('권위 레코드가 없으면 비교 기준은 0 이고 모든 결과 ref 가 그보다 크다 → reconciliation', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'absent' },
        prefixRefs: refs([formatResultRef(BENCH, 2, TPREV), OID2]),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('anchor-rollback')
  })

  it('권위 부재 ∧ ref 도 부재면 판정할 것이 없다(조용한 통과가 아니라 무변이 적격)', () => {
    expect(classifyRecovery(obs({ authority: { kind: 'absent' } })).kind).toBe('no-mutation')
  })

  it('권위를 읽지 못하면 그 자체가 blocker 다(부재로 축소하지 않는다)', () => {
    const v = classifyRecovery(obs({ authority: { kind: 'unreadable', detail: 'EIO' } }))
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('authority-unreadable')
  })
})

/* ================================================================================================
 * T76·T90 — 보존된 과거 ref
 * ============================================================================================= */

describe('T76·T90 — 보존된 전 결과 ref 에 같은 식을 적용한다', () => {
  it('현재 revision 이하의 형제 시도 ref 는 정상 보존이다(§3-T29 의 영구 공존)', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs(
          [formatResultRef(BENCH, 2, TPREV), OID2],
          [formatResultRef(BENCH, N, T2), OID2],
        ),
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            draftDigest: draftDigestOf(record()),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('no-mutation')
  })

  it('현재 revision 초과면 current 여부와 무관하게 reconciliation 이다', () => {
    const v = classifyRecovery(
      obs({ prefixRefs: refs([formatResultRef(BENCH, N + 4, TPREV), OID2]) }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('anchor-rollback')
  })
})

/* ================================================================================================
 * T78 — 열거 실패를 empty set 으로 축소하지 않는다
 * ============================================================================================= */

describe('T78 — 관측 실패는 「결과 없음」이 아니다', () => {
  it('접두 열거 실패 → ref-enumeration-failed', () => {
    const v = classifyRecovery(obs({ prefixRefs: { kind: 'failed', detail: 'exit 128' } }))
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('ref-enumeration-failed')
  })

  it('정확 이름 열거 실패도 별개 관측이라 별개로 발화한다', () => {
    const v = classifyRecovery(obs({ exactRefs: { kind: 'failed', detail: 'exit 128' } }))
    expect(kinds(v)).toContain('ref-enumeration-failed')
  })

  it('D/F 충돌(bare 부모 ref) → ref-namespace-conflict 가 **최우선**이다', () => {
    const v = classifyRecovery(
      obs({
        exactRefs: refs([`refs/fleet/integrated/${BENCH}`, OID2]),
        prefixRefs: { kind: 'failed', detail: 'exit 128' },
        authority: { kind: 'unreadable' },
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    // 최우선 = 다른 사유에 **가려지지 않는다**. 목록의 첫 항목이어야 한다.
    expect(kinds(v)[0]).toBe('ref-namespace-conflict')
  })

  it('bare 부모가 **접두 열거**에서 나와도 최우선 충돌이다(관측 출처에 의존하지 않는다)', () => {
    const v = classifyRecovery(obs({ prefixRefs: refs([`refs/fleet/integrated/${BENCH}`, OID2]) }))
    expect(kinds(v)[0]).toBe('ref-namespace-conflict')
  })

  it('문법 위반 ref 는 무시가 아니라 blocker 다', () => {
    const v = classifyRecovery(
      obs({ prefixRefs: refs([`refs/fleet/integrated/${BENCH}/007-${T1}`, OID]) }),
    )
    expect(kinds(v)).toContain('ref-syntax-invalid')
  })

  it('다른 bench 의 ref 가 열거에 섞이면 blocker 다(접두 경계 신뢰의 회귀 핀)', () => {
    const v = classifyRecovery(obs({ prefixRefs: refs([formatResultRef(T2, N + 1, T1), OID]) }))
    expect(kinds(v)).toContain('ref-foreign-bench')
  })

  it('저널 열거 실패·읽기 실패·버전 스큐는 각각 blocker 다', () => {
    expect(kinds(classifyRecovery(obs({ journal: { kind: 'failed' } })))).toContain(
      'journal-enumeration-failed',
    )
    const skew = classifyRecovery(
      obs({
        journal: {
          kind: 'ok',
          entries: [
            {
              txnId: T1,
              read: { kind: 'incompatible-version', path: '/p', found: 2, supported: 1 },
            },
          ],
        },
      }),
    )
    expect(kinds(skew)).toContain('journal-unreadable')
  })

  it('저널 identity 불일치는 읽기 성공과 구분되는 blocker 다', () => {
    const v = classifyRecovery(
      obs({ journal: entries(journal({ repoCommonGitDir: '/other/.git' })) }),
    )
    expect(kinds(v)).toContain('journal-identity-mismatch')
  })

  it('레코드 안의 txnId 가 열거된 이름과 다르면 blocker 다(저널 층 7종 검증의 판정 측 재확인)', () => {
    const v = classifyRecovery(
      obs({
        journal: {
          kind: 'ok',
          entries: [{ txnId: T2, read: { kind: 'found', record: journal() } }],
        },
      }),
    )
    expect(kinds(v)).toContain('journal-identity-mismatch')
  })

  it('권위 레코드의 identity 가 관측 대상 bench 와 다르면 blocker 다', () => {
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({ identity: { ...IDENTITY, benchId: T2 } }),
        },
      }),
    )
    expect(kinds(v)).toContain('authority-identity-mismatch')
  })
})

/* ================================================================================================
 * T79·T80 — 계층(앵커가 먼저) · blocker 지배
 * ============================================================================================= */

describe('T79 — 앵커 게이트가 승격 판정보다 먼저다', () => {
  it('승격 조건을 전부 만족해도 설명되지 않는 더 높은 ref 가 있으면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID], [formatResultRef(BENCH, N + 3, T2), OID2]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('anchor-rollback')
  })

  it('T88 — 같은 next-revision 을 주장하는 ref 가 둘이면 승격은 없다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID], [formatResultRef(BENCH, N + 1, T2), OID2]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
  })
})

describe('T80 — blocker 가 있으면 어떤 행동 인가도 나오지 않는다', () => {
  it('blocker 를 만드는 입력 전수에서 no-mutation·resume·normal-wait 가 나오지 않는다', () => {
    const blocking: readonly Partial<RecoveryObservation>[] = [
      { authority: { kind: 'unreadable' } },
      { prefixRefs: { kind: 'failed' } },
      { exactRefs: { kind: 'failed' } },
      { exactRefs: refs([`refs/fleet/integrated/${BENCH}`, OID2]) },
      { prefixRefs: refs([`refs/fleet/integrated/${BENCH}/x-${T1}`, OID]) },
      { prefixRefs: refs([formatResultRef(BENCH, N + 9, T2), OID2]) },
      { journal: { kind: 'failed' } },
      { journal: entries(journal({ benchId: T2 })) },
    ]
    // 정상 조합(승격 가능)을 **겹쳐도** blocker 가 지배한다 — 「하나라도 있으면 전면 차단」.
    for (const over of blocking) {
      const v = classifyRecovery(
        obs({ prefixRefs: refs([REF_N1, OID]), journal: entries(journal()), ...over }),
      )
      expect(v.kind).toBe('reconciliation-required')
    }
  })
})

/* ================================================================================================
 * T84~T87·T89 — 면제 조건의 개별 반증
 * ============================================================================================= */

describe('면제 10조건 — 하나라도 깨지면 승격이 아니다', () => {
  it('T84 — 대응 저널이 없는 N+1 ref', () => {
    const v = classifyRecovery(obs({ prefixRefs: refs([REF_N1, OID]) }))
    expect(v.kind).toBe('reconciliation-required')
    expect(reasons(v)).toContain('journal-missing')
  })

  it('T85 — ref 가 가리키는 OID 가 journal.resultOid 와 다르다', () => {
    const v = classifyRecovery(
      obs({ prefixRefs: refs([REF_N1, OID2]), journal: entries(journal()) }),
    )
    expect(reasons(v)).toContain('oid-mismatch')
  })

  it('T86 — expected revision 이 관측 권위 revision 보다 크다(N+1)', () => {
    const j = journal({
      expectedAuthorityRevision: N + 1,
      resultRef: formatResultRef(BENCH, N + 2, T1),
    })
    const v = classifyRecovery(
      obs({ prefixRefs: refs([formatResultRef(BENCH, N + 2, T1), OID]), journal: entries(j) }),
    )
    expect(reasons(v)).toContain('expected-revision-mismatch')
  })

  it('T87 — 두 단계 이상 앞섬(권위 N-1 · 저널 expected N · ref N+1)', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record({ revision: N - 1 }) },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(reasons(v)).toContain('expected-revision-mismatch')
  })

  it('T75 — `composed` 저널의 ref revision 이 expected+1 이 아니면 산술 결속 위반이다', () => {
    // 발행자가 `expectedAuthorityRevision` 을 그대로 실은 off-by-one(정정 196 이 폐기한 정의).
    // ⚠ 이 픽스처의 정의역은 `journal()` 기본값인 **`composed`** 다 — 전 stage 식은
    //   `expected + 2 - stageIndex`(정정 223)이고 `published` 에서는 `<expected>` 가 **정상**이다.
    const wrong = formatResultRef(BENCH, N, T1)
    const v = classifyRecovery(
      obs({ prefixRefs: refs([wrong, OID]), journal: entries(journal({ resultRef: wrong })) }),
    )
    expect(v.kind).toBe('reconciliation-required')
    // 판정 위치가 **저널 검증**으로 올라갔다(Codex PR#289 4R P1) — git ref 가 아직 없어도 잡힌다.
    expect(kinds(v)).toContain('journal-result-ref-invalid')
  })

  it('T75 — 앵커 후보 쪽 산술 결속도 같은 식으로 본다(`composed` 저널에 expected+2 를 실은 이름)', () => {
    // ⚠ `expected + 2` 는 `prepared`(stageIndex 0)에서는 **정상값**이다 — 위반이 되는 것은 이 픽스처의
    //   정의역인 `composed` 에서다(정정 223).
    // ⚠ 위 케이스는 `refRevision ≤ revision` 이라 **복구표 경로**가 잡는다. 면제 조건 ⑥ 자신의
    // 반증력은 **후보 경로**(`refRevision > revision`)에서만 관측된다 — 뮤테이션 자기검사가 이 공백을
    // 드러냈다(⑥ 삭제 뮤턴트 생존).
    const ahead = formatResultRef(BENCH, N + 2, T1)
    const v = classifyRecovery(
      obs({ prefixRefs: refs([ahead, OID]), journal: entries(journal({ resultRef: ahead })) }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-result-ref-invalid')
  })

  it('journal.resultRef 와 실제 ref 이름이 다르면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        // 저널이 든 이름은 유효하지만(문법·bench·txn·산술 전부 통과) **관측된 ref 가 다르다**.
        prefixRefs: refs([formatResultRef(BENCH, N + 2, T1), OID]),
        journal: entries(journal()),
      }),
    )
    expect(reasons(v)).toContain('ref-name-mismatch')
  })

  it('stage 가 정확히 composed 가 아니면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            draftDigest: draftDigestOf(record()),
          }),
        ),
      }),
    )
    expect(reasons(v)).toContain('stage-not-composed')
  })

  it('종결 증거(abandonedAt·abandonReason·publishedAt)가 실려 있으면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal({ abandonedAt: 7, abandonReason: 'superseded' })),
      }),
    )
    // ⚠ 판정 위치가 **저널 검증**으로 올라갔다(Codex PR#289 6R P1) — 종결 증거는 앵커 후보가 아닌
    //    저널에서도 모순이므로 admitted 전수에서 본다.
    expect(kinds(v)).toContain('journal-terminal-evidence')
  })

  it('draftDigest 가 현재 권위에서 재구성한 값과 다르면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal({ draftDigest: 'f'.repeat(64) })),
      }),
    )
    expect(reasons(v)).toContain('digest-mismatch')
  })

  it('전이 결속 필드(previous·next·generation)가 어긋나면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal({ integrationGeneration: 9 })),
      }),
    )
    expect(reasons(v)).toContain('stage-binding-mismatch')
  })

  it('T89 — 롤백된 current 슬롯: current 라는 이유만으로 면제되지 않는다', () => {
    // T1 완료 → 권위가 T2 로 전진 → 파일 롤백으로 current 가 **다시 T1**. T2 의 composed 저널과
    // ref 가 남아 있는데, 「T1 이 current 다」를 근거로 T2 ref 를 숨기면 롤백을 증명하는 가장 높은
    // ref 가 바로 그 이유로 사라진다(계획 정정 199ⓐ).
    const rolled = record({ currentIntegrationTxnId: T1, currentIntegrationStage: 'prepared' })
    const j2 = journal({
      txnId: T2,
      resultRef: formatResultRef(BENCH, N + 1, T2),
      draftDigest: digestAuthorityDraft(composedDraft(rolled, T2)),
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rolled },
        prefixRefs: refs([formatResultRef(BENCH, N + 1, T2), OID]),
        journal: entries(j2),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(reasons(v)).toContain('transition-illegal')
  })
})

/* ================================================================================================
 * T32 — 복구표 6조합(현재 txn 정의역)
 * ============================================================================================= */

describe('T32 — 복구표는 현재 txn 1건을 정의역으로 한다', () => {
  const prepared = journal({
    ...walBound('prepared'),
    resultTree: undefined,
    resultOid: undefined,
    draftDigest: draftDigestOf(record()),
  })

  it('prepared ∧ ref 부재 → no-mutation(포기·재준비 적격)', () => {
    expect(classifyRecovery(obs({ journal: entries(prepared) })).kind).toBe('no-mutation')
  })

  /**
   * **복구표의 「`prepared` ∧ ref 존재」 행은 전용 arm 없이 답한다**(Codex PR#289 5R P1 의 연쇄).
   *
   * stage 별 ref 산술이 서면서 그 상태는 **구조적으로 앵커 후보**가 됐다: `prepared` 저널이 현재 txn 을
   * 가리키려면 결속이 post-CAS 여야 하고(`revision = expected + 1`), 그 저널의 ref 는 `expected + 2`
   * = `revision + 1` 이라 **항상 `> revision`** 이다. 이름이 다르면 그건 mismatch 라는 다른 축이다.
   * 그래서 전용 `result-ref-unattributed` arm 은 **도달 불가**가 되어 제거했다(정정 183·189) —
   * 표가 요구하는 **결과**(reconciliation)는 앵커가 그대로 보장한다.
   */
  it('prepared ∧ ref 존재 → reconciliation(앵커가 답한다 · 전용 arm 없음)', () => {
    const rec = record({ revision: N + 3 })
    const boundPrepared = journal({
      ...walBound('prepared'),
      resultTree: undefined,
      resultOid: undefined,
      expectedAuthorityRevision: N + 2,
      resultRef: formatResultRef(BENCH, N + 4, T1),
      draftDigest: draftDigestOf(rec),
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        // 존재하는 ref 는 **그 저널이 이름 붙인 바로 그것**이어야 한다(아니면 mismatch 라는 다른 축).
        prefixRefs: refs([formatResultRef(BENCH, N + 4, T1), OID]),
        journal: entries(boundPrepared),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('anchor-rollback')
  })

  it('composed ∧ ref 부재 → no-mutation(ref 발행 전 크래시)', () => {
    expect(classifyRecovery(obs({ journal: entries(journal()) })).kind).toBe('no-mutation')
  })

  it('composed ∧ ref 존재 ∧ OID 불일치 → result-ref-mismatch', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record({ revision: N + 3 }) },
        prefixRefs: refs([REF_N1, OID2]),
        // 결속된 pre-cas 쌍(권위 `prepared` · expected === revision)에서 ref 의 OID 만 어긋난다.
        journal: entries(
          journal({
            expectedAuthorityRevision: N + 3,
            resultRef: formatResultRef(BENCH, N + 4, T1),
          }),
        ),
      }),
    )
    expect(kinds(v)).toContain('result-ref-mismatch')
  })

  it('OID 가 같아도 ref **이름**이 저널의 증언과 다르면 mismatch 다(축 분리)', () => {
    // ⚠ 이름과 OID 를 **한 픽스처에서 함께** 어긋내면 어느 쪽이 잡았는지 알 수 없다 — 뮤테이션에서
    //    이름 대조를 지워도 OID 대조가 가려버렸다(생존). 여기서는 OID 를 **일치**시켜 축을 분리한다.
    const rec = record({ revision: N + 3 })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(
          journal({
            expectedAuthorityRevision: N + 3,
            resultRef: formatResultRef(BENCH, N + 4, T1),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toEqual(['result-ref-mismatch'])
  })

  it('published 저널은 차단하지 않는다(C6 · 정상 대기)', () => {
    const pub = journal({
      ...walBound('published'),
      publishedAt: 9,
      expectedAuthorityRevision: N + 1,
      previousAuthorityStage: 'composed',
      nextAuthorityStage: 'published',
    })
    const rec = record({
      revision: N + 2,
      currentIntegrationStage: 'published',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
        journal: entries(journal({ ...pub, draftDigest: draftDigestOf(rec) })),
      }),
    )
    expect(v.kind).toBe('normal-wait')
  })

  it('finalized·abandoned 잔존 → 청소 복구(멱등 종결 · 삭제 아님)', () => {
    // ⚠ 권위 stage 는 저널보다 한 단계 뒤까지만 허용된다(WAL 교차 결속) — `finalized` 저널의 짝은
    // `published` 권위다. `abandoned` 는 종결 기록이라 그 결속의 정의역 밖이다(포기 CAS 가 pending).
    // 결속된 **pre-CAS** 쌍 — 종결 CAS 가 아직 커밋되지 않은 상태(expected === 관측 revision).
    // ⚠ `finalized` 는 ref 를 **요구**하고(5R P1) `abandoned` 는 요구하지 않는다(prepared 에서
    //    포기하면 ref 가 존재한 적이 없다).
    const finalizedRec = record({
      revision: R0 + 3,
      currentIntegrationStage: 'published',
      currentIntegrationResultOid: OID,
    })
    const finalized = classifyRecovery(
      obs({
        authority: { kind: 'found', record: finalizedRec },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
        journal: entries(
          journal({
            ...walBound('finalized'),
            publishedAt: 9,
            draftDigest: nextDraftDigestOf(finalizedRec, 'finalized'),
          }),
        ),
      }),
    )
    expect(finalized.kind).toBe('idempotent-cleanup')

    const abandonedRec = record({ revision: N + 3 })
    const abandoned = classifyRecovery(
      obs({
        authority: { kind: 'found', record: abandonedRec },
        journal: entries(
          journal({
            stage: 'abandoned',
            expectedAuthorityRevision: N + 3,
            previousAuthorityStage: 'prepared',
            nextAuthorityStage: undefined,
            // `prepared` 에서의 포기라 결과 증거가 **없다** — 그래야 ref 를 요구하지 않는다(6R P1).
            resultTree: undefined,
            resultOid: undefined,
            abandonedAt: 9,
            abandonReason: 'user-abandon',
            draftDigest: abandonDraftDigestOf(abandonedRec),
          }),
        ),
      }),
    )
    expect(abandoned.kind).toBe('idempotent-cleanup')
  })

  it('권위가 이미 N+1 이어도 반영된 결과 증거가 다르면 완료 확인이 아니다(정정 204ⓒ)', () => {
    // CAS 가 성공했는지 **불확실**한데 결속까지 어긋난 상태 — 자동 전진 금지.
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({
            revision: N + 1,
            currentIntegrationStage: 'composed',
            currentIntegrationResultOid: OID2,
          }),
        },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    // ⑥ 의 결속 판정이 **복구표보다 먼저** 답한다 — 「post-cas 인데 권위가 든 결과가 저널의 증언과
    // 다르다」는 stage 순서가 아니라 결속의 문제다(Codex PR#289 3R P1).
    expect(kinds(v)).toContain('journal-authority-binding')
  })

  /**
   * **Codex PR#289 3R P1** — 같은 stage 끼리도 결속을 본다. 이전 판은 stage **인덱스만** 비교해서
   * 「둘 다 composed 인데 결과·revision·세대가 어긋난」 손상 쌍이 그대로 복구표에 도달했고, ref 가
   * 없으면 `no-mutation`(= 포기·재준비 적격)이 나왔다.
   */
  it('같은 stage 여도 결속이 어긋나면 ref 가 없어도 reconciliation 이다', () => {
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({
            revision: N + 1,
            currentIntegrationStage: 'composed',
            currentIntegrationResultOid: OID2,
          }),
        },
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-authority-binding')
  })

  /**
   * **Codex PR#289 4R P1** — post-CAS 결속이 stage·revision·세대·resultOid 만 보면 **draft 투영 안의
   * 나머지 필드**(`lifecycle`·`sourceGeneration`·`activeActivity` …)가 롤백·손상돼도 통과한다.
   * 저널은 그 전체를 `draftDigest` 로 이미 증언하고 있으므로 **추가 입력 없이** 대조할 수 있다.
   */
  it('post-CAS 인데 권위 draft 가 저널의 draftDigest 와 다르면 결속 위반이다', () => {
    const advanced = record({
      revision: N + 1,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
    })
    // 저널이 증언한 draft 는 `sourceGeneration: 3` 인데 권위는 4 로 전진했다 — stage·revision·세대·
    // resultOid 는 전부 맞지만 **의도가 다른 draft** 다.
    const rolled = record({
      revision: N + 1,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
      sourceGeneration: 4,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rolled },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal({ draftDigest: draftDigestOf(advanced) })),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-authority-binding')
  })

  /**
   * **Codex PR#289 4R P1** — 저널이 든 `resultRef` 는 **불변 필드**라, git ref 가 아직 없어도
   * 잘못된 이름이 살아남아 나중에 그대로 발행된다. 문법 소유가 이 PR 로 온 이상 여기서 잡아야 한다.
   */
  it('저널이 든 resultRef 가 다른 bench·txn 을 가리키면 blocker 다(git ref 유무와 무관)', () => {
    for (const bad of [
      formatResultRef(T2, N + 1, T1),
      formatResultRef(BENCH, N + 1, T2),
      'refs/heads/x',
    ]) {
      const v = classifyRecovery(obs({ journal: entries(journal({ resultRef: bad })) }))
      expect(v.kind).toBe('reconciliation-required')
      expect(kinds(v)).toContain('journal-result-ref-invalid')
    }
  })

  /**
   * **Codex PR#289 4R P1** — `published` 저널의 ref 는 revision 이 권위 이하라 앵커 후보가 아니다.
   * 그 분기가 OID 를 대조하지 않으면, 교체·손상된 ref 위에서 시퀀서가 게시를 계속한다.
   */
  /**
   * **Codex PR#289 5R P1** — ref 발행은 composed CAS **앞**이므로 post-CAS 상태에서 ref 가 **사라진
   * 것**은 프로토콜상 불가능하다. 그것을 `no-mutation`(포기·재준비 적격)으로 답하면 **ref 롤백·손상이
   * 그대로 숨는다.** ⚠ pre-CAS composed(= 발행 전 크래시)는 그대로 `no-mutation` 이어야 한다.
   */
  it('post-CAS 인데 결과 ref 가 사라졌으면 무변이 적격이 아니다', () => {
    const rec = record({
      revision: N + 1,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
    })
    const gone = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        journal: entries(journal({ draftDigest: draftDigestOf(rec) })),
      }),
    )
    expect(gone.kind).toBe('reconciliation-required')
    expect(kinds(gone)).toContain('result-ref-missing')

    // 대조군 — pre-CAS(권위가 아직 `prepared`)는 ref 가 없는 것이 **정상 크래시 창**이다.
    expect(classifyRecovery(obs({ journal: entries(journal()) })).kind).toBe('no-mutation')
  })

  it('published 저널이어도 ref 가 교체됐으면 정상 대기가 아니다', () => {
    const rec = record({
      revision: N + 2,
      currentIntegrationStage: 'published',
      currentIntegrationResultOid: OID,
    })
    const pub = journal({
      ...walBound('published'),
      publishedAt: 9,
      expectedAuthorityRevision: N + 1,
      previousAuthorityStage: 'composed',
      nextAuthorityStage: 'published',
      draftDigest: draftDigestOf(rec),
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        prefixRefs: refs([REF_N1, OID2]), // 같은 이름 · **다른 커밋**
        journal: entries(pub),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('result-ref-mismatch')
  })

  it('고아 published 저널은 차단하지 않는다(활성 집합 = prepared·composed 뿐 · §3-T33)', () => {
    const orphanPublished = journal({
      txnId: T2,
      ...walBound('published'),
      publishedAt: 9,
      resultRef: formatResultRef(BENCH, N + 1, T2),
      expectedAuthorityRevision: N + 1,
      previousAuthorityStage: 'composed',
      nextAuthorityStage: 'published',
    })
    const v = classifyRecovery(obs({ journal: entries(journal(), orphanPublished) }))
    expect(v.kind).toBe('no-mutation')
  })

  it('권위가 가리키는 txn 의 저널이 없으면 blocker 다(WAL 선기록 위반)', () => {
    const v = classifyRecovery(obs({ journal: entries(journal({ txnId: T2 })) }))
    expect(kinds(v)).toContain('current-txn-journal-missing')
  })
})

/* ================================================================================================
 * I11 — 고아 활성 저널의 2분 (계획 정정 194)
 * ============================================================================================= */

describe('I11 — 고아 활성 저널은 활성 집합 정의가 아니라 복구 판정이 2분한다', () => {
  const noCurrent = {
    currentIntegrationTxnId: undefined,
    currentIntegrationStage: undefined,
    currentIntegrationTxnGeneration: undefined,
  } as const

  it('prepared 고아 ∧ ref 없음 = WAL 선기록의 정상 크래시 창 → no-mutation', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record(noCurrent) },
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            draftDigest: draftDigestOf(record()),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('no-mutation')
  })

  it('composed 고아 → reconciliation(영구 고착이 아니라 판정으로 탈출)', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record({ revision: N + 3, ...noCurrent }) },
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('orphan-active-journal')
  })

  it('ref 를 동반한 prepared 고아 → reconciliation', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record({ revision: N + 3, ...noCurrent }) },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            draftDigest: draftDigestOf(record()),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
  })
})

/* ================================================================================================
 * Codex PR#289 P1 — 관측 계약의 구멍 3건
 * ============================================================================================= */

describe('P1 — 저널 identity 는 권위 유무와 무관하게 검증한다', () => {
  it('권위 부재 + 다른 레포에서 복사된 저널은 benign 이 아니다', () => {
    // benchId 가 같아도(영역 통째 복사·클론) `repoCommonGitDir`·`benchRoot` 는 다르다. 권위가 없다는
    // 이유로 그 대조를 건너뛰면 **남의 레포 저널이 재준비 적격으로 통과**한다 — 권위가 없을수록 더
    // 엄격해야 한다(fail-closed).
    const v = classifyRecovery(
      obs({
        authority: { kind: 'absent' },
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            repoCommonGitDir: '/other/.git',
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-identity-mismatch')
  })

  it('권위 부재 + benchRoot 불일치도 같은 종별이다', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'absent' },
        journal: entries(journal({ benchRoot: '/elsewhere/.fleet-wb' })),
      }),
    )
    expect(kinds(v)).toContain('journal-identity-mismatch')
  })
})

describe('P1 — 권위와 저널의 교차 순서 결속(WAL 선기록)', () => {
  it('권위가 저널보다 앞선 상태는 불가능하다 → reconciliation', () => {
    // WAL 은 저널 선기록 → 권위 CAS 이므로 `authority stage ≤ journal stage` 다. 뒤집힌 관측은
    // **저널 단독 롤백·손상**의 증거이고, 저널 stage 만 보고 분기하면 그 상태가 `no-mutation` 으로
    // 통과해 손상 위에서 포기·재준비가 인가된다.
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({
            currentIntegrationStage: 'published',
            currentIntegrationResultOid: OID,
          }),
        },
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            draftDigest: draftDigestOf(record()),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-behind-authority')
  })

  it('저널이 권위보다 두 단계 앞선 상태도 불가능하다(정정 204 불변식 ①)', () => {
    // 「stage S 의 권위 커밋이 확인되기 전 stage S+1 저널 기록 금지」 → `journal ≤ authority + 1`.
    // ref 를 두지 않아 **앵커가 침묵하는 구간**에서 이 결속만으로 잡히는지 본다.
    const v = classifyRecovery(
      obs({
        journal: entries(
          journal({
            ...walBound('published'),
            publishedAt: 9,
            expectedAuthorityRevision: N + 1,
            previousAuthorityStage: 'composed',
            nextAuthorityStage: 'published',
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-too-far-ahead')
  })

  it('정상 창(권위 prepared · 저널 composed)은 여전히 통과한다', () => {
    const v = classifyRecovery(
      obs({ prefixRefs: refs([REF_N1, OID]), journal: entries(journal()) }),
    )
    expect(v.kind).toBe('resume-composed-cas')
  })
})

describe('P1 — 미종결 txn 위의 고아 prepared 저널', () => {
  it('다른 txn 이 pending 이면 prepared 고아는 benign 이 아니다', () => {
    // 전이 불변식이 「미종결 T1 위에 T2 시작」을 금지하므로 저널-선기록 프로토콜은 T2 를 **애초에
    // 쓰지 말았어야 한다**. 그 존재 자체가 이상 신호인데, benign 규칙이 그것을 삼키고 T1 승격까지
    // 그대로 내주고 있었다.
    const orphanT2 = journal({
      txnId: T2,
      ...walBound('prepared'),
      resultTree: undefined,
      resultOid: undefined,
      resultRef: formatResultRef(BENCH, N + 1, T2),
    })
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal(), orphanT2),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('orphan-active-journal')
  })

  /**
   * **CodeRabbit PR#289** — 완결 귀속 txn 의 저널은 정상 상태에서 `finalized` 다. 그것이 활성 stage 로
   * 남아 있으면 매체 손상·순서 위반의 증거인데, 초안은 「귀속돼 있으니 고아가 아니다」로 **제외**해
   * blocker 없이 통과시켰다. 다른 경로(`current-txn-journal-missing`)가 같은 계열의 매체 불일치를
   * 발화하는 것과 **비대칭**이었다.
   */
  it('완결 귀속 txn 의 저널이 finalized 가 아니면 blocker 다(활성 게이트 밖 · 정정 234)', () => {
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({
            lifecycle: 'integrated',
            completedIntegrationTxnId: T2,
            currentIntegrationTxnId: undefined,
            currentIntegrationStage: undefined,
            currentIntegrationTxnGeneration: undefined,
          }),
        },
        journal: entries(
          journal({
            txnId: T2,
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            resultRef: formatResultRef(BENCH, N + 1, T2),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('completed-txn-journal-unfinalized')
  })

  /**
   * **Codex PR#289 6R P1** — `integrated`·`archived` 권위는 current txn 이 없어 `authorityPending`
   * 이 거짓이지만, 그 위에서 새 txn 을 **시작할 수 없으므로**(전이 불변식) 그 저널은 애초에 쓰일 수
   * 없었다. stage 의 pending 여부만 보면 그 사실을 놓친다.
   */
  it('종결 bench(integrated·archived)에는 benign 창이 없다', () => {
    for (const lifecycle of ['integrated', 'archived'] as const) {
      const rec = record({
        lifecycle,
        ...(lifecycle === 'integrated'
          ? { completedIntegrationTxnId: T2 }
          : { archivedBranch: 'preserved' as const }),
        currentIntegrationTxnId: undefined,
        currentIntegrationStage: undefined,
        currentIntegrationTxnGeneration: undefined,
      })
      const v = classifyRecovery(
        obs({
          authority: { kind: 'found', record: rec },
          journal: entries(
            journal({ ...walBound('prepared'), resultTree: undefined, resultOid: undefined }),
          ),
        }),
      )
      expect(v.kind, lifecycle).toBe('reconciliation-required')
      expect(kinds(v)).toContain('orphan-active-journal')
    }
  })

  /**
   * **Codex PR#289 6R P1** — `previousAuthorityStage` 가 `composed` 이상인 포기는 **이미 ref 가
   * 발행된 뒤**라 그 부재는 손상이고, 청소 CAS 가 남은 통합 상태를 지우면서 **사라진 불변 결과를
   * 숨긴다.** 면제는 「`prepared` 에서의 포기」에만 준다.
   */
  it('composed 이후의 포기는 결과 ref 를 요구한다', () => {
    const rec = record({
      revision: N + 3,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        journal: entries(
          journal({
            stage: 'abandoned',
            expectedAuthorityRevision: N + 3,
            previousAuthorityStage: 'composed',
            nextAuthorityStage: undefined,
            abandonedAt: 9,
            abandonReason: 'user-abandon',
            draftDigest: abandonDraftDigestOf(rec),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('result-ref-missing')
  })

  /**
   * **Codex PR#289 6R P1** — pre-CAS 가지가 **세대만** 보면 「결과 A 를 든 composed 권위 + 결과 B 를
   * 든 published 저널」이 순서·산술·ref 대조를 전부 통과해 `normal-wait` 이 나온다 — 같은 txn 이
   * **불변 결과를 갈아치운** 것이다.
   */
  it('pre-CAS 에서 불변 결과를 갈아치우면 결속 위반이다', () => {
    const rec = record({
      revision: R0 + 2,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID, // 권위가 든 결과 = A
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID2]),
        journal: entries(
          journal({
            ...walBound('published'),
            publishedAt: 9,
            resultOid: OID2, // 저널이 든 결과 = B
            // ⚠ **축을 분리한다** — digest 는 B 로 정확히 재구성해 둔다. 그러지 않으면 draft 결속이
            //    함께 깨져 「둘 중 뭔가 잡았다」가 되고, 뮤테이션에서 두 검사가 서로를 가린다(실측).
            draftDigest: nextDraftDigestOf(rec, 'published', OID2),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-authority-binding')
  })

  /**
   * **Codex PR#289 6R P1(축 분리)** — 결과는 상속되는데 **draft 전체**가 다른 경우. 위 행과 반대로
   * 이쪽은 `resultInherited` 를 통과시키고 `draftBound` 만 깨뜨린다.
   */
  it('pre-CAS 에서 draft 결속이 깨지면 결과가 같아도 위반이다', () => {
    const rec = record({
      revision: R0 + 2,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
        journal: entries(
          journal({ ...walBound('published'), publishedAt: 9, draftDigest: 'f'.repeat(64) }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-authority-binding')
  })

  it('미종결 txn 이 없으면(권위에 통합 없음) prepared 고아는 그대로 benign 이다', () => {
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({
            currentIntegrationTxnId: undefined,
            currentIntegrationStage: undefined,
            currentIntegrationTxnGeneration: undefined,
          }),
        },
        journal: entries(
          journal({
            ...walBound('prepared'),
            resultTree: undefined,
            resultOid: undefined,
            draftDigest: draftDigestOf(record()),
          }),
        ),
      }),
    )
    expect(v.kind).toBe('no-mutation')
  })
})

/* ================================================================================================
 * T81·T92 — 증거 봉인 seam (재검증의 판정 계층)
 * ============================================================================================= */

describe('T81·T92 — 면제 증거는 봉인되고 재검증은 동치로 판정한다', () => {
  const promotable = (over: Partial<RecoveryObservation> = {}): RecoveryObservation =>
    obs({ prefixRefs: refs([REF_N1, OID]), journal: entries(journal()), ...over })

  const evidenceOf = (o: RecoveryObservation) => {
    const v = classifyRecovery(o)
    if (v.kind !== 'resume-composed-cas') throw new Error(`승격이 아니다: ${v.kind}`)
    return v.resume
  }

  it('같은 관측은 같은 증거를 낸다(결정론)', () => {
    expect(isSameRecoveryEvidence(evidenceOf(promotable()), evidenceOf(promotable()))).toBe(true)
  })

  it('권위 revision 이 그 사이에 바뀌면 같은 증거가 아니다', () => {
    // ⑦ 재검증에서 권위가 전진했다면 최초 분류의 면제는 더 이상 유효하지 않다.
    const after = promotable({
      authority: {
        kind: 'found',
        record: record({
          revision: N + 1,
          currentIntegrationStage: 'composed',
          currentIntegrationResultOid: OID,
        }),
      },
    })
    const v = classifyRecovery(after)
    expect(v.kind).toBe('normal-wait')
  })

  it('ref 집합이 바뀌면 같은 증거가 아니다', () => {
    const before = evidenceOf(promotable())
    const withSibling = promotable({
      prefixRefs: refs([REF_N1, OID], [formatResultRef(BENCH, 2, TPREV), OID2]),
    })
    expect(isSameRecoveryEvidence(before, evidenceOf(withSibling))).toBe(false)
  })

  /**
   * **Codex PR#289 4R P1** — `draftDigest` 는 **권위 draft 투영**만 덮는다. 저널의 통합 입력
   * (`sourceSnapshot`·`targetBranch`·`targetHeadBeforeIntegration`·`resultTree`)은 그 투영 밖이라,
   * 그것만 실으면 **바뀐 통합 의도가 같은 증거로** 재검증을 통과한다.
   */
  it('저널의 통합 입력이 바뀌면 같은 증거가 아니다', () => {
    const before = evidenceOf(promotable())
    for (const changed of [
      { sourceSnapshot: 'f'.repeat(40) },
      { targetBranch: 'release' },
      { targetHeadBeforeIntegration: 'f'.repeat(40) },
      { resultTree: 'f'.repeat(40) },
    ]) {
      const after = evidenceOf(promotable({ journal: entries(journal(changed)) }))
      expect(isSameRecoveryEvidence(before, after), JSON.stringify(changed)).toBe(false)
    }
  })

  it('증거 다이제스트는 순수 함수의 산출물이라 관측 밖 값에 의존하지 않는다', () => {
    const a = evidenceOf(promotable())
    const b = evidenceOf(
      promotable({
        authority: {
          kind: 'found',
          record: record({ writtenBy: { ownerToken: 'other', at: 99, durability: 'file+dir' } }),
        },
      }),
    )
    // `writtenBy` 는 CAS 가 배정하는 필드라 draft 투영에 없다 — 면제 판정을 흔들지 않아야 한다.
    expect(isSameRecoveryEvidence(a, b)).toBe(true)
  })
})

/* ================================================================================================
 * T91 — 순수성(무변이 관찰)
 * ============================================================================================= */

describe('T91 — 판정은 순수하다(입력 무변이)', () => {
  it('관측 객체를 변형하지 않는다', () => {
    const o = obs({ prefixRefs: refs([REF_N1, OID]), journal: entries(journal()) })
    const snapshot = JSON.stringify(o)
    classifyRecovery(o)
    expect(JSON.stringify(o)).toBe(snapshot)
  })
})

/* ================================================================================================
 * 로컬 적대 리뷰(Codex 한도 소진 대체) — 정정 233~235
 * ============================================================================================= */

describe('정정 233 — 열린 창의 개입 CAS 는 정상이다(설계급 P1 회귀)', () => {
  /**
   * `revision` 은 **모든 CAS** 가 +1 하는 전역 카운터다. `published` 는 활성이 아니어서 그 창에서
   * 실행·보관이 **계약상 허용**되고(C6 · §3-T33 · I8), 그 CAS 들이 revision·`sourceGeneration`·
   * `activeActivity` 를 바꾼다. tight 등식·전체 draft digest 는 그 정상 상태를 손상으로 오분류했다.
   */
  const publishedJournal = journal({ ...walBound('published'), publishedAt: 9 })

  it('published 뒤 활동 CAS 3회가 끼어들어도 정상 대기다', () => {
    const drifted = record({
      revision: R0 + 2 + 3, // publish CAS(R0+2) 이후 gated·running·종료 3회
      currentIntegrationStage: 'published',
      currentIntegrationResultOid: OID,
      sourceGeneration: 4,
      activeActivity: {
        activityId: 'act',
        kind: 'run',
        generation: 4,
        ownerToken: 'ow',
        execGate: 'running',
        startedAt: 1,
      },
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: drifted },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
        journal: entries(publishedJournal),
      }),
    )
    expect(v.kind).toBe('normal-wait')
  })

  it('보관된 integration-ready bench 도 정상 대기다(I8)', () => {
    const archived = record({
      revision: R0 + 4,
      lifecycle: 'archived',
      archivedBranch: 'preserved',
      currentIntegrationStage: 'published',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: archived },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
        journal: entries(publishedJournal),
      }),
    )
    expect(v.kind).toBe('normal-wait')
  })

  it('finalized 저널의 ref revision 은 등식이 아니라 상한이다(정정 233 · 1-B)', () => {
    // 완결 관측은 외부 소비자 머지 **이후**라 그 사이 개입 CAS 가 expected 를 올린다.
    const rec = record({
      revision: R0 + 8,
      currentIntegrationStage: 'finalized',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: rec },
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
        journal: entries(
          journal({
            ...walBound('finalized'),
            expectedAuthorityRevision: R0 + 7, // 드리프트
            publishedAt: 9,
          }),
        ),
      }),
    )
    expect(v.kind).toBe('idempotent-cleanup')
  })

  it('⚠ 닫힌 창은 여전히 tight 다 — composed 에서 드리프트는 손상이다(음성 통제)', () => {
    // `prepared`·`composed` 는 **활성 저널**이라 실행이 차단되고, 복구 판정은 모든 권위 CAS 보다
    // 먼저 돈다(정정 197ⓐ) → 개입 CAS 가 불가하므로 완화하지 않는다.
    const drifted = record({
      revision: N + 2,
      currentIntegrationStage: 'composed',
      currentIntegrationResultOid: OID,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: drifted },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('journal-authority-binding')
  })
})

describe('정정 235 — 승격 경로도 현재 txn ref 대조를 받는다', () => {
  it('면제가 성립해도 같은 txn 의 여분 ref 는 blocker 다', () => {
    // 4R 은 이 대조를 「표 앞」으로 올렸는데 그 「앞」이 **면제 반환 뒤**였다 — 승격 경로에서만 침묵했다.
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID], [formatResultRef(BENCH, 3, T1), OID2]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('result-ref-mismatch')
  })
})

describe('반증력 복원 — 측정으로 확정된 공백(로컬 적대 리뷰 L4)', () => {
  const preparedOrphan = (txnId: string) =>
    journal({
      ...walBound('prepared'),
      txnId,
      resultTree: undefined,
      resultOid: undefined,
      resultRef: formatResultRef(BENCH, R0 + 2, txnId),
      draftDigest: draftDigestOf(record()),
    })

  it('A — 권위 부재 + 유효 prepared 저널은 benign 이 아니다', () => {
    const v = classifyRecovery(
      obs({ authority: { kind: 'absent' }, journal: entries(preparedOrphan(T2)) }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toContain('orphan-active-journal')
  })

  it('B — 권위가 finalized 면 다른 txn 의 prepared 고아는 benign 이다', () => {
    // finalized 저널의 **post-CAS** 짝 = revision 이 expected(R0+3) 보다 1 앞선 상태.
    const done = record({
      revision: R0 + 4,
      currentIntegrationStage: 'finalized',
      currentIntegrationResultOid: OID,
      currentIntegrationTxnId: T1,
    })
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: done },
        journal: entries(
          journal({ ...walBound('finalized'), publishedAt: 9, draftDigest: draftDigestOf(done) }),
          preparedOrphan(T2),
        ),
        prefixRefs: refs([formatResultRef(BENCH, R0 + 2, T1), OID]),
      }),
    )
    expect(v.kind).toBe('idempotent-cleanup')
  })

  it('C — 종결 증거는 abandonedAt 만으로도 blocker 다(축 분리)', () => {
    const v = classifyRecovery(obs({ journal: entries(journal({ abandonedAt: 7 })) }))
    expect(kinds(v)).toContain('journal-terminal-evidence')
  })

  it('D — 종결 증거는 abandonReason 만으로도 blocker 다(축 분리)', () => {
    const v = classifyRecovery(obs({ journal: entries(journal({ abandonReason: 'superseded' })) }))
    expect(kinds(v)).toContain('journal-terminal-evidence')
  })

  it('F — 권위 부재 시 면제 실패 사유는 authority-unavailable 이다', () => {
    const v = classifyRecovery(
      obs({ authority: { kind: 'absent' }, prefixRefs: refs([REF_N1, OID]) }),
    )
    expect(reasons(v)).toContain('authority-unavailable')
  })

  it('G — 세대 동치만 어긋나도 결속 위반이다(축 분리)', () => {
    // draftDigest 를 **저널의 세대(2)로 정확히 재구성**해 draft 축을 통과시킨다 → 세대 축만 남는다.
    const rec = record()
    const { revision: _r, writtenBy: _w, ...rest } = rec
    const digestWithGen2 = digestAuthorityDraft({
      ...rest,
      currentIntegrationTxnId: T1,
      currentIntegrationStage: 'composed',
      currentIntegrationTxnGeneration: 2,
      currentIntegrationResultOid: OID,
    } as BenchAuthorityDraft)
    const v = classifyRecovery(
      obs({
        journal: entries(journal({ integrationGeneration: 2, draftDigest: digestWithGen2 })),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(kinds(v)).toEqual(['journal-authority-binding'])
  })

  it('L — 정확 이름 질의가 자식 ref 를 답해도 충돌이 아니다', () => {
    // 실측: `for-each-ref refs/…/<benchId>` 는 자식도 함께 답한다. 이름이 **정확히 같은** 항목만 본다.
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        exactRefs: refs([REF_N1, OID]),
        journal: entries(journal()),
      }),
    )
    expect(v.kind).toBe('resume-composed-cas')
  })

  it('M — 저널 열거 실패는 current-txn-journal-missing 을 덧붙이지 않는다', () => {
    const v = classifyRecovery(obs({ journal: { kind: 'failed', detail: 'EIO' } }))
    expect(kinds(v)).toEqual(['journal-enumeration-failed'])
  })

  it('N — blocker 는 진단 앵커(subject)를 싣는다', () => {
    const v = classifyRecovery(obs({ prefixRefs: { kind: 'failed', detail: 'exit 128' } }))
    if (v.kind !== 'reconciliation-required') throw new Error(v.kind)
    expect(v.blockers[0]?.subject).toBe('exit 128')
  })
})
