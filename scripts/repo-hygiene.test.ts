// scripts/repo-hygiene.test.ts
// 레포 위생·CI 정합 불변식(#175). 관례(산문)가 아니라 기계적 계약으로 고정해 재drift 를 막는다.
//   - .gitignore allowlist: .claude 추적 자산(README·skills·workflows)만, 런타임/로컬 자산 제외
//   - verify 집계: package.json `verify` 가 6 품질게이트 + brain:check 를 모두 체인
//   - CI 정합: ci.yml quality 잡이 개별 게이트가 아니라 단일 `npm run verify` 만 실행
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

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
 * 소스 위생 — **원시 제어문자 금지**(#251 PR1b `src/**` → PR1c 레포 전역 → 여기서 **문자 범위 확장**).
 *
 * git 은 NUL 이 있는 파일을 **바이너리로 분류**하므로 PR diff 가 「Binary files … differ」가 되고
 * ripgrep 도 라인을 내지 않는다 — 이 레포의 리뷰(Codex·CodeRabbit)는 diff 를 읽는 봇에 의존하므로
 * 파일 하나가 통째로 리뷰 사각으로 사라진다(PR1b 에서 실제로 발생). 그 가드가 `src/**` 의 `.ts/.tsx`
 * 에만 걸려 있어 `scripts/`·`e2e/`·`deploy/` 는 무방비였다(자체 적대 리뷰 R6-4 · prettier·tsc 도 NUL 을
 * 그대로 통과시킨다). 제어문자는 이스케이프(`\u0000`)로 쓴다.
 *
 * ## 왜 NUL 만으로는 부족한가 (#251 PR3c 실측)
 *
 * PR3c 가 `recovery.ts` 에 **U+0001** 을 실어 착지시켰고 `npm run verify` **7게이트가 전부 통과**했다.
 * 발견자는 게이트가 아니라 외부 리뷰어(CodeRabbit)였다. 문자별 프로브가 경계를 정확히 그린다 —
 * **U+0000 = RED(잡힘)** · **U+0001 · U+001F · U+007F = 통과(무신호)**. 이 가드는 **NUL 만** 보고 있었다.
 *
 * NUL 이 아닌 제어문자는 diff 를 바이너리로 접지는 않지만 **소스에서 보이지 않는다** — 리뷰어는
 * `join('')` 로 읽는데 실제로는 다른 구분자가 돌고, 문자열 상수·정규식 리터럴에 섞이면 값이 조용히
 * 달라진다. 「보이지 않는 바이트가 의미를 바꾼다」는 축이 같으므로 **C0/C1 전반**으로 넓힌다.
 *
 * 허용은 **탭·LF** 뿐이다. CR 은 **거부한다**(Codex #290 P1 — 최초 판본은 「win32 체크아웃의 CRLF
 * 때문에 필수」라며 허용했는데, 그 전제가 실물과 어긋난다): `.gitattributes` 가 `* text=auto eol=lf`
 * 로 워킹트리를 전 플랫폼 LF 로 정규화하므로(그 파일은 이 PR 의 base `b92221c` 에도 이미 있었다)
 * 정상 체크아웃에서는 CRLF 자체가 생기지 않는다. 반대로 CR 을 열어 두면 **단독 CR** 이 통과하는데,
 * JS 에서 CR 은 LineTerminator 라 `//` 주석을 조용히 끝낸다 — 이제 스캔에 들어온 머지 게이트 훅
 * (`.claude/hooks/require-codex-review.mjs`)에서도 그렇다. 이 가드가 막으려는 「보이지 않는 바이트가
 * 의미를 바꾼다」의 교과서적 사례라 예외로 둘 이유가 없다.
 *
 * ⚠ **패턴을 이스케이프 문자열로 만든다.** 문자 클래스에 raw 제어문자를 적으면 **이 가드 자신이
 * 오염원**이 된다 — PR3c 에서 이 규율을 적는 편집이 실제로 8건을 재생산했다.
 *
 * ⚠ `no-control-regex` 를 **이 한 줄에서만** 끈다. 그 규칙의 목적(제어문자가 정규식에 실수로 들어가는
 * 것)과 이 줄의 목적(제어문자를 **찾는** 것)이 정확히 반대다. 규칙을 config 에서 끄면 나머지 레포가
 * 방어를 잃으므로 범위를 한 줄로 묶는다.
 */
const CONTROL_CHAR_RE = new RegExp(
  // eslint-disable-next-line no-control-regex -- 제어문자 탐지가 이 상수의 존재 이유다
  '[\\u0000-\\u0008\\u000B\\u000C\\u000D-\\u001F\\u007F-\\u009F]',
  'g',
)

/** 위반 위치를 `파일:줄 U+XXXX` 로 답한다 — 「몇 건」만 알면 고칠 수가 없다. */
const findControlChars = (text: string, label = ''): string[] => {
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CONTROL_CHAR_RE)) {
      const code = m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
      hits.push(`${label}${label ? ':' : ''}${i + 1} U+${code}`)
    }
  })
  return hits
}

