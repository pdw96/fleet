/**
 * 전송 채널 매니페스트(#197 B2) — main/preload/renderer(ws-bridge)/server 가 공유하는 순수 데이터.
 *
 * Electron IPC 를 WebSocket 으로 교체(문 ②: 브라우저 오케스트레이션 UI)하면서 채널 문자열 계약이
 * preload(리터럴)·ws-bridge(리터럴)·server 핸들러 테이블(B3) 세 면으로 흩어진다. 이 매니페스트가
 * 그 단일 출처다. **preload/main 은 현행 리터럴을 유지**(기존 `ipc-parity.test.ts` 전제·데스크톱
 * 무회귀)하고, `bridge-parity.test.ts` 가 매니페스트↔preload·ws-bridge↔매니페스트를 대조해 표류를
 * 컴파일타임 가까이로 끌어온다.
 *
 * scope 의미:
 *  - `both`    : 데스크톱(Electron main)·웹(server) 양쪽이 핸들. ws-bridge 는 WS 로 invoke/subscribe.
 *  - `desktop` : Electron 전용(자동 업데이트) — server 미등록. ws-bridge 는 로컬 no-op/idle 스텁
 *                (reject 아님 — UI 는 `AppInfo.runtime` 으로 표면을 숨긴다).
 */

export type ChannelKind = 'invoke' | 'push'
export type ChannelScope = 'both' | 'desktop'

export interface ChannelDecl {
  /** invoke=요청/응답(FleetBridge 메서드), push=main/server→클라 브로드캐스트(onXxx 구독). */
  kind: ChannelKind
  /** both=데스크톱·웹 공용, desktop=Electron 전용(웹 스텁). */
  scope: ChannelScope
}

/**
 * 전 채널 선언. 키는 preload/main 의 `'fleet:*'` 리터럴과 정확히 일치해야 한다(bridge-parity 가 강제).
 * `as const satisfies` 로 리터럴 타입을 보존하면서 각 값이 ChannelDecl 을 충족하는지 컴파일타임 검증한다.
 */
