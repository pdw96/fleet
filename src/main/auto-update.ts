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
import type { UpdateEvent, UpdaterChannel } from '../shared/types'

/** electron-updater autoUpdater 가 구조적으로 만족하는 최소 표면. */
export interface UpdaterPort {
  autoDownload: boolean
  allowPrerelease: boolean
  /** 더 낮은 버전 수용 여부. channel 설정의 부작용으로 켜질 수 있어 채널별로 명시 제어(#98). */
  allowDowngrade: boolean
  /** 피드 채널(`${channel}.yml`). GitHub provider 는 태그를 무시하므로 명시 설정 필요(#98). */
  channel: string | null
  on(event: string, listener: (...args: unknown[]) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

/** 채널 선호 → electron-updater 피드 채널. stable=latest.yml, beta=beta.yml(prerelease 허용 동반). */
function feedChannel(channel: UpdaterChannel): string {
  return channel === 'beta' ? 'beta' : 'latest'
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
  /** 무장 시 초기 allowPrerelease 를 결정할 채널 조회(#98). 미주입이면 stable. */
  getChannel?: () => UpdaterChannel
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
  /** 업데이트 채널 변경 적용(#98) — allowPrerelease 갱신 + 스테일 상태 리셋 + 새 채널 재확인. */
  setChannel(channel: UpdaterChannel): void
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
      setChannel: (): void => {}, // 미무장 — updater 무접촉(채널은 store 에만 영속)
    }
  }

  const { updater, send } = deps
  let currentState: UpdateEvent = { kind: 'idle' }
  let activeOp: 'check' | 'download' | 'install' | null = null
  // #98 채널 세대: setChannel 마다 증가. 구 채널 작업(다운로드·체크)의 잔여 이벤트를 무효화한다.
  let gen = 0
  let downloadGen = 0 // 초기엔 현 세대와 일치(채널 전환 전 다운로드 이벤트는 억제 안 함)
  let checkGen = 0 // 진행 중 체크가 속한 세대 — available/not-available 결과를 세대로 게이트
  // checkForUpdates 는 electron-updater 가 in-flight 호출을 coalesce 한다. 채널 전환 재확인이
  // 진행 중 체크에 합쳐져 새 allowPrerelease/channel 로 재발행되지 않는 것을 막는 직렬화 가드.
  let checking = false
  let recheckPending = false

  const set = (e: UpdateEvent): void => {
    currentState = e
    send(e)
  }

  // #98: 채널 선호로 피드 채널 + prerelease 허용을 정한다(기본 stable=latest·false). 미주입이면 stable.
  // allowDowngrade 는 channel 설정 부작용으로 켜질 수 있어(generateUpdatesFilesForAllChannels) 명시 제어 —
  // stable 은 다운그레이드 거부(롤백·메타 혼선 시 구버전 설치 방지), beta 는 허용(높은 stable→낮은 beta 진입).
  const applyChannel = (channel: UpdaterChannel): void => {
    updater.channel = feedChannel(channel)
    updater.allowPrerelease = channel === 'beta'
    updater.allowDowngrade = channel === 'beta'
  }

  updater.autoDownload = false
  applyChannel(deps.getChannel?.() ?? 'stable')

  updater.on('checking-for-update', () => set({ kind: 'checking' }))
  updater.on('update-available', (info: unknown) => {
    activeOp = null // check 종단
    if (checkGen !== gen) return // #98: 채널 전환 전 시작된 구 채널 체크의 결과 무시(스테일 배너 방지)
    set({ kind: 'available', version: readVersion(info) })
  })
  updater.on('update-not-available', () => {
    activeOp = null // check 종단
    if (checkGen !== gen) return // #98: 구 채널 체크의 not-available 무시(새 채널 재확인이 권위)
    set({ kind: 'not-available' })
  })
  updater.on('download-progress', (p: unknown) => {
    if (downloadGen !== gen) return // #98: 채널 전환 전 시작된 구 채널 다운로드의 잔여 progress 무시
    set({ kind: 'progress', percent: readPercent(p) })
  })
  updater.on('update-downloaded', (info: unknown) => {
    activeOp = null // download 종단
    if (downloadGen !== gen) return // #98: 떠난 채널의 다운로드 완료 배너(오설치 유도) 억제
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
      // #98: in-flight 체크가 있으면 coalescing 으로 새 채널 설정이 반영 안 되므로, 직접 재발행하지
      // 않고 보류 플래그만 세운다. 진행 중 체크가 settle 되면 새 allowPrerelease/channel 로 1회 재확인.
      if (checking) {
        recheckPending = true
        return
      }
      checking = true
      checkGen = gen // 이 체크가 속한 채널 세대 — 결과 이벤트 게이트 기준
      try {
        await updater.checkForUpdates()
      } catch {
        // 'error' 이벤트가 백그라운드로 분류하므로 reject 는 흡수한다.
      } finally {
        checking = false
        if (recheckPending) {
          recheckPending = false
          void controller.check()
        }
      }
    },
    download: async () => {
      activeOp = 'download'
      downloadGen = gen // 이 다운로드가 속한 채널 세대 — 이후 채널 전환 시 잔여 이벤트 식별용
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
    setChannel: (channel) => {
      // #98: 피드 채널(beta.yml)+prerelease 허용을 새 채널에 맞추고, 세대를 올려 구 채널 다운로드의
      // 잔여 이벤트를 무효화한 뒤, 스테일 배너를 리셋하고 새 채널을 재확인한다(in-flight 면 settle 후
      // 1회 재발행). 영속은 호출부(store)가 담당 — 여기선 런타임 적용만.
      applyChannel(channel)
      gen++
      currentState = { kind: 'idle' }
      void controller.check()
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
