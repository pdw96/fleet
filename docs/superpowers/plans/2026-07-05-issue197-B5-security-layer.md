# #197-B5 보안층 (Origin·Access JWT·WS nonce·CSP·authenticated presence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fleet-server 의 B3 임시 신뢰모델(loopback 고정 + 느슨한 Origin 가드 + `clientCount>0` presence)을 실제 보안층으로 교체한다 — Origin 정확일치 allowlist(HTTP·upgrade 공통) · Cloudflare Access JWT 서버 자체 검증(`jose` JWKS · fail-closed) · WS nonce(단일사용·TTL 60s·identity+Origin 바인딩) · CSP/보안 헤더 · 승인 presence = 인증 클라이언트 한정(0 이 되는 순간 outstanding 승인 즉시 reject) · non-loopback bind 는 보안 설정 완비 시에만 개방.

**Architecture:** 신규 `src/server/security/{nonce,origin,access-jwt,gate}.ts` 4모듈(전부 주입식 — node vitest 로 전 시맨틱 검증) + `boot.ts` 배선(env 게이트·nonce 발급 endpoint·HTTP/upgrade 게이트·presence 배선) + `static.ts` 헤더 + 클라이언트 2파일(`ws-bridge` 비동기 팩토리 · `web-bridge` nonce 선발급). 서버는 2모드: **loopback**(현행 B3/B4 시맨틱 보존 — 데스크톱·e2e·웹스모크 무회귀) / **secured**(`FLEET_ACCESS_TEAM_DOMAIN`+`FLEET_ACCESS_AUD`+`FLEET_ALLOWED_ORIGINS` 3종 완비 시 — 이때만 non-loopback bind 허용).

**Tech Stack:** Node 24(ESM `.mjs` 서버 번들) · `ws@^8` · **신규 dep `jose@^6`**(ESM-only — 서버 번들이 ESM 이라 정합) · vitest · TypeScript `satisfies`.

## Global Constraints

