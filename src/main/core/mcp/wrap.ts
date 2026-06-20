import type { RiskLevel } from '../../../shared/types'
import type { FleetTool } from '../tools/types'
import type { McpClient, McpProgress, McpToolInfo } from './types'

/** 결과 문자열 길이 상한(컨텍스트 폭주 방지). */
const MAX_RESULT_CHARS = 64 * 1024
/** provider 도구 이름 길이 제약([A-Za-z0-9_-]{1,64}). */
const MAX_TOOL_NAME_LEN = 64
/**
 * 도구 호출 1회당 표면화할 progress 알림 수 상한. 각 progress 는 감사 eventlog 에 영속(매 알림마다
 * 전체 스냅샷 재기록)되므로 악의/버그 서버의 고빈도 progress 가 디스크 폭주·앱 freeze 를 내지 않도록
 * 호출 스코프에서 cap 한다. 정상 마일스톤 진행은 이 상한 이내라 손실 없다.
 */
const MAX_PROGRESS_EVENTS_PER_CALL = 100

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
    if (type === 'resource_link') {
      // resource_link 는 uri/name/mimeType 을 최상위에 둔다(중첩 resource 분기로는 안 잡힘).
      const uri = typeof item['uri'] === 'string' ? item['uri'] : ''
      const name = typeof item['name'] === 'string' ? item['name'] : ''
      const mime = typeof item['mimeType'] === 'string' ? ` ${item['mimeType']}` : ''
      return `[resource_link ${name ? `${name} ` : ''}${uri}${mime}]`
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
 * 위험도는 항상 destructive — annotations(readOnlyHint)는 서버 자기신고라 신뢰하지 않는다(MCP 스펙).
 * onProgress 를 주면 long-running 도구 호출의 진행 알림을 그쪽으로 흘려보낸다(호스트가 감사로 연결).
 */
export function wrapMcpTool(
  serverName: string,
  tool: McpToolInfo,
  client: McpClient,
  onProgress?: (e: McpProgress) => void,
): FleetTool | null {
  const toolPart = sanitize(tool.name)
  if (toolPart.length === 0) return null // 빈 도구 이름 — 식별·호출 불가
  const name = `mcp__${sanitize(serverName)}__${toolPart}`
  if (name.length > MAX_TOOL_NAME_LEN) return null
  // 안전 우선: MCP 도구는 임의 부작용이 가능하고 annotations(readOnlyHint)는 서버 자기신고라
  // 신뢰할 수 없다(MCP 스펙). 전부 destructive 로 분류해 승인 게이트를 강제한다.
  const risk: RiskLevel = 'destructive'
  return {
    definition: {
      name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: 'object' },
    },
    classify: () => risk,
    async execute(input, ctx) {
      // 호출 스코프 progress cap — onProgress 가 있을 때만 래핑(없으면 콜백 비용 0).
      let progressCount = 0
      const cappedProgress = onProgress
        ? (e: McpProgress): void => {
            if (progressCount++ < MAX_PROGRESS_EVENTS_PER_CALL) onProgress(e)
          }
        : undefined
      const result = await client.callTool(tool.name, input, {
        signal: ctx.signal,
        onProgress: cappedProgress,
      })
      let text = contentToString(result.content)
      // conformant 서버는 structuredContent 와 동등한 텍스트 content 를 함께 보내(스펙 SHOULD) 텍스트
      // 우선 소비로 무손실이다. 텍스트가 비고 structuredContent 만 온 경우(SHOULD 위반)만 JSON fallback.
      // 동일 변환 경로(contentToString)를 거쳐 MAX_RESULT_CHARS 바운드를 적용한다 — 거대 구조화 결과가
      // 길이 캡을 우회해 컨텍스트로 새지 않도록(untrusted 서버 방어).
      if (text === '' && result.structuredContent != null) {
        text = contentToString([{ type: 'text', text: JSON.stringify(result.structuredContent) }])
      }
      if (result.isError) throw new Error(text || 'MCP 도구 오류')
      return text
    },
  }
}
