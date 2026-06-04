import { contextBridge, ipcRenderer } from 'electron'
import type { FleetBridge, OrchestratorEvent } from '../shared/types'

const api: FleetBridge = {
  getAppInfo: () => ipcRenderer.invoke('fleet:app:info'),

  // 세션 / CLI
  detectClis: () => ipcRenderer.invoke('fleet:cli:detect'),
  listAdapters: () => ipcRenderer.invoke('fleet:cli:adapters'),
  registerCliSession: (adapterId, opts) => ipcRenderer.invoke('fleet:session:registerCli', adapterId, opts),
  registerApiSession: (config) => ipcRenderer.invoke('fleet:session:registerApi', config),
  listSessions: () => ipcRenderer.invoke('fleet:session:list'),
  removeSession: (id) => ipcRenderer.invoke('fleet:session:remove', id),

  // 프로젝트 / 오케스트레이션
  listProjects: () => ipcRenderer.invoke('fleet:project:list'),
  getProjectTasks: (projectId) => ipcRenderer.invoke('fleet:project:tasks', projectId),
  runProject: (req) => ipcRenderer.invoke('fleet:project:run', req),

  // 채팅
  createRoom: (title, participants) => ipcRenderer.invoke('fleet:chat:createRoom', title, participants),
  listRooms: () => ipcRenderer.invoke('fleet:chat:listRooms'),
  roomHistory: (roomId) => ipcRenderer.invoke('fleet:chat:history', roomId),
  postUserMessage: (roomId, content) => ipcRenderer.invoke('fleet:chat:postUser', roomId, content),
  askLlm: (roomId, llmId) => ipcRenderer.invoke('fleet:chat:askLlm', roomId, llmId),
  discussRoom: (roomId, llmIds, rounds) => ipcRenderer.invoke('fleet:chat:discuss', roomId, llmIds, rounds),

  // 감사 / 이벤트
  listEvents: () => ipcRenderer.invoke('fleet:events:list'),
  onOrchestratorEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: OrchestratorEvent): void => callback(event)
    ipcRenderer.on('fleet:orchestrator:event', listener)
    return () => {
      ipcRenderer.removeListener('fleet:orchestrator:event', listener)
    }
  },
}

contextBridge.exposeInMainWorld('fleet', api)
