# #197 B4 — renderer 웹모드 배선 + Electron 표면 게이팅 + 웹 스모크 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브라우저에서 열린 Fleet UI 가 `window.fleet`(preload) 부재 시 ws-bridge(B2)로 폴백해 fleet-server(B3)와 대화하고, 재접속 시 스냅샷 권위로 재하이드레이션하며, Electron 전용 표면(자동 업데이트·footer)은 `AppInfo.runtime` 으로 게이팅한다. 웹 워크스페이스 경로 설정 채널(`fleet:workspace:set`)을 신설하고 playwright `web` 프로젝트로 브라우저 스모크(목표 입력→런 개시·리로드 복원·런 완주)를 게이트한다.

**Architecture:** 전송층 선택은 부팅 1회 — `main.tsx` 가 `window.fleet` 부재를 감지하면 `createWsBridge` 산출물을 `window.fleet` 에 주입한다(전 컴포넌트의 `window.fleet.*` 호출부 무변경). 재하이드레이션은 `HydrationProvider`(React context)가 ws-bridge 의 `onEventCursor`(재접속 hello)를 nonce 로 변환하고, 각 컴포넌트의 스냅샷 하이드레이션 effect 가 `[hydrateNonce]` deps 로 재실행된다 — **스냅샷은 권위(replace 시맨틱)**: 끊긴 사이 끝난 실행/스트림/busy 를 내릴 수 있어야 하므로 기존 merge(추가만)를 라이브-우선 가드(윈도우별 리셋)와 함께 replace 로 바꾼다. 데스크톱은 bridge=null → nonce 영구 0 → 기존 마운트 1회 시맨틱 그대로(무회귀).

**Tech Stack:** TypeScript(strict) · React 19 · ws-bridge(B2)/fleet-server(B3) 기존 착지물 · vitest(+jsdom·testing-library) · playwright(chromium 신규 프로젝트).

**설계 권위:** 이슈 #197 본문 B4 항목 + 체크포인트 2/2-R 종결 코멘트(잔여 노트 3·4 = B4 몫: task.progress UX 문구·update 스텁 shape 계약 테스트) + B2/B3 착지 코드 실측.

## Global Constraints

- **데스크톱 시맨틱 무회귀**: `runtime === 'electron'` 경로에서 관측 가능한 동작 변화 0. preload/main 에 추가되는 것은 `fleet:workspace:set` 1채널뿐이며 데스크톱에선 **fail-closed**(`FLEET_WORKSPACE_ROOT` 미설정 → throw · UI 도 미노출). 기존 e2e(electron 프로젝트) 전량 GREEN 유지.
- **3면 parity 유지**: 채널 신설은 매니페스트(`channels.ts`)·preload·ws-bridge·server 핸들러·fixtures 를 한 태스크에서 원자적으로 스윕한다 — `AssertExact`/`satisfies`/parity 테스트가 부분 적용을 컴파일·테스트 에러로 막으므로 쪼갤 수 없다.
- **update 스텁은 reject 금지**: ws-bridge desktop 전용 스텁은 no-op/idle(이미 B2 착지 — `getUpdateState()` → `{kind:'unsupported'}`). B4 는 이 shape 를 **계약 테스트로 핀**(체크포인트 2-R 노트 4 — undefined 반환 금지).
- **재접속 UX 문구**: 재접속 통지에 "실시간 진행 델타는 유실될 수 있으며 최종 상태는 스냅숏이 권위" 명시(체크포인트 2-R 노트 3).
- **웹 스모크는 loopback endpoint 한정**(이슈 B4 — B5 전 bind 게이트와 짝). e2e 서버는 `FLEET_PORT=0`(OS 배정)·`127.0.0.1`.
- **`FLEET_E2E === '1'` 엄격 핀** 유지(`isE2EActive` 재사용). 완주 러너는 e2e 활성 안에서만 `FLEET_E2E_RUNNER='complete'` 로 opt-in(기본 러너 hang 계약 무변경 — 데스크톱 e2e 가 의존).
- **per-request timeout 미설정**(IPC 동형 무제한) — `runProject`/`discuss` 는 수 분 pending 이 정당. 소켓 close 시 pending 전원 reject 가 연결 소실을 정리한다(B2 계약 주석 준수).
- **react-hooks 게이트**: `src/renderer/**/*.tsx` 는 `exhaustive-deps`/`set-state-in-effect` error — 신규/변경 effect 는 통과 필수, 기존 인라인 억제는 사유 주석과 함께만.
- **품질 게이트**: 매 태스크 끝 해당 테스트 GREEN, 최종 `npm run verify` GREEN. `src/` 변경 시 `npm run brain` 재생성(brain:check 강제).
- **컨벤션**: 주석 한국어·기존 밀도. 커밋 prefix `feat(#197-B4):`. 브랜치 `feat/197-b4-renderer-web`(master 직접 push 는 ruleset 차단).

## 파일 구조 (책임 지도)

```
src/main/core/workspace/set-workspace.ts   applyWorkspaceSet — 루트 한정(resolveWithin)·존재 디렉터리·런 중 거부 (+test)
src/shared/types.ts                        FleetBridge.setWorkspace(path) 추가
src/shared/transport/channels.ts           'fleet:workspace:set' 선언(kind invoke·scope both)
src/shared/transport/fixtures.ts           workspace:set fixture
src/preload/index.ts                       setWorkspace 리터럴 1줄
src/main/index.ts                          desktop 핸들러(fail-closed) — registerIpc 에 1핸들러
src/server/handlers.ts                     server 핸들러 + HandlerDeps.workspaceRoot
src/server/boot.ts                         workspaceRoot 전달 + e2e 러너 선택(resolveE2eRunner)
src/main/e2e.ts                            e2eCompletingRunner + resolveE2eRunner (+기존 test 확장)
src/renderer/bridge/ws-bridge.ts           setWorkspace 메서드 1줄
src/renderer/bridge/web-bridge.ts          브라우저 WebSocket→WsLike 어댑터 + window.fleet 폴백 주입 (+test)
src/renderer/bridge/errors.ts              describeError — TransportError UX 문구 (+test)
src/renderer/bridge/hydration.tsx          HydrationProvider·useHydration·ConnectionBanner (+test)
src/renderer/main.tsx                      initWebBridge + HydrationProvider 배선
src/renderer/App.tsx                       footer/UpdateBanner runtime 게이팅·runtime prop 전달·nonce deps (+App.test.tsx 신규)
src/renderer/components/ProjectPanel.tsx   activity replace 재하이드레이션·웹 워크스페이스 입력·reject audit
src/renderer/components/ChatPanel.tsx      하이드레이션 윈도우 리셋·유령 스트림/stale busy 정리·reject audit
src/renderer/components/SessionsPanel.tsx  업데이트 채널 섹션 게이팅·catch
src/renderer/components/ApprovalModal.tsx  respondApproval catch
src/renderer/components/UpdateBanner.tsx   getUpdateState/download/install/dismiss catch
e2e/web-server.ts                          out/server/index.mjs 스폰 + 포트 파싱 헬퍼
e2e/web-orchestration.web.e2e.ts           웹 스모크(개시→리로드 복원·오프라인 재접속·완주)
playwright.config.ts                       projects: electron / web(chromium)
package.json                               test:e2e 에 build:server 편입
.github/workflows/e2e.yml                  chromium 설치 스텝
```

### 사전 결정 5건 (체크포인트 4 리뷰 요청 포인트)

