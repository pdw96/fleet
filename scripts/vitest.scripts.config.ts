// scripts 전용 vitest config — skills-lint 테스트 실행용
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
})