- 설계 권위: 이슈 #197 본문 B5 항목 · 체크포인트 2 §4·§7(승인 presence·nonce 하드닝) · v3 §8(Origin·JWT·nonce·CSP — "터널 인증만 신뢰하지 않음") · ADR-0008.
- **데스크톱 무회귀**: `src/preload/**`·`src/main/index.ts` 무변경. `approval-bridge.ts` 변경은 additive(`rejectAll` 추가)만.
- **loopback 모드 = B3/B4 시맨틱 보존**: 보안 env 3종 미설정 시 기존 boot/e2e/웹스모크 테스트 전부 GREEN 유지(nonce 미제시 upgrade 허용). **CSWSH 범위 정직성(체크포인트 4 적대리뷰)**: loopback 정책은 외부·`Origin: null`(file://·sandboxed) CSWSH 는 차단하나 **cross-port localhost origin**(`http://localhost:9999` 등 다른 로컬 포트의 침해 페이지)은 host-set 조회가 포트를 무시하므로 허용된다 — nonce 선택적이라 이 벡터가 잔존한다. 실노출인 non-loopback 은 secured(nonce 필수)라 봉쇄되므로 blocker 아니나, loopback web 모드를 공용/멀티프로세스 머신에서 상시 구동하면 loopback nonce 를 필수로 승격(`gate.ts` loopback `nonce===null → true` 제거)해야 한다. `origin.ts`·`gate.ts` 주석에 이 잔존 표면을 1줄 명기.
- 에러 res 는 message 만(스택 미노출 — B2 프로토콜 계약). 미지 채널 echo 는 **유지**(체크포인트 3 항목 5 재평가: B5 후 이 표면은 JWT+Origin+nonce 뒤 인증 사용자 전용이라 노출 아님 · 디버깅 가치 우선 — 코드 변경 0, 본 계획이 재평가 기록).
- 커밋 컨벤션: `feat(#197-B5): …` / `test(#197-B5): …`. 각 태스크 끝 커밋.
- 게이트: `npm run verify` = skills:lint → brain:check → format:check → typecheck → lint → test:coverage → build. **brain 재생성은 모든 src 변경 후 최종 태스크에서만**(중간 재생성 금지 — CI brain:check fail 실측).
- win 로컬 병렬 spawn-테스트 flake 시 `npx vitest run --no-file-parallelism` (CI 는 green).
- ESLint 코어 순수성 게이트: `src/server/**` 는 이미 스코프 내(B3) — 신규 `src/server/security/**` 도 자동 포함. jose 는 Electron 비의존이라 통과.
- env 파싱 관례: `?.trim() || 기본값`(빈 문자열=미설정 — B3 static-dir 교훈).
- `Date.now` 직접 호출 금지 아님(서버 코드) — 단 nonce/TTL 은 `now` 주입식으로 테스트.

## 파일 구조 (전체 지도)

```
Create: src/server/security/nonce.ts          — 단일사용·TTL nonce 저장소(주입식 clock)
Create: src/server/security/nonce.test.ts
Create: src/server/security/origin.ts         — OriginPolicy 2종(loopback 승계 · allowlist 정확일치)
Create: src/server/security/origin.test.ts
Create: src/server/security/access-jwt.ts     — jose Access JWT 검증(주입식 getKey · 401/503 분류)
Create: src/server/security/access-jwt.test.ts
Create: src/server/security/gate.ts           — gateHttp/gateUpgrade 합성(성패 무관 nonce 소모)
Create: src/server/security/gate.test.ts
Modify: src/main/core/safety/approval-bridge.ts  — rejectAll() 추가(additive)
Modify: src/main/core/safety/approval-bridge.test.ts (있으면 — 없으면 신규)
Modify: src/server/ws-host.ts                 — onAllClientsGone 전이 콜백
Modify: src/server/ws-host.test.ts
Modify: src/server/static.ts                  — CSP·nosniff·캐싱 헤더
Modify: src/server/static.test.ts
Modify: src/server/boot.ts                    — resolveSecurityConfig·bind 게이트 개방·nonce endpoint·게이트 배선·presence 배선·BootDeps 주입
Modify: src/server/boot.test.ts
Modify: src/server/index.ts                   — 기동 로그 모드 반영(1줄)
Modify: src/renderer/bridge/ws-bridge.ts      — connect 팩토리 비동기 허용
Modify: src/renderer/bridge/ws-bridge.test.ts
Modify: src/renderer/bridge/web-bridge.ts     — nonce 선발급 팩토리
Modify: src/renderer/bridge/web-bridge.test.ts
Modify: package.json                          — dep jose 추가
```

의존 순서: T1(nonce)·T2(origin)·T3(jwt) 독립 → T4(gate 가 셋 소비) → T5(config/bind) → T6(presence 시임) → T7(static 헤더) 독립 → T8(boot 배선이 T1~T7 소비) → T9(ws-bridge)→T10(web-bridge) → T11(최종 검증).

---

### Task 1: nonce 저장소 — `security/nonce.ts`

**Files:**
- Create: `src/server/security/nonce.ts`
- Test: `src/server/security/nonce.test.ts`

**Interfaces:**
- Consumes: `node:crypto` randomBytes 만.
- Produces: `NonceBinding { identity: string | null; origin: string | null }` · `NonceStore { issue(binding): string; consume(nonce): NonceBinding | null; size(): number }` · `createNonceStore(opts?: { ttlMs?: number; now?: () => number }): NonceStore` — T4 gate·T8 boot 가 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/security/nonce.test.ts
import { describe, expect, it } from 'vitest'
import { createNonceStore } from './nonce'

describe('createNonceStore — 단일사용·TTL 60s(#197 B5)', () => {
  const binding = { identity: 'me@example.com', origin: 'https://fleet.example.com' }

  it('발급 nonce 는 1회만 소모된다(성패 무관 즉시 소모)', () => {
    const store = createNonceStore()
    const nonce = store.issue(binding)
    expect(nonce.length).toBeGreaterThanOrEqual(43) // 32바이트 base64url
    expect(store.consume(nonce)).toEqual(binding)
    expect(store.consume(nonce)).toBeNull() // 재사용 불가
  })

  it('미발급 nonce → null', () => {
    expect(createNonceStore().consume('no-such-nonce')).toBeNull()
  })

  it('TTL 경과 nonce → null(소모는 됨)', () => {
    let t = 1_000
    const store = createNonceStore({ ttlMs: 60_000, now: () => t })
    const nonce = store.issue(binding)
    t += 60_000 // 정확히 만료 시각 — expiresAt <= now 는 만료
    expect(store.consume(nonce)).toBeNull()
    expect(store.size()).toBe(0)
  })

  it('TTL 이내는 유효 · 발급 시 만료분 sweep', () => {
    let t = 0
    const store = createNonceStore({ ttlMs: 60_000, now: () => t })
    const old = store.issue(binding)
    t = 59_999
    expect(store.consume(old)).toEqual(binding)
    store.issue(binding)
    t = 200_000
    store.issue(binding) // sweep 트리거
    expect(store.size()).toBe(1)
  })

  it('발급 상한 초과 시 최고령부터 밀려난다(무한 성장 방지)', () => {
    const store = createNonceStore()
    const first = store.issue(binding)
    for (let i = 0; i < 100; i++) store.issue(binding)
    expect(store.size()).toBeLessThanOrEqual(100)
    expect(store.consume(first)).toBeNull()
  })

  it('nonce 는 매번 다르다(충돌 시 세션 탈취 표면)', () => {
    const store = createNonceStore()
    expect(store.issue(binding)).not.toBe(store.issue(binding))
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/server/security/nonce.test.ts` → FAIL (`Cannot find module './nonce'`)

- [ ] **Step 3: 최소 구현**

```ts
// src/server/security/nonce.ts
import { randomBytes } from 'node:crypto'

/**
 * WS upgrade 용 단일사용 nonce 저장소(#197 B5). CF_Authorization 쿠키는 cross-site WS 핸드셰이크에도
 * 자동 첨부되므로 쿠키만으로는 CSWSH 를 못 막는다 — 악성 오리진 페이지는 (CORS 때문에) nonce 발급
 * 응답을 읽을 수 없다는 사실이 방어의 핵심. 발급 시 identity+Origin 을 바인딩하고, 소모는 조회 즉시
 * 무조건(upgrade 성패 무관 — 체크포인트 2 §7) 일어난다. clock 주입식이라 TTL 을 결정론 테스트한다.
 */
export interface NonceBinding {
  identity: string | null
  origin: string | null
}

export interface NonceStore {
  issue(binding: NonceBinding): string
  /** 단일사용 소모 — 존재하면 즉시 삭제 후 미만료일 때만 바인딩 반환. */
  consume(nonce: string): NonceBinding | null
  size(): number
}

const DEFAULT_TTL_MS = 60_000
const MAX_PENDING = 100

export function createNonceStore(opts: { ttlMs?: number; now?: () => number } = {}): NonceStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const entries = new Map<string, { binding: NonceBinding; expiresAt: number }>()

  return {
    issue(binding) {
      const t = now()
      for (const [k, v] of entries) if (v.expiresAt <= t) entries.delete(k)
      // 발급은 인증 뒤 표면이지만 무한 성장은 막는다 — 초과 시 최고령(Map 삽입순)부터 폐기.
      while (entries.size >= MAX_PENDING) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      const nonce = randomBytes(32).toString('base64url')
      entries.set(nonce, { binding, expiresAt: t + ttlMs })
      return nonce
    },
    consume(nonce) {
      const entry = entries.get(nonce)
      if (!entry) return null
      entries.delete(nonce) // 단일사용 — 이후 검증 성패와 무관하게 여기서 소모 확정
      return entry.expiresAt <= now() ? null : entry.binding
    },
    size: () => entries.size,
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/server/security/nonce.test.ts` → PASS 6/6
- [ ] **Step 5: 커밋** — `git add src/server/security/nonce.ts src/server/security/nonce.test.ts && git commit -m "feat(#197-B5): WS nonce 저장소 — 단일사용·TTL 60s·identity+Origin 바인딩"`

---

### Task 2: Origin 정책 — `security/origin.ts` + boot 승계

**Files:**
- Create: `src/server/security/origin.ts`
- Test: `src/server/security/origin.test.ts`
- Modify: `src/server/boot.ts` (로컬 `isAllowedOrigin`·`LOOPBACK_HOSTS` 제거 → import)

**Interfaces:**
- Produces: `OriginPolicy = (origin: string | undefined) => boolean` · `createLoopbackOriginPolicy(): OriginPolicy`(B3 시맨틱 승계: 부재→허용·loopback 호스트 허용·파싱불가 거부) · `createAllowlistOriginPolicy(allowed: readonly string[]): OriginPolicy`(부재→거부·**정확 문자열 일치만**) · `LOOPBACK_HOSTS: ReadonlySet<string>` — T4 gate·T5 boot 가 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/security/origin.test.ts
import { describe, expect, it } from 'vitest'
import { createAllowlistOriginPolicy, createLoopbackOriginPolicy } from './origin'

describe('createLoopbackOriginPolicy — B3 가드 승계(무회귀)', () => {
  const policy = createLoopbackOriginPolicy()
  it.each(['http://127.0.0.1:8791', 'http://localhost:5173', 'http://[::1]:8791'])(
    'loopback 오리진(%s) 허용',
    (o) => expect(policy(o)).toBe(true),
  )
  it('Origin 부재(비브라우저) 허용', () => expect(policy(undefined)).toBe(true))
  it.each(['https://evil.example.com', 'http://192.168.0.10:8791', 'not-a-url', 'null'])(
    '비loopback/파싱불가(%s) 거부',
    (o) => expect(policy(o)).toBe(false),
  )
})

describe('createAllowlistOriginPolicy — secured 정확일치(#197 B5)', () => {
  const policy = createAllowlistOriginPolicy(['https://fleet.example.com'])
  it('정확 일치만 허용', () => expect(policy('https://fleet.example.com')).toBe(true))
  it('Origin 부재 거부(fail-closed)', () => expect(policy(undefined)).toBe(false))
  it.each([
    'https://fleet.example.com.evil.com', // suffix 위장
    'https://evil.com/https://fleet.example.com', // path 위장
    'http://fleet.example.com', // scheme 다운그레이드
    'https://fleet.example.com:8443', // 포트 상이
    'HTTPS://FLEET.EXAMPLE.COM', // 대소문자 — 브라우저는 소문자 직렬화, 비정형 입력은 거부
    'null',
  ])('부분일치/위장(%s) 거부', (o) => expect(policy(o)).toBe(false))
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/security/origin.test.ts` → FAIL
- [ ] **Step 3: 구현**

```ts
// src/server/security/origin.ts
/**
 * Origin 정책(#197 B5) — HTTP·WS upgrade 공통. 브라우저는 WS 핸드셰이크에 SOP/CORS 를 적용하지
 * 않으므로(CSWSH) Origin 이 유일한 브라우저측 출처 신호다. loopback 정책은 B3 boot 가드의 승계
 * (부재=비브라우저 허용 — same-machine 신뢰 모델), allowlist 정책은 secured 모드 전용으로 정확
 * 문자열 일치만 허용한다(정규화·suffix 매칭 없음 — 위장 오리진 표면 제거).
 */
export type OriginPolicy = (origin: string | undefined) => boolean

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost'])

export function createLoopbackOriginPolicy(): OriginPolicy {
  return (origin) => {
    if (origin === undefined) return true // 비브라우저 클라이언트(Origin 미전송)
    try {
      const host = new URL(origin).hostname.replace(/^\[|\]$/g, '') // IPv6 대괄호 제거
      return LOOPBACK_HOSTS.has(host)
    } catch {
      return false // 파싱 불가 Origin 거부
    }
  }
}

export function createAllowlistOriginPolicy(allowed: readonly string[]): OriginPolicy {
  const exact = new Set(allowed)
  return (origin) => origin !== undefined && exact.has(origin)
}
```

boot.ts 에서 `isAllowedOrigin`·로컬 `LOOPBACK_HOSTS` 를 삭제하고 대체:

```ts
import { createLoopbackOriginPolicy, LOOPBACK_HOSTS } from './security/origin'
// …
const isAllowedOrigin = createLoopbackOriginPolicy() // T8 에서 gate 로 재배선될 임시 이름 유지
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/security/origin.test.ts src/server/boot.test.ts` → PASS (boot 기존 테스트 무회귀)
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): OriginPolicy 분리 — loopback 승계 + secured 정확일치 allowlist"`

---

### Task 3: Access JWT 검증 — `security/access-jwt.ts` (+ dep `jose`)

**Files:**
- Create: `src/server/security/access-jwt.ts`
- Test: `src/server/security/access-jwt.test.ts`
- Modify: `package.json` (`npm install jose` — dependencies · 서버 런타임 dep)

**Interfaces:**
- Consumes: `jose`(`createRemoteJWKSet`·`jwtVerify`·`errors` · 타입 `JWTVerifyGetKey`) · `node:http` IncomingHttpHeaders.
- Produces: `AccessAuthError { kind: 'unauthorized' | 'unavailable' }` · `AccessVerifier { verify(token: string | undefined): Promise<{ identity: string }> }` · `createAccessVerifier(cfg: { teamDomain: string; aud: string; getKey?: JWTVerifyGetKey }): AccessVerifier` · `extractAccessToken(headers: IncomingHttpHeaders): string | undefined` — T4 gate·T8 boot 가 소비. `getKey` 주입이 테스트(local JWKS)·프로덕션(remote JWKS) 분기점.

- [ ] **Step 1: `npm install jose` 실행** — package.json dependencies 에 `jose@^6` 추가 확인.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// src/server/security/access-jwt.test.ts
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { AccessAuthError, createAccessVerifier, extractAccessToken } from './access-jwt'

const TEAM = 'myteam.cloudflareaccess.com'
const AUD = 'aud-tag-123'

describe('createAccessVerifier — CF Access JWT 자체 검증(fail-closed · #197 B5)', () => {
  let privateKey: CryptoKey
  let getKey: ReturnType<typeof createLocalJWKSet>

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256' }] })
  })

  async function sign(mut: (jwt: SignJWT) => SignJWT = (j) => j): Promise<string> {
    return mut(
      new SignJWT({ email: 'me@example.com' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(`https://${TEAM}`)
        .setAudience(AUD)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('5m'),
    ).sign(privateKey)
  }

  it('유효 토큰 → identity(email 우선)', async () => {
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD, getKey })
    await expect(verifier.verify(await sign())).resolves.toEqual({ identity: 'me@example.com' })
  })

  it.each([
    ['토큰 부재', () => Promise.resolve(undefined)],
    ['iss 불일치', () => sign((j) => j.setIssuer('https://other.cloudflareaccess.com'))],
    ['aud 불일치', () => sign((j) => j.setAudience('wrong-aud'))],
    ['만료', () => sign((j) => j.setExpirationTime(Math.floor(Date.now() / 1000) - 60))],
    ['위조(형식 불량)', () => Promise.resolve('not.a.jwt')],
  ])('%s → unauthorized', async (_label, make) => {
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD, getKey })
    const err = await verifier.verify(await make()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessAuthError)
    expect((err as AccessAuthError).kind).toBe('unauthorized')
  })

  it('타 키 서명 → unauthorized', async () => {
    const other = await generateKeyPair('RS256')
    const forged = await new SignJWT({ email: 'me@example.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey)
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD, getKey })
    const err = await verifier.verify(forged).catch((e: unknown) => e)
    expect((err as AccessAuthError).kind).toBe('unauthorized')
  })

  it('키 조회 실패(네트워크류) → unavailable — 절대 fail-open 하지 않는다', async () => {
    const verifier = createAccessVerifier({
      teamDomain: TEAM,
      aud: AUD,
      getKey: () => Promise.reject(new TypeError('fetch failed')),
    })
    const err = await verifier.verify(await sign()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessAuthError)
    expect((err as AccessAuthError).kind).toBe('unavailable')
  })

  it('email 클레임 부재 시 sub 폴백 · 둘 다 없으면 unauthorized', async () => {
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD, getKey })
    const noEmail = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    await expect(verifier.verify(noEmail)).resolves.toEqual({ identity: 'user-1' })
  })
})

describe('extractAccessToken — 헤더 우선 · CF_Authorization 쿠키 폴백', () => {
  it('Cf-Access-Jwt-Assertion 헤더 우선', () => {
    expect(
      extractAccessToken({ 'cf-access-jwt-assertion': 'tok-h', cookie: 'CF_Authorization=tok-c' }),
    ).toBe('tok-h')
  })
  it('쿠키 폴백(다중 쿠키·= 포함 값)', () => {
    expect(extractAccessToken({ cookie: 'a=1; CF_Authorization=x.y.z==; b=2' })).toBe('x.y.z==')
  })
  it('둘 다 없으면 undefined', () => {
    expect(extractAccessToken({})).toBeUndefined()
  })
})
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/server/security/access-jwt.test.ts` → FAIL
- [ ] **Step 4: 구현**

```ts
// src/server/security/access-jwt.ts
import type { IncomingHttpHeaders } from 'node:http'
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'

