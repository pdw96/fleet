# 설계: provider 구조화 출력 (structured output) — planner · reviewer

- 날짜: 2026-06-09
- 출처: GitHub 이슈 #11 의 한 조각(structured output 분리). 선행 키스톤 #1 은 머지/클로즈 완료.
- 범위: 오케스트레이터 planner / reviewer 의 LLM 출력 파싱을 정규식 슬라이싱 → 네이티브 구조화
  출력으로 대체하되, **CLI 세션·구형 모델을 위한 관대한 폴백 파서는 병존**시켜 회귀를 차단한다.

## 배경 / 문제

`plan.ts` 의 `extractJsonArray`(`indexOf('[')`/`lastIndexOf(']')` 슬라이싱 + fence 정규식)와
`review.ts` 의 `parseReviewVerdict`(첫 토큰 APPROVE/REVISE)는 LLM 이 마크다운·설명을 섞으면 깨질 수
있는 취약한 파싱이다. 세 provider(anthropic/openai/google)는 모두 네이티브 구조화 출력을 지원하므로,
요청 시 출력 형식을 JSON 스키마로 강제해 파싱 신뢰도를 올린다.

핵심 사실(코드 검증):
- 소비처는 `LlmSession.send()`(문자열 반환)를 통해 호출한다. planner: `planTasks` → `{fresh:true}`,
  비스트리밍. reviewer: `runTask` 내 `{fresh:true}`, 비스트리밍. summarizer 는 산문이므로 **대상 아님**.
- planner/reviewer 세션은 **CLI 세션일 수도 있다**(구독형 claude/codex/gemini). 구조화 출력은
  **API 세션에서만** 강제 가능 → 폴백 파서 필수.
- `resilient.ts` 는 4xx 를 재시도하지 않는다(429/5xx 만). 구형 모델의 구조화-출력 400 은 그대로 전파됨.
- 이슈 #11 은 "anthropic tool 기반"으로 적었으나, 최신 Anthropic API 는 **네이티브 구조화 출력**
  (`output_config.format`)을 지원한다 → 세 provider 모두 네이티브로 통일(= tool 우회 불필요).

## 계약 (단일 진실 원천)

`ApiCallOptions`(`src/main/core/providers/types.ts`)에 추가:

```ts
/** 응답을 JSON 스키마로 강제(네이티브 구조화 출력). 지정 시 text 는 깨끗한 JSON 문자열. */
responseSchema?: { name: string; schema: Record<string, unknown> }
```

`SendOptions`(`src/main/core/session/types.ts`)에 동일 필드를 추가하고,
`createApiSession.send()` 가 `callOpts` 로 전달한다.

**불변식**: `responseSchema` 가 주어지고 provider/모델이 지원하면 `ChatResult.text` 는 마크다운/산문
없는 JSON 문자열이다. `send()` 의 `string` 반환 계약은 불변(횡단 변경 없음). `ChatResult` 구조 변경 없음.

### 스키마 제약 (네이티브 구조화 출력 공통)

- 루트는 **object**(OpenAI strict 모드는 루트 object 필수). 따라서 배열은 객체로 감싼다.
- 모든 object 에 `additionalProperties: false`.
- 수치/문자열 길이 제약(minimum/maxLength 등) 미지원 — 단순 타입·enum·array 만 사용.

## provider 네이티브 매핑

요청 body 빌드 시 `opts.responseSchema` 가 있으면 각 provider 네이티브 필드를 추가한다.

| provider | 필드 |
|---|---|
| anthropic | `body.output_config = { format: { type: 'json_schema', schema } }` |
| openai | `body.response_format = { type: 'json_schema', json_schema: { name, schema, strict: true } }` |
| google | `generationConfig.responseMimeType = 'application/json'` + `generationConfig.responseSchema = schema` |

스트리밍 경로(`opts.onToken`)에서도 JSON 은 text 델타로 도착하지만, planner/reviewer 는 비스트리밍이므로
현재 구조화-출력 호출은 버퍼 경로만 탄다. 스트리밍 경로에도 필드는 추가하되 fallback(아래)은 비스트리밍에만 적용.

## 미지원 모델 400 처리 — graceful degradation

구형 모델은 위 필드를 400 으로 거부할 수 있다. 회귀(=기존 regex 로 잘 돌던 사용자)를 막기 위해:

- **provider 는 `responseSchema` 가 있는 요청이 HTTP 400 을 반환하면, 구조화-출력 필드를 뺀 동일 요청을
  1회 재시도한다.** 재시도도 실패하면 그대로 `ApiProviderError` 로 표면화.
- happy path(200)·미지원이 아닌 모델에는 추가 호출이 없다. 400 일 때만 1회 재시도.
- 재시도 후에는 구조화 출력이 없으므로 text 가 산문+JSON 일 수 있음 → 소비처 폴백 파서가 처리.
- 구현은 비스트리밍 POST 를 공통 헬퍼로 감싸 3 provider 중복을 줄인다. 헬퍼는
  `buildBody(withSchema: boolean)` 클로저를 받아 `withSchema:false` 로 재구성한다.

