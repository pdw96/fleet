import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import spawn from 'cross-spawn'
import which from 'which'
import type { CliAdapter, CliDetectionResult } from '../../../shared/types'
import { killTree } from '../process/kill-tree'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  /** spawn 자체 실패(예: 명령 없음 ENOENT, 타임아웃 ETIMEDOUT, 출력 초과 ENOBUFS, 중단 ABORTED) */
  spawnError?: 'ENOENT' | 'ETIMEDOUT' | 'ENOBUFS' | 'ABORTED' | string
}

/** 명령 실행 옵션. */
export interface RunOpts {
  timeoutMs: number
  /** 자식 프로세스 작업 디렉터리(편집 모드 등에서 워크스페이스 지정). */
  cwd?: string
  /** 외부 취소 신호 — abort 시 자식을 죽이고 ABORTED 로 종료한다. */
  signal?: AbortSignal
  /**
   * 자식 stdin 으로 보낼 입력(없으면 즉시 EOF). 긴 프롬프트를 argv 대신 stdin 으로 넘겨
   * Windows 명령줄 길이 한도(.cmd 셰임 cmd.exe ~8191자 / 네이티브 exe ~32767자)를 우회한다.
   * UTF-8 로 인코딩되어 한 번에 write 후 stdin 을 닫는다.
   */
  stdinInput?: string
  /**
   * 자식 프로세스 환경변수. **미지정이면 현행처럼 `process.env` 를 전량 상속**한다(데스크톱·기존
   * 호출 무회귀 특성화 핀). 지정하면 자식 env 는 이 값으로 **완전 대체**된다(부분 병합 아님 — Node
   * spawn 시맨틱). 서버 모드(#197-B6)에서 childEnv 가 allowlist 로 필터한 env 를 주입해 `FLEET_*`
   * 서버 시크릿이 자식(CLI 세션·detect/probe·verify·git)에 새지 않게 한다.
   */
  env?: NodeJS.ProcessEnv
}

/**
 * 명령 실행기 — 테스트에서 mock 주입 가능하도록 분리.
 * `onStdout` 가 주어지면 stdout 디코드 청크를 도착 즉시 전달한다(스트리밍). 미지정 시 버퍼링만.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  opts: RunOpts,
  onStdout?: (chunk: string) => void,
) => Promise<CommandResult>

const MAX_BUFFER = 10 * 1024 * 1024

// killTree(특히 win32 taskkill)는 비동기다. 취소/타임아웃/overflow 시 자식 'close'(트리 실제 종료)를
// 기다려 종결하되, close 가 끝내 안 오면(고집 센 자식) 이 유예 후 SIGKILL escalation + 강제 종결한다.
const KILL_GRACE_MS = 2000

/**
 * 기본 실행기: cross-spawn 기반.
 *
 * Windows 에서 npm 으로 설치된 CLI 는 `gemini.cmd` 같은 배치 셰임이라
 * Node 의 execFile/spawn 으로는 직접 실행되지 않는다:
 *  - 확장자 없이 `gemini` → PATHEXT 미해석으로 ENOENT
 *  - `gemini.cmd` 명시 → Node 20+ 의 .cmd/.bat 차단(CVE-2024-27980)으로 EINVAL
 * cross-spawn 은 PATHEXT 로 셰임을 찾고, cmd.exe 경유 시 인자를 안전하게
 * 이스케이프(주입 방지)해 실행한다. POSIX 에서는 일반 spawn 과 동일하게 동작.
 */
