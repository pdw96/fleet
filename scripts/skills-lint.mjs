// scripts/skills-lint.mjs
// .claude/skills·.claude/workflows·.github/workflows 추적 자산의 경로·시크릿 누출과
// SKILL.md frontmatter 규약을 검사하는 강제 게이트(스펙 §8). fail-on-match.

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
 * 한계: YAML 플로우-스타일 스텝(`- {uses: x@v1}`)은 미지원 — 레포의 전 워크플로가 블록 스타일이고
 * guardian.yml 의 구조 매칭(`pattern: uses: $REF`)이 그 형태를 보강한다. CRLF 도 정규화(\r?\n).
 * @returns {{line:number, ref:string}[]} 위반 줄(ref = 미핀 `owner/repo@ref` 값)
 */
export function scanWorkflowPins(text) {
  const hits = []
  text.split(/\r?\n/).forEach((content, i) => {
    // YAML 키로서의 uses: 만(스텝 `- uses:` / 잡-레벨 `uses:`). 주석(#…)·run 본문은 ^ 앵커로 제외.
    const m = content.match(/^\s*(?:-\s+)?uses:\s*(\S.*)$/)
    if (!m) return
    // 인라인 주석(' #…')·감싼 따옴표 제거해 순수 ref 값 추출.
    const value = m[1]
      .replace(/\s+#.*$/, '')
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
import { readFileSync, existsSync } from 'node:fs'
import { argv, exit } from 'node:process'

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
  if (path.endsWith('SKILL.md')) {
    const r = validateFrontmatter(text)
    if (!r.ok) for (const e of r.errors) msgs.push(`${path} frontmatter: ${e}`)
  }
  return msgs
}

// 이 파일이 직접 실행될 때만 CLI 동작 (import 시엔 동작 안 함)
if (import.meta.url === `file://${argv[1]}` || argv[1]?.endsWith('skills-lint.mjs')) {
  const files = argv.slice(2).filter(existsSync)
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
