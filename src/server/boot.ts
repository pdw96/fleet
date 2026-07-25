import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type RawData } from 'ws'
import type { AppInfo, RunActivity } from '../shared/types'
import { APPROVAL_MAX_PENDING } from '../shared/types'
import { createChildEnv, type ChildEnv } from './child-env'
import { createFleetEngine } from '../main/core/engine'
import { containerCliAdapters, createCliRegistry } from '../main/core/cli/registry'
import { createIpcApprover, type IpcApprover } from '../main/core/safety/approval-bridge'
import { createJsonFileStore } from '../main/core/store/json-file'
import { isE2EActive, resolveE2eRunner, resolveE2eVerifyRunner, seedE2eFixtures } from '../main/e2e'
import { AccessJwtError, createAccessJwtVerifier, type AccessJwtVerifier } from './access-jwt'
import { createEnvKeyCrypto } from './env-key-crypto'
import { createHandlers } from './handlers'
import { resolveSecurityConfig, type SecurityConfig } from './security-config'
import { createStaticHandler } from './static'
import { createNonceStore, type NonceStore } from './ws-nonce'
import { createWsHost, type WsHost } from './ws-host'

/**
 * 소켓 exp-시한 종료(#197-B6 T6)용 시계 — 주입 가능(테스트 결정론). 핸들은 불투명(setTimeout 반환을
 * clearTimeout 에 그대로 전달). 미주입 시 실 Date.now + globalThis.setTimeout(unref) 를 쓴다.
 */
export interface SocketExpiryClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** 테스트 전용 주입(운영 env 표면 0) — 실 JWKS/네트워크 없이 secured 통합 검증. */
export interface BootDeps {
  /** access 모드 JWKS getKey 주입(미주입 시 createRemoteJWKSet — 프로덕션). */
  accessJwks?: AccessJwtVerifierOptionsJwks
  /** 보안 거부 관측 훅(단계·사유 코드만 — 토큰/nonce 값 금지). 미주입 시 서버 로그 1줄. */
  onSecurityReject?: (stage: SecurityRejectStage, reason: string) => void
  /** 승인 presence 검증용 approver 핸들 노출(테스트 — in-flight 승인 주입/관측). */
  onApprover?: (approver: IpcApprover) => void
  /** 소켓 exp 타이머 구동 시계(테스트 — 주입 clock 으로 만료 결정론 검증). 미주입 시 실 타이머. */
  clock?: SocketExpiryClock
}

type AccessJwtVerifierOptionsJwks = Parameters<typeof createAccessJwtVerifier>[0]['jwks']
type SecurityRejectStage = 'nonce' | 'upgrade'

/**
 * fleet-server 조립(#197 B3·B5) — main/index.ts buildEngine+registerIpc 의 서버 대응물.
 * index.ts(엔트리)와 분리해 포트 0 으로 vitest 통합 검증한다. 2모드(#197 B5): loopback(보안 env 미설정 —
 * B3/B4 시맨틱·loopback bind 고정) / access(Cloudflare Access JWT+nonce+Origin exact 게이팅 · non-loopback
 * bind 는 이때만 개방 — resolveBindHost). access presence = 인증 클라 한정(clientCount = 검증 통과 소켓 수).
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_PORT = 8791
/** Node setTimeout 최대 지연(2^31-1 ms ≈ 24.8일). 초과 지연은 즉시 발화(1ms 클램프)하므로 재무장한다. */
const TIMEOUT_MAX = 2_147_483_647

/** 기본 소켓 exp 시계 — 실 Date.now + globalThis 타이머(unref 로 프로세스 미붙듦). */
const defaultClock: SocketExpiryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * 서버 모드 자식 env 정책(#197-B6 T7) — 엔진에 주입할 ChildEnv 를 boot 의 env 로부터 만든다. allowlist
 * 로 서버 시크릿(FLEET_*)을 제거하므로, boot 이 받은 시크릿 env 를 그대로 넘겨도 자식(CLI 세션·detect/
 * probe·MCP·verify·git)엔 안 간다. boot 은 엔진 내부 러너/spawn 을 미노출하므로 실 자식 미수신의 권위
 * 증명은 T3 실 spawn·T10 컨테이너 스모크·라이브 5종에 위임하고, 여기서는 정책(팩토리)만 고정한다.
 */
export function buildServerChildEnv(env: NodeJS.ProcessEnv): ChildEnv {
  return createChildEnv(env)
}

/**
 * CSWSH 방어(#197 B3 · Codex P1): 브라우저는 WS 핸드셰이크에 SOP/CORS 를 적용하지 않으므로 사용자가
 * 방문한 임의 오리진 페이지가 loopback 서버에 접속해 승인 프레임을 가로챌 수 있다(cross-site WebSocket
 * hijacking). Origin 이 있으면(=브라우저) loopback 오리진만 허용하고, Origin 부재(비브라우저 CLI/ws
 * 클라)는 통과 — same-machine 비브라우저는 loopback 신뢰 모델 대상. B5 가 JWT/nonce 로 강화.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true // 비브라우저 클라이언트(Origin 미전송)
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '') // IPv6 대괄호 제거
    return LOOPBACK_HOSTS.has(host)
  } catch {
    return false // 파싱 불가 Origin 거부
  }
}

/**
 * Origin 정책(HTTP nonce endpoint·WS upgrade 공통 — 판정 함수 단일화로 drift 차단, #197 B5).
 *   · loopback: 기존 isAllowedOrigin 승계(부재 허용·loopback 오리진만).
 *   · access: publicOrigin 정확 문자열 일치 — 부재·scheme/포트/서브도메인 차이·`Origin: null` 전부 거부.
 */
function makeOriginAllowed(config: SecurityConfig): (origin: string | undefined) => boolean {
  if (config.mode === 'loopback') return isAllowedOrigin
  const { publicOrigin } = config
  return (origin) => origin === publicOrigin
}

/** Cf-Access-Jwt-Assertion 헤더 우선 → CF_Authorization 쿠키 폴백. 값 내 `=`·다중 쿠키 안전 파싱. */
function extractAccessToken(req: IncomingMessage): string | undefined {
  const header = req.headers['cf-access-jwt-assertion']
  if (typeof header === 'string' && header.length > 0) return header
  const cookie = req.headers.cookie
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === 'CF_Authorization') {
        // 첫 `=` 만 name/value 구분 — 값 내 `=`(있다면) 보존.
        return part.slice(eq + 1).trim()
      }
    }
  }
  return undefined
}

