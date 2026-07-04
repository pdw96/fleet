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
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`fleet-server 기동 타임아웃:\n${log}`)), 15_000)
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
  return {
    url,
    stop: () =>
      new Promise<void>((r) => {
        child.once('exit', () => {
          rmSync(dataDir, { recursive: true, force: true })
          r()
        })
        child.kill()
      }),
  }
}
