# 이슈 #72 설계: Anthropic 확장 캐시 TTL 1h (세션 opt-in)

- **날짜**: 2026-06-17
- **대상**: GitHub 이슈 #72 `후속(provider): Anthropic 확장 캐시 TTL 1h (extended-cache-ttl) — 조건부`
- **유형**: provider 기능 증분 (Anthropic 한정)
- **점수(v/e/r)**: 3/2/2 (#27 7차 재랭킹)

## 배경 / 문제

Anthropic provider 는 재사용 프리픽스(도구 동봉·멀티턴)에 top-level `cache_control = { type:'ephemeral' }`
을 싣지만 `ttl` 을 지정하지 않아 **기본 5분 TTL** 만 적용된다(`anthropic.ts:284-286`). 5m 보다 긴
간격으로 같은 프리픽스가 재전송되는 "꼬리(tail)" 경로(긴 빌드 대기·느린 MCP 도구 루프)에서는 5m
윈도우가 만료돼 캐시가 안 읽히고 매 호출 캐시 쓰기(1.25×)만 순손실로 발생한다.

`ttl:'1h'` + `extended-cache-ttl-2025-04-11` 베타 헤더로 이 tail 케이스의 캐시 히트를 유지할 수 있다.

### 핵심 제약 / 검증 (context7 + 코드 대조)

- **와이어 형태**(context7 `/websites/platform_claude_en_api`): `cache_control.ttl` 은 `'5m'`(기본)
  또는 `'1h'` 만 허용. 베타 헤더 토큰명 = `extended-cache-ttl-2025-04-11` (현행 확인).
- **요금**: 1h 캐시 쓰기 ≈ 2× base input (5m 쓰기 1.25× · 읽기 0.1×). → **무조건 1h 는 안티패턴**
  (일반 빠른 루프는 5m 윈도우 안이라 1h 적용 시 2× 쓰기만 순손실). 그래서 **조건부 opt-in** 으로 좁힌다.
  근거: 단일 승인 한도 `APPROVAL_TIMEOUT_MS = 60_000`(`shared/types.ts`), HTTP 타임아웃
  `LLM_HTTP_TIMEOUT_MS = 300_000`(5분, `engine.ts`) → 통상 턴 간격이 5m 안.
- **usage 무회귀**: 응답 usage 가 `cache_creation.ephemeral_1h_input_tokens`/`ephemeral_5m_input_tokens`
  로 세분화되지만, 우리가 파싱하는 집계 필드 `cache_creation_input_tokens` 는 그대로 유효(CLI 문서 확인)
  → cacheCreation/cacheRead 파싱 무변경.

### provider 범위 결정 (사용자 승인)

검증 결과 provider별 인라인 캐시-TTL 노브 가용성이 다르다:

| Provider | 인라인 per-request TTL 노브 | 메커니즘 |
|---|---|---|
| **Anthropic** | ✅ | `cache_control.ttl: '5m'\|'1h'` — **본 이슈 #72** |
| OpenAI | ✅(신규) | `prompt_cache_retention: '24h'\|'in_memory'` — gpt-5.5+는 `'24h'`만. non-ZDR 기본 이미 24h(이득0)·ZDR 기본 in_memory(24h 강제=프라이버시 무력화) → marginal·양날 |
| Gemini | ❌(인라인 없음) | implicit(2.5+ 자동·제어불가) 또는 explicit `caches.create(ttl)` → 별도 stateful 리소스 API(생성/삭제/name 추적) = 큰 작업 |

**결정**: #72 는 **Anthropic 인라인 노브만** 구현한다. OpenAI `prompt_cache_retention` 과
Gemini explicit CachedContent 는 각각 별도 백로그 이슈로 **등록만**(착수 아님) 한다(area:provider,
tier:later, #27 sub-issue 편입). 근거: 2026-06-17 granular-per-provider 분리 규율 · #72 제목 경계 ·
OpenAI 가치 marginal/양날(자체 검증 필요) · Gemini 는 별개 큰 기능.

## 결정 (사용자 승인 완료)

**트리거 = 세션 opt-in 노브** (기존 `thinking` 노브와 동일 패턴). 무조건/적응형 자동 escalation 비채택
(전자는 안티패턴, 후자는 stateful·"얕은 조건부" 범위 초과). 순수 배관(소비자 없음)도 비채택
(이 레포 'dead capability' refute 전례 — count_tokens). → **config 세션 기본값 + per-call override + UI**.

## 아키텍처 / 컴포넌트

### 1. 타입 (mirror `thinking`)

- `src/shared/types.ts`: 명목 타입 `export type CacheTtl = '5m' | '1h'` 추가.
  `ApiProviderConfig` 에 `cacheTtl?: CacheTtl`(세션 기본값, 영속) — `thinking?` 옆.
- `src/main/core/providers/types.ts`: `ApiCallOptions` 에 `cacheTtl?: CacheTtl`(per-call override).
- 관용구: provider 가 `opts.cacheTtl ?? config.cacheTtl` 로 폴백 — temperature/maxTokens/thinking 과 동일.

### 2. 와이어 동작 (`src/main/core/providers/anthropic.ts`)

기존 `cacheable` 조건(`turns.length > 1 || (opts.tools?.length ?? 0) > 0`)을 변수로 추출하고
1h 여부를 그 조건과 AND 한다(캐시 없이 베타만 다는 무의미 케이스 차단):

```ts
const cacheable = turns.length > 1 || (opts.tools?.length ?? 0) > 0
const oneHourCache = cacheable && (opts.cacheTtl ?? config.cacheTtl) === '1h'
if (cacheable) {
  body.cache_control = oneHourCache
    ? { type: 'ephemeral', ttl: '1h' }   // 1h 경로
    : { type: 'ephemeral' }              // 기본/5m: byte-동일(현행)
}
```

베타 헤더는 단일 할당(`:336`)을 **누적**으로 바꿔 CM 헤더와 공존(쉼표 결합):

```ts
const betas: string[] = []
if (opts.contextManagement) betas.push('context-management-2025-06-27')
if (oneHourCache)           betas.push('extended-cache-ttl-2025-04-11')
if (betas.length) headers['anthropic-beta'] = betas.join(',')
```

- **기본/5m/비-cacheable 경로**: cache_control = `{type:'ephemeral'}`(또는 부재), `anthropic-beta`
  부재 또는 CM-only 문자열 → 현행과 **byte-동일(무회귀)**.
- **CM-only 경로**: `betas = ['context-management-2025-06-27']` → join = 동일 문자열(`:592` 무회귀).
- **1h + CM 공존**: `betas = ['context-management-2025-06-27','extended-cache-ttl-2025-04-11']`.

### 3. UI (`src/renderer/components/SessionsPanel.tsx`) — Anthropic 한정

- `provider === 'anthropic'` 일 때만 "캐시 TTL" 셀렉트 노출(OpenAI 자동·Gemini 묵시 → 노브 무의미).
- 상태 `const [cacheTtl, setCacheTtl] = useState<'' | CacheTtl>('')` ('' = 기본 5m).
- config 빌드: `...(provider === 'anthropic' && cacheTtl === '1h' ? { cacheTtl: '1h' } : {})`.
  (5m 선택은 기본과 동일하므로 키 미포함 — IPC 페이로드·displayName 깔끔, byte-동일 보장.)
- displayName 힌트: `, cache:1h` 같은 접미(thinking 관용구와 동일).
- 헬프텍스트: "5m 초과 tail(긴 빌드·느린 MCP)에서만 이득, 1h 쓰기 ≈2× — 평소엔 기본 권장".

### 4. 데이터 흐름 (영속·IPC 무변경)

`PersistedApiSession.config = Omit<ApiProviderConfig,'apiKey'>`(`store/types.ts:41`) →
config 전체가 그대로 영속/복원된다. `registerApiSession(config)` →
`const { apiKey, ...rest } = config`(`engine.ts:446`) → `rest` 통째 저장.
∴ `ApiProviderConfig` 에 `cacheTtl` 추가만으로 **store/preload/IPC/engine 변경 0**. 재시작 복원 자동.

## 에러 처리 / 엣지

- `cacheTtl` 미지정/`'5m'` → 현행 경로(무회귀). 타입이 `'5m'|'1h'` 유니온이라 무효값 불가.
- 비-cacheable(fresh 단발) + `cacheTtl:'1h'` → cache_control·extended-cache 베타 **부재**(1h 는 cacheable 일 때만).
- per-call `opts.cacheTtl` 가 `config.cacheTtl` 보다 우선(관용구).
- 400 격리(PR #63): 기존 removeCM/removeSchema 재시도 로직 무영향(extended-cache 베타는 단순 캐시 메타라
  format/CM 같은 400 유발 필드 아님). 별도 제거 분기 불필요.

## 테스트 (`providers.test.ts` + `SessionsPanel.test.tsx`)

기존 캐시 단언(`:106`,`:113` = `{type:'ephemeral'}`)·CM 헤더(`:592`)·무-CM(`:601`)는 **그대로 유지**
(기본 경로 무회귀 가드 — default 안 바뀜).

신규(providers.test.ts):
1. config `cacheTtl:'1h'` + cacheable(도구) → `cache_control` = `{type:'ephemeral',ttl:'1h'}` 이고
   `anthropic-beta` 에 `extended-cache-ttl-2025-04-11` 포함.
2. `cacheTtl:'1h'` + `contextManagement` + cacheable → `anthropic-beta` 에 두 토큰 **공존**
   (split 후 둘 다 포함 단언 — 순서 무관 robust).
3. `cacheTtl:'1h'` + 비-cacheable(fresh 단발) → cache_control 부재·extended-cache 베타 부재.
4. per-call `opts.cacheTtl:'1h'` 가 `config.cacheTtl` 부재에도 1h 경로 활성(override 채널).
5. 기본(cacheTtl 미지정) cacheable → `cache_control`={type:'ephemeral'}·extended-cache 베타 **부재**(무회귀 명시).

신규(SessionsPanel.test.tsx):
6. anthropic + 캐시 TTL '1h' 선택 → `registerApiSession` config 에 `cacheTtl:'1h'` 포함.
7. 비-anthropic provider → 캐시 TTL 컨트롤 비노출(렌더 부재).

## 완료 조건

- [ ] 조건부 1h 경로: body `cache_control.ttl==='1h'` + `anthropic-beta` 에 `extended-cache-ttl-2025-04-11`
      (CM 동봉 시 `context-management-2025-06-27` 와 공존).
- [ ] 기본(비-1h) 경로 헤더·바디 byte-동일(무회귀).
- [ ] 4게이트(typecheck·lint·test·build) green.
- [ ] PR 본문 `Closes #72`. Codex 자동리뷰 대기·반영.
- [ ] OpenAI/Gemini 상이슈 등록(area:provider·tier:later·#27 sub-issue·보드).

## 비목표 (YAGNI)

- 무조건 1h / 적응형 wall-clock escalation(stateful) — 범위 초과.
- OpenAI `prompt_cache_retention` · Gemini explicit CachedContent 구현 — 별도 이슈 등록만.
- 5m 를 명시 와이어로 전송(`ttl:'5m'`) — 기본은 키 생략으로 byte-동일 유지.
- store/IPC/preload/engine 시그니처 변경.