설계 근거: `resilient.ts` 는 4xx 를 재시도하지 않으므로 이 degradation 은 provider 책임이다. 모델 ID
allowlist(capability 게이트)는 모델 표류 유지보수 부담(#13 재발)이 있어 채택하지 않는다.

## 소비처: strict 우선 + 관대한 폴백 병존

### plan.ts

- 스키마(객체 루트):
  ```
  { type:'object', additionalProperties:false, required:['tasks'],
    properties:{ tasks:{ type:'array', items:{
      type:'object', additionalProperties:false, required:['title','description'],
      properties:{ title:{type:'string'}, description:{type:'string'},
        role:{type:'string', enum:['architect','implementer','reviewer','tester']},
        dependsOn:{type:'array', items:{type:'integer'}} } } } } }
  ```
- `buildPlannerPrompt`: `{"tasks":[...]}` 형태의 JSON 을 요청하도록 문구 갱신(설명/마크다운 금지 유지).
- `parsePlannedTasks(text)`: ① `JSON.parse(text)` 시도 → `{tasks:[...]}` 또는 bare 배열 수용,
  ② 실패 시 기존 `extractJsonArray(text)` 폴백. 이후 정규화 로직(관대한 필드 보정)은 그대로.
- `planTasks`: `planner.send(prompt, { fresh:true, signal, responseSchema: PLANNER_SCHEMA })`.
- `extractJsonArray` 는 폴백으로 **유지**(삭제 금지).

### review.ts

- 스키마:
  ```
  { type:'object', additionalProperties:false, required:['approved','feedback'],
    properties:{ approved:{type:'boolean'}, feedback:{type:'string'} } }
  ```
- `buildReviewPrompt`: `{"approved":bool,"feedback":string}` JSON 을 요청하도록 갱신.
  (CLI 폴백 호환을 위해 "승인 시 approved=true" 의미를 명시; 기존 APPROVE/REVISE 토큰 파싱도 유지.)
- `parseReviewVerdict(text)`: ① `JSON.parse(text)` 시도 → `{approved:boolean, feedback:string}` 수용,
  ② 실패 시 기존 APPROVE/REVISE 토큰 파싱 폴백.
- `orchestrator.ts` 의 reviewer 호출에 `responseSchema: REVIEW_SCHEMA` 전달.

CLI 세션은 `responseSchema` 를 받지 못하지만 프롬프트는 동일하게 JSON 을 요청 → 잘 만들어진 JSON 이면
`JSON.parse` 가, 아니면 폴백이 처리. **기존 동작 보존.**

## TDD 계획 (코어 변경엔 *.test.ts 동반 — AGENTS.md)

- `providers.test.ts`: provider별로 "responseSchema 주면 body 에 네이티브 필드가 실린다" + "400 시
  구조화 필드 없이 1회 재시도한다"(mockHttp 가 두 번째 호출 body 캡처) 단언. anthropic/openai/google × 2.
- `plan.test.ts`: `parsePlannedTasks` 가 `{tasks:[...]}` / bare 배열 / 프롬프트+JSON 혼합(폴백) 모두
  처리. `buildPlannerPrompt` 가 tasks JSON 형태를 요청. 기존 테스트 유지.
- `review.test.ts`: `parseReviewVerdict` 가 JSON 객체 / APPROVE·REVISE 텍스트 모두 처리. 기존 테스트 유지.
- `session.test.ts`(있으면): `send({responseSchema})` 가 provider 로 전달되는지.
- 품질 게이트 4종: `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

## 영향 파일

- `src/main/core/providers/types.ts` — `ApiCallOptions.responseSchema` + 공통 fallback 헬퍼.
- `src/main/core/providers/{anthropic,openai,google}.ts` — 네이티브 필드 매핑 + 400 degradation.
- `src/main/core/session/types.ts` — `SendOptions.responseSchema`.
- `src/main/core/session/api-session.ts` — `send()` 가 `responseSchema` 를 `callOpts` 로 전달.
- `src/main/core/orchestrator/plan.ts` — 스키마·프롬프트·`parsePlannedTasks`·`planTasks`.
- `src/main/core/orchestrator/review.ts` — 스키마·프롬프트·`parseReviewVerdict`.
- `src/main/core/orchestrator/orchestrator.ts` — reviewer 호출에 `responseSchema` 전달.
- 대응 `*.test.ts` 들.

## 비범위 (YAGNI)

- reasoning effort/thinking, prompt caching(이슈 #11 의 나머지) — 별도 후속(Later).
- summarizer 산문 출력 — 구조화 불필요.
- 스트리밍 경로의 구조화-출력 400 fallback — 현재 호출자가 없어 미구현(필드는 추가됨, 문서화).
- 모델 ID capability allowlist — 표류 부담으로 비채택.

## 미해결 / 라이브 검증 사항

- 세 provider 의 정확한 네이티브 필드명/형태는 단위 테스트(mock)로 계약을 고정하나, **실제 API 응답이
  스키마를 준수하는지는 라이브 키로 별도 확인**(이 PR 범위는 요청 빌드 + 파싱까지). 폴백이 있어 회귀는 없음.
