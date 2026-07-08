import type { RunningServer } from './boot'

/**
 * SIGINT/SIGTERM 종료 배선(#216 C3 T4) — index.ts 부수효과 엔트리에서 분리한 **순수** 함수(레포 관례:
 * "조립·검증 로직은 boot.ts, index 는 부수효과만" · index.ts 헤더). 주입식이라 boot pending/reject·
 * teardown 실패·2차 시그널 경로를 결정론 단위 검증한다.
 *
 * **입력은 `Promise<RunningServer>`(Codex 계획리뷰 P1)** — 현행 index.ts 처럼 시그널 핸들러를 즉시 설치해
 * "running 은 시그널 도달 시점에 pending 이거나 reject 일 수 있다"는 안전 계약을 보존한다. resolved 서버만
 * 받으면 boot-pending 중 SIGTERM 을 놓친다.
 *
 * 백스톱 정책: `s.drainTimeoutMs + 3000`(unref)은 boot resolve **후** `.then` 안에서만 무장한다(drainTimeoutMs
 * 는 boot 완료 전엔 미상). boot 이 hang 하면 index 동기 백스톱은 없고 — 종착은 2차 시그널(로컬/베어호스트) 또는
 * 컨테이너 SIGKILL@stop_grace_period(ADR-0011). boot 은 통상 서브초라 실무 위험 낮음.
 */
export interface ShutdownDeps {
  /** 시그널 구독(index.ts = process.on). 동일 핸들러를 SIGINT·SIGTERM 에 건다(shuttingDown 공유). */
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void
  /** 프로세스 종료(index.ts = process.exit). */
  exit: (code: number) => void
  /** teardown hang 백스톱(index.ts = setTimeout(fn, ms).unref()). shutdown 대상 resolve 후 무장. */
  setBackstop: (fn: () => void, ms: number) => void
}

export function installShutdownHandlers(running: Promise<RunningServer>, deps: ShutdownDeps): void {
  let shuttingDown = false
  const handler = (): void => {
    // 2차 시그널(로컬/베어호스트 Ctrl-C 연타) = 즉시 강제 종료. 컨테이너는 docker stop 이 SIGTERM 1회라
    // 이 경로 미발화 — 컨테이너 궁극 backstop 은 SIGKILL@stop_grace_period.
    if (shuttingDown) {
      deps.exit(1)
      return
    }
    shuttingDown = true
    // 즉시 running 에 배선 — pending 이면 boot 완료까지 대기, reject 면 exit(1)(unhandled rejection 없이).
    void running
      .then(
        (s) => {
          // 백스톱은 drainTimeoutMs 확정(boot resolve) 후에만 무장.
          deps.setBackstop(() => deps.exit(1), s.drainTimeoutMs + 3000)
          return s.shutdown().then(() => deps.exit(0))
        },
        () => deps.exit(1), // boot 실패(running reject)
      )
      .catch(() => deps.exit(1)) // shutdown/teardown reject
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) deps.onSignal(signal, handler)
}
