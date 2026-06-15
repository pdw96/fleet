import { describe, expect, it } from 'vitest'
import type { ApiProviderConfig } from '../../../shared/types'
import { createAnthropicProvider } from './anthropic'
import { createGoogleProvider } from './google'
import { createOpenAiProvider } from './openai'
import { createApiProvider } from './registry'
import { ApiProviderError, sendWithSchemaFallback, type HttpClient, type HttpInit, type HttpResponse } from './types'

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

/** 첫 호출은 400, 재시도부터 SSE 스트림을 돌려주는 mock — 스트리밍 구조화-출력 400 폴백 검증용. */
function mock400ThenStream(chunks: string[]): { http: HttpClient; calls: Captured[] } {
  const calls: Captured[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) return { ok: false, status: 400, text: async () => 'schema unsupported' }
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

const baseOpenai: ApiProviderConfig = {
  id: 'o1', provider: 'openai', displayName: 'GPT', model: 'gpt-4o', apiKey: 'key-o', maxTokens: 256,
}

const baseGoogle: ApiProviderConfig = {
  id: 'g1', provider: 'google', displayName: 'Gemini', model: 'gemini-2.5-pro', apiKey: 'key-g', maxTokens: 256,
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

  it('재사용 프리픽스(도구 동봉·멀티턴)엔 top-level cache_control(ephemeral)를 싣는다 (#11 caching)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    // 도구 동봉 = tool loop 라운드 간 프리픽스 재사용 → 캐시 분기점.
    await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 't', parameters: { type: 'object' } }] })
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral' })
    // 멀티턴(history 누적) 도 재사용 프리픽스.
    await p.chat([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral' })
  })

  it('fresh 단발(1턴·도구 없음)엔 cache_control 을 싣지 않는다 — 휘발성 프리픽스 캐시-쓰기 순손실 방지 (#11 caching)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    // planner/reviewer/summarizer 패턴: system + 단일 user 턴(휘발성). 다음 호출이 다른 프롬프트라 캐시 미적중.
    await p.chat([
      { role: 'system', content: '너는 평가자다' },
      { role: 'user', content: 'q' },
    ])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).cache_control).toBeUndefined()
  })

  it('응답 usage 의 cache_creation/cache_read 토큰을 파싱한다 (#11 caching)', async () => {
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
      }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }])
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 100, cacheReadInputTokens: 200 })
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

  it('responseSchema → output_config.format(json_schema) 를 body 에 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'verdict', schema } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } })
  })

  it('구조화-출력 400 → output_config 없이 1회 재시도(graceful degradation)', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'unsupported field output_config' }
        : { body: JSON.stringify({ content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn' }) }
    })
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    const out = await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema } })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).output_config).toBeDefined()
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).output_config).toBeUndefined()
    expect(out.text).toBe('[]')
  })

  it('thinking 노브 → adaptive thinking + effort 를 body 에 싣는다 — 4.6 세대는 display 생략(4.7 도입 필드) (#11-thinking)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('effort 없이 thinking 만 주면 thinking 만 싣고 output_config 는 없다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {} })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toBeUndefined()
  })

  it('thinking 미지정이면 body 에 thinking/output_config 가 없다(현행 동작)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('responseSchema 와 thinking.effort 공존 시 output_config 에 format+effort 를 병합한다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema }, thinking: { effort: 'low' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'low' })
  })

  it('구조화-출력 400 폴백 시 format 만 제거하고 effort 는 보존한다', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'unsupported field output_config' }
        : { body: JSON.stringify({ content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn' }) }
    })
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema }, thinking: { effort: 'medium' } })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).output_config).toEqual({ effort: 'medium' })
  })

  it('thinking 켜지면 temperature 를 전송하지 않는다(reasoning 모드 정규화) (#11-thinking)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, temperature: 0.3 }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {} })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('thinking 미지정이면 temperature 를 그대로 전송한다 — temperature 허용 모델(Sonnet 4.6) (현행 동작)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, temperature: 0.3 }, http) // claude-sonnet-4-6
    await p.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).temperature).toBe(0.3)
  })

  // ── temperature 거부(no-sampling) 모델 가드 (anthropic-nosampling-guard) ──────────
  // Opus 4.7/4.8·Fable 은 sampling 파라미터(temperature) 자체를 400 으로 거부한다. thinking 미지정이면
  // resolveThinking 이 undefined 라 기존 `!thinking` 게이트가 모델 무관하게 temperature 를 실어 하드 400 →
  // 모델 게이트를 동반해 thinking 여부와 무관하게 생략해야 한다(생략은 항상 안전).

  it('temperature 거부 모델(Opus 4.8)은 thinking 미지정·temperature 명시여도 temperature 를 생략한다 (anthropic-nosampling-guard)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-opus-4-8', temperature: 0.3 }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).temperature).toBeUndefined()
  })

  it('temperature 거부 모델(Fable)도 thinking 미지정·temperature 명시여도 temperature 를 생략한다 (anthropic-nosampling-guard)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-fable-5', temperature: 0.5 }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).temperature).toBeUndefined()
  })

  it('temperature 거부 모델(Opus 4.7)은 per-call opts.temperature 도 생략한다 (anthropic-nosampling-guard)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-opus-4-7' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { temperature: 0.2 })
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).temperature).toBeUndefined()
  })

  it('temperature 거부 모델(Opus 4.8) + thinking 활성 + temperature 명시 — 두 가드 모두 적용돼 temperature 생략 (anthropic-nosampling-guard)', async () => {
    // thinking 게이트(`!thinking`)와 모델 게이트(`!NO_SAMPLING_MODELS`)의 교차. thinking 켜진 경로에서도
    // no-sampling 모델의 temperature 가 새지 않음을 잠가 둔다(어느 한 가드가 회귀로 빠져도 포착).
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-opus-4-8', temperature: 0.3 }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  it('temperature 허용 모델(Sonnet 4.6)은 per-call opts.temperature 도 그대로 전송한다 (config/per-call × accept 매트릭스 보강)', async () => {
    // 거부 모델은 config·per-call 양 경로를 위에서 커버 → 허용 모델의 per-call 경로까지 잠가 매트릭스를 닫는다.
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http) // claude-sonnet-4-6
    await p.chat([{ role: 'user', content: 'q' }], { temperature: 0.4 })
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).temperature).toBe(0.4)
  })

  it('thinking 켜지면 강제 도구사용(toolChoice:required)을 auto 로 낮춘다(확장 thinking 비호환) (#11-thinking)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {}, tools: [{ name: 't', parameters: { type: 'object' } }], toolChoice: 'required' })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.tool_choice).toBeUndefined() // 'any' 미전송 = auto(기본)
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('thinking 켜져도 toolChoice:none 은 유지한다(none 은 thinking 과 호환)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {}, tools: [{ name: 't', parameters: { type: 'object' } }], toolChoice: 'none' })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.tool_choice).toEqual({ type: 'none' })
  })

  it('thinking 미지정이면 toolChoice:required 는 그대로 any 로 전송한다(현행 동작)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 't', parameters: { type: 'object' } }], toolChoice: 'required' })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  // ── #11-thinking 프로덕션 활성화: config 기본값 + 모델-인지 정규화 ──────────

  it('config.thinking 이 세션 기본값으로 동작한다 — per-call 미지정에도 thinking 활성 (#11-thinking 활성화)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, thinking: { effort: 'high' } }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('config.thinking 기본값 경로에서도 temperature 생략·toolChoice required→auto 가드가 동작한다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, temperature: 0.3, thinking: {} }, http)
    await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 't', parameters: { type: 'object' } }], toolChoice: 'required' })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.temperature).toBeUndefined()
    expect(body.tool_choice).toBeUndefined() // required → auto 하향
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('per-call opts.thinking 이 config.thinking 기본값을 이긴다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, thinking: { effort: 'low' } }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ effort: 'max' })
  })

  it('Opus 4.7+ 모델은 display:summarized 를 동봉하고 xhigh effort 를 통과시킨다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-opus-4-8' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'xhigh' })
  })

  it('xhigh 는 4.7 미만(Sonnet 4.6)에서 effort 생략으로 하향한다 — thinking 은 켠 채(서버 기본 high)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http) // claude-sonnet-4-6
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toBeUndefined() // effort 자체 생략 = 기본 high 로 동작
  })

  it('max effort 는 Sonnet 4.6 에서 그대로 통과한다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ effort: 'max' })
  })

  it('adaptive 미지원 모델(Haiku 4.5 등 구형)은 thinking 을 통째로 생략한다(=off, 400 방지)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-haiku-4-5', temperature: 0.3 }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'low' }, tools: [{ name: 't', parameters: { type: 'object' } }], toolChoice: 'required' })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
    expect(body.temperature).toBe(0.3) // thinking off 와 동일하게 동작(가드 미발동)
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  it('Opus 4.5(adaptive 도입 전)도 thinking 생략 대상이다 — 날짜접미 풀 ID 포함', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-opus-4-5-20251101' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('화이트리스트 부분일치 함정 방지 — 마이너 버전 숫자가 번진 미지 ID(opus-4-60)는 off 로 강등한다', async () => {
    // `(?![0-9])` 룩어헤드가 없으면 opus-4-60 이 opus-4-6 으로 부분일치돼 미지 모델에 thinking 을 보내 400 위험.
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, model: 'claude-opus-4-60' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('thinking 활성 + max_tokens 미지정이면 기본을 상향한다(버퍼 16384, 스트리밍 64000) — 명시값은 존중', async () => {
    // 버퍼 경로: 사고 토큰이 4096 예산을 소진해 빈-응답 truncation 이 되는 것을 막는다.
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, maxTokens: undefined, thinking: { effort: 'high' } }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).max_tokens).toBe(16384)

    // 스트리밍 경로: HTTP 타임아웃 위험이 없어 더 크게(Sonnet 4.6 출력 상한 이내).
    // (message_delta 로 stop_reason 을 줘 클린 종료로 만든다 — stop_reason 미수신 잘림 가드와 무충돌.)
    const stream = mockStreamHttp([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    const ps = createAnthropicProvider({ ...baseAnthropic, maxTokens: undefined, thinking: { effort: 'high' } }, stream.http)
    await ps.chat([{ role: 'user', content: 'q' }], { onToken: () => {} })
    expect((JSON.parse(stream.calls[0].init.body) as Record<string, unknown>).max_tokens).toBe(64000)

    // 명시 config.maxTokens 는 그대로(baseAnthropic=256 — 기존 thinking 테스트들이 이미 커버하는 계약의 명시화).
    const { http: h2, calls: c2 } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p2 = createAnthropicProvider({ ...baseAnthropic, thinking: { effort: 'high' } }, h2)
    await p2.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(c2[0].init.body) as Record<string, unknown>).max_tokens).toBe(256)
  })

  it('config.thinking 기본값과 responseSchema 동시(planner 경로) → output_config 에 format+effort 병합', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, thinking: { effort: 'medium' } }, http)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'medium' })
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('thinking off 면 max_tokens 기본은 기존 4096 그대로다(무회귀)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider({ ...baseAnthropic, maxTokens: undefined }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).max_tokens).toBe(4096)
  })

  it('ThinkingBlock 을 tool_use 앞에 thinking 블록으로 재방출하고 signature 를 보존한다 (#11-thinking 채널)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG' } } },
          { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<{ role: string; content: unknown }> }
    const assistant = body.messages.find((m) => m.role === 'assistant')!
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: '사고', signature: 'SIG' },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
    ])
  })

  it('비스트림 thinking 블록을 순서보존 content 로 파싱하고 signature 를 providerMeta 에 보존한다 (#11-thinking)', async () => {
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        content: [
          { type: 'thinking', thinking: '사고 과정', signature: 'SIG_T' },
          { type: 'text', text: '답변' },
          { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
        ],
        stop_reason: 'tool_use',
      }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.text).toBe('답변') // thinking 은 가시 텍스트에서 제외
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } }])
    expect(out.content).toEqual([
      { type: 'thinking', text: '사고 과정', providerMeta: { anthropic: { signature: 'SIG_T' } } },
      { type: 'text', text: '답변' },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
    ])
  })

  it('비스트림 thinking 블록이 없으면 content 를 설정하지 않는다(무회귀)', async () => {
    const { http } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }])
    expect(out.content).toBeUndefined()
    expect(out.text).toBe('hi')
  })

  it('비스트림 redacted_thinking 블록을 보존한다(data 를 providerMeta 로) (#11-thinking)', async () => {
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        content: [
          { type: 'redacted_thinking', data: 'RD_ENC' },
          { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
        ],
        stop_reason: 'tool_use',
      }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.content).toEqual([
      { type: 'thinking', text: '', providerMeta: { anthropic: { redactedData: 'RD_ENC' } } },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
    ])
  })

  it('redacted_thinking(providerMeta.anthropic.redactedData)을 redacted_thinking 블록으로 재방출한다 (#11-thinking)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '', providerMeta: { anthropic: { redactedData: 'RD_ENC' } } },
          { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<{ role: string; content: unknown }> }
    const assistant = body.messages.find((m) => m.role === 'assistant')!
    expect(assistant.content).toEqual([
      { type: 'redacted_thinking', data: 'RD_ENC' },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
    ])
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

  it('tool_use/tool_result 블록을 tool_calls + role:tool 메시지로 평탄화한다', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: '끝' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '검색해' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'search', content: '결과' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    })
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '결과' })
  })

  it('텍스트와 tool_use 가 함께 있는 assistant 턴을 content + tool_calls 로 매핑한다', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: '끝' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '검색해' },
      { role: 'assistant', content: [
        { type: 'text', text: '검색할게요' },
        { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } },
      ] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: '검색할게요',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    })
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

  it('responseSchema → response_format(json_schema, strict) 를 body 에 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider(baseOpenai, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'verdict', schema } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'verdict', schema, strict: true } })
  })

  it('구조화 출력 거부(message.refusal)를 content_filter 로 표면화한다(#7)', async () => {
    const { http } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { refusal: '안전상 거부합니다' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider(baseOpenai, http)
    const out = await p.chat([{ role: 'user', content: 'x' }])
    expect(out.finishReason).toBe('content_filter')
    expect(out.text).toBe('')
    expect(out.rawFinishReason).toContain('거부')
  })

  it('구조화-출력 400 → response_format 없이 1회 재시도', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'response_format json_schema not supported' }
        : { body: JSON.stringify({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] }) }
    })
    const p = createOpenAiProvider(baseOpenai, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema: { type: 'object' } } })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).response_format).toBeDefined()
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).response_format).toBeUndefined()
    expect(out.text).toBe('[]')
  })

  it('어시스턴트 턴의 ThinkingBlock 을 안전 무시하고 tool_calls 메시지를 그대로 만든다(무회귀)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider(baseOpenai, http)
    await p.chat([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG' } } },
          { type: 'tool_use', id: 'tc1', name: 'lookup', input: { id: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tc1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant')!
    // thinking 은 wire 로 새지 않는다(tool_calls + content 만). content 는 텍스트 없음 → null.
    expect(assistant.tool_calls).toEqual([
      { id: 'tc1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } },
    ])
    expect(assistant.content).toBeNull()
    expect(JSON.stringify(body)).not.toContain('SIG')
  })

  // ── reasoning_effort 패리티 (thinking 크로스-프로바이더 1단계 — #11) ──────────
  it('thinking.effort → reasoning_effort 를 reasoning 모델 body 에 싣는다 (reasoning_effort 패리티)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model: 'gpt-5.1', apiKey: 'k' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('high')
  })

  it('low/medium 는 그대로 매핑한다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model: 'gpt-5.5', apiKey: 'k' }, http)
    for (const effort of ['low', 'medium'] as const) {
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort } })
      const body = JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>
      expect(body.reasoning_effort).toBe(effort)
    }
  })

  it('config.thinking 이 세션 기본값으로 동작한다 — per-call 미지정에도 reasoning_effort 활성', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model: 'gpt-5.5', apiKey: 'k', thinking: { effort: 'medium' } }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('medium')
  })

  it('per-call opts.thinking 이 config.thinking 기본값을 이긴다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model: 'gpt-5.5', apiKey: 'k', thinking: { effort: 'low' } }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('high')
  })

  it('비-reasoning 모델(gpt-4o)은 thinking 이 있어도 reasoning_effort 를 보내지 않는다(400 방지)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k', thinking: { effort: 'high' } }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.temperature).toBeUndefined() // 비-reasoning 이지만 temperature 미설정 config → 그대로 미전송
  })

  it('reasoning_effort 거부 모델(gpt-5-chat-latest · o1-mini · o1-preview)은 prefix 가 매칭돼도 미전송한다(400 방지)', async () => {
    // gpt-5-chat-latest 는 비-reasoning chat 변종, o1-mini·o1-preview 는 reasoning_effort 도입 전 o1 초기 모델 —
    // 셋 다 reasoning_effort 를 400 으로 거부. isReasoningModel(토큰 필드용) 은 prefix 로 셋 다 매칭하므로
    // reasoning_effort 게이트는 별도 predicate 여야 한다(codex P2: o1-preview 누락 보강).
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    for (const model of ['gpt-5-chat-latest', 'o1-mini', 'o1-preview', 'o1-preview-2024-09-12']) {
      const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model, apiKey: 'k', thinking: { effort: 'high' } }, http)
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
      expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBeUndefined()
    }
  })

  it('pro 계열 effort 정규화 — gpt-5-pro=high 만, dotted pro(gpt-5.2/5.4-pro)는 low→medium 상향 (codex P2)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const eff = () => (JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort
    // gpt-5-pro 는 high 만 지원 → low/medium/xhigh/max 전부 high(미정규화 시 low/medium 400).
    const pro = createOpenAiProvider({ id: 'p', provider: 'openai', displayName: 'P', model: 'gpt-5-pro', apiKey: 'k' }, http)
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      await pro.chat([{ role: 'user', content: 'q' }], { thinking: { effort: e } })
      expect(eff()).toBe('high')
    }
    // dotted pro(검증 집합 {medium,high,xhigh}): low→medium 상향, medium/high 유지, xhigh/max→xhigh.
    for (const model of ['gpt-5.2-pro', 'gpt-5.4-pro']) {
      const p = createOpenAiProvider({ id: 'd', provider: 'openai', displayName: 'D', model, apiKey: 'k' }, http)
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'low' } })
      expect(eff()).toBe('medium')
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'medium' } })
      expect(eff()).toBe('medium')
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
      expect(eff()).toBe('xhigh')
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
      expect(eff()).toBe('xhigh')
    }
  })

  it('xhigh 는 지원 모델(gpt-5.5)에선 xhigh, 미지원 reasoning 모델(o3-mini)에선 high 로 하향', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const xh = createOpenAiProvider({ id: 'x', provider: 'openai', displayName: 'X', model: 'gpt-5.5', apiKey: 'k' }, http)
    await xh.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
    expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBe('xhigh')

    const lo = createOpenAiProvider({ id: 'l', provider: 'openai', displayName: 'L', model: 'o3-mini', apiKey: 'k' }, http)
    await lo.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
    expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBe('high')
  })

  it('xhigh 지원 세대는 GPT-5.2+(codex 변종 포함) — 5.2/5.2-codex/5.3-codex=xhigh, 5.1/5.0=high 강등 (codex P2)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    for (const model of ['gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex']) {
      const p = createOpenAiProvider({ id: 'x', provider: 'openai', displayName: 'X', model, apiKey: 'k' }, http)
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
      expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBe('xhigh')
    }
    // 5.1/5.0(=plain gpt-5) 은 xhigh 미지원 세대 → high 로 안전 강등(400 방지).
    for (const model of ['gpt-5.1', 'gpt-5']) {
      const p = createOpenAiProvider({ id: 'l', provider: 'openai', displayName: 'L', model, apiKey: 'k' }, http)
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
      expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBe('high')
    }
  })

  it('gpt-5.1-codex-max 는 마이너=1 이지만 xhigh 지원(전용 도입 모델) — plain gpt-5.1-codex/-mini 는 강등 유지 (codex-max 핫픽스)', async () => {
    // 공식 호환성 매트릭스(2026-06, community/codex docs): xhigh 는 gpt-5.1-codex-max 가 처음 도입했고
    // plain gpt-5.1-codex·-mini 는 마이너=1 이라 xhigh 미지원(low/medium/high 만). 숫자비교 supportsXhigh(>=2)
    // 가 마이너=1 인 codex-max 까지 high 로 무성 강등하던 갭 → 'codex-max' 접미사 우선 매칭으로 해소하되
    // 'codex'/'codex-mini' 는 over-match 금지(강등 유지).
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const eff = () => (JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort
    // codex-max: xhigh·max 둘 다 xhigh 유지(강등 없음), low/medium/high 는 그대로 통과(정규화 부작용 없음).
    const max = createOpenAiProvider({ id: 'm', provider: 'openai', displayName: 'M', model: 'gpt-5.1-codex-max', apiKey: 'k' }, http)
    await max.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
    expect(eff()).toBe('xhigh')
    await max.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
    expect(eff()).toBe('xhigh')
    await max.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'medium' } })
    expect(eff()).toBe('medium')
    // 날짜접미 풀 ID 스냅샷(프로덕션 핀 형태)도 xhigh 유지 — 비앵커 substring 매칭이라 정상. 누군가 정규식을
    // 앵커드(/codex-max$/)로 '정리'하면 무성 강등이 재발하는데 이 어서션이 그 회귀를 잠근다(anthropic:423 동형).
    const maxDated = createOpenAiProvider({ id: 'md', provider: 'openai', displayName: 'MD', model: 'gpt-5.1-codex-max-2025-11-19', apiKey: 'k' }, http)
    await maxDated.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
    expect(eff()).toBe('xhigh')
    // plain gpt-5.1-codex·-mini: xhigh 미지원 → high 로 안전 강등(codex-max 접미사 over-match 회귀가드).
    for (const model of ['gpt-5.1-codex', 'gpt-5.1-codex-mini']) {
      const p = createOpenAiProvider({ id: 'c', provider: 'openai', displayName: 'C', model, apiKey: 'k' }, http)
      await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'xhigh' } })
      expect(eff()).toBe('high')
    }
  })

  it('중립 max 는 모델 최상위 티어로 매핑한다 — gpt-5.5=xhigh, o3-mini=high', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const xh = createOpenAiProvider({ id: 'x', provider: 'openai', displayName: 'X', model: 'gpt-5.5', apiKey: 'k' }, http)
    await xh.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
    expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBe('xhigh')

    const lo = createOpenAiProvider({ id: 'l', provider: 'openai', displayName: 'L', model: 'o3-mini', apiKey: 'k' }, http)
    await lo.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'max' } })
    expect((JSON.parse(calls.at(-1)!.init.body) as Record<string, unknown>).reasoning_effort).toBe('high')
  })

  it('effort 없이 thinking 만 주면(thinking:{}) reasoning_effort 를 보내지 않는다(서버 기본 사용)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model: 'gpt-5.5', apiKey: 'k' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {} })
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).reasoning_effort).toBeUndefined()
  })

  it('thinking 미지정이면 reasoning_effort 가 없다(현행 동작 무회귀)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider({ id: 'r', provider: 'openai', displayName: 'R', model: 'gpt-5.5', apiKey: 'k' }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).reasoning_effort).toBeUndefined()
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

  it('실제 functionCall.id 가 있으면 functionCall·functionResponse 양쪽에 id 를 echo 한다 (#17-P2 병렬 상관)', async () => {
    // Gemini 3.x 는 functionCall 마다 고유 id 를 부여한다 → 멀티턴 history 재전송 시 model 턴의
    // functionCall 과 user 턴의 functionResponse 에 같은 id 를 실어 병렬 동일함수 호출을 정확히 상관시킨다.
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '조회' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fc_a1', name: 'lookup', input: { id: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc_a1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    expect(body.contents.at(-2)!.parts[0]).toEqual({
      functionCall: { name: 'lookup', args: { id: 1 }, id: 'fc_a1' },
    })
    expect(body.contents.at(-1)!.parts[0]).toEqual({
      functionResponse: { name: 'lookup', id: 'fc_a1', response: { result: '값' } },
    })
  })

  it('ToolUseBlock.providerMeta.google.thoughtSignature 를 functionCall 에 echo 한다 (#17-P1 채널)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '조회' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'fc_a1', name: 'lookup', input: { id: 1 }, providerMeta: { google: { thoughtSignature: 'SIG_XYZ' } } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc_a1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    // thoughtSignature 는 Part 레벨(functionCall 의 형제)에 실린다 — Gemini wire 계약.
    expect(body.contents.at(-2)!.parts[0]).toEqual({
      functionCall: { name: 'lookup', args: { id: 1 }, id: 'fc_a1' },
      thoughtSignature: 'SIG_XYZ',
    })
  })

  it('providerMeta 가 없으면 functionCall 에 thoughtSignature 를 싣지 않는다 (echo-only-when-present, #29 규율)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '조회' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fc_a1', name: 'lookup', input: { id: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc_a1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    expect(body.contents.at(-2)!.parts[0]).toEqual({
      functionCall: { name: 'lookup', args: { id: 1 }, id: 'fc_a1' },
    })
  })

  it('실제 id 가 없으면(빈 문자열) functionCall·functionResponse 에 id 를 싣지 않는다 (Gemini 2.x 호환)', async () => {
    // 2.x 는 functionCall.id 를 안 줄 수 있다 → 합성 id 를 만들어 보내지 않고 name 으로만 상관한다.
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-flash', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '조회' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '', name: 'lookup', input: { id: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: '', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    expect(body.contents.at(-2)!.parts[0]).toEqual({ functionCall: { name: 'lookup', args: { id: 1 } } })
    expect(body.contents.at(-1)!.parts[0]).toEqual({ functionResponse: { name: 'lookup', response: { result: '값' } } })
  })

  it('tool_result 에 name 이 없으면 functionResponse.name 이 toolUseId 로 폴백한다(id 도 echo)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-flash', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fallback-id', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    // name 부재 시 toolUseId 로 폴백(방어적; 실무 흐름은 항상 name 동반). 실제 id 라 functionResponse.id 도 회신.
    expect(body.contents.at(-1)!.parts[0]).toEqual({
      functionResponse: { name: 'fallback-id', id: 'fallback-id', response: { result: '값' } },
    })
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
    // id 미부여 응답(2.x) → 합성하지 않고 빈 문자열(회신 시 미전송).
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: '', name: 'lookup', input: { id: 1 } }])
    const body = JSON.parse(calls[0].init.body) as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
      toolConfig: { functionCallingConfig: { mode: string } }
    }
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({ name: 'lookup' })
    expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO')
  })

  it('응답 functionCall.id 를 ToolUseBlock.id 로 보존한다 (#17-P2)', async () => {
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { id: 'fc_xyz', name: 'lookup', args: { id: 1 } } }] }, finishReason: 'STOP' }],
      }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'fc_xyz', name: 'lookup', input: { id: 1 } }])
  })

  it('응답 part 레벨 thoughtSignature 를 providerMeta.google 로 캡처한다 (#17-P1, 비스트림)', async () => {
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { id: 'fc_a1', name: 'lookup', args: { id: 1 } }, thoughtSignature: 'SIG_A' }] }, finishReason: 'STOP' }],
      }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 'fc_a1', name: 'lookup', input: { id: 1 }, providerMeta: { google: { thoughtSignature: 'SIG_A' } } },
    ])
  })

  it('병렬 functionCall 중 첫 파트만 thoughtSignature 를 가지면 첫 ToolUseBlock 에만 providerMeta 가 붙는다 (#17-P1)', async () => {
    // Gemini wire 계약: 병렬 호출 시 thoughtSignature 는 첫 functionCall 파트에만 붙는다.
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        candidates: [{ content: { parts: [
          { functionCall: { id: 'fc_1', name: 'lookup', args: { city: '서울' } }, thoughtSignature: 'SIG_A' },
          { functionCall: { id: 'fc_2', name: 'lookup', args: { city: '부산' } } },
        ] }, finishReason: 'STOP' }],
      }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 'fc_1', name: 'lookup', input: { city: '서울' }, providerMeta: { google: { thoughtSignature: 'SIG_A' } } },
      { type: 'tool_use', id: 'fc_2', name: 'lookup', input: { city: '부산' } },
    ])
  })

  it('병렬 동일함수 functionCall 들을 각자의 id 로 구분 보존한다 (#17-P2 핵심)', async () => {
    // 같은 함수를 한 턴에 병렬 호출해도 functionCall.id 로 응답을 정확히 상관시킬 수 있어야 한다.
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: 'fc_1', name: 'get_weather', args: { city: '서울' } } },
                { functionCall: { id: 'fc_2', name: 'get_weather', args: { city: '부산' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'get_weather', parameters: { type: 'object' } }] })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 'fc_1', name: 'get_weather', input: { city: '서울' } },
      { type: 'tool_use', id: 'fc_2', name: 'get_weather', input: { city: '부산' } },
    ])
  })

  // ── #11-Gemini-thinking 1단계: thinkingConfig 배선 + starvation maxOutputTokens 가드 ──────────
  // 세대별 와이어 방언이 다르다(js-genai·ai.google.dev 1차출처): 2.5=thinkingBudget(정수, -1=AUTOMATIC),
  // 3=thinkingLevel(소문자 enum). thinking 토큰이 출력 예산을 함께 소모하므로(공식: "reserve more of the
  // token output for your response" + 실키 검증: 낮은 한도→빈 응답) thinking 활성 시 maxOutputTokens 를
  // cap-safe(전 2.5/3 출력상한 65536 내) 기본/floor 로 끌어올린다.
  const okBody = () => ({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) })

  it('Gemini 2.5: thinking 노브 → generationConfig.thinkingConfig.thinkingBudget=-1(AUTOMATIC) (#11-Gemini-thinking)', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-flash', apiKey: 'k' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: -1 })
  })

  it('Gemini 2.5: thinking 활성 시 과소 maxOutputTokens 를 버퍼 기본(16384)으로 floor 한다(굶음 방지)', async () => {
    // baseGoogle.maxTokens=256 → thinking 이 256 을 먹어 가시 답변이 굶는다 → 16384 로 floor.
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider(baseGoogle, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'medium' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
    expect(body.generationConfig?.maxOutputTokens).toBe(16384)
  })

  it('Gemini 3: effort → thinkingConfig.thinkingLevel(소문자) — high', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'high' })
  })

  it('Gemini 3: low/medium 은 그대로, xhigh·max 는 high 로 수렴한다(미지원 티어 하향)', async () => {
    const cfg = { id: 'g', provider: 'google' as const, displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }
    const cases = [['low', 'low'], ['medium', 'medium'], ['xhigh', 'high'], ['max', 'high']] as const
    for (const [effort, level] of cases) {
      const { http, calls } = mockHttp(okBody)
      await createGoogleProvider(cfg, http).chat([{ role: 'user', content: 'q' }], { thinking: { effort } })
      const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
      expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: level })
    }
  })

  it('Gemini 3: effort 없는 thinking({})은 thinkingLevel 을 싣지 않되(모델 기본) starvation 가드는 적용한다', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k', maxTokens: 256 }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {} })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown; maxOutputTokens?: number } }
    expect(body.generationConfig?.thinkingConfig).toBeUndefined()
    expect(body.generationConfig?.maxOutputTokens).toBe(16384)
  })

  it('thinking 미지정이면 thinkingConfig 미전송·maxOutputTokens 무변경(현행 동작 무회귀)', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider(baseGoogle, http) // maxTokens 256, thinking 없음
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown; maxOutputTokens?: number } }
    expect(body.generationConfig?.thinkingConfig).toBeUndefined()
    expect(body.generationConfig?.maxOutputTokens).toBe(256)
  })

  it('thinking 미지원 모델(gemini-1.5-pro)은 thinkingConfig·starvation 가드 모두 미적용(400 방지)', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-1.5-pro', apiKey: 'k', maxTokens: 256 }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown; maxOutputTokens?: number } }
    expect(body.generationConfig?.thinkingConfig).toBeUndefined()
    expect(body.generationConfig?.maxOutputTokens).toBe(256) // 무변경(미지원 모델)
  })

  it('Gemini 스트리밍 + thinking: maxOutputTokens 를 스트림 기본(32768)으로 floor 한다', async () => {
    const { http, calls } = mockStreamHttp(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'])
    const p = createGoogleProvider(baseGoogle, http) // maxTokens 256
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' }, onToken: () => {} })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
    expect(body.generationConfig?.maxOutputTokens).toBe(32768)
  })

  it('thinking 활성이라도 명시 maxOutputTokens 가 기본 이상이면 존중한다(floor 만, 하향 없음)', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-pro', apiKey: 'k', maxTokens: 50000 }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
    expect(body.generationConfig?.maxOutputTokens).toBe(50000)
  })

  it('config.thinking 이 세션 기본값으로 동작한다 — per-call 미지정에도 thinkingConfig 활성', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k', thinking: { effort: 'low' } }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })

  it('per-call opts.thinking 이 config.thinking 기본값을 이긴다', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k', thinking: { effort: 'low' } }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'high' })
  })

  // ── 적대리뷰 후속: 커버리지 갭 잠금(로직은 정확 확인됨 — 회귀 방지 특성화 테스트) ──────────
  it('Gemini 3.5(앱 기본 Google 모델 gemini-3.5-flash): effort → thinkingLevel(점버전도 gen-3 방언)', async () => {
    // gemini-3.5-flash 는 PROVIDER_DEFAULTS.google 기본값 → gen-3 thinkingLevel 로 정규화돼야 한다.
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3.5-flash', apiKey: 'k' }, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'medium' } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'medium' })
  })

  it('Gemini 2.5(pro/flash/flash-lite): 전 effort 티어가 thinkingBudget=-1 로 수렴한다(1단계 불변식 잠금)', async () => {
    // 1단계는 2.5 서브모델 범위 차이(범위이탈 400)를 피해 effort 무관 -1(AUTOMATIC). 티어→정수 budget 은 2단계.
    for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const) {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
        const { http, calls } = mockHttp(okBody)
        await createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model, apiKey: 'k' }, http)
          .chat([{ role: 'user', content: 'q' }], { thinking: { effort } })
        const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
        expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: -1 })
      }
    }
  })

  it('starvation floor 경계: 버퍼 floor 정확값(16384)은 무변경, 직전(16383)은 16384 로 올림', async () => {
    for (const [maxTokens, expected] of [[16384, 16384], [16383, 16384]] as const) {
      const { http, calls } = mockHttp(okBody)
      await createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-pro', apiKey: 'k', maxTokens }, http)
        .chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
      const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
      expect(body.generationConfig?.maxOutputTokens).toBe(expected)
    }
  })

  it('starvation floor 경계(스트리밍): 스트림 floor 직전(32767)은 32768 로 올림', async () => {
    const { http, calls } = mockStreamHttp(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'])
    await createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-pro', apiKey: 'k', maxTokens: 32767 }, http)
      .chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' }, onToken: () => {} })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
    expect(body.generationConfig?.maxOutputTokens).toBe(32768)
  })

  it('config.thinking(세션 기본) + per-call 과소 maxTokens 도 floor 가 적용된다', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k', thinking: { effort: 'high' } }, http)
    await p.chat([{ role: 'user', content: 'q' }], { maxTokens: 256 })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
    expect(body.generationConfig?.maxOutputTokens).toBe(16384)
  })

  it('config.thinking + config.maxTokens 과소(512) + per-call maxTokens 미지정 → floor(이중 폴백 opts→config→floor)', async () => {
    const { http, calls } = mockHttp(okBody)
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k', maxTokens: 512, thinking: { effort: 'high' } }, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: { maxOutputTokens?: number } }
    expect(body.generationConfig?.maxOutputTokens).toBe(16384)
  })

  it('responseSchema → generationConfig.responseSchema + responseMimeType 를 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }) }))
    const p = createGoogleProvider(baseGoogle, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'verdict', schema } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: Record<string, unknown> }
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
    expect(body.generationConfig?.responseSchema).toEqual(schema)
  })

  it('구조화-출력 400 → responseSchema/responseMimeType 없이 1회 재시도', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'responseSchema unsupported' }
        : { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason: 'STOP' }] }) }
    })
    const p = createGoogleProvider(baseGoogle, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema: { type: 'object' } } })
    expect(calls).toHaveLength(2)
    const b1 = JSON.parse(calls[1].init.body) as { generationConfig?: Record<string, unknown> }
    expect(b1.generationConfig?.responseSchema).toBeUndefined()
    expect(b1.generationConfig?.responseMimeType).toBeUndefined()
    expect(out.text).toBe('[]')
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

  it('Anthropic 스트림: message_start 의 cache_creation/cache_read 토큰을 usage 로 누적한다 (#11 caching)', async () => {
    const { http } = mockStreamHttp([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"cache_creation_input_tokens":50,"cache_read_input_tokens":80}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} })
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 2, cacheCreationInputTokens: 50, cacheReadInputTokens: 80 })
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

  it('tools + onToken 이면 스트리밍하면서 tool_use 블록을 누적한다 (#10 SP3)', async () => {
    const { http, calls } = mockStreamHttp([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"검색"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"search"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"hi\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: (d) => deltas.push(d),
      tools: [{ name: 'search', parameters: { type: 'object' } }],
    })
    expect(deltas).toEqual(['검색'])
    expect(out.text).toBe('검색')
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'hi' } }])
    expect(out.finishReason).toBe('tool_use')
    expect((JSON.parse(calls[0].init.body) as { stream?: boolean }).stream).toBe(true)
  })

  it('tools 가 있어도 onToken 미지정이면 버퍼링 경로를 쓴다(비스트리밍 보존)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 't', parameters: { type: 'object' } }] })
    expect((JSON.parse(calls[0].init.body) as { stream?: boolean }).stream).toBeUndefined()
  })

  it('OpenAI: 스트리밍 중 delta.tool_calls 를 인덱스별로 누적한다 (#10 SP3)', async () => {
    const { http } = mockStreamHttp([
      'data: {"choices":[{"delta":{"content":"날씨"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"seoul\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ])
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: (d) => deltas.push(d),
      tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
    })
    expect(deltas).toEqual(['날씨'])
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'seoul' } }])
    expect(out.finishReason).toBe('tool_use')
    expect(out.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
  })

  it('Google: 스트리밍 중 functionCall part 를 toolCalls 로 모은다 (#10 SP3)', async () => {
    const { http } = mockStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"text":"찾아"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"id":7}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":5}}\n\n',
    ])
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3.5-flash', apiKey: 'k' }, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: (d) => deltas.push(d),
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    })
    expect(deltas).toEqual(['찾아'])
    expect(out.text).toBe('찾아')
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: '', name: 'lookup', input: { id: 7 } }])
  })

  it('Google: 스트리밍 functionCall.id 를 ToolUseBlock.id 로 보존한다 (#17-P2)', async () => {
    const { http } = mockStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc_s1","name":"lookup","args":{"id":7}}}]},"finishReason":"STOP"}]}\n\n',
    ])
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: () => {},
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    })
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'fc_s1', name: 'lookup', input: { id: 7 } }])
  })

  it('Google: 스트리밍 part 레벨 thoughtSignature 를 providerMeta.google 로 캡처한다 (#17-P1)', async () => {
    const { http } = mockStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc_s1","name":"lookup","args":{"id":7}},"thoughtSignature":"SIG_S"}]},"finishReason":"STOP"}]}\n\n',
    ])
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: () => {},
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 'fc_s1', name: 'lookup', input: { id: 7 }, providerMeta: { google: { thoughtSignature: 'SIG_S' } } },
    ])
  })

  it('Anthropic: 스트리밍 중 여러 tool_use 블록을 인덱스 순서로 누적한다 (#10 SP3)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\":1}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu2","name":"write"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\":2}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: () => {},
      tools: [{ name: 'read', parameters: { type: 'object' } }],
    })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 'tu1', name: 'read', input: { p: 1 } },
      { type: 'tool_use', id: 'tu2', name: 'write', input: { p: 2 } },
    ])
  })

  it('Anthropic: 스트리밍 tool_use 의 깨진 input_json 은 원문을 보존한다 (#10 SP3, OpenAI parseArgs 와 대칭)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"x"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{깨진"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: () => {},
      tools: [{ name: 'x', parameters: { type: 'object' } }],
    })
    // {} 로 무성 흡수하지 않고 원문을 보존한다 — 다운스트림 진단성 향상(빈 인자 위장 방지).
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu1', name: 'x', input: '{깨진' }])
  })

  it('OpenAI: 스트리밍 tool_calls 의 깨진 arguments 도 원문을 보존한다 (#10 SP3, anthropic 과 대칭)', async () => {
    const { http } = mockStreamHttp([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"x","arguments":"{깨진"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const p = createOpenAiProvider(baseOpenai, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: () => {},
      tools: [{ name: 'x', parameters: { type: 'object' } }],
    })
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'c1', name: 'x', input: '{깨진' }])
  })

  it('OpenAI: 스트리밍 중 여러 tool_calls 를 인덱스별로 누적한다 (#10 SP3)', async () => {
    const { http } = mockStreamHttp([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"write","arguments":"{\\"x\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], {
      onToken: () => {},
      tools: [{ name: 'read', parameters: { type: 'object' } }],
    })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 'c1', name: 'read', input: {} },
      { type: 'tool_use', id: 'c2', name: 'write', input: { x: 1 } },
    ])
  })

  it('Anthropic streaming: 중간 error 이벤트는 ApiProviderError 로 throw(부분응답 위장 방지)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"부분"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    await expect(p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })).rejects.toBeInstanceOf(ApiProviderError)
  })

  it('OpenAI streaming: 중간 error 페이로드는 ApiProviderError 로 throw(부분응답 위장 방지, anthropic 과 대칭)', async () => {
    const { http } = mockStreamHttp([
      'data: {"choices":[{"delta":{"content":"부분"},"finish_reason":null}]}\n\n',
      'data: {"error":{"message":"overloaded","type":"server_error"}}\n\n',
    ])
    const p = createOpenAiProvider(baseOpenai, http)
    const err = await p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiProviderError)
    expect(err).toMatchObject({ provider: 'openai', status: 200 })
    expect((err as ApiProviderError).detail).toContain('overloaded')
  })

  it('Google streaming: 중간 error 페이로드는 ApiProviderError 로 throw(부분응답 위장 방지, anthropic 과 대칭)', async () => {
    const { http } = mockStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"text":"부분"}]}}]}\n\n',
      'data: {"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}\n\n',
    ])
    const p = createGoogleProvider(baseGoogle, http)
    const err = await p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiProviderError)
    expect(err).toMatchObject({ provider: 'google', status: 200 })
    expect((err as ApiProviderError).detail).toContain('overloaded')
  })

  it('OpenAI streaming: finish_reason 없이 끝나면 ApiProviderError 로 표면화한다(잘림 stop 위장 방지 — #7)', async () => {
    const { http } = mockStreamHttp([
      'data: {"choices":[{"delta":{"content":"잘"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"림"},"finish_reason":null}]}\n\n',
    ])
    const p = createOpenAiProvider(baseOpenai, http)
    await expect(p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })).rejects.toBeInstanceOf(ApiProviderError)
  })

  it('Google streaming: finishReason 없이 끝나면 ApiProviderError 로 표면화한다(잘림 stop 위장 방지 — #7)', async () => {
    const { http } = mockStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"text":"잘"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"림"}]}}]}\n\n',
    ])
    const p = createGoogleProvider(baseGoogle, http)
    await expect(p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })).rejects.toBeInstanceOf(ApiProviderError)
  })

  it('Anthropic streaming: message_delta(stop_reason) 없이 끝나면 ApiProviderError 로 표면화한다(잘림 stop 위장 방지 — #7)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"잘림"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    await expect(p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })).rejects.toBeInstanceOf(ApiProviderError)
  })

  it('Anthropic streaming: 이벤트 0개(빈 200 스트림)도 ApiProviderError 로 표면화한다(잘림 stop 위장 방지 — #7)', async () => {
    const { http } = mockStreamHttp([])
    const p = createAnthropicProvider(baseAnthropic, http)
    await expect(p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })).rejects.toBeInstanceOf(ApiProviderError)
  })

  it('Google: 프롬프트 차단(promptFeedback, 후보 없음)은 content_filter 로 표면화한다', async () => {
    const { http } = mockHttp(() => ({ body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3.5-flash', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'x' }])
    expect(out.text).toBe('')
    expect(out.finishReason).toBe('content_filter')
  })

  it('Google streaming: 프롬프트 차단도 content_filter 로 표면화한다', async () => {
    const { http } = mockStreamHttp(['data: {"promptFeedback":{"blockReason":"OTHER"}}\n\n'])
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3.5-flash', apiKey: 'k' }, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })
    expect(out.finishReason).toBe('content_filter')
  })

  it('Anthropic 스트림: thinking_delta+signature_delta 를 ordered content 로 누적하고 onToken 엔 안 흘린다 (#11-thinking)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"사고"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG_S"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"답"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: (d) => deltas.push(d) })
    expect(deltas).toEqual(['답']) // thinking 은 onToken 으로 안 흐른다
    expect(out.text).toBe('답')
    expect(out.content).toEqual([
      { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG_S' } } },
      { type: 'text', text: '답' },
    ])
  })

  it('Anthropic 스트림: display:omitted (signature_delta 만) 도 thinking 블록을 보존한다 (#11-thinking)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG_O"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"lookup"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {}, tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.content).toEqual([
      { type: 'thinking', text: '', providerMeta: { anthropic: { signature: 'SIG_O' } } },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: {} },
    ])
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu1', name: 'lookup', input: {} }])
  })

  it('Anthropic 스트림: thinking 이 없으면 content 를 설정하지 않는다(무회귀)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {} })
    expect(out.content).toBeUndefined()
    expect(out.text).toBe('hi')
  })

  it('Anthropic 스트림: 블록을 content_block 인덱스 순서로 복원한다(interleaved thinking/tool_use) (#11-thinking)', async () => {
    // adaptive 는 interleaved thinking 을 켠다 — 방어적으로 thinking↔tool_use 교차 순서를 그대로 보존하는지 잠근다.
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"S0"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"a"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"signature_delta","signature":"S2"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"t3","name":"b"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {}, tools: [{ name: 'a', parameters: { type: 'object' } }] })
    expect((out.content ?? []).map((b) => b.type)).toEqual(['thinking', 'tool_use', 'thinking', 'tool_use'])
    expect(out.content?.[0]).toEqual({ type: 'thinking', text: '', providerMeta: { anthropic: { signature: 'S0' } } })
    expect(out.content?.[2]).toEqual({ type: 'thinking', text: '', providerMeta: { anthropic: { signature: 'S2' } } })
    expect(out.toolCalls).toEqual([
      { type: 'tool_use', id: 't1', name: 'a', input: {} },
      { type: 'tool_use', id: 't3', name: 'b', input: {} },
    ])
  })

  it('Anthropic 스트림: redacted_thinking 블록(content_block_start.data)을 보존한다 (#11-thinking)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"RD_S"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"lookup"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {}, tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.content).toEqual([
      { type: 'thinking', text: '', providerMeta: { anthropic: { redactedData: 'RD_S' } } },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: {} },
    ])
  })

  it('OpenAI streaming: 구조화 출력 거부(delta.refusal)도 content_filter 로 표면화한다(#7)', async () => {
    const { http } = mockStreamHttp([
      'data: {"choices":[{"delta":{"refusal":"안전상 "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"refusal":"거부합니다"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const p = createOpenAiProvider(baseOpenai, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'x' }], { onToken: (d) => deltas.push(d) })
    expect(out.finishReason).toBe('content_filter')
    expect(out.text).toBe('')
    expect(out.rawFinishReason).toContain('거부')
    expect(deltas).toEqual([]) // 거부는 content 토큰으로 흘리지 않는다(빈 응답 위장 방지와 대칭)
  })
})