const TEXT = 'text/plain; charset=utf-8'
/** nonce endpoint 응답은 성패 무관 `Cache-Control: no-store`(발급 nonce·인증 상태 캐시 금지). */
function endStatus(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': TEXT })
  res.end(body)
}

/** access 모드 nonce 발급: Origin exact(403) → JWT verify(401/503) → issue → 200 {nonce}. */
async function handleNonceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    publicOrigin: string
    originAllowed: (origin: string | undefined) => boolean
    verifier: AccessJwtVerifier
    nonceStore: NonceStore
    onReject: (stage: SecurityRejectStage, reason: string) => void
  },
): Promise<void> {
  if (req.method !== 'POST') {
    endStatus(res, 405, 'method not allowed') // POST 외 전부 405(GET/HEAD/OPTIONS)
    return
  }
  if (!ctx.originAllowed(req.headers.origin)) {
    ctx.onReject('nonce', 'origin')
    endStatus(res, 403, 'forbidden')
    return
  }
  try {
    const { identity } = await ctx.verifier.verify(extractAccessToken(req) ?? '')
    // Origin exact 통과 = req.headers.origin === publicOrigin. 바인딩 권위값으로 publicOrigin 저장.
    const nonce = ctx.nonceStore.issue(identity, ctx.publicOrigin)
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify({ nonce }))
  } catch (err) {
    const unavailable = err instanceof AccessJwtError && err.kind === 'unavailable'
    ctx.onReject('nonce', unavailable ? 'jwks' : 'jwt')
    endStatus(res, unavailable ? 503 : 401, unavailable ? 'service unavailable' : 'unauthorized')
  }
}

/** 요청 경로가 nonce 발급 endpoint 인지(malformed URL 은 false — 정적 핸들러로 위임). */
function isNonceRequest(req: IncomingMessage): boolean {
  try {
    return new URL(req.url ?? '/', 'http://local').pathname === '/auth/ws-nonce'
  } catch {
    return false
  }
}

/** upgrade 쿼리에서 `?nonce=` 추출(malformed URL·부재·빈 값 → null). 중복 쿼리는 첫 값 채택. */
function parseNonceParam(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://local').searchParams.get('nonce') || null
  } catch {
    return null
  }
}

/**
 * bind 호스트 해소(#197 B5) — non-loopback 은 access 모드에서만 허용(노출 확대 = 보안층 완비 시에만).
 * FLEET_HOST 미설정 = 127.0.0.1 기본(access 여도 개방은 명시 opt-in 이중 게이트: 보안 env + FLEET_HOST).
 * revert 시 즉시 loopback 고정 복귀(이 함수 하나가 "문 열기"의 전부).
 */
