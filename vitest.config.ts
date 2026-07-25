import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 기본은 node. 렌더러 컴포넌트 테스트는 파일 상단 `@vitest-environment jsdom` 도크블록으로 전환.
    environment: 'node',
    // 실 프로세스(git·node 자식·CLI probe)를 스폰하는 테스트가 다수라 vitest 기본 5,000ms 는 부족하다 —
    // 병렬 스위트 부하가 오르면 `ignored-baseline`·`detect` 같은 기존 실-스폰 테스트가 「Test timed out in
    // 5000ms」로 산발 RED 가 된다(#251 PR1a 실측 재현). 상한을 올려도 통과하는 테스트는 느려지지 않는다
    // (타임아웃은 실패 판정 시점일 뿐). 개별 테스트가 더 필요하면 `it(..., ms)` 로 국소 상향한다.
    testTimeout: 20_000,
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 순수 TS 코어만 floor 강제(렌더러 UI 는 별개 성숙도). 회귀 backstop 이지 100% ratchet 아님.
      include: ['src/main/core/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts'],
      all: true,
      // 첫 ubuntu CI 실측(L94.9/S93.25/F92.86/B86.05) ~2-3pt 아래로 확정한 회귀 backstop.
      // 플랫폼 분기(win32/POSIX skipIf)는 전역 수치엔 상쇄돼 영향 미미. 수동 ratchet(autoUpdate 미사용).
      thresholds: { lines: 92, statements: 91, functions: 90, branches: 83 },
    },
  },
})
