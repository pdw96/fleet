import { describe, expect, it } from 'vitest'

import { RESULT_REF_ROOT, formatResultRef, parseResultRef, resultRefPrefix } from './result-ref'

/**
 * §3-T75 계열 — 결과 ref 문법(계획 정정 192·196).
 *
 * 문법 = `refs/fleet/integrated/<benchId>/<resultingRevision>-<txnId>` ·
 * **10진 가변폭 · 선행 0 금지 · 파싱 실패 fail-closed**.
 *
 * ⚠ 이 파일이 고정하는 핵심은 **`resultingRevision` 은 `expectedAuthorityRevision + 1`** 이라는 것이다
 * (정정 196 P1). 초안은 두 값을 같다고 적었고, 그러면 ref 발행에 결속된 **바로 그 CAS** 가 롤백돼도
 * `N > N` 이 거짓이라 앵커가 영원히 침묵한다.
 */

const BENCH = '01J8Z4T7K9QW3M5N7P9R1S3T5V'
const TXN = '01J8Z4T7K9QW3M5N7P9R1S3T5W'

describe('결과 ref 문법 — 조립', () => {
  it('`<root>/<benchId>/<resultingRevision>-<txnId>` 로 조립한다', () => {
    expect(formatResultRef(BENCH, 42, TXN)).toBe(`${RESULT_REF_ROOT}/${BENCH}/42-${TXN}`)
  })

  it('열거 접두는 **경로 성분 경계**로 끝난다 — 이웃 benchId 를 삼키지 않는다', () => {
    // `git.ts:198` 실측: 접두는 경로 성분 경계로 매칭되므로 `…/BX` 는 `…/BXY/T9` 를 답하지 않는다.
    // 그 성질에 의존하려면 접두 자신이 성분 경계여야 한다.
    expect(resultRefPrefix(BENCH)).toBe(`${RESULT_REF_ROOT}/${BENCH}/`)
  })

  it('revision 이 안전 정수 ∧ >= 1 이 아니면 조립을 거부한다', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatResultRef(BENCH, bad, TXN)).toThrow(/resultingRevision/)
    }
  })

  it('benchId·txnId 가 ULID 문법이 아니면 조립을 거부한다 — 정규화하지 않고 거부', () => {
    // PR1a `ulid.ts` 의 「정규화 금지 · 거부」 규율. 소문자를 대문자로 접으면 win32 case-fold 에서
    // 두 이름이 같은 ref 를 가리키는 비단사 매핑이 된다.
    expect(() => formatResultRef(BENCH.toLowerCase(), 1, TXN)).toThrow(/benchId/)
    expect(() => formatResultRef(BENCH, 1, TXN.toLowerCase())).toThrow(/txnId/)
  })
})

describe('결과 ref 문법 — 파싱', () => {
  it('왕복한다', () => {
    const parsed = parseResultRef(formatResultRef(BENCH, 7, TXN))
    expect(parsed).toEqual({ kind: 'ok', benchId: BENCH, resultingRevision: 7, txnId: TXN })
  })

  it('선행 0 을 거부한다 — `01` 과 `1` 이 같은 revision 을 가리키면 비단사다', () => {
    const r = parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/07-${TXN}`)
    expect(r).toEqual({ kind: 'invalid', reason: 'revision-syntax' })
  })

  it('`0`·음수·소수·비10진을 거부한다', () => {
    for (const rev of ['0', '-1', '1.5', '0x10', '1e3', '+1', ' 1', '1 ']) {
      expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/${rev}-${TXN}`)).toEqual({
        kind: 'invalid',
        reason: 'revision-syntax',
      })
    }
  })

  it('안전 정수 범위를 넘는 revision 을 거부한다 — 가변폭이라 자릿수 상한이 없다', () => {
    // 고정폭을 폐기한 대가(정정 192): 이름은 임의 길이 숫자를 실을 수 있으므로 **파싱이** 상한을 본다.
    const huge = '9'.repeat(30)
    expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/${huge}-${TXN}`)).toEqual({
      kind: 'invalid',
      reason: 'revision-range',
    })
  })

  it('ULID 가 아닌 benchId·txnId 를 거부한다', () => {
    expect(parseResultRef(`${RESULT_REF_ROOT}/nope/1-${TXN}`)).toEqual({
      kind: 'invalid',
      reason: 'benchid-syntax',
    })
    expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/1-nope`)).toEqual({
      kind: 'invalid',
      reason: 'txnid-syntax',
    })
  })

  it('bare 부모 ref 를 **별도 종별**로 답한다 — D/F 충돌 최우선 판정의 입력', () => {
    // spec §W-7:828 「`refs/fleet/integrated/<benchId>` 가 ref 로 존재 = REF_NAMESPACE_CONFLICT 최우선」.
    // 이것을 「문법 오류」로 뭉개면 최우선 종별이 일반 blocker 에 섞인다.
    expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}`)).toEqual({
      kind: 'namespace-conflict',
      benchId: BENCH,
    })
  })

  it('ULID 가 아닌 단일 성분은 namespace-conflict 가 **아니라** 문법 오류다', () => {
    // 미겨냥 축(자기검사): 「깊이 1 = namespace-conflict」로만 구현하면 우리 네임스페이스와 무관한
    // 쓰레기 이름이 **최우선 fail-closed 종별**을 참칭한다. 최우선 종별은 참칭당하면 안 된다.
    expect(parseResultRef(`${RESULT_REF_ROOT}/nope`)).toEqual({
      kind: 'invalid',
      reason: 'benchid-syntax',
    })
  })

  it('루트 자신을 거부한다', () => {
    expect(parseResultRef(RESULT_REF_ROOT)).toEqual({ kind: 'invalid', reason: 'benchid-syntax' })
  })

  it('루트 밖·깊이 초과를 거부한다', () => {
    expect(parseResultRef(`refs/heads/${BENCH}/1-${TXN}`)).toEqual({
      kind: 'invalid',
      reason: 'not-in-root',
    })
    expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/1-${TXN}/extra`)).toEqual({
      kind: 'invalid',
      reason: 'depth',
    })
  })

  it('구분자가 없거나 여러 개인 이름을 거부한다', () => {
    expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/1${TXN}`)).toEqual({
      kind: 'invalid',
      reason: 'revision-syntax',
    })
    // txnId 자체는 ULID 라 `-` 를 포함할 수 없다 → 첫 `-` 하나로만 자르는 것이 계약이다.
    expect(parseResultRef(`${RESULT_REF_ROOT}/${BENCH}/1-2-${TXN}`)).toEqual({
      kind: 'invalid',
      reason: 'txnid-syntax',
    })
  })
})

describe('산술 결속 — refRevision = expectedAuthorityRevision + 1 (정정 196)', () => {
  it('`expectedAuthorityRevision` 그대로가 아니라 **+1** 이 ref 에 실린다', () => {
    // 이 행이 이 PR 의 P1 회귀 핀이다. `journal.ts:115` 의 expected 는 「CAS 가 **맞출**」 값(현재 N)이고
    // `authority.ts:1307` 은 `observedRevision + 1` 을 기록한다. 두 값을 같다고 두면 ref 발행에 결속된
    // 바로 그 CAS 의 롤백을 앵커가 못 잡는다.
    const expectedAuthorityRevision = 41
    const ref = formatResultRef(BENCH, expectedAuthorityRevision + 1, TXN)
    const parsed = parseResultRef(ref)
    expect(parsed).toMatchObject({ kind: 'ok', resultingRevision: 42 })
  })
})