export const defaultRunner: CommandRunner = async (command, args, opts, onStdout) => {
  // 워크스페이스(custom cwd) Windows spawn 은 cross-spawn 이 bare 를 cmd.exe 로 넘기고 cmd.exe 가 cwd 를
  // PATH 보다 먼저 검색하므로, bare command 를 PATH-only 절대경로로 미리 해석해 cwd-셰도(워크스페이스 내
  // 악성 claude.cmd) 실행을 차단한다(#158). PATH 미발견이면 cwd 를 고의로 미조회한 보안 거부(ENOENT).
  // 가드 미적용 경로(POSIX·cwd 없음·이미 절대경로)는 await 없이 즉시 Promise 진입 → 기존 동기 spawn 타이밍 보존.
  let resolved = command
  if (isWindowsLike && opts.cwd != null && !path.isAbsolute(command)) {
    // 해석은 abort/timeout 핸들러 설치 전에 일어나므로 여기서 직접 취소를 본다(Codex P2 — started=true 인
    // send 는 settleOrAbort 가 가로채지 않아, 해석 중 취소 시 edit CLI 가 잠깐 실행되는 걸 막는다).
    if (opts.signal?.aborted) return { code: null, stdout: '', stderr: '', spawnError: 'ABORTED' }
    // 해석 상한을 호출자 timeoutMs 로 캡(병든 PATH 가 호출자 예산을 초과하지 않게). 워크스페이스 서브트리 제외.
    const abs = await resolvePathOnly(
      command,
      undefined,
      Math.min(opts.timeoutMs, RESOLVE_TIMEOUT_MS),
      opts.cwd,
    )
    if (opts.signal?.aborted) return { code: null, stdout: '', stderr: '', spawnError: 'ABORTED' }
    if (abs == null) return { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }
    resolved = abs
  }
  return new Promise<CommandResult>((resolve) => {
    const { timeoutMs, cwd, signal, stdinInput } = opts
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let settled = false
    // 종료가 트리거되면(취소/타임아웃/overflow) 그 사유를 담는다. set 되면 killTree 는 1회만,
    // 실제 finish 는 트리 킬 확인(killTree resolve)과 자식 'close'(출력 드레인)를 둘 다 본 뒤 한다.
    let terminating: string | undefined
    let killConfirmed = false // killTree 가 resolve 됨(win32 taskkill 종료 = 트리 force-kill 완료)
    let streamClosed = false // 자식 'close'(stdout 파이프 EOF)
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    // 스트리밍 시 멀티바이트 경계 안전 디코드(청크가 UTF-8 글자 중간에서 끊겨도 OK).
    const decoder = onStdout ? new StringDecoder('utf8') : null

    // 멀티바이트(UTF-8) 경계 깨짐 방지를 위해 Buffer 로 모았다가 마지막에 디코드한다.
    const decode = () => ({
      stdout: Buffer.concat(outChunks).toString(),
      stderr: Buffer.concat(errChunks).toString(),
    })

    const finish = (extra: { code: number | null; spawnError?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      const { stdout, stderr } = decode()
      resolve({ ...extra, stdout, stderr })
    }

    // env 미지정 시 옵션 객체에 `env` 키 자체를 넣지 않는다(조건부 스프레드) — `env: undefined` 를
    // 직접 넘기면 cross-spawn 이 상속 처리를 미묘하게 바꿀 수 있어, 미지정 경로 spawn 을 이전과 정확히 동일하게 보존.
    const child = spawn(resolved, args, {
      windowsHide: true,
      cwd,
      ...(opts.env ? { env: opts.env } : {}),
    })

    // 종료가 트리거됐을 때(취소/타임아웃/overflow) 트리 킬 확인과 stdout close 를 둘 다 본 뒤 종결한다.
    const finishWhenTerminated = () => {
      if (terminating && killConfirmed && streamClosed)
        finish({ code: null, spawnError: terminating })
    }

    // 종료를 한 번만 트리거한다. killTree 는 비동기(특히 win32 taskkill 프로세스 스폰)이므로:
    //  - 트리 킬은 1회만 한다(반복 overflow chunk 가 taskkill 을 폭주 스폰하지 않게 가드).
    //  - 즉시 finish 하지 않고 트리 킬 확인(killTree resolve = win32 taskkill 종료)과 자식 'close'를
    //    둘 다 기다린 뒤 finish → 취소 반환이 "프로세스 트리 종료 완료"를 보장해, 호출자(engine)의
    //    후속 revert 가 살아있는 손자(또는 분리된 자손)와 경합하지 않는다.
    //  - 둘 다 끝내 안 오면 유예(KILL_GRACE_MS) 후 SIGKILL escalation + 강제 종결(무한 대기 방지).
    const terminate = (spawnError: string) => {
      if (settled || terminating) return
      terminating = spawnError
      void killTree(child).then(() => {
        killConfirmed = true
        finishWhenTerminated()
      })
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 이미 종료 */
        }
        finish({ code: null, spawnError })
      }, KILL_GRACE_MS)
      graceTimer.unref?.()
    }

    const timer = setTimeout(() => terminate('ETIMEDOUT'), timeoutMs)

    // 외부 취소 신호 처리: abort 시 자식 트리를 죽이고(트리 종료 확인 후) ABORTED 로 종료한다.
    const onAbort = () => terminate('ABORTED')
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }

    // 출력이 한도를 넘으면 child 트리를 죽이고 명시적 에러로 종료한다(과거 execFile maxBuffer 계약 유지).
    // 그대로 두면 조용한 truncation 또는 무한 출력 CLI 의 timeout 까지 매달림이 발생한다.
    const onOverflow = () => terminate('ENOBUFS')
    child.stdout?.on('data', (c: Buffer) => {
      outChunks.push(c)
      outLen += c.length
      if (onStdout && decoder) onStdout(decoder.write(c))
      if (outLen > MAX_BUFFER) onOverflow()
    })
    child.stderr?.on('data', (c: Buffer) => {
      errChunks.push(c)
      errLen += c.length
      if (errLen > MAX_BUFFER) onOverflow()
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, spawnError: err.code ?? err.message })
    })
    child.on('close', (code) => {
      if (onStdout && decoder) {
        const rest = decoder.end()
        if (rest) onStdout(rest)
      }
      streamClosed = true
      // 종료가 트리거됐으면(취소/타임아웃/overflow) 트리 킬 확인까지 본 뒤, 아니면 정상 종료 코드로 종결한다.
      if (terminating) finishWhenTerminated()
      else finish({ code })
    })

    // 자식이 stdin 을 읽기 전에 죽으면 write 가 EPIPE 를 낼 수 있다 — 실제 결과는
    // error/close 핸들러가 처리하므로 여기서는 미처리 예외만 막는다.
    child.stdin?.on('error', () => {})
    // 프롬프트가 있으면 stdin 으로 보낸 뒤 EOF, 없으면 헤드리스 CLI(claude -p 등)가
    // stdin 입력을 기다리며 멈추지 않도록 즉시 EOF 를 보낸다.
    if (stdinInput != null) child.stdin?.end(stdinInput)
    else child.stdin?.end()
  })
}

