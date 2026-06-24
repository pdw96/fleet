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

/** SKILL.md frontmatter에 name·description이 있는지 검증 */
export function validateFrontmatter(text) {
  const errors = []
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
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
  if (path.endsWith('SKILL.md')) {
    const r = validateFrontmatter(text)
    if (!r.ok) for (const e of r.errors) msgs.push(`${path} frontmatter: ${e}`)
  }
  return msgs
}

// 이 파일이 직접 실행될 때만 CLI 동작 (import 시엔 동작 안 함)
if (import.meta.url === `file://${argv[1]}` || argv[1]?.endsWith('skills-lint.mjs')) {
  const files = argv.slice(2).filter(existsSync)
  const all = files.flatMap(lintFile)
  if (all.length) {
    console.error('✗ skills:lint 위반:\n' + all.map((m) => '  ' + m).join('\n'))
    exit(1)
  }
  console.log(`✓ skills:lint 통과 (${files.length} 파일)`)
}