1. **주입 방식 = `window.fleet` 대입**(Context 주입 아님): renderer 40여 호출부가 전역 `window.fleet` 직접 참조(실측 — 브리지 진입점 부재). 호출부 무변경이 데스크톱 무회귀·diff 최소의 지배적 선택. Context 화는 전 컴포넌트 시그니처 변경으로 이득 없이 회귀 표면만 커진다.
2. **재하이드레이션 = 항상 전체(스냅샷 권위), 커서는 gap 통지용**: `listProjectEvents` 등에 since-커서 API 가 없어 "증분 재생"은 서버 비용이 전체 조회와 동일하다. 따라서 재접속 hello 마다 전체 재하이드레이션(= 체크포인트 2 §2 "커서<minRetained → 강제 전체 재하이드레이션"의 상위 안전 집합). `hasEventGap` 은 로그/통지 용도로만 소비한다. "seq≤커서 push 폐기 필터"는 **불필요가 실측 근거**: 서버는 push 를 재생하지 않고, 옛 소켓의 지연 push 는 ws-bridge stale-socket 가드(B2)가 이미 차단하며, 컴포넌트는 id(FleetEvent)·streamId+seq(chat) 멱등 가드를 이미 보유한다.
3. **재하이드레이션 = replace 시맨틱(기존 merge 에서 의도적 변경)**: 끊긴 사이 종료된 실행/스트림/busy 는 push 를 놓쳤으므로 merge(추가만)로는 영구 stale(유령 진행 표시)이 남는다. 라이브-우선 가드(ended/idled/liveStarted refs)를 하이드레이션 윈도우마다 리셋해 "윈도우 중 라이브가 아는 것 ∪ 스냅샷" 으로 대체한다. 데스크톱은 마운트 1회 윈도우라 기존과 동일 결과.
4. **`fleet:workspace:set` 은 scope both + 데스크톱 fail-closed**: preload 는 `const api: FleetBridge`(전체 구현 강제)·ipc-parity 는 preload↔main 리터럴 일치를 요구하므로 desktop 등록이 구조적으로 필요하다. 대신 공유 헬퍼 `applyWorkspaceSet` 이 `workspaceRoot === null → throw` 라 데스크톱(루트 env 미설정)에선 비활성 — dialog 경로 유일 유지, 표면 확장 없음. 서버측은 `resolveWithin`(#128 path-guard 재사용 — symlink 탈출 방어) + 존재 디렉터리 + **런 진행 중 거부**(서버측 가드 — UI disabled 는 보조).
5. **"런 완주" 스모크 = opt-in 완주 러너**: 기본 `e2eRunner` 는 의도적 영구 hang(데스크톱 e2e 가 in-flight 고정에 의존)이라 완주 불가. `FLEET_E2E_RUNNER='complete'` 일 때만 프롬프트 내용 기반 결정론 응답(플래너→단일 작업 JSON·리뷰→approved·그 외→고정 텍스트)을 주는 `e2eCompletingRunner` 를 **서버 boot 에만** 배선한다(데스크톱 main 무변경). 빈 diff 승인·무변경 keep·verify 없음(빈 워크스페이스) 경로로 `project.done` 까지 완주한다.

### `window.fleet.*` reject audit 전수표 (이슈 B4 · 체크포인트 2 §3)

| 호출부 | 현행 | 처분 (태스크) |
|---|---|---|
| App.tsx:24 `listSessions` | try/catch ✓ | 유지 (T5) |
| App.tsx:35 `getAppInfo` | `.catch` ✓ | 유지 |
| ProjectPanel:91 `listProjects` (마운트 IIFE·이벤트 핸들러 4곳·run) | **무처리** — reject 시 unhandled | 마운트 IIFE try/catch·핸들러는 `.catch(() => undefined)` (T7) |
| ProjectPanel:100 `getProjectTasks` (refreshTasks) | **무처리** | 이벤트 핸들러 발화부 `.catch(() => undefined)` (T7) |
| ProjectPanel:109 `getLastActiveProject` | **무처리** | 마운트 IIFE try/catch 로 흡수 (T7) |
| ProjectPanel:118 `getWorkspace` | `.catch` ✓ | 유지 |
| ProjectPanel:184 `getRunActivity` | **`.then` 무 catch** | 재작성 effect 에 `.catch` (T7) |
| ProjectPanel:198 `setLastActiveProject` | **무처리** | `.catch(() => undefined)` (T7) |
| ProjectPanel:202 `Promise.all(tasks,events)` | **무처리** | IIFE try/catch — 실패는 조용히(재접속 하이드레이션이 재시도) (T7) |
| ProjectPanel:229 `selectWorkspace` / 238 `cancelRun` / 255 `runProject` | catch ✓ | `describeError` 로 문구 승급 — 전송 유래를 "연산 실패"로 오인 금지 (T7) |
| ProjectPanel(신규) `setWorkspace` | — | try/catch + `describeError` (T7) |
| ChatPanel:76 `listRooms` / 83 `roomHistory` | `.catch` ✓ | 유지 |
| ChatPanel:174 `getChatActivity` | **`.then` 무 catch** | 재작성 effect 에 `.catch` (T8) |
| ChatPanel:235 `createRoom` / 246 `postUserMessage` | **무처리** | try/catch + `console.error` (T8) |
| ChatPanel:276 `askLlm` / 289 `discussRoom` / 305 `cancelChat` | catch ✓ | 유지 |
| SessionsPanel:34 `getUpdaterChannel` | **`.then` 무 catch** | `.catch(() => undefined)` (T6) |
| SessionsPanel:47/59/69/129 | catch ✓ | 유지 |
| SessionsPanel:82 `getMcpStatus` | `.catch` ✓ | 유지 |
| AddAiWizard 전 호출부(92·129·199·219·293·311·384) | catch ✓ (실측) | 유지 — 변경 없음 |
| ApprovalModal:37 `respondApproval` | **무처리 void** | `.catch(() => undefined)` — 유실 시 main/server 타임아웃 fail-closed 가 권위 (T9) |
| UpdateBanner:19 `getUpdateState` / 26·34·51 dismiss·download·install | **무처리** | `.catch(() => undefined)` — desktop 전용 표면 방어 (T6) |

---

### Task 0: 브랜치 + `applyWorkspaceSet` 코어 헬퍼

**Files:**
- Create: `src/main/core/workspace/set-workspace.ts`
- Test: `src/main/core/workspace/set-workspace.test.ts`

**Interfaces:**
- Consumes: `resolveWithin(root, p): string`(`src/main/core/workspace/path-guard.ts` — 루트 밖/링크 탈출 throw) · `node:fs statSync`.
- Produces: `applyWorkspaceSet(deps: WorkspaceSetDeps, path: string): string` — Task 1 의 desktop/server 핸들러 양쪽이 소비. `WorkspaceSetDeps = { workspaceRoot: string | null; isRunActive(): boolean; setWorkspace(dir: string): void }`. 반환 = 적용된 정준 절대경로.

- [ ] **Step 1: 브랜치 생성**

```bash
git checkout master && git pull && git checkout -b feat/197-b4-renderer-web
```

- [ ] **Step 2: 실패하는 테스트 작성**

```ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyWorkspaceSet, type WorkspaceSetDeps } from './set-workspace'

let root: string
let applied: string[]

function deps(over: Partial<WorkspaceSetDeps> = {}): WorkspaceSetDeps {
  return {
    workspaceRoot: root,
    isRunActive: () => false,
    setWorkspace: (dir) => applied.push(dir),
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-wsroot-'))
  mkdirSync(join(root, 'proj-a'))
  writeFileSync(join(root, 'file.txt'), 'x')
  applied = []
})

describe('applyWorkspaceSet(#197 B4)', () => {
  it('루트 하위 상대경로를 정준 절대경로로 적용·반환한다', () => {
    const r = applyWorkspaceSet(deps(), 'proj-a')
    expect(applied).toEqual([r])
    expect(r.toLowerCase()).toContain('proj-a')
  })

  it('루트 자기 자신("." )도 허용한다', () => {
    const r = applyWorkspaceSet(deps(), '.')
    expect(applied).toEqual([r])
  })

  it('루트 밖 절대경로 → throw(적용 없음)', () => {
    expect(() => applyWorkspaceSet(deps(), tmpdir())).toThrow(/밖/)
    expect(applied).toEqual([])
  })

  it('".." traversal → throw', () => {
    expect(() => applyWorkspaceSet(deps(), join('proj-a', '..', '..'))).toThrow()
    expect(applied).toEqual([])
  })

  it('미존재 경로 → throw', () => {
    expect(() => applyWorkspaceSet(deps(), 'nope')).toThrow(/디렉터리/)
  })

  it('디렉터리 아닌 파일 → throw', () => {
    expect(() => applyWorkspaceSet(deps(), 'file.txt')).toThrow(/디렉터리/)
  })

  it('런 진행 중 → 거부(경로 검증 이전)', () => {
    expect(() => applyWorkspaceSet(deps({ isRunActive: () => true }), 'proj-a')).toThrow(/실행 진행 중/)
    expect(applied).toEqual([])
  })

  it('루트 밖을 가리키는 링크(junction) 경유 탈출 → throw (체크포인트 4 가드레일)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-outside-'))
    try {
      symlinkSync(outside, join(root, 'esc'), 'junction') // win 은 junction — 권한 불요
    } catch {
      return // 링크 생성 불가 환경 — resolveWithin 자체의 path-guard.test 가 탈출 차단을 커버(best-effort)
    }
    expect(() => applyWorkspaceSet(deps(), 'esc')).toThrow()
    expect(applied).toEqual([])
  })

  it('workspaceRoot 미설정(null) → fail-closed throw (데스크톱 기본)', () => {
    expect(() => applyWorkspaceSet(deps({ workspaceRoot: null }), 'proj-a')).toThrow(/미설정/)
  })

  it('빈/공백 경로 → throw', () => {
    expect(() => applyWorkspaceSet(deps(), '   ')).toThrow(/비어/)
  })
})
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/main/core/workspace/set-workspace.test.ts` → FAIL(모듈 없음).

- [ ] **Step 4: 구현**

```ts
import { statSync } from 'node:fs'
import { resolveWithin } from './path-guard'

/**
 * `fleet:workspace:set`(#197 B4) 의 공유 시맨틱 — desktop main·fleet-server 핸들러가 함께 쓴다.
 * 웹 UI 의 경로 입력을 FLEET_WORKSPACE_ROOT 하위로 한정(resolveWithin — symlink/junction 탈출도
 * realpath 로 차단, #128 path-guard 재사용)하고, 존재하는 디렉터리만 허용한다. 런 진행 중 변경은
 * 거부한다 — UI disabled 는 보조일 뿐 이 서버측 가드가 권위(단, per-run worktree 격리는 Phase C —
 * 이 가드는 Fleet UI 경로만 막는 UI-level 완화임을 이슈 비범위 절이 명시).
 * workspaceRoot === null 은 fail-closed(데스크톱 기본 — dialog 선택 경로만 유지·표면 확장 없음).
 */
export interface WorkspaceSetDeps {
  /** 허용 루트(FLEET_WORKSPACE_ROOT). null = 경로 설정 미지원. */
  workspaceRoot: string | null
  isRunActive(): boolean
  setWorkspace(dir: string): void
}

export function applyWorkspaceSet(deps: WorkspaceSetDeps, path: string): string {
  if (!deps.workspaceRoot) {
    throw new Error('워크스페이스 경로 설정이 지원되지 않습니다(FLEET_WORKSPACE_ROOT 미설정).')
  }
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('워크스페이스 경로가 비어 있습니다.')
  }
  if (deps.isRunActive()) {
    throw new Error('실행 진행 중에는 워크스페이스를 변경할 수 없습니다.')
  }
  const resolved = resolveWithin(deps.workspaceRoot, path.trim())
  if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`존재하는 디렉터리가 아닙니다: ${path}`)
  }
  deps.setWorkspace(resolved)
  return resolved
}
```

- [ ] **Step 5: 통과 확인** — `npx vitest run src/main/core/workspace/set-workspace.test.ts` → PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/workspace/set-workspace.ts src/main/core/workspace/set-workspace.test.ts
git commit -m "feat(#197-B4): applyWorkspaceSet — 루트 한정·존재 디렉터리·런 중 거부 워크스페이스 설정 헬퍼"
```

---

### Task 1: `fleet:workspace:set` 채널 신설 — 6면 원자 스윕

**Files:**
- Modify: `src/shared/transport/channels.ts` · `src/shared/types.ts` · `src/shared/transport/fixtures.ts` · `src/preload/index.ts` · `src/main/index.ts` · `src/renderer/bridge/ws-bridge.ts` · `src/server/handlers.ts` · `src/server/boot.ts`
- Test: `src/server/handlers.test.ts`(describe 추가) — 3면 parity·직렬화·ipc-parity 는 기존 테스트가 자동 커버

**Interfaces:**
- Consumes: `applyWorkspaceSet`(Task 0) · `engine.getRunActivity(): RunActivity`(동기) · `engine.setWorkspace(dir)`.
- Produces: `FleetBridge.setWorkspace(path: string): Promise<string>` — Task 7 웹 UI 가 소비. server `HandlerDeps` 에 `workspaceRoot: string | null` 추가 — boot 이 전달.
- **원자성 주의**: 채널을 매니페스트에 넣는 순간 `BothInvokeChannel` 이 커져 `handlers.ts` 의 `AssertExact`·`fixtures.ts` 의 `satisfies` 가 컴파일 에러, parity 테스트 3종이 RED 가 된다. 이 태스크의 전 파일을 함께 바꾼 뒤에만 게이트가 GREEN — 중간 커밋 금지.

- [ ] **Step 1: 실패하는 서버 핸들러 테스트 작성** — `src/server/handlers.test.ts` 에 describe 추가(파일 상단에 `import { mkdirSync, mkdtempSync } from 'node:fs'` · `import { tmpdir } from 'node:os'` · `import { join } from 'node:path'` 보강, `build()` 에 `workspaceRoot` 인자 지원이 필요하면 `createHandlers({ engine, approver, appInfo, workspaceRoot })` 형태로 기존 build 를 확장):

```ts
describe('fleet:workspace:set(#197 B4)', () => {
  it('루트 하위 존재 디렉터리를 적용하고 정준 경로를 반환한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wsroot-'))
    mkdirSync(join(root, 'proj-a'))
    const { handlers, engine } = build({ workspaceRoot: root })
    const applied = await handlers['fleet:workspace:set']('proj-a')
    expect(engine.getWorkspace()).toBe(applied)
    expect(applied.toLowerCase()).toContain('proj-a')
  })

  it('루트 밖 경로는 거부한다(워크스페이스 무변경)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wsroot-'))
    const { handlers, engine } = build({ workspaceRoot: root })
    await expect(Promise.resolve(handlers['fleet:workspace:set'](tmpdir()))).rejects.toThrow()
    expect(engine.getWorkspace()).toBeNull()
  })

  it('workspaceRoot 미설정 서버는 fail-closed', async () => {
    const { handlers } = build({ workspaceRoot: null })
    await expect(Promise.resolve(handlers['fleet:workspace:set']('x'))).rejects.toThrow(/미설정/)
  })
})
```

(런 중 거부·traversal 상세는 Task 0 단위 테스트가 담당 — 여기선 위임·루트 배선만 검증.)

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/handlers.test.ts` → FAIL(채널 미존재로 타입/키 에러).

- [ ] **Step 3: 매니페스트 선언** — `channels.ts` 의 `'fleet:workspace:select': …` 다음 줄에 추가:

```ts
  // 웹 워크스페이스 경로 설정(#197 B4) — dialog 없는 웹의 selectWorkspace 대체 입력. 서버는
  // FLEET_WORKSPACE_ROOT 하위 한정 + 런 중 거부, 데스크톱 main 은 루트 env 미설정 시 fail-closed(비활성).
  'fleet:workspace:set': { kind: 'invoke', scope: 'both' },
```

- [ ] **Step 4: FleetBridge 계약** — `types.ts` 의 `selectWorkspace` 선언 바로 아래 추가:

```ts
  /**
   * 워크스페이스 경로 직접 설정(#197 B4 — 웹 UI 경로 입력). FLEET_WORKSPACE_ROOT 하위 한정·존재
   * 디렉터리만·런 진행 중 거부. 적용된 정준 절대경로를 반환한다. 데스크톱은 루트 env 미설정 시
   * reject(fail-closed — dialog 선택이 유일 경로).
   */
  setWorkspace(path: string): Promise<string>
```

- [ ] **Step 5: fixture** — `fixtures.ts` 의 `'fleet:workspace:select'` 다음 줄에 추가:

```ts
  'fleet:workspace:set': { args: ['proj-a'], result: '/srv/workspace/proj-a' },
```

- [ ] **Step 6: preload** — `src/preload/index.ts` 의 `selectWorkspace` 다음 줄에 추가:

```ts
  setWorkspace: (path) => ipcRenderer.invoke('fleet:workspace:set', path),
```

- [ ] **Step 7: desktop main 핸들러** — `src/main/index.ts` 상단 import 에 `import { applyWorkspaceSet } from './core/workspace/set-workspace'` 추가, `registerIpc` 의 `fleet:workspace:select` 핸들러 다음에:

```ts
  // 웹 UI 경로 설정 채널의 데스크톱 면(#197 B4) — preload/main 리터럴 parity 를 위해 등록하되,
  // 데스크톱 기본(FLEET_WORKSPACE_ROOT 미설정)에선 fail-closed 로 비활성이다(dialog 선택이 유일 경로 —
  // 사용자 매개 없는 임의 경로 설정 표면을 데스크톱에 열지 않는다).
  ipcMain.handle('fleet:workspace:set', (_e, path: string) =>
    applyWorkspaceSet(
      {
        workspaceRoot: process.env['FLEET_WORKSPACE_ROOT']?.trim() || null,
        isRunActive: () => engine.getRunActivity().activeProjectIds.length > 0,
        setWorkspace: (dir) => engine.setWorkspace(dir),
      },
      path,
    ),
  )
```

