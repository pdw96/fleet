import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'

/**
 * killTree 가 필요로 하는 자식 프로세스의 최소 표면.
 * node:child_process 의 ChildProcess 가 그대로 만족한다.
 */
export interface KillableChild {
  readonly pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

/** taskkill 발사에 쓰는 spawn 의 최소 표면(테스트 주입용). */
export interface KillProc {
  on(event: 'error' | 'exit' | 'close', handler: (...args: unknown[]) => void): unknown
  unref?(): void
}
export type KillSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => KillProc

/** 테스트에서 플랫폼/스폰을 주입하기 위한 옵션. 프로덕션은 기본값(process.platform + node spawn). */
export interface KillTreeOptions {
  platform?: NodeJS.Platform
  spawnFn?: KillSpawnFn
}

/**
 * win32 시스템 taskkill 절대경로. bare `taskkill` 을 띄우면 Windows CreateProcess 가 현재
 * 디렉터리·PATH 를 탐색하므로, workspace 가 영향을 주는 cwd/PATH 에 심긴 가짜 `taskkill.exe`
 * 로 하이재킹될 수 있다(이 정리 경로는 취소 시 승인 게이트 없이 돈다). 절대경로로 못 박는다.
 */
function taskkillPath(): string {
  const sysRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return join(sysRoot, 'System32', 'taskkill.exe')
}

/**
 * 자식 프로세스의 **전체 트리**를 종료한다. 반환 Promise 는 종료가 *확인*되면 resolve 한다 —
 * win32 는 taskkill 프로세스가 종료(=트리 force-kill 완료)할 때, POSIX 는 즉시(child.kill 발사).
 *
 * Windows 에서 cross-spawn 은 npm 설치 CLI(.cmd 셰임)를 cmd.exe 경유로 실행하므로
 * `child.kill()` 은 cmd.exe 껍데기만 죽이고 실제 CLI(node.exe 손자)는 살아남는다. 그러면
 * 취소/타임아웃 이후에도 편집 에이전트가 워크스페이스를 계속 수정해 engine 의 revert
 * (`git reset --hard` + `clean -ffd`)와 경합한다. win32 는 `taskkill /T`(트리) `/F`(강제)로
 * 자손까지 일괄 종료한다. POSIX 는 셰임 경유가 없어 `child.kill()` 로 충분하다.
 *
 * **반환 Promise 의 의미(취소·종료 무결성):** 호출자는 이 Promise 가 resolve 될 때까지 기다리면
 * 트리 종료 *조작*이 끝났음을 알 수 있다(win32 taskkill 종료 = 트리 force-kill 완료). 다만 stdout
 * 파이프를 상속한 손자가 *분리된 자손*을 또 띄운 경우엔 자식 'close'(파이프 EOF)만으로는 트리
 * 종료를 보장하지 못하므로, detect 러너는 이 Promise(트리 킬 확인)와 'close'(출력 드레인)를
 * **둘 다** 기다린 뒤 종결한다. taskkill 을 못 띄우면 child.kill() 로 폴백한다.
 */
export function killTree(child: KillableChild, opts: KillTreeOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  // POSIX 거나 pid 가 없으면(spawn 실패) 트리 킬 대상이 없다 — 기존 kill 로 충분(즉시 resolve).
  if (platform !== 'win32' || child.pid == null) {
    child.kill()
    return Promise.resolve()
  }
  const spawnFn = opts.spawnFn ?? (spawn as unknown as KillSpawnFn)
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    try {
      const proc = spawnFn(taskkillPath(), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      // taskkill 을 띄우지 못하면(드묾) 최소한 셰임이라도 죽이고 종결한다.
      proc.on('error', () => {
        child.kill()
        finish()
      })
      // taskkill 종료 = 트리 force-kill 조작 완료 → 그때 resolve 한다(호출자가 트리 종료를 기다릴 수 있게).
      proc.on('exit', finish)
      proc.unref?.()
    } catch {
      // spawn 동기 throw(이론상 드묾) — 폴백.
      child.kill()
      finish()
    }
  })
}
