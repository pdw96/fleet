import { describe, expect, it } from 'vitest'
import { contentToString, wrapMcpTool } from './wrap'
import type { McpClient } from './types'

/** 기본 fake client — callTool 만 오버라이드해 결과를 조정. */
function fakeClient(over: Partial<McpClient> = {}): McpClient {
  return {
    async initialize() {},
    async listTools() {
      return []
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'result' }] }
    },
    onClose() {},
    onToolsChanged() {},
    close() {},
    ...over,
  }
}

describe('wrapMcpTool', () => {
  it('이름을 mcp__<server>__<tool> 로 프리픽스하고 sanitize 한다', () => {
    const t = wrapMcpTool('my server', { name: 'do.thing' }, fakeClient())
    expect(t?.definition.name).toBe('mcp__my_server__do_thing')
  })

  it('이름이 64자를 넘으면 null 을 반환한다', () => {
    expect(wrapMcpTool('s', { name: 'x'.repeat(70) }, fakeClient())).toBeNull()
  })

  it('모든 MCP 도구를 destructive 로 분류한다(annotations 는 untrusted)', () => {
    // readOnlyHint 는 서버 자기신고라 신뢰하지 않는다(MCP 스펙). 항상 destructive.
    expect(
      wrapMcpTool('s', { name: 'r', annotations: { readOnlyHint: true } }, fakeClient())?.classify(
        {},
      ),
    ).toBe('destructive')
    expect(wrapMcpTool('s', { name: 'w' }, fakeClient())?.classify({})).toBe('destructive')
  })

  it('inputSchema 를 parameters 로 매핑(없으면 빈 object)', () => {
    expect(
      wrapMcpTool('s', { name: 'a', inputSchema: { type: 'object', properties: {} } }, fakeClient())
        ?.definition.parameters,
    ).toEqual({ type: 'object', properties: {} })
    expect(wrapMcpTool('s', { name: 'b' }, fakeClient())?.definition.parameters).toEqual({
      type: 'object',
    })
  })

  it('execute 는 text/image/resource content 를 결합한다', async () => {
    const client = fakeClient({
      async callTool() {
        return {
          content: [
            { type: 'text', text: 'line1' },
            { type: 'image', mimeType: 'image/png', data: 'abcd' },
            { type: 'resource', resource: { uri: 'file://x' } },
          ],
        }
      },
    })
    const out = await wrapMcpTool('s', { name: 't' }, client)?.execute({}, {})
    expect(out).toBe('line1\n[image image/png 4바이트]\n[resource file://x]')
  })

  it('isError 결과는 throw 한다', async () => {
    const client = fakeClient({
      async callTool() {
        return { content: [{ type: 'text', text: 'boom' }], isError: true }
      },
    })
    await expect(wrapMcpTool('s', { name: 't' }, client)?.execute({}, {})).rejects.toThrow('boom')
  })

  it('execute 는 원래 도구 이름·args·signal 을 callTool 로 전달한다', async () => {
    const seen: Array<{ name: string; args: unknown; hasSignal: boolean }> = []
    const client = fakeClient({
      async callTool(name, args, opts) {
        seen.push({ name, args, hasSignal: !!opts?.signal })
        return { content: [] }
      },
    })
    const ac = new AbortController()
    await wrapMcpTool('s', { name: 'orig' }, client)?.execute({ q: 1 }, { signal: ac.signal })
    expect(seen[0]).toEqual({ name: 'orig', args: { q: 1 }, hasSignal: true })
  })

  it('빈 도구 이름은 null 을 반환한다', () => {
    expect(wrapMcpTool('s', { name: '' }, fakeClient())).toBeNull()
  })
})

describe('contentToString', () => {
  it('필드 누락·미상 타입을 안전하게 처리한다', () => {
    expect(
      contentToString([
        { type: 'text' }, // text 필드 없음 → ''
        { type: 'resource', resource: {} }, // uri 없음 → '[resource ]'
        { type: 'audio' }, // 미상 타입 → '[audio]'
      ]),
    ).toBe('\n[resource ]\n[audio]')
  })

  it('resource_link 의 name·uri·mimeType 을 보존한다', () => {
    // resource_link 는 최상위에 uri/name/mimeType 을 둔다(중첩 resource 와 다름).
    expect(
      contentToString([
        { type: 'resource_link', uri: 'file://a.txt', name: 'a.txt', mimeType: 'text/plain' },
        { type: 'resource_link', uri: 'file://b' }, // name·mime 없음
        { type: 'resource_link' }, // uri 도 없음 → 폴백 [resource ] 가 아니라 빈 링크
      ]),
    ).toBe(
      '[resource_link a.txt file://a.txt text/plain]\n[resource_link file://b]\n[resource_link ]',
    )
  })
})
