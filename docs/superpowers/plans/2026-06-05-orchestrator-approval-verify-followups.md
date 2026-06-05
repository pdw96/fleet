# 승인 모달 + verify 자동 수정-루프 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR #5의 후속 미구현 2건(destructive 작업 승인 모달, verify 실패 자동 수정-루프)을 `fix/orchestrator-robustness` 브랜치에 구현한다.

**Architecture:** 승인은 인앱 React 모달 + IPC 왕복으로 처리하되 상관/타임아웃 로직은 순수 모듈(`approval-bridge.ts`)에 두어 헤드리스 테스트를 보장한다. verify 자동 수정은 `runProject`의 검증 섹션을 루프로 확장해, 실패 분석 + 현재 아티팩트를 implementer에 피드백하고 교정본을 게이트 경유 기록 후 재검증한다.

**Tech Stack:** Electron + TypeScript(main/preload), React 18 + Vite(renderer), vitest(+jsdom/RTL), 순수 TS 코어 엔진.

> **커밋 정책(사용자 지정):** 구현 중 태스크별 커밋을 하지 않는다. 각 태스크는 "검증 그린"으로 종료하고, 마지막 태스크에서 스펙 문서 + 전체 변경을 **단일 커밋**으로 묶는다(커밋 전 사용자 확인).

> **검증 명령:** `npm test`(vitest run), `npm run typecheck`(tsc node+web), `npm run lint`(eslint), `npm run build`(electron-vite build).

---

## 파일 구조 (생성/수정)

**기능 1 — 승인 모달**
- Create: `src/main/core/safety/approval-bridge.ts` — IPC 승인 상관/타임아웃(순수)
- Create: `src/main/core/safety/approval-bridge.test.ts`
- Modify: `src/shared/types.ts` — `APPROVAL_TIMEOUT_MS`, `FleetBridge` 2개 메서드, `OrchestratorEventType`에 `verify.fixing`
- Modify: `src/preload/index.ts` — `onApprovalRequest`, `respondApproval`
- Modify: `src/main/index.ts` — approver 주입 + `fleet:approval:respond` 핸들러 + 요청 브로드캐스트
- Create: `src/renderer/components/ApprovalModal.tsx`
- Create: `src/renderer/components/ApprovalModal.test.tsx`
- Modify: `src/renderer/App.tsx` — 모달 상시 마운트
- Modify: `src/renderer/styles.css` — `.modal-*` 클래스

**기능 2 — verify 자동 수정-루프**
- Modify: `src/main/core/orchestrator/review.ts` — `buildVerifyFixPrompt`
- Modify: `src/main/core/orchestrator/review.test.ts` — 프롬프트 테스트 (없으면 생성)
- Modify: `src/main/core/orchestrator/orchestrator.ts` — `maxVerifyFixRounds`, 아티팩트 원장, 수정-루프
- Modify: `src/main/core/orchestrator/orchestrator.test.ts` — 수정-루프 테스트

---

## Task 1: 승인 IPC 브리지 (순수 모듈)

**Files:**
- Create: `src/main/core/safety/approval-bridge.ts`
- Test: `src/main/core/safety/approval-bridge.test.ts`

> 참고: `APPROVAL_TIMEOUT_MS`는 Task 2에서 `shared/types.ts`에 추가한다. 이 태스크를 먼저 실행하려면 import가 미해결이므로, **Task 2의 Step 1(상수 추가)을 먼저 수행**하거나 이 태스크에서 함께 추가하라. 아래 Step 1에 상수 추가를 포함한다.

- [ ] **Step 1: `shared/types.ts`에 타임아웃 상수 추가 (브리지 의존)**

`src/shared/types.ts`의 `export type ApprovalDecision = 'approved' | 'rejected'` 바로 다음 줄에 추가:

