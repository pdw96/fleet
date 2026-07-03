import { describe, expect, it } from 'vitest'
import type { FleetBridge } from '../../shared/types'
import { type BothInvokeChannel, invokeChannels } from '../../shared/transport/channels'
import { type ClientFrame } from '../../shared/transport/protocol'
import { createWsBridge, type WsLike } from './ws-bridge'

/**
 * FleetBridge 메서드 ↔ 채널/인자 바인딩 가드(#197 B2 리뷰 P3). bridge-parity 는 채널 '집합' 동등성만
 * 단언해, 시그니처가 같은 메서드끼리 채널을 맞바꾸거나(getWorkspace↔selectWorkspace) 인자 순서를
 * 뒤집어도(askLlm/postUserMessage) 무탐지로 통과한다. 이 테이블은 각 both-invoke 메서드를 대표 인자로
 * 실제 구동해 **방출된 ReqFrame 의 ch·args** 를 단언 — 오배선/인자 drift 를 구조적으로 막는다.
 * (tsc 는 invoke<T> 반환형·메서드명만 강제하고 채널 리터럴 문자열은 못 본다.)
 */

class CaptureWs implements WsLike {
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err?: unknown) => void) | null = null
  readonly sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
}

// method: FleetBridge 키 · channel: both-invoke 채널 · args: 후행 undefined 없는 대표 인자(트림 무관).
const BINDINGS: readonly {
  method: keyof FleetBridge & string
  channel: BothInvokeChannel
  args: unknown[]
}[] = [
  { method: 'getAppInfo', channel: 'fleet:app:info', args: [] },
  { method: 'detectClis', channel: 'fleet:cli:detect', args: [] },
  { method: 'listAdapters', channel: 'fleet:cli:adapters', args: [] },
  { method: 'probeCli', channel: 'fleet:cli:probe', args: ['claude'] },
  // openCliDocs 는 wire 를 안 태우고 shared 정적 docsUrl 을 동기 open 하므로 채널 바인딩 테이블에서 제외
  // (external:openDocs 는 desktop 전용). 클라 도출 동작은 ws-bridge.test.ts 가 검증.
  {
    method: 'registerCliSession',
    channel: 'fleet:session:registerCli',
    args: ['claude', { stateful: true }],
  },
  { method: 'registerApiSession', channel: 'fleet:session:registerApi', args: [{ id: 'p1' }] },
  { method: 'listSessions', channel: 'fleet:session:list', args: [] },
  { method: 'removeSession', channel: 'fleet:session:remove', args: ['api:p1'] },
  {
    method: 'setSessionCapabilities',
    channel: 'fleet:session:capabilities',
    args: ['api:p1', ['planner']],
  },
  { method: 'listModels', channel: 'fleet:session:listModels', args: [{ id: 'p1' }] },
  { method: 'listProjects', channel: 'fleet:project:list', args: [] },
  { method: 'getProjectTasks', channel: 'fleet:project:tasks', args: ['proj-1'] },
  { method: 'listProjectEvents', channel: 'fleet:project:events', args: ['proj-1'] },
  { method: 'getLastActiveProject', channel: 'fleet:project:lastActive:get', args: [] },
  { method: 'setLastActiveProject', channel: 'fleet:project:lastActive:set', args: ['proj-1'] },
  { method: 'runProject', channel: 'fleet:project:run', args: [{ goal: 'x' }] },
  { method: 'cancelRun', channel: 'fleet:project:cancel', args: ['proj-1'] },
  { method: 'getRunActivity', channel: 'fleet:project:activity', args: [] },
  { method: 'getWorkspace', channel: 'fleet:workspace:get', args: [] },
  { method: 'selectWorkspace', channel: 'fleet:workspace:select', args: [] },
  { method: 'createRoom', channel: 'fleet:chat:createRoom', args: ['My Room', ['llm-1']] },
  { method: 'listRooms', channel: 'fleet:chat:listRooms', args: [] },
  { method: 'roomHistory', channel: 'fleet:chat:history', args: ['room-1'] },
  { method: 'postUserMessage', channel: 'fleet:chat:postUser', args: ['room-1', '안녕'] },
  { method: 'askLlm', channel: 'fleet:chat:askLlm', args: ['room-1', 'llm-1'] },
  { method: 'discussRoom', channel: 'fleet:chat:discuss', args: ['room-1', ['llm-1'], 2] },
  { method: 'cancelChat', channel: 'fleet:chat:cancel', args: ['room-1'] },
  { method: 'getChatActivity', channel: 'fleet:chat:activity', args: [] },
  {
    method: 'setMcpServers',
    channel: 'fleet:mcp:setServers',
    args: [[{ name: 'x', command: 'node' }]],
  },
  { method: 'getMcpStatus', channel: 'fleet:mcp:getStatus', args: [] },
  { method: 'listEvents', channel: 'fleet:events:list', args: [] },
  { method: 'respondApproval', channel: 'fleet:approval:respond', args: ['appr-1', true] },
]

describe('FleetBridge 메서드 ↔ 채널/인자 바인딩', () => {
  it('테이블이 both-invoke 채널 전체를 정확히 덮는다(신규 채널 = 강제 추가)', () => {
    const covered = BINDINGS.map((b) => b.channel).sort()
    expect(new Set(covered).size).toBe(covered.length) // 중복 없음
    expect(covered).toEqual(invokeChannels('both'))
  })

  it.each(BINDINGS)('$method → $channel · args 순서/개수', ({ method, channel, args }) => {
    const ws = new CaptureWs()
    const bridge = createWsBridge({ connect: () => ws })
    ws.onopen?.()
    const fleet = bridge.fleet as unknown as Record<string, (...a: unknown[]) => unknown>
    void fleet[method](...args)
    const req = JSON.parse(ws.sent[ws.sent.length - 1]) as ClientFrame
    expect(req.ch).toBe(channel)
    expect(req.args).toEqual(args)
  })
})
