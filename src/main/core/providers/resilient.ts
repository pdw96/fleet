import type { HttpClient } from './types'

export interface ResilientOptions {
  /** 추가 재시도 횟수 (기본 2 → 최대 3회 시도). */
  retries?: number
  /** 신호 미지정 호출에 적용할 기본 타임아웃 ms (기본 120초). */
  timeoutMs?: number
  /** 백오프 지연 주입(테스트). 기본 setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

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
 * - 신호 미지정 호출에는 기본 타임아웃(AbortSignal.timeout)을 적용해 무한 대기를 막는다.
 * - 네트워크 throw 또는 429/5xx 응답은 지수 백오프로 재시도하고, 한도 초과 시 마지막 결과/에러를 그대로 전달한다.
 */
export function createResilientHttp(inner: HttpClient, opts: ResilientOptions = {}): HttpClient {
  const retries = opts.retries ?? 2
  const timeoutMs = opts.timeoutMs ?? 120_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  return async (url, init) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      const signal = init.signal ?? AbortSignal.timeout(timeoutMs)
      try {
        const res = await inner(url, { ...init, signal })
        if (isRetryable(res.status) && attempt < retries) {
          await sleep(backoffMs(attempt))
          continue
        }
        return res
      } catch (err) {
        lastErr = err
        if (attempt < retries) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw err
      }
    }
    throw lastErr // 도달 불가(루프가 항상 return/throw)지만 타입 안전성 보장
  }
}
