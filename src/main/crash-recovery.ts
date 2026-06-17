/**
 * 렌더러 크래시 자동 복구 — Electron 비의존(webContents/app 유사 객체만 받는다)이라 헤드리스로 검증 가능.
 *
 * 렌더러 프로세스가 예기치 않게 사라지면(crashed/oom/killed/abnormal-exit 등) 창은 흰 화면으로 멈춘다.
 * `render-process-gone` 이벤트를 받아 해당 창을 reload 해 자동 복구한다 — 이것이 진짜 가치다.
 *
 * ⚠️ 의도적으로 하지 않는 것(이슈 #27 가치 기각):
 *   - `uncaughtException` log-and-continue 는 Node 안티패턴이라 추가하지 않는다(메인 프로세스를
 *     깨진 상태로 계속 굴리는 건 위험). 여기서 다루는 건 렌더러 화이트스크린 복구뿐이다.
 *   - 상태 영속은 이미 store/json-file 의 atomic write-rename 로 크래시를 생존하므로 재구현하지 않는다.
 *
 * 무한 reload 루프 방지: 연속 크래시 횟수를 세고, 안정 구간(resetMs)이 지나면 카운트를 리셋한다.
 * 매 reload 마다 지수 백오프로 간격을 벌리고, maxReloads 를 넘기면 reload 를 포기한다 — 흰 화면을
 * 유지하는 편이 무한 재크래시(reload 폭주)보다 안전하다.
 *
 * 검증된 Electron 33.4.11 API (공식 docs · v33.4.11 태그 raw):
 *   - webContents 'render-process-gone' → 리스너 (event, details: RenderProcessGoneDetails)
 *     details.reason ∈ clean-exit | abnormal-exit | killed | crashed | oom | launch-failed | integrity-failure
 *     details.exitCode: number
 *   - webContents.reload() / webContents.isDestroyed()
 *   reload 를 생략하는 경우는 (1) reason=clean-exit(종료코드 0 정상 종료) (2) 앱 종료 진행 중(isShuttingDown)
 *   (3) 백오프 대기 중 창 파괴(isDestroyed) 뿐이다. 특히 reason=killed 는 "SIGTERM 등 외부 강제 종료"
 *   (forcefullyCrashRenderer 포함)라 창은 살아있고 렌더러만 사라진 흰 화면 → reload 로 복구한다(외부 kill 을
 *   teardown 으로 오인해 생략하면 복구가 무력화된다).
 */

/** render-process-gone 이벤트가 싣는 details 의 최소 표면(Electron RenderProcessGoneDetails 가 구조적으로 만족). */
export interface RenderProcessGoneInfo {
  reason: string
  exitCode: number
}

/** installCrashRecovery 가 필요로 하는 webContents 의 최소 표면(실제 Electron.WebContents 가 구조적으로 만족). */
export interface RecoverableWebContents {
  on(event: 'render-process-gone', listener: (event: unknown, details: RenderProcessGoneInfo) => void): unknown
  reload(): void
  isDestroyed(): boolean
}

export interface CrashRecoveryOptions {
  /** 안정 구간(ms) — 마지막 크래시 후 이 시간이 지나면 연속 카운트를 0 으로 리셋(기본 30초). */
  resetMs?: number
  /** 연속 크래시 허용 한도 — 초과하면 reload 를 포기(기본 3회). */
  maxReloads?: number
  /** 백오프 기준 간격(ms) — n 번째 연속 크래시는 base·2^(n-1) 후 reload(기본 500ms). */
  baseDelayMs?: number
  /** 백오프 상한(ms) (기본 5초). */
  maxDelayMs?: number
  /** 진단 로그 sink(기본 console.warn). 테스트에서 주입. */
  log?: (message: string) => void
  /** 지연 실행기(기본 setTimeout). 테스트에서 결정론적 가짜 타이머 주입. */
  schedule?: (fn: () => void, ms: number) => void
  /** 시계(기본 Date.now). 테스트에서 주입. */
  now?: () => number
  /**
   * 앱이 종료(quit) 진행 중인지(기본 () => false). true 면 종료와 싸우지 않도록 reload 를 생략한다.
   * teardown 억제는 reason 이 아니라 이 가드로 판정한다 — 종료 중엔 어떤 사유의 렌더러 종료든 복구하지 않는다.
   */
  isShuttingDown?: () => boolean
}

/**
 * 렌더러 reload 생략 사유: reason=clean-exit(종료코드 0 정상 종료) 만. 나머지(killed·crashed·oom·
 * abnormal-exit·launch-failed·integrity-failure)는 창이 살아있는 비정상 종료라 복구(reload) 대상이다.
 * ⚠️ killed(외부 SIGTERM·forcefullyCrashRenderer)를 여기 넣으면 외부 kill 된 렌더러가 흰 화면으로
 *    방치된다 — 앱 teardown 억제는 reason 이 아니라 isShuttingDown/isDestroyed 가드로 한다.
 */
