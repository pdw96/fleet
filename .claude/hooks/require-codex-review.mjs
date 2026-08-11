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
//   ② head 도착 이후의 OWNER `@codex review` 재트리거보다 늦은 Codex 👍 clean 리액션
//      (시각 단독 결속은 「A 리뷰 중 B push → A 의 늦은 👍」를 오인가한다 — 27R P1)
//   ③ OWNER 의 head-결속 폴백 마커 `[codex-gate-fallback] head=<현재 head SHA>` 코멘트
//      (무응답 폴백 — 풀 렌즈 자가리뷰 완료 근거 서술 동반. SHA 를 손으로 적는 형식이라
//      단순 언급·질문과 구조적으로 갈리고, head 가 바뀌면 자동 실효. env 오버라이드는
//      감사 불가라 두지 않는다)
// head 도착 시각 = 해당 SHA 의 check-suite 최초 생성 시각(push 시 서버 기록 — 커밋 객체의
// committer date 는 작성자 통제라 선일자 위조 가능, 3R P1). check-suite 부재 시에만 committer
// date 폴백. `--match-head-commit` 필수화로 검증 시점과 실행 시점 사이 head 이동(TOCTOU,
// 3R P1)은 GitHub 서버가 거부한다 — 차단 메시지가 복사 가능한 정확한 명령을 제공한다.
//
// reviews/reactions/comments 조회는 --paginate 필수 — 페이지네이션 누락으로 리뷰 3건을 못 본
// 실사고가 게이트 신설의 직접 배경이다. 조회 실패는 fail-closed(차단)한다.
//
// §위협 모델(4R 확정): 이 게이트는 **에이전트 세션의 사고성 미리뷰 머지 방지 장치**다.
// 로컬 쓰기 권한을 가진 적대 행위자는 settings.json/hook 파일 자체를 고칠 수 있으므로
// 적대 방어는 원리적으로 이 층의 비목표다(PR1a 11R 「사고성 방지·악성 방어는 경계 소관」과
// 동형). 다만 수정 비용이 낮은 적대형 구멍(분절 표기·경로 실행 파일·force-push 재결속)은
// 방어 심도로 함께 닫는다. 잔여 한계(일반 push 로 기존 커밋을 head 에 앉히는 시각 우회)는
// 이 범위에서 수용 — SHA-결속 신호(공식 리뷰 commit_id)가 항상 우선 경로다.
// 잔여 한계(24R): 검증과 실행 사이의 base 변경(head 불변)은 이 층에서 닫을 수 없다 —
// gh pr merge 의 서버측 조건은 head(--match-head-commit)뿐이고 base 를 고정하는 플랫폼
// 프리미티브가 없다. 단일 운영자 레포에서 base 변경은 OWNER 의 의도적 행위이므로 사고성
// 위협 모델 밖으로 수용한다(base 변경 후에는 base_ref_changed 재결속이 새 신호를 요구).
// 관할 경계(18R 확정): 게이트는 **명령 문자열에 보이는 병합 능력**만 관할한다. 파일/프로그램
// 경유 실행(`bash script.sh`·`npm run`·`node x.js` 등)의 내용 검사는 비목표 — 파일은 hook
// 과 실행 사이에 바뀔 수 있어 검사가 증명이 못 되고(TOCTOU), 실행의 이행 폐포 게이트는
// 수렴하지 않으며, 병합을 파일에 숨기는 것은 로컬 쓰기 권한자 시나리오(위 비목표)와 동치다.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]'
export const FALLBACK_MARKER = '[codex-gate-fallback]'

// 폴백 마커 코멘트가 근거를 담는가 — 마커 토큰으로 **시작**하고 그 뒤에 비공백 실증 텍스트가
// 있어야 인가한다(40R P1: 마커만 있고 근거 서술이 전혀 없는 코멘트가 startswith 만으로
// 통과해 유일한 감사 근거가 사라지던 결함). 무응답 폴백 경로의 감사성 요건.
export function fallbackMarkerHasEvidence(body, token) {
  return typeof body === 'string' && body.startsWith(token) && /\S/.test(body.slice(token.length))
}

// ── 머지 능력 신호(raw 문자열 스캔) ──────────────────────────────────────────
// 게이트 발동 조건: `merge` + (gh 실행 파일 | github.com | graphql). 인용·치환·래퍼 안에
// 숨어도 raw 스캔에는 보이므로 미탐 방향의 우회가 없다. 셸이 인접 인용 조각을 연결하는
// 분절 표기(`g''h`, 4R P1)에 대비해 따옴표 제거본도 함께 스캔한다. 대가는 오탐(머지 문구를
// 인용만 하는 명령 — PR 본문 등)이며, 그쪽은 fail-closed 후 안내(--body-file 등)로 흡수한다.
/**
 * 스캔용 정규화 변형들 — 셸이 조각을 이어 실행하는 분절·인코딩 표기를 원문과 병행 검사한다:
 * 연속행 쌍 제거(8R) → ANSI-C `\xHH`/`\uHHHH`/8진 이스케이프 디코드(16R: `$'\x67\x68'` 가
 * gh 로 확장) → `${VAR}` 통째 제거(15R) → 따옴표·백슬래시·`$` 제거(g''h·g\h — 4R·5R,
 * `g$'h'` — 9R) → 퍼센트 디코드(REST `m%65rge` — 14R, 서버가 1회 디코드하므로 1회면 충분).
 */
/**
 * 셸 확장·분절 표기를 걷어낸 형태(스캔용) — 연속행 쌍, ANSI-C 이스케이프(\xHH·\uHHHH·8진),
 * 위치/특수 매개변수(`$@`·`$*`·`$1`… — 17R: `g$@h` 는 `$` 만 지우면 `g@h` 로 남아 미탐),
 * `${VAR}`, 따옴표·백슬래시·`$` 를 제거한다. alias 확장의 이행 대조(17R)도 이 형태를 쓴다.
 */
export function stripShellExpansions(s) {
  return s
    .replace(/\\\r?\n/g, '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => {
      // 범위 밖 코드포인트는 fromCodePoint 가 throw — 크래시(exit 1)는 차단(exit 2)이
      // 아니라 우회가 된다(20R P1). 유효 범위만 디코드, 그 외는 제거.
      const cp = parseInt(h, 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/\{(.)(?:\.\.\1)?\}/g, '$1') // 단일문자 brace(`g{h..h}`·`g{h}`) 접기(20R P1)
    .replace(/\[(.)(?:-\1)?\]/g, '$1') // 단일문자 글롭 클래스(`m[e]rge`·`m[e-e]rge`) 접기(23R P1)
    .replace(/[?*+@!]\((.)\)/g, '$1') // 단일문자 extglob(`m@(e)rge` 등 5형) 접기(31R P1)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{1,3})(?![0-9])/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\$[@*#?!0-9-]/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/['"\\$]/g, '')
}

// 다문자 brace 확장(33R P1: `m{erg,x}e` — 단일문자 접기만으론 미탐)과 다문자 extglob
// (36R P1: `m@(er)ge` — 단일문자 접기만으론 미탐)을 bash 시맨틱으로 전개한다. brace 는
// 대안(`,`)과 범위(`..`)만 전개 대상 — 무대안 `{word}` 는 bash 도 리터럴로 남긴다. extglob
// 은 `@(…)`/`+(…)` = 각 대안, `?(…)`/`*(…)` = 빈 문자열 포함, `!(…)` = 보집합이라 정적
// 열거 불가 = overflow. 전개 수가 캡을 넘어도 overflow 로 보고하고, 신호 술어가
// fail-closed 로 흡수한다(능력 토큰 동반 시 병합 단어 존재로 간주).
const BRACE_CAP = 512
const BRACE_RE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/
const EXTGLOB_RE = /[?*+@!]\([^()]*\)/
function expandBraceAlternations(s) {
  const variants = [s]
  let overflow = false
  for (let steps = 0; ; steps++) {
    if (steps > BRACE_CAP * 8) {
      overflow = true
      break
    }
    const idx = variants.findIndex((v) => BRACE_RE.test(v) || EXTGLOB_RE.test(v))
    if (idx === -1) break
    const v = variants[idx]
    const eg = v.match(/([?*+@!])\(([^()]*)\)/)
    const bm = v.match(/\{([^{}]*(?:,|\.\.)[^{}]*)\}/)
    // 둘 다 있으면 앞선 것부터 — 어느 쪽이든 결국 고정점까지 처리된다.
    const useEg = eg && (!bm || eg.index < bm.index)
    if (useEg) {
      if (eg[1] === '!') {
        overflow = true // 보집합은 임의 문자열 매칭 가능 — 정적 열거 불가
        break
      }
      const alts = eg[2].split('|')
      if (eg[1] === '?' || eg[1] === '*') alts.push('')
      const expanded = alts.map(
        (alt) => v.slice(0, eg.index) + alt + v.slice(eg.index + eg[0].length),
      )
      variants.splice(idx, 1, ...expanded)
      if (variants.length > BRACE_CAP) {
        overflow = true
        break
      }
      continue
    }
    const m = bm
    const body = m[1]
    let alts
    // 범위는 선택적 증분(step)까지 bash 시맨틱(34R P1: `{e..e..1}` — 2요소만 받으면 미탐).
    // bash 는 |step| 을 쓰고 0 은 1 로 취급한다.
    const range = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$|^(.)\.\.(.)(?:\.\.(-?\d+))?$/)
    if (range) {
      const numeric = range[1] !== undefined
      const [a, b] = numeric
        ? [parseInt(range[1], 10), parseInt(range[2], 10)]
        : [range[4].codePointAt(0), range[5].codePointAt(0)]
      const inc = Math.max(1, Math.abs(parseInt((numeric ? range[3] : range[6]) ?? '1', 10) || 1))
      const n = Math.floor(Math.abs(b - a) / inc) + 1
      if (n > BRACE_CAP) {
        overflow = true
        break
      }
      const dir = Math.sign(b - a) || 1
      const render = numeric ? String : String.fromCodePoint
      alts = Array.from({ length: n }, (_, i) => render(a + dir * inc * i))
    } else if (body.includes(',')) {
      alts = body.split(',')
    } else {
      // `..` 를 담지만 인식 불가한 범위 표기 — 정적 전개 불가 = fail-closed(34R P1)
      overflow = true
      break
    }
    const expanded = alts.map((alt) => v.slice(0, m.index) + alt + v.slice(m.index + m[0].length))
    variants.splice(idx, 1, ...expanded)
    if (variants.length > BRACE_CAP) {
      overflow = true
      break
    }
  }
  return { variants, overflow }
}

