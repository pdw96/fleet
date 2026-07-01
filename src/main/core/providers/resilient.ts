import type { HttpClient, HttpResponse } from './types'

export interface ResilientOptions {
  /** 추가 재시도 횟수 (기본 2 → 최대 3회 시도). */
  retries?: number
  /** 신호 미지정 호출에 적용할 기본 타임아웃 ms (기본 120초). */
  timeoutMs?: number
  /** 백오프 지연 주입(테스트). 기본은 setTimeout 기반이되 signal abort 시 조기 reject(취소 즉시 반영). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /**
   * 서버 지정 Retry-After 대기의 상한 ms — 과대치(예: 3600s)로 인한 무한대기 방지 (기본 60초·양수 가정).
   * 최악 지연 ≈ retries × maxRetryAfterMs(기본 2×60s) + 요청시간이며, 백오프 sleep 은 사용자 취소를
   * 즉시 반영하므로(init.signal) 무취소 행은 아니다.
   */
  maxRetryAfterMs?: number
  /** 현재시각 주입(테스트) — Retry-After HTTP-date 환산 기준. 기본 Date.now. */
  now?: () => number
}

/**
 * 429/5xx 응답의 서버 지정 재시도 대기(ms)를 파싱한다. 헤더 부재·비정수·과거시각이면 null(지수 폴백 신호).
 * - `retry-after-ms`(밀리초 정수)를 우선한다(Anthropic/OpenAI 확장, 초 헤더보다 정밀).
 * - `Retry-After`(RFC 7231): 정수 delta-seconds 또는 HTTP-date. HTTP-date 는 now 기준 남은 ms 로 환산.
 *
 * 정수는 `^\d+$` 로만 수용한다 — `Number()` 의 관대함(빈 문자열→0·과학표기 `1e3`·hex `0x10`·부호)을
 * 배제해, 빈/비표준 헤더가 0ms(백오프 제거·과부하 서버 즉시 재시도) 또는 예상외 대기로 파싱되지 않게 한다.
 * 정수 형태가 아니면 HTTP-date 파싱으로 넘기고, 그마저 실패(NaN)·과거면 null(지수 폴백).
 */
function parseRetryAfter(res: HttpResponse, nowMs: number): number | null {
  const ms = res.header?.('retry-after-ms')
  if (ms != null && /^\d+$/.test(ms.trim())) return Number(ms.trim())
  const ra = res.header?.('retry-after')
  if (ra == null) return null
  const trimmed = ra.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const dateMs = Date.parse(ra)
  if (Number.isNaN(dateMs)) return null
  const delta = dateMs - nowMs
  return delta >= 0 ? delta : null
}

/** 기본 백오프 sleep — signal 이 abort 되면(사용자 취소) 타이머를 끊고 즉시 reject 한다. */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // abort 사유(signal.reason)를 그대로 전파한다 — 취소 사유 보존이 의도. reason 은 관례상 DOMException.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason)
      },
      { once: true },
    )
  })

/** 재시도 대상 상태코드: 429(rate limit) + 5xx(서버 일시 오류). 4xx 는 재시도하지 않는다. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** 지수 백오프: 250ms, 500ms, 1000ms, … */
function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt
}

/**
 * HttpClient 를 타임아웃 + 재시도로 감싼다.
 * - 모든 호출에 기본 타임아웃(AbortSignal.timeout)을 적용해 무한 대기를 막는다. 호출자 signal 이
 *   있으면(run 경로 planner/reviewer/summarizer) 그 신호와 타임아웃을 AbortSignal.any 로 결합한다
 *   — 과거 `init.signal ?? timeout` 은 signal 지정 호출의 타임아웃을 통째 우회해 run 경로가 무한 대기했다.
 * - 429/5xx 응답은 서버 지정 Retry-After(있으면 존중·maxRetryAfterMs 상한 clamp), 없거나 무효면 지수 백오프로
 *   재시도한다. 네트워크 throw 는 지수 백오프. 한도 초과 시 마지막 결과/에러를 그대로 전달한다.
 * - **사용자 취소**(init.signal abort)는 재시도하지 않고 즉시 throw 한다 — 백오프 재시도로 취소가
 *   ~750ms 지연되면 취소·종료 무결성이 깨진다. 타임아웃 발화(init.signal 미abort)는 재시도를 유지한다.
 *   백오프 sleep 도중 취소가 도착해도 기본 sleep 이 조기 reject 하므로 취소가 대기로 묻히지 않는다.
 */
export function createResilientHttp(inner: HttpClient, opts: ResilientOptions = {}): HttpClient {
  const retries = opts.retries ?? 2
  const timeoutMs = opts.timeoutMs ?? 120_000
  const sleep = opts.sleep ?? defaultSleep
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000
  const now = opts.now ?? Date.now

  return async (url, init) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 호출자 signal 과 시도별 타임아웃을 결합한다(둘 중 하나라도 발화하면 abort). signal 미지정이면 타임아웃만.
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      try {
        const res = await inner(url, { ...init, signal })
        if (isRetryable(res.status) && attempt < retries) {
          // 서버 지정 Retry-After 가 있으면 그 대기를 존중(상한 maxRetryAfterMs 로 clamp), 없거나 무효면 지수
          // 폴백(clamp 미적용 — catch 경로의 지수 백오프와 대칭). 백오프에 init.signal 을 넘겨 sleep 도중 취소가
          // 오면 즉시 풀리게 한다(취소면 catch 의 가드가 throw).
          const serverWait = parseRetryAfter(res, now())
          const wait =
            serverWait != null ? Math.min(serverWait, maxRetryAfterMs) : backoffMs(attempt)
          await sleep(wait, init.signal)
          continue
        }
        return res
      } catch (err) {
        lastErr = err
        // 사용자 취소는 즉시 throw — 재시도하면 취소가 백오프만큼 지연된다. 타임아웃은 init.signal 이
        // abort 되지 않으므로 이 가드를 통과해 정상 재시도된다.
        if (init.signal?.aborted) throw err
        if (attempt < retries) {
          await sleep(backoffMs(attempt), init.signal)
          continue
        }
        throw err
      }
    }
    throw lastErr // 도달 불가(루프가 항상 return/throw)지만 타입 안전성 보장
  }
}
