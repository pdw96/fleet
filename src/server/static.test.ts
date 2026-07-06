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

describe('보안 헤더(#197 B5 T9)', () => {
  // 체크포인트 4-R 확정 최종 문자열 — 계획·테스트 일치 고정. 전체 일치 단언(부분 아님)이라 약화 회귀
  // (지시자 삭제·완화)가 무신호로 새지 않는다. unsafe-eval 부재는 전체 일치에 내포.
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  function assertHeaders(res: Response): void {
    expect(res.headers.get('content-security-policy')).toBe(CSP)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  }

  it('200 자산 응답에 보안 헤더 전량', async () => {
    assertHeaders(await fetch(`${base}/assets/app.js`))
  })
  it('200 SPA 폴백(index) 응답에 보안 헤더 전량', async () => {
    assertHeaders(await fetch(`${base}/rooms`))
  })
  it('404 응답에 보안 헤더 전량', async () => {
    assertHeaders(await fetch(`${base}/assets/nope.js`))
  })
  it('405 응답에 보안 헤더 전량', async () => {
    assertHeaders(await fetch(`${base}/`, { method: 'POST' }))
  })
})