function scanVariants(s) {
  const stripped = stripShellExpansions(s)
  // `${X:-h}` 류 매개변수 확장은 미설정 시 피연산자로 치환된다(21R P1) — 피연산자를 남긴
  // 변형도 병행 스캔한다(`:-`·`:=`·`:+`·`:?` 및 콜론 생략형). 중첩(`${X:-${Y:-h}}`, 22R P1)은
  // 안쪽부터 고정점까지 반복 치환한다.
  // 진짜 고정점까지 반복(25R P1: 고정 횟수 상한은 그보다 깊은 중첩이 우회) — 각 반복은
  // `${…}` 를 최소 한 겹 벗기므로 반복 수는 입력 길이로 자연 유계다.
  let unwrapped = s
  for (let i = 0; i <= s.length; i++) {
    const next = unwrapped.replace(/\$\{[^{}]*?:?[-=+?]([^{}]*)\}/g, '$1')
    if (next === unwrapped) break
    unwrapped = next
  }
  const defaulted = stripShellExpansions(unwrapped)
  // 유효 percent triplet 을 **개별** 디코드한다(39R P1: `m%65rge` 엔드포인트 + `%ZZ` 헤더 —
  // 전체 decodeURIComponent 는 `%ZZ` 에서 throw 해 `%65` 까지 미디코드로 남겨 merge 미탐).
  // `%ZZ` 처럼 hex 아닌 것은 정규식이 애초에 매칭 안 해 그대로 두고, 유효 것만 푼다.
  const decoded = (x) =>
    x.replace(/%[0-9a-fA-F]{2}/g, (m) => {
      try {
        return decodeURIComponent(m)
      } catch {
        return m
      }
    })
  const bases = [s, stripped, defaulted, decoded(s), decoded(stripped)]
  const out = new Set()
  let overflow = false
  for (const b of bases) {
    const e = expandBraceAlternations(b)
    overflow ||= e.overflow
    out.add(b)
    for (const v of e.variants) out.add(v)
  }
  return { variants: [...out], overflow }
}

/** 병합 능력 단어(merge·enqueuePullRequest — 13R) 존재 — gh 문맥 없이도 판단(alias 확장용). */
export function hasMergeWord(s) {
  const { variants, overflow } = scanVariants(s)
  return overflow || variants.some((v) => /merge|enqueuepullrequest/i.test(v))
}

/**
 * alias 확장이 병합 의심인가 — 병합 단어를 담거나(9R~17R), **동사가 실행 시점에 계산**되어
 * 정적으로 비병합임을 증명할 수 없는 경우(20R P1: `!gh pr "$ACTION" "$@"`, ACTION=merge).
 * 위치 전달(`$@`·`$*`·`$N`)은 호출 인자 그대로라 명령 쪽 검사가 담당 — 의심 아님.
 */
// `gh alias list` 는 확장을 YAML 작은따옴표로 감싼다(`pm: '!printf ...'`, 내부 `'`는 `''`)
// — 래핑을 벗겨야 `!` 접두·`$` 등을 볼 수 있다(37R P1: 래핑 때문에 startsWith('!') 실패).
export function unwrapYamlSingleQuote(s) {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
    return t.slice(1, -1).replace(/''/g, "'")
  return t
}

