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

/** 문자열 청크를 UTF-8 바이트 async-iterable(fetch body 모사)로 변환. */
function bodyOf(chunks: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield enc.encode(c)
    },
  }
}

/** SSE body 를 돌려주는 mock — 스트리밍 경로 검증용. */
function mockStreamHttp(chunks: string[]): { http: HttpClient; calls: Captured[] } {
  const calls: Captured[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, text: async () => chunks.join(''), body: bodyOf(chunks) }
  }
  return { http, calls }
}

const baseAnthropic: ApiProviderConfig = {
  id: 'a1',
  provider: 'anthropic',
  displayName: 'Claude',
  model: 'claude-sonnet-4-6',
  apiKey: 'key-a',
  maxTokens: 256,
}

describe('AnthropicProvider', () => {
  it('splits system, maps turns, parses text blocks + usage + finishReason', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({
        content: [{ type: 'text', text: '안' }, { type: 'text', text: '녕' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([
      { role: 'system', content: '너는 도우미다' },
      { role: 'user', content: '안녕?' },
    ])

    expect(out.text).toBe('안녕')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 3 })
    expect(out.toolCalls).toEqual([])
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.system).toBe('너는 도우미다')
    expect(body.messages).toEqual([{ role: 'user', content: '안녕?' }])
    expect(body.max_tokens).toBe(256)
    expect(calls[0].init.headers['x-api-key']).toBe('key-a')
    expect(calls[0].init.headers['anthropic-version']).toBeDefined()
  })

  it('defaults max_tokens to 4096 when unset', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, maxTokens: undefined }, http)
    await p.chat([{ role: 'user', content: 'x' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).max_tokens).toBe(4096)
  })

  it('sends tool definitions and parses tool_use blocks; max_tokens → length', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: '서울' } }],
        stop_reason: 'tool_use',
      }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: '날씨?' }], {
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
      toolChoice: 'required',
    })
    expect(out.finishReason).toBe('tool_use')
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: '서울' } }])
    const body = JSON.parse(calls[0].init.body) as { tools: Array<Record<string, unknown>>; tool_choice: unknown }
    expect(body.tools[0]).toMatchObject({ name: 'get_weather', input_schema: { type: 'object' } })
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  it('maps content blocks (text + image) into the request', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([
      { role: 'user', content: [
        { type: 'text', text: '이게 뭐야?' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<{ content: unknown }> }
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '이게 뭐야?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
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
  it('passes messages through, parses content + usage, gpt-4o uses max_tokens + temperature', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({
        choices: [{ message: { content: '응답입니다' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    }))
    const p = createOpenAiProvider(
      { id: 'o1', provider: 'openai', displayName: 'GPT', model: 'gpt-4o', apiKey: 'key-o', temperature: 0.3, maxTokens: 100 },
      http,
    )
    const out = await p.chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])

    expect(out.text).toBe('응답입니다')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(body.max_tokens).toBe(100)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.temperature).toBe(0.3)
    expect(calls[0].init.headers.authorization).toBe('Bearer key-o')
  })

  it('reasoning models (gpt-5/o-series) use max_completion_tokens and drop temperature', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    for (const model of ['gpt-5.1', 'o3-mini']) {
      const p = createOpenAiProvider(
        { id: 'r', provider: 'openai', displayName: 'R', model, apiKey: 'k', temperature: 0.7, maxTokens: 200 },
        http,
      )
      await p.chat([{ role: 'user', content: 'x' }])
      const body = JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>
      expect(body.max_completion_tokens).toBe(200)
      expect(body.max_tokens).toBeUndefined()
      expect(body.temperature).toBeUndefined()
    }
  })

  it('sends function tools and parses tool_calls', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    }))
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      tools: [{ name: 'search', parameters: { type: 'object' } }],
    })
    expect(out.finishReason).toBe('tool_use')
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }])
    const body = JSON.parse(calls[0].init.body) as { tools: unknown[] }
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'search', description: undefined, parameters: { type: 'object' } } })
  })
})