export function resolveBindHost(env: NodeJS.ProcessEnv, config: SecurityConfig): string {
  const raw = env['FLEET_HOST']?.trim()
  if (!raw) return '127.0.0.1'
  if (LOOPBACK_HOSTS.has(raw)) return raw
  if (config.mode !== 'access') {
    throw new Error(`non-loopback bind 거부(보안 미설정 시 loopback 고정): ${raw}`)
  }
  return raw // access 모드 — 미인증 접속은 upgrade 파이프라인(nonce+JWT+Origin)이 여전히 거부(열린 문 방어)
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

/** 샌드박스 경계 posture(#214 C1) — 코어엔 미노출(엔진은 registry 데이터만 받는다). 주입 배선은 T3. */
export type SandboxBoundary = 'cli' | 'container'

/**
 * CLI 내부 샌드박스를 컨테이너 경계로 대체할지 판정(#214 · ADR-0010). **명시 opt-in 만** — 자동 감지
 * 금지(감지 오판 방향이 보안 완화). 미설정 = `cli`(현행 유지 → 데스크톱·베어호스트 무회귀). 그 외 값은
 * **부팅 거부(loud fail)** — resolveBindHost 이중 게이트 관례와 동일(조용한 강등 금지). trim 후 소문자
 * exact 만(대문자·유사값은 오타 개연 → throw). 형제 파싱 관례(`?.trim()`)를 따른다(FLEET_DATA_DIR 예외 제외).
 */
export function resolveSandboxBoundary(env: NodeJS.ProcessEnv): SandboxBoundary {
  const raw = env['FLEET_SANDBOX_BOUNDARY']?.trim()
  if (!raw) return 'cli'
  if (raw === 'cli' || raw === 'container') return raw
  throw new Error(
    `FLEET_SANDBOX_BOUNDARY 값이 유효하지 않음: "${raw}" (유효값: cli | container · 미설정=cli)`,
  )
}

/**
 * Workbench 킬스위치 env 이름(#251 · 스펙 §W-1). 상수로 export 하는 이유: `NodeJS.ProcessEnv` 는 인덱스
 * 시그니처라 키 오타가 **컴파일된다** — 테스트가 리터럴을 재입력하면 오타 상태로도 「미설정=비활성」이
 * vacuous GREEN 이 된다. 호출자·테스트가 이 상수만 쓰게 해 그 무신호를 닫는다.
 */
export const FLEET_WORKBENCH_ENV = 'FLEET_WORKBENCH'

/**
 * Workbench(#251) 활성 여부 — **명시 opt-in `'1'` 만**. 미설정 = 데스크톱·서버 양쪽 비활성이므로
 * 롤백이 코드 revert 가 아니라 이 스위치 하나다. `'0'` 은 오설정이 아니라 명시 off 라 통과시키고,
 * 그 외 값(`true`/`yes`/`on` …)은 **부팅 거부** — resolveSandboxBoundary 와 동일한 «운영자 env» 관용구다
 * (조용한 비활성 강등이면 「켰는데 안 켜짐」을 운영자가 못 본다). 모든 부수효과 이전에 호출한다.
 *
 * ⚠ 이 함수는 **서버 표면 전용**이다 — Workbench 는 서버(컨테이너) 표면으로 범위 축소됐고(2026-07-23),
 * 데스크톱 Workbench 는 #255 다. `src/main/index.ts` 가 이것을 호출하지 않음을 §3-T8f 가 구조 단언한다.
 */
export function resolveWorkbenchEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env[FLEET_WORKBENCH_ENV]?.trim()
  if (!raw) return false
  if (raw === '1') return true
  if (raw === '0') return false
  throw new Error(
    `${FLEET_WORKBENCH_ENV} 값이 유효하지 않음: "${raw}" (유효값: 1 | 0 · 미설정=비활성)`,
  )
}

/** 승인 보류 TTL(#216 C1) — 미설정 기본·유효 범위. env 설정자=배포자=운영자라 crash 는 공격 벡터 아님. */
const DEFAULT_SERVER_APPROVAL_TTL_MS = 600_000 // 10분(hold-with-expiry 기본)
const APPROVAL_TTL_MIN_MS = 5_000 // 5초
const APPROVAL_TTL_MAX_MS = 1_800_000 // 30분

/**
 * FLEET_APPROVAL_TTL_MS 파싱(#216 C1 §C-4) — fail-fast. 미설정→기본 600000. 설정 시 유한 양의 정수(ms)·
 * [5000, 1800000] 범위 밖이면 **throw**(조용한 clamp 대신 오설정을 시끄럽게 — B3 fail-closed 정신·운영자
 * 무성 놀람 방지). 모든 부수효과(store mkdir 등) 이전에 호출한다.
 */
function resolveApprovalTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env['FLEET_APPROVAL_TTL_MS']?.trim()
  if (!raw) return DEFAULT_SERVER_APPROVAL_TTL_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < APPROVAL_TTL_MIN_MS || n > APPROVAL_TTL_MAX_MS) {
    throw new Error(
      `FLEET_APPROVAL_TTL_MS 는 [${APPROVAL_TTL_MIN_MS}, ${APPROVAL_TTL_MAX_MS}] 범위의 정수 ms 여야 함(받음: ${raw})`,
    )
  }
  return n
}

/**
 * graceful drain 상한(#216 C3) — SIGTERM 시 진행 런 완료 대기 상한(ms). 미설정 기본·유효 범위. 조율 계약:
 * `drainTimeoutMs + 3s ≤ stop_grace_period`(컨테이너가 grace 만료 시 SIGKILL 로 절단 — ADR-0011). MAX 를 120s
 * 로 조여 "무한정 대기" 오설정을 막는다(실 런은 분 단위라 상한 내 완주는 드물고, 상한은 «거의 끝난 런의 착지» 유예).
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000 // 25초(기본 stop_grace_period 30s 안쪽·teardown 3s 여유)
const DRAIN_TIMEOUT_MIN_MS = 1_000 // 1초(사실상 no-grace)
const DRAIN_TIMEOUT_MAX_MS = 120_000 // 2분(grace 를 함께 올릴 때만 유효)

/**
 * FLEET_DRAIN_TIMEOUT_MS 파싱(#216 C3 §3.3) — fail-fast. 미설정→기본 25000. 설정 시 유한 정수(ms)·
 * [1000, 120000] 범위 밖이면 **throw**(조용한 clamp 금지 — resolveApprovalTtlMs·resolveSandboxBoundary 동형).
 * 모든 부수효과(store mkdir 등) 이전에 호출한다.
 */