export function aliasIsSuspect(rawExp) {
  const exp = unwrapYamlSingleQuote(rawExp)
  // `$@`·`$*` 전체 전달만 무해 — `$1` 등 선택/재배열 위치 인자는 호출부 인자를 동사 자리로
  // 옮길 수 있어(23R P1: `!gh pr "$1" …` + 인자 merge) 명명 변수와 같이 의심 처리.
  // 불투명 API 형태(--input·=@ 파일 필드·graphql)로 확장되는 alias 도 의심 — 직접 명령이면
  // 차단될 형태가 alias 를 거치면 통과했다(26R P1: `q: api graphql --input /tmp/q.graphql`).
  // 백틱 명령 치환도 `$(…)` 와 같은 실행 시점 계산이다(36R P1: `!gh pr \`printf m%crge e\``
  // — sh 가 백틱을 평가해 동사를 조립) — 동적 취급.
  // 셸 alias(`!…`) 본문은 그 자체로 sh 가 실행하는 셸 명령이다 — 동적 문법 열거 대신 직접
  // 명령과 동일 규칙으로 재분류한다(37R P1: `!printf 'gh pr m%crge --help' e | sh` —
  // merge/$/백틱 어느 열거에도 안 걸리지만 stdin 인터프리터 규칙이 잡는다). 또한 본문이
  // 외부 stdin 스크립트를 소비하는 형태(`!sh` — 능력이 호출부 stdin 에서 옴)면 관측 불가로
  // 의심 처리한다(39R P1: 격리 본문 `sh` 는 classify 가 pass 라 놓치던 결함).
  if (exp.startsWith('!')) {
    const body = exp.slice(1)
    if (classifyHookInput({ tool_name: 'Bash', tool_input: { command: body } }).kind !== 'pass')
      return true
    if (consumesExternalScript(body)) return true
  }
  return hasMergeWord(exp) || /\$(?![@*])|`/.test(exp) || /--input|=@|graphql/i.test(exp)
}

export function hasMergeSignal(cmd) {
  const capability = (s) =>
    /(^|[^\p{L}\d])gh(\.exe)?([^\p{L}\d]|$)/iu.test(s) || /github\.com|graphql/i.test(s)
  const signal = (s) => /merge|enqueuepullrequest/i.test(s) && capability(s)
  const { variants, overflow } = scanVariants(cmd)
  // brace 전개 overflow = 병합 단어 존재를 정적으로 배제할 수 없음 — 능력 토큰이 있으면
  // 신호로 취급한다(fail-closed).
  return variants.some(signal) || (overflow && variants.some(capability))
}

// 투명 래퍼 — 실효 실행 파일을 가린다(37R P1: `env xargs gh`). 실행 파일 탐색에서 건너뛴다.
const WRAPPER_NAMES = new Set([
  'env',
  'nohup',
  'nice',
  'stdbuf',
  'timeout',
  'time',
  'command',
  'setsid',
  'ionice',
  'doas',
  'sudo',
])
const INTERP_RE = /^(sh|bash|zsh|dash|ksh)(\.exe)?$/
const tokNorm = (t) => t.toLowerCase().replace(/^.*[\\/]/, '')
const isAssembler = (e) => e === 'xargs' || e === 'parallel'
// 실효 실행 파일 토큰의 인덱스 — 대입·투명 래퍼·수치 인자·플래그(및 그 값)를 건너뛴 첫 토큰.
// 래퍼 옵션의 필수값(`env -u FOO`, 37R→41R P1)을 실행 파일로 오인하지 않도록 `=` 미포함
// 옵션의 다음 토큰을 값으로 소비한다 — 값이 위험 실행 토큰을 닮아도 소비한다(42R P1:
// `env -u gh xargs gh` — `-u` 의 값 gh 를 안 먹으면 gh 를 실효로 오인). 값 소비로 인한
// 과소비 우회(무값 옵션 `env -i xargs` 등)는 classify 의 래퍼-프리픽스 보수 규칙이 흡수한다.
function effectiveExeIndex(tokens) {
  let i = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue
    if (WRAPPER_NAMES.has(tokNorm(t))) continue
    if (/^\d+(\.\d+)?[smhd]?$/.test(t)) continue
    if (t.startsWith('-')) {
      const nx = tokens[i + 1]
      if (nx && !nx.startsWith('-') && !t.includes('=')) i++
      continue
    }
    break
  }
  return i
}

// 세그먼트가 투명 래퍼로 시작하는가(대입 프리픽스는 건너뛴다) — 그렇다면 옵션 arity 불명으로
// 실효 실행 위치를 오판할 수 있어, 조립기/stdin 인터프리터의 **존재**만으로 보수 차단한다.
function startsWithWrapper(tokens) {
  const first = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
  return first !== undefined && WRAPPER_NAMES.has(tokNorm(first))
}

// 셸 인터프리터의 `-c '<script>'` 인자를 뽑는다(38R P1: `bash -c 'gh q graphql --input …'`
// — 인용 스크립트가 단일 토큰이라 상위 토큰 검사가 gh/alias 를 못 본다). 각 스크립트는
// 상위와 동일한 분류·alias 검사 파이프라인에 재투입한다. 재귀는 깊이로 유계.
export function extractInterpreterScripts(cmd) {
  const scripts = []
  for (const detailed of tokenizeSegmentsDetailed(cmd)) {
    const tokens = detailed.map((t) => t.text)
    const i = effectiveExeIndex(tokens)
    const exe = tokens[i] !== undefined ? tokNorm(tokens[i]) : undefined
    if (exe && INTERP_RE.test(exe)) {
      const ci = tokens.indexOf('-c', i + 1)
      if (ci !== -1 && tokens[ci + 1] !== undefined && !tokens[ci + 1].startsWith('-'))
        scripts.push(tokens[ci + 1])
    }
  }
  return scripts
}

// 외부 stdin 스크립트를 소비할 수 있는 실효 실행이 있는가 — stdin 인터프리터(sh/bash 등,
// `-c` 도 스크립트 파일 인자도 없음)나 조립기(xargs·parallel)(39R P1: alias `!sh` 가
// 호출부 stdin 으로 임의 명령 실행 — 본문만 보면 능력 토큰이 없어 관측 불가). 능력 토큰
// 유무를 보지 않는다: alias 문맥에선 능력이 호출부 stdin/인자에서 온다.
export function consumesExternalScript(text) {
  for (const detailed of tokenizeSegmentsDetailed(text)) {
    const tokens = detailed.map((t) => t.text)
    const i = effectiveExeIndex(tokens)
    const exe = tokens[i] !== undefined ? tokNorm(tokens[i]) : undefined
    if (!exe) continue
    if (isAssembler(exe)) return true
    if (INTERP_RE.test(exe)) {
      const rest = tokens.slice(i + 1)
      if (!rest.includes('-c') && !rest.some((x) => !x.startsWith('-'))) return true
    }
  }
  return false
}

// ── 따옴표 인지 토크나이저 ────────────────────────────────────────────────────
// 셸 시맨틱의 근사: '…'/"…" 는 한 토큰으로 접고, \ 는 다음 문자를 리터럴로. 연산자·개행·
// 그룹핑(`(` `)` 백틱)은 세그먼트 경계다. canonical 판정은 「세그먼트가 정확히 1개」를
// 요구하므로 근사 오차는 전부 차단(비-canonical) 쪽으로 넘어진다.
export function tokenizeSegments(cmd) {
  return tokenizeSegmentsDetailed(cmd).map((seg) => seg.map((t) => t.text))
}

/**
 * tokenizeSegments 와 동일하되 토큰별로 인용 포함 여부를 남긴다 — 인용된 확장("$VAR")은
 * 워드 분할이 불가능해 플래그·서브커맨드 주입이 안 되지만, 비인용 확장($VAR)은 가능하다
 * (19R P1: `gh -R $ARGS`, ARGS='o/r pr merge').
 */
export function tokenizeSegmentsDetailed(cmd) {
  const segments = []
  let tokens = []
  let cur = ''
  let inToken = false
  let quoted = false
  let unquotedDollar = false
  let unquotedGlob = false
  const push = () => {
    if (inToken) tokens.push({ text: cur, quoted, unquotedDollar, unquotedGlob })
    cur = ''
    inToken = false
    quoted = false
    unquotedDollar = false
    unquotedGlob = false
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
    } else if (ch === "'") {
      const close = cmd.indexOf(ch, i + 1)
      quoted = true
      if (close === -1) {
        cur += cmd.slice(i + 1)
        inToken = true
        i = cmd.length
      } else {
        cur += cmd.slice(i + 1, close)
        inToken = true
        i = close
      }
    } else if (ch === '"') {
      // 이중따옴표 안 `\"` 는 닫힘이 아니다(29R P1: `--body "x\" --match-head-commit …"` 의
      // 이스케이프를 닫힘으로 읽으면 body 내부 문구가 실제 플래그로 승격돼 head 가드가
      // 조용히 소실된 채 통과한다) — 비이스케이프 따옴표까지 스캔한다.
      quoted = true
      let j = i + 1
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          cur += cmd[j + 1]
          j += 2
        } else {
          cur += cmd[j]
          j++
        }
      }
      inToken = true
      i = j < cmd.length ? j : cmd.length
    } else if (/\s/.test(ch)) {
      if (ch === '\n') endSegment()
      else push()
    } else if (ch === '#' && !inToken) {
      // 비인용 # 가 단어 시작이면 셸 주석 — 줄 끝까지 버린다(5R P1: `#222` 를 인자로 읽으면
      // 실제 실행(현재 브랜치 머지)과 다른 PR 을 검증한다). 인용된 "#N" 은 quote 분기로 보존.
      while (i < cmd.length && cmd[i] !== '\n') i++
      endSegment()
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      endSegment()
    } else {
      // 인용 밖의 `$` 는 발생 단위로 기록한다(20R P1: `"$EMPTY"$ARGS` 처럼 인용·비인용이
      // 한 토큰에 섞이면 토큰 단위 quoted 플래그로는 비인용 확장을 놓친다). 비인용 글롭
      // 문자(`?`·`*`·`[` — 브래킷식은 다문자 클래스도 경로명 확장한다, 27R P1: `mer[gG]e`)도
      // 동일 — 경로명 확장이 동사를 조립한다(24R P1: `merg?`).
      if (ch === '$') unquotedDollar = true
      if (ch === '?' || ch === '*' || ch === '[') unquotedGlob = true
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
// `--auto` 는 비허용 — 이연 머지는 활성화 이후의 push 가 이 hook 을 다시 거치지 않고
// 병합될 수 있어(4R P1) 일회 검증 게이트와 양립하지 않는다. `--admin` 도 비허용 —
// 플랫폼 강제 사전 게이트(required checks·리뷰 스레드)를 관리자 권한으로 우회하는
// 플래그라 게이트 층과 목적이 상충한다(5R P1). `--disable-auto`(해제)는 무해.
const MERGE_BOOL_FLAGS = new Set([
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
  // 어느 토큰이든 셸 확장(`$`)·글롭(`?`·`*`·`[]`)·brace(`{}`) 잔존이면 비-canonical — 확장은
  // 워드 분할 주입(12R: `--body $BODY`), 글롭은 경로명 확장으로 값이 바뀌고(25R: `-R o/r?`),
  // brace 는 한 값이 여러 인자로 갈라져 플래그를 주입한다(29R P1: `--body {x,--auto}`).
  if (tokens.some((t) => /[$?*[\]{}]/.test(t))) return null
  // 실행 파일 = bare `gh`/`gh.exe` 만(대소문자 무관 — win32, 3R P1). 경로 지정 실행은
  // PATH 의 gh 로 검증하고 다른 바이너리가 실행되는 불일치가 가능해 배제한다(4R P1).
  const exe = tokens[0]?.toLowerCase()
  if (exe !== 'gh' && exe !== 'gh.exe') return null
  let i = 1
  let repoFlag = null
  let repoUrl = null
  // 전역 -R/--repo 만 허용(그 외 선행 플래그 = 비-canonical)
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const [flag, inline] = splitFlag(tokens[i])
    if (flag !== '-R' && flag !== '--repo') return null
    repoFlag = inline ?? tokens[++i] ?? null
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
        if (flag === '-R' || flag === '--repo') repoFlag = value
        if (flag === '--match-head-commit') matchHead = value
      } else if (!MERGE_BOOL_FLAGS.has(flag)) {
        return null
      }
    } else if (pr == null && target == null) {
      const num = tok.match(/^#?(\d+)$/)
      const url = tok.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/)
      if (num) pr = Number(num[1])
      else if (url) {
        repoUrl = url[1]
        pr = Number(url[2])
      } else if (/[$]/.test(tok) || /:\/\//.test(tok)) {
        // 셸 확장 잔존·비 github.com URL 타깃은 해석 불가(4R P1: 엔터프라이즈 호스트 URL 이
        // 일반 타깃으로 낙하하면 로컬 레포 기준으로 오검증된다).
        return null
      } else target = tok
    } else {
      return null
    }
  }
  // URL 타깃과 -R 이 서로 다른 레포를 가리키면 거부 — gh 는 URL 의 레포를 우선하므로
  // -R 로 덮어쓰면 실제 병합 대상과 검증 대상이 갈라진다(5R P1).
  if (repoUrl != null && repoFlag != null && repoUrl.toLowerCase() !== repoFlag.toLowerCase())
    return null
  return { pr, repo: repoUrl ?? repoFlag, target, matchHead }
}

