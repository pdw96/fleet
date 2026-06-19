/**
 * 자동 업데이트 — Electron 비의존(electron-updater 의 autoUpdater 를 포트로 주입)이라 헤드리스 검증 가능.
 *
 * UX = notify·user-controlled(autoDownload=false): 기동 시 조용히 백그라운드 체크 → 새 버전이 있으면
 * 렌더러 배너가 표시하고, 사용자가 명시적으로 다운로드/설치를 선택한다. main 이 last-state 스냅샷
 * (currentState)을 보유해 렌더러가 준비되기 전 발화한 이벤트도 getState 하이드레이트로 복원한다.
 *
 * 미무장 조건: 비패키지드(dev — app-update.yml 부재로 checkForUpdates throw)·E2E/smoke·darwin
 * (mac 타깃·latest-mac.yml 미산출 → feed 에러). 무장 시에만 리스너/네트워크.
 *
 * 연산 스코프(activeOp)로 error 를 분류: check/유휴 중 에러 = 백그라운드(log-only, 배너 무노출),
 * download/install 중 에러 = 사용자(배너). 종단 이벤트서 activeOp 를 null 로 클리어해 누수를 막는다.
 */
import type { UpdateEvent } from '../shared/types'

/** electron-updater autoUpdater 가 구조적으로 만족하는 최소 표면. */
export interface UpdaterPort {
  autoDownload: boolean
  allowPrerelease: boolean
  on(event: string, listener: (...args: unknown[]) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface AutoUpdateDeps {
  updater: UpdaterPort
  /** UpdateEvent 를 모든 창에 브로드캐스트(index.ts 의 리터럴 send). */
  send: (e: UpdateEvent) => void
  isPackaged: boolean
  /** FLEET_E2E==='1' || FLEET_SMOKE — 결정론 러너/스모크서 네트워크 차단. */
  isE2E: boolean
  platform: NodeJS.Platform
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

export interface UpdateController {
  /** 마운트 하이드레이트용 스냅샷. */
  getState(): UpdateEvent
  /** 백그라운드 체크(에러 log-only). */
  check(): Promise<void>
  /** 사용자 다운로드(에러 배너). */
  download(): Promise<void>
  /** 사용자 설치 — quitAndInstall. */
  install(): void
  /** 배너 닫기 — currentState=idle(권위). */
  dismiss(): void
}

export function installAutoUpdate(deps: AutoUpdateDeps): UpdateController {
  const log = deps.logger ?? console
  const armed = deps.isPackaged && !deps.isE2E && deps.platform !== 'darwin'

  if (!armed) {
    return {
      getState: (): UpdateEvent => ({ kind: 'unsupported' }),
      check: async (): Promise<void> => {},
      download: async (): Promise<void> => {},
      install: (): void => {},
      dismiss: (): void => {},
    }
  }

  const { updater, send } = deps
  let currentState: UpdateEvent = { kind: 'idle' }
  let activeOp: 'check' | 'download' | 'install' | null = null

  const set = (e: UpdateEvent): void => {
    currentState = e
    send(e)
  }

  updater.autoDownload = false
  updater.allowPrerelease = true

  updater.on('checking-for-update', () => set({ kind: 'checking' }))
  updater.on('update-available', (info: unknown) => {
    activeOp = null // check 종단
    set({ kind: 'available', version: readVersion(info) })
  })
  updater.on('update-not-available', () => {
    activeOp = null // check 종단
    set({ kind: 'not-available' })
  })
  updater.on('download-progress', (p: unknown) => {
    set({ kind: 'progress', percent: readPercent(p) })
  })
  updater.on('update-downloaded', (info: unknown) => {
    activeOp = null // download 종단
    set({ kind: 'downloaded', version: readVersion(info) })
  })
  updater.on('error', (err: unknown) => {
    const userInitiated = activeOp === 'download' || activeOp === 'install'
    activeOp = null
    const message = err instanceof Error ? err.message : String(err)
    if (userInitiated) {
      set({ kind: 'error', message }) // 배너
    } else {
      log.warn(`[fleet] 백그라운드 업데이트 확인 실패: ${message}`) // log-only
      currentState = { kind: 'not-available' } // 배너 무노출(send 안 함)
    }
  })

  const controller: UpdateController = {
    getState: () => currentState,
    check: async () => {
      activeOp = 'check'
      try {
        await updater.checkForUpdates()
      } catch {
        // 'error' 이벤트가 백그라운드로 분류하므로 reject 는 흡수한다.
      }
    },
    download: async () => {
      activeOp = 'download'
      try {
        await updater.downloadUpdate()
      } catch {
        // 'error' 이벤트가 사용자→배너로 분류하므로 reject 는 흡수한다.
      }
    },
    install: () => {
      activeOp = 'install'
      updater.quitAndInstall()
    },
    dismiss: () => {
      currentState = { kind: 'idle' } // main 권위, broadcast 없음(렌더러도 로컬 idle)
    },
  }

  void controller.check() // 기동 백그라운드 체크 — 스냅샷+하이드레이트로 타이밍 유실 무해
  return controller
}

function readVersion(info: unknown): string {
  if (info && typeof info === 'object' && 'version' in info) {
    const v = (info as { version: unknown }).version
    if (typeof v === 'string') return v
  }
  return '?'
}

function readPercent(p: unknown): number {
  if (p && typeof p === 'object' && 'percent' in p) {
    const n = (p as { percent: unknown }).percent
    if (typeof n === 'number' && Number.isFinite(n)) {
      return Math.max(0, Math.min(100, Math.round(n)))
    }
  }
  return 0
}