- [ ] **Step 8: ws-bridge** — `ws-bridge.ts` 의 `selectWorkspace: …` 다음 줄에 추가:

```ts
    setWorkspace: (path) => invoke<string>('fleet:workspace:set', path),
```

- [ ] **Step 9: server 핸들러 + boot 배선** — `handlers.ts`:
  - `ChannelMethodMap` 에 `'fleet:workspace:set': 'setWorkspace'` 추가(`'fleet:workspace:select': 'selectWorkspace'` 다음 줄).
  - 상단에 `import { applyWorkspaceSet } from '../main/core/workspace/set-workspace'` 추가.
  - `HandlerDeps` 에 필드 추가:

```ts
  /** FLEET_WORKSPACE_ROOT(정규화) — workspace:set 의 허용 루트. null = 경로 설정 미지원. */
  workspaceRoot: string | null
```

  - `createHandlers` 시그니처를 `({ engine, approver, appInfo, workspaceRoot }: HandlerDeps)` 로, 테이블의 `'fleet:workspace:select'` 다음에:

```ts
    // 웹 경로 설정(#197 B4) — FLEET_WORKSPACE_ROOT 하위 한정·존재 디렉터리·런 중 거부(applyWorkspaceSet).
    'fleet:workspace:set': (path) =>
      applyWorkspaceSet(
        {
          workspaceRoot,
          isRunActive: () => engine.getRunActivity().activeProjectIds.length > 0,
          setWorkspace: (dir) => engine.setWorkspace(dir),
        },
        path,
      ),
```

  - `boot.ts` 의 `createHandlers({ engine, approver: ipcApprover, appInfo })` 를 다음으로 교체(기존 workspaceRoot 검증·resolve 재사용):

```ts
  const handlers = createHandlers({
    engine,
    approver: ipcApprover,
    appInfo,
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : null,
  })
```

- [ ] **Step 10: 전 게이트 통과 확인**

```bash
npm run typecheck && npx vitest run src/server/handlers.test.ts src/main/bridge-parity.test.ts src/main/ipc-parity.test.ts src/shared/transport
```

Expected: 전부 PASS — parity 3면(매니페스트↔preload↔ws-bridge↔server 키)·직렬화 fixture 왕복·ipc-parity(preload↔main)가 신 채널을 자동 검증.

- [ ] **Step 11: 커밋**

```bash
git add src/shared/transport/channels.ts src/shared/types.ts src/shared/transport/fixtures.ts src/preload/index.ts src/main/index.ts src/renderer/bridge/ws-bridge.ts src/server/handlers.ts src/server/boot.ts src/server/handlers.test.ts
git commit -m "feat(#197-B4): fleet:workspace:set 채널 — 6면 스윕(루트 한정·런 중 거부·데스크톱 fail-closed)"
```

---

### Task 2: `web-bridge` — 브라우저 소켓 어댑터 + `window.fleet` 폴백 주입

**Files:**
- Create: `src/renderer/bridge/web-bridge.ts`
- Create: `src/renderer/bridge/errors.ts`
- Test: `src/renderer/bridge/web-bridge.test.ts` · `src/renderer/bridge/errors.test.ts`
- Modify: `src/renderer/main.tsx`(주입 배선 — Provider 는 Task 3 에서 함께)

**Interfaces:**
- Consumes: `createWsBridge`/`WsLike`/`WsBridge`/`TransportError`(ws-bridge — B2 착지).
- Produces:
  - `initWebBridge(win?: WebBridgeWindow, connect?: WsFactory): WsBridge | null` — `window.fleet` 존재(데스크톱)면 null·무변경, 부재면 ws-bridge 생성 후 `win.fleet` 주입. Task 3 의 `main.tsx`/Provider 가 소비.
  - `describeError(err: unknown): string` — Task 7/8 컴포넌트가 소비(TransportError ↔ 연산 실패 구분 문구).

- [ ] **Step 1: 실패하는 테스트 작성** — `web-bridge.test.ts`:

```ts
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import type { FleetBridge } from '../../shared/types'
import type { WsLike } from './ws-bridge'
import { initWebBridge, type WebBridgeWindow } from './web-bridge'

function fakeSocket(): WsLike & { sent: string[] } {
  return { sent: [], send(d: string) { this.sent.push(d) }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }
}

describe('initWebBridge(#197 B4)', () => {
  it('window.fleet 이 이미 있으면(데스크톱) no-op — null 반환·무변경', () => {
    const existing = { marker: true } as unknown as FleetBridge
    const win = { fleet: existing, location: { protocol: 'http:', host: 'x' } } as unknown as WebBridgeWindow
    expect(initWebBridge(win, () => fakeSocket())).toBeNull()
    expect(win.fleet).toBe(existing)
  })

  it('window.fleet 부재면 ws-bridge 를 생성해 주입한다', () => {
    const win = { location: { protocol: 'http:', host: 'x' } } as unknown as WebBridgeWindow
    const bridge = initWebBridge(win, () => fakeSocket())
    expect(bridge).not.toBeNull()
    expect(win.fleet).toBe(bridge!.fleet)
    expect(typeof win.fleet!.listSessions).toBe('function')
    bridge!.dispose()
  })

  it('기본 팩토리는 location 기반 ws(s) URL 로 브라우저 WebSocket 을 연다(어댑터 이벤트 전달)', () => {
    const instances: FakeWebSocket[] = []
    class FakeWebSocket {
      url: string
      onopen: (() => void) | null = null
      onmessage: ((ev: { data: unknown }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: ((e?: unknown) => void) | null = null
      constructor(url: string) { this.url = url; instances.push(this) }
      send = vi.fn()
      close = vi.fn()
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    try {
      const win = { location: { protocol: 'https:', host: 'fleet.example:8443' } } as unknown as WebBridgeWindow
      const bridge = initWebBridge(win)
      expect(instances[0]!.url).toBe('wss://fleet.example:8443/ws')
      bridge!.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
```

`errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TransportError } from './ws-bridge'
import { describeError } from './errors'

describe('describeError(#197 B4)', () => {
  it('전송 단절(disconnected/closed)은 "결과 미확인·자동 복원" 문구로', () => {
    expect(describeError(new TransportError('disconnected', 'x'))).toMatch(/재접속.*복원/)
    expect(describeError(new TransportError('closed', 'x'))).toMatch(/재접속.*복원/)
  })
  it('timeout 은 재시도 안내로', () => {
    expect(describeError(new TransportError('timeout', 'x'))).toMatch(/시간 초과/)
  })
  it('일반 Error 는 message 그대로', () => {
    expect(describeError(new Error('엔진 거부'))).toBe('엔진 거부')
  })
  it('비 Error 값은 String()', () => {
    expect(describeError('오류')).toBe('오류')
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/bridge/web-bridge.test.ts src/renderer/bridge/errors.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현** — `web-bridge.ts`:

```ts
import type { FleetBridge } from '../../shared/types'
import { createWsBridge, type WsBridge, type WsFactory, type WsLike } from './ws-bridge'

/**
 * 웹모드 폴백 배선(#197 B4) — preload 가 없는 배포(브라우저)에서 ws-bridge 를 window.fleet 로 주입한다.
 * renderer 호출부(40여 곳)는 전역 window.fleet 직접 참조라 이 주입 한 곳으로 전 표면이 전환된다
 * (데스크톱은 preload 가 이미 주입 → no-op·무회귀). per-request timeout 은 IPC 동형(무제한 — B2 계약:
 * runProject/discuss 는 수 분 pending 이 정당, 연결 소실은 close 시 pending 전원 reject 가 정리).
 */
export type WebBridgeWindow = Pick<Window, 'location'> & { fleet?: FleetBridge }

/** 브라우저 WebSocket → WsLike 어댑터. 프로퍼티 시그니처 차이(이벤트 인자)를 전달 클로저로 맞춘다. */
function browserSocket(url: string): WsLike {
  const ws = new WebSocket(url)
  const like: WsLike = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = () => like.onopen?.()
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data })
  ws.onclose = () => like.onclose?.()
  ws.onerror = (e) => like.onerror?.(e)
  return like
}

export function initWebBridge(
  win: WebBridgeWindow = window,
  connect?: WsFactory,
): WsBridge | null {
  if (win.fleet) return null // 데스크톱 — preload 브리지가 권위
  const proto = win.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const bridge = createWsBridge({
    connect: connect ?? (() => browserSocket(`${proto}//${win.location.host}/ws`)),
  })
  win.fleet = bridge.fleet
  return bridge
}
```

`errors.ts`:

```ts
import { TransportError } from './ws-bridge'

/**
 * 사용자 표시용 오류 문구(#197 B4 reject audit) — 전송층 유래(TransportError)를 "연산 실패"와
 * 구분한다. 단절 reject 는 연산의 성패 미상(서버에선 계속 진행 중일 수 있음) — 재접속 재하이드레이션이
 * RunActivity/ChatActivity 스냅샷으로 상태를 복원하므로 그 안내를 싣는다.
 */
export function describeError(err: unknown): string {
  if (err instanceof TransportError) {
    if (err.reason === 'timeout') {
      return '요청 시간 초과 — 서버 응답이 없습니다. 잠시 후 다시 시도하세요.'
    }
    return '서버 연결이 끊겨 결과를 확인하지 못했습니다 — 재접속되면 상태가 자동 복원됩니다.'
  }
  return err instanceof Error ? err.message : String(err)
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/bridge/web-bridge.test.ts src/renderer/bridge/errors.test.ts` → PASS.

- [ ] **Step 5: update 스텁 shape 계약 테스트**(체크포인트 2-R 노트 4) — `src/renderer/bridge/ws-bridge.test.ts` 에 describe 추가(기존 `makeBridge` 류 헬퍼가 있으면 재사용, 없으면 페이크 소켓으로 브리지 생성):

```ts
describe('desktop 전용 update 스텁 shape(#197 B4 — 체크포인트 2-R 노트 4)', () => {
  it('getUpdateState 는 undefined 가 아니라 unsupported UpdateEvent 를 반환한다', async () => {
    const { bridge } = makeBridge() // 기존 테스트 헬퍼 재사용
    await expect(bridge.fleet.getUpdateState()).resolves.toEqual({ kind: 'unsupported' })
    await expect(bridge.fleet.getUpdaterChannel()).resolves.toBe('stable')
    await expect(bridge.fleet.checkForUpdate()).resolves.toBeUndefined() // reject 아님
    expect(typeof bridge.fleet.onUpdateEvent(() => {})).toBe('function') // no-op 해제 함수
  })
})
```

Run: `npx vitest run src/renderer/bridge/ws-bridge.test.ts` → PASS(이미 B2 구현이 충족 — 계약 핀만 추가).

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/bridge/web-bridge.ts src/renderer/bridge/web-bridge.test.ts src/renderer/bridge/errors.ts src/renderer/bridge/errors.test.ts src/renderer/bridge/ws-bridge.test.ts
git commit -m "feat(#197-B4): web-bridge — window.fleet 부재 시 ws-bridge 폴백 주입 + describeError + update 스텁 shape 핀"
```

---

### Task 3: `HydrationProvider` — 재접속 nonce·전송 상태 컨텍스트 + `ConnectionBanner`

**Files:**
- Create: `src/renderer/bridge/hydration.tsx`
- Test: `src/renderer/bridge/hydration.test.tsx`
- Modify: `src/renderer/main.tsx`

**Interfaces:**
- Consumes: `WsBridge.onEventCursor/onConnectionState/connectionState`(B2) · `hasEventGap`(protocol).
- Produces (Task 5~8 이 소비):

```ts
export interface HydrationState {
  nonce: number                       // 0=최초 마운트 · 재접속 hello 마다 +1 (스냅샷 effect deps)
  connection: ConnectionState | null  // null=데스크톱(배너 미표시)
}
export function useHydration(): HydrationState
export const HydrationContext: React.Context<HydrationState> // 컴포넌트 테스트 주입용 export
export function HydrationProvider(props: { bridge: WsBridge | null; children: ReactNode }): JSX.Element
export function ConnectionBanner(): JSX.Element | null      // App 에 상시 마운트(웹 전용 표시)
```

- 시맨틱: 최초 hello 는 nonce 를 올리지 않는다(마운트 하이드레이션이 담당 — 이중 조회 방지). 이후 hello(재접속)마다 nonce+1 = 전체 재하이드레이션 트리거(사전 결정 2). 직전 커서와 `hasEventGap` 이면 `console.warn` 으로 gap 을 관측 가능하게 남긴다(rotation 손실 — 스냅샷 권위로 복구됨). 커서는 hello 의 `maxEventSeq` 와 라이브 `OrchestratorEvent.seq` 의 max 로 전진.

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WsBridge } from './ws-bridge'
import { ConnectionBanner, HydrationProvider, useHydration } from './hydration'

