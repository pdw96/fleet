import type { CliAdapter } from '../../../shared/types'
import { CLI_AUTH_INSTALL_META as META } from '../../../shared/cliAuthInstallMeta'

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
    // MCP 패스스루(실측: --mcp-config 는 파일 경로 또는 인라인 JSON 수용). --strict-mcp-config 로
    // 전달된 설정만 쓰게 격리(Fleet 의 독립 호출 철학과 일치). codex/gemini 는 CLI 플래그가 아닌
    // 설정파일(config.toml / settings.json)로 MCP 를 받으므로 여기서 패스스루하지 않는다.
    mcpConfigFlag: '--mcp-config',
    mcpStrictArg: '--strict-mcp-config',
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
    streaming: {
      args: ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
      parse: 'claude-stream',
    },
    // 워크스페이스 직접 편집(실측: v2.1.163). -p 헤드리스 + --permission-mode acceptEdits 로 편집 도구만 자동 승인(전체 우회 아님). cwd=workspace 는 세션이 설정.
    // [#167] 검증 도구(node --check 등)를 --allowedTools 로 자동허용하지 않는다 — `Bash(node --check:*)`
    // 같은 prefix allow 규칙은 후행 인자를 임의 매칭하는데, node 의 preload 플래그(--require/--import/
    // --experimental-loader)는 --check 에도 코드를 실행한다(실측: `node --check --import "data:..."` 가
    // 파일 0건으로 인라인 실행, claude 가 자동승인). prefix 규칙으로는 이 부정 제약을 표현할 수 없어
    // acceptEdits 의 "쓰기만·실행 차단" 경계를 RCE+네트워크로 깬다. 헤드리스 self-verify 가 필요하면
    // preload 를 차단하는 검증 래퍼만 별도 allow 해야 한다(미구현). implementer 는 read-only 빌트인
    // (Read/Grep/Glob)으로 검토하고, 실제 verify(typecheck/lint/test)는 Fleet 이 별도 실행한다.
    edit: { args: ['-p', '--permission-mode', 'acceptEdits'], parse: 'text' },
    auth: { loginCommand: META.claude.loginCommand, docsUrl: META.claude.docsUrl },
    install: { hint: META.claude.installHint, docsUrl: META.claude.docsUrl },
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
    // headless 는 분석 전용(planner/reviewer/summarizer/probe) — codex config 기본값과 무관하게:
    //   --sandbox read-only: 워크스페이스 수정 불가(기본값이 workspace-write 여도). 편집은 아래 edit 가 분리.
    //   --config approval_policy="never": 승인 프롬프트 억제 — Fleet 엔 codex 승인 UI 가 없어,
    //     인터랙티브 승인 정책이면 멈춰 타임아웃날 수 있다(#165 codex review). exec 하위 플래그로 안전한
    //     형태는 공식 SDK(codex exec.ts)가 쓰는 `--config approval_policy="..."`(top-level `--ask-for-approval`
    //     를 exec 뒤에 두면 일부 버전서 거부됨 — openai/codex#26602). `--sandbox` 도 exec 뒤가 맞다(SDK 동일).
    headless: {
      args: ['exec', '--json', '--sandbox', 'read-only', '--config', 'approval_policy="never"'],
      parse: 'codex-jsonl',
    },
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
    edit: {
      args: ['exec', '--json', '-C', '{workspace}', '-s', 'workspace-write'],
      parse: 'codex-jsonl',
    },
    auth: { loginCommand: META.codex.loginCommand, docsUrl: META.codex.docsUrl },
    install: { hint: META.codex.installHint, docsUrl: META.codex.docsUrl },
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
    auth: { loginCommand: META.gemini.loginCommand, docsUrl: META.gemini.docsUrl },
    install: { hint: META.gemini.installHint, docsUrl: META.gemini.docsUrl },
  },
]

