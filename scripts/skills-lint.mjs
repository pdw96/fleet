// scripts/skills-lint.mjs
// .claude/agents·.claude/skills·.claude/workflows·.github/workflows 추적 자산의 경로·시크릿
// 누출과 SKILL.md frontmatter 규약을 검사하는 강제 게이트(스펙 §8). fail-on-match.

/** 차단 패턴 셋 — 개인 절대경로·세션경로·사용자명·자격증명 (스펙 §8) */
export const BANNED_PATTERNS = [
  { re: /[A-Za-z]:[\\/]+Users[\\/]+/i, name: 'Windows 사용자 절대경로' },
  { re: /\/c\/Users\//i, name: 'Git Bash 사용자 절대경로' },
  { re: /AppData[\\/]Local[\\/]Temp/i, name: 'AppData Temp 경로' },
  { re: /projects[\\/]C--Users/i, name: '세션 디렉터리 경로' },
  { re: /\bqkreh\b/, name: '사용자명 리터럴' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, name: 'GitHub 토큰' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, name: 'API 키(sk-)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS 액세스 키' },
]

/** 텍스트를 줄 단위로 스캔해 차단 패턴 매치를 반환 */
export function scanText(text) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((content, i) => {
    // 한 줄에 서로 다른 패턴이 여러 개 매치되면 각각 보고한다(의도된 동작) — 한 줄이
    // 경로+사용자명을 동시에 담으면 둘 다 실제 결함이므로 중복 보고가 아니라 정확한 적발이다.
    for (const { re, name } of BANNED_PATTERNS) {
      if (re.test(content)) hits.push({ line: i + 1, pattern: name })
    }
  })
  return hits
}

/**
 * GitHub Actions 워크플로의 블록-스타일 `uses:` 가 40자 커밋 SHA 로 핀됐는지 검사(#137).
 * 가변 ref(태그·브랜치·짧은 SHA·ref 누락)는 작성자/계정 탈취 시 악성 커밋으로 이동 가능 —
 * 공급망 공격면(2025-03 tj-actions). 핀 SHA 만 허용. 로컬 액션(./ ../)·docker:// 는 핀 대상 아님.
 * 권위적 강제는 이 함수(ci.yml skills:lint 게이트). `.semgrep/guardian.yml` 은 동일 정책의 선언적 미러.
 * 블록 스타일(`- uses:`/잡-레벨 `uses:`)과 uses 가 첫 키인 플로우 스타일(`- {uses: x@v1}`)을 모두 본다.
 * 잔여 한계(미지원): uses 가 첫 키가 아닌 플로우 맵(`- {name: a, uses: x}`)·인라인 steps 배열 —
 * 레포 전 워크플로가 블록 스타일이라 미발현이고 guardian.yml 구조 매칭이 그 형태를 보강한다. CRLF 정규화.
 * @returns {{line:number, ref:string}[]} 위반 줄(ref = 미핀 `owner/repo@ref` 값)
 */
