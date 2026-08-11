#!/usr/bin/env node
// PreToolUse hook — 머지 전 Codex 리뷰 게이트 (ADR-0014 전제의 기계 강제).
//
// 머지 시도(Bash `gh pr merge`·`…/pulls/N/merge` API·GitHub MCP merge_pull_request)를
// 가로채, Codex 봇의 공식 리뷰(pulls/N/reviews) 또는 👍 clean 리액션(issues/N/reactions)
// 이 없으면 exit 2 로 차단한다. 완료 정의 = 「리뷰 또는 👍」(AGENTS.md 4단계 · ADR-0014).
// reviews/reactions 조회는 --paginate 필수 — 페이지네이션 누락으로 리뷰 3건을 못 본
// 실사고가 게이트 신설의 직접 배경이다. 조회 실패는 fail-closed(차단)한다.
//
// 파싱은 위치 정규식이 아니라 토큰 단위 인자 해석이다(Codex PR#288 P1①) — 플래그가
// 타깃 앞에 와도(`gh pr merge --squash 222`) 번호를 정확히 잡고, `-R owner/repo` 전역
// 플래그·URL·브랜치 타깃도 해석한다. 해석이 불확실하면(미지 플래그 등) fail-closed.
// 따옴표 인지 토크나이저라 인용 문자열 안의 머지 명령 문구(PR 본문 등)는 오탐하지 않는다.
//
// Codex 무응답 폴백(Codex PR#288 P1③): AGENTS.md 가 문서화한 「풀 렌즈 자가리뷰 선행
// fallback 머지」는 해당 PR 에 레포 OWNER 가 남긴 감사 가능한 마커 코멘트
// `[codex-gate-fallback]`(자가리뷰 완료 근거 서술 포함)로만 인정한다 — env 오버라이드는
// 감사 불가라 두지 않는다.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]'
export const FALLBACK_MARKER = '[codex-gate-fallback]'

// ── 따옴표 인지 토크나이저 ────────────────────────────────────────────────────
// 셸 시맨틱의 근사: '…'/"…" 는 한 토큰으로 접고, \ 는 다음 문자를 리터럴로. 연산자
// (&& || ; | 개행)는 세그먼트 경계다. 근사가 실패하는 입력(비닫힘 따옴표 등)은 남은
// 전체를 한 토큰으로 접어 — 토큰이 이상해지면 미지 플래그/타깃 판정에서 fail-closed 로
// 흐르므로 우회가 아니라 차단 쪽으로 넘어진다.
export function tokenizeSegments(cmd) {
  const segments = []
  let tokens = []
  let cur = ''
  let inToken = false
  const push = () => {
    if (inToken) tokens.push(cur)
    cur = ''
    inToken = false
  }
  const endSegment = () => {
    push()
    if (tokens.length) segments.push(tokens)
    tokens = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') {
      cur += cmd[i + 1] ?? ''
      inToken = true
      i++
    } else if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, i + 1)
      if (close === -1) {
        cur += cmd.slice(i + 1)
        inToken = true
        i = cmd.length
      } else {
        cur += cmd.slice(i + 1, close)
        inToken = true
        i = close
      }
    } else if (/\s/.test(ch)) {
      if (ch === '\n') endSegment()
      else push()
    } else if (ch === ';' || ch === '|' || ch === '&') {
      endSegment()
    } else {
      cur += ch
      inToken = true
    }
  }
  endSegment()
  return segments
}

// gh pr merge 의 인자 문법(https://cli.github.com/manual/gh_pr_merge): 값을 갖는 플래그를
// 열거해 그 값이 타깃으로 오인되지 않게 한다. 여기 없는 미지 플래그는 값 유무를 알 수
// 없으므로 ambiguous → fail-closed.
const MERGE_VALUE_FLAGS = new Set([
  '-R',
  '--repo',
  '-t',
  '--subject',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-A',
  '--author-email',
  '--match-head-commit',
])
const MERGE_BOOL_FLAGS = new Set([
  '--admin',
  '--auto',
  '--disable-auto',
  '-d',
  '--delete-branch',
  '-m',
  '--merge',
  '-s',
  '--squash',
  '-r',
  '--rebase',
])

