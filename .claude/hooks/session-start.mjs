#!/usr/bin/env node
// SessionStart 훅 — 원격 세션(Claude Code on the web)을 **작업 가능한 상태**로 만든다:
// ① npm 의존성 설치로 `npm run verify` 를 돌릴 수 있게, ② `gh` 설치로 머지 게이트가 검증을
// 수행할 수 있게. 둘 다 없으면 원격 세션은 자기 변경을 검증하지도, 머지하지도 못한다.
//
// ## 왜 필요한가
// 원격 컨테이너는 레포를 fresh clone 만 하고 `node_modules` 를 만들지 않는다. 그 상태에서는
// verify 7게이트 중 `skills:lint`·`brain:check`(순수 node)만 돌고 `format:check`·`typecheck`·
// `lint`·`test:coverage`·`build` 는 전부 실행 불가다 — 즉 **에이전트가 자기 변경을 검증하지 못한 채
// 커밋하게 된다**(2026-08-24 어드바이저 세션에서 실측: 문서 전용 변경이라 무해했으나, 코어 변경이면
// 무검증 커밋이 그대로 나갔을 상황).
//
// ## 경계
// - **로컬은 건드리지 않는다** — `CLAUDE_CODE_REMOTE !== 'true'` 면 즉시 종료. 이미 설치된 개발
//   머신에서 재설치가 도는 것을 막는다.
// - `npm ci` 가 아니라 `npm install` 을 쓴다 — `ci` 는 매번 `node_modules` 를 지우고 다시 받아
//   컨테이너 캐시 이점을 버린다. `install` 은 락파일과 트리가 같으면 사실상 no-op 이라 재실행이 싸다.
// - **Electron 바이너리는 받지 않는다**(`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) — verify 7게이트는
//   바이너리 없이 전부 통과한다(실측: 3009 tests · `electron-vite build` 포함). 바이너리가 필요한
//   것은 `npm run dev`·`dist`·`test:e2e` 뿐인데 원격 세션엔 디스플레이가 없어 어차피 못 돈다.
//   필요해지면 `npx electron install` 로 그 세션에서만 받는다.
// - `HUSKY=0` — 훅 설치는 세션 시작 시점에 불필요하고, 실패 시 설치 전체를 깨뜨릴 이유가 없다.
//
// ## 출력 규약
// SessionStart 훅의 stdout 은 세션 컨텍스트로 주입되므로 **npm 로그는 stderr 로 보낸다**.
// 설치 실패는 조용히 넘기지 않는다 — 비-0 종료로 사용자에게 보이게 한다(fail-loud). 세션 자체는
// 계속 시작되므로 차단이 아니라 신호다.

import { spawnSync } from 'node:child_process'

if (process.env['CLAUDE_CODE_REMOTE'] !== 'true') process.exit(0)

const cwd = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd()

process.stderr.write('[session-start] npm install (원격 세션 — verify 실행 가능 상태 확보)\n')

const r = spawnSync('npm', ['install', '--no-fund', '--no-audit'], {
  cwd,
  // stdout 을 stderr 로 접어 세션 컨텍스트 오염을 막는다.
  stdio: ['ignore', 2, 2],
  env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', HUSKY: '0' },
})

if (r.error) {
  process.stderr.write(`[session-start] npm 실행 실패: ${r.error.message}\n`)
  process.exit(1)
}
if (r.status !== 0) {
  process.stderr.write(
    `[session-start] npm install 실패(exit ${r.status}) — 이 세션에서는 typecheck·lint·test·build 를 돌릴 수 없다.\n`,
  )
  process.exit(r.status ?? 1)
}

