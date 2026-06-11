import { describe, expect, it } from 'vitest'
import { createResilientHttp } from './resilient'
import type { HttpClient, HttpInit, HttpResponse } from './types'

const noSleep = async (): Promise<void> => {}
const init: HttpInit = { method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal }
const resp = (status: number, body = ''): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
})

describe('createResilientHttp', () => {
  it('returns a 2xx response without retrying', async () => {
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      return resp(200, 'ok')
    }
    const http = createResilientHttp(inner, { sleep: noSleep })
    expect((await http('u', init)).status).toBe(200)
    expect(calls).toBe(1)
  })

  it('retries on 503 then succeeds', async () => {
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      return calls < 3 ? resp(503) : resp(200, 'ok')
    }
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 3 })
    expect((await http('u', init)).status).toBe(200)
    expect(calls).toBe(3)
  })

  it('retries on a thrown network error then succeeds', async () => {
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      if (calls < 2) throw new Error('ECONNRESET')
      return resp(200)
    }
    const http = createResilientHttp(inner, { sleep: noSleep })
    expect((await http('u', init)).status).toBe(200)
    expect(calls).toBe(2)
  })

  it('does not retry on a 4xx response', async () => {
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      return resp(400, 'bad')
    }
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 3 })
    expect((await http('u', init)).status).toBe(400)
    expect(calls).toBe(1)
  })

  it('gives up after exhausting retries and returns the last 5xx', async () => {
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      return resp(500)
    }
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 2 })
    expect((await http('u', init)).status).toBe(500)
    expect(calls).toBe(3) // 1 + 2 retries
  })

  it('rethrows the last error when all attempts throw', async () => {
    const inner: HttpClient = async () => {
      throw new Error('boom')
    }
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 1 })
    await expect(http('u', init)).rejects.toThrow('boom')
  })
})

describe('createResilientHttp — 취소·타임아웃 (run 경로 무결성)', () => {
  it('signal 지정 호출에도 타임아웃 신호를 결합한다(init.signal ?? 가 타임아웃을 우회하던 버그)', async () => {
    let received: AbortSignal | undefined
    const inner: HttpClient = async (_u, i) => {
      received = i.signal
      return resp(200)
    }
    const ac = new AbortController()
    const http = createResilientHttp(inner, { sleep: noSleep, timeoutMs: 50 })
    await http('u', { ...init, signal: ac.signal })
    // 원본 signal 을 그대로 넘기면 타임아웃이 적용되지 않는다(버그) — 결합 신호여야 한다.
    expect(received).toBeDefined()
    expect(received).not.toBe(ac.signal)
  })

  it('signal 지정 호출도 timeoutMs 후 타임아웃된다(사용자 미취소 시 무한 대기 방지)', async () => {
    const ac = new AbortController() // 사용자는 취소하지 않음
    const inner: HttpClient = (_u, i) =>
      new Promise<HttpResponse>((_res, rej) =>
        i.signal?.addEventListener('abort', () => rej(new Error('timed-out'))),
      )
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 0, timeoutMs: 30 })
    await expect(http('u', { ...init, signal: ac.signal })).rejects.toThrow('timed-out')
    expect(ac.signal.aborted).toBe(false) // 발화한 건 타임아웃이지 사용자 취소가 아님
  }, 3000)

  it('사용자 취소(init.signal abort)는 재시도 없이 즉시 throw 한다', async () => {
    const ac = new AbortController()
    let calls = 0
    const inner: HttpClient = async (_u, i) => {
      calls++
      if (i.signal?.aborted) throw new Error('aborted')
      ac.abort() // 첫 시도 도중 사용자 취소
      throw new Error('aborted')
    }
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 3 })
    await expect(http('u', { ...init, signal: ac.signal })).rejects.toThrow('aborted')
    expect(calls).toBe(1) // 취소는 백오프 재시도하지 않는다(기존 버그: 1+3=4회 호출)
  })

  it('네트워크 오류(취소 아님)는 기존대로 재시도한다', async () => {
    const ac = new AbortController() // 미abort
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      if (calls < 2) throw new Error('ECONNRESET')
      return resp(200)
    }
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 2 })
    expect((await http('u', { ...init, signal: ac.signal })).status).toBe(200)
    expect(calls).toBe(2) // init.signal 미abort → 정상 재시도(가드는 취소만 단락)
  })

  it('타임아웃 발화(취소 아님)는 재시도해 성공한다(가드가 타임아웃을 단락하지 않음)', async () => {
    const ac = new AbortController() // 사용자 미취소
    let calls = 0
    const inner: HttpClient = (_u, i) =>
      new Promise<HttpResponse>((resolve, reject) => {
        calls++
        if (calls < 2) {
          // 1차: per-attempt 타임아웃이 발화할 때까지 대기 → 결합 신호 abort 로 reject(타임아웃).
          i.signal?.addEventListener('abort', () => reject(new Error('attempt-timeout')))
        } else {
          resolve(resp(200)) // 2차: 즉시 성공
        }
      })
    const http = createResilientHttp(inner, { sleep: noSleep, retries: 2, timeoutMs: 25 })
    expect((await http('u', { ...init, signal: ac.signal })).status).toBe(200)
    expect(calls).toBe(2) // 타임아웃 발화 → init.signal 미abort → 재시도 → 성공
    expect(ac.signal.aborted).toBe(false) // 사용자 신호는 한 번도 abort 되지 않음
  }, 3000)

  it('백오프 sleep 도중 사용자 취소가 도착하면 즉시 풀린다(재시도 없음 — 기본 sleep 은 abort 인지)', async () => {
    const ac = new AbortController()
    let calls = 0
    const inner: HttpClient = async () => {
      calls++
      if (calls === 1) setTimeout(() => ac.abort(), 10) // 첫 응답 후 백오프 sleep 도중 취소
      return resp(503) // 항상 재시도 대상 → 백오프 진입
    }
    // 기본 sleep(주입 안 함) 사용 — 백오프 250ms 도중 10ms 에 취소가 도착하면 즉시 reject 되어야 한다.
    const http = createResilientHttp(inner, { retries: 3, timeoutMs: 60_000 })
    await expect(http('u', { ...init, signal: ac.signal })).rejects.toThrow()
    expect(calls).toBe(1) // 백오프 중 취소 → 다음 시도 없음(미수정 시: 백오프 다 기다린 뒤 재시도)
  }, 3000)
})
