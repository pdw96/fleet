import type { BothInvokeChannel } from './channels'

/**
 * 채널 직렬화 계약 fixture(#197 B2) — `serialization.test.ts` 의 JSON 왕복 검사 입력이자 B3 server
 * 핸들러 round-trip 재사용 기반. 각 both invoke 채널의 **대표 args/result**(정확한 타입 충실도가 아니라
 * 와이어 shape 의 JSON 안전성 검증이 목적)를 둔다. `satisfies Record<BothInvokeChannel, ChannelFixture>`
 * 로 both invoke 집합 전체를 tsc 가 강제한다 — 채널 신설 시 fixture 누락은 컴파일 에러.
 *
 * void 반환(제거/취소/설정 채널)은 `result: undefined` — 프로토콜이 res 프레임에서 value 를 생략한다.
 */
export interface ChannelFixture {
  args: unknown[]
  result: unknown
}

export const CHANNEL_FIXTURES = {
  // ── 앱 메타 ──
  'fleet:app:info': {
    args: [],
    result: { name: 'Fleet', version: '0.1.0', electron: '', node: '', chrome: '', runtime: 'web' },
  },

  // ── 세션 / CLI ──
  'fleet:cli:detect': { args: [], result: [] },
  'fleet:cli:adapters': { args: [], result: [] },
  'fleet:cli:probe': { args: ['claude'], result: { status: 'ok' } },
  // (fleet:external:openDocs 는 desktop 전용 — 웹은 shared 정적 docsUrl 동기 open, 서버 미등록.)
  'fleet:session:registerCli': {
    args: ['claude', { stateful: true }],
    result: { id: 'cli:claude', kind: 'cli', displayName: 'Claude', ref: 'claude' },
  },
  'fleet:session:registerApi': {
    args: [{ id: 'p1', provider: 'anthropic', displayName: 'Sonnet', model: 'claude-sonnet-5' }],
    result: { id: 'api:p1', kind: 'api', displayName: 'Sonnet', ref: 'p1' },
  },
  'fleet:session:list': { args: [], result: [] },
  'fleet:session:remove': { args: ['api:p1'], result: undefined },
  'fleet:session:capabilities': {
    args: ['api:p1', ['planner', 'reviewer']],
    result: { id: 'api:p1', kind: 'api', displayName: 'Sonnet', ref: 'p1' },
  },
  'fleet:session:listModels': {
    args: [{ id: 'p1', provider: 'openai', displayName: 'GPT', model: 'gpt-5' }],
    result: [{ id: 'gpt-5', label: 'GPT-5' }],
  },

  // ── 프로젝트 / 오케스트레이션 ──
  'fleet:project:list': { args: [], result: [] },
  'fleet:project:tasks': { args: ['proj-1'], result: [] },
  'fleet:project:events': { args: ['proj-1'], result: [] },
  'fleet:project:lastActive:get': { args: [], result: null },
  'fleet:project:lastActive:set': { args: ['proj-1'], result: undefined },
  'fleet:project:run': {
    args: [{ goal: 'build a login page', maxConcurrency: 2 }],
    result: { projectId: 'proj-1', tasks: [], summary: '완료' },
  },
  'fleet:project:cancel': { args: ['proj-1'], result: undefined },
  'fleet:project:activity': { args: [], result: { activeProjectIds: [] } },
  'fleet:workspace:get': { args: [], result: null },
  'fleet:workspace:select': { args: [], result: null },
  'fleet:workspace:set': { args: ['proj-a'], result: '/srv/workspace/proj-a' },

  // ── 채팅 ──
  'fleet:chat:createRoom': {
    args: ['My Room', ['llm-1']],
    result: { id: 'room-1', title: 'My Room', participants: ['llm-1'], createdAt: 0 },
  },
  'fleet:chat:listRooms': { args: [], result: [] },
  'fleet:chat:history': { args: ['room-1'], result: [] },
  'fleet:chat:postUser': {
    args: ['room-1', '안녕'],
    result: { id: 'msg-1', roomId: 'room-1', author: { type: 'user' }, content: '안녕', ts: 0 },
  },
  'fleet:chat:askLlm': {
    args: ['room-1', 'llm-1'],
    result: {
      id: 'msg-2',
      roomId: 'room-1',
      author: { type: 'llm', llmId: 'llm-1' },
      content: '응답',
      ts: 0,
    },
  },
  'fleet:chat:discuss': { args: ['room-1', ['llm-1', 'llm-2'], 2], result: [] },
  'fleet:chat:cancel': { args: ['room-1'], result: undefined },
  'fleet:chat:activity': { args: [], result: { busyRooms: [], streams: [] } },

  // ── MCP 호스트 ──
  'fleet:mcp:setServers': {
    args: [[{ name: 'ctx7', command: 'node', args: ['server.js'] }]],
    result: [],
  },
  'fleet:mcp:getStatus': { args: [], result: [] },

  // ── 감사 / 승인 ──
  'fleet:events:list': { args: [], result: [] },
  'fleet:approval:respond': { args: ['appr-1', true], result: undefined },
  'fleet:approval:pending': {
    args: [],
    result: [
      {
        id: 'appr-1',
        kind: 'tool-call',
        summary: '도구 호출: danger',
        target: 'danger',
        risk: 'destructive',
        ts: 0,
        expiresAt: 600_000,
      },
    ],
  },
} as const satisfies Record<BothInvokeChannel, ChannelFixture>