/** onEventCursor/onConnectionState 만 구동하는 페이크 브리지. */
function fakeBridge() {
  let cursorCb: ((c: { maxEventSeq: number; minRetainedEventSeq: number }) => void) | undefined
  let stateCb: ((s: 'connecting' | 'connected' | 'reconnecting' | 'closed') => void) | undefined
  const bridge = {
    fleet: { onOrchestratorEvent: vi.fn(() => () => {}) },
    onEventCursor: vi.fn((cb) => { cursorCb = cb; return () => { cursorCb = undefined } }),
    onConnectionState: vi.fn((cb) => { stateCb = cb; return () => { stateCb = undefined } }),
    getEventCursor: () => null,
    connectionState: () => 'connecting' as const,
    dispose: vi.fn(),
  } as unknown as WsBridge
  return {
    bridge,
    hello: (max: number, min = 1) => act(() => cursorCb?.({ maxEventSeq: max, minRetainedEventSeq: min })),
    setState: (s: 'connecting' | 'connected' | 'reconnecting' | 'closed') => act(() => stateCb?.(s)),
  }
}

function Probe() {
  const { nonce, connection } = useHydration()
  return <div data-testid="probe">{`n=${nonce} c=${connection ?? 'desktop'}`}</div>
}

describe('HydrationProvider(#197 B4)', () => {
  it('bridge=null(데스크톱): nonce 0 고정·connection null', () => {
    render(<HydrationProvider bridge={null}><Probe /></HydrationProvider>)
    expect(screen.getByTestId('probe').textContent).toBe('n=0 c=desktop')
  })

  it('최초 hello 는 nonce 를 올리지 않고, 재접속 hello 마다 +1', () => {
    const f = fakeBridge()
    render(<HydrationProvider bridge={f.bridge}><Probe /></HydrationProvider>)
    f.hello(10)
    expect(screen.getByTestId('probe').textContent).toContain('n=0')
    f.hello(20)
    expect(screen.getByTestId('probe').textContent).toContain('n=1')
    f.hello(30)
    expect(screen.getByTestId('probe').textContent).toContain('n=2')
  })

  it('gap(커서+1 < minRetained)이면 console.warn 으로 관측한다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeBridge()
    render(<HydrationProvider bridge={f.bridge}><Probe /></HydrationProvider>)
    f.hello(10) // 커서=10
    f.hello(50, 40) // 10+1 < 40 → gap
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('이벤트 gap'))
    warn.mockRestore()
  })

  it('connection 상태를 전파한다', () => {
    const f = fakeBridge()
    render(<HydrationProvider bridge={f.bridge}><Probe /></HydrationProvider>)
    f.setState('reconnecting')
    expect(screen.getByTestId('probe').textContent).toContain('c=reconnecting')
  })
})

