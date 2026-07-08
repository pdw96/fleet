import { bootServer } from './boot'
import { installShutdownHandlers } from './shutdown-handlers'

/**
 * fleet-server 엔트리(#197 B3 · #216 C3) — 조립·검증·종료 로직은 전부 boot.ts/shutdown-handlers.ts
 * (테스트 가능)에 있고 여기는 부수효과(기동·시그널 배선)만 둔다. graceful drain 종료(신규 런 거부 →
 * 통지 → 진행 런 대기 상한 → close)는 shutdown-handlers.ts 가 결정론 검증한다. `running` 은 시그널 도달
 * 시점에 pending/reject 일 수 있어(핸들러가 즉시 설치돼 그 상태까지 다뤄야 함) 순수 함수에 Promise 를 넘긴다.
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

// SIGINT/SIGTERM graceful drain 종료(#216 C3) — 순수 로직은 shutdown-handlers.ts, 여기선 실 부수효과만 주입.
installShutdownHandlers(running, {
  onSignal: (signal, handler) => process.on(signal, handler),
  exit: (code) => process.exit(code),
  setBackstop: (fn, ms) => void setTimeout(fn, ms).unref(),
})
