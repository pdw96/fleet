import { describe, expect, it, vi } from 'vitest'
import { installAutoUpdate, type AutoUpdateDeps, type UpdaterPort } from './auto-update'
import type { UpdateEvent } from '../shared/types'

/** electron-updater autoUpdater 의 크래시/이벤트 표면만 흉내내는 페이크 — 리스너를 캡처해 발화를 시뮬레이트. */
function fakeUpdater() {
  const listeners = new Map<string, (...a: unknown[]) => void>()
  const checkForUpdates = vi.fn().mockResolvedValue(undefined)
  const downloadUpdate = vi.fn().mockResolvedValue(undefined)
  const quitAndInstall = vi.fn()
  const u: UpdaterPort & { emit: (ev: string, ...a: unknown[]) => void } = {
    autoDownload: true,
    allowPrerelease: false,
    on: (ev, l) => {
      listeners.set(ev, l as (...a: unknown[]) => void)
    },
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    emit: (ev, ...a) => listeners.get(ev)?.(...a),
  }
  return { u, checkForUpdates, downloadUpdate, quitAndInstall }
}

function make(overrides: Partial<AutoUpdateDeps> = {}) {
  const { u: updater, checkForUpdates, downloadUpdate, quitAndInstall } = fakeUpdater()
  const sent: UpdateEvent[] = []
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: AutoUpdateDeps = {
    updater,
    send: (e) => sent.push(e),
    isPackaged: true,
    isE2E: false,
    platform: 'win32',
    logger: log,
    ...overrides,
  }
  const controller = installAutoUpdate(deps)
  return { updater, sent, log, controller, checkForUpdates, downloadUpdate, quitAndInstall }
}

describe('installAutoUpdate — 가드', () => {
  it('미패키지드는 미무장: unsupported·updater 무접촉', () => {
    const { updater, controller, checkForUpdates } = make({ isPackaged: false })
    expect(controller.getState()).toEqual({ kind: 'unsupported' })
    expect(checkForUpdates).not.toHaveBeenCalled()
    expect(updater.autoDownload).toBe(true) // 기본값 불변(무장 안 함)
  })

  it('darwin 은 미무장(latest-mac.yml 부재 feed 에러 회피)', () => {
    const { controller, checkForUpdates } = make({ platform: 'darwin' })
    expect(controller.getState()).toEqual({ kind: 'unsupported' })
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it('E2E 는 미무장', () => {
    const { checkForUpdates } = make({ isE2E: true })
    expect(checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('installAutoUpdate — 무장', () => {
  it('autoDownload=false·allowPrerelease=true 설정 + 기동 백그라운드 체크 1회', () => {
    const { updater, checkForUpdates } = make()
    expect(updater.autoDownload).toBe(false)
    expect(updater.allowPrerelease).toBe(true)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('updater 이벤트를 UpdateEvent 로 매핑 + getState 스냅샷 반영', () => {
    const { updater, sent, controller } = make()
    updater.emit('update-available', { version: '0.2.0' })
    expect(sent.at(-1)).toEqual({ kind: 'available', version: '0.2.0' })
    expect(controller.getState()).toEqual({ kind: 'available', version: '0.2.0' })

    updater.emit('download-progress', { percent: 42.7 })
    expect(sent.at(-1)).toEqual({ kind: 'progress', percent: 43 })

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(sent.at(-1)).toEqual({ kind: 'downloaded', version: '0.2.0' })
    expect(controller.getState()).toEqual({ kind: 'downloaded', version: '0.2.0' })
  })

  it('백그라운드 체크 에러 → log-only·send 없음·state=not-available', () => {
    const { updater, sent, log, controller } = make()
    // 기동 체크(activeOp=check) 직후 error
    updater.emit('error', new Error('offline'))
    expect(sent).toEqual([]) // 배너 무노출
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toEqual({ kind: 'not-available' })
  })

  it('사용자 다운로드 에러 → error 이벤트 send(배너)', async () => {
    const { updater, sent, controller } = make()
    updater.emit('update-available', { version: '0.2.0' }) // check 종단(activeOp=null)
    await controller.download() // activeOp=download
    updater.emit('error', new Error('net'))
    expect(sent.at(-1)).toEqual({ kind: 'error', message: 'net' })
  })

  it('activeOp 누수 없음: download→downloaded→(이후)백그라운드 error 는 배너 X', async () => {
    const { updater, sent, controller } = make()
    updater.emit('update-available', { version: '0.2.0' })
    await controller.download()
    updater.emit('update-downloaded', { version: '0.2.0' }) // download 종단(activeOp=null)
    const before = sent.length
    updater.emit('error', new Error('later background')) // 백그라운드 분류
    expect(sent.length).toBe(before) // 새 send 없음
  })

  it('activeOp 누수 없음: download error(배너)→(이후)백그라운드 error 는 배너 X', async () => {
    const { updater, sent, controller } = make()
    updater.emit('update-available', { version: '0.2.0' })
    await controller.download()
    updater.emit('error', new Error('user err')) // 사용자 → 배너 + activeOp=null
    const afterUserErr = sent.length
    updater.emit('error', new Error('bg')) // 백그라운드 → send 없음
    expect(sent.length).toBe(afterUserErr)
  })

  it('download/install 은 updater 로 통과', async () => {
    const { controller, downloadUpdate, quitAndInstall } = make()
    await controller.download()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    controller.install()
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('dismiss → getState idle (send 없음)', () => {
    const { updater, sent, controller } = make()
    updater.emit('error', new Error('x')) // 백그라운드라 send 없음
    sent.length = 0
    controller.dismiss()
    expect(controller.getState()).toEqual({ kind: 'idle' })
    expect(sent).toEqual([]) // dismiss 는 broadcast 안 함
  })

  it('install 후 error → 배너(install=사용자 기동, activeOp=install 유지 의도 문서화)', () => {
    const { updater, sent, controller } = make()
    // update-downloaded 로 check 종단(activeOp=null)
    updater.emit('update-downloaded', { version: '0.2.0' })
    // install 호출 → activeOp='install' 설정 + quitAndInstall 호출(no-op)
    controller.install()
    // quitAndInstall 이후 updater 가 error 를 발화하면 배너로 분류
    updater.emit('error', new Error('install fail'))
    expect(sent.at(-1)).toEqual({ kind: 'error', message: 'install fail' })
  })

  it('update-not-available → state=not-available + activeOp 클리어(이후 error 는 백그라운드)', () => {
    const { updater, sent, controller } = make()
    updater.emit('update-not-available')
    expect(sent.at(-1)).toEqual({ kind: 'not-available' })
    expect(controller.getState()).toEqual({ kind: 'not-available' })
    // activeOp 는 update-not-available 에서 null 로 클리어되어야 함
    const before = sent.length
    updater.emit('error', new Error('bg'))
    expect(sent.length).toBe(before) // 새 send 없음(백그라운드 분류)
  })

  it("백그라운드 체크 에러 → log-only(타이밍 보충): installAutoUpdate 가 void controller.check()를\n       호출해 activeOp='check'를 동기적으로 설정한 뒤 checkForUpdates()를 await 하므로,\n       error 이벤트를 즉시 발화해도 올바르게 백그라운드로 분류된다", () => {
    const { updater, sent, log } = make()
    // 기동 직후 error — activeOp='check' 상태에서 발화되므로 백그라운드
    updater.emit('error', new Error('startup-fail'))
    expect(sent).toEqual([])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
