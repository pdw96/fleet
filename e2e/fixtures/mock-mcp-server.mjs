// 최소 stdio JSON-RPC MCP 서버(E2E 픽스처). 외부 의존·네트워크 없이 결정론적으로
// initialize / tools/list / tools/call 만 응답한다 — Playwright 가 MCP 호스트 연결을 검증하는 용도.
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    nl = buffer.indexOf('\n')
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id == null) continue // 알림(notifications/initialized 등)은 응답하지 않는다

    let result
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'mock', version: '0.0.0' },
      }
    } else if (msg.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'echo',
            description: '입력을 그대로 반환한다(테스트용).',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      }
    } else if (msg.method === 'tools/call') {
      // long-running 도구 시뮬레이트 — 요청에 progressToken 이 있으면 결과 전에 진행 알림을 보낸다.
      const token = msg.params?._meta?.progressToken
      if (token != null) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 1, message: 'echo 처리 중' } })}\n`,
        )
      }
      const args = msg.params?.arguments ?? {}
      result = {
        content: [{ type: 'text', text: `echo: ${JSON.stringify(args)}` }],
        // 구조화 결과도 함께 제공한다(텍스트와 동등 — 스펙 SHOULD). 클라이언트는 텍스트를 우선 소비한다.
        structuredContent: { echoed: args },
      }
    } else {
      result = {}
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
  }
})