function splitFlag(tok) {
  const eq = tok.indexOf('=')
  return eq === -1 ? [tok, null] : [tok.slice(0, eq), tok.slice(eq + 1)]
}

/**
 * `gh alias list` 출력 파싱 — key = 이름 토큰열 join, value = { name: string[], exp: string }.
 * 다중행 확장은 `name: |-` 뒤 들여쓴 연속행으로 나온다(19R P1: 개행 담은 셸 alias 의 병합
 * 행이 `|-` 만 기록되고 유실) — 연속행을 공백으로 이어 확장 전체를 본다.
 */
/**
 * alias 확장을 고정점까지 해석한다(35R P1: `q: api`+`qq: q` 연쇄 — 1단 확장만 재분류하면
 * `gh qq graphql --input …` 이 api 를 숨긴 채 통과). gh 는 확장 첫 단어가 alias 면 재귀
 * 해석하고 잔여 인자를 이어붙인다. 순환/과깊이는 정적 해석 불가 = null(호출부 fail-closed).
 */
export function resolveAliasExpansion(aliases, exp0) {
  let exp = exp0
  for (let depth = 0; depth <= aliases.size; depth++) {
    if (exp.startsWith('!')) return exp // 셸 alias — gh 재확장 없음
    const words = exp.trim().split(/\s+/)
    const hit = [...aliases.values()].find(({ name }) =>
      name.every((n, j) => words[j]?.toLowerCase() === n.toLowerCase()),
    )
    if (!hit) return exp
    exp = `${hit.exp} ${words.slice(hit.name.length).join(' ')}`.trim()
  }
  return null
}

export function parseAliasList(text) {
  const aliases = new Map()
  let currents = []
  const register = (rawName, rawExp) => {
    const name = rawName.trim().split(/\s+/)
    const key = name.join(' ')
    const exp = rawExp.trim().replace(/^\|-?$/, '')
    // 콜론 이름의 합성 해석이 실제 alias 항목을 덮어쓰면 안 된다(26R P1: `pm: pr merge` 뒤
    // `pm:x: …` 의 lazy 해석이 pm 을 비병합 확장으로 교체) — 같은 키는 확장을 합집합으로
    // 이어붙여 어느 해석이든 의심 판정에 남게 한다.
    const existing = aliases.get(key)
    const entry = existing ?? { name, exp: '' }
    entry.exp = `${entry.exp} ${exp}`.trim()
    if (!existing) aliases.set(key, entry)
    currents.push(entry)
  }
  for (const line of text.split('\n')) {
    const cont = line.match(/^\s+(.*)$/)
    if (cont && currents.length) {
      for (const c of currents) c.exp = `${c.exp} ${cont[1].trim()}`.trim()
      continue
    }
    currents = []
    // alias 이름은 콜론을 담을 수 있어(`pm:x: pr merge`, 24R P1) 분해가 모호하다 —
    // 첫 콜론·마지막 콜론 양쪽 해석을 모두 등록해 어느 쪽으로 불려도 대조에 걸리게 한다.
    // 확장에도 콜론(URL 등)이 올 수 있어 첫/마지막 두 해석만으론 실제 이름을 놓친다
    // (29R P1: `pm:x: pr merge https://…` — greedy 가 URL 콜론을 잡아 `pm:x` 미등록) —
    // 모든 콜론 위치의 분해를 등록한다(같은 키는 합집합 병합, 콜론 수로 유계).
    for (let ci = line.indexOf(':'); ci !== -1; ci = line.indexOf(':', ci + 1)) {
      if (line.slice(0, ci).trim()) register(line.slice(0, ci), line.slice(ci + 1))
    }
  }
  return aliases
}

/**
 * hook 입력을 게이트 판정으로 환원한다.
 * @returns {{kind:'pass'}|{kind:'blocked', reason:string}
 *          |{kind:'merge', pr:number|null, repo:string|null, target:string|null,
 *            matchHead:string|null, viaMcp:boolean}}
 */
