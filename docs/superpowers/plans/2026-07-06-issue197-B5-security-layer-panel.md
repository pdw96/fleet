# #197-B5 보안층 (Origin·Access JWT·WS nonce·CSP·authenticated presence) — 판사 패널 합성판

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (권장) 또는 superpowers:executing-plans 로 태스크 단위 실행. 스텝은 체크박스(`- [ ]`) 추적.

## 판사 패널 기록 (fleet-plan-panel 드라이런 1회차 — 2026-07-06)

- **파이프라인**: fleet-planner ×3 블라인드 드래프트(기존 B5 계획·이슈 코멘트 접근 금지) → fleet-plan-judge ×2 독립 채점 → 메인 루프 합성.
- **점수**: 공백 그룹(대안도전·ROI·검증가능성·입도) A **16** : B 16 : C 13 — 동점이나 이식 비용 비대칭으로 A 승 / Codex 강점 그룹(ripple·fail-closed·엣지·테스트고정) A **17** : C 16 : B 14. **판사 간 승자 일치 = 초안 A(리스크 우선)** → A 골격 채택.
- **이식**: B(MVP)에서 7건 — 라이브 secure 스모크·nonce 선소모·후속 미룸 리스트·IpcApprover ripple 6파일 교정·verifier 1회 생성 핀·실패 응답 no-store·경계값(중복 쿼리 등). C(계약)에서 5건 — `vite ssr.external` jose·웹스모크 로그 regex 보존·CSP 문자열 전체 일치 핀·부분설정 6조합 교정·주석 drift 스윕.
- **공통 결함 보강**: 인증 실패 관측성 로그+핀 · `/auth/ws-nonce` 메서드 매트릭스 고정 · 정적 자산 무인증 서빙 명시 결정 · 실 Cloudflare Access 라이브 검증의 B6 이월 명기.
- **합성 판정 2건**(초안 간 분열 → 메인 루프 판정): ① presence-0 즉시 reject = **secured 한정**(C 해석 채택 — 스펙 문구 "인증 클라이언트"와 loopback 하위호환 제약에 동시 무모순인 유일 독해. loopback 은 B3/B4 타임아웃 시맨틱 보존) ② nonce 발급 endpoint = **POST**(3안 수렴 — same-origin GET 은 Origin 미동봉이라 "발급도 Origin 검증" 조건이 공허해짐).
- **오염 평가**: 초안 C 의 자진 신고(전역 Grep 에 금지 파일 매치 라인 노출) — 양 판사 모두 **독립 도출 판정**(env 명명 3자 3색·정반대 presence 해석·전 결정 실측 소급 가능).
- **체크포인트 4-R(Codex) 반영 — 2026-07-06**: 조건부 승인(P1 0 · P2 1) → 전부 반영. **P2**: nonce 소비 API 를 `consume(nonce, {identity, origin})` → **`take(nonce): NonceRecord | null`** 로 교정(선소모가 JWT 검증 앞이라 identity 선요구 불가 — Task 5·7). **P3**: CSP 최종 문자열에 `form-action 'self'` 포함 고정(Task 9) · 거부 로그 stage/reason 코드만(토큰·nonce 값 금지 — 기존 제약 유지 확인).

---

**Goal:** fleet-server 의 B3 임시 신뢰모델(loopback 고정 + 느슨한 Origin 가드 + `clientCount>0` presence)을 실제 보안층으로 교체한다 — Origin exact 검증(HTTP·upgrade 공통) · Cloudflare Access JWT 서버 자체 검증(`jose` JWKS · fail-closed) · WS nonce(단일사용·TTL 60s·identity+Origin 바인딩·선소모) · CSP/보안 헤더 · secured 모드 승인 presence = authenticated clients only(0 이 되는 순간 outstanding 즉시 reject) · non-loopback bind 는 access 모드에서만 개방.

