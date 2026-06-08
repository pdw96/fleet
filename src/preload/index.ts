import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalRequest, ChatStreamEvent, FleetBridge, McpServerSpec, OrchestratorEvent } from '../shared/types'

const api: FleetBridge = {
  getAppInfo: () => ipcRenderer.invoke('fleet:app:info'),

  // 세션 / CLI
  detectClis: () => ipcRenderer.invoke('fleet:cli:detect'),
  listAdapters: () => ipcRenderer.invoke('fleet:cli:adapters'),
  registerCliSession: (adapterId, opts) => ipcRenderer.invoke('fleet:session:registerCli', adapterId, opts),
  registerApiSession: (config) => ipcRenderer.invoke('fleet:session:registerApi', config),
  listSessions: () => ipcRenderer.invoke('fleet:session:list'),
  removeSession: (id) => ipcRenderer.invoke('fleet:session:remove', id),
  setSessionCapabilities: (id, roles) => ipcRenderer.invoke('fleet:session:capabilities', id, roles),

  // 프로젝트 / 오케스트레이션
  listProjects: () => ipcRenderer.invoke('fleet:project:list'),
  getProjectTasks: (projectId) => ipcRenderer.invoke('fleet:project:tasks', projectId),
  listProjectEvents: (projectId) => ipcRenderer.invoke('fleet:project:events', projectId),
  getLastActiveProject: () => ipcRenderer.invoke('fleet:project:lastActive:get'),
  setLastActiveProject: (projectId) => ipcRenderer.invoke('fleet:project:lastActive:set', projectId),
  runProject: (req) => ipcRenderer.invoke('fleet:project:run', req),
  cancelRun: (projectId) => ipcRenderer.invoke('fleet:project:cancel', projectId),
  getWorkspace: () => ipcRenderer.invoke('fleet:workspace:get'),
  selectWorkspace: () => ipcRenderer.invoke('fleet:workspace:select'),

  // 채팅
  createRoom: (title, participants) => ipcRenderer.invoke('fleet:chat:createRoom', title, participants),
  listRooms: () => ipcRenderer.invoke('fleet:chat:listRooms'),
  roomHistory: (roomId) => ipcRenderer.invoke('fleet:chat:history', roomId),
  postUserMessage: (roomId, content) => ipcRenderer.invoke('fleet:chat:postUser', roomId, content),
  askLlm: (roomId, llmId) => ipcRenderer.invoke('fleet:chat:askLlm', roomId, llmId),
  discussRoom: (roomId, llmIds, rounds) => ipcRenderer.invoke('fleet:chat:discuss', roomId, llmIds, rounds),
  getChatActivity: () => ipcRenderer.invoke('fleet:chat:activity'),

  // MCP 호스트
  setMcpServers: (servers: McpServerSpec[]) => ipcRenderer.invoke('fleet:mcp:setServers', servers),
  getMcpStatus: () => ipcRenderer.invoke('fleet:mcp:getStatus'),

  // 감사 / 이벤트
  listEvents: () => ipcRenderer.invoke('fleet:events:list'),
  onOrchestratorEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: OrchestratorEvent): void => callback(event)
    ipcRenderer.on('fleet:orchestrator:event', listener)
    return () => {
      ipcRenderer.removeListener('fleet:orchestrator:event', listener)
    }
  },
  onChatStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ChatStreamEvent): void => callback(event)
    ipcRenderer.on('fleet:chat:stream', listener)
    return () => {
      ipcRenderer.removeListener('fleet:chat:stream', listener)
    }
  },
  onApprovalRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, req: ApprovalRequest): void => callback(req)
    ipcRenderer.on('fleet:approval:request', listener)
    return () => {
      ipcRenderer.removeListener('fleet:approval:request', listener)
    }
  },
  respondApproval: (id, approved) => ipcRenderer.invoke('fleet:approval:respond', id, approved),
}

contextBridge.exposeInMainWorld('fleet', api)
