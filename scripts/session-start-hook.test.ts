// scripts/session-start-hook.test.ts
// SessionStart 훅의 **컨텍스트 주입 계약**을 고정한다.
//
// ## 왜 이 테스트가 있는가
// `AGENTS.md` 는 이 레포의 작업 규율 권위지만 **어떤 에이전트에게도 자동 주입되지 않는다** —
// Claude Code 는 `CLAUDE.md`, Gemini CLI 는 `GEMINI.md` 만 읽고, 둘 다 「AGENTS.md 를 읽어라」는
// 포인터일 뿐이다(Codex CLI 만 `AGENTS.md` 를 네이티브로 읽는다). 즉 포인터를 따라가지 않는
// 세션에서는 392줄 규율이 통째로 유실되고, 그 사실은 아무 신호 없이 지나간다.
//
// SessionStart 훅의 stdout 은 세션 컨텍스트로 주입되므로(훅 자신의 「출력 규약」 주석) 그 자리를
// 안내에 쓴다. 안내는 강제가 아니라 안내다 — 실제 강제는 `npm run verify`·ruleset·머지 게이트가
// 한다. 이 테스트가 고정하는 것은 「그 안내가 실제로 stdout 에 나오고, 무한히 비대해지지 않는다」다.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const HOOK = join(ROOT, '.claude', 'hooks', 'session-start.mjs')

/** 로컬 세션(원격 부트스트랩 미수행) 조건으로 훅을 실행한다. */
function runLocal() {
  const env = { ...process.env }
  delete env['CLAUDE_CODE_REMOTE']
  return spawnSync('node', [HOOK], { cwd: ROOT, env, encoding: 'utf8' })
}

describe('SessionStart 훅 — 컨텍스트 주입', () => {
  it('로컬 세션에서도 안내를 stdout 으로 낸다(원격 부트스트랩과 무관)', () => {
    const r = runLocal()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('AGENTS.md')
  })

  it('안내가 세 권위를 전부 지목한다 — 규율·구조 지도·게이트', () => {
    const { stdout } = runLocal()
    // 규율의 권위(포인터가 아니라 본체)
    expect(stdout).toContain('AGENTS.md')
    // src/ 전수 탐색을 대체하는 구조 지도
    expect(stdout).toContain('brain.md')
    // 산문이 아니라 이것이 강제한다
    expect(stdout).toContain('npm run verify')
  })

  it('CLAUDE.md·GEMINI.md 가 포인터일 뿐임을 밝힌다(자동 주입 오해 차단)', () => {
    const { stdout } = runLocal()
    expect(stdout).toContain('CLAUDE.md')
    expect(stdout).toContain('GEMINI.md')
  })

  it('로컬 세션에서는 원격 부트스트랩(npm install·gh)을 돌리지 않는다', () => {
    const { stderr } = runLocal()
    expect(stderr).not.toContain('npm install')
    expect(stderr).not.toContain('gh 설치')
  })

  it('주입 비용에 상한을 둔다 — 매 세션 로드되므로 비대화가 곧 비용이다(ADR-0002 교훈)', () => {
    const { stdout } = runLocal()
    // 현재 ~0.5KB. 상한은 여유를 두되 **무한 증식은 막는다** — 규율 본문을 여기 복사하기
    // 시작하면 AGENTS.md 와 이중 권위가 되어 드리프트한다(안내는 포인터로만 남을 것).
    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(1200)
  })

  it('부트스트랩 로그가 stdout 을 오염시키지 않는다 — 안내만 컨텍스트에 들어간다', () => {
    const { stdout } = runLocal()
    expect(stdout).not.toContain('[session-start]')
  })
})

describe('SessionStart 훅 — 구조 핀', () => {
  // 원격 경로는 npm install 을 실제로 돌리므로 스폰으로 검증할 수 없다. 대신
  // 「안내가 원격 분기보다 **먼저** 나온다」를 소스 순서로 고정한다 — 이 순서가 뒤집히면
  // 원격 세션에서만 안내가 나오고 로컬 세션은 조용히 규율을 잃는다.
  it('안내 출력이 CLAUDE_CODE_REMOTE 조기 종료보다 앞에 온다', () => {
    const src = readFileSync(HOOK, 'utf8')
    const guidance = src.indexOf('process.stdout.write')
    const earlyExit = src.indexOf("process.env['CLAUDE_CODE_REMOTE']")
    expect(guidance).toBeGreaterThan(-1)
    expect(earlyExit).toBeGreaterThan(-1)
    expect(guidance).toBeLessThan(earlyExit)
  })
})