describe('ConnectionBanner(#197 B4)', () => {
  it('데스크톱(null)에선 아무것도 렌더하지 않는다', () => {
    render(<HydrationProvider bridge={null}><ConnectionBanner /></HydrationProvider>)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reconnecting 이면 재접속 배너, closed 면 종료 배너', () => {
    const f = fakeBridge()
    render(<HydrationProvider bridge={f.bridge}><ConnectionBanner /></HydrationProvider>)
    f.setState('reconnecting')
    expect(screen.getByRole('status').textContent).toContain('재접속 중')
    f.setState('closed')
    expect(screen.getByRole('status').textContent).toContain('새로고침')
  })

  it('재접속 완료(nonce 증가) 후 스냅숏 권위·델타 유실 통지를 표시한다(체크포인트 2-R 노트 3)', () => {
    const f = fakeBridge()
    render(<HydrationProvider bridge={f.bridge}><ConnectionBanner /></HydrationProvider>)
    f.hello(10)
    f.setState('reconnecting')
    f.setState('connected')
    f.hello(20) // 재하이드레이션 트리거
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toContain('유실')
    expect(text).toContain('스냅숏')
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/bridge/hydration.test.tsx` → FAIL(모듈 없음).

- [ ] **Step 3: 구현** — `hydration.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { hasEventGap } from '../../shared/transport/protocol'
import type { ConnectionState, WsBridge } from './ws-bridge'

/**
 * 재하이드레이션 컨텍스트(#197 B4) — ws-bridge 의 재접속 hello(onEventCursor)를 세대 카운터(nonce)로
 * 변환한다. 각 패널의 스냅샷 하이드레이션 effect 가 [nonce] deps 로 재실행되며, 스냅샷은 권위
 * (replace 시맨틱 — 끊긴 사이 끝난 실행/스트림/busy 를 내린다). 데스크톱은 bridge=null → nonce 영구 0
 * (마운트 1회 시맨틱 무회귀). 재하이드레이션은 항상 전체 — 증분 재생은 since-커서 API 부재로 서버 비용이
 * 동일해 비범위(커서·hasEventGap 은 rotation 손실 관측 용도).
 */
export interface HydrationState {
  /** 재하이드레이션 세대 — 0=최초 마운트, 재접속 hello 마다 +1. 스냅샷 effect 의 deps 로 쓴다. */
  nonce: number
  /** 웹 전송 상태(데스크톱=null — 배너 미표시). */
  connection: ConnectionState | null
}

export const HydrationContext = createContext<HydrationState>({ nonce: 0, connection: null })

export function useHydration(): HydrationState {
  return useContext(HydrationContext)
}

export function HydrationProvider({
  bridge,
  children,
}: {
  bridge: WsBridge | null
  children: ReactNode
}) {
  const [state, setState] = useState<HydrationState>({
    nonce: 0,
    connection: bridge ? bridge.connectionState() : null,
  })

  useEffect(() => {
    if (!bridge) return
    // 클라이언트 이벤트 커서 — hello.maxEventSeq 와 라이브 영속 이벤트 seq 의 max 로 전진한다.
    let cursor: number | null = null
    const offLive = bridge.fleet.onOrchestratorEvent((e) => {
      if (typeof e.seq === 'number' && (cursor === null || e.seq > cursor)) cursor = e.seq
    })
    const offCursor = bridge.onEventCursor((hello) => {
      if (cursor === null) {
        cursor = hello.maxEventSeq // 최초 접속 — 마운트 하이드레이션이 담당(이중 조회 방지)
        return
      }
      if (hasEventGap(cursor, hello)) {
        // rotation 으로 증분 불가 구간 — 어차피 전체 재하이드레이션이라 복구되지만 관측은 남긴다.
        console.warn(`fleet: 재접속 이벤트 gap 감지(커서 ${cursor} < 보존 최소 ${hello.minRetainedEventSeq})`)
      }
      cursor = Math.max(cursor, hello.maxEventSeq)
      setState((s) => ({ ...s, nonce: s.nonce + 1 }))
    })
    const offState = bridge.onConnectionState((c) => setState((s) => ({ ...s, connection: c })))
    return () => {
      offLive()
      offCursor()
      offState()
    }
  }, [bridge])

  return <HydrationContext.Provider value={state}>{children}</HydrationContext.Provider>
}

/** 전송 상태 배너(웹 전용) — App 상시 마운트. 재접속 완료 후엔 스냅숏 권위 통지를 잠시 띄운다. */
export function ConnectionBanner() {
  const { connection, nonce } = useHydration()
  const [showRecovered, setShowRecovered] = useState(false)

  useEffect(() => {
    if (nonce === 0) return
    // 의도적 동기 setState: 재접속 세대 전환 통지의 즉시 표시(세대당 1회 추가 렌더·무해). 룰은 켜 두고 이 site 만 억제.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowRecovered(true)
    const t = setTimeout(() => setShowRecovered(false), 8000)
    return () => clearTimeout(t)
  }, [nonce])

  if (connection === null) return null // 데스크톱
  if (connection === 'reconnecting') {
    return (
      <div className="update-banner" role="status">
        서버 연결이 끊겼습니다 — 재접속 중…
      </div>
    )
  }
  if (connection === 'closed') {
    return (
      <div className="update-banner update-banner-error" role="status">
        서버 연결이 종료되었습니다 — 페이지를 새로고침하세요.
      </div>
    )
  }
  if (showRecovered) {
    return (
      <div className="update-banner" role="status">
        재접속됨 — 실시간 진행 델타는 유실될 수 있으며 최종 상태는 스냅숏이 권위입니다.
      </div>
    )
  }
  return null
}
```

- [ ] **Step 4: main.tsx 배선** — 전체를 다음으로 교체:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { HydrationProvider } from './bridge/hydration'
import { initWebBridge } from './bridge/web-bridge'
import './styles.css'

// 웹 배포(preload 부재)면 ws-bridge 를 window.fleet 로 주입 — 데스크톱은 no-op(null). #197 B4.
const webBridge = initWebBridge()

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <HydrationProvider bridge={webBridge}>
        <App />
      </HydrationProvider>
    </React.StrictMode>,
  )
}
```

- [ ] **Step 5: 통과 확인** — `npx vitest run src/renderer/bridge/hydration.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/bridge/hydration.tsx src/renderer/bridge/hydration.test.tsx src/renderer/main.tsx
git commit -m "feat(#197-B4): HydrationProvider — 재접속 hello→nonce 변환·gap 관측·ConnectionBanner(스냅숏 권위 통지)"
```

---

### Task 4: App — runtime 게이팅(footer·UpdateBanner)·ConnectionBanner·nonce 재하이드레이션

**Files:**
- Modify: `src/renderer/App.tsx`
- Test: `src/renderer/App.test.tsx`(신규)

**Interfaces:**
- Consumes: `useHydration`·`ConnectionBanner`(Task 3) · `AppInfo.runtime`.
- Produces: `SessionsPanel`/`ProjectPanel` 에 `runtime?: AppInfo['runtime'] | null` prop 전달(Task 5·7 이 수신 — prop 은 옵셔널·기본 null 이라 기존 테스트 무변경).

- [ ] **Step 1: 실패하는 테스트 작성** — `App.test.tsx`(ProjectPanel.test.tsx 의 mock 패턴 동형):

```tsx
/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

function mockFleet(runtime: 'electron' | 'web') {
  const fleet = {
    listSessions: vi.fn().mockResolvedValue([]),
    getAppInfo: vi.fn().mockResolvedValue({
      name: 'Fleet', version: '0.1.0', electron: '42.0.0', node: '24.0.0', chrome: '140', runtime,
    }),
    // App 하위 상시 마운트 컴포넌트(UpdateBanner·ApprovalModal)와 기본 탭(SessionsPanel) 표면
    onUpdateEvent: vi.fn(() => () => {}),
    getUpdateState: vi.fn().mockResolvedValue({ kind: 'idle' }),
    onApprovalRequest: vi.fn(() => () => {}),
    getUpdaterChannel: vi.fn().mockResolvedValue('stable'),
    getMcpStatus: vi.fn().mockResolvedValue([]),
    detectClis: vi.fn().mockResolvedValue([]),
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return fleet
}

async function renderSettled() {
  const r = render(<App />)
  await act(async () => {})
  return r
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('App runtime 게이팅(#197 B4)', () => {
  it('electron: footer 에 Electron/Node/Chrome, UpdateBanner 구독 활성', async () => {
    const fleet = mockFleet('electron')
    await renderSettled()
    expect(screen.getByText(/Electron 42\.0\.0/)).toBeTruthy()
    expect(fleet.onUpdateEvent).toHaveBeenCalled()
  })

  it('web: footer 는 Web/버전 표기, UpdateBanner 미마운트(구독 없음)', async () => {
    const fleet = mockFleet('web')
    await renderSettled()
    expect(screen.getByText(/Web/)).toBeTruthy()
    expect(screen.queryByText(/Electron/)).toBeNull()
    expect(fleet.onUpdateEvent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/App.test.tsx` → FAIL(web 케이스 — 게이팅 없음).

- [ ] **Step 3: App.tsx 수정** — 변경점 4곳:

(a) import 추가·hydration 소비:

```tsx
import { ConnectionBanner, useHydration } from './bridge/hydration'
```

함수 상단(`const [info, setInfo] = …` 다음)에:

```tsx
  const { nonce: hydrateNonce } = useHydration()
```

(b) 마운트 effect 를 재하이드레이션 겸용으로(deps 에 nonce):

```tsx
  useEffect(() => {
    // false-positive: refreshSessions 의 setSessions 는 await(IPC) 뒤에 실행돼 effect 본문 동기 setState 가 아니다.
    // 룰이 async/await 경계를 못 봐 호출부만 보고 플래그 — 룰은 켜 두고 이 site 만 명시 억제.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSessions()
    void window.fleet
      .getAppInfo()
      .then(setInfo)
      .catch(() => undefined)
    // hydrateNonce: 웹 재접속 시 세션/앱정보 스냅샷 재조회(#197 B4 — 데스크톱은 0 고정이라 마운트 1회).
  }, [refreshSessions, hydrateNonce])
```

(c) footer 를 runtime 분기로 교체:

```tsx
      {info && (
        <footer className="footer">
          {info.name}
          {info.runtime === 'web' ? (
            <>
              <span className="sep">/</span>Web
              <span className="sep">/</span>v{info.version}
            </>
          ) : (
            <>
              <span className="sep">/</span>Electron {info.electron}
              <span className="sep">/</span>Node {info.node}
              <span className="sep">/</span>Chrome {info.chrome}
            </>
          )}
        </footer>
      )}
```

(d) UpdateBanner 게이팅 + ConnectionBanner + runtime prop 전달:

```tsx
      {/* 자동 업데이트는 Electron 전용 표면 — runtime 확정(electron) 후에만 마운트한다(#197 B4).
          info 로드 전 마운트하면 웹에서도 구독(onUpdateEvent)이 발화해 게이팅이 무의미해진다.
          데스크톱은 info 도착(수 ms)까지 지연 마운트되지만 getUpdateState 스냅샷 하이드레이트가
          그 사이 상태를 복원하므로 시맨틱 무회귀. */}
      {info?.runtime === 'electron' && <UpdateBanner />}
      <ConnectionBanner />
      <ApprovalModal />
```

탭 렌더부는:

```tsx
          {tab === 'sessions' && (
            <SessionsPanel
              sessions={sessions}
              onRefresh={() => void refreshSessions()}
              runtime={info?.runtime ?? null}
            />
          )}
          {tab === 'project' && <ProjectPanel sessions={sessions} runtime={info?.runtime ?? null} />}
```

(`runtime` prop 은 Task 5·7 에서 수신 — 이 태스크에서는 두 패널의 Props 에 옵셔널 필드만 먼저 추가해 컴파일을 유지한다: `runtime?: 'electron' | 'web' | null`.)

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/App.test.tsx && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/App.tsx src/renderer/App.test.tsx src/renderer/components/SessionsPanel.tsx src/renderer/components/ProjectPanel.tsx
git commit -m "feat(#197-B4): App runtime 게이팅 — footer 웹 표기·UpdateBanner 마운트 게이트·ConnectionBanner·재접속 세션 재조회"
```

---

### Task 5: SessionsPanel·UpdateBanner — 게이팅·catch 마감

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx` · `src/renderer/components/UpdateBanner.tsx`
- Test: `src/renderer/components/SessionsPanel.test.tsx`(케이스 추가)

**Interfaces:**
- Consumes: `runtime` prop(Task 4) · `useHydration`(Task 3).

- [ ] **Step 1: 실패하는 테스트 작성** — `SessionsPanel.test.tsx` 에 추가(기존 mock 헬퍼 재사용):

```tsx
it('web 런타임에선 업데이트 채널 섹션을 렌더하지 않는다(#197 B4)', async () => {
  mockFleet()
  await renderSettled(<SessionsPanel sessions={[]} onRefresh={() => {}} runtime="web" />)
  expect(screen.queryByText('업데이트 채널')).toBeNull()
})

it('electron 런타임에선 업데이트 채널 섹션이 보인다', async () => {
  mockFleet()
  await renderSettled(<SessionsPanel sessions={[]} onRefresh={() => {}} runtime="electron" />)
  expect(screen.getByText('업데이트 채널')).toBeTruthy()
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/components/SessionsPanel.test.tsx` → FAIL(web 케이스).

- [ ] **Step 3: SessionsPanel 수정**
  - Props: `runtime?: 'electron' | 'web' | null` (Task 4 에서 추가됨 — 시그니처 구조분해에 `runtime = null` 기본값).
  - 채널 하이드레이션 effect(34행)에 catch + 재접속 deps:

```tsx
  useEffect(() => {
    void window.fleet
      .getUpdaterChannel()
      .then((c) => {
        channelHydrated.current = true
        if (!channelEdited.current) setChannel(c) // 사용자가 이미 토글했으면 늦은 하이드레이션 무시
      })
      .catch(() => undefined) // 전송 실패 — 표시 기본(stable) 유지, 다음 하이드레이션이 재시도
  }, [])
```

  - MCP 하이드레이트 effect 는 재접속 재조회 편입 — `useHydration` import 후 컴포넌트 상단 `const { nonce: hydrateNonce } = useHydration()`, 94행 effect deps 를 `[refreshMcpStatus, hydrateNonce]` 로.
  - 「05 — 업데이트」 섹션 렌더를 게이팅(웹에서 죽은 컨트롤 숨김 — 스텁은 동작하지만 무의미):

```tsx
      {runtime !== 'web' && (
        <section className="panel">
          … 기존 업데이트 채널 섹션 그대로 …
        </section>
      )}
```

- [ ] **Step 4: UpdateBanner catch 마감** — 14~23행 effect 와 액션 3곳:

```tsx
  useEffect(() => {
    const unsub = window.fleet.onUpdateEvent((e) => {
      liveReceivedRef.current = true
      setState(e)
    })
    void window.fleet
      .getUpdateState()
      .then((snap) => {
        if (!liveReceivedRef.current) setState(snap)
      })
      .catch(() => undefined) // IPC/전송 실패 — idle 유지(#197 B4 reject audit)
    return unsub
  }, [])
```

`dismiss`/다운로드/설치 버튼의 `void window.fleet.xxx()` 3곳을 `void window.fleet.xxx().catch(() => undefined)` 로.

- [ ] **Step 5: 통과 확인** — `npx vitest run src/renderer/components/SessionsPanel.test.tsx src/renderer/components/UpdateBanner.test.tsx && npm run lint` → PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx src/renderer/components/UpdateBanner.tsx
git commit -m "feat(#197-B4): SessionsPanel 업데이트 섹션 웹 게이팅 + MCP 재접속 재조회 + UpdateBanner reject 마감"
```

---

### Task 6: ChatPanel — 하이드레이션 윈도우 리셋·유령 정리(replace)·reject audit

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx`
- Test: `src/renderer/components/ChatPanel.test.tsx`(재접속 시나리오 추가)

**Interfaces:**
- Consumes: `useHydration`(Task 3) · `HydrationContext`(테스트 주입).

- [ ] **Step 1: 실패하는 테스트 작성** — `ChatPanel.test.tsx` 에 추가(기존 mockFleet/renderSettled 헬퍼 재사용, `HydrationContext.Provider` 로 nonce 를 제어):

```tsx
import { HydrationContext } from '../bridge/hydration'

function renderWithNonce(ui: React.ReactElement, nonce: number) {
  return render(
    <HydrationContext.Provider value={{ nonce, connection: 'connected' }}>{ui}</HydrationContext.Provider>,
  )
}

describe('재접속 재하이드레이션(#197 B4 — 스냅샷 권위 replace)', () => {
  it('끊긴 사이 idle 된 방의 stale busy 를 스냅샷이 내린다', async () => {
    const fleet = mockFleet({
      listRooms: vi.fn().mockResolvedValue([ROOM]),
      getChatActivity: vi
        .fn()
        .mockResolvedValueOnce({ busyRooms: [ROOM.id], streams: [] }) // 최초: busy
        .mockResolvedValue({ busyRooms: [], streams: [] }), // 재접속: idle 됐음
    })
    const { rerender } = renderWithNonce(<ChatPanel sessions={[S1, S2]} />, 0)
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'AI 토론 중…' })).toBeTruthy()
    // 재접속(nonce+1) → 스냅샷 재조회 → busy 해제
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected' }}>
        <ChatPanel sessions={[S1, S2]} />
      </HydrationContext.Provider>,
    )
    await act(async () => {})
    expect(screen.getByRole('button', { name: '🤖 AI 자동 토론' })).toBeTruthy()
  })

  it('끊긴 사이 종료된 라이브 스트림(유령 말풍선)을 스냅샷이 걷어낸다', async () => {
    const fleet = mockFleet({
      listRooms: vi.fn().mockResolvedValue([ROOM]),
      getChatActivity: vi.fn().mockResolvedValue({ busyRooms: [], streams: [] }),
    })
    const { rerender } = renderWithNonce(<ChatPanel sessions={[S1, S2]} />, 0)
    await act(async () => {})
    fleet.fire({ kind: 'start', streamId: 'st1', roomId: ROOM.id, llmId: S1.id })
    expect(screen.getByText(/응답 대기 중/)).toBeTruthy()
    // 재접속: 스냅샷에 st1 없음(끊긴 사이 end 유실) → 말풍선 제거
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected' }}>
        <ChatPanel sessions={[S1, S2]} />
      </HydrationContext.Provider>,
    )
    await act(async () => {})
    expect(screen.queryByText(/응답 대기 중/)).toBeNull()
  })

  it('재하이드레이션 윈도우 중 라이브 start 로 생긴 스트림은 보존한다(라이브 우선)', async () => {
    let resolveActivity!: (a: unknown) => void
    const fleet = mockFleet({
      listRooms: vi.fn().mockResolvedValue([ROOM]),
      getChatActivity: vi
        .fn()
        .mockResolvedValueOnce({ busyRooms: [], streams: [] })
        .mockImplementationOnce(() => new Promise((r) => (resolveActivity = r))), // 재접속 스냅샷은 지연
    })
    const { rerender } = renderWithNonce(<ChatPanel sessions={[S1, S2]} />, 0)
    await act(async () => {})
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected' }}>
        <ChatPanel sessions={[S1, S2]} />
      </HydrationContext.Provider>,
    )
    // 윈도우 중 라이브 start 도착 → 스냅샷(빈)이 나중에 resolve 돼도 보존돼야 한다
    fleet.fire({ kind: 'start', streamId: 'st-live', roomId: ROOM.id, llmId: S1.id })
    await act(async () => resolveActivity({ busyRooms: [], streams: [] }))
    expect(screen.getByText(/응답 대기 중/)).toBeTruthy()
  })
})
```

(`ROOM`/`S1`/`S2`/`fire` 는 기존 테스트 파일의 픽스처·헬퍼 이름에 맞춘다 — 파일에 이미 동형 픽스처가 있으면 재사용.)

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/components/ChatPanel.test.tsx` → FAIL(stale busy·유령 스트림 잔존).

- [ ] **Step 3: ChatPanel 수정**

(a) import·컨텍스트:

```tsx
import { useHydration } from '../bridge/hydration'
```

컴포넌트 상단(`const hydratedRef = …` 근처)에:

```tsx
  const { nonce: hydrateNonce } = useHydration()
  // 하이드레이션 윈도우 중 라이브로 도착한 busy 방 / start 스트림 — 스냅샷 replace 시 보존 대상(라이브 우선).
  const liveBusyRef = useRef<Set<string>>(new Set())
  const liveStartedStreamsRef = useRef<Set<string>>(new Set())
```

(b) onChatStream 핸들러 보강(구독 effect 는 `[]` 유지 — ws-bridge 가 재접속에도 리스너를 보존한다):
  - `start` 분기 첫 줄에: `if (!hydratedRef.current) liveStartedStreamsRef.current.add(e.streamId)`
  - `end`/`error` 분기의 `endedStreamsRef.current.add(e.streamId)` 다음에: `liveStartedStreamsRef.current.delete(e.streamId)`
  - `busy` 분기 첫 줄에: `if (!hydratedRef.current) liveBusyRef.current.add(e.roomId)`
  - `idle` 분기의 `idledRoomsRef.current.add(e.roomId)` 다음에: `liveBusyRef.current.delete(e.roomId)`

(c) 방 목록·메시지 재하이드레이션 — 73행 effect deps 를 `[hydrateNonce]` 로(억제 주석의 사유를 "마운트+웹 재접속 세대"로 갱신), 81행 effect deps 를 `[activeRoom, hydrateNonce]` 로.

(d) getChatActivity effect(173행) 전체 교체 — **윈도우 리셋 + replace 시맨틱**:

```tsx
  // 마운트·웹 재접속(hydrateNonce) 시 진행 상태 스냅샷 복원 — 스냅샷은 권위(replace). merge(추가만)면
  // 끊긴 사이 idle/end 된 방·스트림의 stale 진행 표시(유령 말풍선·영구 busy)가 남는다(#197 B4).
  // 라이브-우선 가드(ended/idled/liveBusy/liveStarted)와 델타 버퍼는 이 하이드레이션 윈도우 기준으로 리셋한다.
  useEffect(() => {
    hydratedRef.current = false
    endedStreamsRef.current = new Set()
    idledRoomsRef.current = new Set()
    liveBusyRef.current = new Set()
    liveStartedStreamsRef.current = new Set()
    pendingDeltasRef.current = {}
    pendingToolsRef.current = {}
    let cancelled = false
    window.fleet
      .getChatActivity()
      .then((a) => {
        if (cancelled) return // 더 새 하이드레이션 세대가 시작됨 — 이 스냅샷은 stale
        const pending = pendingDeltasRef.current
        pendingDeltasRef.current = {}
        const pendingTools = pendingToolsRef.current
        pendingToolsRef.current = {}
        hydratedRef.current = true
        setBusyRooms(() => {
          // replace: 윈도우 중 라이브 busy(liveBusyRef) ∪ 스냅샷 busy(윈도우 중 idle 된 방 제외).
          const next = new Set(liveBusyRef.current)
          for (const r of a.busyRooms) if (!idledRoomsRef.current.has(r)) next.add(r)
          return next
        })
        setStreams((prev) => {
          const merged: Record<string, StreamBubble> = {}
          // 윈도우 중 라이브 start 로 생긴 스트림만 보존 — 그 외 prev(재접속 전 잔존)는 스냅샷에 없으면
          // 끊긴 사이 종료된 유령이므로 폐기한다(스냅샷 권위 · 스냅샷에 있으면 아래 루프가 복원).
          for (const [id, s] of Object.entries(prev)) {
            if (liveStartedStreamsRef.current.has(id)) merged[id] = s
          }
          for (const s of a.streams) {
            if (s.streamId in merged) continue // 라이브가 이미 아는 스트림 — 덮어쓰지 않음
            if (endedStreamsRef.current.has(s.streamId)) continue // 윈도우 중 종료 — 되살리지 않음
            // 스냅샷(seq 까지 반영) + 윈도우 중 버퍼된 더 새로운 이벤트(seq>스냅샷)를 seq 순으로 재생.
            let { text, seq } = s
            const steps = [...s.steps]
            const buffered: ({ seq: number; delta: string } | { seq: number; step: ToolStep })[] = [
              ...(pending[s.streamId] ?? []),
              ...(pendingTools[s.streamId] ?? []),
            ].sort((x, y) => x.seq - y.seq)
            for (const ev of buffered) {
              if (ev.seq <= seq) continue
              if ('step' in ev) {
                const i = steps.findIndex((x) => x.id === ev.step.id)
                if (i >= 0) steps[i] = ev.step
                else steps.push(ev.step)
              } else {
                text += ev.delta
              }
              seq = ev.seq
            }
            merged[s.streamId] = { ...s, text, seq, steps }
          }
          return merged
        })
      })
      .catch((e) => console.error('채팅 활동 스냅샷 복원 실패', e)) // 재접속 하이드레이션이 재시도(#197 B4)
    return () => {
      cancelled = true
    }
    // hydrateNonce: 마운트 + 웹 재접속 세대 — 그 외 상태에 비의존(윈도우 리셋이 정확성 조건)이라 의도적 한정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateNonce])
```

(e) reject audit — `createRoom`/`postMessage` 를 try/catch 로:

```tsx
  async function createRoom() {
    const title = newRoomTitle.trim() || `작업방 ${rooms.length + 1}`
    try {
      const room = await window.fleet.createRoom(
        title,
        sessions.map((s) => s.id),
      )
      setNewRoomTitle('')
      await refreshRooms()
      setActiveRoom(room.id)
    } catch (e) {
      console.error('방 생성 실패', e) // 전송 단절 포함 — 재접속 후 재시도 가능(#197 B4 reject audit)
    }
  }

  async function postMessage() {
    if (!activeRoom || !text.trim()) return
    try {
      await window.fleet.postUserMessage(activeRoom, text.trim())
      setText('')
      await refreshMessages(activeRoom)
    } catch (e) {
      console.error('메시지 전송 실패', e) // 입력은 보존(setText 미실행) — 재전송 가능
    }
  }
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/components/ChatPanel.test.tsx && npm run lint` → PASS(기존 케이스 포함 전량 — 특히 하이드레이션 레이스 기존 테스트 무회귀).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ChatPanel.tsx src/renderer/components/ChatPanel.test.tsx
git commit -m "feat(#197-B4): ChatPanel 재접속 재하이드레이션 — 윈도우 리셋·스냅샷 권위 replace(유령 스트림/stale busy 정리)·reject 마감"
```

---

### Task 7: ProjectPanel — activity replace·nonce 재하이드레이션·웹 워크스페이스 입력·reject audit

**Files:**
- Modify: `src/renderer/components/ProjectPanel.tsx`
- Test: `src/renderer/components/ProjectPanel.test.tsx`(재접속·웹 워크스페이스 시나리오 추가)

**Interfaces:**
- Consumes: `useHydration`/`HydrationContext`(Task 3) · `describeError`(Task 2) · `window.fleet.setWorkspace`(Task 1) · `runtime` prop(Task 4).

- [ ] **Step 1: 실패하는 테스트 작성** — `ProjectPanel.test.tsx` 에 추가:

```tsx
import { HydrationContext } from '../bridge/hydration'

function renderWithNonce(nonce: number, ui: React.ReactElement) {
  return render(
    <HydrationContext.Provider value={{ nonce, connection: 'connected' }}>{ui}</HydrationContext.Provider>,
  )
}

describe('재접속 재하이드레이션(#197 B4 — 스냅샷 권위 replace)', () => {
  it('끊긴 사이 끝난 실행의 stale running 잠금을 스냅샷이 내린다', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P2]),
      getRunActivity: vi
        .fn()
        .mockResolvedValueOnce({ activeProjectIds: ['p2'] }) // 최초: 진행 중
        .mockResolvedValue({ activeProjectIds: [] }), // 재접속: 끝났음
    })
    const { rerender } = renderWithNonce(0, <ProjectPanel sessions={[SESSION]} />)
    await act(async () => {})
    expect(screen.getByRole('button', { name: '실행 중…' })).toBeTruthy()
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected' }}>
        <ProjectPanel sessions={[SESSION]} />
      </HydrationContext.Provider>,
    )
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '실행 중…' })).toBeNull()
    expect(screen.getByRole('button', { name: '오케스트레이션 실행' })).toBeTruthy()
  })

  it('윈도우 중 라이브 project.created 는 스냅샷(빈)보다 우선한다', async () => {
    let resolveActivity!: (a: unknown) => void
    const fleet = mockFleet({
      getRunActivity: vi
        .fn()
        .mockResolvedValueOnce({ activeProjectIds: [] })
        .mockImplementationOnce(() => new Promise((r) => (resolveActivity = r))),
    })
    const { rerender } = renderWithNonce(0, <ProjectPanel sessions={[SESSION]} />)
    await act(async () => {})
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected' }}>
        <ProjectPanel sessions={[SESSION]} />
      </HydrationContext.Provider>,
    )
    fleet.fire({ type: 'project.created', message: '', data: { projectId: 'p9', eventId: 'e9' } })
    await act(async () => resolveActivity({ activeProjectIds: [] })) // stale 빈 스냅샷이 늦게 도착
    expect(screen.getByRole('button', { name: '실행 중…' })).toBeTruthy() // 라이브 우선 — 잠금 유지
  })
})

describe('웹 워크스페이스 경로 입력(#197 B4)', () => {
  it('runtime=web 이면 dialog 버튼 대신 경로 입력+적용이 보인다', async () => {
    mockFleet()
    await renderSettled(<ProjectPanel sessions={[]} runtime="web" />)
    expect(screen.queryByRole('button', { name: '워크스페이스 선택' })).toBeNull()
    expect(screen.getByLabelText('워크스페이스 경로')).toBeTruthy()
  })

  it('적용 클릭이 setWorkspace 를 호출하고 반환 경로를 표시한다', async () => {
    const fleet = mockFleet({ setWorkspace: vi.fn().mockResolvedValue('/srv/ws/proj-a') })
    await renderSettled(<ProjectPanel sessions={[]} runtime="web" />)
    fireEvent.change(screen.getByLabelText('워크스페이스 경로'), { target: { value: 'proj-a' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '적용' }))
    })
    expect(fleet.setWorkspace).toHaveBeenCalledWith('proj-a')
    expect(await screen.findByText(/\/srv\/ws\/proj-a/)).toBeTruthy()
  })

  it('서버 거부(루트 밖 등)는 오류로 표시한다', async () => {
    mockFleet({ setWorkspace: vi.fn().mockRejectedValue(new Error('경로가 워크스페이스 밖입니다: x')) })
    await renderSettled(<ProjectPanel sessions={[]} runtime="web" />)
    fireEvent.change(screen.getByLabelText('워크스페이스 경로'), { target: { value: 'x' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '적용' }))
    })
    expect(await screen.findByText(/워크스페이스 밖/)).toBeTruthy()
  })

  it('runtime=electron(기본)은 기존 dialog 버튼 그대로(무회귀)', async () => {
    mockFleet()
    await renderSettled(<ProjectPanel sessions={[]} />)
    expect(screen.getByRole('button', { name: '워크스페이스 선택' })).toBeTruthy()
    expect(screen.queryByLabelText('워크스페이스 경로')).toBeNull()
  })
})
```

(신규 mock 채널 `setWorkspace` 는 `mockFleet` 기본값에 `setWorkspace: vi.fn().mockResolvedValue('/srv/ws')` 로 추가.)

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/components/ProjectPanel.test.tsx` → FAIL.

- [ ] **Step 3: ProjectPanel 수정**

(a) Props·컨텍스트·ref·상태:

```tsx
interface Props {
  sessions: LlmDescriptor[]
  /** AppInfo.runtime — 웹이면 dialog 버튼 대신 경로 입력을 렌더(#197 B4). null=미확정(데스크톱 동형). */
  runtime?: 'electron' | 'web' | null
}
```

```tsx
import { describeError } from '../bridge/errors'
import { useHydration } from '../bridge/hydration'
```

컴포넌트 상단에:

```tsx
  const { nonce: hydrateNonce } = useHydration()
  const [workspaceInput, setWorkspaceInput] = useState('')
  // 하이드레이션 윈도우 중 라이브 project.created 로 시작된 실행 — 스냅샷 replace 시 보존(라이브 우선).
  const liveStartedRunsRef = useRef<Set<string>>(new Set())
```

(b) onOrchestratorEvent 핸들러 보강(구독 effect deps 는 `[]` 유지):
  - `project.created` 분기(`setActiveProjectId(pid)` 앞)에: `liveStartedRunsRef.current.add(pid)`
  - `project.done`/`plan.failed` 분기의 `endedRunsRef.current.add(pid)` 다음에: `liveStartedRunsRef.current.delete(pid)`
  - 같은 핸들러의 fire-and-forget audit: `void refreshProjects()` 4곳 → `void refreshProjects().catch(() => undefined)`, `void refreshTasks(pid)` → `void refreshTasks(pid).catch(() => undefined)`.

(c) 마운트 effect 3개를 nonce 재하이드레이션 겸용으로:

```tsx
  // 마운트·웹 재접속: 방 목록 로드 + 마지막 보던(없으면 최신) 프로젝트 자동 선택. 전송 실패는 조용히
  // (재접속 하이드레이션이 재시도 — #197 B4 reject audit).
  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshProjects()
        const last = await window.fleet.getLastActiveProject()
        const pick = last && list.some((p) => p.id === last) ? last : (list[0]?.id ?? null)
        // 마운트 await 동안 사용자가 이미 방을 선택했으면(예: 새 실행의 project.created) 자동선택으로 되돌리지 않는다.
        if (pick && !hasSelectedRef.current) selectProject(pick)
      } catch {
        /* 스냅샷 로드 실패 — 다음 하이드레이션 세대가 재시도 */
      }
    })()
    // hydrateNonce: 웹 재접속 세대(데스크톱 0 고정). 내부 함수는 안정 참조라 의도적 한정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateNonce])

  // 마운트·웹 재접속: 워크스페이스 상태.
  useEffect(() => {
    void window.fleet
      .getWorkspace()
      .then(setWorkspace)
      .catch(() => undefined)
  }, [hydrateNonce])
```

getRunActivity effect(183행) 전체 교체 — **replace 시맨틱**:

```tsx
  // 마운트·웹 재접속(hydrateNonce) 시 진행 중 실행 스냅샷 복원 — 스냅샷은 권위(replace). merge(추가만)면
  // 끊긴 사이 끝난 실행의 stale running 잠금이 영구 잔존한다(#197 B4). 라이브-우선 가드(endedRunsRef·
  // liveStartedRunsRef)는 이 윈도우 기준으로 리셋: 스냅샷 resolve 전 도착한 라이브 종료는 되살리지 않고,
  // 라이브 시작은 stale 빈 스냅샷이 내리지 못한다. (주의: run() 직후~project.created 사이에 재접속이
  // 겹치면 잠금이 순간 풀릴 수 있으나 project.created 가 즉시 재잠금하고 엔진 동시 실행 가드가 백스톱.)
  useEffect(() => {
    endedRunsRef.current = new Set()
    liveStartedRunsRef.current = new Set()
    let cancelled = false
    window.fleet
      .getRunActivity()
      .then((a) => {
        if (cancelled) return
        const live = [
          ...a.activeProjectIds.filter((pid) => !endedRunsRef.current.has(pid)),
          ...liveStartedRunsRef.current,
        ]
        setRunning(live.length > 0)
        setActiveProjectId((cur) => (cur && live.includes(cur) ? cur : (live[0] ?? null)))
      })
      .catch(() => undefined) // 전송 실패 — 다음 하이드레이션 세대가 재시도
    return () => {
      cancelled = true
    }
  }, [hydrateNonce])
```

선택 effect(196행) deps 를 `[selectedId, hydrateNonce]` 로 바꾸고, effect 본문 첫 줄(`if (!selectedId) return` 다음, `void window.fleet.setLastActiveProject…` 앞)에 윈도우 리셋과 catch 를 추가:

```tsx
    liveDuringLoadRef.current = 0 // 재하이드레이션(nonce) 재실행 시 스냅샷 권위 — 이전 세대 라이브 tail 은 재보존하지 않는다(진행 델타 유실은 통지 문구가 안내)
    void window.fleet.setLastActiveProject(selectedId).catch(() => undefined)
```

(기존 `void window.fleet.setLastActiveProject(selectedId)` 줄은 위로 대체.) `Promise.all` IIFE 는 try/catch 로 감싼다:

```tsx
    void (async () => {
      try {
        const [t, ev] = await Promise.all([
          window.fleet.getProjectTasks(selectedId),
          window.fleet.listProjectEvents(selectedId),
        ])
        … 기존 본문 그대로 …
      } catch {
        /* 스냅샷 로드 실패 — 재접속 하이드레이션이 재시도(#197 B4) */
      }
    })()
```

(d) 오류 문구 승급 — `pickWorkspace`/`cancel`/`run` 의 `err instanceof Error ? err.message : String(err)` 3곳을 `describeError(err)` 로 교체.

(e) 웹 워크스페이스 UI — 워크스페이스 행(436행)을 runtime 분기로 교체:

```tsx
          {runtime === 'web' ? (
            <div className="row" style={{ alignItems: 'center', marginTop: 12, gap: 8 }}>
              <input
                className="field"
                style={{ maxWidth: 320 }}
                aria-label="워크스페이스 경로"
                placeholder="워크스페이스 경로 (서버 루트 하위)"
                value={workspaceInput}
                onChange={(e) => setWorkspaceInput(e.target.value)}
                disabled={running}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void applyWorkspacePath()}
                disabled={running || !workspaceInput.trim()}
              >
                적용
              </button>
              <span className="meta">
                {workspace
                  ? `산출물·검증 활성 → ${workspace}`
                  : '워크스페이스 미설정 — 파일 기록/검증 비활성(텍스트 산출물만)'}
              </span>
            </div>
          ) : (
            <div className="row" style={{ alignItems: 'center', marginTop: 12, gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => void pickWorkspace()}>
                워크스페이스 선택
              </button>
              <span className="meta">
                {workspace
                  ? `산출물·검증 활성 → ${workspace}`
                  : '워크스페이스 미설정 — 파일 기록/검증 비활성(텍스트 산출물만)'}
              </span>
            </div>
          )}
```

핸들러(`pickWorkspace` 옆):

```tsx
  // 웹 경로 설정(#197 B4) — 서버가 FLEET_WORKSPACE_ROOT 하위 한정·런 중 거부를 강제(disabled 는 보조 UX).
  async function applyWorkspacePath() {
    const path = workspaceInput.trim()
    if (!path) return
    try {
      setWorkspace(await window.fleet.setWorkspace(path))
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/components/ProjectPanel.test.tsx && npm run lint` → PASS(기존 케이스 전량 무회귀 — 특히 하이드레이션 레이스·탭 복원 케이스).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ProjectPanel.tsx src/renderer/components/ProjectPanel.test.tsx
git commit -m "feat(#197-B4): ProjectPanel 재접속 재하이드레이션(replace)·웹 워크스페이스 경로 입력·reject audit·describeError"
```

---

### Task 8: ApprovalModal reject 마감 (audit 잔여 정리)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`
- Test: `src/renderer/components/ApprovalModal.test.tsx`(케이스 1개 추가)

- [ ] **Step 1: 실패하는 테스트 작성**:

```tsx
it('respondApproval reject 는 unhandled rejection 없이 흡수된다(#197 B4)', async () => {
  const onUnhandled = vi.fn()
  process.on('unhandledRejection', onUnhandled)
  try {
    const fleet = mockFleet({ respondApproval: vi.fn().mockRejectedValue(new Error('전송 단절')) })
    render(<ApprovalModal />)
    fleet.fire(REQ) // 기존 헬퍼 — 승인 요청 1건 주입
    fireEvent.click(await screen.findByRole('button', { name: '승인' }))
    await act(async () => {})
    expect(onUnhandled).not.toHaveBeenCalled()
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx` → FAIL(unhandled 발생).

- [ ] **Step 3: 수정** — `decide` 를:

```tsx
  const decide = (approved: boolean): void => {
    if (!current) return
    // 회신 유실(전송 단절)은 조용히 흡수 — main/server 의 승인 타임아웃(fail-closed 자동 거부)이 권위라
    // 렌더러가 재시도하지 않는다(#197 B4 reject audit).
    void window.fleet.respondApproval(current.id, approved).catch(() => undefined)
    setQueue((prev) => prev.slice(1))
  }
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#197-B4): ApprovalModal 회신 reject 흡수 — fail-closed 타임아웃 권위 명시"
```

---

### Task 9: `e2eCompletingRunner` — 결정론 완주 러너(opt-in) + boot 선택

**Files:**
- Modify: `src/main/e2e.ts` · `src/server/boot.ts`
- Test: `src/main/e2e.test.ts`(있으면 확장, 없으면 신규)

**Interfaces:**
- Consumes: `CommandRunner`/`PROBE_PROMPT`(기존) · `buildPlannerPrompt` 의 문구 마커(`'너는 소프트웨어 프로젝트 플래너다'`) · `buildReviewPrompt` 의 문구 마커(`'변경(diff)'`).
- Produces: `e2eCompletingRunner: CommandRunner` · `resolveE2eRunner(env): CommandRunner` — boot 만 소비(데스크톱 main 무변경 — hang 러너 계약 보존).
- 완주 경로 실측 근거: planner→`{"tasks":[…1건]}` 파싱(`parsePlannedTasks`), implementer 는 파일 무변경→빈 diff, reviewer 는 빈 diff 도 `approved:true`(리뷰 프롬프트가 "(변경 없음)" 을 명시 지원), 워크스페이스는 seed 의 빈 tmpdir(→package.json 부재로 verify 미구동), summary 는 고정 텍스트 → `project.done`.
- **내성**: 만약 빈 diff 의 git keep 단계가 해당 작업을 실패로 떨어뜨려도 `runProject` 는 부분 진행(continueOnFailure 미배선 — 항상 계속)으로 summary·`project.done` 까지 도달한다 — T10 완주 스모크의 단언(요약 패널 표시 + 실행 버튼 재활성)은 작업 성패와 무관하게 "런 플로우 완주"를 검증하도록 설계돼 있다.

- [ ] **Step 1: 실패하는 테스트 작성** — `src/main/e2e.test.ts` 에 describe 추가:

```ts
import { describe, expect, it } from 'vitest'
import { buildPlannerPrompt } from './core/orchestrator/plan'
import { buildReviewPrompt } from './core/orchestrator/review'
import { PROBE_PROMPT } from './core/cli/probe'
import { e2eCompletingRunner, e2eRunner, resolveE2eRunner } from './e2e'

async function reply(prompt: string): Promise<string> {
  const chunks: string[] = []
  const r = await e2eCompletingRunner('claude', ['-p'], { stdinInput: prompt }, (s) => chunks.push(s))
  return r.stdout + chunks.join('')
}

describe('e2eCompletingRunner(#197 B4 — 완주 스모크용 opt-in)', () => {
  it('--version/probe 는 기본 러너와 동형', async () => {
    await expect(e2eCompletingRunner('claude', ['--version'], {}, undefined)).resolves.toMatchObject({ code: 0 })
    await expect(e2eCompletingRunner('claude', [], { stdinInput: PROBE_PROMPT }, undefined)).resolves.toMatchObject({ code: 0, stdout: 'ok' })
  })

  it('플래너 프롬프트 → 단일 작업 계획 JSON(파싱 가능)', async () => {
    const out = await reply(buildPlannerPrompt('데모 목표'))
    const parsed = JSON.parse(out.match(/\{"tasks":[\s\S]*\}/)![0]) as { tasks: unknown[] }
    expect(parsed.tasks).toHaveLength(1)
  })

  it('리뷰 프롬프트 → approved:true JSON', async () => {
    const out = await reply(buildReviewPrompt('t', 'd', ''))
    expect(out).toContain('"approved": true')
  })

  it('그 외 프롬프트 → 고정 텍스트로 resolve(hang 없음)', async () => {
    const out = await reply('요약하라')
    expect(out).toContain('E2E 완주 러너 응답')
  })
})

describe('resolveE2eRunner', () => {
  it("기본은 hang 러너, FLEET_E2E_RUNNER='complete' 만 완주 러너", () => {
    expect(resolveE2eRunner({})).toBe(e2eRunner)
    expect(resolveE2eRunner({ FLEET_E2E_RUNNER: 'complete' })).toBe(e2eCompletingRunner)
    expect(resolveE2eRunner({ FLEET_E2E_RUNNER: 'yes' })).toBe(e2eRunner) // 엄격 핀 — 미지 값은 기본
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/main/e2e.test.ts` → FAIL(export 없음).

- [ ] **Step 3: 구현** — `src/main/e2e.ts` 말미에 추가:

```ts
/**
 * 완주 러너(#197 B4 — 웹 스모크 "목표 입력→런 완주" 게이트 전용). 기본 e2eRunner 는 의도적 영구
 * in-flight(데스크톱 e2e 가 진행 고정에 의존)라 완주가 불가하다 — 이 러너는 프롬프트 내용으로 단계를
 * 판별해 결정론적으로 응답한다: 플래너→단일 작업 계획 JSON · 리뷰어→approved(빈 diff 도 승인이
 * 리뷰 프롬프트의 명시 계약) · 그 외(구현/요약)→고정 텍스트. 파일 무변경 실행이라 diff 는 항상 비고
 * verify 는 빈 워크스페이스(package.json 부재)에서 미구동 → project.done 까지 완주한다.
 * 활성화는 FLEET_E2E==='1' 안에서 FLEET_E2E_RUNNER==='complete' 로만(이중 opt-in — 프로덕션 격리).
 */
export const e2eCompletingRunner: CommandRunner = (_command, args, opts, onStdout) => {
  if (args.includes('--version'))
    return Promise.resolve({ code: 0, stdout: 'fleet-e2e 9.9.9', stderr: '' })
  if (opts.stdinInput === PROBE_PROMPT)
    return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' })
  const prompt = opts.stdinInput ?? ''
  const payload = prompt.includes('너는 소프트웨어 프로젝트 플래너다')
    ? '{"tasks":[{"title":"산출물 작성","description":"목표를 요약한 산출물을 만든다","role":"implementer","dependsOn":[]}]}'
    : prompt.includes('변경(diff)')
      ? '{"approved": true, "feedback": ""}'
      : 'E2E 완주 러너 응답'
  // 스트림 파서(누적 델타)와 stdout 수확 어느 경로든 같은 본문을 얻도록 두 채널 모두에 싣는다.
  onStdout?.(
    JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: payload } } }) + '\n',
  )
  return Promise.resolve({ code: 0, stdout: payload, stderr: '' })
}

/** e2e 러너 선택 — 완주 러너는 명시 opt-in(`complete`)만. 미지 값은 기본(hang) 러너로 fail-safe. */
export function resolveE2eRunner(env: NodeJS.ProcessEnv): CommandRunner {
  return env['FLEET_E2E_RUNNER'] === 'complete' ? e2eCompletingRunner : e2eRunner
}
```

`src/server/boot.ts` — import 를 `import { isE2EActive, resolveE2eRunner, seedE2eFixtures } from '../main/e2e'` 로 바꾸고 engine 생성부를:

```ts
    runner: e2e ? resolveE2eRunner(env) : undefined,
```

(주의: replan 프롬프트도 플래너 마커를 포함하지만 `maxReplanRounds` 기본 0 = 비활성이라 스모크 경로에선 도달하지 않는다 — 주석으로 명시.)

- [ ] **Step 4: 통과 확인** — `npx vitest run src/main/e2e.test.ts src/server/boot.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/e2e.ts src/main/e2e.test.ts src/server/boot.ts
git commit -m "feat(#197-B4): e2eCompletingRunner — 완주 스모크용 결정론 러너(opt-in) + 서버 boot 선택"
```

---

### Task 10: playwright `web` 프로젝트 + 브라우저 스모크 3본 + CI 편입

**Files:**
- Modify: `playwright.config.ts` · `package.json` · `.github/workflows/e2e.yml`
- Create: `e2e/web-server.ts` · `e2e/web-orchestration.web.e2e.ts`

**Interfaces:**
- Consumes: `out/server/index.mjs`(build:server 산출물 — stdout `fleet-server: http://127.0.0.1:PORT` 로그로 포트 파악) · `FLEET_E2E`/`FLEET_E2E_RUNNER`/`FLEET_PORT=0`/`FLEET_DATA_DIR` env 표면 · 정적 서빙 기본 경로(`out/server/../renderer` = electron-vite renderer 번들).
- Produces: `startFleetWebServer(extraEnv?): Promise<{ url; stop(); cleanup() }>`.

- [ ] **Step 1: playwright projects 분리** — `playwright.config.ts` 의 `defineConfig({ … })` 에 추가:

```ts
  // electron(기존 _electron.launch e2e)과 web(chromium — fleet-server + ws-bridge, #197 B4)을 분리한다.
  // web 스모크는 loopback endpoint 한정(B5 전 bind 게이트와 짝 — 이슈 B4).
  projects: [
    { name: 'electron', testIgnore: /\.web\.e2e\.ts$/ },
    { name: 'web', testMatch: /\.web\.e2e\.ts$/, use: { browserName: 'chromium', trace: 'on-first-retry' } },
  ],
```

- [ ] **Step 2: 서버 스폰 헬퍼** — `e2e/web-server.ts`:

```ts
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 웹 스모크용 fleet-server 실기동(#197 B4) — 빌드 번들(out/server/index.mjs)을 자식 프로세스로 띄우고
 * 기동 로그에서 포트를 파싱한다(FLEET_PORT=0 = OS 배정 — 병렬/충돌 무관). 정적 서빙은 번들 기본 경로
 * (out/renderer)를 그대로 쓴다. store 는 임시 디렉터리(FLEET_DATA_DIR)로 격리하고 종료 시 정리한다.
 */
export interface RunningWebServer {
  url: string
  stop(): Promise<void>
}

export async function startFleetWebServer(
  extraEnv: Record<string, string> = {},
): Promise<RunningWebServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'fleet-web-e2e-'))
  const child = spawn(
    process.execPath,
    [resolve(__dirname, '..', 'out', 'server', 'index.mjs')],
    {
      env: { ...process.env, FLEET_E2E: '1', FLEET_PORT: '0', FLEET_DATA_DIR: dataDir, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fleet-server 기동 타임아웃:\n${log}`)),
      15_000,
    )
    child.stdout.on('data', (d: Buffer) => {
      log += d.toString()
      const m = log.match(/fleet-server: (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) {
        clearTimeout(timer)
        resolveUrl(m[1])
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      log += d.toString()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`fleet-server 조기 종료(code ${code}):\n${log}`))
    })
  })
  return {
    url,
    stop: () =>
      new Promise<void>((r) => {
        child.once('exit', () => {
          rmSync(dataDir, { recursive: true, force: true })
          r()
        })
        child.kill()
      }),
  }
}
```

- [ ] **Step 3: 스모크 작성** — `e2e/web-orchestration.web.e2e.ts`:

```ts
import { expect, test } from '@playwright/test'
import { startFleetWebServer, type RunningWebServer } from './web-server'

