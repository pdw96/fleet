# openai-compatible provider 설계 (2026-06-15)

## 배경 / 문제

Fleet 의 API provider 는 `anthropic`/`openai`/`google` **3종으로 하드코딩**돼 있다
(`shared/types.ts:161` provider 리터럴 유니온, `providers/registry.ts` switch). 엔드포인트도
provider 모듈 상수(`openai.ts` `ENDPOINT = 'https://api.openai.com/v1/chat/completions'`)로 고정 —
`baseUrl`/`customEndpoint` 필드는 코드 전역에 **0건**. 결과적으로 프론티어 3사 + 그 구독 CLI 에 묶여
있다.

컷오프 갭 분석(context7 문서 대조)과 Hermes 비교 분석이 **공통으로 최상위 후보**로 지목한 갭이다
(`fleet-cutoff-gap-analysis` · `hermes-agent-vs-fleet` 메모리). Hermes 는 OpenAI-호환 커스텀 엔드포인트
1개로 OpenRouter(200+ 모델)·로컬 vLLM 까지 닿는다. Fleet 은 raw-HTTP provider 인프라와 모델-인지
정규화 화이트리스트를 이미 보유하므로, **OpenAI Chat Completions 호환 provider 1종 추가**로 같은
레버리지를 저비용 해금할 수 있다.

## 목표 (이번 슬라이스 — full 수직 슬라이스)

`provider: 'openai-compatible'` 를 추가해 사용자가 **임의 baseUrl + API 키 + 모델**을 GUI 에서 등록하고
즉시 오케스트레이션에 쓸 수 있게 한다. 새 서버/데몬/프록시 없음 — 기존 openai provider 와 동일한 raw
HTTP, 엔드포인트만 설정화. reasoning(thinking)은 **opt-in verbatim 패스스루 + 400 회복탄력성**으로 다룬다.

## 비범위 (후속 슬라이스)

- **reasoning 출력 캡처**: OpenRouter·vLLM 은 reasoning 텍스트를 비표준 `message.reasoning` /
  `delta.reasoning` 필드로 분리해 보낸다. 슬라이스1 은 이를 파싱하지 않는다(미파싱이라도 응답은 안 깨짐 —
  thinking 텍스트만 미캡처). gemini thought 캡처와 동형의 별도 채널로 슬라이스2.
- nested `reasoning{}` 객체(OpenRouter 전용 확장), OpenRouter 전용 헤더(HTTP-Referer/X-Title), 모델 목록
  라이브 조회, API 키 영속(safeStorage — 별도 Epic).

## reasoning 처리 결정 근거 (현행문서 검증, 4 출처 1차)

검증 워크플로(OpenRouter·vLLM·OpenAI 스펙·LiteLLM) 결과 **"OpenAI-호환 엔드포인트는 reasoning 미지원"은
거짓**(confidence high):

- `reasoning_effort` 는 OpenAI Chat Completions OpenAPI 스펙의 정식 top-level 필드(nullable enum
  `none|minimal|low|medium|high|xhigh`, default medium). 출처: `openai/openai-openapi` openapi.yaml.
- **OpenRouter**: flat `reasoning_effort` + nested `reasoning{}` 둘 다 수용, 200+ 하위 모델로 자동 정규화.
  미지원 파라미터는 **무시**("the parameter is ignored" — api/reference/overview). flat+nested **동시 전송
  시 400**.
