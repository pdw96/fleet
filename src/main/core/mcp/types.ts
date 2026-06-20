import type { McpServerSpec, McpServerStatus } from '../../../shared/types'
import type { ApprovalGate } from '../safety/approval'
import type { FleetTool } from '../tools/types'

/**
 * child process 의 최소 추상. electron/Node 타입을 코어에 누설하지 않고
 * 테스트에서 fake 를 주입하기 위한 좁은 인터페이스.
 */
export interface McpChild {
  /** 한 줄(개행 포함) 직렬화 메시지를 stdin 으로 쓴다. */
  write(line: string): void
  /** stdout 디코드 청크(부분 메시지 가능). */
  onStdout(handler: (chunk: string) => void): void
  /** 프로세스 종료/오류. err 는 spawn 실패 등. */
  onClose(handler: (err?: Error) => void): void
  kill(): void
}

/** McpServerSpec → 살아있는 자식 프로세스. */
export type SpawnFn = (spec: McpServerSpec) => McpChild

/** JSON-RPC 메시지를 주고받는 transport(개행 프레이밍을 캡슐화). */
export interface McpTransport {
  send(message: Record<string, unknown>): void
  onMessage(handler: (msg: Record<string, unknown>) => void): void
  onClose(handler: (err?: Error) => void): void
  close(): void
}

/** tools/list 항목 메타. */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** MCP 도구 annotations. 신뢰 서버 외엔 untrusted 라 위험도 강등에 쓰지 않는다(MCP 스펙). */
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown }
  /**
   * task-augmented 실행 지원도(2025-11-25). 'required' 는 task invocation(params.task → tasks/result
   * 폴링)을 강제하므로 plain tools/call 로는 실패한다 — Fleet 은 task flow 미구현이라 노출하지 않는다.
   * 'optional'/'forbidden'(기본)은 plain call 가능해 그대로 노출한다.
   */
  execution?: { taskSupport?: 'forbidden' | 'optional' | 'required' }
}

/** tools/call 결과. */
export interface McpCallResult {
  /** content 항목 배열({type:'text'|'image'|'resource'|...}). */
  content: Array<Record<string, unknown>>
  isError?: boolean
  /**
   * 구조화 결과(MCP structuredContent). 서버가 제공할 때만 존재한다. conformant 서버는 동등한
   * 텍스트 content 도 함께 보내므로(스펙 SHOULD) 텍스트 소비만으로 무손실이지만, text 가 없는
   * 서버를 위해 보존한다(wrap 의 fallback 직렬화에서 사용).
   */
  structuredContent?: Record<string, unknown>
}

/** MCP notifications/progress 의 진행 이벤트(progressToken 상관은 client 내부에서 처리). */
export interface McpProgress {
  /** 현재 진행값(단조 증가). */
  progress: number
  /** 전체값(알려진 경우만). */
  total?: number
  /** 사람이 읽는 상태 문자열(선택). */
  message?: string
}

/** 단일 MCP 서버 세션. */
export interface McpClient {
  /** initialize → notifications/initialized. */
  initialize(): Promise<void>
  listTools(): Promise<McpToolInfo[]>
  callTool(
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal; onProgress?: (e: McpProgress) => void },
  ): Promise<McpCallResult>
  /** 연결 종료(자식 종료/명시적 close) 통지. 호스트가 죽은 서버의 도구를 무효화하는 데 쓴다. */
  onClose(handler: (err?: Error) => void): void
  /** 서버의 notifications/tools/list_changed 통지. 호스트가 도구 목록을 다시 가져오는 데 쓴다. */
  onToolsChanged(handler: () => void): void
  close(): void
}

export interface McpClientOptions {
  /** 요청 타임아웃(기본 30_000ms). */
  requestTimeoutMs?: number
  /** 타이머 주입(테스트용, 기본 setTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** 다중 MCP 서버 연결을 관리하고 도구를 FleetTool 로 노출하는 호스트. */
export interface McpHost {
  /** 서버 목록을 전체 교체(diff 연결). 서버별 상태 반환. */
  setServers(specs: McpServerSpec[]): Promise<McpServerStatus[]>
  /** 연결된 모든 서버의 FleetTool(동기, 캐시). */
  tools(): FleetTool[]
  status(): McpServerStatus[]
  /** 모든 자식 프로세스 종료. */
  dispose(): Promise<void>
}

export interface McpHostOptions {
  spawn?: SpawnFn
  onAudit?: (type: string, data: Record<string, unknown>) => void
  clientOptions?: McpClientOptions
  /** 새 MCP 서버 spawn 전 통과할 승인 게이트(shell 실행 = ApprovalGate, AGENTS.md 안전 우선). 미주입 시 게이팅 생략(테스트용). */
  gate?: ApprovalGate
}
