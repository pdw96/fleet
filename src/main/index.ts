import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ApiProviderConfig, AppInfo, OrchestratorEvent, RunProjectRequest } from '../shared/types'
import { createFleetEngine, type FleetEngine } from './core/engine'
import { createJsonFileStore } from './core/store/json-file'

function broadcastOrchestratorEvent(event: OrchestratorEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:orchestrator:event', event)
  }
}

function buildEngine(): FleetEngine {
  const store = createJsonFileStore(join(app.getPath('userData'), 'fleet'))
  return createFleetEngine({ store, onOrchestratorEvent: broadcastOrchestratorEvent })
}

function registerIpc(engine: FleetEngine): void {
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
  ipcMain.handle('fleet:session:registerCli', (_e, adapterId: string, opts?: { stateful?: boolean }) =>
    engine.registerCliSession(adapterId, opts),
  )
  ipcMain.handle('fleet:session:registerApi', (_e, config: ApiProviderConfig) => engine.registerApiSession(config))
  ipcMain.handle('fleet:session:list', () => engine.listSessions())
  ipcMain.handle('fleet:session:remove', (_e, id: string) => engine.removeSession(id))

  // 프로젝트 / 오케스트레이션
  ipcMain.handle('fleet:project:list', () => engine.listProjects())
  ipcMain.handle('fleet:project:tasks', (_e, projectId: string) => engine.getProjectTasks(projectId))
  ipcMain.handle('fleet:project:run', (_e, req: RunProjectRequest) => engine.runProjectFlow(req))

  // 채팅
  ipcMain.handle('fleet:chat:createRoom', (_e, title: string, participants?: string[]) =>
    engine.createRoom(title, participants),
  )
  ipcMain.handle('fleet:chat:listRooms', () => engine.listRooms())
  ipcMain.handle('fleet:chat:history', (_e, roomId: string) => engine.roomHistory(roomId))
  ipcMain.handle('fleet:chat:postUser', (_e, roomId: string, content: string) => engine.postUserMessage(roomId, content))
  ipcMain.handle('fleet:chat:askLlm', (_e, roomId: string, llmId: string) => engine.askLlm(roomId, llmId))
  ipcMain.handle('fleet:chat:discuss', (_e, roomId: string, llmIds: string[], rounds?: number) =>
    engine.discussRoom(roomId, llmIds, rounds),
  )

  // 감사
  ipcMain.handle('fleet:events:list', () => engine.listEvents())
}

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
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  registerIpc(buildEngine())
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