```ts
/** destructive 승인 무응답 시 자동 거부까지의 시간(메인 측 권위 + 렌더러 카운트다운 공용). */
export const APPROVAL_TIMEOUT_MS = 60_000
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/main/core/safety/approval-bridge.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../../shared/types'
import { createIpcApprover } from './approval-bridge'

const req = (id: string): ApprovalRequest => ({
  id,
  kind: 'file-write',
  summary: 's',
  target: 't',
  risk: 'destructive',
  ts: 1,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createIpcApprover', () => {
  it('rejects immediately when no window is available, without sending', async () => {
    const send = vi.fn()
    const a = createIpcApprover({ send, hasWindow: () => false })
    expect(await a.approver(req('1'))).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the request and resolves with the approval decision', async () => {
    const send = vi.fn()
    const a = createIpcApprover({ send, hasWindow: () => true })
    const p = a.approver(req('1'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.pendingCount()).toBe(1)
    a.resolve('1', true)
    expect(await p).toBe(true)
    expect(a.pendingCount()).toBe(0)
  })

  it('resolves with rejection when the user rejects', async () => {
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
    const p = a.approver(req('1'))
    a.resolve('1', false)
    expect(await p).toBe(false)
  })

  it('auto-rejects after the timeout elapses', async () => {
    vi.useFakeTimers()
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true, timeoutMs: 1000 })
    const p = a.approver(req('1'))
    vi.advanceTimersByTime(1000)
    expect(await p).toBe(false)
    expect(a.pendingCount()).toBe(0)
  })

  it('ignores responses for unknown or already-settled requests', async () => {
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
    a.resolve('nope', true) // 미존재 — throw 없이 무시
    const p = a.approver(req('1'))
    a.resolve('1', true)
    a.resolve('1', false) // 이미 해소 — 무시
    expect(await p).toBe(true)
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test -- approval-bridge`
Expected: FAIL — `createIpcApprover`를 `./approval-bridge`에서 찾을 수 없음.

- [ ] **Step 4: 구현 작성**

`src/main/core/safety/approval-bridge.ts`:

```ts
import { APPROVAL_TIMEOUT_MS } from '../../../shared/types'
import type { ApprovalRequest } from '../../../shared/types'

export interface IpcApproverOptions {
  /** 렌더러로 승인 요청 방출(브로드캐스트). */
  send: (req: ApprovalRequest) => void
  /** 응답 가능한 창이 있는지. 없으면 즉시 거부(안전 기본값). */
  hasWindow: () => boolean
  /** 무응답 자동 거부까지(ms). 기본 APPROVAL_TIMEOUT_MS. */
  timeoutMs?: number
}

export interface IpcApprover {
  /** ApprovalGate.approver 로 주입할 콜백. */
  approver: (req: ApprovalRequest) => Promise<boolean>
  /** 렌더러 회신을 해소한다. 미존재/이미 해소 id 는 무시(idempotent). */
  resolve: (id: string, approved: boolean) => void
  /** 대기 중 요청 수(테스트/진단용). */
  pendingCount: () => number
}

interface Pending {
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * destructive 승인 요청을 렌더러로 보내고 회신을 id 로 상관한다.
 * 창이 없으면 즉시 거부, 무응답이면 타임아웃 후 거부(안전 기본값). Electron 비의존(순수).
 */
export function createIpcApprover(opts: IpcApproverOptions): IpcApprover {
  const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS
  const pending = new Map<string, Pending>()

  return {
    approver(req) {
      if (!opts.hasWindow()) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(req.id)) return
          pending.delete(req.id)
          resolve(false)
        }, timeoutMs)
        // 대기 타이머가 프로세스 종료를 막지 않도록 unref(있을 때만 — fake timer 호환).
        if (typeof timer === 'object' && timer && 'unref' in timer) {
          ;(timer as { unref: () => void }).unref()
        }
        pending.set(req.id, { resolve, timer })
        opts.send(req)
      })
    },

    resolve(id, approved) {
      const p = pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(id)
      p.resolve(approved)
    },

    pendingCount() {
      return pending.size
    },
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test -- approval-bridge`
Expected: PASS (5 tests).

---

## Task 2: 공유 계약 + preload 브리지

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`

> `FleetBridge`에 메서드를 추가하면 `preload`의 `const api: FleetBridge`가 구현하지 않는 한 typecheck가 깨진다. 두 변경을 한 태스크로 묶어 typecheck를 그린으로 유지한다.

- [ ] **Step 1: `FleetBridge`에 승인 메서드 추가**

`src/shared/types.ts`의 `FleetBridge` 인터페이스에서 `onChatStream(callback: ...): () => void` 다음 줄(인터페이스 닫기 `}` 직전)에 추가:

```ts
  /** destructive 작업 승인 요청 구독 (해제 함수 반환). */
  onApprovalRequest(callback: (req: ApprovalRequest) => void): () => void
  /** 승인 모달 결정 회신(메인이 id 로 상관). */
  respondApproval(id: string, approved: boolean): Promise<void>
