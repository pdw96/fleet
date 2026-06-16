import spawn from 'cross-spawn'
import type { McpServerSpec } from '../../../shared/types'
import { killTree } from '../process/kill-tree'
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
      // Windows 에서 cross-spawn 은 cmd.exe 셰임 경유라 child.kill() 은 껍데기만 죽인다 → 트리 킬.
      void killTree(child)
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
  // 종료 통지를 단일 지점으로 일원화한다. 우리가 close() 로 죽이든 자식이 스스로 죽든
  // closeHandler 가 정확히 한 번 불려야 한다(과거엔 close() 가 closed 를 먼저 세워 child.onClose 를
  // early-return 시켜, 진행 중 요청이 30초 타임아웃까지 매달리는 버그가 있었다).
  const notifyClose = (err?: Error): void => {
    if (closed) return
    closed = true
    closeHandler?.(err)
  }
  child.onClose((err) => notifyClose(err))

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
      child.kill()
      notifyClose(new Error('MCP 연결을 닫았습니다.'))
    },
  }
}
