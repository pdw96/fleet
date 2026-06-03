import { execFile } from 'node:child_process'
import type { CliAdapter, CliDetectionResult } from '../../../shared/types'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  /** spawn 자체 실패(예: 명령 없음) */
  spawnError?: 'ENOENT' | string
}

/** 명령 실행기 — 테스트에서 mock 주입 가능하도록 분리. */
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>

const MAX_BUFFER = 10 * 1024 * 1024

/** 기본 실행기: child_process.execFile 래핑. */
export const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise<CommandResult>((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        if (e && e.code === 'ENOENT') {
          resolve({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' })
          return
        }
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
      },
    )
    // 헤드리스 CLI(claude -p 등)가 stdin 입력을 기다리며 멈추지 않도록 즉시 EOF 를 보낸다.
    child.stdin?.end()
  })

const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/

/** --version 출력에서 semver 추출. */
export function parseVersion(output: string): string | undefined {
  const m = output.match(SEMVER)
  return m ? m[0] : undefined
}

/** 단일 CLI 감지. */
export async function detectCli(
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
  timeoutMs = 5000,
): Promise<CliDetectionResult> {
  const base = {
    id: adapter.id,
    displayName: adapter.displayName,
    command: adapter.command,
    kind: 'cli' as const,
  }
  const res = await runner(adapter.command, adapter.versionArgs, timeoutMs)

  if (res.spawnError) {
    return { ...base, installed: false, error: res.spawnError }
  }
  const raw = (res.stdout || res.stderr).trim()
  if (res.code === 0) {
    return { ...base, installed: true, version: parseVersion(raw), raw }
  }
  return { ...base, installed: false, raw, error: `exit ${res.code}` }
}

/** 모든 어댑터 병렬 감지. */
export async function detectAll(
  adapters: readonly CliAdapter[],
  runner: CommandRunner = defaultRunner,
  timeoutMs = 5000,
): Promise<CliDetectionResult[]> {
  return Promise.all(adapters.map((a) => detectCli(a, runner, timeoutMs)))
}
