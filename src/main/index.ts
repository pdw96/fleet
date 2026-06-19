import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  AgentRole,
  ApiProviderConfig,
  ApprovalRequest,
  AppInfo,
  ChatStreamEvent,
  McpServerSpec,
  OrchestratorEvent,
  RunProjectRequest,
} from '../shared/types'
import { createFleetEngine, type FleetEngine } from './core/engine'
import { createIpcApprover, type IpcApprover } from './core/safety/approval-bridge'
import { createJsonFileStore } from './core/store/json-file'
import { e2eRunner, seedE2eFixtures } from './e2e'
import { installNavigationGuards } from './window-guards'
import { installPermissionGuards } from './permission-guards'
import { installChildProcessObserver, installCrashRecovery } from './crash-recovery'
import { createSafeStorageCrypto } from './secret-crypto'

function broadcastOrchestratorEvent(event: OrchestratorEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:orchestrator:event', event)
  }
}

function broadcastChatStream(event: ChatStreamEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:chat:stream', event)
  }
}

function broadcastApprovalRequest(req: ApprovalRequest): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:approval:request', req)
  }
}

function buildEngine(): { engine: FleetEngine; ipcApprover: IpcApprover } {
  // 명시적 '1' 만 E2E 로 활성화 — FLEET_E2E=0/false 나 상속된 빈 값으로 프로덕션 런치가
  // 페이크 러너(영구 in-flight)·픽스처 시드로 새지 않게 한다.
  const e2e = process.env['FLEET_E2E'] === '1'
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
    // E2E: 실제 CLI 대신 결정론적 페이크 러너를 주입(FLEET_E2E 일 때만). 프로덕션은 기본 러너.
    runner: e2e ? e2eRunner : undefined,
    // 시크릿(apiKey) 영속용 OS 암호화 백엔드 주입. buildEngine 은 app.whenReady 이후 호출되므로
    // (Linux 키링 등) safeStorage 가용성 판정이 정상 동작한다. 코어는 이 포트만 알고 electron 비의존.
    secretCrypto: createSafeStorageCrypto(),
  })
  if (e2e) seedE2eFixtures(engine) // 페이크 세션 2개 + 방 1개 시드
  return { engine, ipcApprover }
}

