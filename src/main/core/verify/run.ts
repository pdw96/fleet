import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VerificationResult, VerifyKind } from '../../../shared/types'
import { defaultRunner } from '../cli/detect'

export interface VerifyCommand {
  kind: VerifyKind
  command: string
  args: string[]
  cwd?: string
  /** package.json 스크립트가 자명한 no-op 인지(npmVerifyCommands 가 태깅). */
  noop?: boolean
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
 * verify 러너 팩토리(#197-B6 T3). CLI 탐지·편집과 동일한 cross-spawn 기반 `defaultRunner`(`cli/detect`)에
 * 위임한다 — raw `child_process.execFile('npm', …)` 은 Windows 에서 npm/eslint 가 `.cmd` 배치 셰임이라
 * ENOENT/EINVAL 로 깨지므로(win32 verify 상시 실패), `defaultRunner` 가 (a) PATHEXT 셰임 해석 + cmd.exe
 * 인자 이스케이프, (b) PATH-only 절대경로 실행으로 cwd-셰도 차단(#158), (c) timeout/abort/overflow 트리
 * 킬을 단일 구현으로 공유한다(`CommandResult` 구조는 `VerifyExecResult` 와 동일).
 *
 * `baseEnv` 를 주면 검증 자식(워크스페이스 npm 스크립트)에 그 env 를 적용해 서버 시크릿(FLEET_*)이
 * 상속되지 않게 한다. **미주입이면 현행처럼 부모 env 를 상속**(무회귀). 서버 모드에서 boot/engine 이
 * childEnv.base 를 주입한다. verify 는 provider 키가 불필요하므로 base 만.
 */
export function createVerifyRunner(baseEnv?: () => NodeJS.ProcessEnv): VerifyRunner {
  return (cmd, timeoutMs, signal) => {
    // 이미 abort 된 신호면 위임 전에 단락한다 — defaultRunner 의 pre-abort 가드는 win32+cwd 경로
    // 에만 있어 POSIX 에선 자식이 먼저 spawn 된다(이전 execFile 은 전 플랫폼에서 pre-aborted 면
    // 자식 미시작). cancelRun 으로 한 단계가 abort 되면 runAllVerifications 가 같은 신호로 호출하는
    // 나머지 lint/test 가 잠깐 npm 을 띄우지 않게 한다(전 플랫폼 일관; Codex P2).
    if (signal?.aborted) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', spawnError: 'ABORTED' })
    }
    return defaultRunner(cmd.command, cmd.args, {
      timeoutMs,
      cwd: cmd.cwd,
      signal,
      env: baseEnv?.(),
    })
  }
}

/** 기본 verify 러너 — env 미지정(현행 상속). 서버 격리는 createVerifyRunner(baseEnv) 로 주입. */
export const defaultVerifyRunner: VerifyRunner = createVerifyRunner()

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
      noop: cmd.noop,
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
    noop: cmd.noop,
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

/**
 * package.json 스크립트 본문이 "아무 검사도 안 하는" 자명한 no-op 인지.
 * 보수적 — false negative(놓침)는 감수하고 false positive(실제 검사 오판) 0 을 우선한다.
 * 끝 세미콜론은 1개만 허용(`exit 0;;` 는 비-noop). `echo`·`|| true`·wrapper 는 제외.
 * `typeof` 가드 — 비정상 package.json(스크립트 값이 비-string: null·숫자·배열·객체)에서도
 * `.trim()` TypeError 로 verify 를 깨뜨리지 않는다(런타임 캐스트가 거짓일 수 있음).
 */
export function isNoOpScript(body?: string): boolean {
  if (typeof body !== 'string') return false
  const n = body.trim().replace(/;$/, '').trim()
  return n === '' || n === 'exit 0' || n === 'true' || n === ':'
}

/** <cwd>/package.json 의 scripts 맵 (읽기/파싱 실패·없음 → undefined = 알 수 없음). */
function readPackageScripts(cwd: string): Record<string, string> | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return pkg.scripts
  } catch {
    return undefined
  }
}

/** JS/TS 프로젝트 표준 검증 명령 세트 (npm 스크립트 기반). package.json 을 읽어 no-op 을 태깅한다. */
export function npmVerifyCommands(cwd: string): VerifyCommand[] {
  const scripts = readPackageScripts(cwd)
  // 훅이 없으면(undefined) "실제 검사 아님" 으로 본다. 있으면 그 본문이 no-op 일 때만 무해.
  const hookNoOp = (name: string): boolean => {
    const b = scripts?.[name]
    return b === undefined || isNoOpScript(b)
  }
  const mk = (kind: VerifyKind, name: string, args: string[]): VerifyCommand => {
    const cmd: VerifyCommand = { kind, command: 'npm', args, cwd }
    const body = scripts?.[name]
    // main 스크립트가 있을 때만 noop 판정(없으면 npm run 실패=검증 실패, 별개).
    // npm 은 `npm run <name>` 시 pre<name>/post<name> 훅도 실행하므로, 훅에 실검사가 있으면
    // main 이 exit 0 라도 실제 검증이 돈다 → no-op 아님(#168 Codex: false-positive 방지).
    if (body !== undefined) {
      cmd.noop = isNoOpScript(body) && hookNoOp(`pre${name}`) && hookNoOp(`post${name}`)
    }
    return cmd
  }
  return [
    mk('typecheck', 'typecheck', ['run', 'typecheck']),
    mk('lint', 'lint', ['run', 'lint']),
    mk('test', 'test', ['test']),
  ]
}
