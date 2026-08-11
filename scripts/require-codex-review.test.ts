// scripts/require-codex-review.test.ts
// PreToolUse 머지 게이트의 명령 해석 계약(Codex PR#288 1R P1①·2R P1 회귀 고정).
// 1R 원 결함: 위치 정규식이 `--squash` 를 타깃으로 삼켜 pr=null(현재 브랜치 오검증),
// `gh -R … pr merge` 는 아예 미매치(우회). 2R 원 결함: 서브셸/복합 명령 다중 머지/cd 후
// 상대 해석 미탐. 해석 불능은 미탐이 아니라 ambiguous(fail-closed)가 계약이다.
import { describe, it, expect } from 'vitest'
import {
  parseMergeAttempts,
  parseHookInput,
  tokenizeSegments,
} from '../.claude/hooks/require-codex-review.mjs'

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
const one = (cmd: string) => {
  const attempts = parseMergeAttempts(cmd)
  expect(attempts).toHaveLength(1)
  return attempts[0]
}

describe('parseMergeAttempts — 타깃 해석', () => {
  it('플래그가 앞에 와도 번호를 잡는다 (1R 원 결함: --squash 를 타깃으로 삼킴)', () => {
    expect(one('gh pr merge --squash 222')).toMatchObject({ pr: 222, ambiguous: null })
  })
  it('번호가 플래그 앞에 와도 동일', () => {
    expect(one('gh pr merge 222 --squash --delete-branch')).toMatchObject({ pr: 222 })
  })
  it('`#288`·따옴표 감싼 번호도 잡는다', () => {
    expect(one('gh pr merge "#288" -s')).toMatchObject({ pr: 288 })
  })
  it('-R 전역 플래그의 repo 를 추출한다 (1R 원 결함: 전역 플래그 형태는 미매치 = 우회)', () => {
    expect(one('gh -R pdw96/fleet pr merge 5 --squash')).toMatchObject({
      pr: 5,
      repo: 'pdw96/fleet',
    })
  })
  it('서브커맨드 사이·뒤의 -R/--repo= 도 존중한다', () => {
    expect(one('gh pr -R o/r merge 7')).toMatchObject({ pr: 7, repo: 'o/r' })
    expect(one('gh pr merge 7 --repo=o/r')).toMatchObject({ pr: 7, repo: 'o/r' })
  })
  it('URL 타깃에서 repo·번호를 함께 추출한다', () => {
    expect(one('gh pr merge https://github.com/pdw96/fleet/pull/288 --squash')).toMatchObject({
      pr: 288,
      repo: 'pdw96/fleet',
    })
  })
  it('브랜치 타깃은 target 으로 넘긴다(번호 아님 — gh pr view 해석 대상)', () => {
    expect(one('gh pr merge feature/x --merge')).toMatchObject({ pr: null, target: 'feature/x' })
  })
  it('값 플래그의 값을 타깃으로 오인하지 않는다', () => {
    expect(one('gh pr merge --subject fix --match-head-commit abc123 9')).toMatchObject({
      pr: 9,
      ambiguous: null,
    })
  })
})

describe('parseMergeAttempts — 2R 우회 폐쇄', () => {
  it('서브셸로 감싼 머지를 잡는다 (2R 원 결함: `(gh` 토큰으로 미탐)', () => {
    expect(one('(gh pr merge 5 --squash)')).toMatchObject({ pr: 5, ambiguous: null })
  })
  it('백틱·$() 명령치환 안의 머지도 잡는다', () => {
    expect(one('echo `gh pr merge 6 -s`')).toMatchObject({ pr: 6 })
    expect(one('echo $(gh pr merge 8 -s)')).toMatchObject({ pr: 8 })
  })
  it('복합 명령의 모든 머지 시도를 수집한다 (2R 원 결함: 첫 시도만 검증)', () => {
    const attempts = parseMergeAttempts('gh pr merge 1 --squash && gh pr merge 2 --squash')
    expect(attempts.map((a: { pr: number | null }) => a.pr)).toEqual([1, 2])
  })
  it('cd 이후 repo 미지정 머지는 ambiguous (2R 원 결함: hook cwd 와 셸 cwd 가 다름)', () => {
    const a = one('cd /workspace/other && gh pr merge 222')
    expect(a.ambiguous).not.toBeNull()
  })
  it('cd 이후라도 -R 명시면 통과(레포가 핀됨)', () => {
    expect(one('cd /workspace/other && gh pr merge 222 -R pdw96/fleet')).toMatchObject({
      pr: 222,
      repo: 'pdw96/fleet',
      ambiguous: null,
    })
  })
  it('인터프리터(sh -c) 경유 머지를 재귀 해석으로 잡는다', () => {
    expect(one("sh -c 'gh pr merge 5 --squash'")).toMatchObject({ pr: 5 })
  })
  it('GH_REPO/GH_HOST env 리다이렉트는 ambiguous', () => {
    expect(one('GH_REPO=o/r gh pr merge 5').ambiguous).not.toBeNull()
    expect(one('GH_HOST=ghe.example gh pr merge 5').ambiguous).not.toBeNull()
  })
})

describe('parseMergeAttempts — fail-closed 경계', () => {
  it('미지 플래그는 미탐이 아니라 ambiguous', () => {
    expect(one('gh pr merge --mystery-flag 5').ambiguous).not.toBeNull()
  })
  it('미지 전역 플래그가 서브커맨드를 가려도 느슨 센서가 잡는다(우회 불가)', () => {
    expect(one('gh --hostname github.com pr merge 5').ambiguous).not.toBeNull()
  })
  it('비머지 gh 명령은 통과한다', () => {
    expect(parseMergeAttempts('gh pr view 288 --json number')).toEqual([])
    expect(parseMergeAttempts('gh pr create --title x')).toEqual([])
    expect(parseMergeAttempts('git merge main')).toEqual([])
  })
  it('인용 문자열 안의 머지 명령 문구는 오탐하지 않는다(PR#288 생성 시 실사고)', () => {
    expect(parseMergeAttempts('gh pr create --body "예: gh pr merge 5 는 차단된다"')).toEqual([])
    expect(parseMergeAttempts("echo 'gh pr merge 1'")).toEqual([])
  })
  it('복합 명령의 한 세그먼트에 있는 머지는 잡는다', () => {
    expect(one('git push && gh pr merge 42 --squash')).toMatchObject({ pr: 42 })
  })
})

describe('parseHookInput — 비 CLI 경로', () => {
  it('REST pulls/N/merge 를 잡고 repos/ 경로의 repo 도 추출한다', () => {
    expect(parseHookInput(bash('gh api repos/pdw96/fleet/pulls/240/merge -X PUT'))).toEqual([
      { pr: 240, repo: 'pdw96/fleet', target: null, ambiguous: null },
    ])
    expect(parseHookInput(bash('gh api "repos/{owner}/{repo}/pulls/9/merge" -X PUT'))).toEqual([
      { pr: 9, repo: null, target: null, ambiguous: null },
    ])
  })
  it('MCP merge_pull_request 입력에서 번호·repo 를 읽는다', () => {
    expect(
      parseHookInput({
        tool_name: 'mcp__plugin_github_github__merge_pull_request',
        tool_input: { owner: 'pdw96', repo: 'fleet', pull_number: 240 },
      }),
    ).toEqual([{ pr: 240, repo: 'pdw96/fleet', target: null, ambiguous: null }])
  })
  it('Bash 아닌 비머지 도구는 통과', () => {
    expect(parseHookInput({ tool_name: 'Read', tool_input: { file_path: 'x' } })).toEqual([])
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