```

(`ApprovalRequest`는 동일 파일에 이미 정의되어 있으므로 import 불필요.)

- [ ] **Step 2: preload에 구현 추가**

`src/preload/index.ts` 1행 import에 `ApprovalRequest`를 추가:

```ts
import type { ApprovalRequest, ChatStreamEvent, FleetBridge, OrchestratorEvent } from '../shared/types'
```

`onChatStream` 구현 블록(파일 내 마지막 메서드) 다음, 객체 닫기 `}` 직전에 추가:

```ts
  onApprovalRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, req: ApprovalRequest): void => callback(req)
    ipcRenderer.on('fleet:approval:request', listener)
    return () => {
      ipcRenderer.removeListener('fleet:approval:request', listener)
    }
  },
  respondApproval: (id, approved) => ipcRenderer.invoke('fleet:approval:respond', id, approved),
```

- [ ] **Step 3: 타입 체크 통과 확인**

Run: `npm run typecheck`
Expected: PASS (node + web 둘 다 에러 없음).

- [ ] **Step 4: 기존 테스트 회귀 없음 확인**

Run: `npm test`
Expected: PASS (기존 180 tests 유지).

---

## Task 3: 메인 프로세스 배선 (approver 주입 + 응답 핸들러)

**Files:**
- Modify: `src/main/index.ts`

> 이 파일은 electron 의존이라 단위 테스트하지 않는다. typecheck + build(smoke)로 검증한다. `ipcApprover`는 engine(approver)과 IPC 응답 핸들러가 공유해야 하므로 `buildEngine`이 둘 다 반환하도록 바꾼다.

- [ ] **Step 1: import 추가**

`src/main/index.ts`의 import 영역에서 `'../shared/types'` 타입 import에 `ApprovalRequest`를 추가하고, 브리지 모듈 import를 추가한다:

```ts
import type {
  AgentRole,
  ApiProviderConfig,
  ApprovalRequest,
  AppInfo,
  ChatStreamEvent,
  OrchestratorEvent,
  RunProjectRequest,
} from '../shared/types'
import { createFleetEngine, type FleetEngine } from './core/engine'
import { createIpcApprover, type IpcApprover } from './core/safety/approval-bridge'
import { createJsonFileStore } from './core/store/json-file'
```

- [ ] **Step 2: 요청 브로드캐스트 함수 추가**

`broadcastChatStream` 함수 다음에 추가:

```ts
function broadcastApprovalRequest(req: ApprovalRequest): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:approval:request', req)
  }
}
```

- [ ] **Step 3: `buildEngine`이 approver 주입 + ipcApprover 반환**

기존 `buildEngine`을 다음으로 교체:

```ts
function buildEngine(): { engine: FleetEngine; ipcApprover: IpcApprover } {
  const store = createJsonFileStore(join(app.getPath('userData'), 'fleet'))
  const ipcApprover = createIpcApprover({
    send: broadcastApprovalRequest,
    hasWindow: () => BrowserWindow.getAllWindows().length > 0,
  })
  const engine = createFleetEngine({
    store,
    onOrchestratorEvent: broadcastOrchestratorEvent,
    onChatStream: broadcastChatStream,
    approver: ipcApprover.approver,
  })
  return { engine, ipcApprover }
}
```

- [ ] **Step 4: `registerIpc`가 ipcApprover를 받아 응답 핸들러 등록**

`registerIpc` 시그니처를 바꾸고, 함수 끝의 `// 감사` 블록 다음(닫기 `}` 직전)에 핸들러를 추가:

```ts
function registerIpc(engine: FleetEngine, ipcApprover: IpcApprover): void {
```

```ts
  // 감사
  ipcMain.handle('fleet:events:list', () => engine.listEvents())

  // 안전 / 승인 — 렌더러 모달 결정 회신을 id 로 상관 해소.
  ipcMain.handle('fleet:approval:respond', (_e, id: string, approved: boolean) => {
    ipcApprover.resolve(id, approved)
  })
}
```

- [ ] **Step 5: 부팅부에서 새 시그니처로 호출**

`app.whenReady().then(...)` 안의 `registerIpc(buildEngine())` 줄을 교체:

```ts
  const { engine, ipcApprover } = buildEngine()
  registerIpc(engine, ipcApprover)
  createWindow()
```