/**
 * 웹모드 브라우저 스모크(#197 B4) — 실 chromium 이 fleet-server(빌드 번들)의 정적 renderer 를 열고
 * ws-bridge 로 오케스트레이션을 구동한다(문 ② e2e). ① 목표 입력→런 개시 + 리로드 후 WS 스냅샷
 * 재하이드레이션 복원(데스크톱 탭전환 스모크의 웹 등가) ② 오프라인→온라인 재접속 배너·복구
 * ③ 완주 러너로 목표 입력→project.done(이슈 완료 정의 "런 완주").
 */

test.describe('런 개시·복원 (기본 hang 러너)', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer()
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('목표 입력→런 개시, 리로드 후 WS 재하이드레이션으로 잠금 복원', async ({ page }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    await expect(page.locator('footer')).toContainText('Web') // runtime 게이팅 — 웹 footer

    await page.getByRole('button', { name: '프로젝트' }).click()
    await page.getByPlaceholder(/사용자 인증/).fill('웹 스모크 — 진행 고정 목표')
    await page.getByRole('button', { name: '오케스트레이션 실행' }).click()
    await expect(page.getByRole('button', { name: '취소' })).toBeVisible()
    await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()

    // 새 페이지 = 새 브리지 = 마운트 하이드레이션이 WS 스냅샷(getRunActivity)으로 복원해야 한다.
    await page.reload()
    await page.getByText('FLEET').first().waitFor()
    await page.getByRole('button', { name: '프로젝트' }).click()
    await expect(page.getByRole('button', { name: '취소' })).toBeVisible()
    await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()
  })

  test('오프라인→온라인: 재접속 배너와 자동 복구', async ({ page, context }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    await context.setOffline(true)
    // 소켓 단절 → ws-bridge 백오프 재접속 → ConnectionBanner
    await expect(page.getByRole('status').filter({ hasText: '재접속 중' })).toBeVisible({
      timeout: 15_000,
    })
    await context.setOffline(false)
    // 재접속 완료 → 스냅숏 권위 통지(체크포인트 2-R 노트 3 문구)
    await expect(page.getByRole('status').filter({ hasText: '스냅숏이 권위' })).toBeVisible({
      timeout: 20_000,
    })
  })
})

