import type { VerificationResult, VerifyKind } from '../../../shared/types'
import { defaultRunner } from '../cli/detect'

export interface VerifyCommand {
  kind: VerifyKind
  command: string
  args: string[]
  cwd?: string
}

export interface VerifyExecResult {
  code: number | null
  stdout: string
  stderr: string
  spawnError?: string
}

export type VerifyRunner = (
  cmd: VerifyCommand,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<VerifyExecResult>

/**
 * 기본 실행기: CLI 탐지·편집과 동일한 cross-spawn 기반 `defaultRunner`(`cli/detect`)에 위임한다.
 * raw `child_process.execFile('npm', …)` 은 Windows 에서 npm/eslint 가 `.cmd` 배치 셰임이라
 * ENOENT(셰임 미해석)·Node 20+ 의 `.cmd` 직접 spawn 차단(EINVAL)으로 깨졌다(win32 에서 verify
 * 가 항상 실패). `defaultRunner` 는 (a) PATHEXT 로 셰임을 해석하고 cmd.exe 경유 시 인자를 안전
 * 이스케이프하며, (b) 워크스페이스(custom cwd)에서 PATH-only 절대경로로 실행해 cwd-셰도(악성
 * `npm.cmd`)를 차단하고(#158), (c) timeout/abort/overflow 종료(트리 킬)를 단일 구현으로 공유한다.
 * `CommandResult` 는 `VerifyExecResult` 와 구조가 동일하다(code·stdout·stderr·spawnError).
 */
export const defaultVerifyRunner: VerifyRunner = (cmd, timeoutMs, signal) => {
  // 이미 abort 된 신호면 위임 전에 단락한다 — defaultRunner 의 pre-abort 가드는 win32+cwd 경로
  // 에만 있어 POSIX 에선 자식이 먼저 spawn 된다(이전 execFile 은 전 플랫폼에서 pre-aborted 면
  // 자식 미시작). cancelRun 으로 한 단계가 abort 되면 runAllVerifications 가 같은 신호로 호출하는
  // 나머지 lint/test 가 잠깐 npm 을 띄우지 않게 한다(전 플랫폼 일관; Codex P2).
  if (signal?.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', spawnError: 'ABORTED' })
  }
  return defaultRunner(cmd.command, cmd.args, { timeoutMs, cwd: cmd.cwd, signal })
}

/** 실패 출력에서 대표 에러 라인 추출 (간단 분석, 요구사항 5). */
export function summarizeFailure(stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const errLine = lines.find((l) => /error|fail|✗|✘|exception|assert/i.test(l))
  return errLine ?? lines.at(-1) ?? '알 수 없는 실패'
}

export interface RunVerifyOptions {
  runner?: VerifyRunner
  now?: () => number
  timeoutMs?: number
  /** 실행 취소 신호. abort 시 검증 자식 프로세스를 종료하고 ABORTED 로 보고한다. */
  signal?: AbortSignal
}

/** 단일 검증 명령 실행 → VerificationResult. */
export async function runVerification(
  cmd: VerifyCommand,
  opts: RunVerifyOptions = {},
): Promise<VerificationResult> {
  const runner = opts.runner ?? defaultVerifyRunner
  const now = opts.now ?? (() => Date.now())
  const timeoutMs = opts.timeoutMs ?? 120_000
  const fullCommand = `${cmd.command} ${cmd.args.join(' ')}`.trim()

  const started = now()
  const res = await runner(cmd, timeoutMs, opts.signal)
  const durationMs = now() - started

  if (res.spawnError) {
    return {
      kind: cmd.kind,
      command: fullCommand,
      passed: false,
      exitCode: null,
      stdout: res.stdout,
      stderr: res.stderr,
      analysis: `명령 실행 실패: ${res.spawnError}`,
      durationMs,
    }
  }

  const passed = res.code === 0
  return {
    kind: cmd.kind,
    command: fullCommand,
    passed,
    exitCode: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    analysis: passed ? undefined : summarizeFailure(res.stdout, res.stderr),
    durationMs,
  }
}

/** 여러 검증을 순차 실행. */
export async function runAllVerifications(
  cmds: readonly VerifyCommand[],
  opts: RunVerifyOptions = {},
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  for (const cmd of cmds) {
    results.push(await runVerification(cmd, opts))
  }
  return results
}

export function allPassed(results: readonly VerificationResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed)
}

/** JS/TS 프로젝트 표준 검증 명령 세트 (npm 스크립트 기반). */
export function npmVerifyCommands(cwd: string): VerifyCommand[] {
  return [
    { kind: 'typecheck', command: 'npm', args: ['run', 'typecheck'], cwd },
    { kind: 'lint', command: 'npm', args: ['run', 'lint'], cwd },
    { kind: 'test', command: 'npm', args: ['test'], cwd },
  ]
}
