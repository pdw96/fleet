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
  reporter: [['list']],
})
