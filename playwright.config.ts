import { defineConfig } from '@playwright/test'

/**
 * Electron GUI e2e — vitest(단위/컴포넌트)와 분리된 별도 러너.
 * 테스트는 `out/` 의 빌드 산출물을 직접 실행하므로 `electron-vite build` 가 선행되어야 한다(test:e2e 스크립트).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // CI 에서만 재시도 — flaky 한 Electron 기동을 흡수하되 로컬은 즉시 실패로 빠른 피드백.
  retries: process.env.CI ? 2 : 0,
  // list = 로그 가독성, html(open:never) = 분리 워크플로 아티팩트(playwright-report/, gitignore).
  reporter: [['list'], ['html', { open: 'never' }]],
  // 재시도 발생 시에만 trace 수집(test-results/, gitignore) — 실패 디버깅용, 정상 실행 오버헤드 0.
  use: { trace: 'on-first-retry' },
})
