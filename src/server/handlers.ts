import type { AppInfo, FleetBridge } from '../shared/types'
import type { BothInvokeChannel } from '../shared/transport/channels'
import type { FleetEngine } from '../main/core/engine'
import type { IpcApprover } from '../main/core/safety/approval-bridge'
import { applyWorkspaceSet } from '../main/core/workspace/set-workspace'

/**
 * 서버 핸들러 테이블(#197 B3) — main/index.ts `registerIpc` 의 기계적 이사(웹 스코프 32채널).
 * 시그니처는 FleetBridge 메서드에서 **타입 파생**한다: 채널↔메서드 매핑(ChannelMethodMap)을 거쳐
 * Parameters/ReturnType 을 끌어오므로 인자 순서·반환형 drift 는 컴파일 에러(체크포인트 2 §1 —
 * "satisfies Record<BothInvokeChannel, Handler>" 강제의 구현체). desktop 전용(openDocs·update 7종)은
 * 미등록 — ws-host 가 미지 채널을 명시 에러 res 로 응답한다(hang 금지).
 */
type ChannelMethodMap = {
  'fleet:app:info': 'getAppInfo'
  'fleet:cli:detect': 'detectClis'
  'fleet:cli:adapters': 'listAdapters'
  'fleet:cli:probe': 'probeCli'
  'fleet:session:registerCli': 'registerCliSession'
  'fleet:session:registerApi': 'registerApiSession'
  'fleet:session:list': 'listSessions'
  'fleet:session:remove': 'removeSession'
  'fleet:session:capabilities': 'setSessionCapabilities'
  'fleet:session:listModels': 'listModels'
  'fleet:project:list': 'listProjects'
  'fleet:project:tasks': 'getProjectTasks'
  'fleet:project:events': 'listProjectEvents'
  'fleet:project:lastActive:get': 'getLastActiveProject'
  'fleet:project:lastActive:set': 'setLastActiveProject'
  'fleet:project:run': 'runProject'
  'fleet:project:cancel': 'cancelRun'
  'fleet:project:activity': 'getRunActivity'
  'fleet:workspace:get': 'getWorkspace'
  'fleet:workspace:select': 'selectWorkspace'
  'fleet:workspace:set': 'setWorkspace'
  'fleet:chat:createRoom': 'createRoom'
  'fleet:chat:listRooms': 'listRooms'
  'fleet:chat:history': 'roomHistory'
  'fleet:chat:postUser': 'postUserMessage'
  'fleet:chat:askLlm': 'askLlm'
  'fleet:chat:discuss': 'discussRoom'
  'fleet:chat:cancel': 'cancelChat'
  'fleet:chat:activity': 'getChatActivity'
  'fleet:mcp:setServers': 'setMcpServers'
  'fleet:mcp:getStatus': 'getMcpStatus'
  'fleet:events:list': 'listEvents'
  'fleet:approval:respond': 'respondApproval'
  'fleet:approval:pending': 'listPendingApprovals'
}

// 매핑 완전성 핀 — 키 집합이 BothInvokeChannel 과 정확히 일치하지 않으면(누락/잉여) 컴파일 에러.
type AssertExact<A, B> = [A, B] extends [B, A] ? true : never
const _channelMapExhaustive: AssertExact<keyof ChannelMethodMap, BothInvokeChannel> = true
void _channelMapExhaustive

/** FleetBridge 메서드 M 에서 파생한 서버 핸들러 시그니처 — 동기 반환(Awaited)도 허용. */
type HandlerOf<M extends keyof FleetBridge> = (
  ...args: Parameters<FleetBridge[M]>
) => ReturnType<FleetBridge[M]> | Awaited<ReturnType<FleetBridge[M]>>

export type HandlerTable = { [C in BothInvokeChannel]: HandlerOf<ChannelMethodMap[C]> }

export interface HandlerDeps {
  engine: FleetEngine
  approver: IpcApprover
  /** boot 이 조립(version 산출·runtime:'web' 스탬프). */
  appInfo: AppInfo
  /** FLEET_WORKSPACE_ROOT(정규화) — workspace:set 의 허용 루트. null = 경로 설정 미지원. */
  workspaceRoot: string | null
}

export function createHandlers({
  engine,
  approver,
  appInfo,
  workspaceRoot,
}: HandlerDeps): HandlerTable {
  return {
    'fleet:app:info': () => appInfo,

    // ── 세션 / CLI ──
    'fleet:cli:detect': () => engine.detectClis(),
    'fleet:cli:adapters': () => engine.listAdapters(),
    'fleet:cli:probe': (adapterId) => engine.probeCli(adapterId),
    'fleet:session:registerCli': (adapterId, opts) => engine.registerCliSession(adapterId, opts),
    'fleet:session:registerApi': (config) => engine.registerApiSession(config),
    'fleet:session:list': () => engine.listSessions(),
    'fleet:session:remove': (id) => engine.removeSession(id),
    'fleet:session:capabilities': (id, roles) => engine.setSessionCapabilities(id, roles),
    'fleet:session:listModels': (config) => engine.listProviderModels(config),

    // ── 프로젝트 / 오케스트레이션 ──
    'fleet:project:list': () => engine.listProjects(),
    'fleet:project:tasks': (projectId) => engine.getProjectTasks(projectId),
    'fleet:project:events': (projectId) => engine.listProjectEvents(projectId),
    'fleet:project:lastActive:get': () => engine.getLastActiveProject(),
    'fleet:project:lastActive:set': (projectId) => engine.setLastActiveProject(projectId),
    'fleet:project:run': (req) => engine.runProjectFlow(req),
    'fleet:project:cancel': (projectId) => engine.cancelRun(projectId),
    'fleet:project:activity': () => engine.getRunActivity(),
    'fleet:workspace:get': () => engine.getWorkspace(),
    // 헤드리스 서버엔 dialog 가 없다 — Electron "dialog 취소" 와 동형으로 현 워크스페이스 반환.
    // 웹의 경로 설정은 B4 `fleet:workspace:set`(FLEET_WORKSPACE_ROOT 하위 한정) 몫.
    'fleet:workspace:select': () => engine.getWorkspace(),
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

    // ── 채팅 ──
    'fleet:chat:createRoom': (title, participants) => engine.createRoom(title, participants),
    'fleet:chat:listRooms': () => engine.listRooms(),
    'fleet:chat:history': (roomId) => engine.roomHistory(roomId),
    'fleet:chat:postUser': (roomId, content) => engine.postUserMessage(roomId, content),
    'fleet:chat:askLlm': (roomId, llmId) => engine.askLlm(roomId, llmId),
    'fleet:chat:discuss': (roomId, llmIds, rounds) => engine.discussRoom(roomId, llmIds, rounds),
    'fleet:chat:cancel': (roomId) => engine.cancelChat(roomId),
    'fleet:chat:activity': () => engine.getChatActivity(),

    // ── MCP 호스트 ──
    'fleet:mcp:setServers': (servers) => engine.setMcpServers(servers),
    'fleet:mcp:getStatus': () => engine.getMcpStatus(),

    // ── 감사 / 승인 ──
    'fleet:events:list': () => engine.listEvents(),
    'fleet:approval:respond': (id, approved) => {
      approver.resolve(id, approved)
    },
    // 미만료 대기 승인 스냅숏(#216 C1) — 재하이드레이션 권위. approver.list() 는 순수 필터(비파괴).
    'fleet:approval:pending': () => approver.list(),
  } satisfies HandlerTable
}