/**
 * **판정식 자기검사**(양성 통제). 레포가 깨끗할 때 아래 전수 스캔은 **항진**이라 판정식이 망가져도
 * 초록이다 — 그 vacuous-GREEN 을 막는 것이 이 블록이다. PR3c 가 실제로 흘린 두 문자를 회귀 핀으로 둔다.
 */
describe('소스 위생 — 제어문자 판정식 자기검사', () => {
  it('C0/C1 을 전부 잡는다(PR3c 가 흘린 U+0000·U+0001 포함)', () => {
    for (const code of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x0e, 0x1f, 0x7f, 0x80, 0x9f]) {
      const probe = `const a = 'x${String.fromCharCode(code)}y'`
      expect(findControlChars(probe), `U+${code.toString(16)} 를 놓쳤다`).toHaveLength(1)
    }
  })

  it('탭·LF 만 허용한다', () => {
    expect(findControlChars('a\tb\nc\nd\n')).toEqual([])
  })

  // CR 은 거부 쪽이다(Codex #290 P1). `.gitattributes` 의 `* text=auto eol=lf` 가 워킹트리를 전
  // 플랫폼 LF 로 정규화하므로 정상 체크아웃에 CRLF 가 없고, JS 에서 CR 은 LineTerminator 라
  // 단독으로 섞이면 `//` 주석을 조용히 끝낸다. CRLF 도 그 CR 때문에 잡힌다 — 그게 의도다.
  it('CR 은 단독이든 CRLF 든 잡는다', () => {
    expect(findControlChars('a\rb', 'f.ts')).toEqual(['f.ts:1 U+000D'])
    expect(findControlChars('a\r\nb', 'f.ts')).toEqual(['f.ts:1 U+000D'])
  })

  it('비ASCII 를 오탐하지 않는다(한글·이모지·전각)', () => {
    expect(findControlChars('한글 · 이모지 🚀 · 전각Ａ · 결합문자 é')).toEqual([])
  })

  it('위치를 파일:줄 U+XXXX 로 답한다', () => {
    expect(findControlChars(`ok\nbad${String.fromCharCode(1)}here`, 'f.ts')).toEqual([
      'f.ts:2 U+0001',
    ])
  })
})