test.describe('런 완주 (완주 러너 opt-in)', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer({ FLEET_E2E_RUNNER: 'complete' })
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('목표 입력→런 완주(project.done — 요약 표시·잠금 해제)', async ({ page }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    await page.getByRole('button', { name: '프로젝트' }).click()
    await page.getByPlaceholder(/사용자 인증/).fill('웹 스모크 — 완주 목표')
    await page.getByRole('button', { name: '오케스트레이션 실행' }).click()
    // 완주: 요약 패널이 뜨고(런 결과), 실행 버튼이 재활성(잠금 해제 = project.done)된다.
    await expect(page.getByText('최종 요약 / 누락 점검')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByRole('button', { name: '오케스트레이션 실행' })).toBeEnabled()
  })
})
```

- [ ] **Step 4: 스크립트·CI 배선**
  - `package.json`: `"test:e2e": "npm run build && playwright test"` (build = electron-vite build && build:server — web 프로젝트가 서버 번들 필요).
  - `.github/workflows/e2e.yml`: `npx playwright install-deps` 스텝 다음에 추가(chromium 은 electron e2e 에 불필요했어서 미설치 상태):

```yaml
      # web 프로젝트(#197 B4)는 chromium 브라우저 바이너리가 필요하다(electron e2e 는 자체 바이너리).
      - name: Install chromium (web e2e)
        run: npx playwright install chromium