export function resolveDrainTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env['FLEET_DRAIN_TIMEOUT_MS']?.trim()
  if (!raw) return DEFAULT_DRAIN_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < DRAIN_TIMEOUT_MIN_MS || n > DRAIN_TIMEOUT_MAX_MS) {
    throw new Error(
      `FLEET_DRAIN_TIMEOUT_MS 는 [${DRAIN_TIMEOUT_MIN_MS}, ${DRAIN_TIMEOUT_MAX_MS}] 범위의 정수 ms 여야 함(받음: ${raw})`,
    )
  }
  return n
}

/** 드레인 폴링 간격(ms · #216 C3 §3.4) — waitForRunDrain 재귀 poll 주기. shutdown 호출부 상수. */
const DRAIN_POLL_MS = 250

/**
 * 진행 런(activeRuns) 이 빌 때까지 주입 clock 으로 상한 폴링하는 **순수** 함수(#216 C3 §3.4). 순수라 fake
 * getActivity + fakeClock 으로 단위 검증(bootServer 통합은 e2e hang 러너 signal 미honor 로 결정론 불가 · §5).
 *   · 초기 무런 → 즉시 `'drained'`(타이머 무장 0).
 *   · 아니면 단일 `settled` 래치로 poll(재귀)·cap 을 경쟁시키고, 먼저 발화한 쪽이 resolve 와 동시에 형제
 *     타이머를 clearTimeout(재-resolve·좀비 재스케줄 금지 — 타이머 누수 0 · §4-6).
 *   · `'timeout'` 반환도 호출자(shutdown)가 이후 close()→dispose(force abort) 진행.
 * pollMs<=0 은 재귀 폭주라 진입부 throw(fail-fast · §3.4 ">0 강제").
 */
export function waitForRunDrain(
  getActivity: () => RunActivity,
  clock: SocketExpiryClock,
  capMs: number,
  pollMs: number,
): Promise<'drained' | 'timeout'> {
  if (pollMs <= 0) throw new Error(`waitForRunDrain: pollMs 는 양수여야 함(받음: ${pollMs})`)
  if (getActivity().activeProjectIds.length === 0) return Promise.resolve('drained')
  return new Promise((resolve) => {
    let settled = false
    let pollH: unknown
    // settle 은 timer 콜백/poll 에서만 호출돼 항상 capH 할당 후 실행(closure 참조 안전 · approval-bridge 동형).
    const settle = (r: 'drained' | 'timeout'): void => {
      if (settled) return
      settled = true
      clock.clearTimeout(capH)
      clock.clearTimeout(pollH)
      resolve(r)
    }
    const capH = clock.setTimeout(() => settle('timeout'), capMs)
    const poll = (): void => {
      if (getActivity().activeProjectIds.length === 0) return settle('drained')
      pollH = clock.setTimeout(poll, pollMs) // 재무장(activeCount 잔여는 settle 이 정리)
    }
    pollH = clock.setTimeout(poll, pollMs)
  })
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
  /** 실 bind 호스트(index.ts 기동 로그 — loopback 은 127.0.0.1 접두 포맷 계약 보존). */
  host: string
  /** 보안 모드 — 기동 로그 표기. */
  mode: SecurityConfig['mode']
  /** 현재 attach 된(검증 통과) 클라이언트 수 — access presence 소스·health 관측. */
  clientCount(): number
  /**
   * 해소된 드레인 상한(ms · #216 C3) — index.ts 백스톱 사이징(`drainTimeoutMs + 3000`)용. shutdown 내부
   * waitForRunDrain 에 넘기는 cap 과 **동일 const**(divergence 방지 — 노출값<cap 이면 드레인 도중 exit(1)).
   */
  drainTimeoutMs: number
  /**
   * graceful drain 종료(#216 C3): memo-gate → draining on(신규 런 거부) → (broadcast T5) → waitForRunDrain
   * (상한 대기) → close(). idempotent(2회 호출 = 동일 promise). 내부 cap 은 드레인 대기만 상한하며 teardown
   * hang 은 index.ts 백스톱/컨테이너 SIGKILL 이 종착(dispose 무타임아웃 · ADR-0003).
   */
  shutdown(): Promise<void>
  /** 하드 teardown(idempotent · promise-memo) — rejectAll → terminate → close WS/HTTP → dispose. */
  close(): Promise<void>
}

/** ws `RawData`(Buffer|ArrayBuffer|Buffer[])를 텍스트 프레임 문자열로 정규화(no-base-to-string 회피). */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