/**
 * Cloudflare Access JWT 서버 자체 검증(#197 B5 · v3 §8 "터널 인증만 신뢰하지 않음"). cloudflared 가
 * 주입하는 Cf-Access-Jwt-Assertion(우선) 또는 CF_Authorization 쿠키를 팀 도메인 JWKS
 * (https://<team>/cdn-cgi/access/certs)로 검증한다. fail-closed 이원 분류:
 *  - unauthorized(401): 토큰 부재/위조/만료/iss·aud 불일치 — 요청자 문제.
 *  - unavailable(503): JWKS 조회 실패(네트워크/타임아웃) — 검증 불능이면 통과가 아니라 거부.
 * getKey 주입식이라 테스트는 createLocalJWKSet, 프로덕션은 createRemoteJWKSet(기본 캐시)을 쓴다.
 */
export class AccessAuthError extends Error {
  readonly kind: 'unauthorized' | 'unavailable'
  constructor(kind: 'unauthorized' | 'unavailable', message: string) {
    super(message)
    this.name = 'AccessAuthError'
    this.kind = kind
  }
}

export interface AccessVerifier {
  verify(token: string | undefined): Promise<{ identity: string }>
}

export function createAccessVerifier(cfg: {
  teamDomain: string
  aud: string
  getKey?: JWTVerifyGetKey
}): AccessVerifier {
  const issuer = `https://${cfg.teamDomain}`
  const getKey = cfg.getKey ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
  return {
    async verify(token) {
      if (!token) throw new AccessAuthError('unauthorized', 'Access JWT 부재')
      try {
        // algorithms 를 RS256 로 핀(체크포인트 4 P3): CF Access JWKS 는 RSA 만 노출하므로 alg
        // confusion 은 이미 닫혀 있으나, JWKS 구성 변화에 대비한 defense-in-depth 로 명시 제한.
        const { payload } = await jwtVerify(token, getKey, {
          issuer,
          audience: cfg.aud,
          algorithms: ['RS256'],
        })
        const email = typeof payload.email === 'string' ? payload.email : ''
        const identity = email || payload.sub || ''
        if (!identity) throw new AccessAuthError('unauthorized', 'identity 클레임(email/sub) 부재')
        return { identity }
      } catch (err) {
        if (err instanceof AccessAuthError) throw err
        if (err instanceof errors.JWKSTimeout) {
          throw new AccessAuthError('unavailable', 'JWKS 조회 타임아웃')
        }
        if (err instanceof errors.JOSEError) {
          throw new AccessAuthError('unauthorized', 'Access JWT 검증 실패')
        }
        // fetch TypeError 등 비-jose 오류 = 키 조회 인프라 실패 — fail-closed 로 unavailable.
        throw new AccessAuthError('unavailable', 'JWKS 조회 실패')
      }
    },
  }
}

/** Cf-Access-Jwt-Assertion 헤더 우선, CF_Authorization 쿠키 폴백. */
export function extractAccessToken(headers: IncomingHttpHeaders): string | undefined {
  const header = headers['cf-access-jwt-assertion']
  if (typeof header === 'string' && header) return header
  const cookie = headers.cookie
  if (!cookie) return undefined
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === 'CF_Authorization') return part.slice(eq + 1).trim()
  }
  return undefined
}
```

- [ ] **Step 5: 통과 확인** — `npx vitest run src/server/security/access-jwt.test.ts` → PASS
- [ ] **Step 6: 커밋** — `git add -A && git commit -m "feat(#197-B5): Access JWT 자체 검증 — jose JWKS·fail-closed 401/503 분류 (dep: jose)"`

---

### Task 4: 보안 게이트 합성 — `security/gate.ts`

**Files:**
- Create: `src/server/security/gate.ts`
- Test: `src/server/security/gate.test.ts`

**Interfaces:**
- Consumes: T1 `NonceStore` · T2 `OriginPolicy` · T3 `AccessVerifier`/`AccessAuthError`/`extractAccessToken`.
- Produces(T8 boot 소비):

```ts
export type HttpVerdict = { ok: true; identity: string | null } | { ok: false; status: 401 | 403 | 503 }
export interface SecurityGate {
  gateHttp(req: { headers: IncomingHttpHeaders }): Promise<HttpVerdict>
  gateUpgrade(req: { headers: IncomingHttpHeaders; url?: string }): Promise<boolean>
}
export function createSecurityGate(deps: {
  mode: 'loopback' | 'secured'
  originPolicy: OriginPolicy
  nonces: NonceStore
  verifier: AccessVerifier | null // secured 필수 — loopback 은 null
}): SecurityGate
```

**게이트 규칙(테스트가 곧 명세):**
- `gateHttp`: Origin **존재 시** 정책 위반 → 403(HTML 내비게이션은 Origin 미전송이라 통과 대상). secured 는 추가로 JWT 필수 — unauthorized → 401 · unavailable → 503. loopback 통과 시 identity=null.
- `gateUpgrade`: **nonce 를 다른 어떤 검사보다 먼저 소모**(성패 무관 — 체크포인트 2 §7). secured: nonce 필수 + Origin 존재·정확일치 + JWT 유효 + 바인딩(identity·origin) 일치 전부 만족. loopback: nonce 미제시 허용(B3 무회귀), 제시 시 유효+origin 바인딩 일치 필수. JWT 검증 오류는 종류 불문 거부(fail-closed).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/security/gate.test.ts
import { describe, expect, it } from 'vitest'
import type { AccessVerifier } from './access-jwt'
import { AccessAuthError } from './access-jwt'
import { createSecurityGate } from './gate'
import { createNonceStore } from './nonce'
import { createAllowlistOriginPolicy, createLoopbackOriginPolicy } from './origin'

const ORIGIN = 'https://fleet.example.com'
const okVerifier: AccessVerifier = {
  verify: (t) =>
    t === 'good-token'
      ? Promise.resolve({ identity: 'me@example.com' })
      : Promise.reject(new AccessAuthError('unauthorized', 'bad')),
}
const downVerifier: AccessVerifier = {
  verify: () => Promise.reject(new AccessAuthError('unavailable', 'jwks down')),
}

function securedGate(verifier: AccessVerifier = okVerifier) {
  const nonces = createNonceStore()
  return {
    nonces,
    gate: createSecurityGate({
      mode: 'secured',
      originPolicy: createAllowlistOriginPolicy([ORIGIN]),
      nonces,
      verifier,
    }),
  }
}
const authed = { 'cf-access-jwt-assertion': 'good-token', origin: ORIGIN }

describe('gateHttp — secured(#197 B5 게이트 ⑤)', () => {
  it('유효 JWT + 허용 Origin → 통과 + identity', async () => {
    const { gate } = securedGate()
    await expect(gate.gateHttp({ headers: authed })).resolves.toEqual({
      ok: true,
      identity: 'me@example.com',
    })
  })
  it('Origin 부재(HTML 내비게이션)는 JWT 만으로 통과', async () => {
    const { gate } = securedGate()
    const v = await gate.gateHttp({ headers: { 'cf-access-jwt-assertion': 'good-token' } })
    expect(v.ok).toBe(true)
  })
  it('비허용 Origin → 403 (JWT 유효해도)', async () => {
    const { gate } = securedGate()
    await expect(
      gate.gateHttp({ headers: { ...authed, origin: 'https://evil.com' } }),
    ).resolves.toEqual({ ok: false, status: 403 })
  })
  it('JWT 부재/위조 → 401', async () => {
    const { gate } = securedGate()
    await expect(gate.gateHttp({ headers: { origin: ORIGIN } })).resolves.toEqual({
      ok: false,
      status: 401,
    })
  })
  it('JWKS 불능 → 503 (fail-closed — 통과 아님)', async () => {
    const { gate } = securedGate(downVerifier)
    await expect(gate.gateHttp({ headers: authed })).resolves.toEqual({ ok: false, status: 503 })
  })
})

describe('gateHttp — loopback(무회귀)', () => {
  const gate = createSecurityGate({
    mode: 'loopback',
    originPolicy: createLoopbackOriginPolicy(),
    nonces: createNonceStore(),
    verifier: null,
  })
  it('JWT 없이 통과(identity null) · 비loopback Origin 은 403', async () => {
    await expect(gate.gateHttp({ headers: {} })).resolves.toEqual({ ok: true, identity: null })
    await expect(gate.gateHttp({ headers: { origin: 'https://evil.com' } })).resolves.toEqual({
      ok: false,
      status: 403,
    })
  })
})

describe('gateUpgrade — secured nonce 하드닝(#197 B5)', () => {
  async function issue(nonces: ReturnType<typeof createNonceStore>) {
    return nonces.issue({ identity: 'me@example.com', origin: ORIGIN })
  }
  it('nonce+JWT+Origin 전부 유효 → 허용, 같은 nonce 재사용 → 거부(단일사용)', async () => {
    const { gate, nonces } = securedGate()
    const nonce = await issue(nonces)
    const req = { headers: authed, url: `/ws?nonce=${nonce}` }
    await expect(gate.gateUpgrade(req)).resolves.toBe(true)
    await expect(gate.gateUpgrade(req)).resolves.toBe(false)
  })
  it('nonce 부재 → 거부(쿠키 자동첨부 우회 차단)', async () => {
    const { gate } = securedGate()
    await expect(gate.gateUpgrade({ headers: authed, url: '/ws' })).resolves.toBe(false)
  })
  it('Origin 바인딩 불일치 → 거부 · 그 nonce 는 소모돼 재시도도 불가(성패 무관 소모)', async () => {
    const { gate, nonces } = securedGate()
    const nonce = nonces.issue({ identity: 'me@example.com', origin: 'https://other.example.com' })
    await expect(gate.gateUpgrade({ headers: authed, url: `/ws?nonce=${nonce}` })).resolves.toBe(
      false,
    )
    expect(nonces.size()).toBe(0)
  })
  it('identity 바인딩 불일치(타인 nonce 탈취) → 거부', async () => {
    const { gate, nonces } = securedGate()
    const nonce = nonces.issue({ identity: 'attacker@example.com', origin: ORIGIN })
    await expect(gate.gateUpgrade({ headers: authed, url: `/ws?nonce=${nonce}` })).resolves.toBe(
      false,
    )
  })
  it('JWT 무효/JWKS 불능 → 거부(fail-closed) · nonce 는 그래도 소모', async () => {
    const { gate, nonces } = securedGate(downVerifier)
    const nonce = await issue(nonces)
    await expect(gate.gateUpgrade({ headers: authed, url: `/ws?nonce=${nonce}` })).resolves.toBe(
      false,
    )
    expect(nonces.size()).toBe(0)
  })
  it('Origin 부재 upgrade → 거부(secured 는 브라우저 전용 표면)', async () => {
    const { gate, nonces } = securedGate()
    const nonce = nonces.issue({ identity: 'me@example.com', origin: null })
    await expect(
      gate.gateUpgrade({ headers: { 'cf-access-jwt-assertion': 'good-token' }, url: `/ws?nonce=${nonce}` }),
    ).resolves.toBe(false)
  })
})

describe('gateUpgrade — loopback(B3/B4 무회귀 + 선택적 nonce)', () => {
  function loopbackGate() {
    const nonces = createNonceStore()
    return {
      nonces,
      gate: createSecurityGate({
        mode: 'loopback',
        originPolicy: createLoopbackOriginPolicy(),
        nonces,
        verifier: null,
      }),
    }
  }
  it('nonce 미제시(비브라우저·기존 테스트 클라) 허용', async () => {
    const { gate } = loopbackGate()
    await expect(gate.gateUpgrade({ headers: {}, url: '/ws' })).resolves.toBe(true)
  })
  it('제시된 nonce 는 유효해야 한다(무효 nonce → 거부)', async () => {
    const { gate } = loopbackGate()
    await expect(gate.gateUpgrade({ headers: {}, url: '/ws?nonce=bogus' })).resolves.toBe(false)
  })
  it('유효 nonce + origin 바인딩 일치 → 허용(웹스모크 경로)', async () => {
    const { gate, nonces } = loopbackGate()
    const origin = 'http://127.0.0.1:8791'
    const nonce = nonces.issue({ identity: null, origin })
    await expect(gate.gateUpgrade({ headers: { origin }, url: `/ws?nonce=${nonce}` })).resolves.toBe(
      true,
    )
  })
  it('비loopback Origin → 거부(기존 CSWSH 가드 유지)', async () => {
    const { gate } = loopbackGate()
    await expect(
      gate.gateUpgrade({ headers: { origin: 'https://evil.com' }, url: '/ws' }),
    ).resolves.toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/security/gate.test.ts` → FAIL
