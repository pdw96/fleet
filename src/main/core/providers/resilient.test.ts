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