/**
 * Bash 명령 문자열에서 `gh pr merge` 시도를 인자 해석으로 판별한다.
 * @returns {{isMerge:boolean, pr:number|null, repo:string|null, target:string|null,
 *            ambiguous:string|null}}
 *  pr — 명령이 지정한 PR 번호(URL 포함). target — 번호가 아닌 타깃(브랜치명 등, gh pr view 로
 *  해석할 것). repo — `-R/--repo` 또는 URL 이 지정한 `owner/repo`. ambiguous — 해석 불능
 *  사유(널 아니면 fail-closed 대상).
 */
export function parseGhMerge(cmd) {
  const none = { isMerge: false, pr: null, repo: null, target: null, ambiguous: null }
  for (const tokens of tokenizeSegments(cmd)) {
    for (let g = 0; g < tokens.length; g++) {
      if (tokens[g] !== 'gh' && !/[\\/]gh(\.exe)?$/i.test(tokens[g])) continue
      let i = g + 1
      let repo = null
      let ambiguous = null
      // 전역 플래그(-R/--repo 만 값 보유로 인지, 그 외 `-…`는 미지 → ambiguous)
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const [flag, inline] = splitFlag(tokens[i])
        if (flag === '-R' || flag === '--repo') {
          repo = inline ?? tokens[++i] ?? null
        } else {
          ambiguous = `미지 전역 플래그 ${flag}`
        }
        i++
      }
      // gh(cobra)는 서브커맨드 사이 플래그 삽입을 허용한다: `gh pr -R o/r merge 5`.
      if (tokens[i] !== 'pr') continue
      i++
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const [flag, inline] = splitFlag(tokens[i])
        if (flag === '-R' || flag === '--repo') repo = inline ?? tokens[++i] ?? null
        else ambiguous = `미지 플래그 ${flag}`
        i++
      }
      if (tokens[i] !== 'merge') continue
      if (ambiguous) return { isMerge: true, pr: null, repo, target: null, ambiguous }
      i++
      let pr = null
      let target = null
      for (; i < tokens.length; i++) {
        const tok = tokens[i]
        if (tok.startsWith('-')) {
          const [flag, inline] = splitFlag(tok)
          if (MERGE_VALUE_FLAGS.has(flag)) {
            const value = inline ?? tokens[++i] ?? null
            if (flag === '-R' || flag === '--repo') repo = value
          } else if (!MERGE_BOOL_FLAGS.has(flag)) {
            return { isMerge: true, pr: null, repo, target: null, ambiguous: `미지 플래그 ${flag}` }
          }
        } else if (pr == null && target == null) {
          const num = tok.match(/^#?(\d+)$/)
          const url = tok.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/)
          if (num) pr = Number(num[1])
          else if (url) {
            repo = url[1]
            pr = Number(url[2])
          } else target = tok
        } else {
          return { isMerge: true, pr: null, repo, target: null, ambiguous: `잉여 인자 ${tok}` }
        }
      }
      return { isMerge: true, pr, repo, target, ambiguous: null }
    }
    // 2차 느슨 센서 — 구조 파싱이 못 읽은 형태(미지 전역 플래그의 값이 서브커맨드를 가리는
    // 경우 등)로 같은 세그먼트에 gh …
    // pr … merge 토큰이 순서대로 존재하면 미탐(우회) 대신 ambiguous 로 fail-closed 한다.
    // 인용 문자열은 한 토큰으로 접혀 있어(PR 본문 인용 등) 이 센서에 걸리지 않는다.
    const gi = tokens.findIndex((t) => t === 'gh' || /[\\/]gh(\.exe)?$/i.test(t))
    if (gi !== -1) {
      const pi = tokens.indexOf('pr', gi + 1)
      if (pi !== -1 && tokens.indexOf('merge', pi + 1) !== -1)
        return {
          isMerge: true,
          pr: null,
          repo: null,
          target: null,
          ambiguous: '비정형 gh pr merge 형태',
        }
    }
  }
  return none
}

function splitFlag(tok) {
  const eq = tok.indexOf('=')
  return eq === -1 ? [tok, null] : [tok.slice(0, eq), tok.slice(eq + 1)]
}

/**
 * hook 입력 전체(tool_name·tool_input)에서 머지 시도를 판별한다.
 * Bash 는 `gh pr merge` CLI 와 REST `…/pulls/N/merge` 호출 둘 다 본다.
 */