**Architecture:** 신규 `src/server/{security-config,access-jwt,ws-nonce}.ts` 3모듈(전부 주입식 — vitest 로 전 시맨틱 검증) + `boot.ts` 재배선(nonce endpoint·noServer upgrade 파이프라인·presence 배선·bind 게이트) + `static.ts` 헤더 + `approval-bridge.ts` additive `rejectAll()` + `web-bridge.ts` nonce 선취 지연 소켓. 서버 2모드: **loopback**(보안 env 미설정 — B3/B4 시맨틱 보존·무회귀) / **access**(`FLEET_ACCESS_TEAM_DOMAIN`+`FLEET_ACCESS_AUD`+`FLEET_PUBLIC_ORIGIN` 3종 완비 — 이때만 non-loopback bind 허용). 부분 설정 = 부팅 throw(조용한 강등 금지).

**Tech Stack:** Node 24(ESM `.mjs` 서버 번들) · `ws@^8` · **신규 dep `jose@^6.2.3`**(ESM-only·Electron 비의존 — 순수성 게이트 통과) · vitest · TypeScript strict.

## Global Constraints

- 설계 권위: 이슈 #197 본문 B5 항목 · 체크포인트 2 §4·§7 · v3 §8 · ADR-0008.
- **데스크톱 무회귀**: `src/preload/**`·`src/main/index.ts` 무변경. `approval-bridge.ts` 변경은 additive(`rejectAll` 추가)만.
- **loopback 모드 = B3/B4 시맨틱 보존**: 보안 env 3종 미설정 시 기존 boot/e2e/웹스모크 전부 GREEN(nonce 미제시 upgrade 허용·presence 타임아웃 시맨틱 유지). Task 1 특성화 핀이 이를 구현 전에 동결.
- **기동 로그 계약**: loopback 모드 `index.ts` 기동 로그의 `fleet-server: http://127.0.0.1:PORT` 접두 포맷 불변 — `e2e/web-server.ts:35` 파서 regex 가 의존(판사 실측 ripple).
- **fail-closed 전 경로**: 부분 설정→부팅 throw · JWT 파싱/서명/클레임/JWKS 장애→401 · nonce 부재/만료/재사용/바인딩 불일치→401(선소모) · access 모드 Origin 부재→거부. 에러 응답은 상태줄+짧은 사유만(스택·설정값 미노출).
- **인증 실패 관측성**: upgrade/발급 거부 시 서버 로그 1줄(단계·사유 코드 — 토큰 값 미기록) + 테스트 핀(판사 공통 결함 보강).
- 게이트: 매 태스크 해당 테스트 GREEN, 최종 `npm run verify`(skills:lint→brain:check→format:check→typecheck→lint→test:coverage→build). **brain 재생성은 모든 src 변경 후 최종 태스크에서만**. win 병렬 spawn flake 시 `npx vitest run --no-file-parallelism`.
- env 파싱 관례: `?.trim() ||`(빈 문자열=미설정 — B3 static-dir 교훈).
- 커밋 prefix `feat(#197-B5):` · 브랜치 `feat/197-b5-security-layer` · PR 은 `Part of #197`(`Closes` 금지).

## 파일 구조 (책임 지도)

```
src/server/
  security-config.ts(+test)  [신규] env 3종 → { mode:'loopback' } | { mode:'access', teamDomain: URL, aud, publicOrigin } · 부분설정 throw
  access-jwt.ts(+test)       [신규] jose 검증 래퍼 — JWKS 주입식(테스트 local·프로덕션 remote) · RS256 핀 · sub 필수
  ws-nonce.ts(+test)         [신규] nonce 저장소 — 단일사용·TTL 60s·identity+Origin 바인딩·선소모·cap 128
  boot.ts(+test 확장)        [변경] nonce endpoint · noServer upgrade 파이프라인 · presence 배선 · bind 게이트
  static.ts(+test 확장)      [변경] CSP·보안 헤더
  index.ts                   [변경] 기동 로그 모드 표기(loopback 접두 포맷 보존)
src/main/core/safety/approval-bridge.ts(+test)   [변경·additive] IpcApprover.rejectAll()
src/renderer/bridge/web-bridge.ts(+test)         [변경] nonce 선취 지연 소켓(WsFactory 계약 불변 — ws-bridge 무변경)
vite.server.config.ts        [변경] ssr.external: ['ws','jose']
package.json                 [변경] jose ^6.2.3
brain.md                     [최종 재생성]
```