- [ ] **Step 6: 타입 체크 + 빌드 스모크**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS (main/preload/renderer 번들 생성 성공).

---

## Task 4: 승인 모달 컴포넌트 + 마운트 + 스타일

**Files:**
- Create: `src/renderer/components/ApprovalModal.tsx`
- Test: `src/renderer/components/ApprovalModal.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/components/ApprovalModal.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../shared/types'
import { ApprovalModal } from './ApprovalModal'

function mockFleet() {
  let handler: ((req: ApprovalRequest) => void) | undefined
  const respondApproval = vi.fn().mockResolvedValue(undefined)
  const fleet = {
    onApprovalRequest: vi.fn((cb: (req: ApprovalRequest) => void) => {
      handler = cb
      return () => {
        handler = undefined
      }
    }),
    respondApproval,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return {
    fire: (req: ApprovalRequest) => act(() => handler?.(req)),
    respondApproval,
  }
}

const REQ: ApprovalRequest = {
  id: 'req-1',
  kind: 'file-write',
  summary: '파일 쓰기: config/.env',
  target: '/ws/config/.env',
  risk: 'destructive',
  ts: 1,
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('ApprovalModal', () => {
  it('renders nothing until a request arrives', () => {
    mockFleet()
    const { container } = render(<ApprovalModal />)
    expect(container.querySelector('.modal-overlay')).toBeNull()
  })

  it('shows the request summary and target when one arrives', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    expect(screen.getByText('파일 쓰기: config/.env')).toBeTruthy()
    expect(screen.getByText('/ws/config/.env')).toBeTruthy()
  })

  it('approves and dequeues on the 승인 button', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.click(screen.getByRole('button', { name: '승인' }))
    expect(respondApproval).toHaveBeenCalledWith('req-1', true)
    expect(screen.queryByRole('button', { name: '승인' })).toBeNull()
  })

  it('rejects on the 거부 button', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.click(screen.getByRole('button', { name: '거부' }))
    expect(respondApproval).toHaveBeenCalledWith('req-1', false)
  })

  it('shows queued requests one at a time', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fire({ ...REQ, id: 'req-2', summary: '파일 쓰기: secret.pem', target: '/ws/secret.pem' })
    expect(screen.getByText('파일 쓰기: config/.env')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '승인' }))
    expect(respondApproval).toHaveBeenCalledWith('req-1', true)
    expect(screen.getByText('파일 쓰기: secret.pem')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- ApprovalModal`
Expected: FAIL — `ApprovalModal`을 `./ApprovalModal`에서 찾을 수 없음.

- [ ] **Step 3: 컴포넌트 구현**

`src/renderer/components/ApprovalModal.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { APPROVAL_TIMEOUT_MS } from '../../shared/types'
import type { ApprovalRequest, RiskLevel } from '../../shared/types'

const RISK_LABEL: Record<RiskLevel, string> = {
  safe: '안전',
  caution: '주의',
  destructive: '위험',
}

/** destructive 작업 승인 모달. App 레벨에 상시 마운트되어 메인의 승인 요청을 큐로 순차 처리한다. */
export function ApprovalModal() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const [remaining, setRemaining] = useState(0)

  // 승인 요청 구독 — 마운트 1회. 들어온 요청을 큐 뒤에 적재.
  useEffect(() => {
    const unsub = window.fleet.onApprovalRequest((req) => setQueue((prev) => [...prev, req]))
    return unsub
  }, [])

  const current = queue[0]

  // 현재 요청 전환 시 카운트다운 리셋(시각 표시 전용 — 실제 자동 거부는 메인 측 권위).
  useEffect(() => {
    if (!current) return
    setRemaining(Math.ceil(APPROVAL_TIMEOUT_MS / 1000))
    const iv = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000)
    return () => clearInterval(iv)
  }, [current?.id])

  if (!current) return null

  const decide = (approved: boolean): void => {
    void window.fleet.respondApproval(current.id, approved)
    setQueue((prev) => prev.slice(1))
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="panel modal-card">
        <div className="panel-head">
          <span className="eyebrow">승인 필요</span>
          <h2 className="panel-title">위험 작업 승인</h2>
          <div className="right">
            <span className="chip" style={{ color: 'var(--bad)', borderColor: 'currentColor' }}>
              {RISK_LABEL[current.risk]}
            </span>
          </div>
        </div>
        <p className="modal-summary">{current.summary}</p>
        <p className="modal-target">{current.target}</p>
        <div className="modal-actions">
          <span className="modal-countdown">{remaining}s 후 자동 거부</span>
          <button className="btn btn-danger" onClick={() => decide(false)}>
            거부
          </button>
          <button className="btn" onClick={() => decide(true)}>
            승인
          </button>
        </div>
        {queue.length > 1 && <p className="modal-pending">대기 중 {queue.length - 1}건</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- ApprovalModal`
