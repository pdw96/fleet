#!/usr/bin/env node
// PreToolUse hook — 머지 전 Codex 리뷰 게이트 (ADR-0014 전제의 기계 강제).
//
// 설계 = 「우회 형태 열거」가 아니라 「허용 형태 단일화」(canonical allowlist — 레포 교훈
// "정적 가드는 이름이 아니라 형태로 막는다", Codex PR#288 1R P1 3건→2R 4건→3R 8건의 발산이
// 전환 근거). 머지 능력 신호가 보이는 Bash 명령은 정확히 한 형태만 통과한다:
//
//   gh pr merge <번호|#번호|URL> [-R owner/repo] [병합 플래그] --match-head-commit <SHA>
//
// (단일 세그먼트 전체가 이 형태여야 함). 그 외 — REST `pulls/N/merge`·GraphQL mutation·
// 서브셸/명령치환·인터프리터(sh -c 등)·cd 선행·env 리다이렉트·복합 명령 — 는 형태를 개별
// 탐지하지 않고 전부 fail-closed 차단한다(우회 형태의 전수 열거는 수렴하지 않는다).
// GitHub MCP merge_pull_request 는 구조화 입력이라 파싱 없이 검증한다.
//
// 인가 신호는 **현재 head 에 결속**된 것만 인정한다(2R P1):
//   ① head 커밋을 리뷰한 Codex 공식 리뷰(commit_id == head SHA)
//   ② head 도착 시각 이후의 Codex 👍 clean 리액션
//   ③ head 도착 시각 이후의 OWNER `[codex-gate-fallback]` 마커 코멘트(무응답 폴백 — 풀 렌즈
//      자가리뷰 완료 근거 서술 포함. env 오버라이드는 감사 불가라 두지 않는다)
// head 도착 시각 = 해당 SHA 의 check-suite 최초 생성 시각(push 시 서버 기록 — 커밋 객체의
// committer date 는 작성자 통제라 선일자 위조 가능, 3R P1). check-suite 부재 시에만 committer
// date 폴백. `--match-head-commit` 필수화로 검증 시점과 실행 시점 사이 head 이동(TOCTOU,
// 3R P1)은 GitHub 서버가 거부한다 — 차단 메시지가 복사 가능한 정확한 명령을 제공한다.
//
// reviews/reactions/comments 조회는 --paginate 필수 — 페이지네이션 누락으로 리뷰 3건을 못 본
// 실사고가 게이트 신설의 직접 배경이다. 조회 실패는 fail-closed(차단)한다.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]'
export const FALLBACK_MARKER = '[codex-gate-fallback]'

// ── 머지 능력 신호(raw 문자열 스캔) ──────────────────────────────────────────
// 게이트 발동 조건: `merge` + (gh 실행 파일 | github.com | graphql). 인용·치환·래퍼 안에
// 숨어도 raw 스캔에는 보이므로 미탐 방향의 우회가 없다. 대가는 오탐(머지 문구를 인용만 하는
// 명령 — PR 본문 등)이며, 그쪽은 fail-closed 후 안내(--body-file 등)로 흡수한다.
export function hasMergeSignal(cmd) {
  return (
    /merge/i.test(cmd) &&
    (/(^|[^\p{L}\d])gh(\.exe)?([^\p{L}\d]|$)/iu.test(cmd) || /github\.com|graphql/i.test(cmd))
  )
}

// ── 따옴표 인지 토크나이저 ────────────────────────────────────────────────────
// 셸 시맨틱의 근사: '…'/"…" 는 한 토큰으로 접고, \ 는 다음 문자를 리터럴로. 연산자·개행·
// 그룹핑(`(` `)` 백틱)은 세그먼트 경계다. canonical 판정은 「세그먼트가 정확히 1개」를
// 요구하므로 근사 오차는 전부 차단(비-canonical) 쪽으로 넘어진다.
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
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      endSegment()
    } else {
      cur += ch
      inToken = true
    }
  }
  endSegment()
  return segments
}

// gh pr merge 의 인자 문법(https://cli.github.com/manual/gh_pr_merge).
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
 * 명령 전체가 canonical 머지 형태인지 판정한다. canonical = 단일 세그먼트이고, 그 세그먼트가
 * `gh pr merge` + 알려진 플래그·타깃만으로 구성. 하나라도 벗어나면 null(= 차단 대상).
 * @returns {{pr:number|null, repo:string|null, target:string|null, matchHead:string|null}|null}
 *  pr/target — 번호(URL 포함)·비번호 타깃(브랜치명 등, gh pr view 로 해석).
 *  matchHead — `--match-head-commit` 값(필수 검증은 main 에서).
 */