const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/

/** --version 출력에서 semver 추출. */
export function parseVersion(output: string): string | undefined {
  const m = output.match(SEMVER)
  return m ? m[0] : undefined
}

/** PATH 에서 명령 → 실행 경로 해석기(테스트 주입 가능). null = not-found(예외 비전파). */
export type PathResolver = (command: string) => Promise<string | null>

/**
 * 기본 경로 해석기: which 로 표시용 실행 경로를 해석한다. 실행 자체는 cross-spawn(중첩 which@2)이
 * 하지만 둘 다 동일한 node-which PATH+PATHEXT 규칙이고, cwd-셰도 가드(#158)가 spawn 에 절대경로를
 * 넘겨 cross-spawn 이 재해석하지 않으므로 표시 경로 = 실제 실행 경로가 유지된다.
 * ⚠ which 의 *비동기* API 는 not-found 시 ENOENT 로 reject 한다 — 여기서는 `{nothrow}` 를 넘기지
 * 않는다(which@7 의 async 는 nothrow 를 주면 null 을 반환하지만, 미지정 시 기존대로 reject). 따라서
 * 명시적으로 catch→null 정규화해 PathResolver 계약(null = not-found)을 지킨다.
 * resolveCommandPath 의 try/catch 는 커스텀 resolver 용 심층방어.
 */
export const defaultResolver: PathResolver = async (command) => {
  try {
    return await which(command)
  } catch {
    return null
  }
}