Expected: PASS (5 tests).

- [ ] **Step 5: App에 상시 마운트**

`src/renderer/App.tsx` 상단 import에 추가:

```tsx
import { ApprovalModal } from './components/ApprovalModal'
```

`{info && ( ... </footer> )}` 블록 다음, 루트 `</div>` 직전에 추가:

```tsx
      <ApprovalModal />
    </div>
  )
}
```

- [ ] **Step 6: 모달 스타일 추가**

`src/renderer/styles.css` 맨 끝(파일 마지막 줄 뒤)에 추가:

```css
/* ── 승인 모달 ─────────────────────────────────────────────────────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(5, 6, 8, 0.72);
  backdrop-filter: blur(3px);
  animation: fadeUp 0.2s ease both;
}
.modal-card {
  width: 100%;
  max-width: 480px;
  border-color: rgba(255, 111, 111, 0.4);
  box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 111, 111, 0.16);
}
.modal-summary {
  font-size: 14px;
  color: var(--text);
  margin: 0 0 6px;
}
.modal-target {
  font-size: 12px;
  color: var(--dim);
  word-break: break-all;
  margin: 0;
}
.modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}
.modal-countdown {
  margin-right: auto;
  font-size: 11px;
  color: var(--faint);
}
.modal-pending {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--faint);
}
```

- [ ] **Step 7: 렌더러 테스트 + 빌드 회귀 확인**

Run: `npm test`
Expected: PASS (기존 + ApprovalModal 5).

Run: `npm run build`
Expected: PASS (App에 모달 포함되어 번들 성공).

---

## Task 5: verify 수정 프롬프트 빌더

**Files:**
- Modify: `src/main/core/orchestrator/review.ts`
- Test: `src/main/core/orchestrator/review.test.ts` (없으면 생성)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/main/core/orchestrator/review.test.ts`에 추가(파일이 없으면 아래로 생성):

```ts
import { describe, expect, it } from 'vitest'
import type { VerificationResult } from '../../../shared/types'
import { buildVerifyFixPrompt } from './review'

const fail = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  kind: 'test',
  command: 'npm test',
  passed: false,
  exitCode: 1,
  stdout: '',
  stderr: 'boom',
  analysis: 'AssertionError: x !== y',
  durationMs: 1,
  ...over,
})

