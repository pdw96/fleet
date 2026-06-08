# MCP 호스트(API provider 경로) (SP2) — 설계

- 날짜: 2026-06-08
- 브랜치(예정): `feat/mcp-host`
- 출처 이슈: [#10](https://github.com/pdw96/fleet/issues/10) "후속: 도구 실행 루프 + 도구 소스(MCP 호스트 Track 2)"
- 범위: 이슈 #10의 **SP2(MCP 호스트 Track 2)** 만. SP1(도구 실행 루프 + provider tool_result 매핑)은 PR #16에 머지 완료. SP3(스트리밍+도구)는 후속.
- 선행 스펙: [`2026-06-08-tool-execution-loop-sp1-design.md`](./2026-06-08-tool-execution-loop-sp1-design.md)

## 배경

SP1에서 도구 실행 루프(`runToolLoop`)·도구 레지스트리(`createToolRegistry`)·워크스페이스 읽기전용 내장 도구·`ApprovalGate`의 `'tool-call'` kind·감사 이벤트(`tool.requested`/`tool.executed`/`tool.failed`)를 완성했다. SP1 설계의 §범위 밖은 SP2를 이렇게 못박았다:

> **SP2** — MCP 클라이언트/호스트(Track 2): Fleet=MCP 클라이언트(stdio JSON-RPC: initialize/tools/list/tools/call) → SP1 레지스트리에 MCP 도구 주입 + 승인 정책.

또한 SP1은 `'tool-call'` kind를 "SP2의 임의 부작용 MCP 도구를 위한 게이팅 계약을 지금 확립하는 역할"로 도입했다. 즉 **SP2는 새 실행/게이팅 메커니즘을 만들지 않는다** — 외부 MCP 서버의 도구를 SP1 `FleetTool`로 감싸 기존 레지스트리·루프·게이트에 얹는 어댑터 계층이다.

현재 CLI 세션(claude)은 `--mcp-config` 패스스루(#9)로 자체 MCP 호스팅을 한다. **API provider 경로의 호스트만 미구현**이며 SP2가 이를 채운다(CLI 경로는 불변).

## 확정된 결정 (브레인스토밍)

| 항목 | 결정 | 근거 |
|---|---|---|
| 클라이언트 구현 | **직접 구현**(hand-rolled stdio JSON-RPC). 공식 SDK 미사용 | 외부 의존 0·순수 코어·electron 비의존·vitest 전 계층 검증(AGENTS.md 아키텍처 규칙). 필요한 서브셋(initialize/tools/list/tools/call)만 소유 |
| 설정·생명주기 | **엔진 레벨 공유**. `setMcpServers` 로 pre-warm(연결·도구 발견) 후 캐시, 연결 재사용, 모든 API 세션 공용 | `setWorkspace` 패턴과 동형. pre-warm 으로 SP1 `registry.list()` 동기 계약 유지(루프 무수정) |
| 위험도 기본 | **`destructive` 기본**. ~~`annotations.readOnlyHint===true` → `caution`(자동승인)~~ → **항상 destructive 로 강화**(아래 변경 이력) | 안전 우선(AGENTS.md). 게이트가 `caution` 자동승인이므로 미상 부작용 도구의 조용한 실행 차단 |
| 범위 | **코어+엔진+IPC**, 렌더러 최소. `store` 영속·본격 UX 는 후속 | SP1 과 동일한 "순수 코어 우선·최소 IPC 표면" 전략. 세션처럼 런타임 제공 |
| transport | stdio 만 | 이슈가 stdio JSON-RPC 로 명시. SSE/HTTP 는 후속 |

> **변경 이력 (PR [#18](https://github.com/pdw96/fleet/pull/18) Codex 리뷰 반영, 2026-06-08):** 아래 두 안전 결정을 구현 중 강화했다 — 이 절의 원안보다 코드/PR 이 우선한다.
> - **위험도**: `readOnlyHint===true → caution`(자동승인) 폐기. MCP annotations 는 신뢰 서버 외엔 untrusted 다(MCP 스펙)이므로 **모든 MCP 도구를 항상 `destructive`** 로 분류한다(승인 게이트 강제).
> - **spawn 게이팅**: 새 MCP 서버 spawn 은 임의 로컬 프로세스 실행이라 `ApprovalGate({kind:'shell', risk:'destructive'})` 를 통과해야 한다(AGENTS.md "shell→ApprovalGate"). "신뢰 경계=등록"만으로는 부족 — 등록 시점에 사용자 승인을 강제한다.

---

## 아키텍처

새 코어 모듈 `src/main/core/mcp/`(순수 TS, electron 비의존). 레이어 의존:
`providers/`·`safety/` ← `tools/` ← `mcp/` ← `session/`(기존)·`engine.ts`. 순환 없음.
관심사를 transport(프레이밍) / client(프로토콜) / wrap(도구 어댑터) / host(다중 연결 관리)로 분리해 각각 독립 테스트한다.

```
[설정]  renderer → IPC setMcpServers(specs) → engine.setMcpServers
   → mcpHost.setServers(specs):
        diff(현재 캐시 vs 신규): 제거/변경 서버 close, 추가/변경 서버 connect
        connect = spawn → initialize → notifications/initialized → tools/list
        서버별로 격리: 한 서버 실패해도 나머지 진행, status.error 기록, 감사 이벤트
        성공 서버의 도구를 FleetTool[] 로 감싸 캐시

[실행]  askLlm / orchestrator → session.send(prompt)
   → toolDeps(): registry = createToolRegistry([ ...(워크스페이스 도구), ...mcpHost.tools() ])
   → runToolLoop (SP1 그대로):
        tool_use(name=mcp__server__tool) → registry.get → gate.request({kind:'tool-call', risk}) →
        FleetTool.execute → host 가 해당 client.callTool(원래이름, args, {signal}) →
        결과 content → 문자열 → tool_result 회신 → 모델 재호출
```

`mcpHost.tools()` 는 **동기**로 캐시된 `FleetTool[]` 을 돌려준다(연결·발견은 `setServers` 에서 이미 완료). 따라서 SP1 의 `ToolRegistry.list()` 동기 계약과 `runToolLoop` 은 **무수정**이다.

MCP 도구는 워크스페이스가 없어도 동작한다(외부 프로세스). 따라서 `toolDeps` 는 **워크스페이스 OR MCP 도구가 하나라도 있으면** 활성화한다(현재의 워크스페이스 전용 게이팅을 완화). CLI 세션은 자체 MCP 호스팅이므로 SP2 호스트를 쓰지 않는다(SP1 과 동일하게 제외).

---

## 컴포넌트 / 파일

### 신규 `src/main/core/mcp/`

**`types.ts`** — 계약(런타임 의존 없음).
```ts
/** 등록할 MCP 서버 사양(stdio). */
export interface McpServerSpec {
  /** 고유 서버 식별자. 도구 이름 프리픽스에 쓰인다(mcp__<name>__<tool>). */
  name: string
  command: string
  args?: string[]
  /** process.env 위에 병합할 환경변수. */
  env?: Record<string, string>
  cwd?: string
}

/** 서버 연결 상태(IPC 로 렌더러에 전달). */
export interface McpServerStatus {
  name: string
  connected: boolean
  /** 노출된(프리픽스된) 도구 수. */
  toolCount: number
  /** 노출된 도구 이름(프리픽스 포함). */
  tools: string[]
  /** 연결 실패/오류 메시지(있으면). */
  error?: string
}

/** child process 의 최소 추상(테스트에서 fake 주입, electron/Node 타입 비노출). */
export interface McpChild {
  /** 한 줄(개행 포함) 직렬화 메시지를 stdin 으로 쓴다. */
  write(line: string): void
  /** stdout 바이트/문자 청크. */
  onStdout(handler: (chunk: string) => void): void
  /** stderr 청크(진단용). */
  onStderr(handler: (chunk: string) => void): void
  /** 프로세스 종료/오류. err 는 spawn 실패 등. */
  onClose(handler: (err?: Error) => void): void
  kill(): void
}

export type SpawnFn = (spec: McpServerSpec) => McpChild

/** JSON-RPC 메시지를 주고받는 transport(프레이밍 캡슐화). */
export interface McpTransport {
  send(message: Record<string, unknown>): void
  onMessage(handler: (msg: Record<string, unknown>) => void): void
  onClose(handler: (err?: Error) => void): void
  close(): void
}
```

**`stdio.ts`** — `createStdioTransport(spec, spawn): McpTransport`.
- `spawn(spec)` 로 자식을 띄우고 stdout 을 **개행 구분 JSON** 으로 프레이밍한다(MCP stdio: 메시지는 개행으로 구분되며 내부 개행 없음). 부분 청크는 버퍼에 모았다가 `\n` 단위로 잘라 `JSON.parse` 후 `onMessage`.
- `send(msg)` = `child.write(JSON.stringify(msg) + '\n')`.
- 파싱 실패 라인은 버리고 감사/경고로 남긴다(전체 연결을 깨지 않음).
- `child.onClose` → `onClose` 전파.
- `defaultSpawn: SpawnFn` 도 여기(또는 별 파일)에서 제공: `cross-spawn` 으로 `command/args`, `env={...process.env, ...spec.env}`, `cwd`, `stdio:['pipe','pipe','pipe']`. stdout/stderr `setEncoding('utf8')`. `'exit'`·`'error'` → onClose. **cross-spawn 은 이미 의존성**(새 의존 0).

**`client.ts`** — `createMcpClient(transport, opts?): McpClient`.
```ts
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown }
}
export interface McpCallResult {
  content: Array<Record<string, unknown>> // {type:'text',text} | {type:'image',data,mimeType} | {type:'resource',...}
  isError?: boolean
}
export interface McpClient {
  initialize(): Promise<void>   // initialize → notifications/initialized
  listTools(): Promise<McpToolInfo[]>
  callTool(name: string, args: unknown, opts?: { signal?: AbortSignal }): Promise<McpCallResult>
  close(): void
}
export interface McpClientOptions {
  requestTimeoutMs?: number // 기본 30_000
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown   // 테스트 주입(기본 setTimeout)
  clearTimer?: (h: unknown) => void
}
```
- JSON-RPC 2.0: 요청 `{jsonrpc:'2.0', id, method, params}`, 응답을 `id` 로 상관. pending 맵 `id → {resolve, reject, timer}`.
- `initialize` params: `{ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name:'fleet', version } }`. 결과 수신 후 `notifications/initialized`(id 없는 알림) 전송. 서버가 더 낮은 protocolVersion 을 echo 해도 하드 실패하지 않고 진행(로그).
- `tools/list` → `result.tools: McpToolInfo[]`(없으면 `[]`). **nextCursor 를 따라 모든 페이지를 모은다**(#19) — 결정론적 종료: 동일 커서 반복·페이지 상한(100) 초과 시 경고 후 중단해 무한 페이지네이션을 막는다.
- `tools/call` params `{ name, arguments }` → `result: McpCallResult`. 응답 `error` 필드면 reject.
- **요청 타임아웃**: pending 마다 타이머; 초과 시 reject(`'MCP 요청 타임아웃'`)하고 pending 제거. 진행 중이던 요청엔 `notifications/cancelled`(아래 abort 참조) 전송.
- **abort/취소**: `opts.signal` 또는 타임아웃 → 로컬 reject + pending 제거 후, in-flight 였던 요청에 `notifications/cancelled{requestId, reason}` 전송(서버측 long-running/destructive 도구 중단 — #19). `initialize` 는 취소 불가(스펙)이며, 이미 완료/연결 종료된 요청엔 보내지 않는다. 스펙: https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
- **transport close**(자식 크래시 등): 모든 pending reject, 이후 호출은 즉시 reject.
- `PROTOCOL_VERSION = '2025-06-18'` 상수.

**`wrap.ts`** — MCP 도구 1개를 `FleetTool` 로 감싼다.
```ts
export function wrapMcpTool(serverName: string, tool: McpToolInfo, client: McpClient): FleetTool | null
```
- `definition.name = mcp__<sanitize(serverName)>__<sanitize(tool.name)>`. sanitize = `[^A-Za-z0-9_-]` → `_`. 최종 이름 길이 > 64 면 **null 반환**(호출자가 skip + 감사 경고; provider 이름 제약 위반을 silent 로 넘기지 않음 — #7).
- `definition.description = tool.description`, `definition.parameters = tool.inputSchema ?? { type:'object' }`.
- `classify`: 항상 `'destructive'`(annotations 는 untrusted — 변경 이력 참조).
- `execute(input, ctx)`: `const r = await client.callTool(tool.name, input, { signal: ctx.signal })`. `r.content` → 문자열(아래 §결과 매핑). `r.isError` → throw(루프가 isError tool_result 로 회신).

**`host.ts`** — `createMcpHost({ spawn? }): McpHost`.
```ts
export interface McpHost {
  setServers(specs: McpServerSpec[]): Promise<McpServerStatus[]>
  tools(): FleetTool[]            // 캐시된 모든 연결 서버의 FleetTool(동기)
  status(): McpServerStatus[]
  dispose(): Promise<void>        // 모든 client.close()
}
```
- 내부 상태: `Map<serverName, { spec; client; tools: FleetTool[]; status: McpServerStatus }>`.
- `setServers`: 신규 spec 목록과 현재 캐시를 diff.
  - 중복 `name` 은 throw(silent override 금지, 레지스트리와 동일 철학).
  - 제거/변경(command/args/env/cwd 상이) 서버 → `client.close()` 후 캐시 제거.
  - 추가/변경 서버 → `createStdioTransport(spec, spawn)` → `createMcpClient` → `initialize` → `listTools` → 각 도구 `wrapMcpTool`(null=skip+경고). **서버별 try/catch 로 격리**: 실패 서버는 `status.connected=false, error=msg` 로 기록하고 client.close(), 나머지 진행.
  - 변경 없는 서버는 기존 연결 유지(재spawn 금지).
  - 감사: `mcp.server.connected{name,toolCount}` / `mcp.server.failed{name,error}` / `mcp.server.disconnected{name}`.
  - 반환: 전 서버 `McpServerStatus[]`.
- `tools()`: 모든 연결 서버의 `FleetTool[]` flatten(동기, 캐시).
- `dispose()`: 모든 client.close(), 캐시 클리어.
- `spawn` 기본값 = `defaultSpawn`(stdio.ts). 테스트는 fake `spawn` 주입.
- 감사 싱크: 생성 시 `onAudit?` 주입(엔진의 `appendAudit`).

### 수정

- **`src/shared/types.ts`** — `McpServerSpec`·`McpServerStatus` 추가(IPC 표면). `FleetBridge` 에:
  ```ts
  /** MCP 서버 목록 설정(전체 교체). 연결 후 서버별 상태를 반환. */
  setMcpServers(servers: McpServerSpec[]): Promise<McpServerStatus[]>
  /** 현재 MCP 서버 연결 상태/도구 목록. */
  getMcpStatus(): Promise<McpServerStatus[]>
  ```
- **`src/main/core/engine.ts`**:
  - `import { createMcpHost, type McpHost } from './mcp/host'`.
  - `FleetEngineOptions` 에 `mcpHost?: McpHost`(테스트 주입; 기본 `createMcpHost({ spawn: defaultSpawn, onAudit: appendAudit })`).
  - `FleetEngine` 인터페이스에 `setMcpServers(servers): Promise<McpServerStatus[]>`·`getMcpStatus(): McpServerStatus[]`·`dispose(): Promise<void>` 추가.
  - `registerApiSession` 의 `toolDeps` 클로저 수정:
    ```ts
    toolDeps: () => {
      const wsTools = workspaceDir ? createWorkspaceReadTools(workspaceDir) : []
      const mcpTools = mcpHost.tools()
      if (wsTools.length === 0 && mcpTools.length === 0) return undefined
      return { registry: createToolRegistry([...wsTools, ...mcpTools]), gate, onAudit: appendAudit, maxIterations: 8 }
    }
    ```
  - `setMcpServers`/`getMcpStatus` 는 `mcpHost` 위임 + `store.appendEvent('mcp.servers.set', ...)`.
  - `dispose` 는 `mcpHost.dispose()`(+ 향후 다른 정리).
- **`src/main/index.ts`** — IPC 핸들러 `mcp:setServers`·`mcp:getStatus` 등록, preload 브리지 노출, app 종료(`will-quit`/`before-quit`)에 `engine.dispose()` 배선(자식 프로세스 정리). 기존 IPC 등록 패턴 따름.
- **`src/preload/index.ts`** — `setMcpServers`·`getMcpStatus` 브리지 추가. ⚠ **preload/IPC 변경 후 `npm run dev` 재시작 필수**(electron-vite preload 핫리로드 안 됨; AGENTS.md 함정).
- **렌더러(최소)** — 기존 설정/세션 화면에 MCP 서버 패널: `McpServerSpec[]` JSON 입력 → `setMcpServers` 호출 → `getMcpStatus` 로 서버별 연결/도구 수/오류 표시. 무거운 add/remove 폼·검증·`store` 영속은 후속. (구현 시 기존 컴포넌트 구조 확인 후 최소 추가.)

## 결과 매핑 (MCP `tools/call` content → 문자열)

`McpCallResult.content` 는 항목 배열이다. `FleetTool.execute` 는 문자열을 반환해야 하므로:
- `{type:'text', text}` → `text` 그대로.
- `{type:'image', mimeType, data}` → `[image <mimeType> <base64 길이>바이트]` placeholder(본문 미포함 — 컨텍스트 폭주 방지).
- `{type:'resource', resource}` → `[resource <uri 또는 요약>]`.
- 그 외 미상 타입 → `[<type>]`.
- 항목들을 `\n` 으로 결합. **총 길이 바운드**(예: 64KB) 초과 시 잘라내고 `…(N바이트 중 …표시)` 표기(워크스페이스 `read_file` 과 동일 관용).
- `isError === true` → `execute` 가 결합 문자열(없으면 'MCP 도구 오류')로 throw.

## 안전 (AGENTS.md "안전 우선")

- 모든 MCP 도구 실행은 SP1 루프의 `gate.request({kind:'tool-call', ...})` 를 통과한다(SP2 신규 게이팅 없음 — 계약 재사용).
- **모든 MCP 도구는 `destructive`**(approver 필요) — annotations(readOnlyHint)는 untrusted 라 자동승인 강등에 쓰지 않는다(변경 이력). 게이트의 `autoApprove:['safe','caution']` 정책상 모든 MCP 도구 호출은 사용자 승인 모달을 띄운다.
- 이름 프리픽스 `mcp__<server>__<tool>` 로 워크스페이스 도구·타 서버와 충돌 차단. 서버명 유일(host diff 에서 강제) + 서버 내 도구명 유일(MCP 규약) → 전역 유일. provider 이름 제약(`[A-Za-z0-9_-]{1,64}`) 초과 도구는 skip + 감사 경고.
- 자식 프로세스는 `command/args/env` 가 그대로 실행되므로(임의 바이너리) **새 서버 spawn 은 `ApprovalGate({kind:'shell', risk:'destructive'})` 를 통과해야 한다**(변경 이력) — 등록은 사용자 IPC 명시 + spawn 시점 승인. 도구 호출 자체도 위 게이트로 추가 게이팅.
- 모든 연결/실패/도구 호출을 감사 로그로 남긴다(관측성).

## 에러 / 종료 (결정론적)

- 서버 연결 실패(spawn 오류·initialize 타임아웃) → 해당 서버만 `connected:false`+error, 나머지 격리 진행. 도구 0개.
- 도구 호출 타임아웃(기본 30s)·`isError`·자식 크래시 → 해당 호출 isError tool_result(루프 계속, 모델이 대응). 호스트/엔진은 크래시하지 않는다.
- abort 신호/타임아웃 → pending reject 전파 + 서버에 `notifications/cancelled` 전송(#19, in-flight·non-initialize 한정).
- `dispose` 로 모든 자식 종료(좀비 프로세스 방지). main 의 app 종료에 배선.

## 테스트 (게이트: typecheck/lint/test/build 모두 통과)

- `mcp/stdio.test.ts` — fake `McpChild` 주입: 개행 프레이밍(여러 메시지 한 청크/한 메시지 여러 청크), 부분 라인 버퍼링, 잘못된 JSON 라인 스킵, 자식 close 전파, send 직렬화(+개행).
- `mcp/client.test.ts` — fake transport(인메모리): initialize→initialized 순서, tools/list 파싱·페이지네이션(nextCursor 추종·동일 커서 반복 중단·페이지 상한), tools/call 결과·`error`→reject, 요청 타임아웃(setTimer 주입), abort→reject, transport close→pending reject.
- `mcp/wrap.test.ts` — 이름 프리픽스·sanitize·64자 초과 null·빈 이름 null, description/parameters 매핑, 항상 destructive(annotations untrusted), content 매핑(text/image/resource/혼합), 길이 바운드, isError→throw.
- `mcp/host.test.ts` — fake spawn(JSON-RPC 응답 스크립트): 다중 서버 연결·`tools()` 평탄화·서버 하나 실패 격리·중복 서버명 throw·re-setServers diff(미변경 유지·제거 close·변경 재연결)·dispose 전부 close·감사 이벤트.
- `engine.test.ts` 확장 — `mcpHost`(fake spawn) 주입: `setMcpServers` 후 API 세션 send 가 `mcp__*` 도구를 루프로 호출(워크스페이스 없이)·tool_result 회신·최종 텍스트; 워크스페이스+MCP 병합 시 비충돌; `getMcpStatus` 반환; `dispose` 가 client.close 호출.

## 범위 밖 (후속 서브프로젝트/이슈)

- SSE/Streamable HTTP transport(stdio 외).
- `store` 기반 MCP 서버 설정 영속(현재는 세션처럼 런타임 제공).
- MCP roots/sampling/prompts/resources, 도구 변경 알림(`notifications/tools/list_changed`). (서버측 `notifications/cancelled`·`tools/list` 페이지네이션은 #19 에서 구현됨.)
- 본격 렌더러 UX(서버 추가/제거 폼·연결 토글·도구 미리보기).
- SP3 — 도구 사용 중 스트리밍.
