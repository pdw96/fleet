/**
 * 통합 결과 ref 의 문법(§W-7 C1 · 계획 정정 192·196). **문법 소유는 이 PR(PR3c)이다** — PR3b 저널은
 * `resultRef` 를 「비어 있지 않은 문자열」까지만 봤고(정정 174), 여기서 파싱·조립을 확정한다.
 *
 * ```text
 * refs/fleet/integrated/<benchId>/<resultingRevision>-<txnId>
 * ```
 *
 * **`resultingRevision` = `journal.expectedAuthorityRevision + 1`** 이다(정정 196 · Codex 체크포인트 1R P1).
 * 저널의 `expectedAuthorityRevision` 은 「이어질 CAS 가 **맞출**(비교할) revision」(= 현재값 `N`)이고
 * `authority.ts` 의 CAS 는 `observedRevision + 1` 을 **기록**한다. 두 값을 같다고 두면 ref 발행에 결속된
 * **바로 그 CAS** 가 롤백돼도 `N > N` 이 거짓이라 앵커가 침묵한다 — 정정 169 가 막으려던 revision
 * 재사용의 가장 짧은 형태다.
 *
 * **고정폭을 쓰지 않는다**(정정 192 가 정정 166 을 폐기). 이름을 문자열 정렬하지 않고 파싱해 숫자로
 * 비교하므로 고정폭은 이득이 0 이면서 자릿수 상한 초과 시 문법 붕괴라는 실패 모드만 만든다. 대신
 * **선행 0 을 거부**한다 — `01` 과 `1` 이 같은 revision 을 가리키면 비단사 매핑이다(PR1a `ulid.ts` 의
 * 「정규화 금지 · 거부」와 같은 규율).
 */

import { ULID_RE } from './ulid'

/** ref 네임스페이스 루트. 접두 열거의 기준이기도 하다. */
export const RESULT_REF_ROOT = 'refs/fleet/integrated'

/** 10진 · 선행 0 금지 · `0` 금지(revision 은 1부터 · `checkInvariants` ⑧). */
const REVISION_RE = /^[1-9][0-9]*$/

export type ParsedResultRef =
  | {
      readonly kind: 'ok'
      readonly benchId: string
      readonly resultingRevision: number
      readonly txnId: string
    }
  /**
   * `refs/fleet/integrated/<benchId>` 자신이 ref 로 존재하는 상태(D/F 충돌). spec §W-7:828 이 이것을
   * **최우선** fail-closed 로 규정하므로 일반 문법 오류와 **섞지 않는다** — 섞으면 최우선 종별이
   * blocker 집합에서 다른 사유에 가려진다.
   */
  | { readonly kind: 'namespace-conflict'; readonly benchId: string }
  | { readonly kind: 'invalid'; readonly reason: ParseFailureReason }

export type ParseFailureReason =
  'not-in-root' | 'depth' | 'benchid-syntax' | 'revision-syntax' | 'revision-range' | 'txnid-syntax'

const assertUlid = (value: string, label: 'benchId' | 'txnId'): void => {
  if (!ULID_RE.test(value)) {
    throw new Error(
      `${label} 가 ULID 문법이 아니다(정규화하지 않고 거부한다): ${JSON.stringify(value)}`,
    )
  }
}

/**
 * 조립. **거부는 throw** 다 — 호출자는 전부 이 모듈이 소유한 값(권위 revision · 검증된 ULID)을 넘기므로
 * 실패는 프로그래밍 오류이지 데이터 오류가 아니다(파싱 쪽과 대칭이 아닌 것이 의도다).
 */
export function formatResultRef(benchId: string, resultingRevision: number, txnId: string): string {
  assertUlid(benchId, 'benchId')
  assertUlid(txnId, 'txnId')
  if (!Number.isSafeInteger(resultingRevision) || resultingRevision < 1) {
    throw new Error(
      `resultingRevision 은 안전 정수 ∧ >= 1 이어야 한다: ${String(resultingRevision)}`,
    )
  }
  return `${RESULT_REF_ROOT}/${benchId}/${String(resultingRevision)}-${txnId}`
}

/**
 * 열거 접두. **경로 성분 경계로 끝난다** — `git.ts:198` 실측이 「접두는 경로 성분 경계로 매칭된다」이므로
 * 그 성질에 기대려면 접두 자신이 경계여야 한다(`…/BX` 가 `…/BXY/T9` 를 삼키지 않는 근거).
 */
export function resultRefPrefix(benchId: string): string {
  assertUlid(benchId, 'benchId')
  return `${RESULT_REF_ROOT}/${benchId}/`
}

/** 파싱. **fail-closed** — 어떤 실패도 「결과 없음」으로 축소하지 않는다(정정 191 · §3-T78). */
export function parseResultRef(refName: string): ParsedResultRef {
  if (refName !== RESULT_REF_ROOT && !refName.startsWith(`${RESULT_REF_ROOT}/`)) {
    return { kind: 'invalid', reason: 'not-in-root' }
  }
  const rest = refName.slice(RESULT_REF_ROOT.length + 1)
  const parts = rest.split('/')

  // bare 부모 = `…/<benchId>` 로 깊이 1. benchId 문법이 성립할 때만 namespace-conflict 로 답한다 —
  // 문법조차 아닌 이름은 우리 네임스페이스의 D/F 충돌 증거가 아니다.
  if (parts.length === 1) {
    const [benchId] = parts
    if (benchId !== undefined && ULID_RE.test(benchId))
      return { kind: 'namespace-conflict', benchId }
    return { kind: 'invalid', reason: 'benchid-syntax' }
  }
  if (parts.length !== 2) return { kind: 'invalid', reason: 'depth' }

  const [benchId, leaf] = parts
  if (benchId === undefined || !ULID_RE.test(benchId)) {
    return { kind: 'invalid', reason: 'benchid-syntax' }
  }
  if (leaf === undefined) return { kind: 'invalid', reason: 'revision-syntax' }

  // **첫 `-` 하나로만** 자른다. txnId 는 ULID 라 `-` 를 포함할 수 없으므로, 뒤에 `-` 가 더 있으면
  // 그것은 txnId 문법 위반으로 드러난다(구분자 개수를 따로 세지 않는다).
  const sep = leaf.indexOf('-')
  if (sep < 0) return { kind: 'invalid', reason: 'revision-syntax' }
  const revText = leaf.slice(0, sep)
  const txnId = leaf.slice(sep + 1)

  if (!REVISION_RE.test(revText)) return { kind: 'invalid', reason: 'revision-syntax' }
  const resultingRevision = Number(revText)
  // 가변폭의 대가 — 이름은 임의 길이 숫자를 실을 수 있으므로 **파싱이** 상한을 본다.
  if (!Number.isSafeInteger(resultingRevision)) return { kind: 'invalid', reason: 'revision-range' }

  if (!ULID_RE.test(txnId)) return { kind: 'invalid', reason: 'txnid-syntax' }

  return { kind: 'ok', benchId, resultingRevision, txnId }
}