describe('buildVerifyFixPrompt', () => {
  it('includes goal, failure analysis, and current artifacts', () => {
    const artifacts = new Map<string, string>([['src/a.ts', 'export const x = 1']])
    const prompt = buildVerifyFixPrompt('할 일 앱', [fail()], artifacts)
    expect(prompt).toContain('할 일 앱')
    expect(prompt).toContain('AssertionError: x !== y')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('export const x = 1')
    expect(prompt).toContain('```file:')
  })

  it('falls back to stderr when analysis is absent', () => {
    const prompt = buildVerifyFixPrompt('g', [fail({ analysis: undefined, stderr: 'STDERR-LINE' })], new Map())
    expect(prompt).toContain('STDERR-LINE')
    expect(prompt).toContain('(기록된 파일 없음)')
  })

  it('truncates oversized artifact content', () => {
    const big = 'A'.repeat(20_000)
    const prompt = buildVerifyFixPrompt('g', [fail()], new Map([['big.txt', big]]))
    expect(prompt).toContain('…(절단)')
    expect(prompt.length).toBeLessThan(big.length)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- review`
Expected: FAIL — `buildVerifyFixPrompt`가 export되지 않음.

- [ ] **Step 3: 구현 추가**

`src/main/core/orchestrator/review.ts` 1행에 타입 import 추가:

```ts
import type { VerificationResult } from '../../../shared/types'
```

파일 끝에 추가:

```ts
const FIX_DETAIL_CAP = 2_000
const FIX_ARTIFACTS_CAP = 12_000

/**
 * verify 실패 → implementer 재구현 프롬프트(요구사항 5 후속).
 * 실패한 검증의 분석(없으면 stderr)과 현재 워크스페이스 파일 내용(총량 상한)을 실어,
 * 교정본 전체를 ```file:상대경로``` 형식으로 출력하도록 요청한다.
 */
export function buildVerifyFixPrompt(
  goal: string,
  failures: ReadonlyArray<VerificationResult>,
  artifacts: ReadonlyMap<string, string>,
): string {
  const failBlock = failures
    .map((f) => {
      const detail = (f.analysis ?? f.stderr ?? '').slice(0, FIX_DETAIL_CAP)
      return `- [${f.kind}] ${f.command}\n  ${detail.replace(/\n/g, '\n  ')}`
    })
    .join('\n')

  let budget = FIX_ARTIFACTS_CAP
  const artBlocks: string[] = []
  for (const [path, content] of artifacts) {
    if (budget <= 0) {
      artBlocks.push(`\`\`\`file:${path}\n…(생략: 길이 초과)\n\`\`\``)
      continue
    }
    const slice = content.slice(0, budget)
    const body = slice.length < content.length ? `${slice}\n…(절단)` : slice
    budget -= slice.length
    artBlocks.push(`\`\`\`file:${path}\n${body}\n\`\`\``)
  }
  const artText = artBlocks.length > 0 ? artBlocks.join('\n') : '(기록된 파일 없음)'

  return [
    `프로젝트 목표:\n${goal}`,
    '',
    '검증(verify)이 실패했다. 아래 실패를 모두 해결하라:',
    failBlock,
    '',
    '현재 워크스페이스 파일:',
    artText,
    '',
    '수정된 파일 전체를 다음 형식의 코드펜스로 출력하라(워크스페이스 상대경로):',
    '```file:상대/경로.ext\n<파일 전체 내용>\n```',
  ].join('\n')
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- review`
Expected: PASS (3 tests).

---

## Task 6: 오케스트레이터 verify 자동 수정-루프

**Files:**
- Modify: `src/shared/types.ts` — `OrchestratorEventType`에 `verify.fixing`
- Modify: `src/main/core/orchestrator/orchestrator.ts`
- Test: `src/main/core/orchestrator/orchestrator.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/main/core/orchestrator/orchestrator.test.ts`의 마지막 `it(...)` 다음, `describe` 닫기 `})` 직전에 추가:

```ts
  it('re-implements and re-verifies when verification fails, then succeeds', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return ['구현', '```file:src/a.ts', `export const v = ${implCalls}`, '```'].join('\n')
      }),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const writes: Array<{ path: string; content: string }> = []
    const fileWriter = {
      async write(path: string, content: string) {
        writes.push({ path, content })
        return { ok: true, path }
      },
    }
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      fileWriter,
      verify: async () => {
        verifyCalls++
        const passed = verifyCalls >= 2 // 1차 실패, 2차(수정 후) 통과
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed,
            exitCode: passed ? 0 : 1,
            stdout: '',
            stderr: passed ? '' : 'boom',
            analysis: passed ? undefined : 'boom',
            durationMs: 1,
          },
        ]
      },
    })

    expect(verifyCalls).toBe(2) // 최초 + 수정 후 재검증 1회
    expect(implCalls).toBe(2) // 작업 구현 1 + 수정 1
    expect(writes).toHaveLength(2) // 작업 아티팩트 + 수정 아티팩트
    expect(result.verifications?.[0].passed).toBe(true)
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })

  it('marks the project failed when verify fixes are exhausted', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return ['구현', '```file:src/a.ts', 'export const v = 1', '```'].join('\n')
      }),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const fileWriter = { async write(path: string) {
      return { ok: true, path }
    } }
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      fileWriter,
      maxVerifyFixRounds: 2,
      verify: async () => {
        verifyCalls++
        return [
          { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', analysis: 'x', durationMs: 1 },
        ]
      },
    })

    expect(verifyCalls).toBe(3) // 최초 + 수정 2라운드 재검증
    expect(implCalls).toBe(3) // 작업 1 + 수정 2
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('does not attempt fixes when maxVerifyFixRounds is 0', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return '구현'
      }),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const fileWriter = { async write(path: string) {
      return { ok: true, path }
    } }
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      fileWriter,
      maxVerifyFixRounds: 0,
      verify: async () => {
        verifyCalls++
        return [
          { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', durationMs: 1 },
        ]
      },
    })

    expect(verifyCalls).toBe(1) // 수정 시도 없음
    expect(implCalls).toBe(1) // 작업 구현만
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- orchestrator`
Expected: FAIL — `maxVerifyFixRounds` 미지원으로 수정 루프가 돌지 않아 `verifyCalls`/`implCalls` 기대 불일치(첫 두 테스트).

- [ ] **Step 3: `OrchestratorEventType`에 `verify.fixing` 추가**

`src/shared/types.ts`의 `OrchestratorEventType` 유니온에서 `| 'verify.failed'` 다음 줄에 추가:

```ts
  | 'verify.fixing'