export function parseCanonicalMerge(cmd) {
  // 그룹핑 문자가 하나라도 있으면 비-canonical — 서브셸 `(…)`은 토큰화 후 단일 세그먼트로
  // 접혀 canonical 과 구분이 안 되므로, 문자 존재 자체를 배제 조건으로 둔다(엄격한 쪽).
  if (/[()`]/.test(cmd)) return null
  const segments = tokenizeSegments(cmd)
  if (segments.length !== 1) return null
  const tokens = segments[0]
  // 실행 파일 = gh(경로·.exe·대소문자 표기 무관 — win32/Git Bash, 3R P1)
  const exe = tokens[0]?.split(/[\\/]/).pop()?.toLowerCase()
  if (exe !== 'gh' && exe !== 'gh.exe') return null
  let i = 1
  let repo = null
  // 전역 -R/--repo 만 허용(그 외 선행 플래그 = 비-canonical)
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const [flag, inline] = splitFlag(tokens[i])
    if (flag !== '-R' && flag !== '--repo') return null
    repo = inline ?? tokens[++i] ?? null
    i++
  }
  if (tokens[i] !== 'pr' || tokens[i + 1] !== 'merge') return null
  i += 2
  let pr = null
  let target = null
  let matchHead = null
  for (; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-')) {
      const [flag, inline] = splitFlag(tok)
      if (MERGE_VALUE_FLAGS.has(flag)) {
        const value = inline ?? tokens[++i] ?? null
        if (flag === '-R' || flag === '--repo') repo = value
        if (flag === '--match-head-commit') matchHead = value
      } else if (!MERGE_BOOL_FLAGS.has(flag)) {
        return null
      }
    } else if (pr == null && target == null) {
      const num = tok.match(/^#?(\d+)$/)
      const url = tok.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/)
      if (num) pr = Number(num[1])
      else if (url) {
        repo = url[1]
        pr = Number(url[2])
      } else if (/[$]/.test(tok))
        return null // 셸 확장 잔존 타깃은 해석 불가
      else target = tok
    } else {
      return null
    }
  }
  return { pr, repo, target, matchHead }
}

function splitFlag(tok) {
  const eq = tok.indexOf('=')
  return eq === -1 ? [tok, null] : [tok.slice(0, eq), tok.slice(eq + 1)]
}

/**
 * hook 입력을 게이트 판정으로 환원한다.
 * @returns {{kind:'pass'}|{kind:'blocked', reason:string}
 *          |{kind:'merge', pr:number|null, repo:string|null, target:string|null,
 *            matchHead:string|null, viaMcp:boolean}}
 */
export function classifyHookInput(input) {
  const toolName = String(input.tool_name ?? '')
  if (/merge_pull_request/.test(toolName)) {
    const ti = input.tool_input ?? {}
    const pr = ti.pull_number ?? ti.pullNumber ?? null
    if (pr == null) return { kind: 'blocked', reason: 'MCP 입력에 pull_number 없음' }
    const repo = ti.owner && ti.repo ? `${ti.owner}/${ti.repo}` : null
    return { kind: 'merge', pr, repo, target: null, matchHead: ti.sha ?? null, viaMcp: true }
  }
  if (toolName !== 'Bash') return { kind: 'pass' }
  const cmd = String(input.tool_input?.command ?? '')
  if (!hasMergeSignal(cmd)) return { kind: 'pass' }
  const canonical = parseCanonicalMerge(cmd)
  if (canonical == null)
    return { kind: 'blocked', reason: '머지 능력 신호가 있으나 canonical 형태가 아님' }
  return { ...canonical, kind: 'merge', viaMcp: false }
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
  const verdict = classifyHookInput(input)
  if (verdict.kind === 'pass') process.exit(0)
  if (verdict.kind === 'blocked') {
    console.error(
      `[codex-gate] 차단(${verdict.reason}). 머지는 canonical 형태만 허용된다:\n` +
        '  gh pr merge <번호> [-R owner/repo] [--squash 등] --match-head-commit <head SHA>\n' +
        '(REST/GraphQL/복합 명령/서브셸 경유 머지는 전부 차단 — 머지 문구를 본문 인용만 하는 ' +
        '거면 --body-file 로 우회하라.)',
    )
    process.exit(2)
  }

  const gh = (args, allowFail = false) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', cwd, timeout: 45_000 })
    if (r.error || r.status !== 0) {
      if (allowFail) return null
      const detail = (r.stderr || r.error?.message || '').trim().slice(0, 300)
      console.error(`[codex-gate] gh 조회 실패 — fail-closed 차단. ${detail}`)
      process.exit(2)
    }
    return r.stdout
  }

  // 실행 환경의 GH_REPO/GH_HOST 는 대상 레포·호스트를 조용히 바꾼다 — -R 명시 없으면 차단.
  if (!verdict.repo && (process.env.GH_REPO || process.env.GH_HOST)) {
    console.error('[codex-gate] GH_REPO/GH_HOST 환경변수 감지 — -R owner/repo 명시가 필요하다.')
    process.exit(2)
  }

  let { pr, repo, target } = verdict
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
  const headSha = validatePr(gh, base, pr)

  // TOCTOU 봉쇄: 검증한 head 를 GitHub 서버가 병합 조건으로 강제하게 한다(3R P1).
  // MCP 는 구조화 단일 호출이라 sha 미지정을 허용한다(있으면 동일 검증).
  if (verdict.matchHead == null && !verdict.viaMcp) {
    console.error(
      `[codex-gate] PR #${pr} 검증 통과 — 단, 검증 시점의 head 를 서버가 강제하도록 ` +
        '--match-head-commit 이 필수다. 이대로 재시도하라:\n' +
        `  gh pr merge ${pr}${repo ? ` -R ${repo}` : ''} --squash --match-head-commit ${headSha}`,
    )
    process.exit(2)
  }
  if (verdict.matchHead != null && verdict.matchHead.toLowerCase() !== headSha.toLowerCase()) {
    console.error(
      `[codex-gate] --match-head-commit(${verdict.matchHead.slice(0, 7)})이 검증된 현재 ` +
        `head(${headSha.slice(0, 7)})와 다르다 — head 가 이동했으니 재검증 후 재시도하라.`,
    )
    process.exit(2)
  }
  process.exit(0)
}