/**
 * 컨테이너 posture CLI 어댑터(#214 · ADR-0010) — "컨테이너 = 유일한 샌드박스 경계, CLI unsandboxed".
 * 비특권 컨테이너(uid 1000)는 중첩 user namespace 를 불허해 codex 의 bubblewrap FS 샌드박스
 * (`-s read-only`/`workspace-write`)가 `bwrap: No permissions to create a new namespace` 로 깨진다.
 * 컨테이너 모드에선 codex 를 `danger-full-access`(no-sandbox)로 돌리고, `codex exec` 전 경로 공통
 * 게이트인 신뢰-디렉터리 검사를 `--skip-git-repo-check` 로 통과시킨다(서버 프로세스 cwd = `/app` 비-git).
 *
 * args 는 학습 지식이 아니라 **핀 버전(CODEX_VERSION 0.142.5) 컨테이너 실측 verdict**(T0 · #214 코멘트
 * 4900663228)다:
 *   - `codex exec resume` 는 `--sandbox` 를 미수용(clap `unexpected argument`, exit 2) → `--config
 *     sandbox_mode="danger-full-access"` 라우트(openai/codex#26602 선례). `sandbox_mode` 키는
 *     `--strict-config` 에서도 인식.
 *   - trust-dir 검사는 headless·edit·session(start/resume) 전부 발화 → `--skip-git-repo-check` 를
 *     codex 4경로 전부에.
 *   - `{sessionId}`(positional) 뒤에 `extraArgs()`(`--model` 등)가 트레일해도 clap 수용(T0⑥) →
 *     `cli-session.ts` 무변경으로 유효.
 *
 * headless 의 read-only 상실은 보안 경계가 아니라 **역할 규율**(분석 역할의 파일 쓰기 차단) 상실이다 —
 * 컨테이너 안 잔여 리스크로 ADR-0010 에 기록(워크스페이스 무결성은 ignored-baseline 등 오케스트레이터
 * 층이 별도 방어). claude/gemini 는 내부 샌드박스가 opt-in 이고 Fleet 이 켜지 않으므로 **무조정**(차단
 * 실측 시에만 별도 조정 — #214 T8).
 *
 * codex 만 비파괴 diff-spread(args 배열을 통째로 선언 — 문자열 치환 금지, 기본 어댑터와 나란히 두어
 * 드리프트를 한 파일에서 보이게 한다). 명시 opt-in(`FLEET_SANDBOX_BOUNDARY=container`)일 때만 boot 이
 * 이 시드로 registry 를 만들어 엔진에 주입한다(boot.ts). 데스크톱·베어호스트는 기본 시드
 * (`DEFAULT_CLI_ADAPTERS`) 무변경. 런타임 `registry.register()` 확장분은 변환하지 않는다(주입 시점
 * 시드만 — seam 테스트가 핀).
 */
export function containerCliAdapters(
  base: readonly CliAdapter[] = DEFAULT_CLI_ADAPTERS,
): readonly CliAdapter[] {
  return base.map((adapter) => {
    if (adapter.id !== 'codex') return adapter // claude/gemini 무조정 — 내부 샌드박스 opt-in·Fleet 미사용
    return {
      ...adapter,
      headless: {
        ...adapter.headless!,
        args: [
          'exec',
          '--json',
          '--sandbox',
          'danger-full-access',
          '--config',
          'approval_policy="never"',
          '--skip-git-repo-check',
        ],
      },
      session: {
        ...adapter.session!,
        startArgs: [
          'exec',
          '--json',
          '--sandbox',
          'danger-full-access',
          '--config',
          'approval_policy="never"',
          '--skip-git-repo-check',
        ],
        // resume 은 `--sandbox` 미수용 → `--config sandbox_mode` 라우트. `{sessionId}` 마지막 positional 유지.
        resumeArgs: [
          'exec',
          'resume',
          '--json',
          '--config',
          'sandbox_mode="danger-full-access"',
          '--config',
          'approval_policy="never"',
          '--skip-git-repo-check',
          '{sessionId}',
        ],
      },
      edit: {
        ...adapter.edit!,
        args: [
          'exec',
          '--json',
          '-C',
          '{workspace}',
          '-s',
          'danger-full-access',
          '--skip-git-repo-check',
        ],
      },
    }
  })
}

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