- [ ] **Step 3: 구현**

```ts
// src/server/security/gate.ts
import type { IncomingHttpHeaders } from 'node:http'
import { AccessAuthError, extractAccessToken, type AccessVerifier } from './access-jwt'
import type { NonceStore } from './nonce'
import type { OriginPolicy } from './origin'

/**
 * HTTP·WS upgrade 보안 게이트 합성(#197 B5). 규칙 요약:
 *  - HTTP: Origin 존재 시 정책 위반 → 403(HTML 내비게이션은 Origin 미전송). secured 는 JWT 필수
 *    (unauthorized 401 · JWKS 불능 503 — 검증 불능은 통과가 아니라 거부).
 *  - upgrade: nonce 를 다른 검사보다 먼저 소모(성패 무관 — 체크포인트 2 §7). secured 는
 *    nonce+Origin(존재·정확일치)+JWT+바인딩(identity·origin) 전부 필수. loopback 은 nonce 미제시
 *    허용(B3 무회귀 — Origin 가드가 CSWSH 차단)·제시 시 유효 필수.
 */
export type HttpVerdict =
  | { ok: true; identity: string | null }
  | { ok: false; status: 401 | 403 | 503 }

export interface SecurityGate {
  gateHttp(req: { headers: IncomingHttpHeaders }): Promise<HttpVerdict>
  gateUpgrade(req: { headers: IncomingHttpHeaders; url?: string }): Promise<boolean>
}

export function createSecurityGate(deps: {
  mode: 'loopback' | 'secured'
  originPolicy: OriginPolicy
  nonces: NonceStore
  verifier: AccessVerifier | null
}): SecurityGate {
  const { mode, originPolicy, nonces, verifier } = deps

  return {
    async gateHttp(req) {
      const origin = req.headers.origin
      if (origin !== undefined && !originPolicy(origin)) return { ok: false, status: 403 }
      if (mode !== 'secured') return { ok: true, identity: null }
      try {
        const { identity } = await verifier!.verify(extractAccessToken(req.headers))
        return { ok: true, identity }
      } catch (err) {
        const unavailable = err instanceof AccessAuthError && err.kind === 'unavailable'
        return { ok: false, status: unavailable ? 503 : 401 }
      }
    },

    async gateUpgrade(req) {
      // nonce 소모가 최우선 — 이후 어떤 검사가 실패해도 재시도 불가(단일사용 · 성패 무관 소모).
      const nonce = new URL(req.url ?? '/', 'http://local').searchParams.get('nonce')
      const binding = nonce === null ? null : nonces.consume(nonce)
      const origin = req.headers.origin

      if (mode === 'secured') {
        if (origin === undefined || !originPolicy(origin)) return false
        if (!binding) return false // nonce 부재/무효/만료/재사용
        let identity: string
        try {
          identity = (await verifier!.verify(extractAccessToken(req.headers))).identity
        } catch {
          return false // unauthorized 든 unavailable 이든 upgrade 는 전부 거부(fail-closed)
        }
        return binding.identity === identity && binding.origin === origin
      }

      // loopback — B3/B4 무회귀: Origin 가드 + (제시된 경우에만) nonce 유효성.
      if (!originPolicy(origin)) return false
      if (nonce === null) return true
      return binding !== null && binding.origin === (origin ?? null)
    },
  }
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/security/gate.test.ts` → PASS
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): 보안 게이트 합성 — HTTP 401/403/503·upgrade nonce 선소모·fail-closed"`

---

### Task 5: 보안 설정 해석 + non-loopback bind 게이트 개방 — `boot.ts`

**Files:**
- Modify: `src/server/boot.ts` (`resolveSecurityConfig` 신설 · `resolveBindHost(env, security)` 시그니처 변경)
- Modify: `src/server/boot.test.ts` (기존 `resolveBindHost` 테스트 갱신 + 신규)

**Interfaces:**
- Produces: `SecurityConfig { mode: 'loopback' | 'secured'; allowedOrigins: string[]; teamDomain: string | null; aud: string | null }` · `resolveSecurityConfig(env): SecurityConfig` · `resolveBindHost(env, security): string`. T8 이 소비. **호출부가 boot 내부뿐이므로 시그니처 변경은 boot.ts/boot.test.ts 한정.**

**규칙:** env 3종(`FLEET_ACCESS_TEAM_DOMAIN`·`FLEET_ACCESS_AUD`·`FLEET_ALLOWED_ORIGINS`) 전부 설정 → secured, 전부 미설정 → loopback, **일부만 설정 → throw**(어중간한 보안 fail-fast). `FLEET_ALLOWED_ORIGINS` 는 콤마 구분 정확 origin(각 항목 `new URL(o).origin === o` **+ `protocol==='https:'`** — 체크포인트 4 P2). non-loopback `FLEET_HOST` 는 secured 모드에서만 허용. **중간 커밋 창(체크포인트 4 P3)**: T5 가 secured bind 를 열지만 게이트 배선은 T8 이라, T5~T8 사이 체크아웃에서 `FLEET_HOST=0.0.0.0`+secured env 면 무인증 개방 창이 생긴다 — 단일 PR squash 라 master 엔 무영향이나, **T5·T8 을 한 PR 로 묶고 분할 머지 금지**(bisect 안전).

- [ ] **Step 1: 실패하는 테스트 작성** — boot.test.ts 의 기존 `resolveBindHost` describe 를 다음으로 교체:

```ts
// src/server/boot.test.ts — 기존 'resolveBindHost — B5 전 loopback 강제' describe 교체
import { resolveBindHost, resolveSecurityConfig } from './boot'

const SECURED_ENV = {
  FLEET_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com',
  FLEET_ACCESS_AUD: 'aud-tag-123',
  FLEET_ALLOWED_ORIGINS: 'https://fleet.example.com',
}

describe('resolveSecurityConfig — 3종 완비 or 전무(#197 B5)', () => {
  it('전무 → loopback 모드', () => {
    expect(resolveSecurityConfig({}).mode).toBe('loopback')
  })
  it('완비 → secured 모드 + origin 파싱', () => {
    const c = resolveSecurityConfig({
      ...SECURED_ENV,
      FLEET_ALLOWED_ORIGINS: 'https://fleet.example.com, https://fleet2.example.com',
    })
    expect(c.mode).toBe('secured')
    expect(c.allowedOrigins).toEqual(['https://fleet.example.com', 'https://fleet2.example.com'])
  })
  it.each([
    ['team 만', { FLEET_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' }],
    ['aud 누락', { FLEET_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', FLEET_ALLOWED_ORIGINS: 'https://a.com' }],
  ])('일부만 설정(%s) → throw(fail-fast)', (_l, env) => {
    expect(() => resolveSecurityConfig(env)).toThrow(/전부/)
  })
  it.each(['https://a.com/path', 'https://a.com/', 'a.com', 'ws://a.com', 'http://a.com'])(
    '비정형/비http(s) origin(%s) → throw',
    (o) => {
      expect(() => resolveSecurityConfig({ ...SECURED_ENV, FLEET_ALLOWED_ORIGINS: o })).toThrow()
    },
  )
  it('평문 http origin 거부(secured=HTTPS 터널 전제) · https 만 허용', () => {
    expect(resolveSecurityConfig({ ...SECURED_ENV, FLEET_ALLOWED_ORIGINS: 'https://a.com' }).mode).toBe(
      'secured',
    )
  })
})

describe('resolveBindHost — 개방은 secured 모드에서만(#197 B5 게이트)', () => {
  const loopback = resolveSecurityConfig({})
  const secured = resolveSecurityConfig(SECURED_ENV)
  it.each([undefined, '', '127.0.0.1', '::1', 'localhost'])('loopback(%s) 항상 허용', (v) => {
    expect(['127.0.0.1', '::1', 'localhost']).toContain(
      resolveBindHost({ FLEET_HOST: v }, loopback),
    )
  })
  it.each(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '192.168.0.10', 'fleet.example.com', '10.0.0.1'])(
    '보안 설정 없는 non-loopback(%s) → throw — 어떤 env 단독으로도 안 열림',
    (v) => {
      expect(() => resolveBindHost({ FLEET_HOST: v }, loopback)).toThrow(/보안/)
    },
  )
  it('secured 완비 시에만 non-loopback 허용', () => {
    expect(resolveBindHost({ FLEET_HOST: '0.0.0.0' }, secured)).toBe('0.0.0.0')
  })
})
```

