# 설계: provider 응답 truncation/refusal strict 표면화 + 인터랙티브 opt-out (#190)

- **이슈**: #190 (백로그 #27 sub-issue · 컷오프 갭 감사 2R flip 재검증 CONFIRMED)
- **날짜**: 2026-07-02
- **영역**: `area:provider` / `type:bug` (silent-failure)

## 1. 문제

`src/main/core/session/api-session.ts` 의 `unwrap()` 은 provider `ChatResult` 를
레거시 `send(): string` 계약으로 환원하면서, silent-failure 표면화 throw(#7)를
**`text === '' && toolCalls.length === 0`(완전 빈 응답)** 조건 안에만 둔다.

```ts
function unwrap(provider, result): string {
  if (result.text === '' && result.toolCalls.length === 0) {
    // content_filter / length / thinking-only / other → throw
  }
  return result.text // ← 부분 텍스트 + 비정상 finishReason 도 여기로 통과
}
```

따라서 **부분 텍스트가 있는 채로 비정상 종료**한 응답은 4개 throw 를 전부
건너뛰고 잘린/거부된 텍스트를 완전한 응답으로 반환한다:

| finishReason | 원본 사유(예) | 현행 결과 |
|--------------|---------------|-----------|
| `length` | max_tokens 한도 truncation | 잘린 답을 완전 답으로 반환 |
| `content_filter` | mid-response refusal | 부분 거부를 정상 답으로 반환 |
| `other` | anthropic `model_context_window_exceeded`, gemini `MALFORMED_FUNCTION_CALL` 등 | 이상 종료를 정상 답으로 반환 |

`LlmSession.send(): Promise<string>` 계약이 `finishReason` 을 폐기하므로 소비자는
잘림/거부를 감지할 수단이 없다. 현행 pass-through 는 #7 당시 의도된 결정
(`api-session.ts:33` 주석)이나, 컷오프 갭 감사 2R(2026-07-01)이 이를 silent-failure 로
재분류(CONFIRMED). `unwrap` 은 provider-중립이라 3사(anthropic/openai/google) 공통이며,
셋 다 `finishReason` 을 정상 채운다. CLI 세션은 unwrap 미경유라 무관.

## 2. 영향받는 소비자

`.send()` 소비자 중 truncation 이 load-bearing 인 곳:

- `orchestrator/plan.ts:109·151` — planner/replanner, `responseSchema: PLANNER_SCHEMA`,
  `bypassTools`, `fresh`. 잘린 JSON → 파싱 실패 또는 반쪽 계획.
- `orchestrator/orchestrator.ts:376` — reviewer, `responseSchema: REVIEW_SCHEMA`.
  잘린 verdict → 오판(#162 리뷰루프 회귀 계열).
- `orchestrator/orchestrator.ts:789` — summarizer, 자유형식. 잘린 요약이 완전본으로 수용.
- `chat/room.ts:117` — **인터랙티브 채팅룸**, 스트리밍(`onChunk`), 스키마 없음.
  부분 텍스트를 그대로 보여주는 게 정상 — 하드 throw 하면 회귀.

## 3. 설계 — Strict throw + 인터랙티브 opt-out

silent truncation 을 **기본적으로 불가능**하게 만들고, 부분 텍스트가 정당하게
유용한 인터랙티브 경로만 명시적으로 opt-out 한다.

### 3.1 `unwrap` 재구조화

비정상 종료 표면화를 빈-응답 조건에서 분리한다. **opt-out(`allowTruncation`)은
`length`(순수 truncation)에만 적용**하고, `content_filter`(안전/거부 신호)·`other`
(미상/이상 종료)는 **인터랙티브에서도 항상 throw**한다 — 안전·무결성 신호를 부분
텍스트로 위장하지 않는다(Codex 설계 리뷰 정제).

```ts
function unwrap(provider: string, result: ChatResult, allowTruncation = false): string {
  // 안전/거부·미상 종료는 부분 텍스트가 있어도, allowTruncation 과 무관하게 항상 표면화한다
  // — refusal/이상 종료를 정상 응답으로 위장하면 안전 신호가 소실된다.
  if (result.finishReason === 'content_filter') throw new Error(/* 차단 */)
  if (result.finishReason === 'other')          throw new Error(/* 이상 종료 */)
  // 토큰 한도 truncation: 기본 표면화. 부분 텍스트가 있는 인터랙티브 경로만 allowTruncation
  // 으로 보존한다(이미 스트리밍으로 사용자에게 노출됨). 빈-텍스트 truncation 은 보존할 부분이
  // 없으므로 opt-out 여부와 무관하게 throw(#7 유지).
  if (result.finishReason === 'length' && !(allowTruncation && result.text !== '')) {
    throw new Error(/* 잘림·max_tokens */)
  }
  // 텍스트·도구호출 모두 없는 blank 응답 — thinking-only 는 가시출력 부재 전용(빈-텍스트 조건 유지)
  if (result.text === '' && result.toolCalls.length === 0) {
    if (result.content?.some((b) => b.type === 'thinking')) throw new Error(/* thinking-only */)
  }
  return result.text
}
```

- `stop`(정상 종료)·`tool_use`(도구 호출)는 불변 통과.
- 메시지는 기존 #7 문구를 재사용하되, "빈 응답이 되었습니다"→"잘렸습니다"처럼
  부분 텍스트 케이스도 포괄하도록 소폭 조정.
- thinking-only throw 는 빈-텍스트일 때만 의미가 있으므로 하위 조건에 잔존.

### 3.2 플러밍 — `SendOptions.allowTruncation`

- `session/types.ts` 의 `SendOptions` 에 `allowTruncation?: boolean` 추가(문서화 주석 —
  **`length` truncation 에만 적용**·`content_filter`/`other` 는 불가 명시).
- `createApiSession.send` 가 두 unwrap 호출(fresh 경로·accumulate 경로)에
  `sendOpts.allowTruncation` 을 전달.
- **opt-out 소비자 = 채팅룸(`room.ts:117`)만** `allowTruncation: true`. 옆에 **"후속 UI
  잘림 신호 필요 — 의도적 UX debt"** 주석을 남긴다(Codex 권고 — renderer/IPC 알림은 후속 범위).
- CLI 세션은 unwrap 미경유 → 무시(플래그 무해).

### 3.3 소비자별 정책

| 소비자 | 정책 | 결과 |
|--------|------|------|
| planner·replanner·reviewer (기계파싱) | strict | 잘린 JSON 을 파싱 전 명확 에러로 차단 |
| summarizer (자유형식) | strict | 기존 `orchestrator.ts:784` try/catch 가 "요약 실패: 잘렸습니다" 로 강등(오케스트레이션 무손상) |
| 채팅룸 (스트리밍·인터랙티브) | opt-out | 부분 텍스트 표시(현행 UX 보존) |

## 4. 엣지·불변식

- **usage-accounting 무영향**: `emitUsage` 가 `unwrap` 호출 전에 실행되므로(현행
  구조), unwrap 이 더 자주 throw 해도 소비 토큰 집계는 보존된다.
- **스트리밍 구조화 없음**: planner/reviewer 는 `onChunk`(onToken) 미전달 → throw 전
  부분 스트림 노출 없음. 채팅룸은 스트리밍 + opt-out 이라 부분 텍스트 정상 표시.
- **tool-loop 최종 턴 truncated**: 루프가 `toolCalls.length===0` 로 종료해 반환한
  결과가 `length`+텍스트면 unwrap 이 throw(루프 경로도 truncation 표면화). 채팅룸은
  opt-out 이라 보존.
- **pause_turn(`other`·현재 미도달)**: Fleet 은 server tools 미전송이라 미도달 —
  throw 안전(기존 `api-session.ts:57-59` 주석 논리 유지·갱신).

## 5. 스코프 경계 (YAGNI)

- `onFinish` 싱크 미추가(observable-only 대안 기각 — 매 구조화 사이트 opt-in 누락 위험).
- 채팅 truncation UI 알림 미추가(렌더러/IPC 밖 — 별도 후속 여지).
- `send()` 반환 타입 불변(`string`) — 전 코드베이스 계약 보존.
- 별도 ADR 미작성 — #7 정책의 자연 확장이라 코드 주석 + 본 문서로 충분(#140 교훈=과설계 회피).

## 6. 테스트 (TDD)

- **기존 반전(RED)**: `session.test.ts`
  - L209 `부분 텍스트가 있는 length 응답은 그대로 반환한다` ⟹ `→ throw`.
  - L247 `텍스트가 있는 other 응답은 그대로 반환한다` ⟹ `→ throw`.
- **신규(정책)**:
  - 부분+`content_filter` → throw.
  - 부분+`other` → throw.
  - 부분+`length`+`allowTruncation:true` → 부분 텍스트 반환(opt-out).
  - 부분+`content_filter`+`allowTruncation:true` → **여전히 throw**(opt-out 은 length 전용).
  - 부분+`other`+`allowTruncation:true` → **여전히 throw**.
  - 빈+`length`+`allowTruncation:true` → **throw**(보존할 부분 없음).
- **엣지/회귀(Codex 권고)**:
  - tool-loop 최종 턴 `length`+부분 텍스트+`toolCalls:[]` → throw 하고 **history 미커밋** 회귀.
  - usage sink 가 strict throw **전에** 호출됨(소비 토큰 무손실).
- **회귀 보존**: `stop`+텍스트 → 반환 · 빈+`length` → throw(#7) · 빈+thinking-only → throw ·
  `tool_use` → 반환 · 채팅룸 `allowTruncation` 통합(length truncated → 부분 반환·no throw).

## 7. Codex 체크포인트 리뷰 결과 (2026-07-02, `#190` `issuecomment-4862599...`)

**설계 승인.** 정제 반영:

1. `other` strict 포함 — **동의**(provider-중립 unwrap 에 rawFinishReason allowlist 예외는 복잡도↑, 이번 범위 제외).
2. 채팅룸 opt-out 잔여 silent-fail — UI 알림은 후속 범위 OK, **`room.ts` 에 UX debt 주석** 남김.
3. summarizer strict — **동의**(try/catch 강등이 부분 요약 위장보다 안전).
4. **`allowTruncation` 을 `length` 전용으로 좁힘** — `content_filter`/`other` 는 인터랙티브에서도
   항상 throw(안전/무결성). §3.1 반영 완료.
