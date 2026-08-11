// scripts/require-codex-review.test.ts
// PreToolUse 머지 게이트의 판정 계약(Codex PR#288 1R~3R P1 회귀 고정).
// 설계 = canonical allowlist: 머지 능력 신호(hasMergeSignal)가 있는 명령은 정확히 한 형태
// (`gh pr merge …` 단일 세그먼트)만 merge 로 분류하고, 그 외는 전부 blocked(fail-closed).
// 1R~3R 이 찾은 우회(플래그 삼킴·-R 미매치·서브셸·다중 머지·cd·인터프리터·이중따옴표 치환·
// export 전파·REST/GraphQL·gh.exe)는 개별 탐지 없이 이 구조가 일괄 차단함을 여기서 고정한다.
import { describe, it, expect } from 'vitest'
import {
  hasMergeSignal,
  parseCanonicalMerge,
  classifyHookInput,
  tokenizeSegments,
} from '../.claude/hooks/require-codex-review.mjs'

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
const classify = (cmd: string) => classifyHookInput(bash(cmd))

describe('hasMergeSignal — 게이트 발동 조건(raw 스캔·미탐 불가)', () => {
  it('gh+merge 조합이면 인용·치환·래퍼 안이라도 발동한다', () => {
    for (const cmd of [
      'gh pr merge 5',
      'echo "$(gh pr merge 222 --squash)"', // 3R: 이중따옴표 치환
      "env bash -c 'gh pr merge 222 --squash'", // 3R: 래퍼 경유 인터프리터
      'export GH_REPO=o/r; gh pr merge 222', // 3R: env 전파
      'cd /other && gh api -X PUT repos/{owner}/{repo}/pulls/222/merge', // 3R: cd+REST
      "gh api graphql -f query='mutation { mergePullRequest(input: {}) {} }'", // 3R: GraphQL
      'gh.exe pr merge 222 --squash', // 3R: Windows 표기
      'git push origin x:y && gh pr merge 222', // 3R: TOCTOU 복합 명령
      "g''h pr m''erge 222 --squash", // 4R: 인용 분절 연결(셸이 조각을 이어 실행)
      'g"h" pr "m"erge 222', // 4R: 이중따옴표 분절
      'g\\h pr mer\\ge 222 --squash', // 5R: 백슬래시 분절(셸이 \ 를 제거하고 실행)
      'gh pr m\\\nerge 222 --squash', // 8R: 연속행 분절(셸이 \-개행 쌍을 제거하고 실행)
      "g$'h' pr m$'erge' 222 --squash", // 9R: ANSI-C 인용 분절
    ])
      expect(hasMergeSignal(cmd), cmd).toBe(true)
  })
  it('머지·gh 무관 명령은 발동하지 않는다', () => {
    for (const cmd of [
      'git merge main', // merge 있으나 gh/github 없음
      'gh pr view 288 --json number', // gh 있으나 merge 없음
      'gh pr create --title x',
      'npm run verify',
      'echo high merger', // "high"의 gh 는 단어 경계 밖
    ])
      expect(hasMergeSignal(cmd), cmd).toBe(false)
  })
})

