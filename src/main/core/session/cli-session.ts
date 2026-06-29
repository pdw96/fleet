import { randomUUID } from 'node:crypto'
import type { CliAdapter, CliSessionSpec, LlmDescriptor } from '../../../shared/types'
import { classifyCliAuthHint } from '../cli/authHint'
import { defaultRunner, type CommandResult, type CommandRunner } from '../cli/detect'
import { cleanCliOutput, extractCodexThreadId, parseStreamLine } from '../cli/output'
import { settleOrAbort } from './abort'
import type { CreateCliSessionOptions, LlmSession, SendOptions } from './types'

const DEFAULT_TIMEOUT_MS = 120_000

/** 헤드리스 실행 인자 빌드: '{prompt}' 토큰을 실제 프롬프트로 치환. */
export function buildHeadlessArgs(adapter: CliAdapter, prompt: string): string[] {
  const template = adapter.headless?.args ?? ['{prompt}']
  return template.map((a) => a.replaceAll('{prompt}', prompt))
}

// 편집 에이전트 실행 인자 빌드: '{workspace}'·'{prompt}' 토큰을 치환. ({workspace} 먼저 → 프롬프트 내 리터럴 토큰 주입 방지)
const buildEditArgs = (edit: { args: string[] }, prompt: string, workspace: string): string[] =>
  edit.args.map((a) => a.replaceAll('{workspace}', workspace).replaceAll('{prompt}', prompt))

/**
 * spawn 실패/비정상 종료를 통일된 에러로 변환.
 * 비정상 종료가 인증 문제로 보이면 advisory recovery hint 를 base 뒤에 덧붙인다(#148, classifyCliAuthHint).
 * spawnError 분기는 hint 분류 전 즉시 throw(설치·실행·취소 실패는 auth 아님).
 */
function assertRunOk(adapter: CliAdapter, res: CommandResult): void {
  if (res.spawnError) throw new Error(`${adapter.command} 실행 실패: ${res.spawnError}`)
  if (res.code !== 0) {
    const base = `${adapter.command} 종료코드 ${res.code}: ${res.stderr.trim()}`
    const hint = classifyCliAuthHint(adapter, res)
    throw new Error(hint ? `${base}\n\n${hint}` : base)
  }
}

/**
 * CLI(구독제/TUI) 기반 LLM 세션 (요구사항 2A). 두 가지 모드:
 *
 *  - stateless (기본): 헤드리스 1회 실행. 매 send 가 독립 프로세스 → 호출자가 맥락을 매번 제공.
 *    오케스트레이터처럼 '깨끗한 독립 호출'이 필요한 경로에 적합(작업 간 맥락 오염 방지).
 *  - stateful (opts.stateful && adapter.session): CLI 자체 세션 재개로 맥락을 프로세스 간 유지.
 *    첫 호출은 startArgs, 이후는 resumeArgs. 세션 id 는 'preassigned'(우리가 UUID 생성) 또는
 *    'codex-thread'(첫 응답의 thread_id 추출)로 확보. 동일 세션 동시 send 는 직렬화된다.
 *  - edit (sendOpts.workspace 지정 시): 위 둘보다 최우선 경로. adapter.edit 인자를 cwd=workspace 에서
 *    1회 실행해 파일을 직접 편집한다. stateful 여부와 무관하게 항상 stateless(재개 상태 불변).
 *
 * adapter.streaming + sendOpts.onChunk 가 모두 있으면 토큰/이벤트 델타를 실시간으로 흘리고,
 * 아니면 버퍼링 후 최종 텍스트를 1회 전달한다.
 */
