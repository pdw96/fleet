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
      // `__testing__/**` = 실행되지 않고 import 만 되는 테스트 더블(#251 PR1b 락 백엔드 페이크).
      // 계약 검증 수단이지 출하 코드가 아니라 분모에서 제외한다 — 프로덕션 소스가 페이크를 참조하지
      // 않음은 `locks-structure.test.ts` 가 소스 스캔으로 별도 단언한다.
      exclude: ['**/*.test.ts', 'src/main/core/**/__testing__/**'],
      // ⚠ `all: true` 는 **vitest 4 에서 제거된 옵션**이라 여기 없다(#251 PR1b 실측: `CoverageOptions` 에
      // 필드 부재 → tsc 에러). v4 에서는 `include` 를 명시하는 것만으로 **테스트가 import 하지 않은 파일도
      // 분모에 들어간다**(실측: 아무도 import 하지 않는 코어 파일이 0% 로 보고서에 등장). 따라서 분모
      // 완전성을 지키는 것은 위 `include` 이며, 그것이 사라지면 v4 기본값(「테스트가 커버한 파일만」)으로
      // 조용히 축소된다 — `scripts/vitest-config-pin.test.ts` 가 exact 핀으로 막는다.
      // 첫 ubuntu CI 실측(L94.9/S93.25/F92.86/B86.05) ~2-3pt 아래로 확정한 회귀 backstop.
      // 플랫폼 분기(win32/POSIX skipIf)는 전역 수치엔 상쇄돼 영향 미미. 수동 ratchet(autoUpdate 미사용).
      // ⚠ 이 4수치는 `scripts/vitest-config-pin.test.ts` 가 exact 핀한다 — 하향은 그 핀을 함께 고쳐야 한다.
      thresholds: { lines: 92, statements: 91, functions: 90, branches: 83 },
    },
  },
})