describe('parseCanonicalMerge — 허용되는 단일 형태', () => {
  it('플래그가 타깃 앞에 와도 번호를 잡는다 (1R 원 결함: --squash 를 타깃으로 삼킴)', () => {
    expect(parseCanonicalMerge('gh pr merge --squash 222')).toMatchObject({ pr: 222 })
  })
  it('인용된 "#N"·값 플래그 혼재를 해석한다', () => {
    expect(parseCanonicalMerge('gh pr merge "#288" -s')).toMatchObject({ pr: 288 })
    expect(
      parseCanonicalMerge('gh pr merge --subject fix --match-head-commit abc 9'),
    ).toMatchObject({ pr: 9, matchHead: 'abc' })
  })
  it('비인용 #N 은 셸 주석 — 실제 실행과 동일하게 현재 브랜치 머지로 해석한다 (5R P1)', () => {
    // bash 는 `#222` 이후를 버리고 `gh pr merge --squash` 만 실행한다. 파서가 222 를 읽으면
    // 검증 대상(222)과 실행 대상(현재 브랜치)이 갈라진다 — 주석 시맨틱으로 일치시킨다.
    expect(parseCanonicalMerge('gh pr merge --squash #222 --match-head-commit abc')).toMatchObject({
      pr: null,
      target: null,
      matchHead: null,
    })
  })
  it('-R 전역·중간·`=` 형을 존중한다 (1R 원 결함: 전역 플래그 형태 미매치 = 우회)', () => {
    expect(parseCanonicalMerge('gh -R pdw96/fleet pr merge 5 --squash')).toMatchObject({
      pr: 5,
      repo: 'pdw96/fleet',
    })
    expect(parseCanonicalMerge('gh pr merge 7 --repo=o/r')).toMatchObject({ pr: 7, repo: 'o/r' })
  })
  it('URL 타깃에서 repo·번호를 함께 추출한다 — URL 레포가 권위(-R 동일 지정은 허용)', () => {
    expect(
      parseCanonicalMerge('gh pr merge https://github.com/pdw96/fleet/pull/288 --squash'),
    ).toMatchObject({ pr: 288, repo: 'pdw96/fleet' })
    expect(
      parseCanonicalMerge('gh pr merge https://github.com/pdw96/fleet/pull/288 -R pdw96/fleet'),
    ).toMatchObject({ pr: 288, repo: 'pdw96/fleet' })
  })
  it('bare gh.exe·대소문자는 허용, 경로 지정 실행은 배제한다 (3R·4R P1)', () => {
    expect(parseCanonicalMerge('gh.exe pr merge 222 --squash')).toMatchObject({ pr: 222 })
    expect(parseCanonicalMerge('GH.EXE pr merge 222')).toMatchObject({ pr: 222 })
    // 경로 실행 파일은 PATH 의 gh 로 검증하고 딴 바이너리가 실행되는 불일치 가능 → null
    expect(parseCanonicalMerge('/tmp/gh pr merge 222 --match-head-commit abc')).toBeNull()
    expect(parseCanonicalMerge('C:/tools/GH.EXE pr merge 222')).toBeNull()
  })
  it('브랜치 타깃은 target 으로 넘긴다', () => {
    expect(parseCanonicalMerge('gh pr merge feature/x --merge')).toMatchObject({
      pr: null,
      target: 'feature/x',
    })
  })
  it('--match-head-commit 값을 추출한다 (3R P1: TOCTOU 서버측 봉쇄의 입력)', () => {
    expect(parseCanonicalMerge('gh pr merge 5 -s --match-head-commit deadbeef')).toMatchObject({
      matchHead: 'deadbeef',
    })
  })
})

describe('parseCanonicalMerge — 형태 이탈은 전부 null(차단)', () => {
  it.each([
    ['복합 명령(TOCTOU 포함)', 'git push origin x:y && gh pr merge 222 --squash'],
    [
      '첫 세그먼트가 canonical 인 복합 명령(2R 다중 머지 재발 방지)',
      'gh pr merge 1 --squash && gh pr merge 2 --squash',
    ],
    ['canonical 머지 뒤 잉여 세그먼트', 'gh pr merge 5 --squash; echo done'],
    ['서브셸', '(gh pr merge 5 --squash)'],
    ['명령치환(이중따옴표 포함)', 'echo "$(gh pr merge 222 --squash)"'],
    ['인터프리터 경유', "sh -c 'gh pr merge 5'"],
    ['래퍼+인터프리터', "env bash -c 'gh pr merge 222'"],
    ['env 대입 선행', 'GH_REPO=o/r gh pr merge 5'],
    ['export 선행', 'export GH_REPO=o/r; gh pr merge 222'],
    ['cd 선행', 'cd /other && gh pr merge 222'],
    ['미지 플래그', 'gh pr merge --mystery-flag 5'],
    ['미지 전역 플래그', 'gh --hostname ghe.example pr merge 5'],
    ['셸 확장 타깃', 'gh pr merge $PR'],
    [
      '비 github.com URL 타깃(엔터프라이즈 호스트 낙하 방지)',
      'gh pr merge https://ghe.example/o/r/pull/9',
    ],
    ['--auto 이연 머지(일회 검증 게이트와 양립 불가)', 'gh pr merge 5 --auto --squash'],
    [
      '--admin 관리자 우회(플랫폼 사전 게이트와 상충)',
      'gh pr merge 5 --admin --match-head-commit abc',
    ],
    [
      'URL 과 -R 이 다른 레포(gh 는 URL 우선 — 검증·실행 분열)',
      'gh pr merge https://github.com/o/other/pull/9 -R pdw96/fleet --match-head-commit abc',
    ],
    ['잉여 인자', 'gh pr merge 5 6'],
    ['REST 경유', 'gh api -X PUT repos/pdw96/fleet/pulls/240/merge'],
    ['GraphQL 경유', "gh api graphql -f query='mutation { mergePullRequest(input: {}) {} }'"],
  ])('%s', (_label, cmd) => {
    expect(parseCanonicalMerge(cmd)).toBeNull()
  })
})

