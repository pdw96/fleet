import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeUlidTime, isUlid, newUlid, ULID_RE } from './ulid'

/**
 * T1 — ULID 문법·**단사** (#251 PR1 · 스펙 §W-1 · 계약 테스트 §3-T1).
 *
 * bench 경로 유도의 **유일한 가변 성분**이 이 id 다(`benchDir = join(benchRoot, id)`). `git.ts:79` 의
 * `sanitize`(`[^a-zA-Z0-9_-] → _`)는 **비단사**라 bench 경로에 쓸 수 없다(§0.1 C12) — 그래서 여기서는
 * 정규화(sanitize)를 **하지 않고 거부**한다. 즉 이 모듈의 계약은 「통과한 값은 그대로 디렉터리명으로
 * 안전하다」이며, 통과 집합 안에서 **서로 다른 두 id 가 같은 경로로 붕괴하지 않는다**가 핵심 불변식이다.
 *
 * 붕괴 벡터는 win32 대소문자 무시 FS 다 — 소문자를 통과시키는 순간 `01ARZ…` 와 `01arz…` 가 같은
 * 디렉터리가 된다. 그래서 소문자 거부는 스타일이 아니라 **단사 계약의 집행**이다.
 */
describe('T1 — ULID 문법 검증(정규화 금지 · 거부)', () => {
  const VALID = '01JZ8QK9WGZR3T5VXY7NPQ0ABC'

  it('앵커: 표본이 실제로 26자 Crockford Base32 다(아래 거부 단언이 vacuous 가 되지 않게)', () => {
    expect(VALID).toHaveLength(26)
    expect(isUlid(VALID)).toBe(true)
  })

  it('ULID_RE 는 스펙 §W-1 문법과 정확히 같다', () => {
    expect(ULID_RE.source).toBe('^[0-9A-HJKMNP-TV-Z]{26}$')
    // 전역 플래그가 붙으면 `lastIndex` 때문에 같은 값의 반복 검사가 번갈아 false 가 된다(무신호 회귀).
    expect(ULID_RE.flags).toBe('')
  })

  it.each([
    ['25자(1 짧음)', VALID.slice(0, 25)],
    ['27자(1 김)', `${VALID}Z`],
    ['빈 문자열', ''],
    ['소문자 — win32 case-fold 붕괴 벡터', VALID.toLowerCase()],
    ['혼합 대소문자', `${VALID.slice(0, 25)}c`],
    ['I(제외 문자)', `${VALID.slice(0, 25)}I`],
    ['L(제외 문자)', `${VALID.slice(0, 25)}L`],
    ['O(제외 문자)', `${VALID.slice(0, 25)}O`],
    ['U(제외 문자)', `${VALID.slice(0, 25)}U`],
    ['상위 경로 이스케이프(..)', '..'],
    ['경로 구분자 포함', `${VALID.slice(0, 12)}/${VALID.slice(13)}`],
    ['백슬래시 포함(win32 구분자)', `${VALID.slice(0, 12)}\\${VALID.slice(13)}`],
    ['NUL 바이트', `${VALID.slice(0, 25)}\u0000`],
    ['개행(제어문자)', `${VALID.slice(0, 25)}\n`],
    ['탭(제어문자)', `${VALID.slice(0, 25)}\t`],
    ['전각 숫자', `${VALID.slice(0, 25)}０`],
    ['한글', `${VALID.slice(0, 23)}한글자`],
    ['앞뒤 공백', ` ${VALID} `],
    ['선행 대시(옵션 오인)', `-${VALID.slice(1)}`],
    ['점 포함', `${VALID.slice(0, 25)}.`],
  ])('거부: %s', (_label, bad) => {
    expect(isUlid(bad)).toBe(false)
  })

  // 반증력: `\n` 은 `$` 가 줄끝에도 매치하므로 `/^…$/` 를 멀티라인이나 `.test` 오용으로 쓰면 통과한다.
  it('개행이 포함된 26자 접두는 거부된다(`$` 줄끝 매치 함정)', () => {
    expect(isUlid(`${VALID}\n`)).toBe(false)
    expect(isUlid(`${VALID}\nX`)).toBe(false)
  })
})