export function scanWorkflowPins(text) {
  const hits = []
  text.split(/\r?\n/).forEach((content, i) => {
    // YAML 키로서의 uses: 만(스텝 `- uses:` / 잡-레벨 `uses:` / 플로우 `- {uses:`). 주석·run 본문은 ^ 앵커로 제외.
    const m = content.match(/^\s*(?:-\s+)?\{?\s*uses:\s*(\S.*)$/)
    if (!m) return
    // 인라인 주석(' #…')·플로우 맵 트레일러(`, …`·`}`)·감싼 따옴표 제거해 순수 ref 값 추출.
    const value = m[1]
      .replace(/\s+#.*$/, '')
      .split(',')[0]
      .replace(/\}\s*$/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (value.startsWith('./') || value.startsWith('../') || value.startsWith('docker://')) return
    const at = value.lastIndexOf('@')
    const ref = at === -1 ? '' : value.slice(at + 1)
    if (/^[0-9a-f]{40}$/.test(ref)) return // 완전 SHA 핀 = 통과(주석 유무 무관)
    hits.push({ line: i + 1, ref: value })
  })
  return hits
}

// release.yml 안전 라인 매처(모듈 스코프 — 테스트·재사용). 주석(#)·CRLF 내성.
// uses 값의 선행 따옴표 허용(scanWorkflowPins 와 동일하게 `uses: "actions/..."` 도 분류 — Codex PR리뷰).
const RE_ATTEST = /^\s*(?:-\s+)?uses:\s*['"]?actions\/attest-build-provenance@[0-9a-f]{40}\b/
const RE_CHECKOUT_USES = /^\s*(?:-\s+)?uses:\s*['"]?actions\/checkout@/
const RE_WITH = /^(\s*)with:\s*$/
// persist-credentials: false — 따옴표(GH Actions 입력은 문자열) 및 후행 인라인 주석 허용.
const RE_PERSIST_FALSE = /^\s*persist-credentials:\s*['"]?false['"]?\s*(?:#.*)?$/

/**
 * release.yml 안전장치 약화 회귀 센서(#175). scanWorkflowPins(uses: SHA 핀)가 못 보는
 * 공급망급 약화를 적발한다: (a) build provenance attestation 스텝 삭제/un-pin,
 * (b) checkout 스텝의 persist-credentials:false 제거/플립.
 * 단순 텍스트 count(pc:false 수 ≥ checkout 수)는 stray/주석/중복 persist-credentials 로
 * false-GREEN 여지가 있어(Codex 리뷰·자체 적대검증), YAML 리스트 아이템(`- `)을 스텝 경계로
 * 잡아 들여쓰기로 블록을 자른 뒤, 그 블록이 checkout(uses 위치·따옴표 무관 — name-first 도)이면
 * 그 스텝의 `with:` 블록 안에서만 uncommented persist-credentials:false 를 요구한다
 * (GitHub 은 액션 입력을 steps[*].with 에서만 읽으므로 env: 등 다른 키 아래 값은 무효 — Codex PR리뷰).
 * 주석(#) 줄은 ^\s* 앵커와 RE 의 주석 허용으로 처리, 따옴표 스칼라('false'/"false")·후행 주석 허용해
 * false-RED 회피. CRLF 정규화. 권위 강제는 ci.yml skills:lint(`.github/workflows/*.yml`) 게이트.
 * @returns {{rule:string, line?:number, msg:string}[]} 위반 목록(빈 배열 = 안전)
 */
export function scanReleaseSafety(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  // (a) attestation: uncommented `uses: actions/attest-build-provenance@<40-hex SHA>` 존재(삭제·un-pin 둘 다 적발).
  if (!lines.some((l) => RE_ATTEST.test(l)))
    hits.push({
      rule: 'attestation',
      msg: 'build provenance attestation(actions/attest-build-provenance@<40-hex SHA>) 스텝 누락/un-pin — 미서명 릴리스 위험',
    })
  // (b) checkout 스텝의 자격증명 잔류 — 공유 구현에 위임(deploy.yml 핀 테스트도 같은 구현을 쓴다).
  hits.push(...scanCheckoutPersistCredentials(text))
  return hits
}

/**
 * checkout 스텝 자격증명 잔류 회귀 센서(#175 → #245 에서 공유 추출).
 * YAML 리스트 아이템(`- `)을 스텝 경계로 잡아 들여쓰기로 블록을 자른 뒤, 그 블록이 checkout 이면
 * (uses 위치·따옴표 무관 — name-first 도) 그 스텝의 `with:` 블록 안에서만 uncommented
 * persist-credentials:false 를 요구한다. GitHub 은 액션 입력을 steps[*].with 에서만 읽으므로
 * env: 등 다른 키 아래 값은 무효다 — 스텝 어디든 허용하면 자격증명이 잔류해도 통과한다(Codex PR리뷰).
 * release.yml(scanReleaseSafety)·deploy.yml(deploy-cd-pin.test.ts) 이 이 단일 구현을 공유해
 * "무엇이 안전인가"가 두 벌로 갈라지지 않게 한다.
 * @returns {{rule:string, line:number, msg:string}[]} 위반 목록(빈 배열 = 안전)
 */
export function scanCheckoutPersistCredentials(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  const indentOf = (l) => l.match(/^\s*/)[0].length
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s/)
    if (!m) continue
    const base = m[1].length // '-' 앞 들여쓰기 = 스텝 레벨
    let end = i + 1
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > base)) end++
    const block = lines.slice(i, end)
    if (!block.some((l) => RE_CHECKOUT_USES.test(l))) {
      i = end - 1
      continue
    }
    // 이 스텝의 with: 블록 안에서만 persist-credentials:false 를 인정(env: 등 다른 키 아래는 무효).
    let ok = false
    for (let k = 0; k < block.length && !ok; k++) {
      const wm = block[k].match(RE_WITH)
      if (!wm) continue
      const withIndent = wm[1].length
      for (let j = k + 1; j < block.length; j++) {
        if (block[j].trim() === '') continue
        if (indentOf(block[j]) <= withIndent) break // with 블록 종료
        if (RE_PERSIST_FALSE.test(block[j])) {
          ok = true
          break
        }
      }
    }
    if (!ok)
      hits.push({
        rule: 'persist-credentials',
        line: i + 1,
        msg: `checkout 스텝(L${i + 1})의 with: 아래 persist-credentials: false 없음 — 자격증명 잔류 위험`,
      })
    i = end - 1 // 이 블록은 통째로 소비(중첩 스텝 오탐 방지)
  }
  return hits
}

/** SKILL.md frontmatter에 name·description이 있는지 검증 */
export function validateFrontmatter(text) {
  const errors = []
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return { ok: false, errors: ['frontmatter(--- 블록) 없음'] }
  const fm = m[1]
  if (!/^name:[ \t]*\S+/m.test(fm)) errors.push('name 누락')
  if (!/^description:[ \t]*\S+/m.test(fm)) errors.push('description 누락')
  return { ok: errors.length === 0, errors }
}

// --- CLI ---
import { readFileSync, existsSync, globSync } from 'node:fs'
import { argv, exit } from 'node:process'

/**
 * 무인자 실행 시의 정규 글롭셋(#175). `npm run skills:lint` 가 단독으로 동작하도록
 * 게이트 대상 전체를 한 곳에 둔다 — CI(ci.yml)·lint-staged 가 명시 인자를 넘기면 그 경로를
 * 그대로 존중(아래 CLI 분기)하므로 lint-staged 흐름을 깨지 않는다(Codex 리뷰 #3).
 * 브레이스(`{ts,tsx}`)는 fs.globSync 에서 비신뢰 → 개별 패턴으로 나열. `src/**` 포함(#175 item5).
 */
export const DEFAULT_GLOBS = [
  '.claude/*.md',
  '.claude/agents/**/*.md',
  '.claude/hooks/*.mjs',
  '.claude/settings.json',
  '.claude/skills/**/*.md',
  '.claude/workflows/**/*.js',
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  'docs/adr/**/*.md',
  'src/**/*.ts',
  'src/**/*.tsx',
]

/** 단일 파일 검사 → 위반 메시지 배열 */
export function lintFile(path) {
  const msgs = []
  const text = readFileSync(path, 'utf8')
  for (const h of scanText(text)) msgs.push(`${path}:${h.line} 차단패턴[${h.pattern}]`)
  // .github/workflows/*.yml 은 액션 SHA 핀 강제(#137).
  if (/\.github[\\/]+workflows[\\/]/.test(path) && /\.ya?ml$/i.test(path)) {
    for (const h of scanWorkflowPins(text))
      msgs.push(`${path}:${h.line} 미핀 액션 uses:[${h.ref}] — 40자 커밋 SHA 핀 필요(#137)`)
  }
  // release.yml 은 공급망 안전장치(attestation·persist-credentials) 약화 회귀 센서(#175).
  if (/release\.ya?ml$/i.test(path)) {
    for (const h of scanReleaseSafety(text)) msgs.push(`${path} 릴리스 안전[${h.rule}]: ${h.msg}`)
  }
  if (path.endsWith('SKILL.md')) {
    const r = validateFrontmatter(text)
    if (!r.ok) for (const e of r.errors) msgs.push(`${path} frontmatter: ${e}`)
  }
  return msgs
}

// 이 파일이 직접 실행될 때만 CLI 동작 (import 시엔 동작 안 함)
if (import.meta.url === `file://${argv[1]}` || argv[1]?.endsWith('skills-lint.mjs')) {
  const args = argv.slice(2)
  // 인자 없으면 정규 글롭셋으로 자립(npm run skills:lint 단독 동작). 인자가 있으면 그대로 존중(lint-staged).
  const files =
    args.length === 0
      ? [...new Set(DEFAULT_GLOBS.flatMap((g) => globSync(g)))].filter(existsSync)
      : args.filter(existsSync)
  if (files.length === 0) {
    console.error('✗ skills:lint 입력 파일이 없습니다. 인자/글롭 설정을 확인하세요.')
    exit(2)
  }
  const all = files.flatMap(lintFile)
  if (all.length) {
    console.error('✗ skills:lint 위반:\n' + all.map((m) => '  ' + m).join('\n'))
    exit(1)
  }
  console.log(`✓ skills:lint 통과 (${files.length} 파일)`)
}