---

### Task 0: 스캐폴딩 — jose 의존성 + 서버 번들 배선

**Files:** `package.json` · `package-lock.json` · `vite.server.config.ts`

- [ ] `git checkout master && git pull && git checkout -b feat/197-b5-security-layer`
- [ ] `npm install jose` → dependencies `"jose": "^6.2.3"` 확인(런타임 dep).
- [ ] `vite.server.config.ts` `ssr: { external: ['ws'] }` → `['ws', 'jose']` — 누락 시 번들 인라인돼 빌드는 green 인 침묵 함정(판사 C 적중). `npm run build:server` 후 `out/server/index.mjs` 에 `from 'jose'` import 잔존 육안 확인.
- [ ] 검증: `npm run typecheck && npm run lint && npm run build:server` → 커밋.

**ripple:** ESLint 순수성 게이트는 `src/server/**` 기존 커버 — jose 는 Electron/DOM 비의존이라 설정 무변경(Task 4 lint 로 실증).

---

### Task 1: 회귀 가드 핀 — loopback 모드 특성화 (롤백 신호선)

**Files:** `src/server/boot.test.ts`(추가만)

신규 구현 없음 — 현행 그대로 통과해야 하는 특성화 테스트를 먼저 깐다(이후 태스크가 깨면 하위호환 위반 즉시 RED).

- [ ] 추가 핀: 보안 env 전부 부재 + 포트 0 부팅 → nonce/JWT 없이 WS 접속·hello 수신 성공 / `POST /auth/ws-nonce` → 404(loopback 에 endpoint 없음) / 기존 3핀 존치 확인(non-loopback throw·cross-origin 거부·no-origin 허용) / **loopback 승인 타임아웃 시맨틱**(클라 전원 이탈 시 pending 은 타임아웃까지 생존 — 합성 판정 ① 의 반대면 동결).
- [ ] 경계값: `FLEET_ACCESS_*` 빈 문자열만 존재 → loopback 판정.
- [ ] 검증: `npx vitest run src/server/boot.test.ts` → 전부 즉시 GREEN → 커밋.

---

### Task 2: `IpcApprover.rejectAll` — 데스크톱 공유 모듈 (최고 회귀 위협 선처리)

**Files:** `src/main/core/safety/approval-bridge.ts` · `src/main/core/safety/approval-bridge.test.ts`

`IpcApprover` 에 `rejectAll(): void` 추가 — pending 전원 `resolve(false)` + timer clear + map clear. 배선은 Task 7.

- [ ] **RED:** ① pending 2건서 `rejectAll()` → 두 promise 즉시 `false`·`pendingCount()===0` ② rejectAll 후 늦은 `resolve(id, true)` → 무시(멱등) ③ pending 0건 rejectAll → no-op ④ 타이머 잔존 없음(fake timer 진행에도 재해소 없음 — timeout 경합 커버).
- [ ] **GREEN:** 구현(약 8줄). 기존 resolve/timeout 로직 무변경.
- [ ] 검증: `npx vitest run src/main/core/safety/approval-bridge.test.ts && npm run typecheck` → 커밋.

**ripple 전수(판사 교정 — 6파일):** `approval-bridge.ts`(구현)·`approval-bridge.test.ts` · `src/main/index.ts:19,59`(타입 import+생성 — additive 라 무변경, typecheck 실증) · **`src/server/handlers.ts:4,64`(타입 import + `approver: IpcApprover` 필드 — 무변경, 초안 A 누락분)** · `src/server/handlers.test.ts:23`(실 팩토리 — 무변경 컴파일 확인) · `src/server/boot.ts`(Task 7 신규 호출). 인터페이스 구현 테스트 더블 없음(Grep 실측).

---

### Task 3: `security-config` — 모드 게이트 (반쪽 설정 fail-closed)

**Files:** Create `src/server/security-config.ts` · `src/server/security-config.test.ts`