function registerIpc(engine: FleetEngine, ipcApprover: IpcApprover): void {
  ipcMain.handle(
    'fleet:app:info',
    (): AppInfo => ({
      name: 'Fleet',
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    }),
  )

  // 세션 / CLI
  ipcMain.handle('fleet:cli:detect', () => engine.detectClis())
  ipcMain.handle('fleet:cli:adapters', () => engine.listAdapters())
  ipcMain.handle(
    'fleet:session:registerCli',
    (_e, adapterId: string, opts?: { stateful?: boolean; model?: string; mcpConfig?: string }) =>
      engine.registerCliSession(adapterId, opts),
  )
  ipcMain.handle('fleet:session:registerApi', (_e, config: ApiProviderConfig) =>
    engine.registerApiSession(config),
  )
  ipcMain.handle('fleet:session:list', () => engine.listSessions())
  ipcMain.handle('fleet:session:remove', (_e, id: string) => engine.removeSession(id))
  ipcMain.handle('fleet:session:capabilities', (_e, id: string, roles: AgentRole[]) =>
    engine.setSessionCapabilities(id, roles),
  )
  ipcMain.handle('fleet:session:listModels', (_e, config: ApiProviderConfig) =>
    engine.listProviderModels(config),
  )

  // 프로젝트 / 오케스트레이션
  ipcMain.handle('fleet:project:list', () => engine.listProjects())
  ipcMain.handle('fleet:project:tasks', (_e, projectId: string) =>
    engine.getProjectTasks(projectId),
  )
  ipcMain.handle('fleet:project:events', (_e, projectId: string) =>
    engine.listProjectEvents(projectId),
  )
  ipcMain.handle('fleet:project:lastActive:get', () => engine.getLastActiveProject())
  ipcMain.handle('fleet:project:lastActive:set', (_e, projectId: string | null) =>
    engine.setLastActiveProject(projectId),
  )
  ipcMain.handle('fleet:project:run', (_e, req: RunProjectRequest) => engine.runProjectFlow(req))
  ipcMain.handle('fleet:project:cancel', (_e, projectId: string) => engine.cancelRun(projectId))
  ipcMain.handle('fleet:project:activity', () => engine.getRunActivity())
  ipcMain.handle('fleet:workspace:get', () => engine.getWorkspace())
  ipcMain.handle('fleet:workspace:select', async () => {
    const res = await dialog.showOpenDialog({
      title: '산출물 워크스페이스 선택',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || res.filePaths.length === 0) return engine.getWorkspace()
    engine.setWorkspace(res.filePaths[0])
    return res.filePaths[0]
  })

  // 채팅
  ipcMain.handle('fleet:chat:createRoom', (_e, title: string, participants?: string[]) =>
    engine.createRoom(title, participants),
  )
  ipcMain.handle('fleet:chat:listRooms', () => engine.listRooms())
  ipcMain.handle('fleet:chat:history', (_e, roomId: string) => engine.roomHistory(roomId))
  ipcMain.handle('fleet:chat:postUser', (_e, roomId: string, content: string) =>
    engine.postUserMessage(roomId, content),
  )
  ipcMain.handle('fleet:chat:askLlm', (_e, roomId: string, llmId: string) =>
    engine.askLlm(roomId, llmId),
  )
  ipcMain.handle('fleet:chat:discuss', (_e, roomId: string, llmIds: string[], rounds?: number) =>
    engine.discussRoom(roomId, llmIds, rounds),
  )
  ipcMain.handle('fleet:chat:cancel', (_e, roomId: string) => engine.cancelChat(roomId))
  ipcMain.handle('fleet:chat:activity', () => engine.getChatActivity())

  // MCP 호스트
  ipcMain.handle('fleet:mcp:setServers', (_e, servers: McpServerSpec[]) =>
    engine.setMcpServers(servers),
  )
  ipcMain.handle('fleet:mcp:getStatus', () => engine.getMcpStatus())

  // 감사
  ipcMain.handle('fleet:events:list', () => engine.listEvents())

  // 안전 / 승인 — 렌더러 모달 결정 회신을 id 로 상관 해소.
  ipcMain.handle('fleet:approval:respond', (_e, id: string, approved: boolean) => {
    ipcApprover.resolve(id, approved)
  })
}

// 앱 종료(quit) 진행 플래그 — 종료 중 렌더러 종료는 teardown 이므로 크래시 복구 reload 를 억제한다(crash-recovery isShuttingDown 가드).
let isQuitting = false

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Fleet',
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      // 렌더러 격리 강화 — preload 는 contextBridge/ipcRenderer 만 쓰므로 샌드박스와 호환된다(Node API 미사용).
      sandbox: true,
    },
  })

  // 네비게이션 하드닝: 새 창/window.open 거부 + 모든 페이지발 네비게이션(드롭 file://·리다이렉트·
  // 서브프레임·외부 링크·주입 location) 차단(안전 우선). 상세 계약은 window-guards.ts 참조.
  installNavigationGuards(win.webContents)

  // 권한 하드닝: 미디어·지오·알림·클립보드·WebUSB/Serial/HID 거부(정상 경로 없는 로컬 SPA; Web Bluetooth 는 Electron 무리스너 기본동작에 의존). 계약은 permission-guards.ts 참조.
  installPermissionGuards(win.webContents.session)

  // 크래시 복구: 렌더러가 죽어(화이트스크린) render-process-gone 이 발화하면 무한 reload 루프 방지(연속
  // 카운트·지수 백오프·포기 한도)를 끼워 안전하게 reload 한다. 계약은 crash-recovery.ts 참조.
  installCrashRecovery(win.webContents, { isShuttingDown: () => isQuitting })

  win.on('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  const { engine, ipcApprover } = buildEngine()
  registerIpc(engine, ipcApprover)
  // 보조 프로세스(GPU·Utility 등) 종료 관측 — child-process-gone 은 app 에만 발화한다. Chromium 이
  // 자동 재기동하므로 reload 하지 않고 진단 로그만 남긴다(스코프 명시적 한정). 계약은 crash-recovery.ts 참조.
  installChildProcessObserver(app)
  // 종료 시 세션·MCP 자식 프로세스를 정리한다(좀비 방지). dispose 는 비동기(큐 대기 후 late 자식 정리)라
  // will-quit 를 preventDefault 로 잡고 dispose 완료 후 재-quit 한다 — fire-and-forget 이면 그 사이
  // 막 시작된 MCP 서버가 orphan 으로 남을 수 있다.
  app.on('will-quit', (e) => {
    if (isQuitting) return
    e.preventDefault()
    isQuitting = true
    const done = (): void => app.quit() // isQuitting 가드로 재진입은 무해(기본 종료 진행)
    void engine.dispose().finally(done)
    setTimeout(done, 3000) // dispose 가 지연/멈춰도 종료 보장(연결 자식은 dispose 동기 1단계에서 이미 정리)
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // smoke 모드: 메인 프로세스 부팅 + IPC 등록 + 윈도우 생성이 정상이면 종료(0).
  if (process.env['FLEET_SMOKE']) {
    setTimeout(() => app.quit(), 2000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
