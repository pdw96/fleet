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
  it('`#N`·따옴표 번호·값 플래그 혼재를 해석한다', () => {
    expect(parseCanonicalMerge('gh pr merge "#288" -s')).toMatchObject({ pr: 288 })
    expect(
      parseCanonicalMerge('gh pr merge --subject fix --match-head-commit abc 9'),
    ).toMatchObject({ pr: 9, matchHead: 'abc' })
  })
  it('-R 전역·중간·`=` 형을 존중한다 (1R 원 결함: 전역 플래그 형태 미매치 = 우회)', () => {
    expect(parseCanonicalMerge('gh -R pdw96/fleet pr merge 5 --squash')).toMatchObject({
      pr: 5,
      repo: 'pdw96/fleet',
    })
    expect(parseCanonicalMerge('gh pr merge 7 --repo=o/r')).toMatchObject({ pr: 7, repo: 'o/r' })
  })
  it('URL 타깃에서 repo·번호를 함께 추출한다', () => {
    expect(
      parseCanonicalMerge('gh pr merge https://github.com/pdw96/fleet/pull/288 --squash'),
    ).toMatchObject({ pr: 288, repo: 'pdw96/fleet' })
  })
  it('gh.exe·경로 표기를 정규화한다 (3R P1: bare gh.exe 미탐)', () => {
    expect(parseCanonicalMerge('gh.exe pr merge 222 --squash')).toMatchObject({ pr: 222 })
    expect(parseCanonicalMerge('C:/tools/GH.EXE pr merge 222')).toMatchObject({ pr: 222 })
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
  it('MCP merge_pull_request 는 구조화 입력으로 분류된다(sha 있으면 동반)', () => {
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