`resolveSecurityConfig(env): SecurityConfig` — `{ mode:'loopback' } | { mode:'access', teamDomain: URL, aud: string, publicOrigin: string }`. env 3종: `FLEET_ACCESS_TEAM_DOMAIN` · `FLEET_ACCESS_AUD` · `FLEET_PUBLIC_ORIGIN`.

- [ ] **RED:** 3종 전부 부재/공백 → loopback / 3종 유효 → access(`publicOrigin`=`new URL(v).origin` 정규화·`teamDomain`=https URL) / **부분 설정 — 8조합 중 결손 6조합 전수 `it.each` → throw**(누락 env 명시 — 판사 C 교정: 초안 A 의 "3가지"는 오산) / URL 비파싱 → throw / **`FLEET_ACCESS_TEAM_DOMAIN`·`FLEET_PUBLIC_ORIGIN` 둘 다 `http:` 스킴 → throw**(access 배포 전제 = HTTPS 강제 — 체크포인트 4-R 권장 편입).
- [ ] **GREEN:** `?.trim() ||` 관례.
- [ ] 경계값: publicOrigin 포트 포함(origin 보존)·대문자 호스트(정규화 소문자)·trailing slash/path 제거·aud 는 불투명 문자열(형식 비검증 — Cloudflare 관례 과결합 금지).
- [ ] 검증: `npx vitest run src/server/security-config.test.ts` → 커밋.

---

### Task 4: `access-jwt` — Cloudflare Access JWT 서버 자체 검증 (jose · fail-closed)

**Files:** Create `src/server/access-jwt.ts` · `src/server/access-jwt.test.ts`

`createAccessJwtVerifier({ teamDomain, aud, jwks? })` — `jwks` 미주입 시 `createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain))`, 테스트는 `createLocalJWKSet` 주입. `issuer=teamDomain.origin` · `audience=aud` · **`algorithms: ['RS256']` 핀**(jose 기본은 키 적용 가능 alg 전부 허용 — 명시 핀이 실질 방어, 판사 실측). 모든 실패 = throw(호출부 401 변환). `sub` 부재/빈 문자열 → throw(identity 필수).

- [ ] **RED:** `generateKeyPair('RS256')`+`SignJWT` 실서명 — 유효 토큰 → `{ identity: sub }` / 거부 전수 `it.each`: undefined·빈 문자열·형식 불량·만료·nbf 미래·aud 불일치·iss 불일치·타 키 서명·**alg 다운그레이드(HS256)**·sub 결손.
- [ ] **GREEN:** jose v6 `jwtVerify`. **verifier 는 부팅 1회 생성**(요청마다 `createRemoteJWKSet` 재생성 = 캐시·cooldown 30s 무효화 — Task 6·7 배선에서 핀, 판사 B 이식).
- [ ] 검증: `npx vitest run src/server/access-jwt.test.ts && npm run lint`(순수성 게이트 jose 통과 실증) → 커밋.

**경계값:** 원격 JWKS 장애 = throw = 접속 거부(fail-closed — 가용성보다 안전, 주석 명시).

---

### Task 5: `ws-nonce` — 단일사용·TTL·identity+Origin 바인딩 저장소

**Files:** Create `src/server/ws-nonce.ts` · `src/server/ws-nonce.test.ts`

`createNonceStore({ ttlMs=60_000, maxPending=128, now? })` — `issue(identity, origin): string`(randomBytes(32) base64url) · **`take(nonce): NonceRecord | null`**(`NonceRecord = { identity, origin, issuedAt }`). **`take` 는 조회 즉시 레코드 삭제 후 반환**("성패 무관 소모" 저장소 계약 고정) — 바인딩 대조는 호출부(Task 7)가 JWT 검증 후 수행. **체크포인트 4-R P2 반영**: `consume(nonce, {identity, origin})` 형상은 선소모(JWT 앞)가 identity 를 선요구해 구현 불가 — take 형상으로 교정.

