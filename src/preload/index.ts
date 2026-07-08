import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApprovalRequest,
  ChatStreamEvent,
  FleetBridge,
  McpServerSpec,
  OrchestratorEvent,
  UpdateEvent,
} from '../shared/types'

const api: FleetBridge = {
  getAppInfo: () => ipcRenderer.invoke('fleet:app:info'),

  // 세션 / CLI
  detectClis: () => ipcRenderer.invoke('fleet:cli:detect'),
  listAdapters: () => ipcRenderer.invoke('fleet:cli:adapters'),
  registerCliSession: (adapterId, opts) =>
    ipcRenderer.invoke('fleet:session:registerCli', adapterId, opts),
  registerApiSession: (config) => ipcRenderer.invoke('fleet:session:registerApi', config),
  listSessions: () => ipcRenderer.invoke('fleet:session:list'),
  removeSession: (id) => ipcRenderer.invoke('fleet:session:remove', id),
  setSessionCapabilities: (id, roles) =>
    ipcRenderer.invoke('fleet:session:capabilities', id, roles),
  listModels: (config) => ipcRenderer.invoke('fleet:session:listModels', config),
  openCliDocs: (adapterId) => ipcRenderer.invoke('fleet:external:openDocs', adapterId),
  probeCli: (adapterId) => ipcRenderer.invoke('fleet:cli:probe', adapterId),

  // 프로젝트 / 오케스트레이션
  listProjects: () => ipcRenderer.invoke('fleet:project:list'),
  getProjectTasks: (projectId) => ipcRenderer.invoke('fleet:project:tasks', projectId),
  listProjectEvents: (projectId) => ipcRenderer.invoke('fleet:project:events', projectId),
  getLastActiveProject: () => ipcRenderer.invoke('fleet:project:lastActive:get'),
  setLastActiveProject: (projectId) =>
    ipcRenderer.invoke('fleet:project:lastActive:set', projectId),
  runProject: (req) => ipcRenderer.invoke('fleet:project:run', req),
  cancelRun: (projectId) => ipcRenderer.invoke('fleet:project:cancel', projectId),
  getRunActivity: () => ipcRenderer.invoke('fleet:project:activity'),
  getWorkspace: () => ipcRenderer.invoke('fleet:workspace:get'),
  selectWorkspace: () => ipcRenderer.invoke('fleet:workspace:select'),
  setWorkspace: (path) => ipcRenderer.invoke('fleet:workspace:set', path),

  // 채팅
  createRoom: (title, participants) =>
    ipcRenderer.invoke('fleet:chat:createRoom', title, participants),
  listRooms: () => ipcRenderer.invoke('fleet:chat:listRooms'),
  roomHistory: (roomId) => ipcRenderer.invoke('fleet:chat:history', roomId),
  postUserMessage: (roomId, content) => ipcRenderer.invoke('fleet:chat:postUser', roomId, content),
  askLlm: (roomId, llmId) => ipcRenderer.invoke('fleet:chat:askLlm', roomId, llmId),
  discussRoom: (roomId, llmIds, rounds) =>
    ipcRenderer.invoke('fleet:chat:discuss', roomId, llmIds, rounds),
  cancelChat: (roomId) => ipcRenderer.invoke('fleet:chat:cancel', roomId),
  getChatActivity: () => ipcRenderer.invoke('fleet:chat:activity'),

  // MCP 호스트
  setMcpServers: (servers: McpServerSpec[]) => ipcRenderer.invoke('fleet:mcp:setServers', servers),
  getMcpStatus: () => ipcRenderer.invoke('fleet:mcp:getStatus'),

  // 감사 / 이벤트
  listEvents: () => ipcRenderer.invoke('fleet:events:list'),
  onOrchestratorEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: OrchestratorEvent): void =>
      callback(event)
    ipcRenderer.on('fleet:orchestrator:event', listener)
    return () => {
      ipcRenderer.removeListener('fleet:orchestrator:event', listener)
    }
  },
  onChatStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ChatStreamEvent): void =>
      callback(event)
    ipcRenderer.on('fleet:chat:stream', listener)
    return () => {
      ipcRenderer.removeListener('fleet:chat:stream', listener)
    }
  },
  onApprovalRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, req: ApprovalRequest): void =>
      callback(req)
    ipcRenderer.on('fleet:approval:request', listener)
    return () => {
      ipcRenderer.removeListener('fleet:approval:request', listener)
    }
  },
  respondApproval: (id, approved) => ipcRenderer.invoke('fleet:approval:respond', id, approved),
  listPendingApprovals: () => ipcRenderer.invoke('fleet:approval:pending'),
  onApprovalWithdrawn: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string): void => callback(id)
    ipcRenderer.on('fleet:approval:withdrawn', listener)
    return () => {
      ipcRenderer.removeListener('fleet:approval:withdrawn', listener)
    }
  },
  onServerDraining: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: { reason: string }): void =>
      callback(event)
    ipcRenderer.on('fleet:server:draining', listener)
    return () => {
      ipcRenderer.removeListener('fleet:server:draining', listener)
    }
  },
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
  getUpdaterChannel: () => ipcRenderer.invoke('fleet:update:getChannel'),
  setUpdaterChannel: (channel) => ipcRenderer.invoke('fleet:update:setChannel', channel),
}

contextBridge.exposeInMainWorld('fleet', api)