const SKIP_RELOAD_REASONS = new Set(['clean-exit'])

/**
 * child-process-gone(진단 로그 전용) 기록 생략 사유. 보조 프로세스(GPU·Utility 등)는 Chromium 이 자동
 * 재기동하고 복구 액션이 없으므로, 정상 종료(clean-exit)와 종료 시 흔한 외부 kill(killed)은 로그 노이즈라
 * 생략한다(렌더러 reload 와 달리 복구 영향 없음).
 */
const SKIP_LOG_REASONS = new Set(['clean-exit', 'killed'])

/**
 * 한 webContents 에 렌더러 크래시 자동 reload 복구를 설치한다(창마다 1회 호출 — 각 창이 자기 wc 를 reload).
 */
export function installCrashRecovery(wc: RecoverableWebContents, options: CrashRecoveryOptions = {}): void {
  const resetMs = options.resetMs ?? 30_000
  const maxReloads = options.maxReloads ?? 3
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 5_000
  const log = options.log ?? ((m): void => console.warn(m))
  const schedule = options.schedule ?? ((fn, ms): void => void setTimeout(fn, ms))
  const now = options.now ?? ((): number => Date.now())
  const isShuttingDown = options.isShuttingDown ?? ((): boolean => false)

  let crashCount = 0
  let lastCrashAt = 0

  wc.on('render-process-gone', (_event, details) => {
    const at = now()
    // 안정 구간이 지난 뒤의 크래시는 별개 사건으로 본다 → 연속 카운트 리셋(백오프·포기 판정을 새로 시작).
    if (at - lastCrashAt > resetMs) crashCount = 0
    lastCrashAt = at

    if (SKIP_RELOAD_REASONS.has(details.reason)) {
      // reason=clean-exit(종료코드 0) 은 정상 종료라 reload 하지 않는다. killed(외부 강제 종료)는 여기 없다 — 복구 대상.
      log(`[fleet] 렌더러 정상 종료(reason=${details.reason}, exitCode=${details.exitCode}) — reload 생략`)
      return
    }

    crashCount += 1
    if (crashCount > maxReloads) {
      // reload 폭주 차단: 짧은 구간에 연속 크래시가 한도를 넘으면 포기(흰 화면 유지 > 무한 재크래시).
      log(`[fleet] 렌더러 연속 크래시 ${crashCount}회(reason=${details.reason}) — reload 포기(한도 ${maxReloads} 초과)`)
      return
    }

    const delay = Math.min(baseDelayMs * 2 ** (crashCount - 1), maxDelayMs)
    log(
      `[fleet] 렌더러 크래시(reason=${details.reason}, exitCode=${details.exitCode}) — ${delay}ms 후 reload(${crashCount}/${maxReloads})`,
    )
    schedule(() => {
      // 백오프 대기 중 창이 닫혔거나(파괴된 wc 접근 방지) 앱이 종료 진행 중이면 reload 금지(teardown 과 싸우지 않는다).
      if (wc.isDestroyed() || isShuttingDown()) return
      wc.reload()
    }, delay)
  })
}

/** child-process-gone 이벤트가 싣는 details 의 최소 표면(Electron 의 details 객체가 구조적으로 만족). */
export interface ChildProcessGoneInfo {
  type: string
  reason: string
  exitCode: number
  serviceName?: string
  name?: string
}

/** installChildProcessObserver 가 필요로 하는 app 의 최소 표면(실제 Electron.App 이 구조적으로 만족). */
export interface ChildProcessObservable {
  on(event: 'child-process-gone', listener: (event: unknown, details: ChildProcessGoneInfo) => void): unknown
}

/**
 * 보조 프로세스(GPU·Utility·Zygote 등) 종료를 진단 로그로만 남긴다.
 *
 * 의도적 스코프 한정: 이들은 렌더러가 아니라 Chromium 이 자동으로 재기동하는 보조 프로세스라
 * 렌더러 reload 로 복구되지 않는다 → reload 하지 않고 관측·기록만 한다(향후 eventlog-ui 연계 여지).
 * child-process-gone 은 `app` 에만 발화하며(webContents 아님) 검증된 details: type·reason·exitCode·serviceName?·name?.
 */
export function installChildProcessObserver(
  appLike: ChildProcessObservable,
  log: (message: string) => void = (m): void => console.warn(m),
): void {
  appLike.on('child-process-gone', (_event, details) => {
    if (SKIP_LOG_REASONS.has(details.reason)) return // 정상 종료·종료 시 kill 은 잡음이라 기록하지 않는다.
    const nameSuffix = details.name ? `, name=${details.name}` : ''
    log(
      `[fleet] 보조 프로세스 종료(type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}${nameSuffix}) — Chromium 자동 재기동 대상, reload 안 함`,
    )
  })
}
