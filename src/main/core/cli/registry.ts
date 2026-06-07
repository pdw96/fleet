import type { CliAdapter } from '../../../shared/types'

/**
 * 기본 CLI 어댑터 (요구사항 2A). 구독제/TUI 기반 LLM CLI.
 * 새 CLI 는 여기에 추가하거나 런타임에 registry.register() 로 확장한다.
 */
export const DEFAULT_CLI_ADAPTERS: readonly CliAdapter[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    modelFlag: '--model',
    // 프롬프트는 stdin 으로 전달(claude -p 는 stdin 을 프롬프트로 읽는다). 긴 전사도 argv 길이 한도에 안 걸린다.
    promptVia: 'stdin',
    headless: { args: ['-p'] },
    // 세션 재개(검증: v2.1.162). UUID 사전지정 → 첫 호출 --session-id, 이후 --resume. 프롬프트는 stdin.
    session: {
      startArgs: ['-p', '--session-id', '{sessionId}'],
      resumeArgs: ['-p', '--resume', '{sessionId}'],
      idSource: 'preassigned',
    },
    // 토큰 스트리밍(docs 확정). text_delta 이벤트로 부분 텍스트가 흐른다.
    streaming: { args: ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'], parse: 'claude-stream' },
    // 워크스페이스 직접 편집(실측: v2.1.163). -p 헤드리스 + --permission-mode acceptEdits 로 편집 도구만 자동 승인(전체 우회 아님). cwd=workspace 는 세션이 설정.
    edit: { args: ['-p', '--permission-mode', 'acceptEdits'], parse: 'text' },
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    modelFlag: '--model',
    // 프롬프트는 stdin 으로(codex exec 는 프롬프트 미지정 시 stdin 을 읽는다 — "Reading prompt from stdin...").
    promptVia: 'stdin',
    // --json: 사람용 배너/thinking/토큰 메타 대신 JSONL 이벤트로 출력 → agent_message 만 정제.
    headless: { args: ['exec', '--json'], parse: 'codex-jsonl' },
    // 세션 재개(실측: codex 0.136). id 사전지정 불가 → 첫 응답 thread.started 의 thread_id 캡처.
    // resume 시그니처: `exec resume [OPTIONS] <SESSION_ID> <PROMPT>`. PROMPT 는 stdin 으로 대체(실측 통과).
    session: {
      startArgs: ['exec', '--json'],
      resumeArgs: ['exec', 'resume', '--json', '{sessionId}'],
      idSource: 'codex-thread',
    },
    // base 인자에 --json 이 이미 있어 추가 인자 없음. agent_message 는 이벤트 단위(토큰 델타 아님).
    streaming: { args: [], parse: 'codex-jsonl' },
    // 워크스페이스 직접 편집(실측: codex 0.136). -C 로 작업 루트 지정, -s workspace-write 로 워크스페이스 안만 쓰기 허용.
    edit: { args: ['exec', '--json', '-C', '{workspace}', '-s', 'workspace-write'], parse: 'codex-jsonl' },
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    versionArgs: ['--version'],
    modelFlag: '--model',
    // 프롬프트는 stdin 으로. gemini 는 npm .cmd 셰임이라 cross-spawn 이 cmd.exe 경유 → argv 한도 ~8191자로
    // 가장 빨리 걸린다. `-p ""`(빈 값)로 비대화형(헤드리스) 모드만 켜고 프롬프트는 stdin 에 싣는다
    // (gemini: -p 값은 "Appended to input on stdin"). 실측: 코드워드 왕복 통과.
    promptVia: 'stdin',
    headless: { args: ['-p', ''] },
    // 세션 재개(실측: gemini 0.45.0, 코드워드 왕복 통과). claude 와 동형(UUID 사전지정).
    session: {
      startArgs: ['-p', '', '--session-id', '{sessionId}'],
      resumeArgs: ['-p', '', '--resume', '{sessionId}'],
      idSource: 'preassigned',
    },
    // 토큰 스트리밍(실측 0.45.0). message/assistant delta:true 의 content 로 부분 텍스트가 흐른다.
    streaming: { args: ['--output-format', 'stream-json'], parse: 'gemini-stream' },
    // 워크스페이스 직접 편집(실측: gemini 0.45.0). -p 헤드리스 + --approval-mode auto_edit 로 편집 도구만 자동 승인(yolo 전체 우회 아님). cwd=workspace 는 세션이 설정.
    edit: { args: ['-p', '', '--approval-mode', 'auto_edit'], parse: 'text' },
  },
]

export interface CliRegistry {
  list(): CliAdapter[]
  register(adapter: CliAdapter): void
  get(id: string): CliAdapter | undefined
}

/** 확장 가능한 CLI 레지스트리 — 기본 어댑터로 시드된다. */
export function createCliRegistry(seed: readonly CliAdapter[] = DEFAULT_CLI_ADAPTERS): CliRegistry {
  const map = new Map<string, CliAdapter>(seed.map((a) => [a.id, a]))
  return {
    list: () => [...map.values()],
    register: (adapter) => {
      map.set(adapter.id, adapter)
    },
    get: (id) => map.get(id),
  }
}