bootServer 통합 기존 케이스도 갱신: `'non-loopback host 로는 부팅 자체가 거부된다'` 는 그대로 두되 기대 메시지 정규식을 `/보안/` 으로 변경(보안 미설정 + 0.0.0.0 → 거부 유지).

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/boot.test.ts` → FAIL
- [ ] **Step 3: 구현** — boot.ts 의 `resolveBindHost` 를 교체하고 `resolveSecurityConfig` 추가:

```ts
// src/server/boot.ts — 교체/추가
export interface SecurityConfig {
  mode: 'loopback' | 'secured'
  allowedOrigins: string[]
  teamDomain: string | null
  aud: string | null
}

/** 보안 env 3종은 전부 설정하거나 전부 비운다 — 어중간한 보안 구성은 부팅 거부(fail-fast). */
export function resolveSecurityConfig(env: NodeJS.ProcessEnv): SecurityConfig {
  const teamDomain = env['FLEET_ACCESS_TEAM_DOMAIN']?.trim() || null
  const aud = env['FLEET_ACCESS_AUD']?.trim() || null
  const originsRaw = env['FLEET_ALLOWED_ORIGINS']?.trim() || null
  const provided = [teamDomain, aud, originsRaw].filter((v) => v !== null).length
  if (provided === 0) return { mode: 'loopback', allowedOrigins: [], teamDomain: null, aud: null }
  if (provided < 3) {
    throw new Error(
      'FLEET_ACCESS_TEAM_DOMAIN·FLEET_ACCESS_AUD·FLEET_ALLOWED_ORIGINS 는 전부 설정하거나 전부 비워야 한다',
    )
  }
  const allowedOrigins = originsRaw!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allowedOrigins.length === 0) throw new Error('FLEET_ALLOWED_ORIGINS 가 비어 있다')
  for (const o of allowedOrigins) {
    let parsed: URL
    try {
      parsed = new URL(o)
    } catch {
      throw new Error(`FLEET_ALLOWED_ORIGINS 항목이 URL 이 아님: ${o}`)
    }
    if (parsed.origin !== o) {
      throw new Error(`FLEET_ALLOWED_ORIGINS 는 정확한 origin 형식이어야 함(path 금지): ${o}`)
    }
    // 체크포인트 4 P2/P3: ws:// 는 special scheme 이라 origin===o 를 통과한다 — https 만 강제해
    // 평문 다운그레이드·비브라우저 스킴을 배제(secured 는 HTTPS 터널 뒤 전제).
    if (parsed.protocol !== 'https:') {
      throw new Error(`FLEET_ALLOWED_ORIGINS 는 https origin 이어야 함: ${o}`)
    }
  }
  return { mode: 'secured', allowedOrigins, teamDomain, aud }
}

export function resolveBindHost(env: NodeJS.ProcessEnv, security: SecurityConfig): string {
  const raw = env['FLEET_HOST']?.trim()
  if (!raw) return '127.0.0.1'
  if (LOOPBACK_HOSTS.has(raw)) return raw
  if (security.mode !== 'secured') {
    throw new Error(
      `non-loopback bind 는 보안층(Access JWT·Origin allowlist·nonce) 완비 시에만 연다: ${raw}`,
    )
  }
  return raw
}
```

`bootServer` 상단은 임시로 `const security = resolveSecurityConfig(env); const host = resolveBindHost(env, security)` 로 배선(게이트 사용은 T8).

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/boot.test.ts` → PASS
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): 보안 env 3종 해석 + non-loopback bind 게이트 — secured 완비 시에만 개방"`

---

### Task 6: authenticated presence — `approval-bridge.rejectAll` + `ws-host.onAllClientsGone`

**Files:**
- Modify: `src/main/core/safety/approval-bridge.ts`
- Modify: `src/server/ws-host.ts`
- Test: `src/main/core/safety/approval-bridge.test.ts`(기존 파일에 추가 — 없으면 신규) · `src/server/ws-host.test.ts`(추가)

