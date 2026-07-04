import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 웹 스모크용 fleet-server 실기동(#197 B4) — 빌드 번들(out/server/index.mjs)을 자식 프로세스로 띄우고
 * 기동 로그에서 포트를 파싱한다(FLEET_PORT=0 = OS 배정 — 병렬/충돌 무관). 정적 서빙은 번들 기본 경로
 * (out/renderer)를 그대로 쓴다. store 는 임시 디렉터리(FLEET_DATA_DIR)로 격리하고 종료 시 정리한다.
 * loopback 한정(이슈 B4 — B5 전 bind 게이트와 짝).
 */
export interface RunningWebServer {
  url: string
  stop(): Promise<void>
}

export async function startFleetWebServer(
  extraEnv: Record<string, string> = {},
): Promise<RunningWebServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'fleet-web-e2e-'))
  const child = spawn(process.execPath, [resolve(__dirname, '..', 'out', 'server', 'index.mjs')], {
    env: { ...process.env, FLEET_E2E: '1', FLEET_PORT: '0', FLEET_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let url: string
  try {
    url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fleet-server 기동 타임아웃:\n${log}`)),
        15_000,
      )
      child.stdout?.on('data', (d: Buffer) => {
        log += d.toString()
        const m = log.match(/fleet-server: (http:\/\/127\.0\.0\.1:\d+)/)
        if (m) {
          clearTimeout(timer)
          resolveUrl(m[1])
        }
      })
      child.stderr?.on('data', (d: Buffer) => {
        log += d.toString()
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`fleet-server 조기 종료(code ${code}):\n${log}`))
      })
    })
  } catch (err) {
    // 기동 실패(타임아웃·조기종료)에서 자식 프로세스·임시 디렉터리를 정리하고 rethrow — 핸들이 반환되지
    // 않아 stop() 이 절대 호출되지 않으므로 여기서 정리하지 않으면 orphan 프로세스/tmp 누수(리뷰 [8]).
    child.kill()
    rmSync(dataDir, { recursive: true, force: true })
    throw err
  }
  return {
    url,
    stop: () =>
      new Promise<void>((r) => {
        const done = () => {
          rmSync(dataDir, { recursive: true, force: true })
          r()
        }
        // 이미 종료된 child 에는 exit 가 재발화하지 않는다(kill=no-op) — 가드 없이 once('exit')만 걸면
        // 2차 stop()/중도 크래시 후 stop() 이 영구 hang(리뷰 [9]).
        if (child.exitCode !== null || child.signalCode !== null) {
          done()
          return
        }
        child.once('exit', done)
        child.kill()
      }),
  }
}