// 경로 해석 상한. which 의 PATH 순회(파일 stat)는 보통 즉시지만, 병든 PATH(스테일 네트워크 마운트 등)
// 에서 멈출 수 있어 race 로 상한을 건다. 상한의 목적은 **호출자 예산을 병든 PATH 가 삼키지 않게** 하는
// 것이지 「빨라야 한다」가 아니다.
//
// 값 근거(#251 PR1a 실측): 이 상한은 `defaultRunner` 의 win32 cwd-셰도 가드(#158)에도 쓰이고, 거기서
// 초과하면 **실행 거부(ENOENT)** 가 된다 — 즉 표시용이 아니라 실행 성패를 가른다. 같은 머신에서
// `resolvePathOnly('git')` 소요를 측정하니 **유휴 72~87ms** vs **CPU 부하 중 최대 7,592ms**(87배)였다.
// 2,000ms 는 부하 상황에서 상시 초과돼 **멀쩡한 git/CLI 를 「없음」으로 오판**한다(테스트에서 산발 RED 로
// 먼저 드러났고, 프로덕션에서는 바쁜 데스크톱의 간헐적 실행 실패로 나타난다).
// 10s 로 올려도 원래 의도는 유지된다 — git 호출 예산 120s 의 8%이고, `Math.min(opts.timeoutMs, …)` 때문에
// 예산이 더 작은 호출자(CLI probe 5s)는 자기 예산에 그대로 묶인다.
const RESOLVE_TIMEOUT_MS = 10_000

/**
 * 해석된 경로가 PATH shadow 위험인지 판정.
 * - 비절대(상대/CWD PATH 엔트리)면 위험.
 * - 절대라도 **cwd 내부**면 위험: which 는 Windows(및 cygwin/msys)에서 PATH 보다 cwd 를 먼저
 *   검색해 cwd shadow 를 절대경로로 반환하므로(which@7 도 isWindows 시 후보 앞에 cwd 를 prepend),
 *   path.isAbsolute 만으로는 cwd shadow 를 놓친다. dirname 이 cwd 면 위험으로 본다(전 플랫폼).
 */
function isShadowRisk(resolved: string): boolean {
  if (!path.isAbsolute(resolved)) return true
  const dir = path.resolve(path.dirname(resolved))
  const cwd = path.resolve(process.cwd())
  return process.platform === 'win32' ? dir.toLowerCase() === cwd.toLowerCase() : dir === cwd
}

/** which 의 isWindows 정의와 일치 — cmd.exe 가 cwd 를 PATH 보다 먼저 검색하는(= cwd-셰도 벡터가 성립하는) 플랫폼. */
export const isWindowsLike =
  process.platform === 'win32' || process.env.OSTYPE === 'cygwin' || process.env.OSTYPE === 'msys'

/** PATH 전체 매치 해석기(테스트 주입 가능). 기본은 which({all}) — cross-spawn 과 동일 계열.
 *  which@7({all}) 은 `readonly string[]` 를 반환하므로(@types/which@3) 결과는 읽기 전용으로 소비한다. */
export type AllResolver = (command: string) => Promise<readonly string[]>
const defaultAllResolver: AllResolver = (command) => which(command, { all: true })

