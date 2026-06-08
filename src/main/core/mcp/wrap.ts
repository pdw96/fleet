import type { RiskLevel } from '../../../shared/types'
import type { FleetTool } from '../tools/types'
import type { McpClient, McpToolInfo } from './types'

/** 결과 문자열 길이 상한(컨텍스트 폭주 방지). */
const MAX_RESULT_CHARS = 64 * 1024
/** provider 도구 이름 길이 제약([A-Za-z0-9_-]{1,64}). */
const MAX_TOOL_NAME_LEN = 64

/** provider 도구 이름 제약에 맞게 정규화. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** MCP content 항목 배열을 도구 결과 문자열로 변환한다(텍스트 결합·비텍스트 placeholder·길이 바운드). */
export function contentToString(content: Array<Record<string, unknown>>): string {
  const parts = content.map((item) => {
    const type = item['type']
    if (type === 'text') return typeof item['text'] === 'string' ? item['text'] : ''
    if (type === 'image') {
      const mime = typeof item['mimeType'] === 'string' ? item['mimeType'] : 'image'
      const data = typeof item['data'] === 'string' ? item['data'] : ''
      return `[image ${mime} ${data.length}바이트]`
    }
    if (type === 'resource') {
      const res = item['resource'] as { uri?: unknown } | undefined
      const uri = res && typeof res.uri === 'string' ? res.uri : ''
      return `[resource ${uri}]`
    }
    return `[${typeof type === 'string' ? type : 'unknown'}]`
  })
  const joined = parts.join('\n')
  if (joined.length > MAX_RESULT_CHARS) {
    return `${joined.slice(0, MAX_RESULT_CHARS)}\n…(${joined.length}자 중 ${MAX_RESULT_CHARS}자만 표시)`
  }
  return joined
}

/**
 * MCP 도구 1개를 FleetTool 로 감싼다. 이름은 mcp__<server>__<tool> 로 프리픽스한다.
 * provider 이름 제약(64자)을 넘으면 null 을 반환한다(호출자가 skip + 감사 경고).
 * 기본 위험도 destructive, annotations.readOnlyHint===true 면 caution.
 */
export function wrapMcpTool(serverName: string, tool: McpToolInfo, client: McpClient): FleetTool | null {
  const name = `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`
  if (name.length > MAX_TOOL_NAME_LEN) return null
  const risk: RiskLevel = tool.annotations?.readOnlyHint === true ? 'caution' : 'destructive'
  return {
    definition: {
      name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: 'object' },
    },
    classify: () => risk,
    async execute(input, ctx) {
      const result = await client.callTool(tool.name, input, { signal: ctx.signal })
      const text = contentToString(result.content)
      if (result.isError) throw new Error(text || 'MCP 도구 오류')
      return text
    },
  }
}