**Interfaces:**
- Produces: `IpcApprover.rejectAll(): void`(대기 전원 즉시 false 해소 — additive, 데스크톱 무영향) · `WsHostOptions.onAllClientsGone?: () => void`(클라이언트 수 >0 → 0 **전이 시에만** 발화). T8 boot 가 둘을 배선.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/main/core/safety/approval-bridge.test.ts — describe 추가
describe('rejectAll — 인증 presence 소멸 시 즉시 거부(#197 B5)', () => {
  it('대기 전원 false 해소 + pending 0 · 이후 resolve 는 무시(멱등)', async () => {
    const sent: ApprovalRequest[] = []
    const approver = createIpcApprover({
      send: (r) => sent.push(r),
      hasWindow: () => true,
      timeoutMs: 60_000,
    })
    const a = approver.approver({ id: 'a' } as ApprovalRequest)
    const b = approver.approver({ id: 'b' } as ApprovalRequest)
    expect(approver.pendingCount()).toBe(2)
    approver.rejectAll()
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBe(false)
    expect(approver.pendingCount()).toBe(0)
    approver.resolve('a', true) // 이미 해소 — 무시
  })
  it('대기 0 에서 호출해도 무해', () => {
    const approver = createIpcApprover({ send: () => {}, hasWindow: () => true })
    expect(() => approver.rejectAll()).not.toThrow()
  })
})
```

```ts
// src/server/ws-host.test.ts — describe 추가 (기존 테스트의 fake socket 헬퍼 재사용)
describe('onAllClientsGone — >0→0 전이에만 발화(#197 B5 presence)', () => {
  it('마지막 클라이언트 이탈 시 1회 발화, 중간 이탈/재이탈 중복 없음', () => {
    let fired = 0
    const host = createWsHost({
      handlers: {} as HandlerTable,
      eventCursor: () => ({ maxEventSeq: 0, minRetainedEventSeq: 0 }),
      onAllClientsGone: () => fired++,
    })
    const sock = () => ({ send: () => {}, close: () => {} })
    const b1 = host.attach(sock())
    const b2 = host.attach(sock())
    b1.onClose()
    expect(fired).toBe(0) // 아직 1명 남음
    b2.onClose()
    expect(fired).toBe(1)
    b2.onClose() // 중복 close(에러 경로 병행) — 재발화 없음
    expect(fired).toBe(1)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/main/core/safety/approval-bridge.test.ts src/server/ws-host.test.ts` → FAIL
- [ ] **Step 3: 구현**

approval-bridge.ts — 인터페이스와 구현에 추가:

```ts
// IpcApprover 에 추가
  /** 대기 전원 즉시 거부(#197 B5) — 인증 클라이언트 presence 가 0 이 되는 순간 fail-closed. */
  rejectAll: () => void
// 구현에 추가
    rejectAll() {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.resolve(false)
      }
      pending.clear()
    },
```

ws-host.ts — `WsHostOptions` 에 `onAllClientsGone?: () => void` 추가, `onClose` 교체:

```ts
        onClose() {
          // delete 반환값으로 전이 판정 — 중복 close(정상+error 경로 병행)에 재발화하지 않는다.
          if (clients.delete(socket) && clients.size === 0) opts.onAllClientsGone?.()
        },
```

- [ ] **Step 4: 통과 확인** — 위 두 테스트 + `npx vitest run src/server` 전체 무회귀.
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): presence 시임 — approver.rejectAll + ws-host onAllClientsGone 전이 콜백"`

---

### Task 7: 보안 헤더 — `static.ts` CSP·nosniff·캐싱

**Files:**
- Modify: `src/server/static.ts`
- Modify: `src/server/static.test.ts`

**Interfaces:**
- Produces: `WEB_CSP` 상수 export(테스트·문서 대조용). 헤더 규칙: **전 응답** `X-Content-Type-Options: nosniff` · **HTML**(index.html·SPA 폴백·`.html`) `Content-Security-Policy: WEB_CSP` + `Cache-Control: no-cache` + `Referrer-Policy: no-referrer` · **`/assets/` 정적**(비HTML 200) `Cache-Control: public, max-age=31536000, immutable`.
- CSP 값은 데스크톱 `src/renderer/index.html` 메타의 상위집합(동일 지시어 + 헤더 전용 강화):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

(`connect-src 'self'` 는 CSP3 에서 same-origin ws/wss 포함 — B4 리뷰에서 REFUTED 로 확정된 사안. `frame-ancestors 'none'` 은 클릭재킹 차단 — 메타로는 불가한 헤더 전용 지시어.)

- [ ] **Step 1: 실패하는 테스트 작성** — static.test.ts 에 describe 추가:

```ts
// src/server/static.test.ts — 추가 (기존 파일의 요청 헬퍼 재사용; 없으면 동형 작성)
import { WEB_CSP } from './static'

describe('보안 헤더(#197 B5) — CSP·nosniff·캐싱', () => {
  it('index.html 응답: CSP + no-cache + no-referrer + nosniff', async () => {
    const res = await request('/') // 기존 테스트 헬퍼
    expect(res.headers['content-security-policy']).toBe(WEB_CSP)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
  it('SPA 폴백 응답에도 CSP 부착', async () => {
    const res = await request('/some/route')
    expect(res.headers['content-security-policy']).toBe(WEB_CSP)
  })
  it('/assets/ 해시 번들: immutable 캐싱 + nosniff, CSP 없음', async () => {
    const res = await request('/assets/app.js') // 픽스처 루트에 assets/app.js 시드
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBeUndefined()
  })
  it('404/405 에도 nosniff', async () => {
    expect((await request('/no-such.png')).headers['x-content-type-options']).toBe('nosniff')
  })
  it('WEB_CSP 는 데스크톱 index.html 메타 CSP 의 상위집합(드리프트 가드)', async () => {
    // import.meta.dirname (Node 24) — 레포 vitest 테스트엔 __dirname 선례가 없다(ESM 변환 시 미정의).
    const html = await readFile(resolve(import.meta.dirname, '../renderer/index.html'), 'utf8')
    // http-equiv 로 앵커 — 첫 content= 는 viewport meta 라 앵커 없으면 그걸 잡는다(체크포인트 4 P1).
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
      html.replace(/\s+/g, ' '),
    )?.[1] ?? ''
    expect(meta).not.toBe('')
    for (const directive of meta.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(WEB_CSP).toContain(directive)
    }
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/static.test.ts` → FAIL
- [ ] **Step 3: 구현** — static.ts 의 `send` 를 헤더 인지형으로 교체:

```ts
// src/server/static.ts — 추가/교체 부분
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

const HTML_HEADERS = {
  'content-security-policy': WEB_CSP,
  'cache-control': 'no-cache',
  'referrer-policy': 'no-referrer',
} as const
const IMMUTABLE_HEADERS = { 'cache-control': 'public, max-age=31536000, immutable' } as const

  const send = (
    res: ServerResponse,
    status: number,
    body: Buffer | string,
    type: string,
    extra: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...extra })
    res.end(body)
  }
```

호출부 갱신: HTML 전송(루트 index.html·`.html` 확장자·SPA 폴백) → `send(res, 200, body, MIME['.html'], HTML_HEADERS)` / `/assets/` prefix 200 → `send(res, 200, body, mime, IMMUTABLE_HEADERS)` / 그 외(404·405 포함)는 extra 없음(nosniff 는 send 가 항상 부착).

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/static.test.ts` → PASS(기존 traversal/폴백 테스트 포함)
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): 정적 서빙 보안 헤더 — CSP(메타 상위집합)·nosniff·immutable 캐싱"`

---

### Task 8: boot 배선 — nonce endpoint·HTTP/upgrade 게이트·presence·BootDeps

**Files:**
- Modify: `src/server/boot.ts`
- Modify: `src/server/index.ts` (기동 로그 1줄)
- Modify: `src/server/boot.test.ts` (통합 테스트 추가)

**Interfaces:**
- Consumes: T1~T7 전부.
- Produces: `bootServer(env, deps?: BootDeps)` — `BootDeps { accessVerifier?: AccessVerifier }`(테스트 전용 주입: 실 JWKS 없이 secured 통합 검증). `POST /api/ws-nonce` endpoint(응답 `{ nonce }` JSON · `Cache-Control: no-store`).

- [ ] **Step 1: 실패하는 통합 테스트 작성** — boot.test.ts 에 추가:

```ts
// src/server/boot.test.ts — 추가
import type { AccessVerifier } from './security/access-jwt'
import { AccessAuthError } from './security/access-jwt'

function httpReq(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((res, rej) => {
    const r = httpRequest(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (m) => {
        let body = ''
        m.on('data', (c: Buffer) => (body += c.toString('utf8')))
        m.on('end', () => res({ status: m.statusCode ?? 0, headers: m.headers, body }))
      },
    )
    r.on('error', rej)
    r.end()
  })
}

describe('bootServer 통합 — loopback nonce 경로(#197 B5 · 무회귀 겸)', () => {
  it('POST /api/ws-nonce → no-store nonce → ?nonce= upgrade 성공 · 재사용 upgrade 거부', async () => {
    const server = await boot() // 기존 헬퍼(FLEET_E2E=1)
    try {
      const issued = await httpReq(server.port, '/api/ws-nonce', { method: 'POST' })
      expect(issued.status).toBe(200)
      expect(issued.headers['cache-control']).toBe('no-store')
      const { nonce } = JSON.parse(issued.body) as { nonce: string }

      const s1 = await connect(server.port, `/?nonce=${nonce}`) // connect 헬퍼에 path 인자 추가
      expect((await nextFrame(s1)).t).toBe('hello')
      s1.close()

      await expect(connect(server.port, `/?nonce=${nonce}`)).rejects.toThrow() // 단일사용
    } finally {
      await server.close()
    }
  })
  it('nonce 없는 접속은 여전히 허용(B3/B4 무회귀)', async () => {
    const server = await boot()
    try {
      const socket = await connect(server.port)
      expect((await nextFrame(socket)).t).toBe('hello')
      socket.close()
    } finally {
      await server.close()
    }
  })
})

describe('bootServer 통합 — secured 모드(#197 B5 게이트 ⑤)', () => {
  const ORIGIN = 'https://fleet.example.com'
  const securedEnv = () => ({
    FLEET_PORT: '0',
    FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b5-data-')),
    FLEET_E2E: '1',
    FLEET_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com',
    FLEET_ACCESS_AUD: 'aud-tag-123',
    FLEET_ALLOWED_ORIGINS: ORIGIN,
  })
  const okVerifier: AccessVerifier = {
    verify: (t) =>
      t === 'good-token'
        ? Promise.resolve({ identity: 'me@example.com' })
        : Promise.reject(new AccessAuthError('unauthorized', 'bad')),
  }
  const AUTH = { 'cf-access-jwt-assertion': 'good-token' }

  it('JWT 부재 → 정적/nonce 전부 401 · 위조 Origin → 403', async () => {
    const server = await bootServer(securedEnv(), { accessVerifier: okVerifier })
    try {
      expect((await httpReq(server.port, '/')).status).toBe(401)
      expect((await httpReq(server.port, '/api/ws-nonce', { method: 'POST' })).status).toBe(401)
      expect(
        (await httpReq(server.port, '/', { headers: { ...AUTH, origin: 'https://evil.com' } }))
          .status,
      ).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('JWT+Origin+nonce 전 사슬 → upgrade 성공 · nonce 없는 upgrade 는 JWT 유효해도 거부', async () => {
    const server = await bootServer(securedEnv(), { accessVerifier: okVerifier })
    try {
      const issued = await httpReq(server.port, '/api/ws-nonce', {
        method: 'POST',
        headers: { ...AUTH, origin: ORIGIN },
      })
      expect(issued.status).toBe(200)
      const { nonce } = JSON.parse(issued.body) as { nonce: string }
      const socket = await connect(server.port, `/?nonce=${nonce}`, { ...AUTH, origin: ORIGIN })
      expect((await nextFrame(socket)).t).toBe('hello')
      socket.close()

      await expect(connect(server.port, '/', { ...AUTH, origin: ORIGIN })).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  it('nonce POST 에 Origin 부재 → 403(secured 는 브라우저 표면 한정)', async () => {
    const server = await bootServer(securedEnv(), { accessVerifier: okVerifier })
    try {
      expect(
        (await httpReq(server.port, '/api/ws-nonce', { method: 'POST', headers: AUTH })).status,
      ).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('JWKS 도달 불가(실 remote 검증기) → 503 fail-closed — 어떤 요청도 통과하지 않는다', async () => {
    // deps 미주입 = 실 createRemoteJWKSet. 형식 불량 토큰('good-token')은 jwtVerify 가 JWKS fetch
    // *전에* JWSInvalid 로 던져 401 이 되므로(체크포인트 4 P2), 네트워크 경로를 열려면 **구조상 유효한**
    // 서명 JWT 를 보내야 한다 — 미존재 도메인이라 getKey 가 fetch 실패 → unavailable → 503.
    const { generateKeyPair, SignJWT } = await import('jose')
    const { privateKey } = await generateKeyPair('RS256')
    const TEAM = 'nonexistent-team-xyz.invalid'
    const wellFormed = await new SignJWT({ email: 'me@example.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(`https://${TEAM}`)
      .setAudience('aud-tag-123')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const server = await bootServer({ ...securedEnv(), FLEET_ACCESS_TEAM_DOMAIN: TEAM })
    try {
      const res = await httpReq(server.port, '/', {
        headers: { 'cf-access-jwt-assertion': wellFormed },
      })
      expect(res.status).toBe(503)
    } finally {
      await server.close()
    }
  })
})

describe('bootServer 통합 — 인증 presence 0 → outstanding 승인 즉시 reject 배선', () => {
  // 승인 요청을 실 런으로 유발하기 어려우므로 배선 자체는 시임 테스트(T6)가 권위.
  // 여기서는 마지막 클라이언트 이탈 시 approver.rejectAll 이 배선돼 있음을 boot 소스 정적 단언으로 핀
  // (eslint-config-purity 핀 테스트와 동형 패턴 — 배선 삭제/약화 무신호 방지).
  it('boot.ts 가 onAllClientsGone → rejectAll 를 배선한다', async () => {
    const src = await readFile(resolve(import.meta.dirname, 'boot.ts'), 'utf8') // Node 24 — __dirname 미사용
    expect(src).toMatch(/onAllClientsGone:\s*\(\)\s*=>\s*ipcApprover\.rejectAll\(\)/)
  })
})
```

`connect` 헬퍼 시그니처 확장: `connect(port, path = '/', headers?: Record<string, string>)` — `new WebSocket(\`ws://127.0.0.1:${port}${path}\`, { headers })` · 거부 시 `error`/`unexpected-response` 로 reject (ws 클라이언트는 `unexpected-response` 이벤트 — `socket.once('unexpected-response', (_r, m) => rej(new Error(\`upgrade 거부: ${m.statusCode}\`)))` 추가).

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/boot.test.ts` → FAIL
- [ ] **Step 3: 구현** — boot.ts `bootServer` 를 다음 형태로 배선:

```ts
// src/server/boot.ts — bootServer 내부 배선(발췌 · 기존 코드 유지 부분 생략)
import { createAccessVerifier, type AccessVerifier } from './security/access-jwt'
import { createSecurityGate } from './security/gate'
import { createNonceStore } from './security/nonce'
import {
  createAllowlistOriginPolicy,
  createLoopbackOriginPolicy,
  LOOPBACK_HOSTS,
} from './security/origin'

export interface BootDeps {
  /** 테스트 전용 — 실 JWKS 없이 secured 경로 통합 검증. 미주입 시 createRemoteJWKSet. */
  accessVerifier?: AccessVerifier
}

export async function bootServer(env: NodeJS.ProcessEnv, deps: BootDeps = {}): Promise<RunningServer> {
  const security = resolveSecurityConfig(env)
  const host = resolveBindHost(env, security)
  // … (기존 store/approver/engine 조립 그대로 — ipcApprover 는 기존 위치) …

  const nonces = createNonceStore()
  const verifier =
    security.mode === 'secured'
      ? (deps.accessVerifier ??
        createAccessVerifier({ teamDomain: security.teamDomain!, aud: security.aud! }))
      : null
  const gate = createSecurityGate({
    mode: security.mode,
    originPolicy:
      security.mode === 'secured'
        ? createAllowlistOriginPolicy(security.allowedOrigins)
        : createLoopbackOriginPolicy(),
    nonces,
    verifier,
  })

  wsHost = createWsHost({
    handlers,
    eventCursor: () => store.eventCursor(),
    // 인증 클라이언트 presence 소멸 = 승인 응답 주체 소멸 — 대기 승인 즉시 거부(fail-closed).
    onAllClientsGone: () => ipcApprover.rejectAll(),
  })

  const staticHandler = createStaticHandler(staticDir)
  const deny = (res: ServerResponse, status: number): void => {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'auth unavailable')
  }
  const httpServer = createServer((req, res) => {
    void (async () => {
      const verdict = await gate.gateHttp(req)
      if (!verdict.ok) {
        deny(res, verdict.status)
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://local').pathname
      if (req.method === 'POST' && pathname === '/api/ws-nonce') {
        const origin = req.headers.origin ?? null
        if (security.mode === 'secured' && origin === null) {
          deny(res, 403) // 브라우저 POST 는 Origin 을 항상 보낸다 — 부재 = 브라우저 아님
          return
        }
        const nonce = nonces.issue({ identity: verdict.identity, origin })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store', // 캐시/중간자 저장 금지(체크포인트 2 §7)
          'x-content-type-options': 'nosniff',
        })
        res.end(JSON.stringify({ nonce }))
        return
      }
      staticHandler(req, res)
    })().catch(() => {
      /* 응답 커밋 후 오류 — static 과 동형의 floating-promise 방어 */
    })
  })
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (
      info: { req: import('node:http').IncomingMessage },
      cb: (ok: boolean, code?: number, message?: string) => void,
    ) => {
      gate.gateUpgrade(info.req).then(
        (ok) => (ok ? cb(true) : cb(false, 401, 'unauthorized')),
        () => cb(false, 500),
      )
    },
  })
  // … (기존 connection 배선·listen·close 그대로) …
}
```

index.ts 로그 교체 — **`fleet-server: http://127.0.0.1:PORT` URL 형식 보존 필수**(체크포인트 4 P1: `e2e/web-server.ts:35` 의 `/fleet-server: (http:\/\/127\.0\.0\.1:\d+)/` 정규식이 웹 스모크 포트 파싱에 이걸 쓴다 — 형식 깨면 웹 e2e 전멸):

