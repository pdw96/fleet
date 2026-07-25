# #197 B3 — 서버 엔트리 + 핸들러 + 어댑터 + 정적 서빙 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 헤드리스 `fleet-server`(Node) — Electron main 의 `registerIpc` 핸들러를 WS 로 이사해 브라우저 클라이언트(ws-bridge, B2 착지)가 코어 엔진을 구동할 수 있게 한다. B5 전까지 loopback bind 고정.

**Architecture:** 코어 엔진(`createFleetEngine`)·store·approver 는 그대로 재사용하고 **전송층만** 신설한다. `src/server/` 에 엔트리(`index`→`boot` 조립)·WS 호스트(`ws-host`)·핸들러 테이블(`handlers` — `satisfies` 로 FleetBridge 시그니처 파생 강제)·어댑터 2종(`env-key-crypto` AES-256-GCM · 워크스페이스 env 경로 검증)·정적 서빙(`static`)을 둔다. 프레임 계약은 B2 의 `src/shared/transport/{protocol,channels,fixtures}` 를 소비하며, 서버측 신뢰 경계용 `decodeClientFrame` 만 protocol 에 추가한다.

**Tech Stack:** TypeScript(strict) · Node 24 · `ws`(신규 dep) · vite SSR 빌드(`vite.server.config.ts` → `out/server/index.mjs`) · vitest.

**설계 권위:** 이슈 #197 본문 B3 항목 + 체크포인트 2/2-R 리뷰(이슈 코멘트) + `docs/fleet-saas-infra-plan-v3.html` §6·§7·§8.

## Global Constraints

- **데스크톱 무회귀**: `src/main/index.ts`·`src/preload/**`·`src/renderer/**` 는 **무변경**. 변경 허용 파일은 이 계획의 Files 목록이 전부.
- **loopback bind 강제(B5 전)**: `FLEET_HOST` 가 `127.0.0.1`/`::1`/`localhost`/미설정 외 값이면 **부팅 거부(throw)**. `0.0.0.0`·`::`·외부 host 거부를 단위 테스트로 핀(이슈 B3 완료 조건).
- **에러 응답 스택 미노출**: res error 프레임은 `error.message` 만(B2 프로토콜 계약 — `makeErrFrame`).
- **핸들러 테이블 타입 강제**: `satisfies`/mapped type 으로 `BothInvokeChannel` 전량 + FleetBridge 파생 시그니처를 tsc 가 강제(체크포인트 2 §1).
- **시크릿 키는 env 만**: `FLEET_SECRET_KEY` — 파일/볼륨 로딩 경로 금지(이슈 B3 명시).
- **순수성 게이트 확장**: `src/server/**`·`src/shared/transport/**` 에 electron/DOM-free ESLint 게이트 적용 + `scripts/eslint-config-purity.test.ts` 로 게이트 자체 핀.
- **`FLEET_E2E === '1'` 엄격 핀** 유지(`isE2EActive` 재사용 — 술어 복제 금지).
- **품질 게이트**: 매 태스크 끝 커밋 전 해당 테스트 GREEN, 최종 `npm run verify` GREEN(= skills:lint·brain:check·format:check·typecheck·lint·test:coverage·build). `src/` 변경 시 `npm run brain` 재생성 필수(brain:check 가 강제).
- **런타임 인자 스키마 validator 는 비범위**(체크포인트 2 §1 판정 — fixture 계약 테스트로 대체). 서버측 인자 신뢰 정규화는 Electron IPC 현행과 동일 수준(엔진 내부 검증)으로 유지.
- **컨벤션**: 주석 한국어·기존 밀도 준수. 커밋 prefix `feat(#197-B3):`. 브랜치 `feat/197-b3-server-entry`(master 직접 push 는 ruleset 이 차단).

## 파일 구조 (책임 지도)

```
src/server/
  index.ts            엔트리 1줄대 — boot 호출 + SIGINT/SIGTERM 종료 배선(테스트 비대상 최소화)
  boot.ts             env 파싱(resolveBindHost=loopback 게이트·port·dataDir·workspaceRoot) + 조립(bootServer)
  handlers.ts         BothInvokeChannel 32개 핸들러 테이블 — FleetBridge 시그니처 파생 타입 강제
  ws-host.ts          WS 세션 호스트 — hello·req 디스패치·push 브로드캐스트·presence(clientCount)
  env-key-crypto.ts   SecretCrypto 어댑터 — AES-256-GCM(FLEET_SECRET_KEY env)
  static.ts           renderer 정적 서빙 — traversal 가드·SPA 폴백
  *.test.ts           각 모듈 동반 테스트(+ boot.test.ts 는 실 ws 클라이언트 통합)
src/shared/transport/protocol.ts   decodeClientFrame 추가(서버측 신뢰 경계)
vite.server.config.ts              SSR 번들 → out/server/index.mjs
eslint.config.mjs · scripts/eslint-config-purity.test.ts   게이트 확장 + 핀
tsconfig.node.json · package.json · electron-builder.yml    배선(include·deps·build 체이닝·패키징 제외)
```

이슈 본문의 파일 명명(`{index,ws-host,handlers,env-key-crypto,static}`)에서 **`boot.ts` 만 추가 분리** — `index.ts` 는 import 부수효과로 listen 하는 엔트리라 단위 테스트가 불가능하므로, 조립 함수(`bootServer`, 포트 0 테스트 가능)를 분리한다. 이슈의 5파일 의도(책임 분리)를 강화하는 방향의 최소 일탈.

**핸들러 수 주석**: `registerIpc` 는 33개를 등록하지만 그중 `fleet:external:openDocs` 는 `scope: 'desktop'`(B2 에서 웹은 클라 동기 도출로 확정) → **서버 테이블은 both invoke 32개**. update 7채널도 desktop 전용이라 미등록(미지 채널 invoke 는 hang 이 아니라 명시 에러 res).

---

### Task 0: 의존성·배선 스캐폴딩

**Files:**
- Modify: `package.json` (deps `ws`, devDeps `@types/ws`, scripts)
- Modify: `tsconfig.node.json` (include 에 `src/server`)
- Modify: `electron-builder.yml` (데스크톱 패키징에서 서버 번들 제외)

**Interfaces:**
- Produces: 이후 전 태스크의 컴파일/린트 환경(`src/server/**` 가 tsc·type-aware lint 대상이 됨).

- [ ] **Step 1: 브랜치 생성**

```bash
git checkout master && git pull && git checkout -b feat/197-b3-server-entry
```

- [ ] **Step 2: ws 설치**

```bash
npm install ws && npm install -D @types/ws
```

Expected: `package.json` dependencies 에 `"ws": "^8.x"`, devDependencies 에 `"@types/ws"`.

- [ ] **Step 3: tsconfig.node.json include 확장**

`tsconfig.node.json` 의 include 를 다음으로 교체:

```json
  "include": ["src/main", "src/preload", "src/server", "src/shared", "scripts"]
```

(ESLint 타입인지 린팅은 `parserOptions.project` 가 이 tsconfig 을 참조하므로 자동 편입.)

- [ ] **Step 4: electron-builder 패키징에서 서버 번들 제외**

`electron-builder.yml` files 를:

```yaml
files:
  - out/**
  - '!out/server/**' # 서버 번들은 컨테이너 전용(B6 deploy) — 데스크톱 asar 에 싣지 않는다
  - package.json
```