```

- [ ] **Step 5: 로컬 실행 확인**

```bash
npm run build
npx playwright test --project=web
```

Expected: 3 passed. 주의 2건 — (a) `context.setOffline` 이 이 chromium 버전에서 활성 WS 를 끊지 않으면 오프라인 테스트가 timeout: 그 경우 `page.evaluate` 로 서버 소켓 강제 종료 대신 **해당 테스트만 `test.fixme` 처리하지 말고**, 서버를 `stop()` 후 동일 env 로 재기동하는 방식(단, in-memory 실행 상태 소실로 배너 검증만 가능)으로 대체하고 계획 편차를 PR 본문에 기록한다. (b) 완주 러너가 어댑터 출력 파싱과 안 맞으면(요약 미표시) `src/main/e2e.test.ts` 는 GREEN 이므로 CLI 어댑터의 reply 추출 경로(스트림 누적 vs stdout)를 실측해 `e2eCompletingRunner` 의 방출 채널을 조정한다 — 계약 변경이 아니라 페이로드 전달 방식 조정.

- [ ] **Step 6: 데스크톱 e2e 무회귀 확인**

```bash
npx playwright test --project=electron
```

Expected: 기존 5개 spec 전량 PASS(프로젝트 분리·config 변경의 무회귀 확인).

- [ ] **Step 7: 커밋**

```bash
git add playwright.config.ts package.json .github/workflows/e2e.yml e2e/web-server.ts e2e/web-orchestration.web.e2e.ts
git commit -m "feat(#197-B4): playwright web 프로젝트 — fleet-server 실기동 스모크(개시·리로드 복원·오프라인 재접속·완주)"
```

---

### Task 11: 마무리 — brain 재생성·verify·자가 점검

**Files:**
- Modify: `docs/brain/**`(재생성 산출물)

- [ ] **Step 1: brain 재생성** — `npm run brain` (src 변경 반영 — brain:check 게이트).

- [ ] **Step 2: 전체 verify**

```bash
npm run verify
```

Expected: skills:lint·brain:check·format:check·typecheck(3 tsconfig)·lint(max-warnings 0)·test:coverage·build 전부 GREEN.

- [ ] **Step 3: 자가 점검 체크리스트** (이슈 B4 완료 조건 ↔ 구현 대응)
  - `window.fleet` 부재 시 WS 브리지 폴백 → Task 2·3 (`initWebBridge`+`main.tsx`)
  - 재접속 재하이드레이션 + seq 커서(gap 관측) → Task 3·6·7 (사전 결정 2·3 — 편차 사유 포함)
  - UpdateBanner/footer `AppInfo.runtime` 게이팅·스텁 no-op shape 핀 → Task 4·5 + Task 2 Step 5
  - `openCliDocs` `Promise<void>` 표면 → B2 착지 유지·`ws-bridge-binding` 기존 테스트가 커버(변경 0 — audit 표에 명시)
  - `fleet:workspace:set`(FLEET_WORKSPACE_ROOT 하위 한정) → Task 0·1·7
  - 런 중 workspace 변경 거부 → Task 0(서버측)·Task 7(UI disabled)
  - reject 처리 audit → 전수표 + Task 5~8
  - playwright web 프로젝트(loopback·FLEET_E2E=1·목표 입력→런) → Task 9·10
  - task.progress UX 문구(체크포인트 2-R 노트 3) → Task 3 ConnectionBanner
  - update 스텁 shape 계약 테스트(노트 4) → Task 2 Step 5

- [ ] **Step 4: 커밋·푸시·PR**

```bash
git add -A && git commit -m "chore(#197-B4): brain 재생성 + verify GREEN"
npm run format:check && npx prettier --version   # CI prettier stale 함정 사전 확인(메모리: #162)
git push -u origin feat/197-b4-renderer-web
```

PR 본문: `Part of #197` (Closes 금지 — 멀티-phase 메타), 계획 편차(있으면)·적대리뷰 결과 첨부. **머지 전 Codex/CodeRabbit 리뷰 대기·스레드 resolve**(레포 워크플로).

---

## 리스크·완화

| 리스크 | 완화 |
|---|---|
| replace 시맨틱이 데스크톱 하이드레이션 레이스 기존 보호를 약화 | 라이브-우선 가드(ended/idled/liveStarted)를 윈도우 리셋으로 보존 + 기존 레이스 테스트 전량 GREEN 을 태스크 게이트로(T6·T7 Step 4) |
| `context.setOffline` 의 WS 단절 동작이 버전 의존 | T10 Step 5 (a) 대체 경로 명시 — 편차는 PR 기록 |
| 완주 러너가 CLI 어댑터 출력 파싱과 불일치 | 스트림+stdout 이중 방출 + T10 Step 5 (b) 실측 조정 절차 |
| preload 변경(dev 재시작 함정 — AGENTS.md) | T1 이후 로컬 dev 는 반드시 electron 재시작(주의 주석) |
| 채널 신설이 B2/B3 parity·fixture 게이트 연쇄 RED | T1 원자 스윕(중간 커밋 금지) + Step 10 일괄 게이트 |
| 웹에서 desktop 전용 스텁 오호출(게이팅 누락) | UpdateBanner 마운트 게이트 + SessionsPanel 섹션 게이트 + 스텁 자체 no-op(이중 방어) |

## 비범위 (B4)

- Origin/JWT/nonce/CSP·non-loopback 개방 — **B5**. 승인 presence 강화(authenticated only)도 B5.
- 컨테이너 Dockerfile/compose·자식 격리 — **B6**(웹 스모크의 컨테이너 재실행 포함).
- push 재생·증분 이벤트 API(since-커서) — 전체 재하이드레이션으로 대체(사전 결정 2).
- `task.progress` 재접속 재생 — 명시적 비범위(스냅샷 권위·통지 문구로 안내, 체크포인트 2 §2).
- per-run worktree 격리 — Phase C(런 중 변경 거부는 UI/서버 가드일 뿐임을 유지).
