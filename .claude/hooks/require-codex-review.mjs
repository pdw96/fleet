#!/usr/bin/env node
// PreToolUse hook — 머지 전 Codex 리뷰 게이트 (ADR-0014 전제의 기계 강제).
//
// 머지 시도(Bash `gh pr merge`·`…/pulls/N/merge` API·GitHub MCP merge_pull_request)를
// 가로채, Codex 봇의 공식 리뷰(pulls/N/reviews) 또는 👍 clean 리액션(issues/N/reactions)
// 이 없으면 exit 2 로 차단한다. 완료 정의 = 「리뷰 또는 👍」(AGENTS.md 4단계 · ADR-0014).
// reviews/reactions 조회는 --paginate 필수 — 페이지네이션 누락으로 리뷰 3건을 못 본
// 실사고가 게이트 신설의 직접 배경이다. 조회 실패는 fail-closed(차단)한다.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]'

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0) // 입력이 hook 계약과 다르면 판단 불가 — 게이트 대상 아님
}

const toolName = String(input.tool_name ?? '')
const cwd = input.cwd || process.cwd()

// ── 머지 시도인지 판별 + PR 번호 추출 ─────────────────────────────────────────
let isMerge = false
let pr = null

if (/merge_pull_request/.test(toolName)) {
  isMerge = true
  const ti = input.tool_input ?? {}
  pr = ti.pull_number ?? ti.pullNumber ?? null
} else if (toolName === 'Bash') {
  const cmd = String(input.tool_input?.command ?? '')
  const cli = cmd.match(/\bgh\s+pr\s+merge\b(?:\s+(?:"?#?(\d+)"?|\S+))?/)
  const api = cmd.match(/\/pulls\/(\d+)\/merge\b/)
  if (cli) {
    isMerge = true
    pr = cli[1] ? Number(cli[1]) : null
  } else if (api) {
    isMerge = true
    pr = Number(api[1])
  }
}

if (!isMerge) process.exit(0)

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd, timeout: 45_000 })
  if (r.error || r.status !== 0) {
    const detail = (r.stderr || r.error?.message || '').trim().slice(0, 300)
    console.error(`[codex-gate] gh 조회 실패 — fail-closed 차단. ${detail}`)
    process.exit(2)
  }
  return r.stdout
}

// PR 번호가 명령에 없으면(현재 브랜치 머지) gh 로 해석
if (pr == null) {
  const out = gh(['pr', 'view', '--json', 'number', '--jq', '.number']).trim()
  if (!/^\d+$/.test(out)) {
    console.error('[codex-gate] PR 번호를 해석할 수 없어 fail-closed 차단.')
    process.exit(2)
  }
  pr = Number(out)
}

const reviewers = gh([
  'api',
  `repos/{owner}/{repo}/pulls/${pr}/reviews`,
  '--paginate',
  '--jq',
  '.[].user.login',
])
const thumbs = gh([
  'api',
  `repos/{owner}/{repo}/issues/${pr}/reactions`,
  '--paginate',
  '--jq',
  '.[] | select(.content == "+1") | .user.login',
])

const seen = new Set([...reviewers.split('\n'), ...thumbs.split('\n')].map((s) => s.trim()))
if (seen.has(CODEX_LOGIN)) process.exit(0)

console.error(
  `[codex-gate] PR #${pr} 에 Codex 리뷰·👍 clean 이 아직 없다 — 머지 차단(ADR-0014 전제). ` +
    '`@codex review` 로 트리거 후 대기하라(보통 7~20분). 무응답 fallback 머지는 ' +
    'P1 신호 렌즈를 포함한 풀 렌즈 자가리뷰 선행이 조건이다.',
)
process.exit(2)
