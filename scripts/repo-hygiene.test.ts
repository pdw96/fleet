// scripts/repo-hygiene.test.ts
// 레포 위생·CI 정합 불변식(#175). 관례(산문)가 아니라 기계적 계약으로 고정해 재drift 를 막는다.
//   - .gitignore allowlist: .claude 추적 자산(README·skills·workflows)만, 런타임/로컬 자산 제외
//   - verify 집계: package.json `verify` 가 6 품질게이트 + brain:check 를 모두 체인
//   - CI 정합: ci.yml quality 잡이 개별 게이트가 아니라 단일 `npm run verify` 만 실행
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

const read = (p: string) => readFileSync(p, 'utf8')

describe('.gitignore — .claude allowlist(#175 item1)', () => {
  const gi = read('.gitignore')
  const lines = gi.split(/\r?\n/).map((l) => l.trim())
  it('.claude/* 로 전체를 제외하고 추적 자산만 negation 한다', () => {
    expect(lines).toContain('.claude/*')
    expect(lines).toContain('!.claude/README.md')
    expect(lines).toContain('!.claude/skills/')
  })
  it('추적 자산인 .claude/workflows/ 를 negation 한다(lint-staged·ci.yml 이 참조 — Codex 리뷰 #5)', () => {
    expect(lines).toContain('!.claude/workflows/')
  })
})

describe('package.json verify — 품질게이트 집계(#175 item2)', () => {
  const pkg = JSON.parse(read('package.json'))
  const verify: string = pkg.scripts?.verify ?? ''
  it('verify 스크립트가 존재한다', () => {
    expect(verify.length).toBeGreaterThan(0)
  })
  it('6 품질게이트 + brain:check 를 모두 체인한다(local==CI)', () => {
    for (const cmd of [
      'npm run skills:lint',
      'npm run brain:check',
      'npm run format:check',
      'npm run typecheck',
      'npm run lint',
      'npm run test:coverage',
      'npm run build',
    ]) {
      expect(verify, `verify 가 "${cmd}" 를 포함해야 한다`).toContain(cmd)
    }
  })
})

describe('ci.yml quality 잡 — 단일 verify 진입(#175 item2 재drift 차단)', () => {
  const ci = read('.github/workflows/ci.yml')
  it('required status check 잡 이름을 유지한다(rename 시 master 머지 게이팅 무력화 — 적대리뷰 #4)', () => {
    // master ruleset 의 required check 는 잡 표시명으로 매칭된다. 이 이름이 바뀌면 게이트가
    // 조용히 사라지므로(false-GREEN at ruleset level) 기계적으로 못박는다.
    expect(ci).toContain('name: typecheck · lint · test · build')
    expect(ci).toContain('windows vitest (win32 보안 회귀)')
  })
  it('quality 잡이 npm run verify 를 실행한다', () => {
    expect(ci).toContain('npm run verify')
  })
  it('개별 품질게이트 스텝을 직접 두지 않는다(전부 verify 경유 — drift 원천 차단)', () => {
    // windows-tests 잡의 `npm test` 는 의도된 예외(win32 보안 회귀)라 허용.
    for (const cmd of [
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm run build',
      'node scripts/skills-lint.mjs',
    ]) {
      expect(ci, `ci.yml 이 개별 게이트 "${cmd}" 를 직접 두면 안 된다`).not.toContain(cmd)
    }
  })
})

/**
 * 소스 위생 — **원시 NUL 바이트 금지**(#251 PR1b 가 `src/**` 에 신설한 가드의 레포 전역 확장).
 *
 * git 은 NUL 이 있는 파일을 **바이너리로 분류**하므로 PR diff 가 「Binary files … differ」가 되고
 * ripgrep 도 라인을 내지 않는다 — 이 레포의 리뷰(Codex·CodeRabbit)는 diff 를 읽는 봇에 의존하므로
 * 파일 하나가 통째로 리뷰 사각으로 사라진다(PR1b 에서 실제로 발생). 그 가드가 `src/**` 의 `.ts/.tsx`
 * 에만 걸려 있어 `scripts/`·`e2e/`·`deploy/` 는 무방비였다(자체 적대 리뷰 R6-4 · prettier·tsc 도 NUL 을
 * 그대로 통과시킨다). 제어문자는 이스케이프(`\u0000`)로 쓴다.
 */
describe('소스 위생 — 리뷰 대상 텍스트에 원시 NUL 0건(#251 PR1c)', () => {
  const ROOTS = ['src', 'scripts', 'e2e', 'deploy', '.github']
  const EXT = /\.(?:ts|tsx|mjs|cjs|js|sh|ya?ml|json|md)$/
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p)
      } else if (EXT.test(e.name)) files.push(p)
    }
  }
  for (const r of ROOTS) if (existsSync(r)) walk(r)

  it('앵커: 스캔 대상이 충분히 많고 네 루트를 모두 덮는다', () => {
    expect(files.length).toBeGreaterThan(100)
    for (const r of ROOTS) expect(files.some((f) => f.startsWith(`${r}${sep}`))).toBe(true)
  })

  it('원시 NUL 바이트가 0건이다(리뷰 diff 가 바이너리로 접히지 않는다)', () => {
    expect(files.filter((f) => readFileSync(f).includes(0))).toEqual([])
  })
})
