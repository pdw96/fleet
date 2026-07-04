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
    })().catch(() => {
      // 드문 이중 writeHead(응답 커밋/중단 후 재전송 시도로 ERR_HTTP_HEADERS_SENT 등)가
      // void 처리된 프로미스 밖으로 새면 unhandledRejection 으로 프로세스가 죽을 수 있다 —
      // 이 시점엔 보낼 게 없으므로 그냥 삼킨다(entry-signal 과 동일한 floating-promise 방어).
    })
  }
}