```

- [ ] **Step 4: review import에 빌더 추가**

`src/main/core/orchestrator/orchestrator.ts`의 review import 줄을 교체:

```ts
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, buildVerifyFixPrompt, parseReviewVerdict } from './review'
```

- [ ] **Step 5: `RunOptions`에 옵션 추가**

`RunOptions` 인터페이스의 `verify?: () => Promise<VerificationResult[]>` 다음 줄에 추가:

```ts
  /** verify 실패 시 implementer 재구현→재검증을 최대 N회 시도(기본 2, 0=비활성). */
  maxVerifyFixRounds?: number
```

- [ ] **Step 6: 아티팩트 원장 + writeArtifacts 일반화**

`const failed = new Set<string>()` 다음 줄에 원장을 추가:

```ts
  // verify 수정-루프가 implementer 에게 보여줄 '현재 워크스페이스 파일' 원장(성공 기록분 누적).
  const artifactLedger = new Map<string, string>()
```

기존 `writeArtifacts` 함수 전체(`const writeArtifacts = async (task: Task, output: string): Promise<void> => { ... }`)를 아래로 교체:

```ts
  /** 승인된 산출물의 파일 아티팩트를 워크스페이스에 기록하고 원장을 갱신한다(fileWriter 가 있을 때만). */
  const writeArtifacts = async (output: string, ctx: { taskId?: string }): Promise<void> => {
    const fw = opts.fileWriter
    if (!fw) return
    const arts = parseArtifacts(output)
    if (arts.length === 0) return
    const written: string[] = []
    const denied: string[] = []
    for (const a of arts) {
      try {
        const res = await fw.write(a.path, a.content)
        if (res.ok) {
          written.push(res.path)
          artifactLedger.set(a.path, a.content)
        } else {
          denied.push(`${a.path}(${res.reason ?? '거부'})`)
        }
      } catch (err) {
        denied.push(`${a.path}(${err instanceof Error ? err.message : String(err)})`)
      }
    }
    emit({
      type: 'task.artifacts',
      message: `파일 기록 ${written.length}개${denied.length ? `, 거부/실패 ${denied.length}개` : ''}`,
      data: { taskId: ctx.taskId, written, denied },
    })
  }
```

`runTask` 안의 호출부 `if (approved) await writeArtifacts(task, output)`를 교체:

```ts
      if (approved) await writeArtifacts(output, { taskId: task.id })
```

- [ ] **Step 7: verify 섹션을 수정-루프로 교체**

기존 `// ── 4) 검증 ...` 주석부터 `if (opts.verify) { ... }` 블록 끝(닫기 `}`)까지(현 247–268행 범위)를 아래로 교체. 그 다음의 `const verifyFailed = ...` / `store.updateProject` / `project.done` / `return` 은 그대로 둔다:

```ts
  // ── 4) 검증 + 자동 수정-루프 (요구사항 5 후속) ──
  // verify 실패 시 실패 분석 + 현재 아티팩트를 implementer 에 피드백해 교정본을 재구현·게이트경유 재기록하고
  // 재검증한다. 최대 maxVerifyFixRounds 회(기본 2, 0=비활성). implementer/fileWriter 없으면 루프 생략.
  let verifications: VerificationResult[] | undefined
  if (opts.verify) {
    const run = opts.verify
    const requestedFix = Math.floor(opts.maxVerifyFixRounds ?? 2)
    const maxFix = Number.isFinite(requestedFix) && requestedFix >= 0 ? requestedFix : 2
    store.updateProject(project.id, { status: 'verifying' })

    const verifyOnce = async (): Promise<VerificationResult[]> => {
      try {
        return await run()
      } catch (err) {
        emit({
          type: 'verify.failed',
          message: `검증 실행 오류: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id },
        })
        return []
      }
    }
    const emitVerify = (v: readonly VerificationResult[]): void => {
      if (v.length === 0) return // 실행 오류는 verifyOnce 가 이미 방출
      const ok = v.every((r) => r.passed)
      emit({
        type: ok ? 'verify.passed' : 'verify.failed',
        message: ok ? '검증 통과' : `검증 실패: ${v.filter((r) => !r.passed).map((r) => r.kind).join(', ')}`,
        data: { projectId: project.id },
      })
    }

    verifications = await verifyOnce()
    emitVerify(verifications)

    const fixImplementerId = resolveLlmForRole(assignments, 'implementer', 'implementer')
    const fixImplementer = fixImplementerId ? sessions.get(fixImplementerId) : undefined

    for (
      let round = 1;
      round <= maxFix && verifications.some((v) => !v.passed) && !!opts.fileWriter && !!fixImplementer;
      round++
    ) {
      const failing = verifications.filter((v) => !v.passed)
      emit({
        type: 'verify.fixing',
        message: `검증 실패 — 수정 시도 (라운드 ${round})`,
        data: { projectId: project.id, round },
      })
      try {
        const fixOutput = await fixImplementer.send(buildVerifyFixPrompt(goal, failing, artifactLedger), { fresh: true })
        await writeArtifacts(fixOutput, {})
      } catch (err) {
        emit({
          type: 'verify.fixing',
          message: `수정 실패: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id, round },
        })
        break
      }
      verifications = await verifyOnce()
      emitVerify(verifications)
    }
  }
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `npm test -- orchestrator`
Expected: PASS (기존 + 신규 3). 특히 기존 "runs verification..."/"marks the project failed when verification fails"(fileWriter 미주입 → 루프 생략)도 유지.

---

## Task 7: 전체 검증 게이트 + 단일 커밋

**Files:** (없음 — 검증/커밋만)

- [ ] **Step 1: 전체 테스트**

Run: `npm test`
Expected: PASS (기존 180 + approval-bridge 5 + ApprovalModal 5 + review 3 + orchestrator 3 ≈ 196).

- [ ] **Step 2: 타입 체크**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: 린트**

Run: `npm run lint`
Expected: PASS (에러 0).

- [ ] **Step 4: 빌드 스모크**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: 단일 커밋 (사용자 확인 후)**

> 사용자에게 커밋 진행 확인을 받은 뒤 실행. 스펙/계획 문서 + 전체 구현을 한 커밋으로 묶는다.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: 승인 모달 + verify 자동 수정-루프 — PR #5 후속

- 승인 모달: createIpcApprover(순수) 로 destructive 작업 IPC 왕복.
  무응답/창없음 → 타임아웃 자동 거부(안전 기본값). 렌더러 ApprovalModal 큐 순차 처리.
- verify 자동 수정-루프: 실패 분석 + 아티팩트 원장을 implementer 에 피드백,
  교정본 게이트경유 재기록 후 재검증(최대 2회). verify.fixing 이벤트.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 자체 검토 (스펙 대비)

- **스펙 §기능1 (승인 모달)** → Task 1(브리지)·2(계약/preload)·3(메인 배선)·4(모달/CSS). ✅
- **스펙 §기능2 (verify 수정-루프)** → Task 5(프롬프트)·6(루프/원장/옵션). ✅
- **공유 타입 변경** → Task 1 Step1(상수)·2 Step1(FleetBridge)·6 Step3(verify.fixing). ✅
- **테스트 계획 3종** → approval-bridge.test / ApprovalModal.test / orchestrator·review.test. ✅
- **검증 게이트** → Task 7. ✅
- **무응답/창없음 자동 거부** → Task 1 구현 + 테스트. ✅
- **최대 2회·0 비활성·NaN/음수→2** → Task 6 Step7 클램프 + Task 6 테스트(2회 소진/0 비활성). ✅
- **타입 일관성**: `createIpcApprover`/`IpcApprover`/`approver`/`resolve`/`pendingCount`, `buildVerifyFixPrompt(goal, failures, artifacts)`, `maxVerifyFixRounds`, `writeArtifacts(output, ctx)` — 태스크 간 동일 시그니처 사용 확인. ✅
- 플레이스홀더 없음(모든 코드/명령 구체화). ✅