- [ ] **RED:** issue→take 성공(레코드 필드 일치)·재-take null(단일사용) / **take 후 어떤 재시도도 null**(선소모 핀 — 바인딩 불일치로 인한 재시도 포함) / TTL 경계 59_999 반환·**60_000 null**(`>=`) / 미지·빈 문자열 null / cap 128 초과 최고령 evict / 만료분 lazy sweep(cap 잠식 방지) / 같은 identity 다중 발급 각각 독립(탭 2개) / **발급 nonce 매회 상이·43자 base64url**(엔트로피 회귀 가드 — 판사 B 이식).
- [ ] **GREEN:** Map+삽입순 evict(약 40줄).
- [ ] 검증: `npx vitest run src/server/ws-nonce.test.ts` → 커밋.

---

### Task 6: nonce 발급 endpoint + Origin 검증 공통화 (HTTP 면)

**Files:** Modify `src/server/boot.ts` · `src/server/boot.test.ts`

access 모드에서만 `POST /auth/ws-nonce` 를 정적 서빙 앞에 배선. 검증 순서: **Origin exact**(부재/불일치 403) → **JWT verify**(`Cf-Access-Jwt-Assertion` 헤더 우선·`CF_Authorization` 쿠키 폴백, 실패 401) → `issue(identity, origin)` → `200 { nonce }`. **성공·실패 응답 공통 `Cache-Control: no-store`**(판사 B 이식). Origin 판정 함수는 upgrade(Task 7)와 동일 함수 공유(HTTP·upgrade 공통 — drift 차단). **메서드 매트릭스 고정**(판사 공통 결함 보강): POST 외(`GET`/`HEAD`/`OPTIONS`) → 405.

- [ ] **RED(통합 — 포트 0 + fetch, `bootServer(env, testOverrides?)` 에 JWKS 주입 인자 추가 — 운영 env 표면 0):**
  - loopback: `POST /auth/ws-nonce` → 404(Task 1 핀 유지).
  - access: 유효 Origin+JWT → 200 + nonce + `cache-control: no-store` / **401 실패 응답에도 no-store 단언**.
  - Origin 부재 → 403 · scheme/포트/서브도메인 차이 → 403(exact) · `Origin: null` → 403.
  - JWT 부재 → 401 · 쿠키 폴백(`CF_Authorization=<유효토큰>`) → 200 · 쿠키 파싱 경계(다중 쿠키·값 내 `=`).
  - `GET`/`HEAD`/`OPTIONS` `/auth/ws-nonce` → 405.
  - **거부 시 서버 로그 1줄**(단계 코드 — 토큰 미기록) 방출 핀.
- [ ] **GREEN:** 라우팅 함수로 감싸기 + `resolveSecurityConfig`·verifier(1회 생성)·nonceStore 조립.
- [ ] 검증: `npx vitest run src/server/boot.test.ts` → 커밋.

**ripple:** `bootServer(env)` → optional 인자 확장 — 소비처 `src/server/index.ts`(무변경)·`boot.test.ts`. fixtures/channels/protocol 무변경(인증은 프레임 계약 밖).

---

### Task 7: upgrade 파이프라인 교체 + 승인 presence fail-closed (핵심 위협 면)

**Files:** Modify `src/server/boot.ts` · `src/server/boot.test.ts` (ws-host 코드 무변경 — 검증 통과 소켓만 attach = presence 구조 성립. **주석 drift 갱신: `boot.ts:20-21`·`:100`·`ws-host.ts:19` "B5 전 임시" 문구** — 판사 C 이식)

