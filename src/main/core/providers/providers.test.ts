import { describe, expect, it } from 'vitest'
import type { ApiProviderConfig } from '../../../shared/types'
import { createAnthropicProvider } from './anthropic'
import { createGoogleProvider } from './google'
import { createOpenAiProvider } from './openai'
import { createApiProvider } from './registry'
import { ApiProviderError, type HttpClient, type HttpInit } from './types'

interface Captured {
  url: string
  init: HttpInit
}

function mockHttp(
  responder: (url: string, init: HttpInit) => { ok?: boolean; status?: number; body: string },
): { http: HttpClient; calls: Captured[] } {
  const calls: Captured[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const r = responder(url, init)
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.body }
  }
  return { http, calls }
}

const baseAnthropic: ApiProviderConfig = {
  id: 'a1',
  provider: 'anthropic',
  displayName: 'Claude',
  model: 'claude-sonnet-4',
  apiKey: 'key-a',
  maxTokens: 256,
}

describe('AnthropicProvider', () => {
  it('splits system, maps turns, parses text blocks', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ content: [{ type: 'text', text: '안' }, { type: 'text', text: '녕' }] }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([
      { role: 'system', content: '너는 도우미다' },
      { role: 'user', content: '안녕?' },
    ])

    expect(out).toBe('안녕')
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.system).toBe('너는 도우미다')
    expect(body.messages).toEqual([{ role: 'user', content: '안녕?' }])
    expect(body.max_tokens).toBe(256)
    expect(calls[0].init.headers['x-api-key']).toBe('key-a')
    expect(calls[0].init.headers['anthropic-version']).toBeDefined()
  })

  it('throws ApiProviderError on non-ok response', async () => {
    const { http } = mockHttp(() => ({ ok: false, status: 401, body: 'invalid key' }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(ApiProviderError)
  })

  it('throws when api key is missing', async () => {
    const { http } = mockHttp(() => ({ body: '{}' }))
    const p = createAnthropicProvider({ ...baseAnthropic, apiKey: undefined }, http)
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow('API 키')
  })
})

describe('OpenAiProvider', () => {
  it('passes messages through and parses choice content', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: '응답입니다' } }] }),
    }))
    const p = createOpenAiProvider(
      { id: 'o1', provider: 'openai', displayName: 'GPT', model: 'gpt-4o', apiKey: 'key-o', temperature: 0.3 },
      http,
    )
    const out = await p.chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])

    expect(out).toBe('응답입니다')
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(body.temperature).toBe(0.3)
    expect(calls[0].init.headers.authorization).toBe('Bearer key-o')
  })
})

describe('GoogleProvider', () => {
  it('maps roles, sets systemInstruction, builds url, parses parts', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini 응답' }] } }] }),
    }))
    const p = createGoogleProvider(
      { id: 'g1', provider: 'google', displayName: 'Gemini', model: 'gemini-1.5-pro', apiKey: 'key-g' },
      http,
    )
    const out = await p.chat([
      { role: 'system', content: '시스템' },
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '이전답변' },
    ])

    expect(out).toBe('gemini 응답')
    expect(calls[0].url).toContain('models/gemini-1.5-pro:generateContent')
    expect(calls[0].url).toContain('key=key-g')
    const body = JSON.parse(calls[0].init.body) as {
      contents: Array<{ role: string }>
      systemInstruction?: unknown
    }
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model'])
    expect(body.systemInstruction).toBeDefined()
  })
})

describe('createApiProvider (registry)', () => {
  it('dispatches to the correct provider implementation', () => {
    const a = createApiProvider({ id: 'a', provider: 'anthropic', displayName: 'A', model: 'm', apiKey: 'k' })
    const o = createApiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'm', apiKey: 'k' })
    const g = createApiProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'm', apiKey: 'k' })
    expect(a.provider).toBe('anthropic')
    expect(o.provider).toBe('openai')
    expect(g.provider).toBe('google')
  })
})
