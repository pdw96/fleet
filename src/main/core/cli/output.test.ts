import { describe, expect, it } from 'vitest'
import { cleanCliOutput, extractCodexThreadId, parseCodexJsonl } from './output'

// 실제 codex 0.136 `exec --json` 출력 (read-only, "PONG" 응답)에서 캡처한 스트림.
// 맨 앞의 stdin 안내 줄은 JSON 이 아니며 반드시 무시되어야 한다.
const REAL_CODEX_JSONL = [
  'Reading additional input from stdin...',
  '{"type":"thread.started","thread_id":"019e91da-8481-73c1-bf7f-03219075f106"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":24495,"cached_input_tokens":17792,"output_tokens":20}}',
].join('\n')

describe('parseCodexJsonl', () => {
  it('실제 스트림에서 agent_message 텍스트만 추출하고 메타/안내 줄을 버린다', () => {
    expect(parseCodexJsonl(REAL_CODEX_JSONL)).toBe('PONG')
  })

  it('agent_message 가 여러 번이면 마지막 것을 반환한다(--output-last-message 의미)', () => {
    const stream = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"검토 중..."}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"APPROVE"}}',
    ].join('\n')
    expect(parseCodexJsonl(stream)).toBe('APPROVE')
  })

  it('여러 줄 응답과 CRLF 개행을 보존/처리한다', () => {
    const stream =
      '{"type":"turn.started"}\r\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"줄1\\n줄2"}}\r\n' +
      '{"type":"turn.completed"}'
    expect(parseCodexJsonl(stream)).toBe('줄1\n줄2')
  })

  it('thinking/tool 등 다른 item 타입은 무시한다', () => {
    const stream = [
      '{"type":"item.completed","item":{"type":"reasoning","text":"속으로 생각"}}',
      '{"type":"item.completed","item":{"type":"command_execution","text":"ls"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"최종"}}',
    ].join('\n')
    expect(parseCodexJsonl(stream)).toBe('최종')
  })

  it('agent_message 가 없으면 빈 문자열을 반환한다', () => {
    const stream = '{"type":"thread.started"}\n{"type":"turn.completed"}'
    expect(parseCodexJsonl(stream)).toBe('')
  })

  it('깨진 JSON 줄을 만나도 throw 하지 않고 건너뛴다', () => {
    const stream = [
      '{ this is not json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
    ].join('\n')
    expect(parseCodexJsonl(stream)).toBe('ok')
  })
})

describe('extractCodexThreadId', () => {
  it('thread.started 이벤트에서 thread_id 를 추출한다(실측 스트림)', () => {
    expect(extractCodexThreadId(REAL_CODEX_JSONL)).toBe('019e91da-8481-73c1-bf7f-03219075f106')
  })

  it('안내 줄/깨진 JSON 줄을 건너뛰고 첫 thread_id 를 찾는다', () => {
    const stream = [
      'Reading additional input from stdin...',
      '{ broken json',
      '{"type":"thread.started","thread_id":"tid-9"}',
      '{"type":"turn.started"}',
    ].join('\n')
    expect(extractCodexThreadId(stream)).toBe('tid-9')
  })

  it('thread.started 가 없으면 undefined 를 반환한다', () => {
    expect(extractCodexThreadId('{"type":"turn.started"}\n{"type":"turn.completed"}')).toBeUndefined()
  })
})

describe('cleanCliOutput', () => {
  it("'codex-jsonl' 은 agent_message 를 추출한다", () => {
    expect(cleanCliOutput('codex-jsonl', REAL_CODEX_JSONL)).toBe('PONG')
  })

  it("'codex-jsonl' 에서 메시지가 없으면 원문 트림으로 폴백한다", () => {
    expect(cleanCliOutput('codex-jsonl', '  비정상 출력  ')).toBe('비정상 출력')
  })

  it("'text' 와 미지정은 트림만 한다", () => {
    expect(cleanCliOutput('text', '  응답  \n')).toBe('응답')
    expect(cleanCliOutput(undefined, '  응답  \n')).toBe('응답')
  })
})
