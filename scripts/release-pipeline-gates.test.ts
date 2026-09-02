import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// v0.1.1 은 Release 워크플로 4개 잡이 **전부 성공**한 채 자산 0개로 발행됐다.
// electron-builder 는 `releaseType: draft` 인데 공개된 릴리스를 만나면 업로드를 건너뛰고도 exit 0 한다
// (`reason=existing type not compatible with publishing type`). 즉 잡 성공이 자산 존재를 뜻하지 않는다.
// immutable releases 아래에서는 사후 자산 추가도 태그 이름 재사용도 불가능해 복구가 재출하뿐이므로,
// 이 두 게이트는 실패 비용이 특히 큰 자리다. 게이트가 조용히 사라져도 릴리스는 green 이라 무신호 —
// 그래서 설정 텍스트로 핀한다(ADR-0016 선례: 산문 규약 대신 기계 강제).
describe('릴리스 파이프라인 fail-closed 게이트 핀', () => {
  const yml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

  describe('prepare — 공개된 릴리스 재사용 차단', () => {
    it('기존 릴리스의 draft 여부를 조회한다', () => {
      expect(yml).toMatch(/gh release view "\$GITHUB_REF_NAME".*--json isDraft/)
    })

    it('draft 가 아니면 하드 실패한다(재사용하지 않는다)', () => {
      // `!= "true"` 분기 안에 exit 1 이 있어야 한다. 경고만 찍고 통과하면 v0.1.1 이 재발한다.
      expect(yml).toMatch(/if \[ "\$EXISTING_DRAFT" != "true" \]; then[\s\S]{0,600}?exit 1/)
    })

    it('실패 메시지가 올바른 태그 push 방법을 안내한다', () => {
      expect(yml).toMatch(/git push origin \$GITHUB_REF_NAME/)
    })
  })

  describe('release — 공개 전 자산 실재 확인', () => {
    const assetCheck = yml.indexOf('자산 실재 확인')
    const publish = yml.indexOf('--draft=false')

    it('자산 확인 스텝이 존재한다', () => {
      expect(assetCheck).toBeGreaterThan(-1)
    })

    it('자산 확인이 공개(--draft=false)보다 **먼저** 온다', () => {
      // 순서가 뒤집히면 게이트가 존재해도 의미가 없다 — 공개는 immutable 이라 되돌릴 수 없다.
      expect(publish).toBeGreaterThan(assetCheck)
    })

    it('인스톨러·업데이트 메타데이터 4부류를 모두 요구한다', () => {
      const step = yml.slice(assetCheck, publish)
      // 채널별 파일명(latest/beta/alpha)을 열거하지 않는다 — 채널 라우팅이 바뀌어도 낡지 않도록 부류로 본다.
      expect(step).toMatch(/grep -qE '\\\.exe\$'/)
      expect(step).toMatch(/grep -qE '\\\.AppImage\$'/)
      expect(step).toMatch(/grep -qE -- '-linux\\\.yml\$'/)
      expect(step).toMatch(/grep -vE -- '-linux\\\.yml\$'[\s\S]{0,80}grep -qE '\\\.yml\$'/)
    })

    it('누락 시 exit 1 로 공개를 막는다', () => {
      const step = yml.slice(assetCheck, publish)
      expect(step).toMatch(/if \[ -n "\$MISSING" \]; then[\s\S]{0,600}?exit 1/)
      // 판정의 입력이 실제 릴리스 자산 조회여야 한다 — assets.txt 가 다른 출처로 갈아끼워지면
      // grep 들은 그대로인 채 게이트만 무의미해진다.
      expect(step).toMatch(/gh release view[^\n]*--json assets[\s\S]{0,120}> assets\.txt/)
    })
  })

  // `exit 1` 은 스텝이 실제로 잡을 실패시킬 때만 게이트다. `continue-on-error: true` 는 실패한
  // 스텝을 성공으로 접고 **다음 스텝을 그대로 실행**시키므로, 자산 게이트에 그 한 줄만 붙이면
  // exit 1 이 나도 바로 뒤의 공개 스텝이 돌아 v0.1.1 이 그대로 재현된다(공개 스텝의 `if: always()`
  // 도 동형). 편집 1줄로 완성되는 fail-open 이고 동기도 현실적이다 — 막힌 릴리스를 뚫으려는
  // 조작이 바로 v0.1.1 을 만든 압력이다. `deploy-cd-pin.test.ts:79-83` 이 같은 밴을 이미 갖는다.
  // 현재 `release.yml` 에 `if:`·`continue-on-error` 는 0건이라 오탐 위험이 없다.
  describe('fail-open 조건 밴', () => {
    it('워크플로 어디에도 continue-on-error: true 가 없다', () => {
      expect(yml).not.toMatch(/continue-on-error:\s*true/)
    })

    it('자산 확인~공개 구간에 조건부 실행(if:)이 없다', () => {
      // 파일 전체가 아니라 이 구간만 본다 — prepare·build 의 장래 정당한 `if:` 를 오탐하지 않는다.
      expect(yml.slice(yml.indexOf('자산 실재 확인'))).not.toMatch(/^\s+if:/m)
    })
  })
})