// ── gh CLI 확보 ─────────────────────────────────────────────────────────────
//
// ## 왜 필요한가 — 부트스트랩 데드락
//
// 머지 게이트 훅(`require-codex-review.mjs`)은 Codex 신호를 **`gh` 로 조회해서** 검증하고,
// 조회에 실패하면 fail-closed 로 차단한다. 그런데 그 훅은 `gh` 토큰을 담은 명령을 전부
// 「gh 호출 가능성」으로 분류해 `gh alias list`(숨은 병합 alias 배제)를 먼저 돌린다 —
// **gh 가 없으면 그 조회부터 실패하므로, gh 를 설치하는 명령까지 차단된다.**
// 즉 원격 세션은 자력으로 이 상태를 벗어날 수 없다(2026-09-02 실측: PR#309 머지 시도에서
// `apt-get install -y gh` 가 같은 사유로 차단). 세션 시작 시 미리 깔아 그 고리를 끊는다.
//
// 게이트를 약화시키는 게 아니라 **게이트가 실제 검증을 수행할 수 있게** 하는 것이다 —
// gh 부재 상태의 차단은 「검증 결과 거부」가 아니라 「검증 불능」이었다.
//
// ## 경계
// - **실패는 fail-loud 하되 세션을 죽이지 않는다**(npm 과 다르다). gh 가 없어도 verify·개발은
//   전부 가능하고 막히는 건 머지뿐이라, 설치 실패로 세션 전체를 못 쓰게 만들 이유가 없다.
// - 이미 있으면 건너뛴다(컨테이너 상태는 훅 완료 후 캐시되므로 재실행이 사실상 무료).
// - apt 경로만 쓴다. 릴리스 tarball 폴백은 버전 핀·아치 분기·체크섬 검증이 따라오는데 이 세션에서
//   실행 검증할 수 없어 **미검증 코드**가 된다(PR#309 에서 얻은 교훈 — 실행할 수 없는 경로를
//   추측으로 쓰지 않는다). apt 가 실패하면 조치 방법을 문면으로 남긴다.
//
// ## 원격 세션의 gh 동작 — 실측(2026-09-02 · ubuntu 24.04 universe gh 2.45.0)
// 다음 세션이 오판하기 쉬운 지점이라 값으로 적어 둔다:
// - **`gh auth status` 는 「토큰 무효」로 보고하는데 실제 호출은 성공한다.** `GH_TOKEN` 은 14자
//   플레이스홀더이고 에이전트 프록시가 자격증명을 주입하기 때문이다(실측: `gh api user` → 계정명 반환).
//   그 표시를 보고 「gh 를 쓸 수 없다」고 결론내지 말 것.
// - **GraphQL 은 핀된 PR-리뷰 오퍼레이션 집합만 서빙된다.** `gh pr view --json …` 은 HTTP 403
//   (「use REST via gh api repos/…」)로 떨어지고, REST(`gh api repos/{owner}/{repo}/…`)는 정상이다.
//   GraphQL 에 의존하는 서브커맨드는 원격 세션에서 못 쓸 수 있다.
// - 따라서 이 설치가 여는 것은 **부트스트랩 데드락 해소**까지다. 원격 세션에서 머지가 끝까지
//   성립하는지는 **미검증** — 게이트의 조회 경로와 gh 머지 경로가 GraphQL 인지에 달려 있다.
const hasGh = spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0
if (hasGh) {
  process.stderr.write('[session-start] gh 이미 설치됨 — 건너뜀\n')
} else {
  process.stderr.write('[session-start] gh 설치 (머지 게이트가 Codex 신호 조회에 사용)\n')
  const apt = spawnSync('apt-get', ['install', '-y', '--no-install-recommends', 'gh'], {
    stdio: ['ignore', 2, 2],
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  })
  const ok = !apt.error && apt.status === 0
  if (!ok) {
    process.stderr.write(
      `[session-start] ⚠ gh 설치 실패(${apt.error?.message ?? `exit ${apt.status}`}) — verify·개발은 정상이나 ` +
        '이 세션에서 머지는 차단된다(게이트가 gh 로 검증한다). 웹 UI 머지 또는 로컬 `gh pr merge` 를 쓸 것.\n',
    )
  }
}

process.stderr.write('[session-start] 완료 — `npm run verify` 사용 가능\n')
