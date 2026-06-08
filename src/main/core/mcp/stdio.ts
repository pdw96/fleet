import spawn from 'cross-spawn'
import type { McpServerSpec } from '../../../shared/types'
import type { McpChild, McpTransport, SpawnFn } from './types'

/**
 * 기본 spawn: cross-spawn 으로 자식을 띄우고 McpChild 로 감싼다.
 * stderr 는 부모로 inherit 한다(파이프 버퍼 포화로 자식이 막히는 것을 방지, 디버깅 가시성).
 */
export const defaultSpawn: SpawnFn = (spec: McpServerSpec): McpChild => {
  const child = spawn(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.stdout?.setEncoding('utf8')
  // 자식이 stdin 을 읽기 전에 죽으면 write 가 EPIPE 를 낼 수 있다 — close/error 가 처리.
  child.stdin?.on('error', () => {})
  return {
    write: (line) => {
      child.stdin?.write(line)
    },
    onStdout: (handler) => {
      child.stdout?.on('data', (c: string) => handler(c))
    },
    onClose: (handler) => {
      child.on('error', (err: Error) => handler(err))
      child.on('close', () => handler())
    },
    kill: () => {
      child.kill()
    },
  }
}

/**
 * stdio JSON-RPC transport. 자식 stdout 을 개행 구분 JSON 으로 프레이밍한다
 * (MCP stdio: 메시지는 개행으로 구분되며 메시지 내부에 개행이 없다). 부분 청크는 버퍼링한다.
 */
export function createStdioTransport(spec: McpServerSpec, spawnFn: SpawnFn): McpTransport {
  const child = spawnFn(spec)
  let buffer = ''
  let messageHandler: ((msg: Record<string, unknown>) => void) | undefined
  let closeHandler: ((err?: Error) => void) | undefined
  let closed = false

  child.onStdout((chunk) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) {
        try {
          messageHandler?.(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // 잘못된 JSON 라인은 버린다(연결 전체를 깨지 않음).
        }
      }
      nl = buffer.indexOf('\n')
    }
  })
  child.onClose((err) => {
    if (closed) return
    closed = true
    closeHandler?.(err)
  })

  return {
    send: (message) => {
      child.write(`${JSON.stringify(message)}\n`)
    },
    onMessage: (handler) => {
      messageHandler = handler
    },
    onClose: (handler) => {
      closeHandler = handler
    },
    close: () => {
      if (closed) return
      closed = true
      child.kill()
    },
  }
}
