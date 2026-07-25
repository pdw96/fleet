import { randomBytes } from 'node:crypto'

/**
 * ULID 자체 구현 (#251 · 스펙 §W-1) — Workbench id 생성·검증.
 *
 * **왜 자체 구현인가**: npm `ulid` 대비 이득이 없다(48bit ms + 80bit 랜덤 + Crockford Base32 가 전부).
 * AGENTS.md 「코어는 Node 표준 + 소수 순수 패키지」 정합 · 신규 의존성 **0**.
 *
 * **왜 이 id 가 계약인가**: bench 경로 유도의 **유일한 가변 성분**이다(`benchDir = join(benchRoot, id)`).
 * `git.ts:79` 의 `sanitize`(`[^a-zA-Z0-9_-] → _`)는 **비단사**(`a/b`·`a?b` → `a_b`)라 bench 경로에
 * 사용 금지(§0.1 C12). 그래서 여기서는 **정규화하지 않고 거부**한다 — 통과 집합 안에서 서로 다른 두
 * id 가 같은 디렉터리로 붕괴하지 않는 것이 불변식이고, 그 주 붕괴 벡터가 win32 대소문자 무시 FS 라
 * **소문자 거부는 스타일이 아니라 단사 계약의 집행**이다.
 */

/** Crockford Base32 — 오독 쌍(I/1 · L/1 · O/0 · U/V)을 없앤 32글자. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 시간 성분 = 48bit ms → base32 10자(10자는 50bit 용량이라 상위 2bit 는 항상 0 → 선두 ≤ '7'). */
const TIME_LEN = 10
/** 랜덤 성분 = 80bit = 10바이트 → base32 16자(16*5 = 80, 패딩 없음). */
const RANDOM_BYTES = 10
const RANDOM_LEN = 16
const MAX_TIME_MS = 2 ** 48 - 1

/**
 * ULID 문법. **전역 플래그를 붙이지 않는다** — `g` 는 `lastIndex` 를 남겨 같은 값의 반복 `test` 가
 * 번갈아 false 가 되는 무신호 회귀를 만든다(검증기는 상태를 가지면 안 된다).
 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 검증(정규화 금지). 통과 = 「그대로 디렉터리명으로 안전하고 단사」. */
export function isUlid(value: string): boolean {
  return typeof value === 'string' && ULID_RE.test(value)
}

const encodeTime = (ms: number): string => {
  let out = ''
  let n = ms
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[n % 32] + out
    n = Math.floor(n / 32)
  }
  return out
}

// 80bit 는 Number 의 안전 정수(53bit)를 넘으므로 BigInt 로 누산한다(32bit 비트연산 절단 회피).
const encodeRandom = (bytes: Uint8Array): string => {
  let acc = 0n
  for (const b of bytes) acc = (acc << 8n) | BigInt(b)
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ALPHABET[Number(acc & 31n)] + out
    acc >>= 5n
  }
  return out
}

/**
 * ULID 생성. `now`·`random` 은 **테스트 결정론용 주입 seam**(§3.2) — 미주입이면 `Date.now()` +
 * `crypto.randomBytes`.
 *
 * 시간 인자 오설정은 **throw** 한다(조용한 절단·랩어라운드 금지) — 절단하면 서로 다른 시각이 같은
 * 접두를 갖게 되어 정렬 계약이 조용히 깨진다.
 */
export function newUlid(
  now: number = Date.now(),
  random: (size: number) => Uint8Array = randomBytes,
): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME_MS) {
    throw new Error(`ULID 시간 인자가 48bit ms 범위를 벗어남: ${now}`)
  }
  const bytes = random(RANDOM_BYTES)
  if (bytes.length !== RANDOM_BYTES) {
    throw new Error(`ULID 랜덤원이 ${RANDOM_BYTES}바이트를 반환해야 함(실제 ${bytes.length})`)
  }
  return encodeTime(now) + encodeRandom(bytes)
}

/** 시간 성분 복호(진단·정렬 검증용). **검증된 값에만 답한다** — 문법 위반은 throw(암묵 통과 금지). */
export function decodeUlidTime(id: string): number {
  if (!isUlid(id)) throw new Error(`ULID 문법 위반: ${JSON.stringify(id)}`)
  let n = 0
  for (const ch of id.slice(0, TIME_LEN)) n = n * 32 + ALPHABET.indexOf(ch)
  return n
}
