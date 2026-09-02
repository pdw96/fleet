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

/**
 * `<cwd>/package.json` 읽기 결과. **「없다」와 「있는데 깨졌다」를 반드시 구분한다**(Codex PR#313 4R P1).
 *
 * 둘을 `undefined` 하나로 접으면 치명적인 구멍이 생긴다 — 구현 에이전트가 **깨진 `package.json` 을
 * 만들어 놓으면** 「원래 npm 프로젝트가 아니었다」로 위장돼 검증이 통째로 건너뛰어지고 프로젝트가
 * `done` 으로 보고된다. 「사라진 검사」는 `sawCommands` 가 막지만, **애초에 명령을 낸 적이 없는**
 * 이 경로는 그 방어가 닿지 않는다. 그래서 여기서 상태를 갈라 **깨진 매니페스트는 실패로 접는다**
 * (fail closed).
 */
type ManifestRead =
  | { state: 'absent' } // package.json 이 없다 → 비-npm 워크스페이스(정당한 스킵)
  | { state: 'invalid'; reason: string } // 있는데 읽을 수 없다 → 검증 실패
  | { state: 'ok'; scripts: Record<string, string> | undefined }

function readPackageManifest(cwd: string): ManifestRead {
  const path = join(cwd, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // 부재만 정당한 스킵이다. 권한 오류 등 「있는데 못 읽는」 경우는 실패로 접는다(fail closed).
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { state: 'absent' }
    return {
      state: 'invalid',
      reason: `package.json 을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      state: 'invalid',
      reason: `package.json 을 파싱할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'package.json 의 최상위가 객체가 아닙니다.' }
  }
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (scripts === undefined) return { state: 'ok', scripts: undefined }
  // ⚠ 런타임 캐스트는 거짓일 수 있다 — `{"scripts": null}`·`{"scripts": []}` 는 유효한 JSON 이고
  // `typeof null === 'object'` 라 선언 타입만 믿으면 소비자가 null 을 인덱싱해 깨진다(1R P2).
  // 던지지 않게 막는 동시에 **조용히 스킵되지도 않게** invalid 로 올린다(4R P1).
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return { state: 'invalid', reason: 'package.json 의 scripts 가 객체가 아닙니다.' }
  }
  return { state: 'ok', scripts: scripts as Record<string, string> }
}

/**
 * `<cwd>/package.json` 의 scripts 맵 (없음·읽기 실패 → undefined = 알 수 없음).
 * `npmVerifyCommands` 전용의 **관대한** 읽기다 — 그 함수는 noop 태깅만 하므로 상태 구분이 불필요하고,
 * 기존 동작을 그대로 유지한다. 스킵/실패 판정이 필요한 쪽은 `readPackageManifest` 를 직접 쓴다.
 */
function readPackageScripts(cwd: string): Record<string, string> | undefined {
  const manifest = readPackageManifest(cwd)
  return manifest.state === 'ok' ? manifest.scripts : undefined
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

/** `npmVerifyCommands` 가 거는 스크립트 이름(= npm 프로젝트 판정의 근거 집합). */
const NPM_VERIFY_SCRIPTS = ['typecheck', 'lint', 'test'] as const

/**
 * `detectVerifyCommands` 의 판정. 세 갈래를 **반드시 구분**한다 — 두 개로 접으면 구멍이 생긴다.
 * - `commands`: 돌릴 검증이 있다.
 * - `none`: 돌릴 검증이 없다(비-npm 워크스페이스 등) → 정당한 스킵. 단 **조용하면 안 된다**(#166).
 * - `invalid`: `package.json` 이 있는데 읽을 수 없다 → **검증 실패**(fail closed · 4R P1).
 */
export type VerifyDetection =
  | { kind: 'commands'; commands: VerifyCommand[] }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }

/**
 * 워크스페이스를 보고 **실제로 돌릴 수 있는** 검증 명령을 정한다(#300).
 *
 * `npmVerifyCommands` 는 세 npm 스크립트를 무조건 반환하므로, 빈 폴더·Python·Go·Rust 워크스페이스
 * 에서는 모든 작업이 성공해도 `npm run typecheck` 가 없어 **항상** 「검증 실패」로 끝났다. 게다가
 * verify-fix 라운드가 implementer 를 재스폰해 *"npm run typecheck 실패를 고쳐라"* 를 시키는 탓에
 * **남의 레포에 `package.json` 이 심어졌다**(#300 · #299 와 결합).
 *
 * 판정: `package.json` 부재 → `none`. 있는데 읽기/파싱 실패거나 최상위·`scripts` 형태가 어긋나면
 * → `invalid`(호출자가 실패로 접는다). 정상이면 위 세 스크립트가 **하나도** 없을 때만 `none` 이고,
 * 하나라도 있으면 현행 세 명령 그대로다(무회귀).
 */
export function detectVerifyCommands(cwd: string): VerifyDetection {
  const manifest = readPackageManifest(cwd)
  if (manifest.state === 'absent') return { kind: 'none' }
  if (manifest.state === 'invalid') return { kind: 'invalid', reason: manifest.reason }
  const scripts = manifest.scripts
  if (scripts === undefined) return { kind: 'none' }
  // 「인식하는 이름이 아예 없다」와 「있는데 값이 깨졌다」를 가른다(Codex PR#313 5R P1).
  // 후자를 none 으로 접으면 `{"scripts":{"test":123}}` 같은 매니페스트가 조용히 스킵된다 —
  // 매니페스트 전체가 깨진 경우(4R P1)와 같은 위장이 **스크립트 값 단위**로 재현된다.
  // (npm 도 비-string 스크립트 값으로는 `npm run <name>` 을 돌리지 못하므로 실제로 깨진 상태다.)
  const present = NPM_VERIFY_SCRIPTS.filter((name) =>
    Object.prototype.hasOwnProperty.call(scripts, name),
  )
  if (present.length === 0) return { kind: 'none' }
  const malformed = present.filter((name) => typeof scripts[name] !== 'string')
  if (malformed.length > 0) {
    return {
      kind: 'invalid',
      reason: `package.json 의 검증 스크립트 값이 문자열이 아닙니다: ${malformed.join(', ')}`,
    }
  }
  return { kind: 'commands', commands: npmVerifyCommands(cwd) }
}