describe('GoogleProvider', () => {
  it('maps roles, sets systemInstruction, auths via header, parses parts + usage', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'gemini 응답' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
      }),
    }))
    const p = createGoogleProvider(
      { id: 'g1', provider: 'google', displayName: 'Gemini', model: 'gemini-2.5-flash', apiKey: 'key-g' },
      http,
    )
    const out = await p.chat([
      { role: 'system', content: '시스템' },
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '이전답변' },
    ])

    expect(out.text).toBe('gemini 응답')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 4 })
    expect(calls[0].url).toContain('models/gemini-2.5-flash:generateContent')
    // API 키는 URL 쿼리스트링이 아니라 헤더로 전송된다(#5).
    expect(calls[0].url).not.toContain('key=')
    expect(calls[0].init.headers['x-goog-api-key']).toBe('key-g')
    const body = JSON.parse(calls[0].init.body) as {
      contents: Array<{ role: string }>
      systemInstruction?: unknown
    }
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model'])
    expect(body.systemInstruction).toBeDefined()
  })

  it('SAFETY finishReason maps to content_filter', async () => {
    const { http } = mockHttp(() => ({ body: JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }) }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-flash', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'x' }])
    expect(out.text).toBe('')
    expect(out.finishReason).toBe('content_filter')
  })

  it('sends functionDeclarations and parses functionCall', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { id: 1 } } }] }, finishReason: 'STOP' }],
      }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-flash', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    })
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'lookup-0', name: 'lookup', input: { id: 1 } }])
    const body = JSON.parse(calls[0].init.body) as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
      toolConfig: { functionCallingConfig: { mode: string } }
    }
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({ name: 'lookup' })
    expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO')
  })
})

describe('provider streaming (SSE)', () => {
  it('Anthropic: onToken 으로 텍스트 델타를 흘리고 usage/finish 를 누적한다', async () => {
    const { http, calls } = mockStreamHttp([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"안"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"녕"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'hi' }], { onToken: (d) => deltas.push(d) })
    expect(deltas).toEqual(['안', '녕'])
    expect(out.text).toBe('안녕')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 2 })
    expect((JSON.parse(calls[0].init.body) as { stream?: boolean }).stream).toBe(true)
  })

  it('OpenAI: stream:true + include_usage, 델타와 usage 파싱', async () => {
    const { http, calls } = mockStreamHttp([
      'data: {"choices":[{"delta":{"content":"H"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"i"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ])
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'hi' }], { onToken: (d) => deltas.push(d) })
    expect(deltas).toEqual(['H', 'i'])
    expect(out.text).toBe('Hi')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    const body = JSON.parse(calls[0].init.body) as { stream?: boolean; stream_options?: { include_usage?: boolean } }
    expect(body.stream).toBe(true)
    expect(body.stream_options?.include_usage).toBe(true)
  })

  it('Google: streamGenerateContent?alt=sse 로 요청하고 델타/usage 파싱', async () => {
    const { http, calls } = mockStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"text":"안"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"녕"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
    ])
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3.5-flash', apiKey: 'k' }, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'hi' }], { onToken: (d) => deltas.push(d) })
    expect(deltas).toEqual(['안', '녕'])
    expect(out.text).toBe('안녕')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
    expect(calls[0].url).toContain('streamGenerateContent?alt=sse')
  })

  it('tools 가 있으면 스트리밍하지 않고 버퍼링 경로를 쓴다(도구 호출 보존)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const deltas: string[] = []
    await p.chat([{ role: 'user', content: 'q' }], {
      onToken: (d) => deltas.push(d),
      tools: [{ name: 't', parameters: { type: 'object' } }],
    })
    expect((JSON.parse(calls[0].init.body) as { stream?: boolean }).stream).toBeUndefined()
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