/**
 * 한 PR 의 Codex 신호를 **현재 head 에 결속해** 검증한다. 통과하면 head SHA 를 반환하고,
 * 못 하면 exit 2. 인정 신호: ① head 를 리뷰한 공식 리뷰(commit_id == head) ② head 도착
 * 이후 👍 ③ head 도착 이후 OWNER 폴백 마커. head 도착 시각 = check-suite 최초 생성(서버
 * 기록·push 시각) → 부재 시 committer date 폴백(작성자 통제 시각이라 차선임을 명시).
 */
function validatePr(gh, base, pr) {
  const headSha = gh(['api', `${base}/pulls/${pr}`, '--jq', '.head.sha']).trim()
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    console.error(`[codex-gate] PR #${pr} head SHA 해석 실패 — fail-closed 차단.`)
    process.exit(2)
  }

  const reviewedShas = gh([
    'api',
    `${base}/pulls/${pr}/reviews`,
    '--paginate',
    '--jq',
    `.[] | select(.user.login == "${CODEX_LOGIN}") | .commit_id`,
  ])
  if (reviewedShas.split('\n').some((s) => s.trim() === headSha)) return headSha

  const headTime = headArrivalTime(gh, base, headSha)

  // 👍 리액션은 commit 결속이 없어 head 도착 시각으로 결속한다(ISO-8601 Z 는 사전순 비교 가능).
  const thumbTimes = gh([
    'api',
    `${base}/issues/${pr}/reactions`,
    '--paginate',
    '--jq',
    `.[] | select(.content == "+1" and .user.login == "${CODEX_LOGIN}") | .created_at`,
  ])
  if (thumbTimes.split('\n').some((t) => t.trim() && t.trim() >= headTime)) return headSha

  // 무응답 폴백 — head 도착 이후 OWNER 가 남긴 감사 마커 코멘트만 인정.
  const fallbackTimes = gh([
    'api',
    `${base}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `.[] | select(.author_association == "OWNER" and (.body | contains("${FALLBACK_MARKER}"))) | .created_at`,
  ])
  if (fallbackTimes.split('\n').some((t) => t.trim() && t.trim() >= headTime)) {
    console.error(
      `[codex-gate] PR #${pr}: Codex 리뷰 부재이나 head 이후 OWNER 의 ${FALLBACK_MARKER} 마커 ` +
        '확인 — 풀 렌즈 자가리뷰 폴백으로 허용(AGENTS.md 4단계).',
    )
    return headSha
  }

  console.error(
    `[codex-gate] PR #${pr} 의 현재 head(${headSha.slice(0, 7)})에 결속된 Codex 신호가 없다 — ` +
      '머지 차단(ADR-0014 전제). 낡은 라운드의 리뷰·👍 는 새 커밋을 인가하지 않는다. ' +
      '`@codex review` 로 재트리거 후 대기하라(보통 7~20분). 무응답 fallback 머지는 P1 신호 렌즈를 ' +
      `포함한 풀 렌즈 자가리뷰 완료 후, 그 근거를 담은 OWNER 코멘트에 ${FALLBACK_MARKER} 마커를 ` +
      'head 커밋 이후 남기는 것이 조건이다(감사 가능 경로).',
  )
  process.exit(2)
}

/** head SHA 의 도착 시각 — check-suite 최초 생성(서버 기록) 우선, 부재 시 committer date. */
function headArrivalTime(gh, base, headSha) {
  const suites = gh(
    [
      'api',
      `${base}/commits/${headSha}/check-suites`,
      '--jq',
      '[.check_suites[].created_at] | sort | .[0] // empty',
    ],
    true,
  )
  const first = suites?.trim()
  if (first && /^\d{4}-\d{2}-\d{2}T/.test(first)) return first
  const committed = gh([
    'api',
    `${base}/commits/${headSha}`,
    '--jq',
    '.commit.committer.date',
  ]).trim()
  if (!/^\d{4}-\d{2}-\d{2}T/.test(committed)) {
    console.error('[codex-gate] head 도착 시각 해석 실패 — fail-closed 차단.')
    process.exit(2)
  }
  return committed
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('require-codex-review.mjs')
) {
  main()
}
