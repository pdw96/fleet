# Electron autoUpdater (PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #74 후속 PR2 — `electron-updater` 로 notify·user-controlled 자동 업데이트를 main 프로세스에 배선하고 비차단 배너로 노출한다(PR1 이 세운 GitHub Releases 피드 위).

**Architecture:** 의존성 주입형 `auto-update.ts` 모듈(`crash-recovery.ts` 패턴)이 `electron-updater` 의 `autoUpdater`(포트로 주입)를 무장·이벤트 매핑·연산 스코프 추적하고 `UpdateController` 를 반환한다. `index.ts` 가 IPC 리터럴(5 invoke/handle + 1 send)을 소유해 parity 가드를 만족하고, 렌더러 `UpdateBanner` 가 main 스냅샷을 하이드레이트(라이브 우선)해 기동 이벤트 유실을 막는다.

**Tech Stack:** Electron 33 · electron-updater ^6 · electron-vite/Rollup · React 19 · Vitest · Testing-Library.

**Spec:** `docs/superpowers/specs/2026-06-20-electron-autoupdater-design.md` (v3, codex exec 3라운드 clean).

## Global Constraints

> 모든 태스크의 요구사항에 암묵 포함. 값은 스펙서 verbatim.

- **브랜치**: `feat/electron-autoupdater` (이미 분기·spec 3커밋 보유).
- **무장 조건**: `armed = isPackaged && !isE2E && platform !== 'darwin'`. 미무장 시 컨트롤러 = no-op, `getState()` = `{kind:'unsupported'}`.
- **updater 노브**: `autoDownload = false` · `allowPrerelease = true`.
- **CJS import (codex P2a)**: `import { autoUpdater } from 'electron-updater'` (named — default import 금지: external+CJS Rollup interop 래핑 위험).
- **패키징**: `electron-updater` 는 **production `dependencies`** + electron-vite **main 빌드 `rollupOptions.external: ['electron-updater']`**. `electron-builder.yml`/`files` 무변경(prod dep 자동 포함).
- **IPC 리터럴은 전부 `src/main/index.ts`·`src/preload/index.ts` 에**(parity 가드). 채널: invoke/handle `fleet:update:{getState,check,download,install,dismiss}` · send/on/removeListener `fleet:update:event`.
- **연산 스코프(codex P2)**: `activeOp: 'check'|'download'|'install'|null`. 종단 이벤트(`update-available`·`update-not-available`·`update-downloaded`·`error`)서 `null` 클리어. `error` 분류 = `activeOp ∈ {download,install}` → 배너 send / `{check,null}` → log-only·`not-available`(send 없음).
- **dismiss 권위(codex P2)**: `dismiss()` → main `currentState={kind:'idle'}`(send 없음). 렌더러도 로컬 idle.
- **4 게이트**: `npm run typecheck && npm run lint && npm run format:check && npm test` — 최종 전부 green. `ipc-parity.test.ts` 상시 green.
- **커밋**: 한국어 conventional commits + 저장소 표준 co-author 트레일러. 커밋 시 husky lint-staged 가 prettier/eslint 자동 적용.
- **engines**: `node >=22.22.1 <23 || >=24` (기존 — 변경 없음).

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/types.ts` | `UpdateEvent` 유니온 + `FleetBridge` 5 메서드 | Modify |
| `src/main/auto-update.ts` | autoUpdater 무장·이벤트 매핑·스코프·컨트롤러 (electron 비의존, DI) | Create |
| `src/main/auto-update.test.ts` | 페이크 updater 로 컨트롤러 유닛 테스트 | Create |
| `src/main/index.ts` | broadcast 헬퍼 + 컨트롤러 생성 + IPC 리터럴 5종 | Modify |
| `src/preload/index.ts` | 브리지 5 메서드 | Modify |
| `electron.vite.config.ts` | main `external: ['electron-updater']` | Modify |
| `package.json` | `electron-updater` prod dependency | Modify |
| `src/renderer/components/UpdateBanner.tsx` | 비차단 배너 + 하이드레이션 | Create |
| `src/renderer/components/UpdateBanner.test.tsx` | 배너 상태기계·하이드레이트 테스트 | Create |
| `src/renderer/App.tsx` | `<UpdateBanner />` 마운트 | Modify |
| `src/renderer/styles.css` | `.update-banner` 최소 스타일 | Modify |
| `src/main/ipc-parity.test.ts` | (변경 없음 — 신규 채널 자동 강제) | — |

---

## Task 1: `UpdateEvent` 타입 + `auto-update.ts` 모듈 (DI·TDD)

**Files:**
- Modify: `src/shared/types.ts` (`UpdateEvent` 유니온 추가 — `ChatStreamEvent` 정의(428행) 근처)
- Create: `src/main/auto-update.ts`
- Test: `src/main/auto-update.test.ts`

**Interfaces:**
- Produces:
  - `type UpdateEvent` (판별 유니온, 아래 코드)
  - `interface UpdaterPort { autoDownload: boolean; allowPrerelease: boolean; on(event, listener): void; checkForUpdates(): Promise<unknown>; downloadUpdate(): Promise<unknown>; quitAndInstall(): void }`
  - `interface AutoUpdateDeps { updater: UpdaterPort; send: (e: UpdateEvent) => void; isPackaged: boolean; isE2E: boolean; platform: NodeJS.Platform; logger?: Pick<Console,'info'|'warn'|'error'> }`
  - `interface UpdateController { getState(): UpdateEvent; check(): Promise<void>; download(): Promise<void>; install(): void; dismiss(): void }`
  - `function installAutoUpdate(deps: AutoUpdateDeps): UpdateController`

- [ ] **Step 1: `UpdateEvent` 타입 추가**

`src/shared/types.ts` 의 `ChatStreamEvent` 유니온(428행) 정의 바로 위에 삽입:

```ts
/**
 * 자동 업데이트 상태/이벤트 (main → 렌더러). main(currentState)이 권위 스냅샷이며
 * 렌더러는 onUpdateEvent 구독 + getUpdateState 하이드레이트로 동기화한다.
 * idle/checking/not-available/unsupported → 배너 미표시.
 */