- [ ] **Step 5: 패키징 제외 핀 테스트** — `scripts/electron-builder-pin.test.ts` 신규(config 핀 패턴 — eslint-config-purity 와 동형, 체크포인트 3 권고):

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #197 B3: 서버 번들(out/server)은 컨테이너 전용 — 데스크톱 asar 에 실리면 무의미한 비대화이고,
// files 글롭이 조용히 되돌아가도 빌드는 green 이라 무신호다 → 설정 텍스트로 핀한다.
describe('electron-builder 패키징 제외 핀(#197 B3)', () => {
  it('files 가 out/server 를 제외한다', () => {
    const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
    expect(yml).toMatch(/!out\/server\/\*\*/)
  })
})
```

Run: `npx vitest run scripts/electron-builder-pin.test.ts` → PASS.

- [ ] **Step 6: 기존 게이트 무회귀 확인 후 커밋**

```bash
npm run typecheck && npm run lint
git add package.json package-lock.json tsconfig.node.json electron-builder.yml scripts/electron-builder-pin.test.ts
git commit -m "chore(#197-B3): ws 의존성 + src/server tsc/lint 배선 + 데스크톱 패키징 제외(핀 테스트)"
```

---

### Task 1: `decodeClientFrame` — 서버측 신뢰 경계 (shared/transport)

**Files:**
- Modify: `src/shared/transport/protocol.ts`
- Test: `src/shared/transport/protocol.test.ts` (기존 파일에 describe 추가)

**Interfaces:**
- Consumes: 기존 `ReqFrame`.
- Produces: `decodeClientFrame(data: string): ReqFrame | null` — Task 4(ws-host)가 소비. 불변식: `t==='req'` · `id` 정수 · `ch` string · `args` 배열. 위반은 null(호출부 무시 — 응답 없음).

- [ ] **Step 1: 실패하는 테스트 작성**

`protocol.test.ts` 에 추가(파일 상단 import 에 `decodeClientFrame` 포함시킬 것):

```ts
describe('decodeClientFrame — 서버측 신뢰 경계(#197 B3)', () => {
  it('정상 req 프레임을 파싱한다', () => {
    const f = decodeClientFrame(JSON.stringify({ t: 'req', id: 1, ch: 'fleet:app:info', args: [] }))
    expect(f).toEqual({ t: 'req', id: 1, ch: 'fleet:app:info', args: [] })
  })

  it('양의 safe integer id 만 허용한다', () => {
    expect(
      decodeClientFrame(
        JSON.stringify({ t: 'req', id: Number.MAX_SAFE_INTEGER, ch: 'x', args: [] }),
      ),
    ).not.toBeNull()
  })

  it.each([
    ['깨진 JSON', '{nope'],
    ['비객체', '"str"'],
    ['미지 t', JSON.stringify({ t: 'push', ch: 'x', event: 1 })],
    ['id 비정수', JSON.stringify({ t: 'req', id: 1.5, ch: 'x', args: [] })],
    ['id 비수치', JSON.stringify({ t: 'req', id: 'a', ch: 'x', args: [] })],
    ['id 0/음수', JSON.stringify({ t: 'req', id: 0, ch: 'x', args: [] })],
    ['id -1', JSON.stringify({ t: 'req', id: -1, ch: 'x', args: [] })],
    ['id unsafe 범위', JSON.stringify({ t: 'req', id: 9007199254740992, ch: 'x', args: [] })],
    ['ch 비문자열', JSON.stringify({ t: 'req', id: 1, ch: 7, args: [] })],
    ['args 비배열', JSON.stringify({ t: 'req', id: 1, ch: 'x', args: {} })],
  ])('%s → null (무시)', (_name, wire) => {
    expect(decodeClientFrame(wire)).toBeNull()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/shared/transport/protocol.test.ts`
Expected: FAIL — `decodeClientFrame is not defined`(import 에러).

- [ ] **Step 3: 구현**

`protocol.ts` 말미에 추가:

```ts
/**
 * 와이어 문자열을 ClientFrame(req)으로 안전 파싱 — 서버측 신뢰 경계(#197 B3, decodeFrame 의 대칭).
 * 불변식 위반은 null — 호출부(ws-host)가 무시한다(응답 없음: id 를 신뢰할 수 없는 프레임엔
 * correlation 가능한 res 를 만들 수 없다). id 는 **양의 safe integer 한정**(체크포인트 3 P2-1):
 * correlation id 는 res 에 그대로 반사되므로 비정상 id(0/음수/unsafe/소수)를 허용하면 클라 pending
 * map 쪽에 추적 어려운 edge 가 생긴다(ws-bridge 는 ++lastId 로 1부터 발급 — 정상 경로 무영향).
 * args 원소의 내용 검증은 비범위(런타임 validator 비범위 정책 — 체크포인트 2 §1).
 */
export function decodeClientFrame(data: string): ReqFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const f = parsed as Record<string, unknown>
  if (f['t'] !== 'req') return null
  const id = f['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (typeof f['ch'] !== 'string') return null
  if (!Array.isArray(f['args'])) return null
  return parsed as ReqFrame
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/shared/transport/protocol.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/transport/protocol.ts src/shared/transport/protocol.test.ts
git commit -m "feat(#197-B3): decodeClientFrame — 서버측 req 프레임 신뢰 경계 검증"
```

---

### Task 2: `env-key-crypto` — AES-256-GCM SecretCrypto 어댑터

**Files:**
- Create: `src/server/env-key-crypto.ts`
- Test: `src/server/env-key-crypto.test.ts`

**Interfaces:**
- Consumes: `SecretCrypto`(`src/main/core/secret/types.ts` — `isAvailable()/encrypt()/decrypt()` 동기 계약).
- Produces: `createEnvKeyCrypto(env: NodeJS.ProcessEnv): SecretCrypto` · `parseSecretKey(raw: string | undefined): Buffer | null` — Task 6(boot)이 엔진에 주입.
- 정책: 키 소스는 **`FLEET_SECRET_KEY` env 만**(파일/볼륨 금지). 64자 hex 또는 32바이트 base64. 암호문 prefix `ev1:`(safeStorage `v1:` 과 구분 — 포맷 혼동 시 decrypt 명시 throw). 키 부재/형식 오류 → `isAvailable()=false`(코어는 시크릿 미영속으로 동작 — NOOP_CRYPTO 와 동일 강등, 부팅은 계속).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it } from 'vitest'
import { createEnvKeyCrypto, parseSecretKey } from './env-key-crypto'

const HEX_KEY = 'a'.repeat(64)
const B64_KEY = Buffer.alloc(32, 7).toString('base64')

describe('parseSecretKey', () => {
  it('64자 hex → 32바이트', () => {
    expect(parseSecretKey(HEX_KEY)?.length).toBe(32)
  })
  it('32바이트 base64 → 32바이트', () => {
    expect(parseSecretKey(B64_KEY)?.length).toBe(32)
  })
  it.each([undefined, '', 'short', 'g'.repeat(64), Buffer.alloc(16).toString('base64')])(
    '부재/형식 오류(%s) → null',
    (raw) => {
      expect(parseSecretKey(raw)).toBeNull()
    },
  )
})

describe('createEnvKeyCrypto — AES-256-GCM(#197 B3)', () => {
  const crypto = createEnvKeyCrypto({ FLEET_SECRET_KEY: HEX_KEY })

  it('키 유효 → isAvailable true, 왕복 성공', () => {
    expect(crypto.isAvailable()).toBe(true)
    const token = crypto.encrypt('sk-api-키-비밀')
    expect(token.startsWith('ev1:')).toBe(true)
    expect(token).not.toContain('sk-api')
    expect(crypto.decrypt(token)).toBe('sk-api-키-비밀')
  })

  it('IV 랜덤 — 같은 평문도 매번 다른 암호문', () => {
    expect(crypto.encrypt('x')).not.toBe(crypto.encrypt('x'))
  })

  it('변조된 암호문 → throw (GCM 인증 실패)', () => {
    const token = crypto.encrypt('secret')
    const buf = Buffer.from(token.slice(4), 'base64')
    buf[buf.length - 1] ^= 0xff
    expect(() => crypto.decrypt('ev1:' + buf.toString('base64'))).toThrow()
  })

  it('다른 키로 decrypt → throw', () => {
    const other = createEnvKeyCrypto({ FLEET_SECRET_KEY: 'b'.repeat(64) })
    expect(() => other.decrypt(crypto.encrypt('secret'))).toThrow()
  })

  it('미지 prefix(safeStorage v1: 등) → 명시 throw', () => {
    expect(() => crypto.decrypt('v1:abcd')).toThrow(/포맷/)
  })

  it('키 부재 → isAvailable false, encrypt/decrypt throw', () => {
    const none = createEnvKeyCrypto({})
    expect(none.isAvailable()).toBe(false)
    expect(() => none.encrypt('x')).toThrow()
    expect(() => none.decrypt('ev1:xx')).toThrow()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/env-key-crypto.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretCrypto } from '../main/core/secret/types'

// 암호문 포맷 버전 — safeStorage 어댑터의 'v1:' 과 구분(포맷 혼동 시 decrypt 가 명시 throw).
const PREFIX = 'ev1:'
const IV_LEN = 12 // GCM 권장 96-bit
const TAG_LEN = 16

/** FLEET_SECRET_KEY 파싱 — 64자 hex 또는 32바이트 base64 만 유효. 그 외 null(미가용 강등). */
export function parseSecretKey(raw: string | undefined): Buffer | null {
  if (!raw) return null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  const b = Buffer.from(raw, 'base64')
  return b.length === 32 ? b : null
}

/**
 * 서버용 SecretCrypto(#197 B3) — safeStorage(Electron OS 키체인) 대체 어댑터. 컨테이너엔 OS 키체인이
 * 없으므로 AES-256-GCM + env 키(FLEET_SECRET_KEY)로 API 키를 암호화 영속한다. 키 소스는 env 만
 * (파일/볼륨 로딩 금지 — 이슈 #197 B3). 키 부재/형식 오류는 isAvailable=false → 코어가 시크릿을
 * 영속하지 않는 안전 강등(NOOP_CRYPTO 동형). 포맷: ev1: + base64(iv(12) | tag(16) | ciphertext).
 */
export function createEnvKeyCrypto(env: NodeJS.ProcessEnv): SecretCrypto {
  const key = parseSecretKey(env['FLEET_SECRET_KEY'])
  const requireKey = (): Buffer => {
    if (!key) throw new Error('FLEET_SECRET_KEY 미설정/형식 오류(64자 hex 또는 32바이트 base64)')
    return key
  }
  return {
    isAvailable: () => key !== null,
    encrypt(plain) {
      const iv = randomBytes(IV_LEN)
      const cipher = createCipheriv('aes-256-gcm', requireKey(), iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    },
    decrypt(token) {
      if (!token.startsWith(PREFIX)) throw new Error('알 수 없는 암호문 포맷')
      const buf = Buffer.from(token.slice(PREFIX.length), 'base64')
      const decipher = createDecipheriv('aes-256-gcm', requireKey(), buf.subarray(0, IV_LEN))
      decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN))
      const ct = buf.subarray(IV_LEN + TAG_LEN)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
  }
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/env-key-crypto.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/server/env-key-crypto.ts src/server/env-key-crypto.test.ts
git commit -m "feat(#197-B3): env-key-crypto — AES-256-GCM SecretCrypto 어댑터(FLEET_SECRET_KEY env 전용)"
```

---

### Task 3: `handlers` — BothInvokeChannel 32핸들러 테이블 (타입 강제 이사)

**Files:**
- Create: `src/server/handlers.ts`
- Test: `src/server/handlers.test.ts`

**Interfaces:**
- Consumes: `FleetEngine`(`src/main/core/engine`) · `IpcApprover`(`src/main/core/safety/approval-bridge`) · `AppInfo`/`FleetBridge`(`src/shared/types`) · `BothInvokeChannel`/`invokeChannels`(`src/shared/transport/channels`).
- Produces: `createHandlers(deps: HandlerDeps): HandlerTable` — Task 4(ws-host)·Task 6(boot)이 소비. `HandlerTable = { [C in BothInvokeChannel]: (...args: Parameters<FleetBridge[대응메서드]>) => 반환 | Promise<반환> }`.
- 시맨틱 결정 3건(main/index.ts `registerIpc` 와의 의도적 차이):
  1. `fleet:app:info` → 주입된 `appInfo`(`runtime:'web'` 스탬프·version 은 boot 이 산출) 반환.
  2. `fleet:workspace:select` → **dialog 없음(헤드리스)** — Electron 의 "dialog 취소" 시맨틱과 동형으로 `engine.getWorkspace()` 그대로 반환. 웹 경로 설정 UI 는 B4 `fleet:workspace:set` 신설 몫(워크스페이스 경로 검증 어댑터의 boot 측 절반은 Task 6).
  3. 나머지 30개 → `registerIpc` 의 엔진 위임을 기계적으로 이사(로직 변경 0).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, AppInfo } from '../shared/types'
import { invokeChannels } from '../shared/transport/channels'
import { CHANNEL_FIXTURES } from '../shared/transport/fixtures'
import { createFleetEngine } from '../main/core/engine'
import { createIpcApprover } from '../main/core/safety/approval-bridge'
import { createHandlers } from './handlers'

const APP_INFO: AppInfo = {
  name: 'Fleet',
  version: '0.0.0-test',
  electron: '',
  node: process.versions.node,
  chrome: '',
  runtime: 'web',
}

function build() {
  const sent: ApprovalRequest[] = []
  const approver = createIpcApprover({ send: (r) => sent.push(r), hasWindow: () => true })
  const engine = createFleetEngine({ approver: approver.approver })
  return { engine, approver, sent, handlers: createHandlers({ engine, approver, appInfo: APP_INFO }) }
}

describe('서버 핸들러 테이블(#197 B3)', () => {
  it('테이블 키가 매니페스트 both invoke 와 정확히 일치한다(3면 parity 의 서버면)', () => {
    const { handlers } = build()
    expect(Object.keys(handlers).sort()).toEqual(invokeChannels('both'))
  })

  it('모든 both invoke 채널에 fixture 가 존재한다(직렬화 계약 커버리지 재확인)', () => {
    expect(Object.keys(CHANNEL_FIXTURES).sort()).toEqual(invokeChannels('both'))
  })

  it('app:info 가 runtime=web 을 스탬프한다', async () => {
    const { handlers } = build()
    await expect(Promise.resolve(handlers['fleet:app:info']())).resolves.toEqual(APP_INFO)
  })

  it('workspace:select 는 dialog 없이 현재 워크스페이스를 그대로 반환한다(취소 시맨틱)', async () => {
    const { handlers, engine } = build()
    expect(await handlers['fleet:workspace:select']()).toBeNull()
    engine.setWorkspace('C:/tmp/ws')
    expect(await handlers['fleet:workspace:select']()).toBe('C:/tmp/ws')
  })

  it('approval:respond 가 approver pending 을 해소한다', async () => {
    const { handlers, approver, sent } = build()
    const decision = approver.approver({
      id: 'appr-1',
      summary: 't',
      command: 'rm',
      classification: 'destructive',
    } as unknown as ApprovalRequest)
    expect(sent).toHaveLength(1)
    await handlers['fleet:approval:respond'](sent[0].id, true)
    await expect(decision).resolves.toBe(true)
  })

  it('엔진 위임 대표 경로 — registerCli → session:list 왕복', async () => {
    const { handlers } = build()
    const desc = await handlers['fleet:session:registerCli']('claude', { stateful: true })
    expect(desc.id).toBe('cli:claude')
    const list = await handlers['fleet:session:list']()
    expect(list.map((s) => s.id)).toContain('cli:claude')
  })
})
```

주의: `ApprovalRequest` 필드는 `src/shared/types.ts` 실 계약에 맞춰 조정(위는 대표 shape — 구현 시 타입 에러가 나면 실 필드로 교체).

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/handlers.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

```ts
import type { AppInfo, FleetBridge } from '../shared/types'
import type { BothInvokeChannel } from '../shared/transport/channels'
import type { FleetEngine } from '../main/core/engine'
import type { IpcApprover } from '../main/core/safety/approval-bridge'

/**
 * 서버 핸들러 테이블(#197 B3) — main/index.ts `registerIpc` 의 기계적 이사(웹 스코프 32채널).
 * 시그니처는 FleetBridge 메서드에서 **타입 파생**한다: 채널↔메서드 매핑(ChannelMethodMap)을 거쳐
 * Parameters/ReturnType 을 끌어오므로 인자 순서·반환형 drift 는 컴파일 에러(체크포인트 2 §1 —
 * "satisfies Record<BothInvokeChannel, Handler>" 강제의 구현체). desktop 전용(openDocs·update 7종)은
 * 미등록 — ws-host 가 미지 채널을 명시 에러 res 로 응답한다(hang 금지).
 */
type ChannelMethodMap = {
  'fleet:app:info': 'getAppInfo'
  'fleet:cli:detect': 'detectClis'
  'fleet:cli:adapters': 'listAdapters'
  'fleet:cli:probe': 'probeCli'
  'fleet:session:registerCli': 'registerCliSession'
  'fleet:session:registerApi': 'registerApiSession'
  'fleet:session:list': 'listSessions'
  'fleet:session:remove': 'removeSession'
  'fleet:session:capabilities': 'setSessionCapabilities'
  'fleet:session:listModels': 'listModels'
  'fleet:project:list': 'listProjects'
  'fleet:project:tasks': 'getProjectTasks'
  'fleet:project:events': 'listProjectEvents'
  'fleet:project:lastActive:get': 'getLastActiveProject'
  'fleet:project:lastActive:set': 'setLastActiveProject'
  'fleet:project:run': 'runProject'
  'fleet:project:cancel': 'cancelRun'
  'fleet:project:activity': 'getRunActivity'
  'fleet:workspace:get': 'getWorkspace'
  'fleet:workspace:select': 'selectWorkspace'
  'fleet:chat:createRoom': 'createRoom'
  'fleet:chat:listRooms': 'listRooms'
  'fleet:chat:history': 'roomHistory'
  'fleet:chat:postUser': 'postUserMessage'
  'fleet:chat:askLlm': 'askLlm'
  'fleet:chat:discuss': 'discussRoom'
  'fleet:chat:cancel': 'cancelChat'
  'fleet:chat:activity': 'getChatActivity'
  'fleet:mcp:setServers': 'setMcpServers'
  'fleet:mcp:getStatus': 'getMcpStatus'
  'fleet:events:list': 'listEvents'
  'fleet:approval:respond': 'respondApproval'
}

// 매핑 완전성 핀 — 키 집합이 BothInvokeChannel 과 정확히 일치하지 않으면(누락/잉여) 컴파일 에러.
type AssertExact<A, B> = [A, B] extends [B, A] ? true : never
const _channelMapExhaustive: AssertExact<keyof ChannelMethodMap, BothInvokeChannel> = true
void _channelMapExhaustive

/** FleetBridge 메서드 M 에서 파생한 서버 핸들러 시그니처 — 동기 반환(Awaited)도 허용. */
type HandlerOf<M extends keyof FleetBridge> = (
  ...args: Parameters<FleetBridge[M]>
) => ReturnType<FleetBridge[M]> | Awaited<ReturnType<FleetBridge[M]>>

export type HandlerTable = { [C in BothInvokeChannel]: HandlerOf<ChannelMethodMap[C]> }

export interface HandlerDeps {
  engine: FleetEngine
  approver: IpcApprover
  /** boot 이 조립(version 산출·runtime:'web' 스탬프). */
  appInfo: AppInfo
}

export function createHandlers({ engine, approver, appInfo }: HandlerDeps): HandlerTable {
  return {
    'fleet:app:info': () => appInfo,

    // ── 세션 / CLI ──
    'fleet:cli:detect': () => engine.detectClis(),
    'fleet:cli:adapters': () => engine.listAdapters(),
    'fleet:cli:probe': (adapterId) => engine.probeCli(adapterId),
    'fleet:session:registerCli': (adapterId, opts) => engine.registerCliSession(adapterId, opts),
    'fleet:session:registerApi': (config) => engine.registerApiSession(config),
    'fleet:session:list': () => engine.listSessions(),
    'fleet:session:remove': (id) => engine.removeSession(id),
    'fleet:session:capabilities': (id, roles) => engine.setSessionCapabilities(id, roles),
    'fleet:session:listModels': (config) => engine.listProviderModels(config),

    // ── 프로젝트 / 오케스트레이션 ──
    'fleet:project:list': () => engine.listProjects(),
    'fleet:project:tasks': (projectId) => engine.getProjectTasks(projectId),
    'fleet:project:events': (projectId) => engine.listProjectEvents(projectId),
    'fleet:project:lastActive:get': () => engine.getLastActiveProject(),
    'fleet:project:lastActive:set': (projectId) => engine.setLastActiveProject(projectId),
    'fleet:project:run': (req) => engine.runProjectFlow(req),
    'fleet:project:cancel': (projectId) => engine.cancelRun(projectId),
    'fleet:project:activity': () => engine.getRunActivity(),
    'fleet:workspace:get': () => engine.getWorkspace(),
    // 헤드리스 서버엔 dialog 가 없다 — Electron "dialog 취소" 와 동형으로 현 워크스페이스 반환.
    // 웹의 경로 설정은 B4 `fleet:workspace:set`(FLEET_WORKSPACE_ROOT 하위 한정) 몫.
    'fleet:workspace:select': () => engine.getWorkspace(),

    // ── 채팅 ──
    'fleet:chat:createRoom': (title, participants) => engine.createRoom(title, participants),
    'fleet:chat:listRooms': () => engine.listRooms(),
    'fleet:chat:history': (roomId) => engine.roomHistory(roomId),
    'fleet:chat:postUser': (roomId, content) => engine.postUserMessage(roomId, content),
    'fleet:chat:askLlm': (roomId, llmId) => engine.askLlm(roomId, llmId),
    'fleet:chat:discuss': (roomId, llmIds, rounds) => engine.discussRoom(roomId, llmIds, rounds),
    'fleet:chat:cancel': (roomId) => engine.cancelChat(roomId),
    'fleet:chat:activity': () => engine.getChatActivity(),

    // ── MCP 호스트 ──
    'fleet:mcp:setServers': (servers) => engine.setMcpServers(servers),
    'fleet:mcp:getStatus': () => engine.getMcpStatus(),

    // ── 감사 / 승인 ──
    'fleet:events:list': () => engine.listEvents(),
    'fleet:approval:respond': (id, approved) => {
      approver.resolve(id, approved)
    },
  } satisfies HandlerTable
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/handlers.test.ts` → PASS. `npm run typecheck` → PASS(시그니처 파생 강제 확인 — 일부러 인자 순서를 바꿔보고 에러가 나는지 1회 스팟 체크 후 원복해도 좋다).

- [ ] **Step 5: 커밋**

```bash
git add src/server/handlers.ts src/server/handlers.test.ts
git commit -m "feat(#197-B3): 서버 핸들러 테이블 — registerIpc 웹 32채널 이사 + FleetBridge 파생 타입 강제"
```

---

### Task 4: `ws-host` — hello·req 디스패치·push 브로드캐스트·presence

**Files:**
- Create: `src/server/ws-host.ts`
- Test: `src/server/ws-host.test.ts`

**Interfaces:**
- Consumes: `HandlerTable`(Task 3) · `decodeClientFrame`/`makeOkFrame`/`makeErrFrame`/`HelloFrame`(protocol) · `BothPushChannel`(channels).
- Produces (Task 6 이 소비):

```ts
export interface WsSocket { send(data: string): void; close(): void }
export interface WsClientBinding { onMessage(data: string): void; onClose(): void }
export interface WsHost {
  attach(socket: WsSocket): WsClientBinding   // 접속 즉시 hello 송신
  broadcast(ch: BothPushChannel, event: unknown): void
  clientCount(): number                        // presence — approver hasWindow 대체(B5 전 임시)
}
export function createWsHost(opts: {
  handlers: HandlerTable
  eventCursor(): { maxEventSeq: number; minRetainedEventSeq: number }
}): WsHost
```

- 시맨틱: ① attach 첫 프레임 = hello(store.eventCursor 워터마크) ② req → 핸들러 await → ok/err res(err 는 message 만) ③ **미지 채널 = 명시 에러 res**(hang 금지 — desktop 채널 와이어 호출 방어) ④ 위조/깨진 프레임 = 무시(무응답) ⑤ push 는 전 클라 브로드캐스트, 클라별 send 실패 격리 ⑥ close 후 소켓은 집합 제거(이후 push 미수신·clientCount 감소).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '../shared/types'
import { createWsHost, type WsSocket } from './ws-host'
import type { HandlerTable } from './handlers'

class FakeSocket implements WsSocket {
  readonly sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

const APP_INFO = { name: 'Fleet', runtime: 'web' } as AppInfo

/** 테스트 전용 최소 핸들러 테이블 — 실 테이블 계약은 handlers.test.ts 가 담당. */
function stubHandlers(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    'fleet:app:info': () => APP_INFO,
    'fleet:session:remove': () => undefined, // void 채널 — value 생략 검증용
    'fleet:cli:probe': () => {
      throw new Error('보이는 메시지')
    },
    ...overrides,
  } as unknown as HandlerTable
}

function build(handlers = stubHandlers()) {
  return createWsHost({ handlers, eventCursor: () => ({ maxEventSeq: 42, minRetainedEventSeq: 7 }) })
}

describe('ws-host(#197 B3)', () => {
  it('attach 즉시 hello 프레임(커서 워터마크)을 보낸다', () => {
    const host = build()
    const s = new FakeSocket()
    host.attach(s)
    expect(s.frames()[0]).toEqual({ t: 'hello', maxEventSeq: 42, minRetainedEventSeq: 7 })
  })

  it('req → ok res (correlation id 보존)', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 3, ch: 'fleet:app:info', args: [] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    expect(s.frames()[1]).toEqual({ t: 'res', id: 3, ok: true, value: APP_INFO })
  })

  it('void 반환 → value 키 생략(프로토콜 고정 정책)', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 4, ch: 'fleet:session:remove', args: ['x'] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    expect(s.frames()[1]).toEqual({ t: 'res', id: 4, ok: true })
    expect(Object.keys(s.frames()[1] as object)).not.toContain('value')
  })

  it('핸들러 throw → error.message 만(스택/원인 미노출)', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 5, ch: 'fleet:cli:probe', args: ['claude'] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    expect(s.frames()[1]).toEqual({ t: 'res', id: 5, ok: false, error: { message: '보이는 메시지' } })
  })

  it('미지 채널(desktop 전용 등) → hang 이 아니라 명시 에러 res', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 6, ch: 'fleet:update:check', args: [] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    const res = s.frames()[1] as { ok: boolean; error: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error.message).toContain('fleet:update:check')
  })

  it('위조/깨진 프레임은 무시(무응답·크래시 없음)', () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage('{broken')
    b.onMessage(JSON.stringify({ t: 'res', id: 1, ok: true }))
    b.onMessage(JSON.stringify({ t: 'req', id: 'x', ch: 'fleet:app:info', args: [] }))
    expect(s.frames()).toHaveLength(1) // hello 뿐
  })

  it('broadcast 는 전 클라에 push — 한 클라 send 실패가 나머지를 막지 않는다', () => {
    const host = build()
    const ok1 = new FakeSocket()
    const bad: WsSocket = {
      send: () => {
        throw new Error('죽은 소켓')
      },
      close: () => {},
    }
    const ok2 = new FakeSocket()
    host.attach(ok1)
    host.attach(bad)
    host.attach(ok2)
    host.broadcast('fleet:orchestrator:event', { kind: 'x' })
    for (const s of [ok1, ok2]) {
      expect(s.frames()[1]).toEqual({ t: 'push', ch: 'fleet:orchestrator:event', event: { kind: 'x' } })
    }
  })

  it('close 후엔 push 미수신·clientCount 감소(presence)', () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    expect(host.clientCount()).toBe(1)
    b.onClose()
    expect(host.clientCount()).toBe(0)
    host.broadcast('fleet:chat:stream', {})
    expect(s.frames()).toHaveLength(1) // hello 뿐
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/ws-host.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

```ts
import type { BothPushChannel } from '../shared/transport/channels'
import {
  decodeClientFrame,
  makeErrFrame,
  makeOkFrame,
  type HelloFrame,
  type PushFrame,
  type ReqFrame,
} from '../shared/transport/protocol'
import type { HandlerTable } from './handlers'

/**
 * WS 세션 호스트(#197 B3) — Electron IPC 의 서버측 대체. 실 `ws` 소켓 타입에 의존하지 않는
 * 최소 계약(WsSocket) 주입식이라 node vitest 로 전 시맨틱을 검증한다(ws-bridge 의 WsLike 와 동형 전략).
 *  - attach 첫 프레임 = hello(이벤트 커서 워터마크 — B1 store.eventCursor, 재접속 gap 판정용)
 *  - req 디스패치: 핸들러 await → ok/err res. 에러는 message 만(스택 미노출 — 프로토콜 계약).
 *  - 미지 채널(desktop 전용 포함)은 명시 에러 res — 무응답이면 클라 pending 이 영구 hang 한다.
 *  - 신뢰 경계: decodeClientFrame 위반 프레임은 무시(id 신뢰 불가 → correlation res 불가).
 *  - presence: clientCount() — B5 전 loopback 한정의 임시 presence(approver hasWindow 대체).
 */
export interface WsSocket {
  send(data: string): void
  close(): void
}

export interface WsClientBinding {
  onMessage(data: string): void
  onClose(): void
}

export interface WsHost {
  attach(socket: WsSocket): WsClientBinding
  broadcast(ch: BothPushChannel, event: unknown): void
  clientCount(): number
}

export interface WsHostOptions {
  handlers: HandlerTable
  /** 접속 인사(hello)에 실을 이벤트 커서 워터마크 — store.eventCursor 를 주입. */
  eventCursor(): { maxEventSeq: number; minRetainedEventSeq: number }
}

export function createWsHost(opts: WsHostOptions): WsHost {
  const clients = new Set<WsSocket>()
  // 인덱스 접근용 — 테이블 키 밖 채널은 undefined → 명시 에러 res.
  const handlers = opts.handlers as Partial<Record<string, (...args: unknown[]) => unknown>>

  const safeSend = (socket: WsSocket, data: string): void => {
    try {
      socket.send(data)
    } catch {
      /* 죽은 소켓 send 실패 격리 — 정리는 close 콜백 몫 */
    }
  }

  async function dispatch(socket: WsSocket, frame: ReqFrame): Promise<void> {
    const handler = handlers[frame.ch]
    if (!handler) {
      safeSend(socket, JSON.stringify(makeErrFrame(frame.id, `알 수 없는 채널: ${frame.ch}`)))
      return
    }
    try {
      const value = await handler(...frame.args)
      safeSend(socket, JSON.stringify(makeOkFrame(frame.id, value)))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      safeSend(socket, JSON.stringify(makeErrFrame(frame.id, message)))
    }
  }

  return {
    attach(socket) {
      clients.add(socket)
      const cursor = opts.eventCursor()
      const hello: HelloFrame = { t: 'hello', ...cursor }
      safeSend(socket, JSON.stringify(hello))
      return {
        onMessage(data) {
          const frame = decodeClientFrame(data)
          if (!frame) return
          void dispatch(socket, frame)
        },
        onClose() {
          clients.delete(socket)
        },
      }
    },
    broadcast(ch, event) {
      const frame: PushFrame = { t: 'push', ch, event }
      const data = JSON.stringify(frame)
      for (const c of clients) safeSend(c, data)
    },
    clientCount: () => clients.size,
  }
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/ws-host.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/server/ws-host.ts src/server/ws-host.test.ts
git commit -m "feat(#197-B3): ws-host — hello/req 디스패치/push 브로드캐스트/presence (주입식 소켓 계약)"
```

---

### Task 5: `static` — renderer 정적 서빙 (traversal 가드 + SPA 폴백)

**Files:**
- Create: `src/server/static.ts`
- Test: `src/server/static.test.ts`

**Interfaces:**
- Consumes: `node:http`/`node:fs`/`node:path` 만.
- Produces: `createStaticHandler(rootDir: string): (req: IncomingMessage, res: ServerResponse) => void` — Task 6 이 http 서버에 배선.
- 정책: GET/HEAD 만(그 외 405) · `/` → `index.html` · 루트 밖 해소 경로 404(존재 노출 방지 — 403 아님) · 확장자 없는 미존재 경로 → `index.html`(SPA 폴백) · MIME 화이트리스트(기본 `application/octet-stream`).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStaticHandler } from './static'

let server: Server
let base: string

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-static-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Fleet</title>')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  // 루트 "밖" 파일 — traversal 로 닿으면 안 되는 대상.
  writeFileSync(join(root, '..', 'fleet-static-secret.txt'), 'secret')
  server = createServer(createStaticHandler(root))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('정적 서빙(#197 B3)', () => {
  it('/ → index.html (text/html)', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Fleet')
  })

  it('자산 파일 — MIME 매핑', async () => {
    const res = await fetch(`${base}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it.each([
    '/../fleet-static-secret.txt',
    '/%2e%2e/fleet-static-secret.txt',
    '/assets/../../fleet-static-secret.txt',
    '/..%2ffleet-static-secret.txt', // encoded slash traversal
    '/..%5cfleet-static-secret.txt', // encoded backslash(win 구분자) traversal
  ])('traversal(%s) → 404 (루트 밖 접근 차단)', async (path) => {
    const res = await fetch(base + path)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret')
  })

  it.each(['/%E0%A4%A', '/%ZZ'])(
    'malformed percent-encoding(%s) → 404 (예외 누출/500 금지 — 체크포인트 3 P2-2)',
    async (path) => {
      const res = await fetch(base + path)
      expect(res.status).toBe(404)
    },
  )

  it('확장자 없는 미존재 경로 → SPA 폴백(index.html)', async () => {
    const res = await fetch(`${base}/rooms`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Fleet')
  })

  it('미존재 자산(.js) → 404', async () => {
    expect((await fetch(`${base}/assets/nope.js`)).status).toBe(404)
  })

  it('POST → 405', async () => {
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/static.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

```ts
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * renderer 번들 정적 서빙(#197 B3). WS 와 같은 http 서버에 얹는다(upgrade 는 ws 가 가로챔).
 * 보안: 요청 경로를 rootDir 기준으로 해소한 뒤 relative 검사로 루트 밖 접근을 404 로 자른다
 * (decodeURIComponent 후 검사라 %2e%2e 우회 불가·404 로 존재 비노출). 캐싱/CSP 헤더는 B5 몫.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export function createStaticHandler(rootDir: string) {
  const root = resolve(rootDir)
  const insideRoot = (abs: string): boolean => {
    const rel = relative(root, abs)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  }
  const send = (res: ServerResponse, status: number, body: Buffer | string, type: string): void => {
    res.writeHead(status, { 'content-type': type })
    res.end(body)
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'method not allowed', 'text/plain; charset=utf-8')
        return
      }
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname)
      } catch {
        // malformed percent-encoding(URIError 등)은 SPA 폴백 이전에 404 로 닫는다(체크포인트 3 P2-2
        // — 예외가 핸들러 밖으로 새면 요청 단위 500/uncaught 로 번진다).
        send(res, 404, 'not found', 'text/plain; charset=utf-8')
        return
      }
      if (pathname === '/') pathname = '/index.html'
      const abs = resolve(root, `.${pathname}`)
      if (!insideRoot(abs)) {
        send(res, 404, 'not found', 'text/plain; charset=utf-8') // 존재 비노출 — 403 아님
        return
      }
      try {
        const body = await readFile(abs)
        send(res, 200, body, MIME[extname(abs)] ?? 'application/octet-stream')
      } catch {
        if (extname(abs) === '') {
          // SPA 폴백 — 확장자 없는 클라이언트 라우트는 index.html 로.
          try {
            send(res, 200, await readFile(resolve(root, 'index.html')), MIME['.html'])
            return
          } catch {
            /* index 자체 부재 → 404 */
          }
        }
        send(res, 404, 'not found', 'text/plain; charset=utf-8')
      }
    })()
  }
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/server/static.test.ts` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/server/static.ts src/server/static.test.ts
git commit -m "feat(#197-B3): 정적 서빙 — traversal 가드(404 비노출)·SPA 폴백·MIME 화이트리스트"
```

---

### Task 6: `boot` — env 파싱(loopback 게이트) + 조립 + 실 WS 통합 테스트

**Files:**
- Create: `src/server/boot.ts`
- Test: `src/server/boot.test.ts`

**Interfaces:**
- Consumes: Task 2~5 산출물 전부 + `createFleetEngine`/`createJsonFileStore`/`createIpcApprover`/`isE2EActive`/`e2eRunner`/`seedE2eFixtures`(전부 electron-free 실측 확인됨) + `ws`(`WebSocketServer`).
- Produces: 
  - `resolveBindHost(env): string` — **B3 보안 게이트**: 미설정/`''`→`127.0.0.1`, 허용집합 `{127.0.0.1, ::1, localhost}` 외 전부 throw(B5 가 설정 게이트로 개방할 유일 지점).
  - `resolvePort(env): number` — `FLEET_PORT` 정수 0~65535(기본 8791), 위반 throw.
  - `bootServer(env: NodeJS.ProcessEnv): Promise<RunningServer>` — `{ port, close(): Promise<void> }`. Task 7 엔트리가 소비.
- env 표면(B3 전체): `FLEET_HOST`(loopback 한정) · `FLEET_PORT` · `FLEET_DATA_DIR`(기본 `./fleet-data` — store 위치·데스크톱 userData 와 분리) · `FLEET_WORKSPACE_ROOT`(설정 시 존재하는 디렉터리 검증 후 `engine.setWorkspace` — **워크스페이스 어댑터의 boot 측**; 미설정이면 워크스페이스 없음) · `FLEET_SECRET_KEY`(Task 2) · `FLEET_STATIC_DIR`(기본 번들 상대 `../renderer`) · `FLEET_E2E`(`isE2EActive` 재사용).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { bootServer, resolveBindHost, resolvePort, type RunningServer } from './boot'
import type { ServerFrame } from '../shared/transport/protocol'

describe('resolveBindHost — B5 전 loopback 강제(#197 B3 완료 조건)', () => {
  it.each([undefined, '', '127.0.0.1', '::1', 'localhost'])('loopback(%s) 허용', (v) => {
    expect(['127.0.0.1', '::1', 'localhost']).toContain(resolveBindHost({ FLEET_HOST: v }))
  })
  it.each(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '192.168.0.10', 'fleet.example.com', '10.0.0.1'])(
    'non-loopback(%s) → throw — 어떤 env 로도 안 열림',
    (v) => {
      expect(() => resolveBindHost({ FLEET_HOST: v })).toThrow(/loopback/i)
    },
  )
})

describe('resolvePort', () => {
  it('기본 8791 · FLEET_PORT 정수 파싱 · 0(임시 포트) 허용', () => {
    expect(resolvePort({})).toBe(8791)
    expect(resolvePort({ FLEET_PORT: '0' })).toBe(0)
  })
  it.each(['abc', '-1', '65536', '3.5'])('위반(%s) → throw', (v) => {
    expect(() => resolvePort({ FLEET_PORT: v })).toThrow()
  })
})

describe('bootServer 통합 — 실 ws 클라이언트(#197 B3)', () => {
  async function boot(): Promise<RunningServer> {
    return bootServer({
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b3-data-')),
      FLEET_E2E: '1', // 결정론 픽스처(세션 2·방 1) + 페이크 러너
    })
  }
  function connect(port: number): Promise<WebSocket> {
    return new Promise((res, rej) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      socket.once('open', () => res(socket))
      socket.once('error', rej)
    })
  }
  function nextFrame(socket: WebSocket): Promise<ServerFrame> {
    return new Promise((res) =>
      socket.once('message', (d) => res(JSON.parse(String(d)) as ServerFrame)),
    )
  }

  it('non-loopback host 로는 부팅 자체가 거부된다', async () => {
    await expect(bootServer({ FLEET_HOST: '0.0.0.0', FLEET_PORT: '0' })).rejects.toThrow(/loopback/i)
  })

  it('접속 첫 프레임=hello → app:info(runtime=web) → E2E 시드 세션 조회 → 미지 채널 에러', async () => {
    const server = await boot()
    const socket = await connect(server.port)
    try {
      const hello = await nextFrame(socket)
      expect(hello.t).toBe('hello')

      const resOf = async (id: number, ch: string, args: unknown[] = []) => {
        const p = nextFrame(socket)
        socket.send(JSON.stringify({ t: 'req', id, ch, args }))
        return p
      }
      const info = (await resOf(1, 'fleet:app:info')) as { ok: boolean; value: { runtime: string } }
      expect(info.ok).toBe(true)
      expect(info.value.runtime).toBe('web')

      const list = (await resOf(2, 'fleet:session:list')) as { value: { id: string }[] }
      expect(list.value.map((s) => s.id).sort()).toEqual(['cli:claude', 'cli:codex'])

      const unknown = (await resOf(3, 'fleet:update:check')) as { ok: boolean }
      expect(unknown.ok).toBe(false)
    } finally {
      socket.close()
      await server.close()
    }
  })

  it('FLEET_WORKSPACE_ROOT 미존재 경로 → 부팅 거부(fail-fast)', async () => {
    await expect(
      bootServer({ FLEET_PORT: '0', FLEET_WORKSPACE_ROOT: join(tmpdir(), 'no-such-dir-xyz') }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/boot.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

```ts
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type { AppInfo } from '../shared/types'
import { createFleetEngine } from '../main/core/engine'
import { createIpcApprover } from '../main/core/safety/approval-bridge'
import { createJsonFileStore } from '../main/core/store/json-file'
import { e2eRunner, isE2EActive, seedE2eFixtures } from '../main/e2e'
import { createEnvKeyCrypto } from './env-key-crypto'
import { createHandlers } from './handlers'
import { createStaticHandler } from './static'
import { createWsHost, type WsHost } from './ws-host'

/**
 * fleet-server 조립(#197 B3) — main/index.ts buildEngine+registerIpc 의 서버 대응물.
 * index.ts(엔트리)와 분리해 포트 0 으로 vitest 통합 검증한다. B5(보안층) 전까지 loopback bind 를
 * resolveBindHost 가 강제한다 — presence(clientCount) 기반 임시 승인이 loopback 한정과 짝이기 때문
 * (체크포인트 2 §4). 개방은 B5 의 설정 게이트에서만.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_PORT = 8791

export function resolveBindHost(env: NodeJS.ProcessEnv): string {
  const raw = env['FLEET_HOST']?.trim()
  if (!raw) return '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(raw)) {
    throw new Error(`non-loopback bind 거부(B5 보안층 전 loopback 고정): ${raw}`)
  }
  return raw
}

export function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env['FLEET_PORT']?.trim()
  if (!raw) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`FLEET_PORT 가 유효한 포트가 아님: ${raw}`)
  }
  return port
}

/** 번들(out/server)·소스(src/server) 양쪽에서 레포/설치 루트의 package.json version 을 읽는다. */
function readOwnVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface RunningServer {
  port: number
  close(): Promise<void>
}

export async function bootServer(env: NodeJS.ProcessEnv): Promise<RunningServer> {
  const host = resolveBindHost(env)
  const port = resolvePort(env)
  const e2e = isE2EActive(env)
  const dataDir = resolve(env['FLEET_DATA_DIR'] ?? 'fleet-data')
  const store = createJsonFileStore(join(dataDir, 'fleet'))

  // wsHost 는 engine 콜백보다 늦게 만들어진다 — 브로드캐스트는 조립 완료 후에만 유효(부팅 중 이벤트 무해 drop).
  let wsHost: WsHost | null = null
  const ipcApprover = createIpcApprover({
    send: (req) => wsHost?.broadcast('fleet:approval:request', req),
    // B5 전 임시 presence: 접속 클라이언트 존재 = 응답 가능. loopback 고정과 짝(체크포인트 2 §4).
    hasWindow: () => (wsHost?.clientCount() ?? 0) > 0,
  })
  // 키 부재/형식 오류는 fail-open 이 아니라 "라이브 세션만 유지·디스크 미영속" 강등 — 운영자가
  // 조용한 미영속에 놀라지 않게 부팅 로그로 명시한다(체크포인트 3 권고).
  const secretCrypto = createEnvKeyCrypto(env)
  if (!secretCrypto.isAvailable()) {
    console.warn(
      'fleet-server: FLEET_SECRET_KEY 미설정/형식 오류 — API 키는 영속되지 않는다(라이브 세션만 유지)',
    )
  }
  const engine = createFleetEngine({
    store,
    onOrchestratorEvent: (e) => wsHost?.broadcast('fleet:orchestrator:event', e),
    onChatStream: (e) => wsHost?.broadcast('fleet:chat:stream', e),
    approver: ipcApprover.approver,
    runner: e2e ? e2eRunner : undefined,
    secretCrypto,
  })
  if (e2e) seedE2eFixtures(engine)

  // 워크스페이스 어댑터(boot 측): dialog 대신 env 경로 검증 — 미존재/비디렉터리는 fail-fast.
  const workspaceRoot = env['FLEET_WORKSPACE_ROOT']?.trim()
  if (workspaceRoot) {
    if (!statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`FLEET_WORKSPACE_ROOT 가 디렉터리가 아님: ${workspaceRoot}`)
    }
    engine.setWorkspace(resolve(workspaceRoot))
  }

  const appInfo: AppInfo = {
    name: 'Fleet',
    version: readOwnVersion(),
    electron: '',
    node: process.versions.node,
    chrome: '',
    runtime: 'web',
  }
  const handlers = createHandlers({ engine, approver: ipcApprover, appInfo })
  wsHost = createWsHost({ handlers, eventCursor: () => store.eventCursor() })

  const staticDir =
    env['FLEET_STATIC_DIR'] ?? join(dirname(fileURLToPath(import.meta.url)), '../renderer')
  const httpServer = createServer(createStaticHandler(staticDir))
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (socket) => {
    const binding = wsHost!.attach({
      send: (data) => socket.send(data),
      close: () => socket.close(),
    })
    socket.on('message', (data) => binding.onMessage(String(data)))
    socket.on('close', binding.onClose)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen)
    httpServer.listen(port, host, resolveListen)
  })

  return {
    port: (httpServer.address() as AddressInfo).port,
    close: async () => {
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((r) => httpServer.close(() => r()))
      await engine.dispose()
    },
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/server/boot.test.ts`
Expected: PASS. (win32 로컬에서 소켓 flake 시 `npx vitest run --no-file-parallelism src/server` 로 재확인 — B2 교훈.)

- [ ] **Step 5: 커밋**

```bash
git add src/server/boot.ts src/server/boot.test.ts
git commit -m "feat(#197-B3): bootServer 조립 + loopback bind 강제(non-loopback env 거부) + 실 WS 통합 테스트"
```

---

### Task 7: 엔트리 + SSR 빌드 + verify 편입

**Files:**
- Create: `src/server/index.ts`
- Create: `vite.server.config.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `bootServer`(Task 6).
- Produces: `out/server/index.mjs`(실행: `node out/server/index.mjs`) · `npm run build` 가 서버 번들까지 산출(= `npm run verify` 마지막 게이트에 자동 편입 — 체크포인트 2 결정 2).

- [ ] **Step 1: 엔트리 작성** — `src/server/index.ts`:

```ts
import { bootServer } from './boot'

/**
 * fleet-server 엔트리(#197 B3) — 조립·검증 로직은 전부 boot.ts(테스트 가능)에 있고 여기는
 * 부수효과(기동·시그널 종료)만 둔다. 종료는 main/index.ts will-quit 와 동형: dispose 완료 후
 * 종료하되 3초 백스톱으로 종료를 보장한다(dispose 가 큐 대기로 지연될 수 있음).
 */
const running = bootServer(process.env)
running
  .then((s) => console.log(`fleet-server: http://127.0.0.1:${s.port} (loopback 고정 — B5 전)`))
  .catch((err) => {
    console.error('fleet-server 기동 실패:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.then((s) => s.close()).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  })
}
```

- [ ] **Step 2: SSR 빌드 설정** — `vite.server.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// fleet-server SSR 번들(#197 B3) — electron-vite 3타깃과 별도(체크포인트 2 결정 2).
// ESM(.mjs) 출력: 레포 package.json 이 CJS 기본이라 확장자로 모듈 종류를 고정하고
// import.meta.url(정적 서빙 기본 경로·version 읽기)을 원형 보존한다.
export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: 'out/server',
    target: 'node24',
    emptyOutDir: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } },
  },
  ssr: { external: ['ws'] }, // 런타임 dep — 번들 미포함(node_modules 해소)
})
```

- [ ] **Step 3: 스크립트 체이닝** — `package.json` scripts 변경:

```json
    "build": "electron-vite build && npm run build:server",
    "build:server": "vite build --config vite.server.config.ts",
    "start:server": "node out/server/index.mjs",
```

(`dist`/`dist:dir` 는 `electron-vite build` 직호출 유지 — 데스크톱 패키징에 서버 번들 불필요, Task 0 의 `!out/server/**` 와 일관.)

- [ ] **Step 4: 빌드+기동 스모크**

```bash
npm run build
FLEET_PORT=0 node -e "import('./out/server/index.mjs')" &  # 또는 수동: npm run start:server 후 Ctrl+C
```

Expected: 빌드 성공 + `fleet-server: http://127.0.0.1:...` 로그. (Windows PowerShell 은 `$env:FLEET_PORT='0'; npm run start:server` 후 Ctrl+C.)
추가 스모크: `$env:FLEET_HOST='0.0.0.0'; npm run start:server` → "non-loopback bind 거부" 에러·비정상 종료 확인 후 env 해제.

- [ ] **Step 5: 커밋**

```bash
git add src/server/index.ts vite.server.config.ts package.json
git commit -m "feat(#197-B3): 서버 엔트리 + vite SSR 번들(out/server) + build/verify 게이트 편입"
```

---

### Task 8: ESLint 순수성 게이트 확장 + 게이트 자체 핀

**Files:**
- Modify: `eslint.config.mjs` (코어 순수성 블록 files 확장)
- Modify: `scripts/eslint-config-purity.test.ts` (확장 스코프 핀)

**Interfaces:**
- Produces: `src/server/**`·`src/shared/transport/**` 에 electron/DOM-free 게이트(기존 core 블록과 동일 룰). 게이트 약화/삭제 시 purity 테스트가 RED(#173 패턴 — 게이트 무테스트 함정 회피).

- [ ] **Step 1: 실패하는 테스트(게이트 핀) 먼저 추가** — `scripts/eslint-config-purity.test.ts` 의 코어 블록 describe 에:

```ts
  it('게이트 스코프가 src/server·src/shared/transport 를 포함한다(#197 B3 확장)', () => {
    expect(coreBlock?.files).toContain('src/server/**/*.ts')
    expect(coreBlock?.files).toContain('src/shared/transport/**/*.ts')
  })
```

Run: `npx vitest run scripts/eslint-config-purity.test.ts` → FAIL.

- [ ] **Step 2: 게이트 확장** — `eslint.config.mjs` 코어 순수성 블록의 files 를:

```js
  // 코어 순수성 게이트(AGENTS.md 「Fleet 특화 P1 신호」 #1): src/main/core 는 electron/DOM-free
  // 순수 TS 계약. #197 B3 부터 서버 전송층(src/server)·공유 전송 계약(src/shared/transport)도
  // 동일 게이트 — 서버는 컨테이너 Node 에서 돌므로 한 줄의 electron import 도 런타임 크래시다.
  {
    files: ['src/main/core/**/*.ts', 'src/server/**/*.ts', 'src/shared/transport/**/*.ts'],
```

(블록 내부 룰은 무변경 — `ELECTRON_IMPORT_PATHS`/`no-restricted-globals` object form/동적 import 가드 그대로.)

- [ ] **Step 3: 통과 확인**

```bash
npx vitest run scripts/eslint-config-purity.test.ts && npm run lint
```

Expected: 둘 다 PASS(서버 코드는 electron/DOM 미사용이라 신규 위반 0이어야 정상 — 위반이 나오면 그 코드가 버그).

- [ ] **Step 4: 커밋**

```bash
git add eslint.config.mjs scripts/eslint-config-purity.test.ts
git commit -m "feat(#197-B3): 순수성 ESLint 게이트를 src/server·src/shared/transport 로 확장 + 게이트 핀"
```

---

### Task 9: brain 재생성 + 전체 verify + 데스크톱 무회귀 확인

**Files:**
- Modify: `brain.md` (자동 생성 — `npm run brain`)

- [ ] **Step 1: brain 재생성**

```bash
npm run brain && npm run brain:check
```

Expected: brain.md 에 `src/server/**` 6모듈 반영, brain:check PASS.

- [ ] **Step 2: 전체 게이트**

```bash
npm run verify
```

Expected: skills:lint → brain:check → format:check → typecheck → lint → test:coverage(코어 floor 4메트릭 무회귀 — 서버는 floor 비대상[이슈 결정: B6 후 실측 편입]) → build(electron 3타깃 + 서버 번들) 전부 GREEN. format 이 걸리면 `npm run format` 후 재실행.

- [ ] **Step 3: 데스크톱 e2e 무회귀**

```bash
npm run test:e2e
```

Expected: 기존 playwright 데스크톱 스위트 PASS(9/9 — B2 시점 기준). preload/main/renderer 무변경이므로 실패 시 원인 추적(대개 환경 flake — 재실행 1회 허용, 재현되면 중단·조사).

- [ ] **Step 4: 커밋 + 이후 절차(사용자 확인 후)**

```bash
git add brain.md && git commit -m "chore(#197-B3): brain 재생성"
```

PR: 제목 `feat(#197-B3): 서버 엔트리 + 핸들러 테이블 + 어댑터 + loopback bind + 정적 서빙`, 본문에 **`Part of #197`**(멀티-phase — `Closes` 금지), B3 완료 조건 대비표(loopback 거부 테스트·satisfies 강제·어댑터 2·게이트 확장) 포함. push/PR 은 컨벤션대로 **사용자 확인 후**. PR open 후 Codex 자동리뷰 + CodeRabbit 스레드 대기·반영(매 푸시 후 unresolved 재확인).

---

## 리스크·주의 (구현자 필독)

1. **`args` 신뢰 수준은 Electron IPC 동형** — 핸들러 시그니처 타입은 컴파일타임 계약일 뿐, 와이어 args 런타임 검증은 안 한다(체크포인트 2 §1 판정: validator 과설계). loopback+B5 인증이 신뢰 경계. 단 프레임 **구조**(id/ch/args 형)는 `decodeClientFrame` 이 검증한다.
2. **push 브로드캐스트는 조립 순서 의존** — `wsHost` 가 engine 콜백 이후 생성되므로 `wsHost?.` 옵셔널 참조(부팅 중 이벤트 drop 은 무해 — 클라이언트가 아직 없음). 이 순서를 바꾸면 TDZ/null 크래시.
3. **JSON store 동시 쓰기 금지** — `FLEET_DATA_DIR` 는 서버 전용이어야 한다(이슈 보안 전제). 테스트는 반드시 mkdtemp 주입(레포에 `fleet-data/` 생성 금지 — 통합 테스트에서 env 누락하면 레포가 오염된다).
4. **desktop 채널 invoke = 에러 res** — ws-bridge 는 desktop 채널을 wire 로 안 태우므로(B2 bridge-parity 핀) 정상 경로에선 안 나온다. 미지 채널 에러는 방어층이다.
5. **`fleet:workspace:select` 시맨틱** — 서버에선 "변경 없이 현 값 반환". renderer 가 이 반환값으로 상태를 덮어써도 무변화라 안전. B4 가 runtime 게이팅으로 UI 표면 자체를 교체한다.
6. **Windows 소켓 테스트 flake** — 로컬 win 병렬 실행에서 flake 시 `--no-file-parallelism`(B2 실측 교훈). CI(ubuntu·windows) green 이 판정 기준.
7. **`ws` 메시지는 Buffer** — `String(data)` 변환 후 decode(테스트의 문자열 경로와 동일화).
8. **B4 와의 경계** — renderer 폴백 배선·`fleet:workspace:set` 채널 신설·재하이드레이션은 전부 B4. B3 에서 channels.ts 매니페스트는 **무변경**이다(변경하면 bridge-parity·binding 테스트가 깨진다).

