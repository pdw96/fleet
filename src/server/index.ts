import { bootServer } from './boot'

/**
 * fleet-server 엔트리(#197 B3) — 조립·검증 로직은 전부 boot.ts(테스트 가능)에 있고 여기는
 * 부수효과(기동·시그널 종료)만 둔다. 종료는 main/index.ts will-quit 와 동형: dispose 완료 후
 * 종료하되 3초 백스톱으로 종료를 보장한다(dispose 가 큐 대기로 지연될 수 있음).
 */
const running = bootServer(process.env)
running
  .then((s) => console.log(`fleet-server: http://127.0.0.1:${s.port} (loopback 고정 — B5 전)`))
  .catch((err) => {
    console.error('fleet-server 기동 실패:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.then((s) => s.close()).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  })
}