export type UpdateEvent =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }
```

- [ ] **Step 2: 실패하는 테스트 작성**

Create `src/main/auto-update.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { installAutoUpdate, type AutoUpdateDeps, type UpdaterPort } from './auto-update'
import type { UpdateEvent } from '../shared/types'

/** electron-updater autoUpdater 의 크래시/이벤트 표면만 흉내내는 페이크 — 리스너를 캡처해 발화를 시뮬레이트. */
function fakeUpdater() {
  const listeners = new Map<string, (...a: unknown[]) => void>()
  const u: UpdaterPort & { emit: (ev: string, ...a: unknown[]) => void } = {
    autoDownload: true,
    allowPrerelease: false,
    on: (ev, l) => {
      listeners.set(ev, l as (...a: unknown[]) => void)
    },
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    emit: (ev, ...a) => listeners.get(ev)?.(...a),
  }
  return u
}

function make(overrides: Partial<AutoUpdateDeps> = {}) {
  const updater = fakeUpdater()
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
  return { updater, sent, log, controller }
}

describe('installAutoUpdate — 가드', () => {
  it('미패키지드는 미무장: unsupported·updater 무접촉', () => {
    const { updater, controller } = make({ isPackaged: false })
    expect(controller.getState()).toEqual({ kind: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.autoDownload).toBe(true) // 기본값 불변(무장 안 함)
  })

  it('darwin 은 미무장(latest-mac.yml 부재 feed 에러 회피)', () => {
    const { updater, controller } = make({ platform: 'darwin' })
    expect(controller.getState()).toEqual({ kind: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('E2E 는 미무장', () => {
    const { updater } = make({ isE2E: true })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('installAutoUpdate — 무장', () => {
  it('autoDownload=false·allowPrerelease=true 설정 + 기동 백그라운드 체크 1회', () => {
    const { updater } = make()
    expect(updater.autoDownload).toBe(false)
    expect(updater.allowPrerelease).toBe(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
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
    const { updater, controller } = make()
    await controller.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('dismiss → getState idle (send 없음)', () => {
    const { updater, sent, controller } = make()
    updater.emit('error', new Error('x')) // 백그라운드라 send 없음
    sent.length = 0
    controller.dismiss()
    expect(controller.getState()).toEqual({ kind: 'idle' })
    expect(sent).toEqual([]) // dismiss 는 broadcast 안 함
  })
})
```

> 위 "사용자 다운로드 에러" 테스트의 `await make.length` 줄은 오타 방지용 자리표시가 아니라 **삭제**한다 — 실제로는 두 번째 `make()` 블록만 쓴다. 구현 시 첫 `make()` 호출/`await make.length` 를 지우고 단일 시나리오로 정리한다(아래 Step 3 통과 후 Step 4 에서 확인).

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/auto-update.test.ts`
Expected: FAIL — "Cannot find module './auto-update'" / `installAutoUpdate is not a function`.

- [ ] **Step 4: `auto-update.ts` 구현**

Create `src/main/auto-update.ts`:

```ts
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
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/auto-update.test.ts`
Expected: PASS (전 케이스).

- [ ] **Step 6: 타입체크**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7: 커밋**

```bash
git add src/shared/types.ts src/main/auto-update.ts src/main/auto-update.test.ts
git commit -m "feat(update): autoUpdater 코어 모듈 — DI·스냅샷·activeOp 분류"
```

---

## Task 2: main/preload 배선 + dependency + 외부화 (parity 게이트)

**Files:**
- Modify: `package.json` (`dependencies` 에 `electron-updater`)
- Modify: `electron.vite.config.ts` (main `external`)
- Modify: `src/shared/types.ts` (`FleetBridge` 5 메서드)
- Modify: `src/main/index.ts` (import·broadcast·컨트롤러·IPC 리터럴 5)
- Modify: `src/preload/index.ts` (브리지 5)
- Test: `src/main/ipc-parity.test.ts` (기존 — 신규 채널 자동 강제)

**Interfaces:**
- Consumes: `installAutoUpdate`, `UpdateController`, `UpdateEvent` (Task 1)
- Produces: `FleetBridge.{getUpdateState,checkForUpdate,downloadUpdate,installUpdate,dismissUpdate,onUpdateEvent}` — 렌더러(Task 3)가 사용.

- [ ] **Step 1: electron-updater 설치 (prod dependency)**

Run: `npm install electron-updater@^6`
Expected: `package.json` `dependencies` 에 `electron-updater` 추가(devDependencies 아님). lockfile 갱신.

> electron-updater 는 순수 JS(네이티브 빌드 없음) — electron postinstall(allow-scripts) 이슈와 무관. 설치 후 `npm run dev` 가 electron 캐시 복원이 필요하면 AGENTS.md 의 electron 캐시 복원 절차를 따른다(패키징/테스트엔 무영향).

- [ ] **Step 2: main 빌드 외부화**

`electron.vite.config.ts` 의 `main.build.rollupOptions` 를 수정:

```ts
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['electron-updater'],
      },
    },
  },
```

- [ ] **Step 3: `FleetBridge` 5 메서드 추가**

`src/shared/types.ts` 의 `FleetBridge` 인터페이스 끝(`respondApproval` 다음, 538행 근처)에 추가:

```ts
  // 자동 업데이트
  /** 업데이트 상태 스냅샷(배너 마운트 하이드레이트). */
  getUpdateState(): Promise<UpdateEvent>
  /** 수동 업데이트 확인(백그라운드 분류). */
  checkForUpdate(): Promise<void>
  /** 다운로드 시작(사용자 액션). */
  downloadUpdate(): Promise<void>
  /** 다운로드분 설치·재시작(quitAndInstall). */
  installUpdate(): Promise<void>
  /** 배너 닫기 — main currentState=idle. */
  dismissUpdate(): Promise<void>
  /** 업데이트 이벤트 구독(해제 함수 반환). */
  onUpdateEvent(callback: (event: UpdateEvent) => void): () => void
```

- [ ] **Step 4: preload 브리지 추가**

`src/preload/index.ts` 의 `api` 객체 끝(`respondApproval` 다음, 80행)에 추가하고, 상단 type import 에 `UpdateEvent` 를 더한다:

```ts
// 상단 import 에 UpdateEvent 추가:
import type {
  ApprovalRequest,
  ChatStreamEvent,
  FleetBridge,
  McpServerSpec,
  OrchestratorEvent,
  UpdateEvent,
} from '../shared/types'

// api 끝에 추가:
  getUpdateState: () => ipcRenderer.invoke('fleet:update:getState'),
  checkForUpdate: () => ipcRenderer.invoke('fleet:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('fleet:update:download'),
  installUpdate: () => ipcRenderer.invoke('fleet:update:install'),
  dismissUpdate: () => ipcRenderer.invoke('fleet:update:dismiss'),
  onUpdateEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: UpdateEvent): void =>
      callback(event)
    ipcRenderer.on('fleet:update:event', listener)
    return () => {
      ipcRenderer.removeListener('fleet:update:event', listener)
    }
  },
```

- [ ] **Step 5: main 배선 (broadcast + 컨트롤러 + IPC 리터럴)**

`src/main/index.ts`:

(a) 상단 import 에 추가:

```ts
import { autoUpdater } from 'electron-updater'
import { installAutoUpdate } from './auto-update'
```

(b) type import 에 `UpdateEvent` 추가(`../shared/types` 블록):

```ts
import type {
  AgentRole,
  ApiProviderConfig,
  ApprovalRequest,
  AppInfo,
  ChatStreamEvent,
  McpServerSpec,
  OrchestratorEvent,
  RunProjectRequest,
  UpdateEvent,
} from '../shared/types'
```

(c) 기존 broadcast 헬퍼들(`broadcastApprovalRequest` 다음, 38행 근처) 아래에 추가:

```ts
function broadcastUpdateEvent(event: UpdateEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:update:event', event)
  }
}
```

(d) `app.whenReady().then(...)` 내부, `createWindow()` 호출(211행) 바로 다음에 추가:

```ts
  // 자동 업데이트: 패키지드·non-E2E·non-darwin 에서만 무장. 컨트롤러가 IPC 의 권위 소스.
  const updater = installAutoUpdate({
    updater: autoUpdater,
    send: broadcastUpdateEvent,
    isPackaged: app.isPackaged,
    isE2E: process.env['FLEET_E2E'] === '1' || !!process.env['FLEET_SMOKE'],
    platform: process.platform,
    logger: console,
  })
  ipcMain.handle('fleet:update:getState', () => updater.getState())
  ipcMain.handle('fleet:update:check', () => updater.check())
  ipcMain.handle('fleet:update:download', () => updater.download())
  ipcMain.handle('fleet:update:install', () => updater.install())
  ipcMain.handle('fleet:update:dismiss', () => updater.dismiss())
```

- [ ] **Step 6: parity·typecheck·lint·format 확인**

Run: `npx vitest run src/main/ipc-parity.test.ts`
Expected: PASS — 신규 5 invoke/handle + 1 send/on/removeListener 채널이 양쪽 일치.

Run: `npm run typecheck`
Expected: 0 errors.

Run: `npm run lint && npm run format:check`
Expected: 0 errors (신규 파일 prettier 정합 — 필요 시 `npm run format` 1회).

- [ ] **Step 7: 커밋**

```bash
git add package.json package-lock.json electron.vite.config.ts src/shared/types.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(update): electron-updater 배선 — IPC 5채널·main 외부화·prod dep"
```

---

## Task 3: `UpdateBanner` 컴포넌트 + 마운트 (TDD)

**Files:**
- Create: `src/renderer/components/UpdateBanner.tsx`
- Test: `src/renderer/components/UpdateBanner.test.tsx`
- Modify: `src/renderer/App.tsx` (마운트)
- Modify: `src/renderer/styles.css` (최소 스타일)

**Interfaces:**
- Consumes: `window.fleet.{onUpdateEvent,getUpdateState,downloadUpdate,installUpdate,dismissUpdate}`, `UpdateEvent` (Task 2)

- [ ] **Step 1: 실패하는 테스트 작성**

Create `src/renderer/components/UpdateBanner.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateEvent } from '../../shared/types'
import { UpdateBanner } from './UpdateBanner'

function mockFleet(snapshot: UpdateEvent = { kind: 'idle' }) {
  let handler: ((e: UpdateEvent) => void) | undefined
  const downloadUpdate = vi.fn().mockResolvedValue(undefined)
  const installUpdate = vi.fn().mockResolvedValue(undefined)
  const dismissUpdate = vi.fn().mockResolvedValue(undefined)
  const fleet = {
    onUpdateEvent: vi.fn((cb: (e: UpdateEvent) => void) => {
      handler = cb
      return () => {
        handler = undefined
      }
    }),
    getUpdateState: vi.fn().mockResolvedValue(snapshot),
    downloadUpdate,
    installUpdate,
    dismissUpdate,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return {
    fire: (e: UpdateEvent) => act(() => handler?.(e)),
    downloadUpdate,
    installUpdate,
    dismissUpdate,
  }
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('UpdateBanner', () => {
  it('idle 스냅샷이면 아무것도 렌더 안 함', async () => {
    mockFleet({ kind: 'idle' })
    const { container } = render(<UpdateBanner />)
    await act(async () => {})
    expect(container.querySelector('.update-banner')).toBeNull()
  })

  it('available 스냅샷을 하이드레이트해 다운로드 버튼 표시', async () => {
    mockFleet({ kind: 'available', version: '0.2.0' })
    render(<UpdateBanner />)
    expect(await screen.findByRole('button', { name: '다운로드' })).toBeTruthy()
    expect(screen.getByText(/0\.2\.0/)).toBeTruthy()
  })

  it('라이브 이벤트가 스냅샷을 이긴다(라이브 우선)', async () => {
    const { fire } = mockFleet({ kind: 'available', version: '0.2.0' })
    render(<UpdateBanner />)
    fire({ kind: 'not-available' }) // 스냅샷 resolve 전 라이브 도착
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '다운로드' })).toBeNull()
  })

  it('다운로드 클릭 → downloadUpdate 호출', async () => {
    const { downloadUpdate } = mockFleet({ kind: 'available', version: '0.2.0' })
    render(<UpdateBanner />)
    fireEvent.click(await screen.findByRole('button', { name: '다운로드' }))
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('progress 퍼센트 표시', async () => {
    const { fire } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'progress', percent: 42 })
    expect(screen.getByText(/42%/)).toBeTruthy()
  })

  it('downloaded → 지금 클릭 → installUpdate', async () => {
    const { fire, installUpdate } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'downloaded', version: '0.2.0' })
    fireEvent.click(screen.getByRole('button', { name: '지금' }))
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  it('downloaded → 나중에 클릭 → dismissUpdate + 배너 숨김', async () => {
    const { fire, dismissUpdate } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'downloaded', version: '0.2.0' })
    fireEvent.click(screen.getByRole('button', { name: '나중에' }))
    expect(dismissUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '지금' })).toBeNull()
  })

  it('error → 닫기 클릭 → dismissUpdate + 배너 숨김', async () => {
    const { fire, dismissUpdate } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'error', message: 'x' })
    expect(screen.getByText('업데이트 확인 실패')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(dismissUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('업데이트 확인 실패')).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/UpdateBanner.test.tsx`
Expected: FAIL — "Cannot find module './UpdateBanner'".

- [ ] **Step 3: `UpdateBanner.tsx` 구현**

Create `src/renderer/components/UpdateBanner.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { UpdateEvent } from '../../shared/types'

/**
 * 비차단 자동 업데이트 배너. App 레벨에 상시 마운트(탭 전환에 언마운트 안 됨, ApprovalModal 동형).
 * main(currentState)이 권위 — 구독 먼저 건 뒤 getUpdateState 로 하이드레이트하되, 그 사이 라이브
 * 이벤트가 오면 스냅샷으로 덮어쓰지 않는다(라이브 우선). 닫기/나중에는 main dismiss 로 권위 정리.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateEvent>({ kind: 'idle' })
  // 하이드레이션 레이스 가드: 스냅샷 resolve 전 라이브를 받았으면 스냅샷 무시(라이브 우선).
  const liveReceivedRef = useRef(false)

  useEffect(() => {
    const unsub = window.fleet.onUpdateEvent((e) => {
      liveReceivedRef.current = true
      setState(e)
    })
    void window.fleet.getUpdateState().then((snap) => {
      if (!liveReceivedRef.current) setState(snap)
    })
    return unsub
  }, [])

  const dismiss = (): void => {
    void window.fleet.dismissUpdate()
    setState({ kind: 'idle' })
  }

  if (state.kind === 'available') {
    return (
      <div className="update-banner" role="status">
        <span>새 버전 {state.version} 사용 가능</span>
        <button className="btn" onClick={() => void window.fleet.downloadUpdate()}>
          다운로드
        </button>
      </div>
    )
  }
  if (state.kind === 'progress') {
    return (
      <div className="update-banner" role="status">
        <span>업데이트 다운로드 중… {state.percent}%</span>
      </div>
    )
  }
  if (state.kind === 'downloaded') {
    return (
      <div className="update-banner" role="status">
        <span>버전 {state.version} 다운로드 완료 — 재시작해 적용</span>
        <button className="btn" onClick={() => void window.fleet.installUpdate()}>
          지금
        </button>
        <button className="btn btn-ghost" onClick={dismiss}>
          나중에
        </button>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="update-banner update-banner-error" role="status">
        <span>업데이트 확인 실패</span>
        <button className="btn btn-ghost" onClick={dismiss}>
          닫기
        </button>
      </div>
    )
  }
  return null // idle · checking · not-available · unsupported
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/UpdateBanner.test.tsx`
Expected: PASS (전 케이스).

- [ ] **Step 5: App.tsx 에 마운트**

`src/renderer/App.tsx`:

(a) import 추가:

```tsx
import { UpdateBanner } from './components/UpdateBanner'
```

(b) `<ApprovalModal />`(89행) 바로 위에 추가:

```tsx
      <UpdateBanner />
      <ApprovalModal />
```

- [ ] **Step 6: 최소 스타일**

`src/renderer/styles.css` 끝에 추가:

```css
.update-banner {
  position: fixed;
  left: 50%;
  bottom: 48px;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-radius: 8px;
  background: var(--panel, #25262b);
  border: 1px solid var(--line, #3a3b40);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  z-index: 50;
  font-size: 13px;
}
.update-banner-error {
  border-color: var(--bad, #e5484d);
}
.btn-ghost {
  background: transparent;
  opacity: 0.75;
}
```

> `--panel`/`--line`/`--bad` 변수가 styles.css 에 없으면 fallback 값이 적용된다(이미 정의돼 있으면 그 값 사용). `.btn` 은 기존 클래스 재사용.

- [ ] **Step 7: 게이트 + 커밋**

Run: `npm run typecheck && npx vitest run src/renderer/components/UpdateBanner.test.tsx`
Expected: 0 errors / PASS.

```bash
git add src/renderer/components/UpdateBanner.tsx src/renderer/components/UpdateBanner.test.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(update): UpdateBanner — 하이드레이션·상태기계·App 마운트"
```

---

## Task 4: 전체 게이트 + 패키징 검증 (dist:dir)

**Files:** (코드 변경 없음 — 검증·완수 게이트)

- [ ] **Step 1: 4 게이트 전체 실행**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: 전부 green(테스트 전건 PASS — 신규 `auto-update`/`UpdateBanner` + 기존 `ipc-parity` 포함).

- [ ] **Step 2: 패키징 산출 + 외부화/포함 검증**

Run: `npm run dist:dir`
Expected: `electron-vite build` → `out/` + `electron-builder --dir` → `dist/win-unpacked/` 생성(에러 없음).

검증(bash):

```bash
# (a) electron-updater 는 외부 require 로 남아야 한다(번들 금지 — 동적 require 보존).
grep -c "require('electron-updater')\|require(\"electron-updater\")" out/main/index.js   # ≥ 1

# (b) cross-spawn/safe-regex 는 외부 require 가 없어야 한다(번들 유지 = 무회귀).
grep -c "require('cross-spawn')\|require(\"cross-spawn\")\|require('safe-regex')\|require(\"safe-regex\")" out/main/index.js   # 0

# (c) 패키지드 asar 에 electron-updater 포함.
npx @electron/asar list dist/win-unpacked/resources/app.asar | grep -m1 "node_modules/electron-updater/package.json"   # 매치 1건
```

Expected: (a) ≥1 · (b) 0 · (c) 매치 존재. 하나라도 어긋나면 외부화/패키징 설정을 점검(스펙 §번들링).

- [ ] **Step 3: 패키지드 기동 smoke**

Run (PowerShell):
```powershell
$env:FLEET_SMOKE='1'; & .\dist\win-unpacked\Fleet.exe; echo "exit=$LASTEXITCODE"
```
Expected: 부팅 후 ~2초 내 종료(exit 0). updater 는 smoke(isE2E)서 미무장이라 네트워크 호출 없음.

- [ ] **Step 4: (선택) CI release E2E**

PR1 패턴 — 패키지드 앱이 updater 무장 후 정상 산출/기동하는지 1회 확인하려면:
```bash
# 임시 브랜치에서 version 을 0.1.0-pre.2 로 범프 후 일치 태그 push → release.yml 3-잡 green 확인
# 검증 후: gh release delete v0.1.0-pre.2 --cleanup-tag  (master 무오염)
```
Expected: prepare→build(win+ubuntu)→release green, GitHub Release 에 `.exe`·`.AppImage`·`latest*.yml` 게시. **실행 전 사용자 확인**(외부 릴리스 게시).

- [ ] **Step 5: 최종 커밋 (필요 시)**

dist:dir 검증서 설정 수정이 있었다면 커밋. 없으면 Task 1–3 커밋으로 PR 준비 완료.

```bash
git status   # clean 이면 추가 커밋 불요
```

---

## Self-Review (작성자 체크)

- **Spec coverage**: notify·user-controlled UX(Task 3 배너) · autoDownload=false/allowPrerelease=true(Task 1) · 스냅샷 하이드레이트 P1(Task 1 getState + Task 3 구독-먼저) · named import P2a(Task 2 Step 5a) · 백그라운드 에러 log-only P2b(Task 1 error 핸들러) · darwin 가드 P2c(Task 1) · activeOp 누수 P2(Task 1 종단 클리어 + 테스트) · main-side dismiss P2(Task 1 dismiss + Task 3 [닫기]/[나중에]) · 외부화+prod dep(Task 2) · IPC parity(Task 2 Step 6) · dist:dir 이중 단언 P3(Task 4 Step 2) · will-quit 명시 검증(Task 4 Step 3 기동 smoke + 선택 E2E) → **전 요구 매핑됨**.
- **Placeholder scan**: TBD/TODO/미완 단계 없음. 모든 코드 단계가 완전한 코드 블록 보유.
- **Type consistency**: `installAutoUpdate`/`UpdateController`/`UpdateEvent`/`UpdaterPort`/`AutoUpdateDeps` 명칭·시그니처가 Task 1↔2↔3 전부 일치. IPC 채널 문자열 5+1 이 index.ts↔preload↔테스트 일치.
