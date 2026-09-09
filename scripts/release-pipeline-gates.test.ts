import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// v0.1.1 은 Release 워크플로 4개 잡이 **전부 성공**한 채 자산 0개로 발행됐다.
// electron-builder 는 `releaseType: draft` 인데 공개된 릴리스를 만나면 업로드를 건너뛰고도 exit 0 한다
// (`reason=existing type not compatible with publishing type`). 즉 잡 성공이 자산 존재를 뜻하지 않는다.
// immutable releases 아래에서는 사후 자산 추가도 태그 이름 재사용도 불가능해 복구가 재출하뿐이므로,
// 이 두 게이트는 실패 비용이 특히 큰 자리다. 게이트가 조용히 사라져도 릴리스는 green 이라 무신호 —
// 그래서 설정 텍스트로 핀한다(ADR-0016 선례: 산문 규약 대신 기계 강제).
describe('릴리스 파이프라인 fail-closed 게이트 핀', () => {
  const yml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

  /**
   * 이름으로 스텝 하나를 잘라낸다 — **다음 스텝 항목(또는 잡 경계)의 시작 줄까지**, 그리고 그 앞의
   * 주석 줄은 다음 스텝의 것이므로 떼어낸다.
   *
   * 경계를 `- name:`/`- uses:` 두 리터럴로만 잡으면 두 방향으로 틀린다: (a) `- run:` 축약 스텝(이
   * 파일에 6개 있다)을 경계로 못 봐 슬라이스가 남의 스텝 본문을 삼키고, (b) 다음 스텝의 선행 주석
   * 블록이 딸려 온다. 부재 단언(`not.toMatch`)이 **남의 텍스트를 감시**하게 되므로 오탐과 과소검출이
   * 동시에 생긴다 — 실제로 이 게이트 스텝의 슬라이스가 「태그 ref 보장」의 주석 23줄을 삼키고 있었다.
   */
  const step = (name: string): string => {
    const lines = yml.split('\n')
    const start = lines.findIndex((l) => l === `      - name: ${name}`)
    if (start === -1) throw new Error(`스텝을 찾지 못했다: ${name}`)
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      // 스텝 항목의 시작(`      - `) 또는 더 얕은 들여쓰기(잡·최상위 키) = 이 스텝의 끝.
      if (/^ {6}- /.test(lines[i]) || /^ {0,5}\S/.test(lines[i])) {
        end = i
        break
      }
    }
    while (end > start + 1 && /^\s*#/.test(lines[end - 1])) end--
    return lines.slice(start, end).join('\n')
  }

  /** 스텝 이름은 한 곳에서만 적는다 — 두 표기로 참조하면 리네임 시 한쪽만 RED 가 된다. */
  const ENSURE_TAG_STEP = '태그 ref 보장 (dispatch 개시 경로 전용)'
  const MASTER_GATE_STEP = '출하 커밋 master 포함 확인 (미머지 코드 출하 차단)'

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
      // 스텝 **선언**으로 앵커한다 — 다른 스텝의 주석이 이 스텝을 이름으로 참조하므로,
      // 문자열 첫 등장으로 자르면 슬라이스가 남의 스텝까지 삼켜 보장이 헐거워진다.
      const ensure = step('태그 ref 보장 (dispatch 개시 경로 전용)')
      expect(ensure).toMatch(
        /if \[ "\$EVENT_NAME" != "workflow_dispatch" \]; then[\s\S]{0,200}?exit 0/,
      )
      // 조기 반환이 대조보다 **먼저** 와야 한다.
      expect(ensure.indexOf('!= "workflow_dispatch"')).toBeLessThan(
        ensure.indexOf('"$EXISTING" !='),
      )
    })

    it('태그 존재 확인이 refs/tags 정확 조회다(동명 브랜치 오인 차단)', () => {
      // `commits/<ref>` 는 같은 이름의 **브랜치**도 해석한다. 태그가 없는데 동명 브랜치의 head 가
      // 이 실행의 커밋이면 생성을 건너뛰고, 뒤의 `gh release create` 가 문서화된 동작대로 기본
      // 브랜치 최신 상태에서 태그를 날조한다 — 빌드한 커밋과 다른 곳에 태그가 붙는다.
      expect(yml).toMatch(/REF_API="repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$TAG"/)
      expect(yml).not.toMatch(/GITHUB_REPOSITORY\/commits\//)
    })

    it('annotated 태그를 벗겨서 커밋과 비교한다', () => {
      // refs/tags 정확 조회의 대가: object 가 커밋이 아니라 태그 객체일 수 있다. 안 벗기면
      // 정상 태그를 「다른 커밋을 가리킨다」로 오탐해 출하를 막는다.
      expect(yml).toMatch(
        /if \[ "\$OBJ_TYPE" = "tag" \]; then[\s\S]{0,200}?gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$EXISTING" -q \.object\.sha/,
      )
    })

    it('gh release create 가 태그를 날조하지 못한다(--verify-tag)', () => {
      // 「태그 ref 보장」이 사라지거나 조건이 어긋나도 여기서 fail-closed 로 막는 이중 방어.
      expect(yml).toMatch(/gh release create "\$TAG"[\s\S]{0,200}?--verify-tag/)
    })

    it('dispatch 에서만 커밋을 고정하고, push 는 checkout 기본값을 쓴다', () => {
      // dispatch 에서 github.ref 는 브랜치라, 고정하지 않으면 prepare 가 태그를 붙인 커밋과
      // build 가 빌드한 커밋이 갈릴 수 있다(그 사이 브랜치에 push 가 들어오면).
      //
      // push 쪽 폴백은 **빈 문자열**이어야 한다. `github.ref` 를 명시하는 것은 무변경이 아니라
      // **고정 해제**다: checkout 기본값은 내부적으로 github.sha(이벤트에 기록된 커밋)를 쓰는데,
      // ref 이름을 넘기면 checkout 시점의 원격 태그가 현재 가리키는 곳을 다시 해석한다 — 이벤트
      // 후 태그가 강제 갱신되면 워크플로·릴리스가 나타내는 커밋과 빌드한 커밋이 갈린다(Codex P1).
      const checkouts = yml.match(/uses: actions\/checkout@/g) ?? []
      const pins =
        yml.match(
          /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.sha \|\| '' \}\}/g,
        ) ?? []
      expect(pins).toHaveLength(checkouts.length)
      // 무조건 고정도, ref 이름 폴백도 금지.
      expect(yml).not.toMatch(/ref: \$\{\{ github\.sha \}\}/)
      expect(yml).not.toMatch(/\|\| github\.ref \}\}/)
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

  // 두 개시 경로 모두 「지금 고른 것」의 HEAD 를 그대로 태깅한다 — CLI 의 `git tag` 는 어느 브랜치에서든
  // 찍히고, dispatch 의 「태그 ref 보장」은 고른 ref 의 커밋에 태그를 만든다. 즉 머지·리뷰되지 않은
  // 코드가 immutable 공개 릴리스로 나갈 수 있었고, 그것을 막는 것은 **사람의 확인뿐**이었다
  // (Codex PR#327 3R P1 → #328). 복구는 재출하뿐이다 — v0.1.1 이 이미 그 비용을 치렀다.
  // 정상 출하는 이 게이트가 있든 없든 green 이라 소실이 무신호다 — 위 두 게이트와 같은 근거로 핀한다.
  describe('prepare — 출하 커밋의 master 포함 강제', () => {
    const NAME = MASTER_GATE_STEP

    it('게이트가 `prepare` 잡 안에, 태그 ref 생성보다 **먼저** 있다', () => {
      // 두 가지를 함께 본다. ① 순서 — 뒤에 오면 dispatch 가 특성 브랜치 커밋에 태그를 이미
      // 만든 뒤 실패한다. ② **소속 잡** — 텍스트 위치만 보면 게이트를 `prepare` 앞의 별도 잡으로
      // 옮기고 `needs:` 를 빠뜨리는 편집(흔한 리팩터 실수)이 통과한다. 두 잡이 병렬로 돌아
      // 게이트가 태그 생성을 전혀 막지 못하는데도 순서 단언은 만족된다.
      const prepare = yml.slice(yml.indexOf('\n  prepare:'), yml.indexOf('\n  build:'))
      expect(prepare).toContain(`- name: ${NAME}`)
      expect(prepare).toContain(`- name: ${ENSURE_TAG_STEP}`)
      expect(prepare.indexOf(`- name: ${NAME}`)).toBeLessThan(
        prepare.indexOf(`- name: ${ENSURE_TAG_STEP}`),
      )
    })

    it('판정 대상이 워크트리의 HEAD 다($GITHUB_SHA 가 아니라)', () => {
      // `git rev-parse HEAD` 는 checkout 이 무엇을 해석했든 **항상 커밋**이라, annotated 태그
      // push 에서 `GITHUB_SHA` 가 커밋인지 태그 객체인지라는 물음에 의존하지 않는다.
      expect(step(NAME)).toMatch(/SHA=\$\(git rev-parse HEAD\)/)
    })

    it('판정을 compare API 의 status 로 한다(브랜치 이름이 아니라 포함 관계)', () => {
      expect(step(NAME)).toMatch(/compare\/master\.\.\.\$SHA" -q \.status/)
    })

    it('통과 arm 이 정확히 `identical|behind` 와 `*` 뿐이다', () => {
      // **존재 단언만으로는 부족하다**(실측): `identical|behind)` **앞에** `ahead)` arm 을 끼우면
      // 「arm 이 존재한다」·「`*)` 아래 exit 1 이 있다」 두 핀이 그대로 매치해 GREEN 이었다.
      // `ahead` 는 master 의 **자손** = 아직 머지되지 않은 커밋이라, arm 하나로 게이트가 통째로
      // 무력해진다. 그래서 존재가 아니라 **집합**을 고정한다. 들여쓰기가 아니라 `case`~`esac`
      // 구간으로 앵커해 정당한 재포맷에는 오탐하지 않는다.
      const body = step(NAME)
      const from = body.indexOf('case "$STATUS" in')
      const to = body.indexOf('esac', from)
      expect(from).toBeGreaterThan(-1)
      expect(to).toBeGreaterThan(from)
      const arms = [...body.slice(from, to).matchAll(/^[ \t]+([^\s)][^)\n]*)\)[ \t]*$/gm)].map(
        (m) => m[1],
      )
      expect(arms).toEqual(['identical|behind', '*'])
    })

    it('실패 arm 의 `exit 1` 이 **명령**이다(메시지 속 문자열이 아니라)', () => {
      // `/\*\)[\s\S]*?exit 1/` 는 부분 문자열이라, `exit 1` 을 지우고 그 단어가 들어간
      // `::warning::` 메시지를 남기면 통과한다 — 게이트가 조용히 경고 장치로 전락한다.
      // 이 레포는 근거를 긴 메시지로 남기는 관행이 강해 우연 성립 확률이 낮지 않다.
      const body = step(NAME)
      expect(body).toMatch(/^\s+exit 1$/m)
      expect(body).not.toMatch(/::warning::/)
    })

    it('판정 입력이 각각 한 번만 대입된다(재대입으로 덮어쓰기 차단)', () => {
      // `SHA=$(git rev-parse HEAD)` 뒤에 `SHA=<master 의 sha>` 한 줄을 더하면 판정이 항상
      // `identical` 이 된다 — 첫 대입만 보는 존재 단언으로는 못 막는다. `STATUS` 도 동형이다.
      const body = step(NAME)
      expect(body.match(/^\s*SHA=/gm) ?? []).toHaveLength(1)
      expect(body.match(/^\s*(?:if ! )?STATUS=/gm) ?? []).toHaveLength(1)
    })

    it('두 개시 경로를 모두 덮는다(이벤트 분기·조기 종료가 없다)', () => {
      // push 만/dispatch 만 덮으면 다른 경로가 그대로 뚫린다 — 포함 관계 술어를 고른 이유가 이것이다.
      // 토큰 `EVENT_NAME` 하나만 밴하면 소문자 표현식(`${{ github.event_name }}`)·다른 컨텍스트
      // (`GITHUB_REF_TYPE`)·변수 개명으로 전부 우회된다. 그래서 **분기의 결과**(조기 통과)도 막는다.
      const body = step(NAME)
      expect(body).not.toMatch(/EVENT_NAME/)
      expect(body).not.toMatch(/github\.event_name/)
      expect(body).not.toMatch(/GITHUB_REF_TYPE/)
      expect(body).not.toMatch(/\bexit 0\b/)
    })

    it('게이트 스텝에 fail-open 조건이 붙어 있지 않다', () => {
      // `continue-on-error: true` 한 줄이면 exit 1 이 나도 다음 스텝이 그대로 돈다(#314 패턴).
      expect(step(NAME)).not.toMatch(/^\s+if:/m)
      expect(step(NAME)).not.toMatch(/continue-on-error/)
    })
  })

  // 위 핀은 전부 **정적 텍스트 대조**라 셸을 한 번도 실행하지 않는다. 그래서 텍스트가 그럴듯하면서
  // 동작이 뒤집히는 편집(허용 arm 추가 · `|| echo identical` 폴백 · `exit 1` 을 메시지로 강등)이
  // 통과할 수 있었다 — 실제로 첫 두 개는 통과했다(실측). 여기서는 워크플로의 `run:` 본문을 파일에서
  // **그대로 뽑아** 가짜 `gh` 를 PATH 앞에 놓고 돌린다. status 값별 종료코드가 계약이고, 그 계약은
  // 텍스트 표현이 어떻게 바뀌어도 유지돼야 한다. #328 의 「master 정상 출하는 영향 없음」도 여기서 산다.
  //
  // win32 skip: 이 스텝은 `shell: bash` · `runs-on: ubuntu-latest` 에서만 실행되고, 검증 대상도
  // 그 셸 의미론이다. ci.yml 의 windows 잡은 `.cmd` 셰임 회귀 전용이라 이 계약과 무관하다.
  describe.skipIf(process.platform === 'win32')('게이트 실행 계약 (status → 종료코드)', () => {
    const runBody = (): string => {
      const s = step(MASTER_GATE_STEP)
      const at = s.indexOf('        run: |\n')
      if (at === -1) throw new Error('run 블록을 찾지 못했다')
      return s.slice(at + '        run: |\n'.length)
    }

    /**
     * 가짜 `gh` 를 PATH 앞에 놓고 게이트 본문을 실행한다.
     *
     * 실패 모드는 **실물과 같아야** 한다 — 진짜 `gh` 는 404 에서 stdout 에 아무것도 쓰지 않고
     * stderr 로만 보고한다(실측: `gh: Not Found (HTTP 404)`). 스텁이 실패할 때도 stdout 에
     * 값을 뱉으면 `|| echo …` 폴백 뮤턴트가 두 출력이 이어붙는 바람에 우연히 잡혀, 핀이 실제보다
     * 강해 보인다. 그 착시를 한 번 겪어서 여기에 적어 둔다.
     */
    const runGate = (ghStdout: string, ghExit = 0): number => {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-master-gate-'))
      try {
        const gh = join(dir, 'gh')
        writeFileSync(
          gh,
          ghExit === 0
            ? `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(ghStdout)}\n`
            : `#!/bin/sh\necho 'gh: Not Found (HTTP 404)' >&2\nexit ${ghExit}\n`,
        )
        chmodSync(gh, 0o755)
        const script = join(dir, 'gate.sh')
        writeFileSync(script, runBody())
        const r = spawnSync('bash', [script], {
          cwd: new URL('..', import.meta.url).pathname,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            GITHUB_REPOSITORY: 'pdw96/fleet',
            TAG: 'v9.9.9',
          },
        })
        return r.status ?? -1
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it.each([
      ['identical', 0, 'master HEAD — 정상 출하'],
      ['behind', 0, 'master 위의 옛 커밋 — 포함된다'],
    ])('%s 는 통과한다 (%i) — %s', (status, code) => {
      expect(runGate(status)).toBe(code)
    })

    it.each([
      ['ahead', 'master 의 자손 — 아직 머지되지 않았다'],
      ['diverged', '특성 브랜치'],
      ['', 'status 가 비었다 — 판정 불가'],
      ['unexpected-new-value', '모르는 값 — 판정 불가'],
    ])('%s 는 하드 실패한다 — %s', (status) => {
      expect(runGate(status)).not.toBe(0)
    })

    it('compare 조회가 실패하면 통과시키지 않는다(`|| echo identical` 류 폴백 차단)', () => {
      // 404 는 「이 커밋이 레포에 없다」 = 방어 대상 그 자체다. API 실패를 통과로 접는 한 줄이
      // 게이트를 fail-open 으로 뒤집는데, 동기가 현실적이다("플레이크에 릴리스가 막힌다").
      expect(runGate('', 1)).not.toBe(0)
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
    it('워크플로 어디에도 continue-on-error 가 없다(값 무관)', () => {
      // `\s*true` 만 보면 `continue-on-error: ${{ … }}` 표현식 값으로 우회된다. 이 워크플로에
      // 정당한 `continue-on-error` 는 하나도 없으므로 키 자체를 밴하는 편이 좁고 정확하다.
      expect(yml).not.toMatch(/continue-on-error:/)
    })

    it('실패를 삼키는 `if:` 형태가 없다', () => {
      // `deploy-cd-pin.test.ts` 와 같은 목록. `자산 실재 확인` 이후 구간만 보던 아래 핀은
      // 잡 수준 `if: always()`(예: `release:` 잡 자체에 붙이면 build 실패도 무시된다)를 놓친다.
      expect(yml).not.toMatch(/if:[^\n]*\balways\(\)/)
      expect(yml).not.toMatch(/if:[^\n]*!\s*cancelled\(\)/)
      expect(yml).not.toMatch(/if:[^\n]*\bfailure\(\)/)
    })

    it('자산 확인~공개 구간에 조건부 실행(if:)이 없다', () => {
      // 파일 전체가 아니라 이 구간만 본다 — prepare·build 의 장래 정당한 `if:` 를 오탐하지 않는다.
      expect(yml.slice(yml.indexOf('자산 실재 확인'))).not.toMatch(/^\s+if:/m)
    })
  })
})