export function createCliSession(
  descriptor: LlmDescriptor,
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  opts: CreateCliSessionOptions = {},
): LlmSession {
  const spec = opts.stateful ? adapter.session : undefined
  let sessionId: string | null = null
  let started = false // start 성공 여부. resume 전환은 이 플래그로만 → 첫 실패가 세션을 오염시키지 않게.
  let chain: Promise<unknown> = Promise.resolve() // 동일 세션 직렬화 체인

  /**
   * 인자 배열을 실행한다. streaming 활성 시 stdout 을 라인 단위로 파싱해 델타를 onChunk 로 흘리고,
   * 아니면 버퍼링 후 최종 텍스트를 1회 onChunk 한다. 두 경우 모두 {res, text} 를 반환한다
   * (res.stdout 은 codex thread_id 추출 등에 쓰인다).
   */
  // promptVia==='stdin' 어댑터는 프롬프트를 argv 가 아닌 자식 stdin 으로 보낸다(명령줄 길이 한도 우회).
  const stdinFor = (prompt: string): string | undefined =>
    adapter.promptVia === 'stdin' ? prompt : undefined

  // 세션 모델이 지정돼 있고 어댑터가 모델 플래그를 노출하면 모든 실행에 `--model <model>` 을 덧붙인다.
  // 빈 값이면 생략 → CLI 기본 모델 사용(기존 동작 보존).
  const modelArgs = (): string[] => {
    const m = descriptor.model?.trim()
    return m && adapter.modelFlag ? [adapter.modelFlag, m] : []
  }

  // 세션에 MCP 설정(경로/인라인 JSON)이 있고 어댑터가 패스스루 플래그를 노출하면 모든 실행에 덧붙인다.
  // strict 플래그가 있으면 전달된 설정만 쓰게 격리한다. 플래그 없는 어댑터(codex/gemini)는 무시.
  const mcpArgs = (): string[] => {
    const c = descriptor.mcpConfig?.trim()
    if (!c || !adapter.mcpConfigFlag) return []
    return adapter.mcpStrictArg
      ? [adapter.mcpConfigFlag, c, adapter.mcpStrictArg]
      : [adapter.mcpConfigFlag, c]
  }

  /** 모든 실행 인자 끝에 공통으로 붙는 부가 인자(모델·MCP). */
  const extraArgs = (): string[] => [...modelArgs(), ...mcpArgs()]

  const execute = async (
    args: string[],
    sendOpts: SendOptions,
    // 버퍼 정제에 쓸 파싱 포맷. 기본은 헤드리스 포맷이며, 편집 모드는 adapter.edit.parse 를 넘긴다
    // (스트리밍 델타 파서는 별개로 adapter.streaming.parse 를 그대로 쓴다).
    parseFmt = adapter.headless?.parse,
    // promptVia==='stdin' 일 때 자식 stdin 으로 보낼 프롬프트(미지정이면 argv 전달 어댑터).
    stdinInput?: string,
  ): Promise<{ res: CommandResult; text: string }> => {
    const stream = adapter.streaming
    if (stream && sendOpts.onChunk) {
      const onChunk = sendOpts.onChunk
      let buf = ''
      let full = ''
      const emitLine = (line: string): void => {
        const delta = parseStreamLine(stream.parse, line)
        if (delta) {
          full += delta
          onChunk(delta)
        }
      }
      const onStdout = (chunk: string): void => {
        buf += chunk
        let nl = buf.indexOf('\n')
        while (nl !== -1) {
          emitLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
        }
      }
      const res = await runner(
        adapter.command,
        [...args, ...extraArgs(), ...stream.args],
        {
          timeoutMs: sendOpts.timeoutMs ?? timeoutMs,
          // 편집 모드(runEditing)는 cwd 를 직접 넘기므로 이 경로는 headless/stateful 전용.
          // cwd(read-only) 가 명시되면 그 경로를, 아니면 종전대로 workspace 를 cwd 로 쓴다.
          cwd: sendOpts.cwd ?? sendOpts.workspace,
          signal: sendOpts.signal,
          stdinInput,
        },
        onStdout,
      )
      emitLine(buf) // 마지막 개행 없는 잔여 라인
      assertRunOk(adapter, res)
      // 파서 드리프트 관측(#11): exit-0 인데 스트림 파서가 델타를 0개 뽑았고 원시 출력은 있으면
      // CLI 출력 이벤트 스키마가 바뀌었을 가능성이 높다 — 버퍼 정제 폴백 전에 경고를 남긴다.
      if (full === '' && res.stdout.trim() !== '') {
        console.warn(
          `[fleet] ${adapter.command}: 스트림 파서(${stream.parse})가 델타를 0개 추출했습니다 ` +
            `(exit 0, 원시 ${res.stdout.length}바이트). CLI 출력 형식 변경 의심(파서 드리프트) — 버퍼 정제로 폴백합니다.`,
        )
      }
      // 델타가 비어 있으면(이벤트 단위 CLI 등) 버퍼 정제로 폴백해 응답을 잃지 않는다.
      return { res, text: full || cleanCliOutput(parseFmt, res.stdout) }
    }
    const res = await runner(adapter.command, [...args, ...extraArgs()], {
      timeoutMs: sendOpts.timeoutMs ?? timeoutMs,
      // cwd(read-only) 우선, 없으면 workspace(headless/stateful 경로). 편집은 runEditing 이 별도 처리.
      cwd: sendOpts.cwd ?? sendOpts.workspace,
      signal: sendOpts.signal,
      stdinInput,
    })
    assertRunOk(adapter, res)
    const text = cleanCliOutput(parseFmt, res.stdout)
    sendOpts.onChunk?.(text)
    return { res, text }
  }

  const runStateless = async (prompt: string, sendOpts: SendOptions): Promise<string> => {
    if (!adapter.headless) {
      throw new Error(`${adapter.displayName}는 헤드리스 1회 실행을 지원하지 않습니다.`)
    }
    const { text } = await execute(
      buildHeadlessArgs(adapter, prompt),
      sendOpts,
      adapter.headless?.parse,
      stdinFor(prompt),
    )
    return text
  }

  // 편집 모드는 항상 stateless/fresh: cwd=workspace 에서 1회 실행해 파일을 직접 편집한다.
  const runEditing = async (
    prompt: string,
    workspace: string,
    sendOpts: SendOptions,
  ): Promise<string> => {
    if (!adapter.edit) throw new Error(`${adapter.displayName}는 편집 모드를 지원하지 않습니다.`)
    // 편집 모드 stdout 정제는 edit.parse 를 우선한다(편집 CLI 의 출력 포맷이 헤드리스와 다를 수 있다).
    // cwd 는 항상 workspace 로 고정한다 — read-only cwd 가 함께 와도 편집은 호출자가 체크포인트/승인한
    // workspace 트리에서 일어나야 한다(claude/gemini edit args 는 {workspace} 없이 spawn cwd 에 의존). #165 P2.
    const { text } = await execute(
      buildEditArgs(adapter.edit, prompt, workspace),
      { ...sendOpts, cwd: workspace },
      adapter.edit.parse ?? adapter.headless?.parse,
      stdinFor(prompt),
    )
    return text
  }

  const runStateful = async (
    s: CliSessionSpec,
    prompt: string,
    sendOpts: SendOptions,
  ): Promise<string> => {
    const resuming = started // 성공적으로 시작된 세션만 재개한다(첫 실패 후엔 start 로 재시도).
    // start 시도마다 새 id 를 생성한다(직전 실패 id 는 미사용 상태이므로 재사용하지 않는다).
    if (!resuming && s.idSource === 'preassigned') sessionId = randomUUID()
    const template = resuming ? s.resumeArgs : s.startArgs
    // {sessionId} 를 먼저 치환하고 사용자 프롬프트를 마지막에 주입 → 프롬프트 내 리터럴 토큰 충돌 방지.
    const args = template.map((a) =>
      a.replaceAll('{sessionId}', sessionId ?? '').replaceAll('{prompt}', prompt),
    )
    // execute 내 assertRunOk → 실패 시 started 미전환. stdin 어댑터는 프롬프트를 stdin 으로 보낸다.
    const { res, text } = await execute(args, sendOpts, adapter.headless?.parse, stdinFor(prompt))
    if (!resuming && s.idSource === 'codex-thread') {
      const tid = extractCodexThreadId(res.stdout)
      if (!tid)
        throw new Error(
          `${adapter.command}: 응답에서 thread_id 를 찾지 못해 세션을 시작할 수 없습니다.`,
        )
      sessionId = tid
    }
    started = true // 모든 throw 를 통과한 뒤에만 resume 모드로 전환
    return text
  }

  return {
    id: descriptor.id,
    descriptor,
    stateful: !!spec,
    async send(prompt: string, sendOpts: SendOptions = {}): Promise<string> {
      const prior = chain
      let started = false // 실제 자식 spawn 진입 여부 — 이후의 abort 는 조기 거부하지 않고 runner 정착(killTree/close)을 따른다.
      const link = (async () => {
        await prior.catch(() => {}) // 앞 호출의 성공/실패와 무관하게 순서만 보장
        // 큐 대기 중 취소됐으면 자식 spawn 없이 중단한다(낭비 방지). 체인 순서는 보존되므로 다음 send 는
        // 여전히 이 링크의 정착을 기다린다(직렬화 유지). 취소 즉시성은 아래 settleOrAbort 가 담당.
        sendOpts.signal?.throwIfAborted()
        started = true
        // workspace 가 있으면 편집 모드가 최우선(항상 fresh/stateless): cwd=workspace 에서 파일 직접 편집.
        if (sendOpts.workspace) return runEditing(prompt, sendOpts.workspace, sendOpts)
        // fresh 면 stateful 세션이라도 헤드리스 1회(재개 상태 불변) → 오케스트레이터 독립 호출.
        return spec && !sendOpts.fresh
          ? runStateful(spec, prompt, sendOpts)
          : runStateless(prompt, sendOpts)
      })()
      chain = link.catch(() => {}) // 직렬화 체인은 에러로 끊기지 않게(순서만 보존)
      // 큐 대기 중에만 취소를 즉시 반영한다. 실행 시작(자식 spawn) 후의 취소는 runner 의 killTree/close-후-정착을
      // 따른다 — 오케스트레이터 revert 가 살아있는 자식과 경합하지 않게 보장(직렬화 링크는 위 chain 이 보존).
      return settleOrAbort(link, sendOpts.signal, () => started)
    },
    async dispose(): Promise<void> {
      // stateless 1회 실행은 유지 리소스 없음. stateful 세션 파일의 '사후 정리'는 CLI 별로
      // 불균일/불가하여 자동화하지 않는다(의도적 미구현):
      //  - claude: 세션 삭제 CLI 명령 없음(--no-session-persistence 는 start 플래그라 resume 자체를 깸).
      //  - codex : `codex archive <id>`(하드삭제 아닌 보관)만 존재.
      //  - gemini: `--delete-session <index>`(uuid 아닌 index → --list-sessions 조회 필요).
      // 세션 파일은 소형 텍스트라 누적이 느리다. 필요 시 사용자가 ~/.claude·~/.codex 등을 정리.
    },
  }
}
