import { execFile } from 'node:child_process'
import type { VerificationResult, VerifyKind } from '../../../shared/types'

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

const MAX_BUFFER = 10 * 1024 * 1024

/** 기본 실행기: child_process.execFile. signal abort 시 자식 프로세스를 종료한다(취소 전파). */
export const defaultVerifyRunner: VerifyRunner = (cmd, timeoutMs, signal) =>
  new Promise<VerifyExecResult>((resolve) => {
    execFile(
      cmd.command,
      cmd.args,
      { cwd: cmd.cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER, signal },
      (err, stdout, stderr) => {
        const e = err as
          | (NodeJS.ErrnoException & {
              code?: number | string
              killed?: boolean
              signal?: NodeJS.Signals | null
            })
          | null
        // 취소(AbortSignal) 로 죽은 자식은 정상 실패가 아니라 ABORTED 로 보고한다(timeout 검사보다 먼저).
        if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
          resolve({ code: null, stdout: '', stderr: '', spawnError: 'ABORTED' })
          return
        }
        if (e && e.code === 'ENOENT') {
          resolve({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' })
          return
        }
        if (e && (e.killed || e.signal === 'SIGTERM')) {
          resolve({
            code: null,
            stdout: stdout?.toString() ?? '',
            stderr: stderr?.toString() ?? '',
            spawnError: 'ETIMEDOUT',
          })
          return
        }
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
      },
    )
  })

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
