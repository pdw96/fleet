// scripts 전용 vitest config — skills-lint 테스트 실행용
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
})
