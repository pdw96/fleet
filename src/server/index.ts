import { bootServer } from './boot'

/**
 * fleet-server 엔트리(#197 B3) — 조립·검증 로직은 전부 boot.ts(테스트 가능)에 있고 여기는
 * 부수효과(기동·시그널 종료)만 둔다. 종료 모양(dispose 후 종료 + 3초 백스톱)은
 * main/index.ts will-quit 와 유사하나 완전히 동형은 아니다: `running` 은 시그널 도달 시점에
 * 아직 pending 이거나 이미 reject 된 상태일 수 있는 비동기 promise라서, 핸들러가 그 reject
 * 분기까지 반드시 처리해야 한다(미처리 시 기동 실패 후 시그널 → unhandled rejection 크래시).
 */
const running = bootServer(process.env)
running
  // 기동 로그 — loopback 은 `fleet-server: http://127.0.0.1:PORT` 접두 포맷 불변(e2e/web-server.ts:35
  // 파서 regex 계약). access 는 실 bind 호스트 표기(파서 대상 아님·loopback e2e 만 파싱).
  .then((s) => console.log(`fleet-server: http://${s.host}:${s.port} (mode: ${s.mode})`))
  .catch((err) => {
    console.error('fleet-server 기동 실패:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running
      .then((s) => s.close())
      .then(
        () => process.exit(0),
        // boot 실패(running reject)/close 실패 — 이미 상단 .catch 가 로깅·exitCode 설정을 했으니
        // 여기서는 unhandled rejection 으로 새는 것만 막고 종료 코드 1로 정리한다.
        () => process.exit(1),
      )
    setTimeout(() => process.exit(1), 3000).unref()
  })
}
