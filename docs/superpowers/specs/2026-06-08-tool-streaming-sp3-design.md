# 도구 사용 중 스트리밍 + 도구 단계 라이브 UI (SP3) — 설계

- 날짜: 2026-06-08
- 브랜치(예정): `feat/tool-streaming`
- 출처 이슈: [#10](https://github.com/pdw96/fleet/issues/10) "후속: 도구 실행 루프 + 도구 소스(MCP 호스트 Track 2)"
- 범위: 이슈 #10의 **SP3(도구 사용 중 스트리밍 + 도구 단계 라이브 UI)** 만. SP1(도구 실행 루프, PR #16)·SP2(MCP 호스트, PR #18)는 머지 완료.
- 선행 스펙: [`2026-06-08-tool-execution-loop-sp1-design.md`](./2026-06-08-tool-execution-loop-sp1-design.md) · [`2026-06-08-mcp-host-sp2-design.md`](./2026-06-08-mcp-host-sp2-design.md)

## 배경

SP1 키스톤(PR #15)에서 provider 계약을 `ChatResult`(text·toolCalls·finishReason·usage)로 진화시키고,
SP1에서 `runToolLoop`(도구 실행 루프)을, SP2에서 MCP 호스트(외부 도구 소스)를 채웠다. 남은 이슈 체크박스:

> - [ ] 스트리밍 + 도구 동시 지원(현재는 tools 사용 시 버퍼링 경로로 폴백)

세 provider 는 모두 `streaming = !!opts.onToken && !opts.tools?.length` 로 게이팅한다 — **도구를 동봉하면
스트리밍을 끄고 버퍼링(최종 1회 파싱)** 한다. 따라서 도구 루프가 도는 동안 사용자는 빈 말풍선("응답 대기 중…")만
보다가 최종 텍스트가 한 번에 떨어지고, 도구가 실행되고 있다는 신호도 전혀 없다. SP3 가 이 두 가지를 채운다:

- **Part A — 도구 사용 중 텍스트 스트리밍.** provider 가 도구 동봉 요청에서도 SSE 스트리밍하면서 텍스트 델타를
  흘리고 **동시에 tool_use 블록을 누적**한다. 루프는 이미 `onToken` 을 provider 로 전달하므로(아래) 루프 중간
  어시스턴트 텍스트가 라이브 말풍선으로 흐른다.
- **Part B — 도구 단계 라이브 UI.** 루프가 도구 1개를 실행할 때마다 구조화된 도구 단계 이벤트(`ChatStreamEvent`
  의 새 `tool` 변형)를 방출해, 렌더러가 "🔧 read_file 실행 중 → ✓ 완료" 칩을 라이브로 보여준다. 탭 재마운트
  catch-up 도 SP-기존 스냅샷(`getChatActivity`)에 단계를 실어 복원한다.

## 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 스트리밍 게이트 | `!opts.tools?.length` 조건 **제거**. `onToken` 만 있으면 도구 동봉이어도 스트리밍 | 이슈가 명시한 "스트리밍+도구 동시". provider 별 SSE 가 tool_use 를 이미 표현(아래 §SSE) |
| tool_use 누적 | provider 별 `readStream` 이 텍스트와 함께 tool_use 블록을 누적해 `ChatResult.toolCalls` 채움 | 버퍼링 파서와 동일 결과를 스트림에서 재구성 → 루프 무수정 |
| 루프 변경 | `runToolLoop` 은 도구 단계 방출(`opts.onToolStep`) 외 **무수정**. `onToken` 은 이미 `...opts` 로 provider 에 전달됨 | 최소 변경. 스트리밍 활성화는 순수 provider 레벨 |
| 도구 단계 채널 | 별도 IPC 추가 없이 기존 `ChatStreamEvent`(onChatStream)에 `tool` 변형 추가 | 기존 라이브 채널 재사용 → preload/IPC 표면 무변경(함정 회피). 한 streamId 안에서 텍스트 델타와 도구 단계가 interleave |
| 단계 모델 | 도구별 `{ id, name, phase: 'running'|'ok'|'error', risk?, summary? }`. id 로 칩을 in-place 갱신 | 칩 1개가 running→ok/error 로 전이. 간결·결정론 |
| catch-up | `ActiveChatStream.steps[]` 에 단계를 누적, `getChatActivity` 가 반환 → 재마운트 복원 | 텍스트 catch-up(SP-기존)과 대칭. 탭 전환에도 진행 표시 유지(#9 철학) |
| 최종 메시지 | 영속 메시지는 여전히 **최종 턴 텍스트**(unwrap). 도구 단계·중간 텍스트는 라이브 전용 | 도구 단계는 진행 관측이지 대화 기록이 아님. 기존 `ChatMessage` 계약 불변 |

---

## 아키텍처 / 데이터 흐름

```
provider.readStream(SSE)                       [Part A]
  ├ text_delta            → onToken(delta) ───────────────┐
  └ tool_use(start/json/stop) 누적 → ChatResult.toolCalls │
runToolLoop                                                │   [Part B]
  ├ provider.chat({...opts(onToken), tools})  ◀───────────┘
  ├ 도구 실행 직전 onToolStep({id,name,'running',risk,summary})
  └ 실행 후    onToolStep({id,name,'ok'|'error'})
session.send(onChunk·onToolStep) → room.askLlm(onToken·onToolStep)
  → engine.streamedAsk:
        onToken    → activeStreams.text 누적 → emit {kind:'delta'}
        onToolStep → activeStreams.steps 갱신 → emit {kind:'tool'}
  → IPC onChatStream → renderer ChatPanel: 델타=말풍선 텍스트, tool=도구 칩
getChatActivity → ActiveChatStream{ text, seq, steps } → 재마운트 catch-up
```

`onToken` 전파 경로는 **이미 존재**한다(SP1 스트리밍): provider→session(onChunk)→room(onToken)→
engine `streamedAsk`(delta 이벤트). SP3 는 (Part A) provider 가 도구 동봉에서도 onToken 을 호출하게 만들고,
(Part B) 같은 경로에 `onToolStep` 을 평행으로 추가한다.

---

## Part A — provider 스트리밍 중 tool_use 누적

세 provider 공통: `const streaming = !!opts.onToken && !opts.tools?.length` → `const streaming = !!opts.onToken`.
스트리밍 본문은 텍스트 델타 + tool_use 블록을 함께 재구성한다. 비스트리밍(onToken 미지정) 경로는 불변.

### Anthropic (Messages SSE)
- `content_block_start` `{index, content_block:{type:'tool_use', id, name}}` → 인덱스별 tool_use 누적기 시작
  (`{id, name, json:''}`). `type:'text'` 블록 시작은 무시(텍스트는 delta 로 옴).
- `content_block_delta`:
  - `delta.type==='text_delta'` → `text += delta.text`; `onToken(delta.text)` (기존).
  - `delta.type==='input_json_delta'` → 해당 인덱스 누적기에 `delta.partial_json` 이어붙임.
- `content_block_stop` 또는 스트림 종료 → 각 누적기의 json 을 `JSON.parse`(빈/실패 시 `{}`)해 `ToolUseBlock` 생성.
- `message_delta.stop_reason` → finishReason(기존). 중간 `error` 이벤트 throw(기존, #7).

### OpenAI (Chat Completions SSE)
- `choices[0].delta.tool_calls[]` 각 항목 `{index, id?, function:{name?, arguments?}}` → 인덱스별 누적:
  `id`·`name` 은 처음 도착분 채택, `arguments`(문자열 조각)는 이어붙임.
- `delta.content` → 텍스트 델타(기존). `finish_reason:'tool_calls'`.
- 스트림 종료 시 누적 `arguments` 를 `parseArgs`(기존 헬퍼)로 파싱해 `ToolUseBlock` 생성.
- `stream_options.include_usage` 는 도구 동봉 때도 유지.

### Google (streamGenerateContent?alt=sse)
- 스트림 청크의 `candidates[0].content.parts[]` 에 `functionCall:{name,args}` 가 온다(보통 분할 안 됨, 통째).
  텍스트 part 는 델타로 흘리고(기존), functionCall part 는 순서대로 모은다.
- 종료 시 모은 functionCall 을 `ToolUseBlock`(`id=`​`${name}-${i}`, 비스트리밍과 동일 규칙)으로 변환.
- 프롬프트 차단(promptFeedback) content_filter 표면화 기존 유지.

> 세 경우 모두 **스트리밍 결과 = 버퍼링 결과**가 되도록(toolCalls·finishReason·usage) 재구성한다. 따라서
> `runToolLoop` 의 `result.toolCalls.length` 종료 판정과 turns 재구성은 무수정으로 동작한다.

---

## Part B — 도구 단계 라이브 이벤트

### 공유 타입 (`src/shared/types.ts`)
```ts
/** 도구 실행 단계(라이브 진행 관측용; 대화 기록 아님). id 로 칩을 in-place 갱신. */
export interface ToolStep {
  /** tool_use id(없으면 name 기반 합성). 칩 식별자. */
  id: string
  name: string
  /** running: 실행 시작 · ok: 성공 · error: 실패/거부/미존재. */
  phase: 'running' | 'ok' | 'error'
  risk?: RiskLevel
  /** 인자 요약(running 시) 또는 짧은 결과/오류 요지. */
  summary?: string
}
```
`ChatStreamEvent` 유니온에 추가:
```ts
| { kind: 'tool'; streamId: string; roomId: string; step: ToolStep; seq: number }
```
`ActiveChatStream` 에 `steps: ToolStep[]` 추가(재마운트 catch-up). `seq` 는 기존 델타 seq 와 **공유 카운터**를
쓴다(한 스트림의 텍스트·도구 이벤트가 단일 단조 시퀀스 → 멱등·정렬 일관).

### 콜백 전파
- `ApiCallOptions`(providers/types.ts)·`SendOptions`(session/types.ts)·`AskOptions`(chat/room.ts) 에
  `onToolStep?: (step: ToolStep) => void` 추가. provider 는 onToolStep 을 **소비하지 않는다**(루프 전용) —
  단지 `ApiCallOptions` 를 통해 루프까지 흐른다.
- `ToolLoopDeps` 는 무변경(엔진 toolDeps 클로저가 per-send 싱크를 모름). 루프는 `opts.onToolStep` 을 읽는다.

### 루프 방출 (`tools/loop.ts`)
도구별로:
- 게이트 승인 후 실행 직전: `onToolStep?.({ id, name, phase:'running', risk, summary: argPreview })`.
- 성공: `onToolStep?.({ id, name, phase:'ok' })`. 실패/거부/미존재: `phase:'error'`(요지 summary).
- id 는 `call.id`(빈 값이면 `name` 합성). 감사(onAudit)는 기존 유지 — 단계 이벤트는 라이브 채널 전용.

### 엔진 (`engine.ts` `streamedAsk`)
- `activeStreams` 엔트리에 `steps: ToolStep[]` 추가. `onToolStep` 콜백:
  - id 로 기존 step 갱신(없으면 push), `seq += 1`(델타와 공유 카운터), `emit({kind:'tool', streamId, roomId, step, seq})`.
- `getChatActivity` 의 `ActiveChatStream` 매핑에 `steps` 포함.

### 렌더러 (`ChatPanel.tsx`)
- `StreamBubble` 에 `steps: ToolStep[]` 추가. `onChatStream`:
  - `start` → `steps:[]`. `tool` → id 로 step in-place 갱신(seq 멱등은 텍스트와 동일 가드 적용은 단계엔 불필요 —
    phase 전이는 최신 우선; 다만 하이드레이션 catch-up 일관 위해 스냅샷 steps 로 머지).
- 말풍선 본문 아래 도구 칩 행 렌더: running=스피너/점, ok=✓, error=⚠ + name(+summary 툴팁/축약). 기존 텍스트
  스트림과 한 말풍선에 공존.

> preload/IPC **무변경**: `onChatStream` 채널·`getChatActivity` 모두 기존. 새 이벤트 변형/필드만 추가되므로
> preload 핫리로드 함정(AGENTS.md)에 해당 없음(타입만 확장).

---

## 안전 / 비기능
- 도구 단계 이벤트는 **승인 게이트 이후**(running)·실행 결과(ok/error)만 노출 — 게이팅 정책 불변(SP1). 승인 모달은
  기존 `onApprovalRequest` 로 그대로 뜬다.
- summary 는 인자/결과를 **짧게 절단**(기존 `previewInput` 재사용, 결과는 길이 바운드) — 컨텍스트/UI 폭주 방지.
- abort: provider 스트리밍 본문은 `opts.signal` 을 그대로 받는다(http init). 중간 중단 시 부분 텍스트는 버려지고
  루프/세션이 reject — 기존 동작.

## 에러 / 종료 (결정론)
- 스트림 중간 tool_use json 파싱 실패 → 빈 `{}` 입력으로 처리(도구가 스스로 검증). 부분 응답 위장 금지(#7)는
  텍스트 경로(error 이벤트 throw)에 기존대로 적용.
- 스트리밍이 toolCalls 를 못 만들고 finishReason 만 'tool_use' 인 비정상은 루프가 `toolCalls.length===0` 으로
  정상 종료 처리(버퍼링과 동일).

## 테스트 (게이트: typecheck/lint/test/build 모두 통과)
- `providers/providers.test.ts` 확장:
  - Anthropic 스트리밍 + tool_use: `content_block_start`(tool_use)→`input_json_delta`×N→`content_block_stop`,
    텍스트 델타 동반 → `out.toolCalls` 재구성·`out.text`·델타 흐름. `stream:true` 가 도구 동봉에도 전송됨.
  - OpenAI 스트리밍 tool_calls: `delta.tool_calls[]` 인덱스 누적(분할 arguments)·델타 → toolCalls.
  - Google 스트리밍 functionCall: 청크의 functionCall part → toolCalls(`name-i`).
  - 회귀: "tools 가 있으면 스트리밍하지 않고 버퍼링" 테스트는 **반대로** 바뀐다(이제 스트리밍) — 갱신.
- `tools/loop.test.ts` 확장: `onToolStep` 가 running→ok 순서로 호출, 실패/거부/미존재 → error 단계 방출, abort 전파.
- `session/api-session.test.ts` 확장: `onToolStep` 가 onChunk 와 함께 send→루프까지 전달.
- `chat/room.test.ts` 확장: `AskOptions.onToolStep` → `session.send` onToolStep 연결.
- `engine.test.ts` 확장: 도구 루프 발언이 `kind:'tool'` 이벤트(running/ok) 방출, `getChatActivity().streams[].steps`
  catch-up 반영.
- `ChatPanel.test.tsx` 확장: `tool` 이벤트로 칩 렌더·phase 전이, 스냅샷 steps 복원.

## 범위 밖 (후속)
- 도구 단계의 영속(store) — 현재 라이브 전용. 감사 로그(tool.*)는 SP1 그대로 영속.
- 텍스트/도구 단계의 **순서 보존 인터리브 렌더**(현재는 텍스트 본문 + 단계 칩 분리 렌더). 세그먼트 통합은 후속.
- 도구 입력(input_json) 부분 스트리밍의 라이브 표시(현재는 완성 후 running 칩만).
- 병렬 도구 실행(SP1 §순차 유지).
