// scripts/mcp-client-version.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * MCP `clientInfo.version` ↔ `package.json` version 정합 게이트 (Codex PR#313 2R P2).
 *
 * `src/main/core/mcp/client.ts` 의 `CLIENT_VERSION` 은 Fleet 이 MCP 서버에 자기를 소개하는 값이다.
 * 여기가 낡으면 **모든 설치본이 틀린 버전을 광고**해 서버측 호환 처리·진단을 오도한다.
 *
 * 원래 이 정합은 「package.json 과 동기화(드리프트 시 수정)」라는 **산문 규약**이었는데, `0.1.1`
 * 릴리스 범프가 실제로 이 상수를 `0.1.0` 에 남겨둔 채 나갈 뻔했다 — 산문은 릴리스 절차와 연결돼
 * 있지 않아 아무 신호도 내지 않는다. ADR-0016 이 세운 선례(범프마다 낡는 값은 산문에서 빼고 게이트로
 * 강제한다)를 그대로 적용해 대조로 승격한다.
 *
 * 소스 텍스트를 읽어 대조하는 이유: `CLIENT_VERSION` 은 내부 상수라 export 하지 않는다. 정합
 * 하나를 위해 프로덕션 공개 표면을 넓히는 대신, `approval-gate-exceptions.test.ts` 와 같은 축
 * (소스 대조)으로 판정한다.
 */
describe('MCP clientInfo.version ↔ package.json 정합', () => {
  const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
    .version
  const source = readFileSync('src/main/core/mcp/client.ts', 'utf8')

  it('package.json 의 version 이 semver 형태다', () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('CLIENT_VERSION 선언이 정확히 하나 있다 (대조가 헛돌지 않게)', () => {
    const declarations = source.match(/^const CLIENT_VERSION = '[^']*'$/gm) ?? []
    expect(declarations).toHaveLength(1)
  })

  it('CLIENT_VERSION 이 package.json 의 version 과 같다', () => {
    const declared = /^const CLIENT_VERSION = '([^']*)'$/m.exec(source)?.[1]
    expect(declared).toBe(pkgVersion)
  })

  it('clientInfo 가 그 상수를 쓴다 (리터럴 하드코딩으로 우회되지 않게)', () => {
    expect(source).toMatch(/clientInfo:\s*\{\s*name:\s*'fleet',\s*version:\s*CLIENT_VERSION\s*\}/)
  })
})