- **vLLM**: `reasoning_effort` 1급 필드(소스 `protocol.py`), `extra="allow"` 라 모르는 필드 **무시**(PR
  #10463 이후; 구버전은 400).
- **LiteLLM류 프록시**: 모델별 매핑, **기본은 미지원 시 예외**, `drop_params=True` 일 때만 drop.

핵심 함정 2가지:
1. `openai.ts` 의 OpenAI **모델명 정규식 정규화**(`isReasoningModel(/^(o[0-9]|gpt-5)/)`·`supportsXhigh`·
   `isProModel`·`resolveReasoningEffort`)를 그대로 재사용하면, OpenRouter 슬러그(`anthropic/claude-*`·
   `qwen/*`·`deepseek/*`)에 전부 `false` → reasoning 이 **영구 silent-drop**. → **재사용 금지**.
2. 미지원 파라미터 처리가 서버마다 다름(무시 vs 400) → **맹목 전송도, 완전 미전송도 정답 아님**.

→ 결정: **opt-in flat 패스스루 + 400 재시도 가드**.

## 설계

### 1. 타입 (`shared/types.ts`)

- `ApiProviderConfig.provider` 유니온에 `'openai-compatible'` 추가:
  `provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible'`.
- `ApiProviderConfig` 에 `baseUrl?: string` 필드 추가(주석: openai-compatible 일 때 필수, 그 외 무시).
- 파급(컴파일러 `never` 분기가 강제로 지목): `registry.ts` switch, `SessionsPanel` `PROVIDER_DEFAULTS`
  Record, `providers/types.ts` `ProviderMeta = Partial<Record<provider, ...>>`(Partial 라 신규 키 무해).

### 2. provider (`providers/openai.ts` 파라미터화)

`createOpenAiProvider(config, http)` 를 두 모드 공용으로 확장(공유 헬퍼 `buildMessages`·`readStream`·
`mapUsage`·`parseArgs` 전부 재사용, 분기는 아래 4점만). `const compatible = config.provider === 'openai-compatible'`.

- **엔드포인트**: `compatible ? normalizeBaseUrl(config.baseUrl) : ENDPOINT`. `normalizeBaseUrl(u)` =
  `u.replace(/\/+$/, '') + '/chat/completions'`(끝슬래시 정규화 — `openrouter.ai/api/v1` →
  `.../v1/chat/completions`, `http://localhost:8000/v1` 동일). baseUrl 누락/공백이면 provider 생성에서
  throw(`requireBaseUrl` 명확 메시지).
- **token 필드**: compatible 은 `isReasoningModel` 게이트 적용 안 함(OpenAI 모델명 가정) → 항상
  `max_tokens`(광범위 호환). 기존 openai 경로는 불변(`reasoning ? max_completion_tokens : max_tokens`).
- **temperature**: compatible 은 reasoning-모델 게이트 없이 `temperature` 설정 시 전송(reasoning 모델이면
  게이트웨이가 무시 — Claude 4.7 "silently ignored" 선례).
- **reasoning**: opt-in flat 패스스루. `const effort = (opts.thinking ?? config.thinking)?.effort`. 명시된
  경우에만 `body.reasoning_effort = effort === 'max' ? 'high' : effort`('max'→'high' 다운매핑 — OpenAI 스펙
  비표준값으로 strict 서버 Literal 검증 400 회피, 그 외 low/medium/high/xhigh 그대로). **`resolveReasoningEffort`
  미사용**. nested `reasoning{}` 미전송(flat 단일).
- **반환 `provider` 필드**: 하드코딩 `'openai'` → `config.provider`(기존 openai 케이스 동일값, compatible 은
  'openai-compatible' 반영).

#### 400 회복탄력성 (reasoning)
compatible 경로에서 `reasoning_effort` 가 실린 요청이 400 이면 그 필드만 빼고 **1회 재시도**(기존
`sendWithSchemaFallback` 과 동형 graceful degradation). 구현: send 래퍼가 첫 400 시 `delete body.reasoning_effort`
후 재전송하고, 그 결과는 다시 `sendWithSchemaFallback`(response_format 400 폴백)과 조합(둘 다 body 변이 후
재전송이라 중첩 안전·각 1회). strict 서버 하드실패와 기대불일치 둘 다 흡수.

### 3. registry (`providers/registry.ts`)

`case 'openai-compatible': return createOpenAiProvider(config, http)`(동일 구현, config 가 동작 결정).
`never` 분기가 누락을 컴파일타임에 강제.

### 4. UI (`renderer/SessionsPanel.tsx`)

- provider 드롭다운 4번째 옵션 `<option value="openai-compatible">OpenAI-compatible</option>`.
- `PROVIDER_DEFAULTS['openai-compatible'] = ''`(기본 모델 없음 — 사용자 입력 필수).
- provider === 'openai-compatible' 일 때 **baseUrl 입력칸**(필수, placeholder 예 `https://openrouter.ai/api/v1`).
  신규 state `baseUrl`. 등록 config 에 `baseUrl` 포함(compatible 일 때). 빈 baseUrl 또는 빈 model 이면 등록
  버튼 비활성/검증.
- `thinkingSupported` 에 openai-compatible **포함** → effort 셀렉트 노출. help text 4-way 확장: "엔드포인트/
  모델이 지원할 때만 reasoning_effort 로 적용(미지원 시 무시 또는 자동 제거)".

## 데이터 흐름

```
SessionsPanel (baseUrl + apiKey + model + effort?) 
  → IPC registerApiSession(config{provider:'openai-compatible', baseUrl, ...})
    → registry.createApiProvider → createOpenAiProvider(config)   // endpoint = normalizeBaseUrl(baseUrl)
      → fetch(endpoint, body{max_tokens, temperature?, reasoning_effort?})  // 400 시 reasoning_effort 제거 재시도
        → ChatResult(text/toolCalls/usage)   // mapUsage: cached_tokens 서로소(기존)
IPC/preload 는 config 패스스루라 타입 외 무변경.
```

## 테스트 (TDD)

`providers.test.ts`(openai-compatible describe):
- baseUrl 로 요청(normalizeBaseUrl: `https://x/v1` + 끝슬래시 → `/v1/chat/completions`) · `max_tokens` 사용
  (`max_completion_tokens` 미전송) · temperature 설정 시 전송.
- effort 미지정 → `reasoning_effort` 미전송(무회귀). effort 지정 → flat `reasoning_effort` 전송.
  `'max'` → `'high'` 다운매핑.
- reasoning_effort 실린 요청 400 → 그 필드 빼고 1회 재시도(2번째 호출 body 에 reasoning_effort 부재) →
  성공 응답 파싱.
- baseUrl 누락 → provider 생성 throw(명확 메시지).
- 응답 파싱(text/tool_calls/usage·cached_tokens) 공통 동작 + 스트리밍 경로 동일.
- registry: `provider:'openai-compatible'` → openai provider 인스턴스 라우팅(`provider` 필드 반영).

`SessionsPanel` 테스트: openai-compatible 선택 시 baseUrl 입력칸 노출·effort 셀렉트 노출, baseUrl 빈값
등록 차단, 등록 config 에 baseUrl 포함.

## 영향 범위

`src/shared/types.ts` · `src/main/core/providers/openai.ts` · `src/main/core/providers/registry.ts` ·
`src/renderer/components/SessionsPanel.tsx` (+ 각 테스트). IPC/preload/engine 무변경(config 패스스루).
4 게이트 + 다중 에이전트 적대 리뷰 + Codex 봇 리뷰 대상.
