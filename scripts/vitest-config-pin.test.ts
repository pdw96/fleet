import { describe, expect, it } from 'vitest'

import config from '../vitest.config'

/**
 * `vitest.config.ts` 회귀 핀 (#251 PR1b).
 *
 * **왜 필요한가**: 커버리지 floor 는 이 레포의 명문 규범(「floor 하향 금지 — 그 PR 안에서 해소」)인데
 * `vitest.config.ts` 를 단언하는 테스트가 **0건**이었다 — 즉 floor 를 낮추는 한 줄이 전 게이트를 조용히
 * 통과한다. 형제 선례가 이미 4건 있다(`eslint-config-purity` · `deploy-sandbox-boundary-pin` ·
 * `electron-builder-pin` · `deploy-cd-pin`) — 같은 관용구로 닫는다.
 *
 * ⚠ 이 파일은 `scripts/**` 라 `coverage.include`(`src/main/core/**`) 밖이다 = **커버리지 비용 0**.
 *
 * 값을 **의도적으로 바꿀 때**는 이 핀도 함께 고친다(그게 이 핀의 목적이다 — 변경이 리뷰에 보이게 만든다).
 */

const coverage = config.test?.coverage

describe('vitest.config — 커버리지 게이트 핀', () => {
  it('floor 4수치가 정확히 고정돼 있다(하향은 이 행에서 RED)', () => {
    expect(coverage && 'thresholds' in coverage ? coverage.thresholds : undefined).toEqual({
      lines: 92,
      statements: 91,
      functions: 90,
      branches: 83,
    })
  })

  /**
   * **분모 완전성의 유일한 근거**다. vitest 4 는 `coverage.all` 을 제거했고(실측: `CoverageOptions` 에
   * 필드 부재), v4 에서는 `include` 를 명시하는 것만으로 테스트가 import 하지 않은 파일도 분모에 들어간다
   * (실측: 아무도 import 하지 않는 코어 파일이 0% 로 보고서에 등장). 이 배열이 사라지거나 좁아지면
   * 분모가 「테스트가 커버한 파일만」으로 **조용히 축소**되어 커버리지가 오른 것처럼 보인다.
   */
  it('커버리지 대상은 순수 TS 코어 전량이다(범위 축소로 floor 를 우회할 수 없다)', () => {
    expect(coverage?.include).toEqual(['src/main/core/**/*.{ts,tsx}'])
  })

  /**
   * `exclude` 는 **테스트 파일과 테스트 전용 헬퍼만** 담는다. 프로덕션 경로가 여기 들어오면 그 파일의
   * 미커버 행이 분모에서 빠져 floor 가 무의미해진다.
   * `__testing__/**` = 실행되지 않고 import 만 되는 테스트 더블(#251 PR1b 페이크) — 계약 검증 수단이지
   * 출하 코드가 아니므로 분모에서 제외한다(그 격리는 `locks-structure.test.ts` 가 별도로 단언한다).
   */
  it('exclude 는 테스트 파일 + __testing__ 헬퍼로 한정된다', () => {
    expect(coverage?.exclude).toEqual(['**/*.test.ts', 'src/main/core/**/__testing__/**'])
  })

  it('전역 testTimeout 이 실 프로세스 스폰 테스트를 견디는 값이다(개별 it 상향 불요)', () => {
    expect(config.test?.testTimeout).toBe(20_000)
  })
})