describe('스트리밍 구조화-출력 400 graceful degradation (#26 후속 b)', () => {
  const schemaOpt = { name: 'v', schema: { type: 'object' } }

  it('Anthropic: 스트리밍+responseSchema 400 → format 제거 후 1회 재시도(스트리밍 유지)', async () => {
    const { http, calls } = mock400ThenStream([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'x' }], {
      onToken: (d) => deltas.push(d),
      responseSchema: schemaOpt,
    })
    expect(calls).toHaveLength(2)
    const b0 = JSON.parse(calls[0].init.body) as { output_config?: Record<string, unknown>; stream?: boolean }
    expect(b0.output_config?.format).toBeDefined()
    const b1 = JSON.parse(calls[1].init.body) as { output_config?: Record<string, unknown>; stream?: boolean }
    expect(b1.output_config).toBeUndefined()
    expect(b1.stream).toBe(true) // 재시도도 스트리밍 요청 유지
    expect(out.text).toBe('{}')
    expect(deltas).toEqual(['{}'])
  })

  it('Anthropic: 재시도 strip 은 format 만 제거하고 output_config.effort(thinking)는 보존한다', async () => {
    const { http, calls } = mock400ThenStream([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'x' }], {
      onToken: () => {},
      responseSchema: schemaOpt,
      thinking: { effort: 'low' },
    })
    const b1 = JSON.parse(calls[1].init.body) as { output_config?: Record<string, unknown> }
    expect(b1.output_config?.format).toBeUndefined()
    expect(b1.output_config?.effort).toBe('low')
  })

  it('OpenAI: 스트리밍+responseSchema 400 → response_format 제거 후 1회 재시도(스트리밍 유지)', async () => {
    const { http, calls } = mock400ThenStream([
      'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const p = createOpenAiProvider(baseOpenai, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { onToken: () => {}, responseSchema: schemaOpt })
    expect(calls).toHaveLength(2)
    const b0 = JSON.parse(calls[0].init.body) as { response_format?: unknown; stream?: boolean }
    expect(b0.response_format).toBeDefined()
    const b1 = JSON.parse(calls[1].init.body) as { response_format?: unknown; stream?: boolean }
    expect(b1.response_format).toBeUndefined()
    expect(b1.stream).toBe(true)
    expect(out.text).toBe('{}')
  })

  it('Google: 스트리밍+responseSchema 400 → responseSchema/responseMimeType 제거 후 1회 재시도', async () => {
    const { http, calls } = mock400ThenStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"{}"}]},"finishReason":"STOP"}]}\n\n',
    ])
    const p = createGoogleProvider(baseGoogle, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { onToken: () => {}, responseSchema: schemaOpt })
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toContain('streamGenerateContent?alt=sse') // 재시도도 스트리밍 엔드포인트 유지
    const b1 = JSON.parse(calls[1].init.body) as { generationConfig?: Record<string, unknown> }
    expect(b1.generationConfig?.responseSchema).toBeUndefined()
    expect(b1.generationConfig?.responseMimeType).toBeUndefined()
    expect(out.text).toBe('{}')
  })

  it('스트리밍 400 이라도 responseSchema 가 없으면 재시도하지 않는다(에러 보존)', async () => {
    const { http, calls } = mock400ThenStream([])
    const p = createAnthropicProvider(baseAnthropic, http)
    await expect(p.chat([{ role: 'user', content: 'x' }], { onToken: () => {} })).rejects.toBeInstanceOf(ApiProviderError)
    expect(calls).toHaveLength(1)
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

describe('sendWithSchemaFallback', () => {
  const ok = (): HttpResponse => ({ ok: true, status: 200, text: async () => 'ok' })
  const bad400 = (): HttpResponse => ({ ok: false, status: 400, text: async () => 'unsupported' })

  it('성공(200)이면 재시도 없이 그대로 반환', async () => {
    let n = 0
    const res = await sendWithSchemaFallback(async () => { n++; return ok() }, true, () => { throw new Error('strip 호출 금지') })
    expect(res.status).toBe(200)
    expect(n).toBe(1)
  })

  it('스키마 있고 400 이면 stripSchema 후 1회 재시도', async () => {
    let n = 0
    let stripped = false
    const res = await sendWithSchemaFallback(
      async () => { n++; return n === 1 ? bad400() : ok() },
      true,
      () => { stripped = true },
    )
    expect(stripped).toBe(true)
    expect(n).toBe(2)
    expect(res.status).toBe(200)
  })

  it('스키마 없으면 400 이라도 재시도하지 않는다', async () => {
    let n = 0
    const res = await sendWithSchemaFallback(async () => { n++; return bad400() }, false, () => { throw new Error('strip 금지') })
    expect(n).toBe(1)
    expect(res.status).toBe(400)
  })
})
