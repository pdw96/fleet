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
      expect(yml).toMatch(/gh release view "\$TAG".*--json isDraft/)
    })

    it('draft 가 아니면 하드 실패한다(재사용하지 않는다)', () => {
      // `!= "true"` 분기 안에 exit 1 이 있어야 한다. 경고만 찍고 통과하면 v0.1.1 이 재발한다.
      expect(yml).toMatch(/if \[ "\$EXISTING_DRAFT" != "true" \]; then[\s\S]{0,700}?exit 1/)
    })

    it('실패 메시지가 올바른 개시 방법을 안내한다', () => {
      expect(yml).toMatch(/git push origin \$TAG/)
    })
  })

  // 브라우저만 쓰는 운용 환경에서 태그 push 가 막히면 파이프라인 전체가 인질이 된다(실측:
  // 세션의 git 프록시가 refs/tags/* 를 403 으로 거부, Codespaces 한도 소진). 그래서 dispatch 개시
  // 경로를 뒀는데, 이 경로는 **태그를 워크플로가 직접 만든다** — 잘못 만들면 태그가 가리키지 않는
  // 커밋이 그 태그로 발행되고, 발행은 immutable 이라 되돌릴 수 없다. 아래가 그 안전 조건들이다.
  describe('dispatch 개시 경로', () => {
    it('workflow_dispatch 로 태그 입력을 받는다', () => {
      expect(yml).toMatch(/workflow_dispatch:[\s\S]{0,300}?inputs:[\s\S]{0,300}?tag:/)
    })

    it('태그를 `inputs` 컨텍스트가 아니라 github.event_name 분기로 정한다', () => {
      // `inputs` 컨텍스트가 push 이벤트에서 어떻게 채워지는지는 문서에 명시돼 있지 않다.
      // `inputs.tag || github.ref_name` 류의 축약은 그 미명시 동작에 의존하므로 쓰지 않는다.
      expect(yml).toMatch(/EVENT_NAME: \$\{\{ github\.event_name \}\}/)
      expect(yml).toMatch(/if \[ "\$EVENT_NAME" = "workflow_dispatch" \]/)
      expect(yml).not.toMatch(/\$\{\{\s*inputs\./)
    })

    it('사용자 입력을 셸에 인라인 보간하지 않는다(env 경유 1회뿐)', () => {
      // `run:` 안에 `${{ github.event.inputs.tag }}` 를 직접 쓰면 태그 문자열이 셸 소스로 들어간다.
      const uses = yml.match(/\$\{\{\s*github\.event\.inputs\./g) ?? []
      expect(uses).toHaveLength(1)
      expect(yml).toMatch(/INPUT_TAG: \$\{\{ github\.event\.inputs\.tag \}\}/)
    })

    it('태그 형식을 검증한다', () => {
      expect(yml).toMatch(/grep -qE '\^v\[0-9\]\+/)
    })

    it('기존 태그가 이 실행의 커밋과 다르면 하드 실패한다', () => {
      // 다른 커밋을 그 태그로 발행하는 것이 이 경로 고유의 최악 실패다.
      expect(yml).toMatch(/if \[ "\$EXISTING" != "\$GITHUB_SHA" \]; then[\s\S]{0,400}?exit 1/)
    })

    it('SHA 대조가 dispatch 경로로 한정된다(annotated 태그 push 오탐 방지)', () => {
      // annotated 태그 push 에서 GITHUB_SHA 는 커밋이 아니라 태그 객체일 수 있는데 `commits/<ref>`
      // 는 항상 커밋을 준다 — push 경로까지 대조하면 정상 출하를 막는 오탐이 된다. 그래서 스텝 진입
      // 직후 push 를 조기 반환시킨다. 이 가드가 사라지면 게이트가 오탐 장치로 바뀐다.
      const step = yml.slice(yml.indexOf('태그 ref 보장'))
      expect(step).toMatch(
        /if \[ "\$EVENT_NAME" != "workflow_dispatch" \]; then[\s\S]{0,200}?exit 0/,
      )
      // 조기 반환이 대조보다 **먼저** 와야 한다.
      expect(step.indexOf('!= "workflow_dispatch"')).toBeLessThan(step.indexOf('"$EXISTING" !='))
    })

    it('태그 존재 확인에 commits/<ref> 를 쓴다(annotated 태그 오탐 방지)', () => {
      // `git/ref/tags/<t>` 의 object.sha 는 annotated 태그에서 **태그 객체**라 커밋과 비교하면
      // 항상 불일치로 읽힌다 — 정상 push 를 오탐으로 막는다. `commits/<ref>` 는 둘 다 역참조한다.
      expect(yml).toMatch(/gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$TAG" -q \.sha/)
      expect(yml).not.toMatch(/git\/ref\/tags/)
    })

    it('dispatch 에서만 커밋을 고정한다(push 경로 무변경)', () => {
      // dispatch 에서 github.ref 는 브랜치라, 고정하지 않으면 prepare 가 태그를 붙인 커밋과
      // build 가 빌드한 커밋이 갈릴 수 있다(그 사이 브랜치에 push 가 들어오면).
      // 반대로 push 경로는 건드리지 않는다 — 문서는 push 의 GITHUB_SHA 를 「Tip commit pushed to
      // the ref」라고만 하고 annotated 태그에서 그것이 커밋인지 태그 객체인지 단정하지 않는다.
      // 무조건 `github.sha` 로 고정하면 **동작하던 출하 경로**를 미검증 가정 위에 올리게 된다.
      const checkouts = yml.match(/uses: actions\/checkout@/g) ?? []
      const pins =
        yml.match(
          /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.sha \|\| github\.ref \}\}/g,
        ) ?? []
      expect(pins).toHaveLength(checkouts.length)
      // 무조건 고정(push 경로까지 바꾸는 형태)은 금지.
      expect(yml).not.toMatch(/ref: \$\{\{ github\.sha \}\}/)
    })

    it('태그가 잡 출력으로 전파된다(GITHUB_REF_NAME 재사용 금지)', () => {
      expect(yml).toMatch(/outputs:\s*\n\s*tag: \$\{\{ steps\.tag\.outputs\.tag \}\}/)
      expect(yml).toMatch(/needs: \[prepare, build\]/)
      // 태그 결정 스텝 **뒤로는** GITHUB_REF_NAME 이 값으로 쓰이면 안 된다 — dispatch 에선 브랜치명이다.
      const afterDecision = yml.slice(yml.indexOf('Verify tag matches package.json version'))
      expect(afterDecision).not.toMatch(/"\$GITHUB_REF_NAME"/)
      expect(afterDecision).not.toMatch(/\$GITHUB_REF_NAME\b/)
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