```ts
  .then((s) =>
    console.log(`fleet-server: http://127.0.0.1:${s.port} (보안 env 3종 미설정 시 loopback 고정)`),
  )
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server` → 전부 PASS(기존 B3 통합 포함 · flake 시 `--no-file-parallelism`)
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): boot 배선 — nonce endpoint·HTTP/upgrade 게이트·authenticated presence·BootDeps 주입"`

---

### Task 9: 클라이언트 — ws-bridge 비동기 connect 팩토리

**Files:**
- Modify: `src/renderer/bridge/ws-bridge.ts`
- Modify: `src/renderer/bridge/ws-bridge.test.ts` (추가)

**Interfaces:**
- 변경: `WsFactory = () => WsLike | Promise<WsLike>`(하위호환). **동기 반환은 반드시 동기 경로 유지**(체크포인트 4 P1) — 기존 ~30 테스트가 `createWsBridge(...)` 직후 **동기적으로** `sockets[0].open()` 을 호출하는데, 무조건 `await opts.connect()` 로 감싸면 소켓 핸들러 부착이 한 마이크로태스크 지연돼 그 open 이 무시된다(연쇄 실패). 팩토리 반환값의 thenable 여부로 분기: 동기값은 즉시 배선, Promise 만 비동기 배선. 팩토리 reject = 접속 실패 = close 와 동일 경로(백오프 재접속/terminal). T10 web-bridge 가 비동기 팩토리를 주입.

- [ ] **Step 1: 실패하는 테스트 작성** — ws-bridge.test.ts 에 추가(기존 FakeSocket 헬퍼 재사용):

```ts
describe('비동기 connect 팩토리(#197 B5 — nonce 선발급)', () => {
  it('Promise<WsLike> 팩토리로도 접속·요청이 동작한다', async () => {
    const sock = new FakeSocket()
    const bridge = createWsBridge({ connect: () => Promise.resolve(sock) })
    await Promise.resolve() // 팩토리 resolve 틱
    sock.onopen?.()
    const p = bridge.fleet.getAppInfo()
    sock.onmessage?.({ data: JSON.stringify({ t: 'res', id: 1, ok: true, value: { name: 'F' } }) })
    await expect(p).resolves.toEqual({ name: 'F' })
    bridge.dispose()
  })
  it('팩토리 reject(nonce 발급 실패 등) → 재접속 스케줄(백오프)', async () => {
    vi.useFakeTimers()
    let calls = 0
    const sock = new FakeSocket()
    const bridge = createWsBridge({
      connect: () => (++calls === 1 ? Promise.reject(new Error('nonce 실패')) : sock),
      initialBackoffMs: 10,
    })
    await Promise.resolve()
    await Promise.resolve() // reject 처리 틱
    expect(bridge.connectionState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toBe(2)
    bridge.dispose()
    vi.useRealTimers()
  })
  it('await 중 dispose → 소켓 즉시 close · stale 콜백 무시', async () => {
    let resolveFactory: (s: FakeSocket) => void = () => {}
    const bridge = createWsBridge({
      connect: () => new Promise<FakeSocket>((r) => (resolveFactory = r)),
    })
    bridge.dispose()
    const late = new FakeSocket()
    resolveFactory(late)
    await Promise.resolve()
    await Promise.resolve()
    expect(late.closed).toBe(true) // dispose 후 도착한 소켓은 곧장 닫는다
  })
})
```

- [ ] **Step 2: 실패 확인**(타입 에러 포함) — `npx vitest run src/renderer/bridge/ws-bridge.test.ts` → FAIL
- [ ] **Step 3: 구현** — 타입·openSocket 교체:

```ts
export type WsFactory = () => WsLike | Promise<WsLike>

  // 기존 동기 배선을 함수로 추출(변경 없음 — onopen/onmessage/onclose/onerror 기존 본문 그대로).
  function wire(s: WsLike): void {
    socket = s
    s.onopen = (): void => {
      if (s !== socket || disposed) return
      isOpen = true
      backoff = initialBackoff
      flushQueue()
      setState('connected')
    }
    s.onmessage = (ev): void => {
      if (s !== socket || disposed) return
      handleMessage(ev.data)
    }
    s.onclose = (): void => {
      if (s !== socket || disposed) return
      handleClose()
    }
    s.onerror = (): void => {
      /* 브라우저는 error 뒤 close 발화 — 재접속은 onclose 단일 경로 */
    }
  }

  function openSocket(): void {
    const result = opts.connect()
    // 동기 반환은 즉시 배선(하위호환 — 기존 테스트의 동기 open() 이 부착된 핸들러를 만난다).
    if (!(result instanceof Promise)) {
      wire(result)
      return
    }
    // Promise 팩토리(nonce 선발급)만 비동기 배선.
    result.then(
      (s) => {
        if (disposed) {
          try {
            s.close()
          } catch {
            /* dispose 경합 무해 */
          }
          return
        }
        wire(s)
      },
      () => {
        // 팩토리 실패(nonce 발급 실패·네트워크) = 접속 실패 — close 와 동일 백오프/종료 경로.
        if (!disposed) handleClose()
      },
    )
  }
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/bridge` → 기존 B2 계약 전부 무회귀 + 신규 PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): ws-bridge connect 팩토리 비동기 허용 — nonce 선발급 대비(실패=백오프 재접속)"`

---

### Task 10: 클라이언트 — web-bridge nonce 선발급 팩토리

**Files:**
- Modify: `src/renderer/bridge/web-bridge.ts`
- Modify: `src/renderer/bridge/web-bridge.test.ts`

**Interfaces:**
- 기본 팩토리 변경: 매 (재)접속마다 `POST /api/ws-nonce`(same-origin — CF_Authorization 쿠키 자동 동봉) → `{nonce}` → `ws(s)://<host>/ws?nonce=<encodeURIComponent>`. 발급 실패 throw → T9 백오프 경로. `initWebBridge(win, connect?)` 시그니처 불변(주입 테스트 유지).

- [ ] **Step 1: 실패하는 테스트 작성** — web-bridge.test.ts 에 추가:

```ts
describe('nonce 선발급 기본 팩토리(#197 B5)', () => {
  it('POST /api/ws-nonce 후 ?nonce= 로 접속한다', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${input}`)
      return { ok: true, json: async () => ({ nonce: 'n0nce+/=' }) } as Response
    }))
    const opened: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          opened.push(url)
        }
        send(): void {}
        close(): void {}
        onopen: null = null
        onmessage: null = null
        onclose: null = null
        onerror: null = null
      },
    )
    const win = { location: { protocol: 'http:', host: '127.0.0.1:8791' } } as WebBridgeWindow
    const bridge = initWebBridge(win)
    expect(bridge).not.toBeNull()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(urls).toEqual(['POST /api/ws-nonce'])
    expect(opened[0]).toBe('ws://127.0.0.1:8791/ws?nonce=n0nce%2B%2F%3D')
    bridge!.dispose()
    vi.unstubAllGlobals()
  })
  it('발급 실패(res.ok=false) → 팩토리 throw(재접속 백오프 경로)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response))
    // initWebBridge 내부 팩토리를 직접 검증하기 위해 createNonceFactory 를 export 해 단위 검증한다.
    await expect(
      createNonceFactory({ location: { protocol: 'https:', host: 'fleet.example.com' } } as WebBridgeWindow)(),
    ).rejects.toThrow(/503/)
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 1b: 기존 동기 URL 단언 테스트 교체(체크포인트 4 P2)** — `web-bridge.test.ts:61-62` 의 `initWebBridge(win)` 직후 동기 `expect(instances[0]!.url).toBe('wss://fleet.example:8443/ws')` 는 새 기본 팩토리가 **비동기 nonce fetch 선행**이라 동기 시점에 `instances` 가 비어 크래시한다. 이 케이스를 삭제하고 위 Step 1 의 nonce 팩토리 계약 테스트(POST → `?nonce=` 부착)로 대체한다. 주입 팩토리를 쓰는 나머지 기존 케이스(`initWebBridge(win, () => fakeSocket())` — 21·28·34행)는 무영향(주입 팩토리 우선).

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/bridge/web-bridge.test.ts` → FAIL
- [ ] **Step 3: 구현**

```ts
// src/renderer/bridge/web-bridge.ts — 추가/교체
/**
 * WS 접속 nonce 선발급 팩토리(#197 B5). 매 (재)접속마다 same-origin POST 로 단일사용 nonce 를 받아
 * upgrade 쿼리에 싣는다 — CF_Authorization 쿠키는 cross-site 에도 자동 첨부되지만 이 응답은 악성
 * 오리진이 (CORS 로) 읽을 수 없으므로 CSWSH 가 닫힌다. 발급 실패는 throw → ws-bridge 가 접속 실패와
 * 동일하게 백오프 재접속한다(TTL 60s·단일사용이라 재접속마다 재발급이 필수).
 */
export function createNonceFactory(win: WebBridgeWindow): () => Promise<WsLike> {
  const proto = win.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return async () => {
    // AbortSignal.timeout(체크포인트 4 P3): half-open 서버로 fetch 가 영영 안 끝나면 팩토리가 pending
    // 에 갇혀 재접속 체인 전체가 정지한다(reject·resolve 둘 다 없음) — 타임아웃으로 throw→백오프 경로.
    const res = await fetch('/api/ws-nonce', {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`ws-nonce 발급 실패: ${res.status}`)
    const { nonce } = (await res.json()) as { nonce: string }
    return browserSocket(`${proto}//${win.location.host}/ws?nonce=${encodeURIComponent(nonce)}`)
  }
}

export function initWebBridge(win: WebBridgeWindow = window, connect?: WsFactory): WsBridge | null {
  if (win.fleet) return null
  const bridge = createWsBridge({ connect: connect ?? createNonceFactory(win) })
  win.fleet = bridge.fleet
  return bridge
}
```

(`proto` 계산이 팩토리로 이동 — initWebBridge 의 기존 `proto` 지역변수 제거.)

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/bridge` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(#197-B5): web-bridge nonce 선발급 — 매 재접속 POST /api/ws-nonce → ?nonce= upgrade"`

---

### Task 11: 최종 — e2e 무회귀 · brain 재생성 · verify GREEN

**Files:**
- Modify: `brain.md`(재생성 산출물) — **이 태스크 전에는 절대 재생성하지 않는다.**

- [ ] **Step 1: 데스크톱 e2e 무회귀** — Run: `npm run test:e2e -- --project=electron` → 9/9 PASS (preload/main 무변경이므로 실패 시 원인 규명 필수).
- [ ] **Step 2: 웹 스모크 무회귀** — Run: `npm run test:e2e -- --project=web` → PASS. 이제 클라이언트가 nonce 경로로 접속하므로 이 스모크가 nonce 발급→소모 실경로를 덮는다(loopback 모드).
- [ ] **Step 3: brain 재생성** — Run: `npm run brain` (모든 src 변경 완료 후 최종 1회).
- [ ] **Step 4: 전체 게이트** — Run: `npm run verify` → GREEN (format:check 전에 `npx prettier --version` 이 lockfile 과 일치하는지 확인 — stale 회귀 함정).
- [ ] **Step 5: 커밋** — `git commit -m "chore(#197-B5): brain 재생성 + 게이트 GREEN"`
- [ ] **Step 6: (선택·라이브) secured 모드 실기동 스모크** — `FLEET_ACCESS_TEAM_DOMAIN=<Phase A 실 팀도메인> FLEET_ACCESS_AUD=<실 AUD> FLEET_ALLOWED_ORIGINS=https://fleet.example.com npm run start:server` 후 `curl -i http://127.0.0.1:8791/` → **401**(실 JWKS 도달 + 토큰 부재 fail-closed 실증 — 실 터널 e2e 는 B6 deploy 접합 몫).

---

## 완료 조건 ↔ 이슈 게이트 대조

| 이슈 B5 요구 | 구현 태스크 | 핀 테스트 |
|---|---|---|
| Origin 검증(HTTP·upgrade 공통) | T2·T4·T8 | origin.test(정확일치·위장 거부) · gate.test(403/upgrade 거부) · boot 통합 |
| Access JWT 자체 검증(jose JWKS·fail-closed) | T3·T4·T8 | access-jwt.test(위조/만료/타키/iss/aud → 401 · JWKS 불능 → 503) · boot 통합(실 remote 경로 503) |
| WS nonce 단일사용·TTL 60s | T1 | nonce.test(재사용 불가·만료·상한) |
| nonce identity+Origin 바인딩 | T4 | gate.test(identity/origin 불일치 거부) |
| 발급 endpoint `Cache-Control: no-store` | T8 | boot 통합(헤더 단언) |
| upgrade 성패 무관 소모 | T4 | gate.test(거부 후 size()=0) |
| CSP | T7 | static.test(헤더·메타 상위집합 드리프트 가드) |
| 승인 presence = **handshake-time** authenticated only · 검증 실패 socket 미포함 | T6·T8 | gate.test(upgrade 거부 = attach 미도달) · ws-host.test(전이 1회) |
| 인증 클라이언트 0 → outstanding 승인 즉시 reject | T6·T8 | approval-bridge.test(rejectAll) · boot 배선 정적 핀 |
| non-loopback bind 는 여기서만 설정 게이트로 개방 | T5 | boot.test(3종 완비 시에만 · 단독 env 전부 거부) |
| dep: jose | T3 | package.json |
| 게이트 ⑤ 미검증 Origin/identity 거부(#193 계약 테스트) | T4·T8 | gate.test + boot 통합 secured 4케이스 |
| 데스크톱 무회귀 | 전체 | electron e2e 9/9 · preload/main 무변경 |
| 미지 채널 echo 재평가(체크포인트 3 잔여) | 본 계획 | 재평가 완료: 유지(인증 뒤 표면·디버깅 가치) — 코드 변경 0 |

## 명시적 비범위

- 실 Cloudflare 터널·실 Access 로그인 e2e → **B6**(deploy 접합·라이브 5종 검증). B5 라이브는 T11 Step 6 의 로컬 secured 401 실증까지.
- 자식 spawn env 화이트리스트·fleet-data 0700 → **B6**.
- 다중 클라이언트 per-request 승인 delivery target 추적 → Phase B 비범위(단일 사용자 전제 — 체크포인트 2-R 합의).
- 레이트리밋/브루트포스 방어 — Access 앞단(Cloudflare) 몫. nonce 상한(MAX_PENDING)으로 메모리만 방어.
- 웹 playwright 의 secured 모드 브라우저 e2e — 실 Access 쿠키 없이는 모의가 과대(주입 verifier 는 boot 통합이 이미 커버).
- **소켓 수명 중 JWT 재검증 → B6**(체크포인트 4 P2-1): JWT 는 WS upgrade 1회만 검증되고 장수명 소켓(runProject 수 분) 동안 재검증 경로가 없다 — Access 세션 취소/JWT 만료 후에도 소켓 유지 시 승인 통제 지속. 그래서 완료조건표를 "**handshake-time** authenticated"로 정정. 주기적 재검증(만료 시 소켓 강제 close→rejectAll)은 B6 로 이관.

## 체크포인트 4 적대리뷰 반영 결과 (Codex 한도 소진 → 자체 2렌즈 find + 독립 refute)

**반영(코드/테스트 변경 — P1×3·P2×3·P3×3):**
- **P1** ws-bridge 비동기 팩토리 무회귀(T9): 무조건 `await` → **thenable 분기**(동기값 즉시 배선)로 교체 — 기존 ~30 동기 open() 테스트 보존.
- **P1** index.ts 로그(T8/T11): `fleet-server: http://127.0.0.1:PORT` URL 형식 **보존**(웹 e2e `web-server.ts:35` 정규식 의존).
- **P1** CSP 드리프트 regex(T7): `http-equiv="Content-Security-Policy"` 앵커로 교체(첫 매치 viewport meta 회피).
- **P2** 503 통합 테스트(T8): 형식 불량 `'good-token'` → 유효 서명 JWT 로 교체(getKey fetch 도달 → unavailable 503).
- **P2** `resolveSecurityConfig`(T5): `parsed.protocol==='https:'` 강제 + `ws://a.com,` 테스트 케이스를 http/ws 거부로 교정.
- **P2** web-bridge 기존 동기 URL 단언(T10): nonce 팩토리 계약 테스트로 대체 스텝 추가.
- **P3** jose `algorithms: ['RS256']` 핀(T3) · CSP `form-action 'self'` 추가(T7) · nonce fetch `AbortSignal.timeout` (T10 — 재접속 정지 방지) · 테스트 `__dirname`→`import.meta.dirname`(T7/T8).

**문서화(판단 — 코드 변경 없음):**
- loopback **cross-port localhost CSWSH** 잔존 표면(refuter CONFIRMED): Global Constraints 에 범위 정직성 명기 — secured 는 봉쇄, loopback web 을 공용 머신 상시 구동 시 nonce 필수 승격.
- presence 소켓-수명 JWT 재검증 → B6 이관(위 비범위).
- rejectAll 이 loopback 에도 배선 = 의도된 시맨틱 변경(리로드 후 응답 경로는 RunActivity 에 pending approval 부재로 원래도 없음 — 실회귀 아님).

**REFUTED(반영 안 함):** 브라우저 CSWSH 우회(file://·확장·DNS rebinding·`Origin:null` — 전부 Origin 가드 fail-closed) · alg none/HS confusion(jose API 차원 차단) · nonce 엔드포인트 CSRF(Origin 403+CORS 이중) · CF_Authorization 자동첨부(secured nonce 필수+CORS). MAX_PENDING 전역 축출 DoS·nonce URL 쿼리 유출은 단일 사용자 전제/WS API 제약상 **tier:later**(구현 시 access-log 마스킹 문서화 권고).

## Self-Review 결과 (작성 시 수행)

1. **스펙 커버리지**: 이슈 B5 문장 전 항목 → 위 대조표에 태스크 매핑 완료. 잔여 없음.
2. **플레이스홀더 스캔**: 코드 스텝 전부 실코드. boot.ts T8 발췌는 "기존 코드 유지 부분 생략" 명시 — 신규 라인은 전부 제시됨.
3. **타입 일관성**: `NonceBinding`(T1)↔gate(T4)↔boot(T8) · `AccessVerifier.verify → {identity}`(T3)↔gate/BootDeps · `WsFactory` 비동기 확장(T9)↔web-bridge(T10) · `resolveBindHost(env, security)`(T5)↔T8 — 교차 확인 완료.
