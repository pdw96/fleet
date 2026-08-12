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

/** 관측된 권위 revision. 결과 ref 는 `N+1` 을 이름에 싣는다(계획 정정 196). */
const N = 5

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
  benchId: BENCH,
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
            stage: 'published',
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
        journal: entries(journal()),
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
            stage: 'published',
            publishedAt: 9,
            expectedAuthorityRevision: N + 1,
            previousAuthorityStage: 'composed',
            nextAuthorityStage: 'published',
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
          journal({ stage: 'prepared', resultTree: undefined, resultOid: undefined }),
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

  it('T75 — ref 이름의 revision 이 expected+1 이 아니면 산술 결속 위반이다', () => {
    // 발행자가 `expectedAuthorityRevision` 을 그대로 실은 off-by-one(정정 196 이 폐기한 정의).
    const wrong = formatResultRef(BENCH, N, T1)
    const v = classifyRecovery(
      obs({ prefixRefs: refs([wrong, OID]), journal: entries(journal({ resultRef: wrong })) }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(reasons(v)).toContain('arithmetic-binding')
  })

  it('T75 — 앵커 후보 쪽 산술 결속도 같은 식으로 본다(expected+2 를 실은 이름)', () => {
    // ⚠ 위 케이스는 `refRevision ≤ revision` 이라 **복구표 경로**가 잡는다. 면제 조건 ⑥ 자신의
    // 반증력은 **후보 경로**(`refRevision > revision`)에서만 관측된다 — 뮤테이션 자기검사가 이 공백을
    // 드러냈다(⑥ 삭제 뮤턴트 생존).
    const ahead = formatResultRef(BENCH, N + 2, T1)
    const v = classifyRecovery(
      obs({ prefixRefs: refs([ahead, OID]), journal: entries(journal({ resultRef: ahead })) }),
    )
    expect(v.kind).toBe('reconciliation-required')
    expect(reasons(v)).toEqual(['arithmetic-binding'])
  })

  it('journal.resultRef 와 실제 ref 이름이 다르면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(journal({ resultRef: formatResultRef(BENCH, N + 1, T2) })),
      }),
    )
    expect(reasons(v)).toContain('ref-name-mismatch')
  })

  it('stage 가 정확히 composed 가 아니면 승격하지 않는다', () => {
    const v = classifyRecovery(
      obs({
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(
          journal({ stage: 'prepared', resultTree: undefined, resultOid: undefined }),
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
    expect(reasons(v)).toContain('terminal-evidence-present')
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
  const prepared = journal({ stage: 'prepared', resultTree: undefined, resultOid: undefined })

  it('prepared ∧ ref 부재 → no-mutation(포기·재준비 적격)', () => {
    expect(classifyRecovery(obs({ journal: entries(prepared) })).kind).toBe('no-mutation')
  })

  it('prepared ∧ ref 존재 → result-ref-unattributed', () => {
    // (A) 에서 ref 는 **composed 저널 뒤**에만 발행된다 — prepared 상태의 ref 는 설명되지 않는다.
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record({ revision: N + 3 }) },
        prefixRefs: refs([REF_N1, OID]),
        journal: entries(prepared),
      }),
    )
    expect(kinds(v)).toContain('result-ref-unattributed')
  })

  it('composed ∧ ref 부재 → no-mutation(ref 발행 전 크래시)', () => {
    expect(classifyRecovery(obs({ journal: entries(journal()) })).kind).toBe('no-mutation')
  })

  it('composed ∧ ref 존재 ∧ OID 불일치 → result-ref-mismatch', () => {
    const v = classifyRecovery(
      obs({
        authority: { kind: 'found', record: record({ revision: N + 3 }) },
        prefixRefs: refs([REF_N1, OID2]),
        journal: entries(journal()),
      }),
    )
    expect(kinds(v)).toContain('result-ref-mismatch')
  })

  it('published 저널은 차단하지 않는다(C6 · 정상 대기)', () => {
    const pub = journal({
      stage: 'published',
      publishedAt: 9,
      expectedAuthorityRevision: N + 1,
      previousAuthorityStage: 'composed',
      nextAuthorityStage: 'published',
    })
    const v = classifyRecovery(
      obs({
        authority: {
          kind: 'found',
          record: record({
            revision: N + 2,
            currentIntegrationStage: 'published',
            currentIntegrationResultOid: OID,
          }),
        },
        journal: entries(pub),
      }),
    )
    expect(v.kind).toBe('normal-wait')
  })

  it('finalized·abandoned 잔존 → 청소 복구(멱등 종결 · 삭제 아님)', () => {
    for (const stage of ['finalized', 'abandoned'] as const) {
      const j = journal({
        stage,
        ...(stage === 'finalized'
          ? { publishedAt: 9, previousAuthorityStage: 'published', nextAuthorityStage: 'finalized' }
          : { abandonedAt: 9, abandonReason: 'user-abandon', nextAuthorityStage: undefined }),
      })
      const v = classifyRecovery(
        obs({
          authority: { kind: 'found', record: record({ revision: N + 3 }) },
          journal: entries(j),
        }),
      )
      expect(v.kind).toBe('idempotent-cleanup')
    }
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
    expect(kinds(v)).toContain('expected-revision-mismatch')
  })

  it('고아 published 저널은 차단하지 않는다(활성 집합 = prepared·composed 뿐 · §3-T33)', () => {
    const orphanPublished = journal({
      txnId: T2,
      stage: 'published',
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
          journal({ stage: 'prepared', resultTree: undefined, resultOid: undefined }),
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
          journal({ stage: 'prepared', resultTree: undefined, resultOid: undefined }),
        ),
      }),
    )
    expect(v.kind).toBe('reconciliation-required')
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