describe('classifyHookInput — 3분류(pass/blocked/merge)', () => {
  it('신호 없는 명령·비 Bash 도구는 pass', () => {
    expect(classify('git merge main')).toEqual({ kind: 'pass' })
    expect(classifyHookInput({ tool_name: 'Read', tool_input: { file_path: 'x' } })).toEqual({
      kind: 'pass',
    })
  })
  it('본문이 명령 밖인 GraphQL 은 신호 없어도 blocked — 관측 불가(9R P1)', () => {
    expect(classify('gh api graphql --input /tmp/q.json').kind).toBe('blocked')
    expect(classify('gh api graphql --input=- -H x').kind).toBe('blocked')
    expect(classify('gh api graphql -f query="$Q"').kind).toBe('blocked')
    // 인라인 리터럴 본문(변수·--input 없음)은 신호 스캔 담당 — 비병합 쿼리는 pass
    expect(classify("gh api graphql -f query='query { viewer { login } }'").kind).toBe('pass')
  })
  it('엔드포인트가 명령 밖인 변이 REST 는 신호 없어도 blocked — 관측 불가(11R P1)', () => {
    expect(classify('. /tmp/endpoint.env && gh api -X PUT "$ENDPOINT"').kind).toBe('blocked')
    expect(classify('gh api --method=PUT "$E"').kind).toBe('blocked')
    expect(classify('gh api -X DELETE $E').kind).toBe('blocked')
    // 리터럴 경로 GET·리터럴 경로 변이(비병합 — 병합 경로는 신호 스캔 담당)는 pass
    expect(classify('gh api repos/pdw96/fleet/pulls/288/comments --paginate').kind).toBe('pass')
    expect(classify('gh api repos/pdw96/fleet/issues -f title=hi').kind).toBe('pass')
  })
  it('신호 있으나 canonical 아님 = blocked (인용 오탐도 미탐 아닌 차단 쪽)', () => {
    expect(classify('gh pr create --body "예: gh pr merge 5 는 차단된다"').kind).toBe('blocked')
    expect(classify('gh api -X PUT repos/pdw96/fleet/pulls/240/merge').kind).toBe('blocked')
  })
  it('canonical 머지는 merge 로 분류된다', () => {
    expect(classify('gh pr merge 222 --squash --match-head-commit abc')).toMatchObject({
      kind: 'merge',
      pr: 222,
      matchHead: 'abc',
      viaMcp: false,
    })
  })
  it('MCP merge_pull_request 는 구조화 입력으로 분류된다(sha 는 main 에서 필수 강제)', () => {
    expect(
      classifyHookInput({
        tool_name: 'mcp__plugin_github_github__merge_pull_request',
        tool_input: { owner: 'pdw96', repo: 'fleet', pull_number: 240, sha: 'abc' },
      }),
    ).toMatchObject({ kind: 'merge', pr: 240, repo: 'pdw96/fleet', matchHead: 'abc', viaMcp: true })
    expect(
      classifyHookInput({
        tool_name: 'mcp__plugin_github_github__merge_pull_request',
        tool_input: { owner: 'pdw96', repo: 'fleet' },
      }).kind,
    ).toBe('blocked')
  })
})

describe('tokenizeSegments — 근사 셸 시맨틱', () => {
  it('따옴표 블록을 한 토큰으로 접는다', () => {
    expect(tokenizeSegments('a "b c" d')).toEqual([['a', 'b c', 'd']])
  })
  it('연산자·개행·그룹핑이 세그먼트를 가른다', () => {
    expect(tokenizeSegments('a && b; c\nd')).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(tokenizeSegments('(a b) `c`')).toEqual([['a', 'b'], ['c']])
  })
})