describe('소스 위생 — 리뷰 대상 텍스트에 원시 제어문자 0건(#251 PR1c · PR3c 범위 확장)', () => {
  // `.claude` 를 포함하는 이유(Codex #290 P1) — 그 트리는 **다른 어떤 게이트도 제어문자를 보지
  // 않는다**: eslint 는 `.claude/**` 를 통째로 ignores 하고(eslint.config.mjs 「.claude/** 는 eslint
  // 대상에서 제외」절), 그 자리를 대신한다고 적힌 `skills:lint` 에는 제어문자 검사가 없다(실측 0건).
  // 그런데 그 안에 **머지 게이트 자신**(`.claude/hooks/require-codex-review.mjs`)이 있고, 보이지 않는
  // 바이트가 그 정규식에 섞이면 무엇을 막는지가 조용히 달라진다. 스캔에서 빼면 정확히 이 가드가
  // 막으려는 오염이 가장 위험한 파일에서만 무방비가 된다.
  // ⚠ 다만 `.claude` 만은 **추적 파일로 한정**한다(Codex #290 P2). 이 루트는 `.gitignore` 가
  // `.claude/*` allowlist 라 무시되는 런타임 자산이 같은 트리에 산다 — `settings.local.json` 뿐
  // 아니라 **워크플로 worktree**(= 그 아래에 통째로 다른 체크아웃)까지다. eslint 가 이 트리를
  // 제외한 사유가 바로 그것이라고 `eslint.config.mjs` 상단이 적고 있다. 파일시스템 walk 는 그것을
  // 전부 읽으므로, 로컬에만 있는 CRLF 파일 하나로 `npm test`·`npm run verify` 가 RED 가 된다 —
  // `.gitattributes` 의 `eol=lf` 는 **추적 콘텐츠만** 정규화하므로 그 파일들은 보호 밖이다.
  // 필수 게이트가 개발자 머신 상태에 따라 갈리는 것은 #307 이 닫으려는 축과 같은 것이라
  // `git ls-files` 로 추적 자산만 센다. 코드 루트는 walk 그대로 둔다 — 그쪽은 무시 자산이 사실상
  // 없고, 커밋 전 새 파일도 잡아 주는 편이 낫다.
  const WALK_ROOTS = ['src', 'scripts', 'e2e', 'deploy', '.github']
  const TRACKED_ROOTS = ['.claude']
  const ROOTS = [...WALK_ROOTS, ...TRACKED_ROOTS]
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
  // `git ls-files` 는 항상 `/` 구분자를 낸다 — 아래 앵커가 `sep` 로 비교하므로 win32 에서
  // 어긋나지 않게 정규화한다(그 한 줄이 없으면 windows 레그에서만 앵커가 깨진다).
  const tracked = (root: string): string[] =>
    execFileSync('git', ['ls-files', '-z', '--', root], { encoding: 'utf8' })
      .split('\0')
      .filter((p) => p !== '' && EXT.test(p))
      .map((p) => p.split('/').join(sep))
  for (const r of WALK_ROOTS) if (existsSync(r)) walk(r)
  for (const r of TRACKED_ROOTS) files.push(...tracked(r))

  it('앵커: 스캔 대상이 충분히 많고 ROOTS 전부를 덮는다', () => {
    expect(files.length).toBeGreaterThan(100)
    for (const r of ROOTS) expect(files.some((f) => f.startsWith(`${r}${sep}`))).toBe(true)
  })

  // 루트 단위 앵커만으로는 `.claude` 에서 **아무 파일 하나**만 있어도 통과한다. 이 가드를 넓힌
  // 이유가 머지 게이트 본체였으므로(#290 P1) 그 파일을 이름으로 못박는다 — `TRACKED_ROOTS` 의
  // 추적 열거가 좁아지거나 EXT 가 `.mjs` 를 잃으면 여기서 RED 가 난다.
  it('앵커: 머지 게이트 훅이 스캔 대상에 실제로 들어 있다', () => {
    expect(files).toContain(join('.claude', 'hooks', 'require-codex-review.mjs'))
  })

  it('원시 NUL 바이트가 0건이다(리뷰 diff 가 바이너리로 접히지 않는다)', () => {
    expect(files.filter((f) => readFileSync(f).includes(0))).toEqual([])
  })

  it('NUL 외 C0/C1 제어문자도 0건이다(소스에서 보이지 않는 바이트가 의미를 바꾼다)', () => {
    expect(files.flatMap((f) => findControlChars(read(f), f))).toEqual([])
  })
})