export async function bootServer(
  env: NodeJS.ProcessEnv,
  deps: BootDeps = {},
): Promise<RunningServer> {
  // 보안 모드 판정 — 부분 설정은 여기서 fail-fast(store mkdir 등 모든 부수효과 이전).
  const securityConfig = resolveSecurityConfig(env)
  // 샌드박스 경계 판정(#214 C1) — 미지값이면 여기서 loud-fail(모든 부수효과 이전).
  const sandboxBoundary = resolveSandboxBoundary(env)
  const host = resolveBindHost(env, securityConfig)
  const port = resolvePort(env)
  // 승인 보류 TTL(#216 C1) — 오설정이면 여기서 fail-fast(모든 부수효과 이전).
  const approvalTtlMs = resolveApprovalTtlMs(env)
  // graceful drain 상한(#216 C3) — 오설정이면 여기서 fail-fast. RunningServer.drainTimeoutMs 와 shutdown 내부
  // waitForRunDrain cap 이 이 단일 const 를 공유한다(divergence 0).
  const drainTimeoutMs = resolveDrainTimeoutMs(env)
  // Workbench 킬스위치(#251) — 오설정이면 여기서 fail-fast. PR0 시점의 기능은 아직 없으므로, 켠 운영자가
  // 「켰는데 아무 일도 안 일어난다」를 조용히 겪지 않도록 기동 로그로 현 상태를 명시한다(소비는 PR1+).
  if (resolveWorkbenchEnabled(env)) {
    console.warn(
      `fleet-server: ${FLEET_WORKBENCH_ENV}=1 — Workbench 표면은 아직 미구현(#251 진행 중). 현재 bench 는 생성·실행되지 않는다.`,
    )
  }
  const e2e = isE2EActive(env)
  // 워크스페이스 검증(dialog 대신 env 경로): 미존재/비디렉터리는 fail-fast — store 생성(mkdirSync
  // 부수효과) 이전에 순수 검증부터 끝낸다. 실제 적용(setWorkspace)은 engine 생성 후로 미룬다.
  const workspaceRoot = env['FLEET_WORKSPACE_ROOT']?.trim()
  if (workspaceRoot && !statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`FLEET_WORKSPACE_ROOT 가 디렉터리가 아님: ${workspaceRoot}`)
  }
  const dataDir = resolve(env['FLEET_DATA_DIR'] ?? 'fleet-data')
  // 세션/이벤트/암호문이 담기는 데이터 디렉터리를 store 생성보다 **먼저** 0700 으로 잠근다(#197-B6 T5) —
  // 동일 호스트 타 사용자의 접근 차단. createJsonFileStore 가 recursive mkdir 로 부모를 기본 mode 로 만들기
  // 전에 선생성해야 하고, 기존 디렉터리는 recursive mkdir 이 mode 를 안 바꾸므로 chmod 로 보정한다.
  // win32 는 POSIX mode 가 무의미하므로 스킵(CI linux 가 mode 를 강제 커버).
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700)
  const store = createJsonFileStore(join(dataDir, 'fleet'))

  // wsHost 는 engine 콜백보다 늦게 만들어진다 — 브로드캐스트는 조립 완료 후에만 유효(부팅 중 이벤트 무해 drop).
  let wsHost: WsHost | null = null
  // graceful drain 게이트(#216 C3) — shutdown() 이 동기로 true 로 뒤집으면 fleet:project:run 핸들러가
  // 신규 런을 거부한다(handlers isDraining 비옵셔널로 주입). 여기선 선언만(shutdown 조립은 아래 return).
  let draining = false
  // 주입 clock(테스트 결정론) — 소켓 exp 타이머와 **동일 clock 을 approver 만료 타이머에도** 라우팅해
  // 통합 만료를 결정론화한다(#216 C1 §C-2·§3-23). 원래 348행 정의를 approver 조립 위로 끌어올림.
  const clock = deps.clock ?? defaultClock
  const ipcApprover = createIpcApprover({
    send: (req) => wsHost?.broadcast('fleet:approval:request', req),
    // presence: 접속(검증 통과) 클라이언트 존재 = 응답 가능. hold 정책이라 presence=0 이어도 거부하지 않고
    // 보류(스냅숏이 다음 접속에 재제시·TTL 만료/취소 abort 만이 종착 — #216 C1 §C-1·C-6). hasWindow 는
    // hold 에서 미참조이나 계약상 유지(정책 전환 시 무회귀).
    hasWindow: () => (wsHost?.clientCount() ?? 0) > 0,
    presencePolicy: 'hold',
    // 승인 이탈(응답/만료/철회/취소) tombstone 브로드캐스트(bare string id) — attach(인증 통과) 소켓만 도달.
    onWithdraw: (id) => wsHost?.broadcast('fleet:approval:withdrawn', id),
    // 만료 타이머·list 필터를 소켓 exp 와 동일 clock 으로(§C-2 통합 결정론). arrow 래퍼로 this-binding 안전.
    now: () => clock.now(),
    setTimer: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimer: (h) => clock.clearTimeout(h),
    maxPending: APPROVAL_MAX_PENDING,
  })
  deps.onApprover?.(ipcApprover) // 테스트 관측(운영 no-op)
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
    // hold 정책 TTL(#216 C1) — gate 가 expiresAt=ts+ttlMs 로 스탬프. FLEET_APPROVAL_TTL_MS(fail-fast 파싱).
    approvalTtlMs,
    runner: e2e ? resolveE2eRunner(env) : undefined,
    verifyRunner: e2e ? resolveE2eVerifyRunner(env) : undefined,
    // 자식 env 격리(#197-B6 T7): 서버 시크릿(FLEET_*)이 CLI 세션·detect/probe·MCP·verify·git 자식에 안 새게
    // allowlist 필터된 env 를 주입한다. boot 이 받은 env(운영=process.env)를 넘겨도 자식엔 base/provider 만 간다.
    childEnv: buildServerChildEnv(env),
    // 샌드박스 경계 주입(#214 C3 · ADR-0010) — container 모드에서만 container-posture 어댑터로 시드한
    // registry 를 넘긴다(codex danger-full-access + skip). cli/미설정은 undefined → 엔진이 기본 시드
    // (createCliRegistry())로 폴백(데스크톱·베어호스트 바이트 동일). **이 줄이 삭제되면 컨테이너에서 codex
    // 가 다시 bwrap(user namespace)로 깨진다(전 테스트 GREEN 무신호) — boot-sandbox-seam.test 가 핀한다.**
    cliRegistry:
      sandboxBoundary === 'container' ? createCliRegistry(containerCliAdapters()) : undefined,
    secretCrypto,
  })
  if (e2e) seedE2eFixtures(engine)

  // 워크스페이스 적용(검증은 위에서 끝남 — engine 이 여기서야 존재하므로 setWorkspace 만 늦춘다).
  if (workspaceRoot) {
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
  const handlers = createHandlers({
    engine,
    approver: ipcApprover,
    appInfo,
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : null,
    // 클로저 draining 을 읽는 게이트 — shutdown() 이 true 로 뒤집으면 신규 런 거부(#216 C3).
    isDraining: () => draining,
  })
  wsHost = createWsHost({ handlers, eventCursor: () => store.eventCursor() })

  // 보안 컨텍스트(#197 B5) — access 검증기는 부팅 1회 생성(요청마다 createRemoteJWKSet 재생성은
  // 캐시/cooldown 무효화). nonceStore·originAllowed 는 HTTP nonce endpoint·WS upgrade(T7) 공유.
  const onSecurityReject: (stage: SecurityRejectStage, reason: string) => void =
    deps.onSecurityReject ??
    ((stage, reason) => console.warn(`fleet-server: 보안 거부 stage=${stage} reason=${reason}`))
  const originAllowed = makeOriginAllowed(securityConfig)
  // (clock 은 approver 조립 위로 이동됨 — #216 C1 §C-2. 여기선 재선언하지 않는다.)
  const nonceStore = createNonceStore()
  const accessVerifier: AccessJwtVerifier | null =
    securityConfig.mode === 'access'
      ? createAccessJwtVerifier({
          teamDomain: securityConfig.teamDomain,
          aud: securityConfig.aud,
          jwks: deps.accessJwks,
        })
      : null

  // `?.trim() || 기본값` — FLEET_HOST/FLEET_WORKSPACE_ROOT/FLEET_PORT 와 동일 패턴. `??` 는 빈
  // 문자열에서 폴백하지 않아, env 템플레이팅으로 FLEET_STATIC_DIR='' 가 되면 staticDir 가 CWD 로
  // 해소되고 createStaticHandler('') 가 저장소/앱 루트 파일을 그대로 서빙한다(정보 노출 · #197 B3
  // Codex P2). trim 후 빈 문자열/공백만도 미설정으로 취급해 renderer 폴백을 강제한다.
  const staticDir =
    env['FLEET_STATIC_DIR']?.trim() || join(dirname(fileURLToPath(import.meta.url)), '../renderer')
  const staticHandler = createStaticHandler(staticDir)
  const httpServer = createServer((req, res) => {
    // access 모드에서만 nonce 발급 endpoint 를 정적 서빙 앞에 가로챈다. loopback 은 endpoint 부재 —
    // /auth/ws-nonce POST 는 정적 핸들러 method guard 로 405(T1 특성화 핀).
    if (securityConfig.mode === 'access' && accessVerifier && isNonceRequest(req)) {
      void handleNonceRequest(req, res, {
        publicOrigin: securityConfig.publicOrigin,
        originAllowed,
        verifier: accessVerifier,
        nonceStore,
        onReject: onSecurityReject,
      }).catch(() => {
        // 드문 이중 writeHead 등이 floating promise 밖으로 새 unhandledRejection 되지 않게(static.ts 동형).
      })
      return
    }
    staticHandler(req, res)
  })
  // noServer 모드(#197 B5) — JWKS 검증이 async 라 sync verifyClient 로는 불가. httpServer 'upgrade' 를
  // 직접 받아 nonce 선소모→Origin→JWT→바인딩 순으로 게이팅한 소켓만 handleUpgrade→attach 한다.
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (socket, _req, expiresAtMs?: number) => {
    // 소켓 error 리스너를 **모든 경로 이전에** 선부착한다 — 리스너 부재 시 Node 가 프로세스를 종료(#197 B3 ·
    // Codex P2). 특히 아래 attach-시점-만료 early-close 도 error 없이 close 를 시도하므로, malformed 프레임/전송
    // 오류가 그 소켓에 방출되면 크래시할 수 있다(적대리뷰 CONFIRMED#1). onGone 은 attach 후 handleSocketGone 로
    // 교체돼 presence 정리까지 포함하고, attach 전엔 no-op 이라 조기 close 경로도 안전하다.
    let onGone = (): void => {}
    socket.on('error', () => {
      onGone()
      try {
        socket.close()
      } catch {
        /* 이미 닫힘 */
      }
    })
    // 소켓 exp-시한 종료(#197-B6 T6): access 모드에서 검증된 JWT 의 exp 도달 시 소켓을 닫는다. attach
    // 시점에 이미 만료(exp<=now)면 소켓을 유지하지 않는다 — attach 이전에 close 해 presence(clientCount)
    // 오염·rejectAll 오발을 막는다. loopback 은 exp 무관(handshake-only B3/B4 시맨틱).
    const hasExpiry = securityConfig.mode === 'access' && expiresAtMs !== undefined
    if (hasExpiry && expiresAtMs - clock.now() <= 0) {
      socket.close()
      return
    }
    const binding = wsHost!.attach({
      send: (data) => socket.send(data),
      close: () => socket.close(),
    })
    let expTimer: unknown
    // close·error 공통 정리 — 소켓 이탈 시 exp 타이머를 clear 하고 binding 을 닫는다.
    // **#216 C1(C-6 supersede)**: access presence-0 전이 시 rejectAll 을 **제거**한다 — hold 정책 하에서
    // 인증 클라 0(외출)이어도 승인을 거두지 않고 보류해야 "외출 중 폰 승인" 완료정의가 성립한다. fail-closed
    // 종착은 이제 **TTL 만료 거부 + 취소 abort 두 경로**(C3 취소 그래프 관통 GREEN 이 선행 안전 게이트). 인가
    // 경계는 불변(응답=attach 인증 소켓만·B5 무변경). 종료 drain rejectAll 은 close() 가 관장(아래).
    // exp 타이머는 여기서 반드시 clear — 닫힌 소켓이 만료 시각까지 타이머 클로저를 붙들거나 이중 close 하지 않게.
    const handleSocketGone = (): void => {
      if (expTimer !== undefined) {
        clock.clearTimeout(expTimer)
        expTimer = undefined
      }
      binding.onClose()
    }
    onGone = handleSocketGone // 선부착 error 리스너가 이제 presence 정리까지 포함
    // exp 타이머 무장 — 지연이 Node TIMEOUT_MAX(≈24.8일)를 넘으면 즉시 발화(1ms 클램프)하므로 clamp 후
    // 재무장(arm 재귀)한다. 장수명 Access 토큰이 접속 직후 닫혀 재접속 루프에 빠지지 않게(오버플로 방지).
    if (hasExpiry) {
      const arm = (): void => {
        const remaining = expiresAtMs - clock.now()
        if (remaining <= 0) {
          socket.close()
          return
        }
        expTimer = clock.setTimeout(arm, Math.min(remaining, TIMEOUT_MAX))
      }
      arm()
    }
    socket.on('message', (data) => binding.onMessage(rawDataToString(data)))
    socket.on('close', handleSocketGone)
    // error 리스너는 위에서 선부착됨(onGone=handleSocketGone 로 승격) — 여기서 재부착하지 않는다.
  })

  /** 검증 실패 — 401 상태줄 write 후 소켓 파괴 + 관측 로그 1줄(stage/reason 코드만 · 토큰/nonce 값 금지). */
  const rejectUpgrade = (socket: Duplex, reason: string): void => {
    onSecurityReject('upgrade', reason)
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    } catch {
      /* 이미 닫힌 소켓 write 실패 무시 */
    }
    socket.destroy()
  }

  // expiresAtMs: access 모드에서 검증된 JWT exp(ms) — connection 핸들러의 소켓 exp 타이머 근거(#197-B6 T6).
  const acceptUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    expiresAtMs?: number,
  ): void => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, expiresAtMs))
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (socket.destroyed) return // handleUpgrade 전 파괴 확인(B3 P2 형제)
    const origin = req.headers.origin

    if (securityConfig.mode === 'loopback') {
      // B3/B4 시맨틱 — isAllowedOrigin(부재 허용·loopback 오리진만). nonce 는 선택적(무시).
      if (!originAllowed(origin)) return rejectUpgrade(socket, 'origin')
      acceptUpgrade(req, socket, head)
      return
    }

    // access 모드 — nonce 선소모 파이프라인(체크포인트 4-R 확정 순서).
    const nonce = parseNonceParam(req.url)
    if (!nonce) return rejectUpgrade(socket, 'nonce-absent')
    // 무조건 삭제(성패 무관 소모) — 이후 어떤 실패에도 재사용 불가.
    const record = nonceStore.take(nonce)
    if (!record) return rejectUpgrade(socket, 'nonce-invalid')
    if (!originAllowed(origin)) return rejectUpgrade(socket, 'origin')
    let identity: string
    let expiresAtMs: number
    try {
      const verified = await accessVerifier!.verify(extractAccessToken(req) ?? '')
      identity = verified.identity
      expiresAtMs = verified.expiresAtMs // exp 부재/비유한수는 verify 가 이미 fail-closed(여기 도달=유한값)
    } catch {
      return rejectUpgrade(socket, 'jwt')
    }
    // 바인딩 대조 — nonce 발급 시 identity+Origin 과 upgrade 의 JWT sub+Origin 이 일치해야 한다.
    if (record.identity !== identity || record.origin !== origin) {
      return rejectUpgrade(socket, 'binding')
    }
    if (socket.destroyed) return // async 검증 도중 파괴됐으면 중단
    acceptUpgrade(req, socket, head, expiresAtMs)
  }

  httpServer.on('upgrade', (req, socket, head) => {
    // raw socket 'error' 리스너 선부착 — handleUpgrade 전/중 소켓 오류가 unhandled 로 프로세스를 죽이지
    // 않게(B3 P2 형제). async 검증 경로 예외는 여기서 삼키고 소켓을 파괴(fail-closed).
    socket.on('error', () => {
      /* 업그레이드 중 소켓 오류 격리 — destroy 는 아래 경로가 처리 */
    })
    void handleUpgrade(req, socket, head).catch(() => {
      try {
        socket.destroy()
      } catch {
        /* already destroyed */
      }
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen)
    httpServer.listen(port, host, resolveListen)
  })

  // 하드 teardown(#216 C3 promise-memo) — 동시/중복 close 는 동일 promise 를 await 한다(closed flag 는 teardown
  // 미완인데 조기 resolve 될 여지 → promise-memo 로 완료까지 공유). rejectAll·terminate 는 이미 멱등.
  let closePromise: Promise<void> | null = null
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      // 종료 시 outstanding 승인 전원 즉시 reject(dispose 전) — 어떤 클라도 응답 못 함(멱등·mode 무관 안전).
      ipcApprover.rejectAll()
      for (const c of wss.clients) c.terminate()
      wss.close()
      // httpServer.close() 는 리스너만 닫고 기존 커넥션 완료를 대기한다. 정적 자산 서빙으로 생긴 HTTP
      // keep-alive(브라우저 idle·keepAliveTimeout 기본 5s)·close-창 late-upgrade 소켓은 스스로 끝날 때까지
      // close() 를 pending 시켜 clean 종료를 지연(최악 백스톱 발화로 exit(1) 강등)한다 — closeAllConnections 로
      // 전 커넥션을 강제 종료해 즉시 close 완료(#216 C3 · 자체 적대리뷰 P3). WS 소켓은 이미 terminate 됨(멱등).
      await new Promise<void>((r) => {
        httpServer.close(() => r())
        httpServer.closeAllConnections()
      })
      await engine.dispose()
    })())

  // graceful drain 종료(#216 C3) — memo-gate → draining → (broadcast T5) → waitForRunDrain → close.
  let shutdownPromise: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    // ⓪ memo-gate: draining/wait/close 이전 첫 평가(멱등 — 중복 SIGTERM/SIGINT 에 동일 promise·broadcast/close 1회).
    if (shutdownPromise) return shutdownPromise
    // ① 동기 set — 이후 fleet:project:run 은 isDraining 게이트가 거부(체크와 호출 사이 await 0 = 레이스 0).
    draining = true
    shutdownPromise = (async () => {
      // ② 클라 통지(best-effort) — attach(인증 통과) 소켓만 도달·safeSend 격리. 정적 페이로드(민감값 0).
      // 로그 1줄 = 운영자가 재배포 시 `docker logs` 로 드레인 시작을 관측(C5 런북 §1.3)·drain e2e 결정론 관측.
      console.warn('[fleet] draining — 신규 런 거부·진행 런 완료 대기 후 종료(#216 C3)')
      wsHost?.broadcast('fleet:server:draining', { reason: 'shutdown' })
      // ③ 진행 런(activeRuns) 완료 대기(상한). drainTimeoutMs 는 RunningServer 노출값과 동일 const(divergence 0).
      await waitForRunDrain(() => engine.getRunActivity(), clock, drainTimeoutMs, DRAIN_POLL_MS)
      // ④ 하드 teardown(timeout=force → dispose 가 잔여 런 abort → 오케스트레이터 revert · rejectAll fail-closed 종단).
      await close()
    })()
    return shutdownPromise
  }

  return {
    port: (httpServer.address() as AddressInfo).port,
    host,
    mode: securityConfig.mode,
    clientCount: () => wsHost?.clientCount() ?? 0,
    drainTimeoutMs,
    shutdown,
    close,
  }
}
