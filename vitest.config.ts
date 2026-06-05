import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 기본은 node. 렌더러 컴포넌트 테스트는 파일 상단 `@vitest-environment jsdom` 도크블록으로 전환.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
