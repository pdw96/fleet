# 도구 실행 루프 + provider tool_result 매핑 (SP1) — 설계

- 날짜: 2026-06-08
- 브랜치(예정): `feat/tool-execution-loop`
- 출처 이슈: [#10](https://github.com/pdw96/fleet/issues/10) "후속: 도구 실행 루프 + 도구 소스(MCP 호스트 Track 2)"
- 범위: 이슈 #10을 3개 서브프로젝트로 분해한 것 중 **SP1**만. SP2(MCP 호스트)·SP3(스트리밍+도구)는 후속.

## 배경

키스톤(PR #15 `feat/ai-ecosystem-modernization`, 이슈 #1)에서 provider 계약을 tool-calling
대비로 진화시켰다. `ApiProvider.chat()`은 `opts.tools`(ToolDefinition[])를 받고
`ChatResult.toolCalls`(ToolUseBlock[])를 돌려준다. 그러나:

1. **도구 실행 루프와 도구 소스가 없다.** `toolCalls`는 코어 어디에서도 소비되지 않는다
   (`provider.chat()` 호출처는 `session/api-session.ts` 한 곳뿐이고 단발 호출이다).
2. **OpenAI/Gemini의 tool_result 매핑이 미완성이다.**
   - `providers/openai.ts:46-48` — tool_use/tool_result content가 text fallback. Chat Completions가
     요구하는 `assistant.tool_calls[]` + `role:'tool'` 메시지 구조 미구현.
   - `providers/google.ts:54` — `functionResponse`에 `b.toolUseId`를 `name`으로 넣는다. Gemini는
     함수 `name`으로 응답을 correlate 하므로 매칭되지 않는 결함.
   - Anthropic만 네이티브로 완성(`providers/anthropic.ts:45-48`).
3. **도구 사용 시 스트리밍이 차단된다**(`streaming = !!opts.onToken && !opts.tools?.length`) — SP3 범위.

SP1은 (1) 실행 루프 + 도구 레지스트리 + 내장(워크스페이스 읽기전용) 도구 소스와
(2) OpenAI/Gemini tool_result 매핑 완성을 다룬다. 외부 의존 0, 순수 코어라 vitest 로 E2E 검증한다.

## 확정된 결정

| 항목 | 결정 |
|---|---|
| 분해 | #10을 SP1/SP2/SP3으로 분해, 이번엔 SP1만 |
| 내장 도구 | 워크스페이스 읽기전용 세트: `read_file` · `list_directory` · `grep` · `glob` |
| 노출 범위 | 워크스페이스 설정 시 **모든 API 세션** send()(채팅 + 오케스트레이터) |
| 루프 위치 | `createApiSession.send()` 내부 캡슐화. `send()`의 `string` 반환 계약 불변. CLI 세션 제외(자체 MCP 호스팅) |
| 안전/승인 | `ApprovalGate` 경유, 새 `ApprovalRequest.kind: 'tool-call'`. 도구별 `classify`. 읽기전용=safe(자동승인)·민감파일=destructive·경로탈출=하드 거부 |
| 종료 | 기본 `maxIterations=8`(설정가능). 소진 시 여전히 tool_use면 명확한 Error(#7 철학) |
| 관측 | 감사 로그 이벤트(`tool.requested`/`tool.executed`/`tool.failed`)만. 라이브 UI는 SP3 |

---

## 아키텍처

새 코어 모듈 `src/main/core/tools/`(순수 TS, electron 비의존). 레이어 의존: `providers/` ← `tools/`
← `session/` (순환 없음). 도구 레지스트리/도구/루프는 IPC로 직렬화되지 않으므로 함수 필드를 둘 수
있다(IPC 직렬화되는 `CliAdapter`와 달리 제약 없음).

```
askLlm / orchestrator → session.send(prompt)
  └ toolDeps()?  → runToolLoop(provider, turns, {tools: registry.list(), toolChoice:'auto'}, deps)
       반복 (최대 maxIterations=8):
         result = await provider.chat(turns, {tools, signal})
         if finishReason !== 'tool_use' || toolCalls.length === 0 → return result   // 정상 종료
         turns.push({ role:'assistant', content: [text?, ...tool_use blocks] })
         for call of result.toolCalls:
           tool = registry.get(call.name)
           if !tool → isError "알 수 없는 도구"; onAudit('tool.failed'); continue   // 게이트 건너뜀
           risk = tool.classify(call.input)
           onAudit('tool.requested', {name, risk})
           decision = await gate.request({ kind:'tool-call', summary, target: call.name, risk })
           승인  → content = await tool.execute(call.input, {signal})   // throw → isError
           거부/throw → isError content
           onAudit('tool.executed'|'tool.failed', {...})
         turns.push({ role:'user', content: [tool_result(toolUseId, name, content, isError)...] })
       루프 소진(여전히 tool_use) → throw Error("도구 루프가 최대 N회를 초과했습니다 ...")
  → unwrap(ChatResult) → string → 호출자
```

`non-fresh` 세션은 누적 `history`를 그대로 확장(도구 왕복 턴 포함)해 멀티턴 정합을 보존한다.
`fresh` 호출은 임시 turns 배열에서 루프를 돌리고 폐기한다(오케스트레이터 독립성 유지).

## 컴포넌트 / 파일

### 신규 `src/main/core/tools/`

**`types.ts`**
```ts
export interface ToolContext { signal?: AbortSignal }

export interface FleetTool {
  definition: ToolDefinition          // providers/types 의 ToolDefinition (name·description·parameters JSON Schema)
  classify(input: unknown): RiskLevel // 입력 기반 위험도(게이트 통과 후 실행)
  execute(input: unknown, ctx: ToolContext): Promise<string> // 결과 문자열. 위반/오류는 throw
}

export interface ToolRegistry {
  list(): ToolDefinition[]
  get(name: string): FleetTool | undefined
  has(name: string): boolean
}

export interface ToolLoopDeps {
  registry: ToolRegistry
  gate: ApprovalGate
  onAudit?: (type: string, data: Record<string, unknown>) => void
  maxIterations?: number              // 기본 8
}
```

**`registry.ts`** — `createToolRegistry(tools: FleetTool[]): ToolRegistry`. name → FleetTool 맵.
중복 name 은 throw 로 충돌을 표면화한다(silent override 금지).

**`workspace-tools.ts`** — `createWorkspaceReadTools(root: string): FleetTool[]`. 모든 도구는 `root`
내부로 격리한다(아래 안전 절). 도구:
- `read_file({ path })` — 텍스트 파일 읽기. 최대 바이트 바운드(예: 256KB) 초과 시 잘라내고 표시.
  `classify`: `SENSITIVE_FILE` 매치 → `destructive`, 그 외 → `safe`.
- `list_directory({ path })` — 디렉터리 엔트리 목록(파일/디렉터리 구분). `classify`: `safe`.
- `grep({ pattern, path? })` — 내용 정규식 검색(바운드: 최대 스캔 파일 수·최대 결과 수). 민감파일
  제외. `safe-regex` 류 검증 또는 길이/복잡도 가드로 catastrophic regex 방어. `classify`: `safe`.
- `glob({ pattern })` — 파일명 글롭 매치(바운드). 민감파일 제외. `classify`: `safe`.

**`loop.ts`** — `runToolLoop(provider, turns, opts, deps): Promise<ChatResult>`. 위 의사코드.
순수 함수(주입된 provider/gate/registry만 의존) → 단위 테스트 용이.

### 수정

- **`providers/types.ts`** — `ToolResultBlock`에 `name?: string` 추가(도구 이름; Gemini가 name으로
  correlate). Anthropic/OpenAI는 `toolUseId` 사용, Gemini는 `name ?? toolUseId`.
- **`providers/openai.ts`** — 메시지 빌더를 `buildMessages(turns)`로 재작성:
  - assistant 턴이 tool_use 블록 포함 → `{ role:'assistant', content: <text|null>, tool_calls:[{ id, type:'function', function:{ name, arguments: JSON.stringify(input) } }] }`
  - tool_result 블록 포함 user 턴 → tool_result 당 `{ role:'tool', tool_call_id, content }` 메시지 N개
  - text/image content 매핑은 불변
- **`providers/google.ts`** — `mapParts`의 tool_result 분기를 `{ functionResponse: { name: b.name ?? b.toolUseId, response: { result: b.content } } }`로 수정.
- **`session/api-session.ts`** — `createApiSession(descriptor, provider, opts)`의 `opts`에
  `toolDeps?: () => ToolLoopDeps | undefined` 추가. `send()`는 `toolDeps?.()`가 truthy면
  `runToolLoop`로, 아니면 기존 `provider.chat` 단발로 분기(완전 하위호환). non-fresh는 history를
  루프에 전달해 도구 왕복 턴이 누적되게 하고, 루프 종료 후 최종 assistant 텍스트를 push.
- **`engine.ts`** — `registerApiSession`에서 toolDeps 클로저 주입:
  ```ts
  createApiSession(descriptor, createApiProvider(config, http), {
    toolDeps: () => workspaceDir
      ? { registry: createToolRegistry(createWorkspaceReadTools(workspaceDir)), gate, onAudit: appendAudit, maxIterations: 8 }
      : undefined,
  })
  ```
  클로저로 만들어 런타임 워크스페이스 변경(`setWorkspace`)을 추종한다.
- **`shared/types.ts`** — `ApprovalRequest.kind` 유니온에 `'tool-call'` 추가(유일한 IPC 표면 변경).
  SP1 내장도구는 대부분 `safe`→자동승인이라 승인 모달은 안 뜬다. 렌더러 `ApprovalModal`이 kind를
  exhaustive switch로 다루면 케이스 보강(아니면 무변경). 구현 시 확인.

## 안전 (요구사항 6 · AGENTS.md "안전 우선")

- 루프는 도구 실행 **전** `gate.request({ kind:'tool-call', summary, target, risk })`를 통과해야 한다.
  `onAudit`로 모든 요청/결과를 감사 로그에 남긴다(ApprovalGate onEvent와 동일 패턴, 동일 store).
- **경로 격리**: 모든 워크스페이스 도구는 입력 경로를 `path.resolve(root, p)` 후 `fs.realpath`로
  실경로를 구해 `root` 하위인지 검사한다. 벗어나면(`../`·심볼릭 링크 탈출 포함) 게이트 이전에
  도구가 **throw**(루프가 isError tool_result로 회신, 프롬프트 없음). 디렉터리 traversal 방어.
- **민감파일**: `read_file`이 `safety/approval.ts`의 `SENSITIVE_FILE`(`.env`·`.pem`·`.key`·`.ssh` 등)
  에 매치되면 `classify → destructive`(approver 필요). grep/glob은 민감파일을 결과에서 제외.
- `'tool-call'` kind는 SP2의 임의 부작용 MCP 도구를 위한 게이팅 계약을 지금 확립하는 역할.

## 에러 / 종료 (요구사항: 결정론적 종료)

- `maxIterations` 기본 8(ToolLoopDeps로 주입 가능). 소진 시 마지막 결과가 여전히 tool_use면
  미완성 응답을 성공으로 위장하지 않고 명확한 Error를 던진다(#7 silent-truncation 방지 철학).
- 도구 실행 throw / 미존재 도구 / 게이트 거부 → 해당 `tool_result.isError=true`로 모델에 회신해
  모델이 스스로 대응(표준 에이전트 동작). 루프 자체는 계속된다.
- abort: `opts.signal`을 `provider.chat`과 `ctx.signal`(execute)로 전파. 도구는 장기 작업 시 확인.
- 도구 호출은 한 턴에 여러 개 올 수 있다 — SP1은 **순차** 실행(승인 순서 결정론·단순성). 병렬은 후속.

## 테스트 (게이트: typecheck/lint/test/build 모두 통과)

- `tools/registry.test.ts` — list/get/has, 중복 name 처리.
- `tools/workspace-tools.test.ts` — tmp dir 픽스처: read_file/list_directory/grep/glob 정상 경로;
  경로탈출(`../`)·심볼릭 링크 탈출 → throw; 민감파일 read → destructive 분류·grep/glob 제외;
  사이즈/스캔 바운드.
- `tools/loop.test.ts` — mock ApiProvider(toolCalls 반환 후 stop): 루프가 도구 실행→tool_result
  회신→정상 종료; max-iterations 초과 → throw; 도구 throw → isError 회신 후 계속; 게이트 거부 →
  isError; 미존재 도구 → isError; 감사 이벤트 방출; abort 전파.
- `providers/providers.test.ts` 확장 — OpenAI: tool_use 턴 → body.tool_calls, tool_result 턴 →
  role:'tool' 메시지(tool_call_id); Gemini: tool_result → functionResponse.name = 도구 이름;
  Anthropic: 기존 동작 회귀(불변).
- `session/api-session.test.ts` 확장 — toolDeps 주입 시 루프 경유 후 최종 텍스트 반환; 미주입 시
  기존 단발 동작 회귀; fresh(임시 turns 폐기) vs non-fresh(history 확장) 분기.

## 범위 밖 (후속 서브프로젝트/이슈)

- **SP2** — MCP 클라이언트/호스트(Track 2): Fleet=MCP 클라이언트(stdio JSON-RPC: initialize/
  tools/list/tools/call) → SP1 레지스트리에 MCP 도구 주입 + 승인 정책.
- **SP3** — 도구 사용 중 스트리밍(텍스트 델타 + 도구 단계 라이브 UI).
- write/shell 내장 도구(현재 implementer=CLI 편집 경로가 담당).
- 구조화 출력(#11) · planner replan(#12) · 라이브 모델 조회(#13).
