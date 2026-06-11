import { spawn } from 'node:child_process'
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
  on(event: 'error', handler: (err: Error) => void): unknown
  unref?(): void
}
export type KillSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => KillProc

/** 테스트에서 플랫폼/스폰을 주입하기 위한 옵션. 프로덕션은 기본값(process.platform + node spawn). */
export interface KillTreeOptions {
  platform?: NodeJS.Platform
  spawnFn?: KillSpawnFn
}

/**
 * 자식 프로세스의 **전체 트리**를 종료한다.
 *
 * Windows 에서 cross-spawn 은 npm 설치 CLI(.cmd 셰임)를 cmd.exe 경유로 실행하므로
 * `child.kill()` 은 cmd.exe 껍데기 프로세스만 죽이고 실제 CLI(node.exe 손자)는 살아남는다.
 * 그러면 취소/타임아웃 이후에도 편집 에이전트가 워크스페이스를 계속 수정해
 * engine 의 revert(`git reset --hard` + `clean -ffd`)와 경합한다(취소·종료 무결성 깨짐).
 * win32 에서는 `taskkill /T`(트리) `/F`(강제)로 자손까지 일괄 종료한다.
 * POSIX 에서는 셰임 경유가 없어 `child.kill()` 로 충분하다.
 *
 * taskkill 은 발사 후 비대기(fire-and-forget)다 — 호출자는 기존처럼 자식의 'close' 이벤트로
 * 종료를 관측한다(child.kill() 계약과 동일). taskkill 자체를 못 띄우면 child.kill() 로 폴백한다.
 *
 * **주의(취소·종료 무결성):** 이 함수는 트리가 *완전히* 죽기 전에 반환한다(taskkill 비동기,
 * /T 가 자손까지 내리기까지 수십~수백 ms). 취소 직후 파괴적 후처리(워크스페이스 revert =
 * `git reset --hard`+`clean -ffd` 등)를 순서대로 수행하는 호출자는 반환을 트리 종료 완료로
 * 가정하지 말고 자식 'close' 이벤트를 관측해 동기화해야 한다(run 경로 취소·종료 무결성 후속 작업).
 */
export function killTree(child: KillableChild, opts: KillTreeOptions = {}): void {
  const platform = opts.platform ?? process.platform
  // POSIX 거나 pid 가 없으면(spawn 실패) 트리 킬 대상이 없다 — 기존 kill 로 충분.
  if (platform !== 'win32' || child.pid == null) {
    child.kill()
    return
  }
  const spawnFn = opts.spawnFn ?? (spawn as unknown as KillSpawnFn)
  try {
    const proc = spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    // taskkill 을 띄우지 못하면(드묾) 최소한 셰임이라도 죽인다.
    proc.on('error', () => child.kill())
    proc.unref?.()
  } catch {
    // spawn 동기 throw(이론상 드묾) — 폴백.
    child.kill()
  }
}
