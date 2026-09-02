/**
 * 데스크톱 이중 기동 배타 — Electron 비의존(app 유사 객체만 받는다)이라 헤드리스로 검증 가능.
 *
 * 왜 필요한가: 데스크톱 상태는 `fleet-store.json` 단일 파일이고, 매 변경마다 **전체 스냅샷을
 * write-rename 으로 덮어쓴다**(`core/store/json-file.ts`). 부팅 시 1회 로드한 메모리 상태가 권위이므로,
 * 같은 userData 를 잡은 두 인스턴스는 서로의 세션·방·이벤트를 나중에 저장한 쪽이 무성 소거한다
 * (last-writer-wins). 충돌 해소·병합 경로가 없어 사용자에게는 데이터가 "그냥 사라진" 것으로 보인다.
 *
 * 왜 여기서 막는가: `core/workbench/active-instance.ts` 의 인스턴스 배타는 **서버 표면 전용** 설계라
 * (같은 파일 머리 주석) 데스크톱을 대체하지 못한다. Electron 의 `requestSingleInstanceLock()` 은
 * userData 경로 단위 배타라 이 결함과 스코프가 정확히 일치한다 — e2e 처럼 `--user-data-dir` 로 분리된
 * 인스턴스는 서로 배타하지 않는다(격리된 store 라 유실도 없다).
 *
 * 계약: 락을 못 잡은 인스턴스는 `false` 를 받고 **엔진·store·IPC 를 아무것도 만들지 않은 채** 종료한다.
 * 부팅 배선(`whenReady`)이 이 반환값 뒤에 와야 하는 이유다 — `single-instance.test.ts` 가 소스 스캔으로 핀.
 */

/** acquireSingleInstanceLock 이 필요로 하는 app 의 최소 표면(실제 Electron.App 이 구조적으로 만족). */
export interface LockableApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

/** 두 번째 기동이 되살릴 창의 최소 표면(실제 Electron.BrowserWindow 가 구조적으로 만족). */
export interface RestorableWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface SingleInstanceOptions {
  /** 현재 열린 창 목록 — 첫 창을 되살린다(Fleet 은 단일 창 SPA). */
  getWindows: () => RestorableWindow[]
}

/**
 * 단일 인스턴스 락을 잡는다. `true` = 이 프로세스가 유일 인스턴스(부팅 계속), `false` = 이미 다른
 * 인스턴스가 있어 `quit()` 을 요청했으므로 **호출자는 어떤 부팅 배선도 하지 않아야 한다**.
 *
 * 락을 잡은 인스턴스는 이후 기동 시도(`second-instance`)마다 첫 창을 복원·포커스한다 — 두 번째 실행이
 * "아무 반응 없음"으로 보이지 않게 하는 부분이다. 창이 없으면(전부 닫힌 종료 진행 중) 무해하게 지나간다.
 */
export function acquireSingleInstanceLock(
  app: LockableApp,
  { getWindows }: SingleInstanceOptions,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', () => {
    const [win] = getWindows()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  return true
}