describe('T1 — 단사(injective): 통과한 두 id 는 같은 경로로 정규화되지 않는다', () => {
  const BENCH_ROOT = join('C:', 'wb')

  it('생성 표본 2,000개가 win32 case-fold 후에도 전부 서로 다른 경로다', () => {
    const ids = Array.from({ length: 2000 }, () => newUlid())
    expect(new Set(ids).size).toBe(ids.length) // 앵커: 표본 자체에 중복이 없다
    const folded = ids.map((id) => join(BENCH_ROOT, id).toLowerCase())
    expect(new Set(folded).size).toBe(ids.length)
  })

  it('NFC/NFD 정규화로도 붕괴하지 않는다(macOS NFD FS 대비)', () => {
    const ids = Array.from({ length: 500 }, () => newUlid())
    const normalized = ids.map((id) => id.normalize('NFD'))
    expect(new Set(normalized).size).toBe(ids.length)
    // 통과 집합이 ASCII 전용이라 정규화가 항등이어야 한다(비ASCII 가 새면 이 단언이 RED).
    expect(normalized).toEqual(ids)
  })

  // 반증력: `sanitize`(비단사) 를 재도입한 구현이면 이 행이 RED 다 — 두 유효 id 가 같은 값으로 붕괴한다.
  it('검증은 정규화하지 않는다 — 거부값을 고쳐서 통과시키지 않는다', () => {
    const lower = newUlid().toLowerCase()
    expect(isUlid(lower)).toBe(false)
  })
})

describe('T1 — 생성 계약(48bit ms + 80bit 랜덤 · 신규 의존성 0)', () => {
  it('생성값은 항상 문법을 만족한다(1,000회)', () => {
    for (let i = 0; i < 1000; i++) expect(isUlid(newUlid())).toBe(true)
  })

  it('시간 성분이 왕복한다(상위 10자 = 48bit ms)', () => {
    const now = 1_770_000_000_000
    expect(decodeUlidTime(newUlid(now))).toBe(now)
  })

  it('같은 ms 안에서도 랜덤 성분으로 갈린다(충돌 없음)', () => {
    const now = 1_770_000_000_000
    const ids = Array.from({ length: 500 }, () => newUlid(now))
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(1) // 시간 접두는 동일
  })

  it('시간 접두가 사전순 정렬 = 시간순 정렬이다(lexicographic sortability)', () => {
    const a = newUlid(1_700_000_000_000)
    const b = newUlid(1_700_000_000_001)
    const c = newUlid(1_800_000_000_000)
    expect([c, a, b].sort()).toEqual([a, b, c])
  })

  it('랜덤원 주입으로 결정론 생성이 가능하다(테스트 결정론 정책 §3.2)', () => {
    const fixed = (n: number): Uint8Array => new Uint8Array(n).fill(0)
    expect(newUlid(0, fixed)).toBe('0000000000' + '0'.repeat(16))
    const maxed = (n: number): Uint8Array => new Uint8Array(n).fill(0xff)
    expect(newUlid(0, maxed)).toBe('0000000000' + 'Z'.repeat(16))
  })

  it('랜덤원이 요청 바이트 수를 정확히 받는다(10바이트 = 80bit)', () => {
    const seen: number[] = []
    newUlid(0, (n) => {
      seen.push(n)
      return new Uint8Array(n)
    })
    expect(seen).toEqual([10])
  })

  it.each([
    ['음수', -1],
    ['48bit 초과', 2 ** 48],
    ['비정수', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('시간 인자 오설정(%s) = throw — 조용한 절단 금지', (_label, bad) => {
    expect(() => newUlid(bad)).toThrow(/ULID/)
  })

  it('48bit 상한 경계는 통과한다(2^48-1)', () => {
    const max = 2 ** 48 - 1
    expect(decodeUlidTime(newUlid(max))).toBe(max)
    // 10자 base32 는 50bit 를 담을 수 있고 48bit 상한은 그중 상위 2bit 가 0 이라 선두가 '7' 이다
    // (ULID 표준의 최대 타임스탬프 표기와 동일). 'Z'*10 을 기대하면 그건 2^50-1 이라 오답이다.
    expect(newUlid(max).slice(0, 10)).toBe('7ZZZZZZZZZ')
  })

  it('랜덤원이 요청보다 짧은 배열을 주면 throw(조용한 짧은 id 금지)', () => {
    expect(() => newUlid(0, (n) => new Uint8Array(n - 1))).toThrow(/ULID/)
  })
})

describe('T1 — decodeUlidTime 은 검증된 값에만 답한다', () => {
  it('문법 위반 입력은 throw(암묵 통과 금지)', () => {
    expect(() => decodeUlidTime('not-a-ulid')).toThrow(/ULID/)
    expect(() => decodeUlidTime(newUlid().toLowerCase())).toThrow(/ULID/)
  })
})
