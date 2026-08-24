#!/usr/bin/env node
// SessionStart 훅 — 원격 세션(Claude Code on the web)에서 npm 의존성을 설치해
// `npm run verify` 를 **실행 가능한 상태**로 만든다.
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

process.stderr.write('[session-start] 완료 — `npm run verify` 사용 가능\n')