export function parseHookInput(input) {
  const toolName = String(input.tool_name ?? '')
  if (/merge_pull_request/.test(toolName)) {
    const ti = input.tool_input ?? {}
    const pr = ti.pull_number ?? ti.pullNumber ?? null
    const repo = ti.owner && ti.repo ? `${ti.owner}/${ti.repo}` : null
    return {
      isMerge: true,
      pr,
      repo,
      target: null,
      ambiguous: pr == null ? 'MCP 입력에 pull_number 없음' : null,
    }
  }
  if (toolName !== 'Bash')
    return { isMerge: false, pr: null, repo: null, target: null, ambiguous: null }
  const cmd = String(input.tool_input?.command ?? '')
  const api = cmd.match(
    /repos\/(?:\{owner\}\/\{repo\}|([^/\s{}]+\/[^/\s{}]+))\/pulls\/(\d+)\/merge\b/,
  )
  if (api)
    return {
      isMerge: true,
      pr: Number(api[2]),
      repo: api[1] ?? null,
      target: null,
      ambiguous: null,
    }
  return parseGhMerge(cmd)
}

// ── main (직접 실행 시에만 — 테스트 import 시 stdin 을 읽지 않는다) ───────────
function main() {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.exit(0) // 입력이 hook 계약과 다르면 판단 불가 — 게이트 대상 아님
  }

  const cwd = input.cwd || process.cwd()
  const parsed = parseHookInput(input)
  if (!parsed.isMerge) process.exit(0)
  if (parsed.ambiguous) {
    console.error(
      `[codex-gate] 머지 명령 해석 불확실(${parsed.ambiguous}) — fail-closed 차단. ` +
        '명시적 PR 번호로 다시 시도하라(예: gh pr merge <번호> --squash).',
    )
    process.exit(2)
  }

  const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', cwd, timeout: 45_000 })
    if (r.error || r.status !== 0) {
      const detail = (r.stderr || r.error?.message || '').trim().slice(0, 300)
      console.error(`[codex-gate] gh 조회 실패 — fail-closed 차단. ${detail}`)
      process.exit(2)
    }
    return r.stdout
  }

  let { pr, repo, target } = parsed
  // 번호가 없으면(현재 브랜치·브랜치명 타깃) gh 로 해석 — repo 지정도 함께 존중한다.
  if (pr == null) {
    const args = ['pr', 'view']
    if (target) args.push(target)
    if (repo) args.push('-R', repo)
    args.push('--json', 'number', '--jq', '.number')
    const out = gh(args).trim()
    if (!/^\d+$/.test(out)) {
      console.error('[codex-gate] PR 번호를 해석할 수 없어 fail-closed 차단.')
      process.exit(2)
    }
    pr = Number(out)
  }

  const base = repo ? `repos/${repo}` : 'repos/{owner}/{repo}'
  const reviewers = gh([
    'api',
    `${base}/pulls/${pr}/reviews`,
    '--paginate',
    '--jq',
    '.[].user.login',
  ])
  const thumbs = gh([
    'api',
    `${base}/issues/${pr}/reactions`,
    '--paginate',
    '--jq',
    '.[] | select(.content == "+1") | .user.login',
  ])
  const seen = new Set([...reviewers.split('\n'), ...thumbs.split('\n')].map((s) => s.trim()))
  if (seen.has(CODEX_LOGIN)) process.exit(0)

  // 무응답 폴백 — 해당 PR 에 OWNER 가 남긴 감사 마커 코멘트만 인정(감사 흔적이 PR 에 남는다).
  const fallback = gh([
    'api',
    `${base}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `.[] | select(.author_association == "OWNER") | .body`,
  ])
  if (fallback.includes(FALLBACK_MARKER)) {
    console.error(
      `[codex-gate] PR #${pr}: Codex 리뷰 부재이나 OWNER 의 ${FALLBACK_MARKER} 마커 확인 — ` +
        '풀 렌즈 자가리뷰 폴백으로 허용(AGENTS.md 4단계).',
    )
    process.exit(0)
  }

  console.error(
    `[codex-gate] PR #${pr} 에 Codex 리뷰·👍 clean 이 아직 없다 — 머지 차단(ADR-0014 전제). ` +
      '`@codex review` 로 트리거 후 대기하라(보통 7~20분). 무응답 fallback 머지는 P1 신호 렌즈를 ' +
      `포함한 풀 렌즈 자가리뷰 완료 후, 그 근거를 담은 OWNER 코멘트에 ${FALLBACK_MARKER} 마커를 ` +
      '남기는 것이 조건이다(감사 가능 경로).',
  )
  process.exit(2)
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('require-codex-review.mjs')
) {
  main()
}