1. `verifyClient` → **`{ noServer: true }` + `httpServer.on('upgrade')`** 교체(JWKS async — sync verifyClient 불가). 검증 순서(**합성 조정 — 판사 B 이식 · 체크포인트 4-R 확정 순서**): ① `?nonce=` 파싱(부재 401) → ② **`record = nonceStore.take(nonce)`**(무조건 삭제 — 이후 어떤 실패에도 재사용 불가·null 이면 401) → ③ Origin exact → ④ JWT verify → ⑤ **바인딩 대조 `record.identity===sub && record.origin===Origin`** → 통과 시에만 `handleUpgrade`→`attach`. 실패 = `HTTP/1.1 401` write + `socket.destroy()` + **관측 로그 1줄(stage/reason 코드만 — 토큰·nonce 값 금지)**. async 경로 전체 `.catch`(B3 unhandled-rejection 형제 경로).
2. Origin 정책: loopback = 현행 `isAllowedOrigin`(Task 1 핀 보존) / access = publicOrigin exact + **부재도 거부**.
3. **승인 presence(합성 판정 ① — secured 한정):** 소켓 `close`·`error` 두 경로(형제 스윕) 공통 함수에서 `binding.onClose()` 후 `mode==='access' && clientCount()===0` 이면 `ipcApprover.rejectAll()`. `close()`(서버 종료)도 `engine.dispose()` 전 rejectAll. **loopback 은 타임아웃 시맨틱 유지**(Task 1 핀과 정합).
4. raw socket `'error'` 리스너 선부착 + `handleUpgrade` 전 `socket.destroyed` 확인(B3 P2 형제 경로).

- [ ] **RED(통합 — 실 ws 클라):**
  - **완료 게이트 ⑤:** access — nonce 없이 → 거부 / **유효 JWT 쿠키 자동첨부여도 nonce 없으면 거부**(CF_Authorization 우회 차단 실증) / 타 identity nonce → 거부 / 발급 origin 과 다른 Origin → 거부 / 재사용 → 거부 / **실패 upgrade 의 nonce 를 올바른 조건으로 재시도 → 거부**(선소모 통합 핀).
  - 정상 경로: POST 발급 → `?nonce=` 접속 → hello → `clientCount()===1`.
  - **완료 게이트 ④:** ① 미검증 접속 시도만 있는 상태 + 승인 요청 → 즉시 false(검증 실패 socket presence 미포함) ② 인증 클라 1·pending 중 disconnect → **타임아웃 없이 즉시 reject** ③ **인증 클라 2 중 1 이탈 → pending 유지**(0 "되는 순간"에만 — 판사 B 지목 유일 핀) ④ 중복 응답 멱등(존치 확인).
  - 경계값(판사 B 이식): `?nonce=` 빈 값 · `?nonce=a&nonce=b` 중복 쿼리(첫 값 채택으로 고정 테스트) · `/auth/ws-nonce` 경로로 upgrade 시도(라우팅 혼선 없음).
  - loopback: nonce 없이 접속 성공·기존 Origin 3핀·**타임아웃 시맨틱 유지**(Task 1 핀 GREEN 지속).
- [ ] **GREEN:** boot.ts 재배선(약 60줄). noServer 모드에서 `close()` 의 `wss.clients` terminate 동작 확인(미포함이면 자체 Set).
- [ ] 검증: `npx vitest run src/server/boot.test.ts src/server/ws-host.test.ts` → 커밋.

**ripple 전수:** verifyClient 제거 → `isAllowedOrigin` 모드 인자 수용(boot 내부 2곳). ws-host `attach`/`clientCount` 계약 무변경(테스트 무수정 GREEN). 경로 핀(`/ws` 한정)은 비범위(현행 전 경로 upgrade — boot.test 루트 접속 실측 보존).

---

### Task 8: web-bridge — nonce 선취 지연 소켓 (클라이언트 면)

**Files:** Modify `src/renderer/bridge/web-bridge.ts` · `src/renderer/bridge/web-bridge.test.ts`

`WsFactory` 동기 계약 유지(ws-bridge 무변경) — 지연 소켓 어댑터: 즉시 `WsLike` 반환, 내부 `fetch('/auth/ws-nonce', { method:'POST' })` → 200 이면 `?nonce=` 부착 접속, **404 면 nonce 없이 접속**(loopback 하위호환 — access 서버면 어차피 서버가 거부), 그 외(401/403/네트워크) → `onclose` 발화(기존 백오프 재접속 합류). 재접속 = 팩토리 재호출 = **매번 새 nonce**(단일사용 정합).