export function classifyHookInput(input, _depth = 0) {
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
  if (!hasMergeSignal(cmd)) {
    // 병합 단어가 보이는데 치환/확장(`$`·백틱)이 함께 있으면 실행 파일 자체가 동적으로
    // 조립될 수 있다(23R: `$(printf g)h pr merge` · 24R: `CLI=gh; "$CLI" pr merge` — gh
    // 토큰이 어느 변형에도 없어 신호 미발동). 정상 명령에서 병합 단어+확장 동반은 드물어
    // fail-closed 로 흡수한다(확장 없이 리터럴로 쓰라).
    if (hasMergeWord(cmd) && /[$`]/.test(cmd))
      return { kind: 'blocked', reason: '병합 단어와 셸 확장 동반 — 실행 파일 조립 가능' }
    // 실행 파일 자리의 확장·글롭은 무엇이 실행되는지 자체를 알 수 없다(25R: 상속 `CLI=gh` +
    // `"$CLI" pm 222` · 26R: 파일 `gh` 존재 시 `g?` 경로명 확장) — 대입 프리픽스(`NAME=…`)를
    // 건너뛴 첫 토큰(실행 파일)의 `$`(인용 무관)·비인용 글롭을 차단(리터럴로 쓰라).
    // 대입 값의 `$`(`SC="$TEMP/…"`)는 실행 파일이 아니므로 무관.
    for (const seg of tokenizeSegmentsDetailed(cmd)) {
      const exe = seg.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text))
      if (exe && (exe.text.includes('$') || exe.unquotedGlob))
        return { kind: 'blocked', reason: '실행 파일 자리 셸 확장/글롭 — 실행 대상 판별 불가' }
    }
    // 병합 능력이 명령 문자열 밖에 있으면 신호 스캔이 못 본다 — 불투명 gh api 호출은 차단:
    // ① GraphQL 본문이 --input 파일/stdin·셸 변수에 있는 경우(9R P1)
    // ② 변이 REST 호출(-X 비GET·--input·-f/-F 필드)의 엔드포인트가 셸 변수이거나 세그먼트에
    //    리터럴 경로가 아예 없는 경우(11R P1: `. env && gh api -X PUT "$ENDPOINT"`)
    // 인라인 리터럴 본문·경로의 병합은 여기 오기 전에 신호 스캔이 잡는다.
    const allSegments = tokenizeSegmentsDetailed(cmd)
    const cmdHasGh = allSegments.some((seg) =>
      seg.some((t) => {
        const exe = t.text.toLowerCase()
        return exe === 'gh' || exe === 'gh.exe'
      }),
    )
    // gh 능력 명령의 백틱 명령 치환은 서브커맨드·인자를 실행 시점에 계산한다(40R P1:
    // `gh pr \`printf m%crge e\` 222` — 백틱이 merge 를 숨겨 hasMergeWord 도 false). 백틱은
    // 세그먼트 경계라 토큰 플래그로 안 잡히므로 원문에서 본다 — $(…)/비인용 $ 와 대칭으로
    // 관측 불가. gh 인자에 명령 치환이 필요하면 리터럴로 펼치거나 --body-file 로 우회하라.
    if (cmdHasGh && /`/.test(cmd))
      return { kind: 'blocked', reason: 'gh 명령에 백틱 명령 치환 — 서브커맨드/인자 실행시점 계산' }
    // 같은 명령 안에서 alias 를 만들고(gh alias set/import/delete) 또 다른 gh 를 호출하면,
    // hook 의 alias 스냅샷은 실행 전에 찍혀 새 alias 를 못 본다(41R P1: `gh alias set pm
    // 'pr m'"$(printf erge)"; gh pm 222` — 둘째 세그먼트가 갓 만든 pm 을 pr merge 로 확장).
    // alias 변이 + 다른 gh 호출 동반이면 보수적으로 차단한다.
    const ghSegs = allSegments.filter((seg) =>
      seg.some((t) => t.text.toLowerCase() === 'gh' || t.text.toLowerCase() === 'gh.exe'),
    )
    const mutatesAlias = ghSegs.some((seg) => {
      const texts = seg.map((t) => t.text)
      const gi = texts.findIndex((t) => {
        const e = t.toLowerCase()
        return e === 'gh' || e === 'gh.exe'
      })
      let s = gi + 1
      while (s < texts.length && texts[s].startsWith('-')) {
        if (!texts[s].includes('=')) s++
        s++
      }
      return (
        texts[s]?.toLowerCase() === 'alias' &&
        /^(set|import|delete|remove)$/i.test(texts[s + 1] ?? '')
      )
    })
    if (mutatesAlias && ghSegs.length >= 2)
      return {
        kind: 'blocked',
        reason: 'alias 변이와 다른 gh 호출 동반 — 사전 스냅샷이 갓 만든 alias 를 못 본다',
      }
    // gh 가 있는 명령에서 GH_*/PATH 대입은 alias 관측 소스·실행 바이너리를 바꾼다
    // (22R P1: `GH_CONFIG_DIR=/tmp/alt gh pm 222` — hook 은 기본 환경의 alias 를 본다).
    if (
      cmdHasGh &&
      allSegments.some((seg) => seg.some((t) => /^(GH_[A-Z0-9_]*|PATH)=/.test(t.text)))
    )
      return { kind: 'blocked', reason: 'gh 호출과 GH_*/PATH 대입 동반 — 관측 환경 불일치' }
    // argv/스크립트가 명령 밖에서 조립되는 실행 경유는 인자를 관측할 수 없다(33R P1:
    // `printf 'pr m%crge …' e | xargs gh` — 원문에 연속 병합 단어가 없어 신호 미발동).
    // 조립기(xargs·parallel)의 인자에 gh/GitHub 능력 토큰이 보이거나, 능력 토큰이 있는
    // 명령에서 본문 없는 셸 인터프리터(stdin 스크립트)가 실행되면 차단한다.
    const CAPABILITY = /(^|[^\p{L}\d])gh(\.exe)?([^\p{L}\d]|$)|api\.github\.com|graphql/iu
    // 인터프리터 `-c '<script>'` 스크립트는 상위 토큰 검사가 못 본다(38R P1) — 재귀 분류로
    // 스크립트 내부의 gh 능력을 검사한다(직접형 `bash -c 'gh api graphql --input …'`).
    // alias 경유형(`gh q …`)은 main 의 alias 검사가 담당(classify 는 alias 미해석).
    // 상한 도달 시 남은 스크립트가 있으면 fail-closed(39R P1: 6중 중첩으로 상한을 넘겨
    // innermost 를 미분류로 통과시키던 결함) — 정적 분류 불가는 차단이다.
    const nestedScripts = extractInterpreterScripts(cmd)
    if (nestedScripts.length) {
      if (_depth >= 5)
        return { kind: 'blocked', reason: '인터프리터 중첩이 분류 상한 초과 — 정적 분류 불가' }
      for (const script of nestedScripts) {
        const sv = classifyHookInput(
          { tool_name: 'Bash', tool_input: { command: script } },
          _depth + 1,
        )
        if (sv.kind !== 'pass')
          return {
            kind: 'blocked',
            reason: `인터프리터 -c 스크립트가 차단 대상(${sv.reason ?? sv.kind})`,
          }
      }
    }
    // 투명 래퍼·대입·플래그값을 건너뛴 실효 실행 파일로 판정한다(37R·41R P1: `env -u FOO
    // xargs gh` — 공용 effectiveExeIndex 가 래퍼 옵션 값까지 소비).
    for (const detailed of allSegments) {
      const tokens = detailed.map((t) => t.text)
      const exeIdx = effectiveExeIndex(tokens)
      // 래퍼 프리픽스 세그먼트는 옵션 arity 불명으로 실효 실행 위치를 오판할 수 있다(42R P1:
      // `env -u gh xargs gh` — 과소비/과소비 반대 어느 쪽이든 오판 가능). 조립기(xargs·parallel)
      // 나 stdin 인터프리터(-c 없는 sh/bash)가 세그먼트에 **존재**하면 능력 동반 시 보수 차단한다
      // (-c 스크립트 인터프리터는 재귀 classify 가 정밀 판정하므로 제외).
      if (startsWithWrapper(tokens) && CAPABILITY.test(cmd)) {
        const hasAssembler = tokens.some((t) => isAssembler(tokNorm(t)))
        const hasStdinInterp =
          tokens.some((t) => INTERP_RE.test(tokNorm(t))) && !tokens.includes('-c')
        if (hasAssembler || hasStdinInterp)
          return {
            kind: 'blocked',
            reason: '래퍼 프리픽스에 조립기/stdin 인터프리터 — 실효 실행 위치 불명, 관측 불가',
          }
      }
      if (exeIdx >= tokens.length) continue
      const exe = tokNorm(tokens[exeIdx])
      if (isAssembler(exe) && CAPABILITY.test(tokens.slice(exeIdx + 1).join(' ')))
        return {
          kind: 'blocked',
          reason: 'argv 를 명령 밖(stdin/파일)에서 조립하는 gh 호출 — 관측 불가',
        }
      if (INTERP_RE.test(exe) && CAPABILITY.test(cmd)) {
        const rest = tokens.slice(exeIdx + 1)
        if (!rest.includes('-c') && !rest.some((t) => !t.startsWith('-')))
          return {
            kind: 'blocked',
            reason: '셸 인터프리터가 스크립트를 stdin 에서 읽음 — 관측 불가',
          }
      }
    }
    for (const detailed of allSegments) {
      const tokens = detailed.map((t) => t.text)
      const hasGh = tokens.some((t) => {
        const exe = t.toLowerCase()
        return exe === 'gh' || exe === 'gh.exe'
      })
      // 비-gh 클라이언트의 GitHub API 직접 호출은 전부 차단(20R curl → 21R wget·glob 로
      // 클라이언트·플래그 열거가 발산 — 구조 규칙으로 접는다): 본문/경로 표기를 클라이언트별로
      // 해석하지 않고, `api.github.com`(REST·GraphQL 공통 호스트)이 보이면 gh 로 하라고
      // 안내한다. github.com 웹 URL(clone·PR 링크 인용)은 무관하므로 api 호스트만 본다.
      if (!hasGh && tokens.some((t) => /api\.github\.com|github\.com\/graphql/i.test(t)))
        return {
          kind: 'blocked',
          reason: '비-gh 클라이언트의 GitHub API 직접 호출 — 관측 불가, gh CLI 로 실행하라',
        }
      if (!hasGh) continue
      // gh 앞의 어떤 env 대입 프리픽스도 실행 환경을 바꾼다(22R P1 일반화) — 차단.
      {
        const gi = tokens.findIndex((t) => {
          const exe = t.toLowerCase()
          return exe === 'gh' || exe === 'gh.exe'
        })
        if (tokens.slice(0, gi).some((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)))
          return { kind: 'blocked', reason: 'gh 호출에 env 대입 프리픽스 — 관측 환경 불일치' }
      }
      // gh 호출 세그먼트의 **비인용** `$` 확장은 워드 분할로 서브커맨드·플래그를 주입할 수
      // 있다(19R P1: `gh -R $ARGS 222`, ARGS='o/r pr merge') — 위치 불문 차단. 인용된
      // 확장("$VAR")은 분할이 불가능해 값 위치에선 허용(단, 서브커맨드 자리는 아래에서
      // 인용 여부 무관 차단 — 단어 하나로도 동사가 된다).
      if (detailed.some((t) => t.unquotedDollar))
        return { kind: 'blocked', reason: 'gh 호출에 비인용 셸 확장 — 워드 분할 주입 가능' }
      // 비인용 글롭은 경로명 확장으로 동사를 조립할 수 있다(24R P1: `gh pr merg?` + 파일
      // `merge` 존재 시). gh api 쿼리스트링의 `?` 는 인용하면 통과.
      if (detailed.some((t) => t.unquotedGlob))
        return { kind: 'blocked', reason: 'gh 호출에 비인용 글롭 — 경로명 확장 조립 가능' }
      // 서브커맨드 자리의 셸 확장은 병합 동사를 가릴 수 있다(13R P1: `gh pr $ACTION 222`·
      // `gh $CMD 222`) — gh 다음 첫 비플래그 토큰, 그리고 첫 토큰이 `api`(인자=엔드포인트)가
      // 아니면 둘째 비플래그 토큰까지 `$` 를 거부한다. 플래그 값(-F body=@$X)은 해당 없음.
      {
        const gi = tokens.findIndex((t) => {
          const exe = t.toLowerCase()
          return exe === 'gh' || exe === 'gh.exe'
        })
        const positional = []
        for (let i = gi + 1; i < tokens.length && positional.length < 2; i++) {
          if (tokens[i].startsWith('-')) {
            if (!tokens[i].includes('=')) i++ // 값 플래그로 보수 가정 — 다음 토큰은 값
            continue
          }
          positional.push(tokens[i])
        }
        const depth = positional[0] === 'api' ? 1 : 2
        if (positional.slice(0, depth).some((t) => t.includes('$')))
          return { kind: 'blocked', reason: 'gh 서브커맨드 자리에 셸 확장 — 병합 동사 은닉 가능' }
      }
      if (!tokens.includes('api')) continue
      const hasDollar = tokens.some((t) => t.includes('$'))
      const hasInput = tokens.some((t) => t.startsWith('--input'))
      if (tokens.includes('graphql')) {
        // 타입 필드의 `@` 값은 파일/stdin 에서 읽는다(12R P1: `-F query=@/tmp/m.graphql`).
        if (hasInput || hasDollar || tokens.some((t) => t.includes('=@')))
          return {
            kind: 'blocked',
            reason: 'GraphQL 본문이 명령 밖(--input/파일 필드/변수) — 관측 불가',
          }
        continue
      }
      // 엔드포인트 = `api` 다음의 첫 비플래그 토큰(값 플래그의 값은 건너뜀). 판정은 필드
      // 값이 아니라 엔드포인트 토큰 기준 — 필드 값의 `$`(예: -F body=@$DIR/x.md)는 본문
      // 내용이지 대상 경로가 아니다(자기 오탐 실측으로 정밀화).
      const API_VALUE_FLAGS = new Set([
        '-X',
        '--method',
        '-H',
        '--header',
        '-f',
        '--field',
        '-F',
        '--raw-field',
        '--input',
        '-q',
        '--jq',
        '-t',
        '--template',
        '--hostname',
        '--cache',
        '-p',
        '--preview',
      ])
      let mutating = hasInput
      let endpoint = null
      for (let i = tokens.indexOf('api') + 1; i < tokens.length; i++) {
        let [flag, inline] = splitFlag(tokens[i])
        // cobra 는 짧은 옵션에 값을 붙여 쓰는 표기를 허용한다(12R P1: `-XPUT`·`-Fk=v`).
        const attached = flag.match(/^(-[XfFHqtp])(.+)$/)
        if (attached) {
          flag = attached[1]
          inline = inline == null ? attached[2] : `${attached[2]}=${inline}`
        }
        if (tokens[i].startsWith('-')) {
          const v = inline ?? (API_VALUE_FLAGS.has(flag) ? tokens[++i] : null) ?? ''
          if ((flag === '-X' || flag === '--method') && v.toUpperCase() !== 'GET') mutating = true
          if (/^(-f|-F|--field|--raw-field)$/.test(flag)) mutating = true
        } else if (endpoint == null) {
          endpoint = tokens[i]
        }
      }
      // `{owner}/{repo}` 외 플레이스홀더는 리터럴이 아니다(16R P1: `{branch}` 가 현재
      // 브랜치명 — 예: `merge` — 으로 치환돼 병합 엔드포인트가 된다).
      const scrubbed = endpoint?.replace(/\{owner\}|\{repo\}/g, '') ?? null
      if (mutating && (scrubbed == null || /[${]/.test(scrubbed)))
        return { kind: 'blocked', reason: '변이 gh api 의 엔드포인트가 명령 밖(변수) — 관측 불가' }
    }
    return { kind: 'pass' }
  }
  const canonical = parseCanonicalMerge(cmd)
  if (canonical == null)
    return { kind: 'blocked', reason: '머지 능력 신호가 있으나 canonical 형태가 아님' }
  // 타깃 생략(현재 브랜치)·브랜치명 타깃은 hook 해석과 실행 시점 해석이 갈릴 수 있다
  // (15R P1: 사이에 워크트리가 다른 PR 로 이동하면 같은 head SHA 로 SHA 가드도 통과) —
  // 안정 식별자(번호·URL)만 허용한다.
  if (canonical.pr == null)
    return {
      kind: 'blocked',
      reason:
        '명시적 PR 번호/URL 필수 — 현재 브랜치·브랜치명 해석은 검증과 실행 사이에 갈릴 수 있다' +
        '(번호는 `gh pr view --json number` 로 확인)',
    }
  return { ...canonical, kind: 'merge', viaMcp: false }
}

// ── main (직접 실행 시에만 — 테스트 import 시 stdin 을 읽지 않는다) ───────────
function main() {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    // 읽을 수 없는 호출은 비병합임을 증명할 수 없다(15R P1) — fail-closed.
    console.error('[codex-gate] hook 입력(JSON) 해석 실패 — 판단 불가라 fail-closed 차단.')
    process.exit(2)
  }

  const cwd = input.cwd || process.cwd()
  const verdict = classifyHookInput(input)
  if (verdict.kind === 'pass') {
    // gh alias 는 리터럴 merge 없이 병합으로 확장될 수 있다(7R P1: `gh pm 222`) — gh 토큰이
    // 보이는 명령은 구성된 alias 목록을 실측해, 병합 신호를 담은 확장의 alias 이름이 명령에
    // 등장하면 차단한다. alias 목록 조회 실패는 fail-closed(숨은 alias 를 배제 못 함).
    const cmd = String(input.tool_input?.command ?? '')
    // 트리거도 정규화본으로 판정한다(18R P1: `g''h pm 222` 는 raw 에 gh 토큰이 없어
    // alias 스캔을 건너뛴다). 스캔 시 명령 토큰도 동일 정규화로 재토큰화.
    const normCmd = stripShellExpansions(cmd)
    if (
      String(input.tool_name) === 'Bash' &&
      /(^|[^\p{L}\d])gh(\.exe)?([^\p{L}\d]|$)/iu.test(normCmd)
    ) {
      const r = spawnSync('gh', ['alias', 'list'], { encoding: 'utf8', cwd, timeout: 45_000 })
      if (r.error || r.status !== 0) {
        console.error(
          '[codex-gate] gh alias 목록 조회 실패 — 숨은 병합 alias 를 배제할 수 없어 차단.',
        )
        process.exit(2)
      }
      // alias 확장은 gh 접두 없이 나온다(`pm: pr merge`, 9R P1) — 확장 문자열은 이미 gh 명령
      // 문맥이므로 merge 단어 단독을 신호로 보고, alias 가 다른 alias 로 확장되는 체인
      // (`pm: px`·`px: pr merge`, 10R P1)은 고정점 전파로 이행적으로 물들인다. 이름은 공백을
      // 담을 수 있으므로(`pr land: pr merge`, 11R P1) 토큰 열로 다루고 연속 부분열로 대조한다.
      const containsSeq = (arr, seq) =>
        seq.length > 0 &&
        arr.some((_, i) => seq.every((s, j) => arr[i + j]?.toLowerCase() === s.toLowerCase()))
      const aliases = parseAliasList(r.stdout)
      const mergey = new Set(
        [...aliases.values()]
          // 셸 alias(`!…`)는 분절 표기를 담을 수 있다(16R P1: `!gh pr m''erge "$@"`) —
          // 확장도 신호 스캔과 같은 정규화 변형으로 검사한다.
          .filter(({ exp }) => aliasIsSuspect(exp))
          .map(({ name }) => name.join(' ')),
      )
      let grew = true
      while (grew) {
        grew = false
        for (const [key, { exp }] of aliases) {
          if (mergey.has(key)) continue
          // 확장 안의 alias 참조는 분절 표기를 담을 수 있다(17R P1: `!gh p''x "$@"`) —
          // 신호 스캔과 같은 확장 제거 형태로 토큰화해 대조한다.
          const expTokens = stripShellExpansions(exp).split(/\s+/)
          for (const mk of mergey) {
            if (containsSeq(expTokens, aliases.get(mk).name)) {
              mergey.add(key)
              grew = true
              break
            }
          }
        }
      }
      // alias 검사를 임의 명령 문자열에 적용하는 함수 — cmd 와 인터프리터 -c 스크립트
      // (38R P1: `bash -c 'gh q graphql --input …'`) 각각에 돌린다.
      const auditAliasesIn = (text) => {
        // brace 류 분절 호출(`gh p{m..m}`, 23R P1)도 잡도록 원문·정규화본 양쪽을 대조한다.
        const segTokens = [
          ...tokenizeSegments(text),
          ...tokenizeSegments(stripShellExpansions(text)),
        ]
        for (const mk of mergey) {
          const { name, exp } = aliases.get(mk)
          if (segTokens.some((seg) => containsSeq(seg, name))) {
            console.error(
              `[codex-gate] gh alias '${mk}' 는 (이행적으로) 병합으로 확장된다(${exp}) — ` +
                'alias 경유 병합은 차단. canonical 형태로 직접 실행하라.',
            )
            process.exit(2)
          }
        }
        // 비병합 alias 라도 호출 직후 인자에 확장이 오면 그 인자가 동사 자리로 이어진다
        // (29R P1: `pr x: pr` + `gh pr x "$ACTION" 222`, ACTION=merge — 인용 확장이라 비인용
        // 규칙도 미발동) — gh 뒤 alias 이름 열 매칭 직후 토큰의 `$` 는 인용 무관 차단.
        for (const seg of tokenizeSegmentsDetailed(text)) {
          const texts = seg.map((t) => t.text)
          const gi = texts.findIndex((t) => {
            const exe = t.toLowerCase()
            return exe === 'gh' || exe === 'gh.exe'
          })
          if (gi === -1) continue
          // 전역 플래그(-R 값 등)를 건너뛴 위치에서 alias 이름을 맞춘다(30R P1: gh 바로 뒤
          // 고정 매칭은 `gh -R o/r pr x "$ACTION"` 을 놓친다). 값 유무 미상 플래그는 보수적으로
          // 다음 토큰을 값으로 소비한다.
          let start = gi + 1
          while (start < texts.length && texts[start].startsWith('-')) {
            if (!texts[start].includes('=')) start++
            start++
          }
          for (const { name, exp } of aliases.values()) {
            const matches = name.every(
              (n, j) => texts[start + j]?.toLowerCase() === n.toLowerCase(),
            )
            if (!matches) continue
            if (texts[start + name.length]?.includes('$')) {
              console.error(
                `[codex-gate] gh alias '${name.join(' ')}' 호출 직후 인자에 셸 확장 — 확장이 ` +
                  '동사 자리로 이어질 수 있어 차단. 리터럴 인자로 실행하라.',
              )
              process.exit(2)
            }
            // 확장+이어붙인 인자의 합성을 직접 명령과 동일 규칙으로 재분류(31R·32R P1:
            // `q: api` 뒤 불투명 GraphQL/변이 REST 가 확장 단독 비의심으로 통과 — GraphQL
            // 전용 패턴 대신 classifyHookInput 재투입으로 판정 일치를 만든다). 확장은
            // 고정점까지 해석한다(35R P1: `qq: q` 연쇄가 api 를 숨김) — 순환/과깊이는 차단.
            const resolved = resolveAliasExpansion(aliases, exp)
            if (resolved == null) {
              console.error(
                `[codex-gate] gh alias '${name.join(' ')}' 확장이 순환/과깊이 — 정적 해석 불가라 차단.`,
              )
              process.exit(2)
            }
            const combined = `${resolved} ${texts.slice(start + name.length).join(' ')}`
            const reVerdict = classifyHookInput({
              tool_name: 'Bash',
              tool_input: { command: `gh ${combined}` },
            })
            if (reVerdict.kind !== 'pass') {
              const why = reVerdict.reason ?? reVerdict.kind
              console.error(
                `[codex-gate] gh alias '${name.join(' ')}' 호출의 합성 형태가 차단 대상(${why}) — ` +
                  'alias 없이 인라인 리터럴로 실행하라.',
              )
              process.exit(2)
            }
          }
        }
      }
      // cmd 와 그 안의 인터프리터 -c 스크립트들(중첩 포함, 깊이 유계)을 모두 검사한다.
      const auditTexts = [cmd]
      for (let d = 0; d < auditTexts.length && d < 64; d++)
        auditTexts.push(...extractInterpreterScripts(auditTexts[d]))
      // brace 전개 변형에도 alias 검사를 적용한다(42R P1: `gh {pm,--squash} 222` 가 alias
      // 호출 `gh pm …` 로 전개되는데 raw·singleton-stripped 형만 보면 pm 을 못 맞춘다).
      // 다문자 brace 전개는 bash 시맨틱으로 펼친다(hasMergeSignal 과 같은 전개기 공유).
      const withBrace = []
      for (const text of auditTexts) {
        withBrace.push(text)
        for (const v of expandBraceAlternations(text).variants) if (v !== text) withBrace.push(v)
      }
      for (const text of withBrace) auditAliasesIn(text)
    }
    process.exit(0)
  }
  if (verdict.kind === 'blocked') {
    console.error(
      `[codex-gate] 차단(${verdict.reason}). 머지는 canonical 형태만 허용된다:\n` +
        '  gh pr merge <번호> [-R owner/repo] [--squash 등] --match-head-commit <head SHA>\n' +
        '(REST/GraphQL/복합 명령/서브셸 경유 머지는 전부 차단 — 머지 문구를 본문 인용만 하는 ' +
        '거면 --body-file 로 우회하라.)',
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

  // GH_HOST 는 검증 API 호출(gh api)의 호스트를 통째로 리다이렉트한다 — 병합은 github.com
  // URL 을 겨냥하면서 검증은 타 호스트에서 이뤄지는 분열이 가능하므로(7R P1) 설정돼 있으면
  // 무조건 차단. GH_REPO 는 명시 -R/URL 이 있으면 무해하나 없으면 대상이 조용히 바뀌므로 차단.
  if (process.env.GH_HOST) {
    console.error(
      '[codex-gate] GH_HOST 환경변수 감지 — 검증과 병합의 호스트가 갈라질 수 있어 차단.',
    )
    process.exit(2)
  }
  if (!verdict.repo && process.env.GH_REPO) {
    console.error('[codex-gate] GH_REPO 환경변수 감지 — -R owner/repo 명시가 필요하다.')
    process.exit(2)
  }

  // pr 은 항상 명시 번호다 — Bash 는 classify 가 번호/URL 을 강제하고(15R P1: 이중 해석
  // 레이스 제거) MCP 는 pull_number 필수.
  const { pr, repo } = verdict
  if (pr == null) {
    console.error('[codex-gate] PR 번호 부재 — fail-closed 차단.')
    process.exit(2)
  }

  const base = repo ? `repos/${repo}` : 'repos/{owner}/{repo}'
  const headSha = validatePr(gh, base, pr)

  // TOCTOU 봉쇄: 검증한 head 를 GitHub 서버가 병합 조건으로 강제하게 한다(3R P1).
  // MCP 도 hook 과 실행 사이가 원자적이지 않으므로 sha 필수(4R P1).
  if (verdict.matchHead == null) {
    // 재시도 안내는 원 명령을 보존해 SHA 만 덧붙인다(12R P2: --squash 강제 치환은 요청한
    // 병합 전략을 조용히 바꾼다). 원 명령은 canonical 단일 세그먼트라 뒤에 덧붙여도 유효.
    const originalCmd = String(input.tool_input?.command ?? '').trim()
    const hint = verdict.viaMcp
      ? `merge_pull_request 호출에 sha: "${headSha}" 를 포함해 재시도하라.`
      : '이대로 재시도하라:\n' + `  ${originalCmd} --match-head-commit ${headSha}`
    console.error(
      `[codex-gate] PR #${pr} 검증 통과 — 단, 검증 시점의 head 를 서버가 강제하도록 ` +
        `기대 head SHA 가 필수다. ${hint}`,
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
  const headLine = gh(['api', `${base}/pulls/${pr}`, '--jq', '.head.sha + " " + .base.ref']).trim()
  const [headSha, baseRef] = headLine.split(/\s+/)
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '') || !baseRef) {
    console.error(`[codex-gate] PR #${pr} head SHA/base 해석 실패 — fail-closed 차단.`)
    process.exit(2)
  }

  // base 브랜치가 merge queue 를 요구하면 평문 병합 명령이 이연(auto) 병합을 암묵 활성화해
  // 이후 push 가 이 hook 을 재통과하지 않고 병합될 수 있다(6R P1) — 게이트가 검증할 수 없는
  // 상태이므로 차단한다. 조회 실패도 fail-closed(gh 헬퍼가 exit 2).
  // baseRef 는 `#`·`?` 등을 담을 수 있는 유효 git ref — 인코딩 없이 삽입하면 URL 프래그먼트로
  // 잘려 다른 브랜치의 룰을 조회한다(15R P1: `stable#queued` → `stable`).
  const rules = gh([
    'api',
    `${base}/rules/branches/${encodeURIComponent(baseRef)}`,
    '--paginate',
    '--jq',
    '.[].type',
  ])
  if (rules.split('\n').some((t) => t.trim() === 'merge_queue')) {
    console.error(
      `[codex-gate] PR #${pr} 의 base(${baseRef})가 merge queue 를 요구한다 — 평문 병합이 ` +
        '이연 병합을 암묵 활성화해 이후 push 를 이 게이트가 재검증할 수 없으므로 차단한다.',
    )
    process.exit(2)
  }

  // base 변경(`pr edit -B`)은 head 를 안 움직이고 리뷰된 diff 를 바꾼다(13R P1) — 모든
  // 신호(commit_id 일치 리뷰 포함)는 마지막 base_ref_changed 이벤트 이후여야 한다.
  const baseChangedAt = latestTimelineEvent(gh, base, pr, 'base_ref_changed') ?? ''

  const headTime = [headArrivalTime(gh, base, pr, headSha), baseChangedAt].sort().at(-1)

  // 트리거는 **단독** `@codex review` 코멘트만 인정한다(28R: 산문 속 인용 — 예: 답글에서
  // 명령을 설명하는 문장 — 이 contains 로 트리거가 되면 늦은 👍 를 오결속한다).
  const triggerTimes = gh([
    'api',
    `${base}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `.[] | select(.author_association == "OWNER" and (.body | test("^\\\\s*@codex review\\\\s*$"))) | .created_at`,
  ])
  const latestTrigger = triggerTimes
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^\d{4}-\d{2}-\d{2}T/.test(t) && t >= headTime)
    .sort()
    .at(-1)

  // base 변경이 있었으면 시각 기반 자동 경로(공식 리뷰·👍)를 **전부 건너뛴다**(41R P1:
  // 제출/리액션 시각은 리뷰를 새 base diff 에 인과 결속하지 못한다 — A base 리뷰가 in-flight
  // 로 재트리거 이후 제출돼도 commit_id==head·시각 조건을 만족한다). base 변경 후엔 OWNER 가
  // 새 base diff 를 보고 남긴 audited 폴백 마커(근거 서술 포함)만 유일 경로다.
  if (!baseChangedAt) {
    const reviewLines = gh([
      'api',
      `${base}/pulls/${pr}/reviews`,
      '--paginate',
      '--jq',
      `.[] | select(.user.login == "${CODEX_LOGIN}") | .commit_id + " " + .submitted_at`,
    ])
    // head 가 그대로이므로 commit_id 결속으로 충분(base 변경 없음).
    if (
      reviewLines.split('\n').some((line) => {
        const [sha] = line.trim().split(/\s+/)
        return sha === headSha
      })
    )
      return headSha

    // 👍 리액션은 commit 결속이 없다 — head 도착 시각만으로는 「A 리뷰 중 B push → A 의 늦은
    // 👍」가 B 를 인가한다(27R P1). 트리거 체인으로 결속한다: head 도착 **이후** OWNER 의
    // `@codex review` 재트리거가 존재하고, 👍 가 그 트리거 이후일 때만 현재 head 의 신호로
    // 인정한다(트리거 없으면 👍 경로 무효 — 명시 재트리거 후 새 👍 를 받으라).
    if (latestTrigger) {
      const thumbTimes = gh([
        'api',
        `${base}/issues/${pr}/reactions`,
        '--paginate',
        '--jq',
        `.[] | select(.content == "+1" and .user.login == "${CODEX_LOGIN}") | .created_at`,
      ])
      if (thumbTimes.split('\n').some((t) => t.trim() && t.trim() >= latestTrigger)) return headSha
    }
  }

  // 무응답 폴백 — OWNER 가 남긴 head-결속 마커(`[codex-gate-fallback] head=<현재 head SHA>`)를
  // **코멘트 첫머리 앵커**로만 인정한다(25R P1: 이 hook 의 안내문이 정확한 토큰을 출력하므로
  // 그 문자열을 인용한 질문·진단 코멘트가 contains 로 통과했다 — 인용/질문은 항상 앞에 다른
  // 텍스트가 붙는다). SHA 결속이라 head 가 바뀌면 자동 실효.
  // --paginate 는 jq 를 페이지별로 평가한다(7R P1) — 집계는 JS 에서 한다.
  const fallbackToken = `${FALLBACK_MARKER} head=${headSha}`
  // 마커로 시작하는 OWNER 코멘트를 @json 라인으로 받아 JS 에서 판정한다 — 근거(마커 뒤
  // 비공백 텍스트, 40R P1) 검사를 순수 함수로 일원화한다. body 는 @json 으로 안전 인코딩.
  const fallbackRaw = gh([
    'api',
    `${base}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `.[] | select(.author_association == "OWNER" and (.body | startswith("${fallbackToken}"))) | {c: .created_at, b: .body} | @json`,
  ])
  // SHA 결속이라 head 이동엔 자동 실효하나, base 변경은 head 를 안 움직이므로(13R P1)
  // 마커도 마지막 base_ref_changed 이후만 인정한다. 그리고 마커 뒤 실증 텍스트가 있어야 한다.
  const fallbackOk = fallbackRaw
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      let o
      try {
        o = JSON.parse(line)
      } catch {
        return false
      }
      return (o.c ?? '') >= baseChangedAt && fallbackMarkerHasEvidence(o.b ?? '', fallbackToken)
    })
  if (fallbackOk) {
    console.error(
      `[codex-gate] PR #${pr}: Codex 리뷰 부재이나 OWNER 의 head-결속 폴백 마커 확인 — ` +
        '풀 렌즈 자가리뷰 폴백으로 허용(AGENTS.md 4단계).',
    )
    return headSha
  }

  console.error(
    `[codex-gate] PR #${pr} 의 현재 head(${headSha.slice(0, 7)})에 결속된 Codex 신호가 없다 — ` +
      '머지 차단(ADR-0014 전제). 낡은 라운드의 리뷰·👍 는 새 커밋을 인가하지 않는다. ' +
      '`@codex review` 로 재트리거 후 대기하라(보통 7~20분). 무응답 fallback 머지는 P1 신호 렌즈를 ' +
      '포함한 풀 렌즈 자가리뷰 완료 후, 마커(`[codex-gate-fallback] head=<현재 head 40자 SHA>`)로 ' +
      '**시작하는** OWNER 코멘트에 근거 서술을 담는 것이 조건이다(첫머리 앵커 — 인용·질문은 ' +
      '불인정, 감사 가능·head-결속 경로).',
  )
  process.exit(2)
}

/**
 * 이 SHA 가 「이 PR 의 head 가 된」 시각의 보수적 하한 — 다음의 최댓값(4R P1: SHA 전역
 * check-suite 시각만 보면 타 브랜치에서 이미 검사를 돌린 커밋을 force-push 로 head 에 앉혀
 * 낡은 👍 를 통과시킬 수 있다):
 *   (a) SHA 의 check-suite 최초 생성(서버 기록) — 부재 시 committer date 폴백(차선)
 *   (b) PR 타임라인의 마지막 head_ref_force_pushed 이벤트 시각(서버 기록)
 * 일반 push 로 기존 커밋을 head 에 앉히는 변형은 남는다 — §위협 모델(사고 방지) 범위에서
 * 수용하고, SHA-결속 신호(공식 리뷰 commit_id)가 항상 우선 경로다.
 */
function headArrivalTime(gh, base, pr, headSha) {
  const candidates = []
  // 조회 실패는 gh 헬퍼가 fail-closed(exit 2) — allowFail 로 삼키면 「성공·suite 없음」과
  // 「요청 실패」가 구분되지 않아 작성자 통제 시각(committer date)으로 조용히 강등된다(6R P1).
  const suites = gh([
    'api',
    `${base}/commits/${headSha}/check-suites`,
    '--jq',
    '[.check_suites[].created_at] | sort | .[0] // empty',
  ])
  const first = suites?.trim()
  if (first && /^\d{4}-\d{2}-\d{2}T/.test(first)) candidates.push(first)
  else {
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
    candidates.push(committed)
  }
  const forced = latestTimelineEvent(gh, base, pr, 'head_ref_force_pushed')
  if (forced) candidates.push(forced)
  return candidates.sort().at(-1)
}

/**
 * PR 타임라인에서 해당 이벤트의 마지막 시각(서버 기록)을 반환한다. 없으면 null.
 * --paginate 는 jq 를 페이지별로 평가하므로(7R P1) last 집계를 jq 에 맡기면 페이지당
 * 한 줄씩 나온다 — 시각을 전부 방출하고 최댓값 선택은 JS 에서 한다.
 */
function latestTimelineEvent(gh, base, pr, event) {
  const times = gh([
    'api',
    `${base}/issues/${pr}/timeline`,
    '--paginate',
    '--jq',
    `.[] | select(.event == "${event}") | .created_at`,
  ])
  const valid = times
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^\d{4}-\d{2}-\d{2}T/.test(t))
  return valid.sort().at(-1) ?? null
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('require-codex-review.mjs')
) {
  try {
    main()
  } catch (e) {
    // 미처리 예외의 exit 1 은 차단(exit 2)이 아니라 우회다(20R P1: 범위 밖 \U 이스케이프가
    // 정규화에서 throw → 게이트 전체 무력화) — 어떤 실패도 fail-closed 로 끝낸다.
    console.error(`[codex-gate] 내부 오류 — fail-closed 차단. ${e?.message ?? e}`)
    process.exit(2)
  }
}
