import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #222 CD: GHCR pull 파이프라인의 계약·보안·race 계약을 정적 텍스트로 핀한다. deploy.yml/override 가
// 구현 재량으로 fail-open(allowlist 회귀)·시크릿 유출·태그 회귀로 조용히 약화돼도 무신호가 되지 않게
// 코드보다 먼저(RED) 둔다. scripts/ 라 vitest include 로 PR마다 상시 실행(Docker 불요)·coverage floor 무영향.
// deploy-sandbox-boundary-pin.test.ts 동형. 판사 패널(승자 리스크)+Codex 3R P1(역필터·latest master-tip·GH_TOKEN) 반영.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const workflow = () => read('../.github/workflows/deploy.yml')
const override = () => read('../deploy/docker-compose.ghcr.yml')
const baseCompose = () => read('../deploy/docker-compose.yml')
const dockerignore = () => read('../.dockerignore')

// SHA 핀된 actions/checkout 참조 전부. 40-hex 만 매치하므로 태그/브랜치 ref 회귀는 "추출 0건" 으로 드러난다.
const checkoutShas = (text: string) =>
  [...text.matchAll(/actions\/checkout@([0-9a-f]{40})\b/g)].map((m) => m[1])

// checkout 스텝 본문만 잘라낸다 — 다음 스텝(`- uses:`/`- name:`/`- run:`) 직전까지. 라인 단위로 스캔한다
// (멀티라인 정규식은 `\s` 가 개행을 넘고 `^` 가 문자열 시작에도 걸려 스텝 경계를 잘못 잡는다).
const STEP_HEAD = /^\s*-\s+(uses|name|run):/
const checkoutStep = (text: string) => {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^\s*-\s+uses:\s*actions\/checkout@/.test(l))
  if (start < 0) return ''
  let end = start + 1
  while (end < lines.length && !STEP_HEAD.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

// paths-ignore 항목 → .dockerignore 대응(기저 경로). 스킵되는 건 이미지 무영향뿐이어야 한다(fail-safe).
const PATHS_IGNORE_SAFE: Record<string, string> = {
  'docs/**': 'docs',
  '**/*.md': '*.md',
  '.claude/**': '.claude',
  '.dogfood/**': '.dogfood',
  'coverage/**': 'coverage',
  '.vscode/**': '.vscode',
  '.idea/**': '.idea',
  'fleet-brain.html': 'fleet-brain.html',
}

describe('deploy: GHCR CD 발행 정책 핀(#222)', () => {
  // ① [보안] 권한 최소성 — top-level permissions 블록을 allowlist 로 화이트리스트(3종 denylist 는 나머지
  // write 스코프[deployments/pull-requests 등]를 놓친다 · 전파일 스캔은 job-level 우회 · 자가 적대리뷰 P3).
  it('top-level permissions 는 contents:read + packages:write 만(allowlist — 그 외 스코프 RED)', () => {
    const wf = workflow()
    // top-level permissions 블록(permissions: ~ jobs:)만 추출 — job-level·전파일 스캔 우회 방지.
    const block = wf.slice(wf.indexOf('\npermissions:'), wf.indexOf('\njobs:'))
    expect(block).toMatch(/permissions:/)
    const perms = [...block.matchAll(/^ +([a-z-]+):\s*(\S+)\s*$/gm)].map((m) => `${m[1]}: ${m[2]}`)
    expect(perms.length).toBeGreaterThan(0)
    for (const p of perms) {
      expect(['contents: read', 'packages: write'], `예상 밖 permission '${p}'`).toContain(p)
    }
  })

  // ② [보안] 시크릿 유출 밴 — --password-stdin 만 허용. -p/--password 의 공백·등호·붙임형 전부 밴(자가 적대리뷰 P3).
  it('GHCR 로그인은 --password-stdin(토큰 argv 유출 금지 — 공백·= ·붙임형 밴)', () => {
    const wf = workflow()
    expect(wf).toMatch(/--password-stdin/)
    expect(wf).not.toMatch(/docker login[^\n]*\s-p[ =]?\S/) // -p VALUE·-p=·-pVALUE
    expect(wf).not.toMatch(/docker login[^\n]*--password(?!-stdin)/) // --password VALUE·--password=VALUE
  })

  // ③ [fail-safe] 역필터 핀 — paths-ignore 존재 AND on.push 에 paths:(allowlist) 부재. Codex 스펙 P1.
  it('트리거는 paths-ignore 역필터(allowlist paths: 금지 — fail-open 재도입 차단)', () => {
    const wf = workflow()
    expect(wf).toMatch(/paths-ignore:/)
    // `paths-ignore:` 라인은 `paths:` 로 시작하지 않음(paths 뒤 하이픈). 순수 allowlist `paths:` 만 잡는다.
    expect(wf).not.toMatch(/^\s*paths:\s/m)
  })

  // ④ [fail-closed] 발행 순서 — smoke 게이트 < 첫 push. push 스텝에 조건부 실행 금지.
  it('smoke 게이트가 push 보다 앞(깨진 이미지 발행 차단) · push 조건부 금지', () => {
    const wf = workflow()
    const smokeIdx = wf.indexOf('deploy/smoke.sh')
    const pushIdx = wf.indexOf('docker push')
    expect(smokeIdx).toBeGreaterThanOrEqual(0)
    expect(pushIdx).toBeGreaterThan(smokeIdx)
    // fail-open 조건 밴 — bare·${{ }} 래핑 always()/failure()/!cancelled()·continue-on-error(자가 적대리뷰 P3).
    expect(wf).not.toMatch(/if:\s*\$?\{?\{?\s*always\s*\(\)/)
    expect(wf).not.toMatch(/if:[^\n]*!cancelled\s*\(\)/)
    expect(wf).not.toMatch(/if:[^\n]*failure\s*\(\)/)
    expect(wf).not.toMatch(/continue-on-error:\s*true/)
  })

  // ⑤ [race] 태그 순서 — :sha push 가 :latest push 보다 앞(롤백 타깃 선보장).
  it(':sha push 가 :latest push 보다 먼저(롤백 타깃 선보장)', () => {
    const wf = workflow()
    const shaPush = wf.search(/push\s+"?ghcr\.io\/[^"\s]*:sha-/)
    const latestPush = wf.search(/push\s+"?ghcr\.io\/[^"\s]*:latest/)
    expect(shaPush).toBeGreaterThanOrEqual(0)
    expect(latestPush).toBeGreaterThan(shaPush)
  })

  // ⑥ [계약] namespace actor-ban — image 경로에 github.actor 금지(봇/dependabot 오push 차단), owner 사용.
  it('image namespace 는 repository_owner(github.actor 금지)', () => {
    const wf = workflow()
    expect(wf).not.toMatch(/ghcr\.io\/\$\{\{\s*github\.actor/)
    expect(wf).not.toMatch(/ghcr\.io\/\$GITHUB_ACTOR/)
    expect(wf).toMatch(/GITHUB_REPOSITORY_OWNER|github\.repository_owner/)
  })

  // ⑦ [계약] SHA 12hex — 생성식 ${GITHUB_SHA::12} 또는 sha-<12hex> 패턴.
  it('SHA 태그는 12hex 고정(${GITHUB_SHA::12})', () => {
    const wf = workflow()
    expect(wf).toMatch(/GITHUB_SHA::12|GITHUB_SHA:0:12|sha-[0-9a-f]{12}/)
  })

  // ⑧ [계약] 4-way 이름 리터럴 일치 — base basename == push target == override image == smoke 폴백.
  it('이미지 이름 4-way 일치(base·발행·override·smoke)', () => {
    const base = baseCompose()
    const wf = workflow()
    const ov = override()
    for (const svc of ['fleet-server', 'fleet-webterminal']) {
      expect(base).toContain(svc) // base image basename
      expect(ov).toContain(`ghcr.io/pdw96/${svc}`) // override image
    }
    // 발행 워크플로는 `for svc in server webterminal` 로 fleet-$svc 전개(두 서비스 커버·DRY).
    expect(wf).toMatch(/for svc in server webterminal/)
    expect(wf).toMatch(/fleet-\$svc/)
    // smoke 폴백은 base 의 :local 태그를 쓴다(smoke.sh 는 별도 파일 — base basename 일치로 대리 확인).
  })

  // ⑨ [계약] paths-ignore 각 항목이 알려진 안전집합에 속함(신규 미매핑 항목 = fail-open 차단). `**/*.png` 는
  // Codex PR P2 로 제거됨 — src 하위 png 가 vite 번들(out/renderer)에 들어가면 stale 인데 .dockerignore 루트
  // `*.png` 로는 안 잡히기 때문(재귀↔루트 글롭 비대칭). 남은 `**/*.md` 는 런타임 이미지(out/)에 미포함이라 안전.
  it('paths-ignore 각 항목이 안전집합에 속함(신규 미매핑 항목=fail-open 차단)', () => {
    const wf = workflow()
    const di = dockerignore()
    // paths-ignore 블록만 추출 — `paths-ignore:` ~ `workflow_dispatch:`(다음 on 키) 사이의 single-quote 항목.
    // (파일 끝까지 slice 하면 steps 의 `- uses:` 등을 항목으로 오인한다.)
    const block = wf.slice(wf.indexOf('paths-ignore:'), wf.indexOf('workflow_dispatch:'))
    const items = [...block.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1].trim())
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      // 각 paths-ignore 항목은 알려진 안전 매핑에 있어야 하고, 그 dockerignore 대응이 실재해야 한다.
      const mapped = PATHS_IGNORE_SAFE[item]
      expect(
        mapped,
        `paths-ignore '${item}' 는 안전 매핑에 없음(이미지 영향 가능 → fail-open)`,
      ).toBeDefined()
      const lineRe = new RegExp(`^\\s*${mapped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
      expect(di, `.dockerignore 에 '${mapped}' 라인 부재`).toMatch(lineRe)
    }
  })

  // ⑩ [공급망] checkout SHA 균일 핀 — ci.yml/release.yml 과 동일 SHA + persist-credentials:false.
  // 이전 구현은 특정 SHA 를 리터럴로 박았으나 주석이 선언한 의도는 「고정된 값」이 아니라 「레포와 동일한
  // 값」이었다. Dependabot 이 워크플로 전체를 한 PR 로 일괄 범프하면(#239 실측: 7파일 10스텝 동일값)
  // 균일성 불변식은 유지되는데 리터럴만 뒤처져 무관한 RED 가 났다 → 관계 단언으로 전환(⑧ 4-way 일치와 동형).
  // 값이 SHA 핀인지 자체는 skills-lint 의 scanWorkflowPins 가 이중으로 강제한다(#245).
  it('checkout 은 레포 공통 SHA 핀 + persist-credentials:false', () => {
    const sources: Record<string, string> = {
      'deploy.yml': workflow(),
      'ci.yml': read('../.github/workflows/ci.yml'),
      'release.yml': read('../.github/workflows/release.yml'),
    }
    const all = new Set<string>()
    for (const [name, text] of Object.entries(sources)) {
      const shas = checkoutShas(text)
      // 추출 0건을 조용히 통과시키지 않는다 — 스텝 삭제·태그 ref 회귀·파일 리네임이 전부 여기서 RED.
      expect(shas.length, `${name} 에 SHA 핀된 actions/checkout 이 없다`).toBeGreaterThan(0)
      for (const s of shas) all.add(s)
    }
    expect([...all], 'checkout SHA 가 워크플로 간 불일치(균일 핀 회귀)').toHaveLength(1)

    // persist-credentials 는 checkout 스텝 본문의 실제 YAML 키 라인이어야 한다. 파일 전역 매칭은
    // 스텝에서 소실돼도 주석·타 스텝의 동일 문자열로 조용히 통과했다(기존 단언의 과소신호 결함).
    const step = checkoutStep(sources['deploy.yml'])
    expect(
      step.split('\n').some((l) => /^\s*persist-credentials:\s*false\s*(#.*)?$/.test(l)),
      'deploy.yml checkout 스텝에 persist-credentials:false 키 부재',
    ).toBe(true)
  })

  // ⑪ override 파일 핀 — fleet·ttyd 각 build:!reset + ghcr image + GHCR_TAG.
  it('docker-compose.ghcr.yml 은 build:!reset + GHCR image + GHCR_TAG', () => {
    const ov = override()
    const resets = ov.match(/build:\s*!reset/g) ?? []
    expect(resets.length).toBeGreaterThanOrEqual(2) // fleet + ttyd
    expect(ov).toContain('ghcr.io/pdw96/fleet-server')
    expect(ov).toContain('ghcr.io/pdw96/fleet-webterminal')
    expect(ov).toContain('GHCR_TAG')
  })

  // ⑫ [race] latest master-tip 가드 + GH_TOKEN — Codex 계획 P1(회귀 차단) + 재리뷰 P1(gh api 인증).
  // 순서 프록시(commits/master < :latest)만으론 「가드가 존재한다」를 담보 못 함(if 제거·`if true` 약화가 통과)
  // → 가드 조건 `[ "$TIP" = "$GITHUB_SHA" ]` 자체 존재 + latest push 가 그 뒤임을 단언(자가 적대리뷰 P2).
  it(':latest push 는 [ "$TIP" = "$GITHUB_SHA" ] 가드 뒤 + gh api 스텝에 GH_TOKEN', () => {
    const wf = workflow()
    const guard = /if\s+\[\s*"\$TIP"\s*=\s*"\$GITHUB_SHA"\s*\]/
    expect(wf).toMatch(guard) // 가드 조건 자체(if true / [ -n "$TIP" ] 로 약화되면 RED)
    expect(wf).toMatch(/commits\/master/) // master tip lookup 존재
    const guardIdx = wf.search(guard)
    const latestPush = wf.search(/push\s+"?ghcr\.io\/[^"\s]*:latest/)
    expect(latestPush).toBeGreaterThan(guardIdx) // latest push 는 가드 뒤(가드 밖으로 빼면 RED)
    // gh api 인증 — persist-credentials:false 라 GH_TOKEN 명시 필수(없으면 private 레포 401 hard-fail).
    expect(wf).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token/)
  })
})
