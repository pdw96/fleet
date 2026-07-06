import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * renderer 번들 정적 서빙(#197 B3·B5). WS 와 같은 http 서버에 얹는다(upgrade 는 ws 가 가로챔).
 * 보안: 요청 경로를 rootDir 기준으로 해소한 뒤 relative 검사로 루트 밖 접근을 404 로 자른다
 * (decodeURIComponent 후 검사라 %2e%2e 우회 불가·404 로 존재 비노출). 전 응답에 CSP·보안 헤더(#197 B5).
 *
 * 무인증 서빙(명시 결정): non-loopback 개방(access) 후에도 renderer 번들은 JWT 없이 서빙된다 — 의도적
 * 수용. 번들은 비밀이 아니고, 실배포는 터널 앞단 Cloudflare Access(MFA)가 HTML 자체를 게이팅하며, 직접
 * LAN bind 는 운영자 명시 opt-in 이다. 인증은 WS upgrade(nonce+JWT)·nonce endpoint 가 담당(오케스트레이션).
 */
// 체크포인트 4-R 확정 CSP — 데스크톱 index.html 메타 상위집합. connect-src 'self' 는 CSP3 에서 same-origin
// ws/wss 포함(B4 리뷰 REFUTED·라이브 재확인 Task 11). Referrer-Policy 는 ?nonce= URL 이 Referer 로 새는 것
// 방지 정합. 문자열은 static.test.ts 와 전체 일치 고정(약화 회귀 무신호 차단).
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
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
    // 단일 지점 — 전 응답(200·404·405·SPA 폴백)에 CSP·보안 헤더를 균일 부착(누락 표면 0).
    res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS })
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
    })().catch(() => {
      // 드문 이중 writeHead(응답 커밋/중단 후 재전송 시도로 ERR_HTTP_HEADERS_SENT 등)가
      // void 처리된 프로미스 밖으로 새면 unhandledRejection 으로 프로세스가 죽을 수 있다 —
      // 이 시점엔 보낼 게 없으므로 그냥 삼킨다(entry-signal 과 동일한 floating-promise 방어).
    })
  }
}
