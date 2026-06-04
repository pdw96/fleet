import type { CliOutputFormat, StreamParseFormat } from '../../../shared/types'

/** codex `exec --json` 이벤트의 최소 형태. 알 수 없는 필드는 무시한다. */
interface CodexEvent {
  type?: unknown
  item?: { type?: unknown; text?: unknown }
}

/**
 * codex `exec --json` 의 JSONL 이벤트 스트림에서 최종 에이전트 메시지만 추출한다.
 *
 * codex 0.136 스키마:
 *   {"type":"thread.started", ...}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"<응답>"}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * 배너/설정/thinking/토큰 사용량 등 메타는 모두 버린다. agent_message 가 여러 번
 * 나오면 codex 의 `--output-last-message` 와 동일하게 "마지막" 메시지를 반환한다
 * (리뷰 판정처럼 첫 토큰 prefix 로 파싱하는 소비자가 narration 에 오염되지 않도록).
 *
 * JSON 으로 파싱되지 않는 줄(예: "Reading additional input from stdin...")은 건너뛴다.
 */
export function parseCodexJsonl(raw: string): string {
  let last = ''
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    // 빠른 경로: JSONL 이벤트가 아닌 줄(빈 줄/안내 문구)은 즉시 스킵.
    if (trimmed.charCodeAt(0) !== 0x7b /* '{' */) continue
    let evt: CodexEvent
    try {
      evt = JSON.parse(trimmed) as CodexEvent
    } catch {
      continue
    }
    if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
      last = evt.item.text
    }
  }
  return last.trim()
}

/**
 * codex `exec --json` 스트림에서 세션 식별자(thread_id)를 추출한다.
 * 첫 이벤트 `{"type":"thread.started","thread_id":"<uuid>"}` 에서 얻으며,
 * 이 id 를 `codex exec resume <id>` 에 넘겨 대화를 이어간다(실측 확인: codex 0.136).
 * 안내 줄/깨진 JSON 줄은 건너뛴다.
 */
export function extractCodexThreadId(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.charCodeAt(0) !== 0x7b /* '{' */) continue
    try {
      const evt = JSON.parse(trimmed) as { type?: unknown; thread_id?: unknown }
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') return evt.thread_id
    } catch {
      continue
    }
  }
  return undefined
}

/** 스트림 1라인 파서의 최소 형태. */
interface StreamLine {
  type?: unknown
  role?: unknown
  delta?: unknown
  content?: unknown
  event?: { delta?: { type?: unknown; text?: unknown } }
  item?: { type?: unknown; text?: unknown }
}

/**
 * 스트림 JSONL 한 줄에서 사용자에게 보일 '텍스트 델타'를 추출한다(없으면 빈 문자열).
 * 포맷별 이벤트 형태는 실측 확정(claude docs / gemini 0.45.0 / codex 0.136).
 * JSON 이 아닌 줄(안내/빈 줄)은 빈 문자열로 무시한다.
 */
export function parseStreamLine(format: StreamParseFormat, line: string): string {
  const trimmed = line.trim()
  if (trimmed.charCodeAt(0) !== 0x7b /* '{' */) return ''
  let e: StreamLine
  try {
    e = JSON.parse(trimmed) as StreamLine
  } catch {
    return ''
  }
  switch (format) {
    case 'claude-stream':
      return e.type === 'stream_event' && e.event?.delta?.type === 'text_delta' && typeof e.event.delta.text === 'string'
        ? e.event.delta.text
        : ''
    case 'gemini-stream':
      return e.type === 'message' && e.role === 'assistant' && e.delta === true && typeof e.content === 'string'
        ? e.content
        : ''
    case 'codex-jsonl':
      return e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string'
        ? e.item.text
        : ''
    default:
      return ''
  }
}

/**
 * 헤드리스 stdout 정제 디스패처 — adapter.headless.parse 전략에 따라 메타를 제거한다.
 * 'codex-jsonl' 에서 agent_message 를 못 찾으면(비정상 종료 등) 원문 트림으로 폴백해
 * 응답을 조용히 빈 문자열로 잃지 않는다.
 */
export function cleanCliOutput(format: CliOutputFormat | undefined, raw: string): string {
  switch (format) {
    case 'codex-jsonl':
      return parseCodexJsonl(raw) || raw.trim()
    case 'text':
    default:
      return raw.trim()
  }
}