- [ ] **RED(fetch·WebSocket 스텁):** ① 200 → `?nonce=<값>` URL ② 404 → nonce 쿼리 없음 ③ fetch reject/401 → onclose 발화(영구 hang 금지) ④ 개설 전 send 없음(ws-bridge 큐잉 계약 확인) ⑤ fetch 중 close() → 소켓 미생성/생성 즉시 close(누수 없음) ⑥ **재호출마다 fetch 재수행 횟수 핀**(재접속=새 nonce — 판사 B 이식).
- [ ] **GREEN:** `browserSocket` 확장(약 30줄).
- [ ] 검증: `npx vitest run src/renderer/bridge/web-bridge.test.ts src/renderer/bridge/ws-bridge.test.ts` → 커밋.

**ripple:** `ws-bridge.ts`·hydration 무변경(WsLike/WsFactory 계약 보존 — ws-bridge.test 무수정 GREEN 이 핀). preload/main 무접촉.

---

### Task 9: CSP + 보안 헤더 (정적 서빙)

**Files:** Modify `src/server/static.ts` · `src/server/static.test.ts`

`send` 헬퍼 단일 지점 — **최종 문자열(체크포인트 4-R 확정 — 계획·테스트 일치 고정)**: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`(`?nonce=` URL 잔존 방지 정합). `connect-src 'self'` 는 CSP3 에서 same-origin ws/wss 포함(B4 리뷰 REFUTED 확정 — 라이브 재확인은 Task 11). `static.ts:8` 주석("CSP 는 B5 몫") 갱신.

- [ ] **RED:** 응답 4종 전수(200 자산·404·405·SPA 폴백)에 헤더 존재 + **CSP 문자열 전체 일치 핀**(부분 단언 아님 — 약화 회귀 무신호 방지, 판사 C 이식. `unsafe-eval` 부재는 전체 일치에 내포).
- [ ] **GREEN:** send 헬퍼 수정(약 10줄).
- [ ] 검증: `npx vitest run src/server/static.test.ts` → 커밋.

**명시 결정(판사 공통 결함 보강):** non-loopback 개방 후 정적 자산(renderer 번들)은 JWT 없이 서빙된다 — **의도적 수용**. 근거: 번들은 비밀 아님·실배포는 터널 앞단 Cloudflare Access(MFA) 가 HTML 자체를 게이팅·직접 LAN bind 는 운영자 명시 opt-in. `static.ts` 주석 1줄 명기.

---

### Task 10: bind 게이트 개방 — access 모드에서만 (노출 확대 = 최종 잠금 해제)

**Files:** Modify `src/server/boot.ts`(`resolveBindHost`) · `src/server/boot.test.ts` · `src/server/index.ts`(로그)

`resolveBindHost(env, config)` — access 모드만 non-loopback 허용. 이 커밋 하나가 "문 열기"의 전부 — revert = 즉시 loopback 고정 복귀.

- [ ] **RED:** loopback + `FLEET_HOST=0.0.0.0` → throw 유지(핀 문구 "보안 미설정 시" 로 갱신) / access + `0.0.0.0`·외부 host → 허용 / access + FLEET_HOST 미설정 → 기본 `127.0.0.1`(개방은 명시 opt-in 이중 게이트) / 통합: access `0.0.0.0` 부팅 + 미인증 접속 여전히 거부(열린 문을 Task 7 파이프라인이 지킴).
- [ ] **GREEN:** 시그니처 확장 + `index.ts` 기동 로그 모드 표기 — **loopback 시 `fleet-server: http://127.0.0.1:PORT` 접두 포맷 불변**(`e2e/web-server.ts:35` regex 계약 — 판사 C 이식).
- [ ] 검증: `npx vitest run src/server/boot.test.ts` → 커밋.

**ripple:** `resolveBindHost` 소비처 = boot 내부·boot.test.ts 뿐(Grep 실측).

---

### Task 11: 최종 — brain 재생성 + 전 게이트 + 라이브 스모크 (loopback 무회귀 + access 실기동)

