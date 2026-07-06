import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type RawData } from 'ws'
import type { AppInfo } from '../shared/types'
import { createChildEnv, type ChildEnv } from './child-env'
import { createFleetEngine } from '../main/core/engine'
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
  const host = resolveBindHost(env, securityConfig)
  const port = resolvePort(env)
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
  const ipcApprover = createIpcApprover({
    send: (req) => wsHost?.broadcast('fleet:approval:request', req),
    // presence: 접속(검증 통과) 클라이언트 존재 = 응답 가능. access 모드는 인증 클라 0 전이 시 rejectAll 이
    // outstanding 을 즉시 거둔다(#197 B5 · 체크포인트 2 §4). loopback 은 타임아웃 시맨틱 유지.
    hasWindow: () => (wsHost?.clientCount() ?? 0) > 0,
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
    runner: e2e ? resolveE2eRunner(env) : undefined,
    verifyRunner: e2e ? resolveE2eVerifyRunner(env) : undefined,
    // 자식 env 격리(#197-B6 T7): 서버 시크릿(FLEET_*)이 CLI 세션·detect/probe·MCP·verify·git 자식에 안 새게
    // allowlist 필터된 env 를 주입한다. boot 이 받은 env(운영=process.env)를 넘겨도 자식엔 base/provider 만 간다.
    childEnv: buildServerChildEnv(env),
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
  })
  wsHost = createWsHost({ handlers, eventCursor: () => store.eventCursor() })

  // 보안 컨텍스트(#197 B5) — access 검증기는 부팅 1회 생성(요청마다 createRemoteJWKSet 재생성은
  // 캐시/cooldown 무효화). nonceStore·originAllowed 는 HTTP nonce endpoint·WS upgrade(T7) 공유.
  const onSecurityReject: (stage: SecurityRejectStage, reason: string) => void =
    deps.onSecurityReject ??
    ((stage, reason) => console.warn(`fleet-server: 보안 거부 stage=${stage} reason=${reason}`))
  const originAllowed = makeOriginAllowed(securityConfig)
  const clock = deps.clock ?? defaultClock
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
    // close·error 공통 정리 — 인증 클라이언트가 0 이 되는 순간(access 한정) outstanding 승인 즉시 reject.
    // 검증 통과 소켓만 attach 되므로 clientCount = 인증 클라 수(presence 오염 없음). loopback 은 타임아웃
    // 시맨틱 유지(rejectAll 미호출 — B3/B4 하위호환·T1 핀). rejectAll 은 pending 0 이면 no-op(멱등).
    // exp 타이머는 여기서 반드시 clear — 닫힌 소켓이 만료 시각까지 타이머 클로저를 붙들거나 이중 close 하지 않게.
    const handleSocketGone = (): void => {
      if (expTimer !== undefined) {
        clock.clearTimeout(expTimer)
        expTimer = undefined
      }
      binding.onClose()
      if (securityConfig.mode === 'access' && wsHost!.clientCount() === 0) {
        ipcApprover.rejectAll()
      }
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

  return {
    port: (httpServer.address() as AddressInfo).port,
    host,
    mode: securityConfig.mode,
    clientCount: () => wsHost?.clientCount() ?? 0,
    close: async () => {
      // 종료 시 outstanding 승인 전원 즉시 reject(dispose 전) — 어떤 클라도 응답 못 함(멱등·mode 무관 안전).
      ipcApprover.rejectAll()
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((r) => httpServer.close(() => r()))
      await engine.dispose()
    },
  }
}
