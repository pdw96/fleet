import { StringDecoder } from 'node:string_decoder'
import spawn from 'cross-spawn'
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
export const defaultRunner: CommandRunner = (command, args, opts, onStdout) =>
  new Promise<CommandResult>((resolve) => {
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

    const child = spawn(command, args, { windowsHide: true, cwd })

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
  const res = await runner(adapter.command, adapter.versionArgs, { timeoutMs })

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
