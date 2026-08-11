// scripts/require-codex-review.test.ts
// PreToolUse 머지 게이트의 명령 해석 계약(Codex PR#288 P1① 회귀 고정).
// 원 결함: 위치 정규식이 `--squash` 를 타깃으로 삼켜 pr=null(현재 브랜치 오검증),
// `gh -R … pr merge` 는 아예 미매치(우회). 해석 불능은 미탐이 아니라 ambiguous(fail-closed).
import { describe, it, expect } from 'vitest'
import {
  parseGhMerge,
  parseHookInput,
  tokenizeSegments,
} from '../.claude/hooks/require-codex-review.mjs'

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })

describe('parseGhMerge — 타깃 해석', () => {
  it('플래그가 앞에 와도 번호를 잡는다 (원 결함: --squash 를 타깃으로 삼킴)', () => {
    expect(parseGhMerge('gh pr merge --squash 222')).toMatchObject({
      isMerge: true,
      pr: 222,
      ambiguous: null,
    })
  })
  it('번호가 플래그 앞에 와도 동일', () => {
    expect(parseGhMerge('gh pr merge 222 --squash --delete-branch')).toMatchObject({ pr: 222 })
  })
  it('`#288`·따옴표 감싼 번호도 잡는다', () => {
    expect(parseGhMerge('gh pr merge "#288" -s')).toMatchObject({ pr: 288 })
  })
  it('-R 전역 플래그의 repo 를 추출한다 (원 결함: 전역 플래그 형태는 미매치 = 우회)', () => {
    expect(parseGhMerge('gh -R pdw96/fleet pr merge 5 --squash')).toMatchObject({
      isMerge: true,
      pr: 5,
      repo: 'pdw96/fleet',
    })
  })
  it('서브커맨드 사이·뒤의 -R/--repo= 도 존중한다', () => {
    expect(parseGhMerge('gh pr -R o/r merge 7')).toMatchObject({ pr: 7, repo: 'o/r' })
    expect(parseGhMerge('gh pr merge 7 --repo=o/r')).toMatchObject({ pr: 7, repo: 'o/r' })
  })
  it('URL 타깃에서 repo·번호를 함께 추출한다', () => {
    expect(
      parseGhMerge('gh pr merge https://github.com/pdw96/fleet/pull/288 --squash'),
    ).toMatchObject({
      pr: 288,
      repo: 'pdw96/fleet',
    })
  })
  it('브랜치 타깃은 target 으로 넘긴다(번호 아님 — gh pr view 해석 대상)', () => {
    expect(parseGhMerge('gh pr merge feature/x --merge')).toMatchObject({
      isMerge: true,
      pr: null,
      target: 'feature/x',
    })
  })
  it('값 플래그의 값을 타깃으로 오인하지 않는다', () => {
    expect(parseGhMerge('gh pr merge --subject fix --match-head-commit abc123 9')).toMatchObject({
      pr: 9,
      ambiguous: null,
    })
  })
})

describe('parseGhMerge — fail-closed 경계', () => {
  it('미지 플래그는 미탐이 아니라 ambiguous', () => {
    const r = parseGhMerge('gh pr merge --mystery-flag 5')
    expect(r.isMerge).toBe(true)
    expect(r.ambiguous).not.toBeNull()
  })
  it('미지 전역 플래그가 서브커맨드를 가려도 느슨 센서가 잡는다(우회 불가)', () => {
    const r = parseGhMerge('gh --hostname github.com pr merge 5')
    expect(r.isMerge).toBe(true)
    expect(r.ambiguous).not.toBeNull()
  })
  it('비머지 gh 명령은 통과한다', () => {
    expect(parseGhMerge('gh pr view 288 --json number').isMerge).toBe(false)
    expect(parseGhMerge('gh pr create --title x').isMerge).toBe(false)
    expect(parseGhMerge('git merge main').isMerge).toBe(false)
  })
  it('인용 문자열 안의 머지 명령 문구는 오탐하지 않는다(PR#288 생성 시 실사고)', () => {
    expect(parseGhMerge('gh pr create --body "예: gh pr merge 5 는 차단된다"').isMerge).toBe(false)
    expect(parseGhMerge("echo 'gh pr merge 1'").isMerge).toBe(false)
  })
  it('복합 명령의 한 세그먼트에 있는 머지는 잡는다', () => {
    expect(parseGhMerge('git push && gh pr merge 42 --squash')).toMatchObject({ pr: 42 })
  })
})

describe('parseHookInput — 비 CLI 경로', () => {
  it('REST pulls/N/merge 를 잡고 repos/ 경로의 repo 도 추출한다', () => {
    expect(parseHookInput(bash('gh api repos/pdw96/fleet/pulls/240/merge -X PUT'))).toMatchObject({
      isMerge: true,
      pr: 240,
      repo: 'pdw96/fleet',
    })
    expect(
      parseHookInput(bash('gh api "repos/{owner}/{repo}/pulls/9/merge" -X PUT')),
    ).toMatchObject({
      isMerge: true,
      pr: 9,
      repo: null,
    })
  })
  it('MCP merge_pull_request 입력에서 번호·repo 를 읽는다', () => {
    expect(
      parseHookInput({
        tool_name: 'mcp__plugin_github_github__merge_pull_request',
        tool_input: { owner: 'pdw96', repo: 'fleet', pull_number: 240 },
      }),
    ).toMatchObject({ isMerge: true, pr: 240, repo: 'pdw96/fleet', ambiguous: null })
  })
  it('Bash 아닌 비머지 도구는 통과', () => {
    expect(parseHookInput({ tool_name: 'Read', tool_input: { file_path: 'x' } }).isMerge).toBe(
      false,
    )
  })
})

describe('tokenizeSegments — 근사 셸 시맨틱', () => {
  it('따옴표 블록을 한 토큰으로 접는다', () => {
    expect(tokenizeSegments('a "b c" d')).toEqual([['a', 'b c', 'd']])
  })
  it('연산자·개행이 세그먼트를 가른다', () => {
    expect(tokenizeSegments('a && b; c\nd')).toEqual([['a'], ['b'], ['c'], ['d']])
  })
})