/** childDir 이 baseDir(자신 포함)의 서브트리 안인지. win32 는 대소문자 무시. */
function isWithinDir(childDir: string, baseDir: string): boolean {
  const norm = (p: string): string =>
    isWindowsLike ? path.resolve(p).toLowerCase() : path.resolve(p)
  const rel = path.relative(norm(baseDir), norm(childDir))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * 명령을 **PATH-only 절대경로**로 해석한다(#158, 워크스페이스 cwd-셰도 차단용).
 * which 는 win32 에서 cwd 를 무조건 prepend 하므로 {all} 로 [cwd?, …PATH] 전체 매치를 받아
 * **현재 process cwd 내부 매치를 제외**한 첫 PATH 매치를 고른다(앱 컨텍스트 호출 → 워크스페이스는 후보에 없음).
 * 그 절대경로를 spawn 에 넘기면 cross-spawn 이 cmd.exe 에 절대경로를 줘 cwd 검색을 우회한다.
 * - 이미 절대경로면 그대로(호출자 해석 완료).
 * - 비절대 매치(상대 PATH 엔트리)는 spawn 시 cwd 재해석 여지가 있어 거부(절대경로만 cwd-독립 보장).
 * - `excludeDir`(워크스페이스)가 PATH 에 있어 그 서브트리로 해석된 매치도 거부(CodeRabbit — 워크스페이스 셰도 전면 차단).
 * - not-found(전부 제외됐거나 0매치)·예외·타임아웃 → null(호출자가 보안 거부).
 */
export async function resolvePathOnly(
  command: string,
  resolver: AllResolver = defaultAllResolver,
  timeoutMs = RESOLVE_TIMEOUT_MS,
  excludeDir?: string,
): Promise<string | null> {
  if (path.isAbsolute(command)) return command
  const cwd = path.resolve(process.cwd()) // which cwd 스냅샷과 일치시키려 await 전 캡처
  const exclude = excludeDir != null ? path.resolve(excludeDir) : null
  let matches: readonly string[] | null
  try {
    matches = await Promise.race([
      resolver(command).catch(() => []), // 비동기 which 는 not-found 시 reject → [] 정규화
      new Promise<null>((r) => {
        setTimeout(() => r(null), timeoutMs).unref?.()
      }),
    ])
  } catch {
    return null
  }
  if (!matches) return null // 타임아웃
  const safe = matches.find((m) => {
    if (!path.isAbsolute(m)) return false // §6 불변식① — 절대경로만
    const dir = path.resolve(path.dirname(m))
    const inCwd = isWindowsLike ? dir.toLowerCase() === cwd.toLowerCase() : dir === cwd
    if (inCwd) return false // 앱 cwd 셰도 제외
    if (exclude && isWithinDir(dir, exclude)) return false // 워크스페이스 서브트리 제외
    return true
  })
  return safe ?? null
}

/**
 * 명령이 PATH 에서 해석되는 실제 경로와 shadow 위험을 판정한다.
 * - not-found(null)·해석 예외·타임아웃 → 빈 객체(탐지 본 기능을 깨거나 매달지 않는다).
 * - 상대 PATH 또는 cwd 내부로 해석되면 pathShadowRisk: true.
 */
export async function resolveCommandPath(
  command: string,
  resolver: PathResolver = defaultResolver,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<{ resolvedPath?: string; pathShadowRisk?: boolean }> {
  try {
    const p = await Promise.race([
      resolver(command),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs).unref?.()
      }),
    ])
    if (!p) return {}
    return isShadowRisk(p) ? { resolvedPath: p, pathShadowRisk: true } : { resolvedPath: p }
  } catch {
    return {}
  }
}

/** 단일 CLI 감지. */
export async function detectCli(
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
  timeoutMs = 5000,
  resolver: PathResolver = defaultResolver,
): Promise<CliDetectionResult> {
  const base = {
    id: adapter.id,
    displayName: adapter.displayName,
    command: adapter.command,
    kind: 'cli' as const,
  }
  // 버전 spawn 과 경로 해석을 동시 실행(추가 지연 0). 경로 해석 실패는 탐지 본 기능을 깨지 않는다.
  const [res, pathInfo] = await Promise.all([
    runner(adapter.command, adapter.versionArgs, { timeoutMs }),
    resolveCommandPath(adapter.command, resolver),
  ])

  if (res.spawnError) {
    return { ...base, installed: false, error: res.spawnError, ...pathInfo }
  }
  const raw = (res.stdout || res.stderr).trim()
  if (res.code === 0) {
    return { ...base, installed: true, version: parseVersion(raw), raw, ...pathInfo }
  }
  return { ...base, installed: false, raw, error: `exit ${res.code}`, ...pathInfo }
}

/** 모든 어댑터 병렬 감지. */
export async function detectAll(
  adapters: readonly CliAdapter[],
  runner: CommandRunner = defaultRunner,
  timeoutMs = 5000,
  resolver: PathResolver = defaultResolver,
): Promise<CliDetectionResult[]> {
  return Promise.all(adapters.map((a) => detectCli(a, runner, timeoutMs, resolver)))
}
