import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type RawData } from 'ws'
import type { AppInfo } from '../shared/types'
import { createFleetEngine } from '../main/core/engine'
import { createIpcApprover } from '../main/core/safety/approval-bridge'
import { createJsonFileStore } from '../main/core/store/json-file'
import { isE2EActive, resolveE2eRunner, resolveE2eVerifyRunner, seedE2eFixtures } from '../main/e2e'
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

/** ws `RawData`(Buffer|ArrayBuffer|Buffer[])를 텍스트 프레임 문자열로 정규화(no-base-to-string 회피). */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

export async function bootServer(env: NodeJS.ProcessEnv): Promise<RunningServer> {
  const host = resolveBindHost(env)
  const port = resolvePort(env)
  const e2e = isE2EActive(env)
  // 워크스페이스 검증(dialog 대신 env 경로): 미존재/비디렉터리는 fail-fast — store 생성(mkdirSync
  // 부수효과) 이전에 순수 검증부터 끝낸다. 실제 적용(setWorkspace)은 engine 생성 후로 미룬다.
  const workspaceRoot = env['FLEET_WORKSPACE_ROOT']?.trim()
  if (workspaceRoot && !statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`FLEET_WORKSPACE_ROOT 가 디렉터리가 아님: ${workspaceRoot}`)
  }
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
    runner: e2e ? resolveE2eRunner(env) : undefined,
    verifyRunner: e2e ? resolveE2eVerifyRunner(env) : undefined,
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

  // `?.trim() || 기본값` — FLEET_HOST/FLEET_WORKSPACE_ROOT/FLEET_PORT 와 동일 패턴. `??` 는 빈
  // 문자열에서 폴백하지 않아, env 템플레이팅으로 FLEET_STATIC_DIR='' 가 되면 staticDir 가 CWD 로
  // 해소되고 createStaticHandler('') 가 저장소/앱 루트 파일을 그대로 서빙한다(정보 노출 · #197 B3
  // Codex P2). trim 후 빈 문자열/공백만도 미설정으로 취급해 renderer 폴백을 강제한다.
  const staticDir =
    env['FLEET_STATIC_DIR']?.trim() || join(dirname(fileURLToPath(import.meta.url)), '../renderer')
  const httpServer = createServer(createStaticHandler(staticDir))
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin }: { origin: string }) => isAllowedOrigin(origin),
  })
  wss.on('connection', (socket) => {
    const binding = wsHost!.attach({
      send: (data) => socket.send(data),
      close: () => socket.close(),
    })
    socket.on('message', (data) => binding.onMessage(rawDataToString(data)))
    socket.on('close', () => binding.onClose())
    socket.on('error', () => {
      // 소켓 error(비정상 프레임/전송 오류) 리스너 부재 시 Node 가 프로세스를 종료(#197 B3 · Codex P2) —
      // 바인딩 정리 후 해당 소켓만 종료(다른 연결 무영향).
      binding.onClose()
      socket.close()
    })
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