- [ ] `npm run brain`(모든 src 변경 후 — 유일 재생성 시점).
- [ ] `npm run verify` GREEN. 사전 `npx prettier --version` lockfile 동기 확인.
- [ ] `npm run test:e2e` — 데스크톱 e2e + 웹 스모크 GREEN: loopback 라이브 무회귀 + **CSP 적용 상태 WS 접속·스타일 정상·콘솔 CSP 위반 0**(위반 시 Task 9 최소 확장 후 재실행).
- [ ] **라이브 access 스모크(판사 B 이식 — bootServer 테스트 주입 재사용, 운영 env 표면 0):** 로컬 JWKS 주입 access 부팅 스크립트로 ① 발급→`?nonce=` 접속→hello(양성 경로) ② nonce 재사용 거부 ③ 무 JWT upgrade 401 ④ `FLEET_HOST=0.0.0.0`+가짜 team domain → 기동되나 전 접속 401(fail-closed 실증) — 4항목 실측 후 PR 본문 기록.
- [ ] 커밋 → PR(`Part of #197`) → Codex 리뷰 대기(`@codex review` 순수 한 줄).

---

## 리스크 · 롤백 경로

| 리스크 | 완화 | 롤백 |
|---|---|---|
| approval-bridge 변경 데스크톱 회귀 | Task 2 additive 최소 diff·기존 테스트 무수정 GREEN·main/index.ts 무접촉 | Task 2 단독 revert |
| bind 개방이 잠금 완성 전 누출 | 개방 = Task 10 단일 최종 커밋·loopback throw 핀 상시 GREEN | Task 10 revert = loopback 복귀 |
| CSP 라이브 파손(단위 무신호) | Task 11 웹 스모크 판정·style-src 완화 여지 | Task 9 revert(독립 커밋) |
| noServer 전환 회귀 | Task 1 특성화 핀 + `wss.clients` 동작 확인 | Task 7 revert(presence 조항 미충족 상태 복귀 = 머지 불가 인지) |
| 원격 JWKS 장애 = 접속 불가 | 의도된 fail-closed·jose 캐시/cooldown 30s | 운영 완화는 B6 몫 |
| 웹스모크 로그 파서 회귀 | 접두 포맷 계약 명시 + Task 11 이중 가드 | — |
| nonce 저장소 잠식 | 발급이 JWT 뒤 + cap 128 + lazy sweep | — |

## 후속으로 미룬 것 (별도 이슈 등재 후보 — 판사 B 이식)

- nonce endpoint 레이트리밋 정교화(현행 cap+선소모로 갈음) · WS subprotocol nonce 이동 · 인증 실패 감사 이벤트(eventlog 편입 — 현행은 서버 로그 1줄) · Access 그룹/이메일 allowlist claim 검증(현행 iss+aud+sub).
- **실 Cloudflare Access 라이브 완주 검증은 B6(deploy 접합) 이월 명기**(판사 공통 결함): 실 터널 뒤 실 JWT 의 헤더/쿠키 형태·`iss`/`aud` 실값·cloudflared Origin 보존 실측 + `deploy/` 스택 env 3종 배선은 B6 완료 조건에 편입(Phase A "라이브 5/5" 관례 준수).

## 스펙 판정 기록 (체크포인트 리뷰 확인 요망)

1. **nonce 발급 = POST**(3안 수렴): same-origin GET 은 브라우저가 Origin 미동봉 → "발급도 Origin 검증" 조건 공허화. POST 는 항상 동봉.
2. **presence-0 즉시 reject = access(secured) 모드 한정**(판사 논거 채택): 스펙 문구 "인증 클라이언트"·loopback 하위호환 제약에 동시 무모순. loopback 은 B3/B4 타임아웃 시맨틱 유지(Task 1 핀).
3. **`FLEET_PUBLIC_ORIGIN` env 신설**: Origin exact 검증의 권위 소스 — teamDomain 에서 유도 불가(터널 호스트네임 ≠ 팀 도메인). 테스트용 JWKS/issuer 오버라이드 env 는 **비채택**(운영 표면 최소화 — `bootServer` 주입 인자로 대체).
