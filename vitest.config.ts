import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 기본은 node. 렌더러 컴포넌트 테스트는 파일 상단 `@vitest-environment jsdom` 도크블록으로 전환.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 순수 TS 코어만 floor 강제(렌더러 UI 는 별개 성숙도). 회귀 backstop 이지 100% ratchet 아님.
      include: ['src/main/core/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts'],
      all: true,
      // 플랫폼 분기(win32/POSIX skipIf 공존)로 ubuntu==CI 수치가 낮아 보수적. 수동 ratchet(autoUpdate 미사용).
      thresholds: { lines: 90, statements: 88, functions: 88, branches: 80 },
    },
  },
})
