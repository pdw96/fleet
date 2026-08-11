// scripts/require-codex-review.test.ts
// PreToolUse 머지 게이트의 판정 계약(Codex PR#288 1R~3R P1 회귀 고정).
// 설계 = canonical allowlist: 머지 능력 신호(hasMergeSignal)가 있는 명령은 정확히 한 형태
// (`gh pr merge …` 단일 세그먼트)만 merge 로 분류하고, 그 외는 전부 blocked(fail-closed).
// 1R~3R 이 찾은 우회(플래그 삼킴·-R 미매치·서브셸·다중 머지·cd·인터프리터·이중따옴표 치환·
// export 전파·REST/GraphQL·gh.exe)는 개별 탐지 없이 이 구조가 일괄 차단함을 여기서 고정한다.
import { describe, it, expect } from 'vitest'
import {
  hasMergeSignal,
  hasMergeWord,
  aliasIsSuspect,
  stripShellExpansions,
  parseAliasList,
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
      'gh api -X PUT repos/o/r/pulls/222/m%65rge', // 14R: 퍼센트 인코딩 REST 경로
      'g${EMPTY}h pr mer${EMPTY}ge 222 --squash', // 15R: 미설정 변수 확장 분절
      "$'\\x67\\x68' pr $'\\x6d\\x65\\x72\\x67\\x65' 222 --squash", // 16R: ANSI-C \xHH 확장
      'g$@h pr mer$@ge 222 --squash', // 17R: 위치 매개변수 분절(무인자 시 빈 확장)
      'g$*h pr mer$1ge 222 --squash', // 17R: $*·$N 변형
      "$'\\U00000067\\U00000068' pr $'\\U0000006d\\U00000065\\U00000072\\U00000067\\U00000065' 5", // 19R: 8자리 \U
      'g{h..h} pr mer{g..g}e 222 --squash', // 20R: 단일문자 brace 분절
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
      '값 플래그의 셸 확장(워드 분할로 --auto 주입 가능)',
      'gh pr merge 5 --body $BODY --match-head-commit abc',
    ],
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
    // 타입 필드의 @ 값은 파일/stdin 주입(12R P1) — 붙임 표기 포함 차단
    expect(classify('gh api graphql -F query=@/tmp/m.graphql').kind).toBe('blocked')
    expect(classify('gh api graphql -Fquery=@/tmp/m.graphql').kind).toBe('blocked')
    // 인라인 리터럴 본문(변수·--input 없음)은 신호 스캔 담당 — 비병합 쿼리는 pass
    expect(classify("gh api graphql -f query='query { viewer { login } }'").kind).toBe('pass')
  })
  it('엔드포인트가 명령 밖인 변이 REST 는 신호 없어도 blocked — 관측 불가(11R P1)', () => {
    expect(classify('. /tmp/endpoint.env && gh api -X PUT "$ENDPOINT"').kind).toBe('blocked')
    expect(classify('gh api --method=PUT "$E"').kind).toBe('blocked')
    expect(classify('gh api -X DELETE $E').kind).toBe('blocked')
    // 붙임 표기(-XPUT)도 변이로 해석해야 한다(12R P1)
    expect(classify('. /tmp/endpoint.env && gh api -XPUT "$ENDPOINT"').kind).toBe('blocked')
    // 리터럴 경로 GET·리터럴 경로 변이(비병합 — 병합 경로는 신호 스캔 담당)는 pass
    expect(classify('gh api repos/pdw96/fleet/pulls/288/comments --paginate').kind).toBe('pass')
    expect(classify('gh api repos/pdw96/fleet/issues -f title=hi').kind).toBe('pass')
    // 판정 기준은 엔드포인트 토큰 — 필드 값의 $ 는 본문 내용(자기 오탐 실측)
    expect(classify('gh api repos/o/r/issues/1/comments -F "body=@$DIR/x.md"').kind).toBe('pass')
  })
  it('변이 REST 의 {branch} 류 플레이스홀더는 blocked — 브랜치명이 merge 일 수 있다(16R P1)', () => {
    expect(classify('gh api -X PUT repos/pdw96/fleet/pulls/222/{branch}').kind).toBe('blocked')
    // {owner}/{repo} 는 레포 스코프 치환이라 리터럴 취급 유지(비병합 경로 pass)
    expect(classify('gh api repos/{owner}/{repo}/issues -f title=hi').kind).toBe('pass')
  })
  it('hasMergeWord — 셸 alias 확장의 분절 표기도 잡는다(16R P1)', () => {
    expect(hasMergeWord('!gh pr m\'\'erge "$@"')).toBe(true)
    expect(hasMergeWord('pr merge')).toBe(true)
    expect(hasMergeWord('pr view')).toBe(false)
  })
  it('stripShellExpansions — alias 이행 대조용 정규화(17R P1)', () => {
    // `!gh p''x "$@"` 안의 분절 참조 p''x 가 px 토큰으로 복원돼 이행 전파가 잇는다
    expect(stripShellExpansions('!gh p\'\'x "$@"').split(/\s+/)).toContain('px')
    expect(stripShellExpansions('g$@h pr mer$@ge')).toBe('gh pr merge')
  })
  it('gh 호출의 비인용 $ 확장은 blocked — 워드 분할 주입(19R P1), 인용 확장 값은 pass', () => {
    // ARGS='o/r pr merge' 면 비인용 확장이 서브커맨드까지 주입한다
    expect(classify('gh -R $ARGS 222 --squash').kind).toBe('blocked')
    // 인용 확장은 워드 분할 불가 — 값 위치는 허용(기존 -F "body=@$DIR" pass 와 일관)
    expect(classify('gh api repos/o/r/issues/1/comments -F "body=@$DIR/x.md"').kind).toBe('pass')
  })
  it('범위 밖 \\U 이스케이프에 throw 하지 않는다(20R P1 — 크래시 exit 1 = 우회)', () => {
    expect(() => hasMergeSignal("gh pr merge 222 --body $'\\UFFFFFFFF' --squash")).not.toThrow()
    expect(hasMergeSignal("gh pr merge 222 --body $'\\UFFFFFFFF' --squash")).toBe(true)
  })
  it('curl 등 gh 외 클라이언트의 불투명 GitHub GraphQL 본문은 blocked(20R P1)', () => {
    expect(
      classify('curl -X POST https://api.github.com/graphql --data-binary @/tmp/q.json').kind,
    ).toBe('blocked')
    expect(classify('curl https://api.github.com/graphql -d "$Q"').kind).toBe('blocked')
    expect(classify('curl https://example.com/x -d @f.json').kind).toBe('pass')
  })
  it('혼합 인용 확장("$EMPTY"$ARGS)의 비인용 부분을 잡는다(20R P1)', () => {
    expect(classify('gh -R "$EMPTY"$ARGS 222 --squash').kind).toBe('blocked')
  })
  it('aliasIsSuspect — 동적 동사 alias 는 정적 증명 불가로 의심 처리(20R P1)', () => {
    expect(aliasIsSuspect('!gh pr "$ACTION" "$@"')).toBe(true)
    expect(aliasIsSuspect('pr view "$@"')).toBe(false) // 위치 전달만은 무해
    expect(aliasIsSuspect('pr merge')).toBe(true)
  })
  it('parseAliasList — 다중행(`|-`) 확장을 이어붙인다(19R P1)', () => {
    const m = parseAliasList('pm: |-\n  echo prep\n  gh pr merge "$@"\npx: pr view')
    expect(m.get('pm')?.exp).toContain('merge')
    expect(m.get('px')?.exp).toBe('pr view')
  })
  it('서브커맨드 자리의 셸 확장은 blocked — 병합 동사 은닉 가능(13R P1)', () => {
    expect(classify('. /tmp/action.env && gh pr $ACTION 222 --squash').kind).toBe('blocked')
    expect(classify('gh $CMD 222 --squash').kind).toBe('blocked')
    // 19R 전면 규칙으로 비인용 $ 는 GET 엔드포인트라도 차단(워드 분할 주입 가능) —
    // 인용하면 분할 불가라 통과(값 위치 인용 확장 허용과 일관)
    expect(classify('gh api repos/$OWNER/r/issues --paginate').kind).toBe('blocked')
    expect(classify('gh api "repos/$OWNER/r/issues" --paginate').kind).toBe('pass')
  })
  it('enqueuePullRequest mutation 은 merge 단어 없이도 신호 발동 — blocked(13R P1)', () => {
    expect(
      classify("gh api graphql -f query='mutation { enqueuePullRequest(input: {}) {} }'").kind,
    ).toBe('blocked')
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
  it('타깃 생략·브랜치명 타깃은 blocked — 이중 해석 레이스(15R P1)', () => {
    // hook 해석과 실행 시점 해석 사이에 워크트리가 다른 PR 로 이동할 수 있다(같은 head 면
    // SHA 가드도 통과) — 안정 식별자(번호·URL)만 허용.
    expect(classify('gh pr merge --squash --match-head-commit abc').kind).toBe('blocked')
    expect(classify('gh pr merge feature/x --merge --match-head-commit abc').kind).toBe('blocked')
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