export const CHANNELS = {
  // ── 앱 메타 ──
  'fleet:app:info': { kind: 'invoke', scope: 'both' },

  // ── 세션 / CLI ──
  'fleet:cli:detect': { kind: 'invoke', scope: 'both' },
  'fleet:cli:adapters': { kind: 'invoke', scope: 'both' },
  'fleet:cli:probe': { kind: 'invoke', scope: 'both' },
  // 문서 열기: 데스크톱은 shell.openExternal(이 채널). 웹은 shared 정적 docsUrl 을 동기 window.open
  // 하므로 server 미등록 = desktop 전용(#197 B2 리뷰 — 팝업 차단·서버 URL 신뢰 회피).
  'fleet:external:openDocs': { kind: 'invoke', scope: 'desktop' },
  'fleet:session:registerCli': { kind: 'invoke', scope: 'both' },
  'fleet:session:registerApi': { kind: 'invoke', scope: 'both' },
  'fleet:session:list': { kind: 'invoke', scope: 'both' },
  'fleet:session:remove': { kind: 'invoke', scope: 'both' },
  'fleet:session:capabilities': { kind: 'invoke', scope: 'both' },
  'fleet:session:listModels': { kind: 'invoke', scope: 'both' },

  // ── 프로젝트 / 오케스트레이션 ──
  'fleet:project:list': { kind: 'invoke', scope: 'both' },
  'fleet:project:tasks': { kind: 'invoke', scope: 'both' },
  'fleet:project:events': { kind: 'invoke', scope: 'both' },
  'fleet:project:lastActive:get': { kind: 'invoke', scope: 'both' },
  'fleet:project:lastActive:set': { kind: 'invoke', scope: 'both' },
  'fleet:project:run': { kind: 'invoke', scope: 'both' },
  'fleet:project:cancel': { kind: 'invoke', scope: 'both' },
  'fleet:project:activity': { kind: 'invoke', scope: 'both' },
  'fleet:workspace:get': { kind: 'invoke', scope: 'both' },
  'fleet:workspace:select': { kind: 'invoke', scope: 'both' },
  // 웹 워크스페이스 경로 설정(#197 B4) — dialog 없는 웹의 selectWorkspace 대체 입력. 서버는
  // FLEET_WORKSPACE_ROOT 하위 한정 + 런 중 거부, 데스크톱 main 은 루트 env 미설정 시 fail-closed(비활성).
  'fleet:workspace:set': { kind: 'invoke', scope: 'both' },

  // ── 채팅 ──
  'fleet:chat:createRoom': { kind: 'invoke', scope: 'both' },
  'fleet:chat:listRooms': { kind: 'invoke', scope: 'both' },
  'fleet:chat:history': { kind: 'invoke', scope: 'both' },
  'fleet:chat:postUser': { kind: 'invoke', scope: 'both' },
  'fleet:chat:askLlm': { kind: 'invoke', scope: 'both' },
  'fleet:chat:discuss': { kind: 'invoke', scope: 'both' },
  'fleet:chat:cancel': { kind: 'invoke', scope: 'both' },
  'fleet:chat:activity': { kind: 'invoke', scope: 'both' },

  // ── MCP 호스트 ──
  'fleet:mcp:setServers': { kind: 'invoke', scope: 'both' },
  'fleet:mcp:getStatus': { kind: 'invoke', scope: 'both' },

  // ── 감사 / 승인 ──
  'fleet:events:list': { kind: 'invoke', scope: 'both' },
  'fleet:approval:respond': { kind: 'invoke', scope: 'both' },
  // 대기 승인 스냅숏(재하이드레이션 · #216 C1) — 후접속/재접속 클라가 놓친 카드 재제시.
  'fleet:approval:pending': { kind: 'invoke', scope: 'both' },

  // ── 자동 업데이트(Electron 전용) ──
  'fleet:update:getState': { kind: 'invoke', scope: 'desktop' },
  'fleet:update:check': { kind: 'invoke', scope: 'desktop' },
  'fleet:update:download': { kind: 'invoke', scope: 'desktop' },
  'fleet:update:install': { kind: 'invoke', scope: 'desktop' },
  'fleet:update:dismiss': { kind: 'invoke', scope: 'desktop' },
  'fleet:update:getChannel': { kind: 'invoke', scope: 'desktop' },
  'fleet:update:setChannel': { kind: 'invoke', scope: 'desktop' },

  // ── 푸시 스트림(main/server → 클라 브로드캐스트) ──
  'fleet:orchestrator:event': { kind: 'push', scope: 'both' },
  'fleet:chat:stream': { kind: 'push', scope: 'both' },
  'fleet:approval:request': { kind: 'push', scope: 'both' },
  // 승인 이탈(응답/만료/철회/취소) tombstone 브로드캐스트(bare string id · #216 C1).
  'fleet:approval:withdrawn': { kind: 'push', scope: 'both' },
  'fleet:update:event': { kind: 'push', scope: 'desktop' },
} as const satisfies Record<string, ChannelDecl>

/** 매니페스트에 선언된 모든 채널명. */
export type Channel = keyof typeof CHANNELS

/** invoke(요청/응답) 채널. */
export type InvokeChannel = {
  [K in Channel]: (typeof CHANNELS)[K]['kind'] extends 'invoke' ? K : never
}[Channel]

/** push(구독) 채널. */
export type PushChannel = {
  [K in Channel]: (typeof CHANNELS)[K]['kind'] extends 'push' ? K : never
}[Channel]

/**
 * both invoke 채널 — server(B3)가 반드시 핸들해야 하는 집합. B3 핸들러 테이블이
 * `satisfies Record<BothInvokeChannel, Handler>` 로 이 유니온을 강제해 시그니처 drift 를 tsc 로 막는다.
 */
export type BothInvokeChannel = {
  [K in Channel]: (typeof CHANNELS)[K] extends { kind: 'invoke'; scope: 'both' } ? K : never
}[Channel]

/** both push 채널 — ws-bridge 가 WS 구독하는 라이브 스트림 집합. */
export type BothPushChannel = {
  [K in Channel]: (typeof CHANNELS)[K] extends { kind: 'push'; scope: 'both' } ? K : never
}[Channel]

/** 매니페스트에서 kind(+선택 scope)로 필터한 채널명을 정렬해 반환(결정론적). */
export function invokeChannels(scope?: ChannelScope): Channel[] {
  return filterChannels('invoke', scope)
}

export function pushChannels(scope?: ChannelScope): Channel[] {
  return filterChannels('push', scope)
}

function filterChannels(kind: ChannelKind, scope?: ChannelScope): Channel[] {
  return (Object.keys(CHANNELS) as Channel[])
    .filter(
      (c) => CHANNELS[c].kind === kind && (scope === undefined || CHANNELS[c].scope === scope),
    )
    .sort()
}
