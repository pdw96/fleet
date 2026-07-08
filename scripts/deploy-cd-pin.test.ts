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

// paths-ignore 항목 → .dockerignore 대응(기저 경로). 스킵되는 건 이미지 무영향뿐이어야 한다(fail-safe).
const PATHS_IGNORE_SAFE: Record<string, string> = {
  'docs/**': 'docs',
  '**/*.md': '*.md',
  '.claude/**': '.claude',
  '.dogfood/**': '.dogfood',
  '**/*.png': '*.png',
  'coverage/**': 'coverage',
  '.vscode/**': '.vscode',
  '.idea/**': '.idea',
  'fleet-brain.html': 'fleet-brain.html',
}

describe('deploy: GHCR CD 발행 정책 핀(#222)', () => {
  // ① [보안] 권한 최소성 음성 핀 — contents:read + packages:write 만. 그 외 write 스코프 부재.
  it('permissions 는 contents:read + packages:write 만(id-token/attestations/contents:write 부재)', () => {
    const wf = workflow()
    expect(wf).toMatch(/permissions:/)
    expect(wf).toMatch(/contents:\s*read/)
    expect(wf).toMatch(/packages:\s*write/)
    expect(wf).not.toMatch(/id-token:\s*write/)
    expect(wf).not.toMatch(/attestations:\s*write/)
    expect(wf).not.toMatch(/contents:\s*write/)
  })

  // ② [보안] 시크릿 유출 밴 — --password-stdin 존재 AND docker login 에 -p/--password argv 부재.
  it('GHCR 로그인은 --password-stdin(토큰 argv 유출 금지)', () => {
    const wf = workflow()
    expect(wf).toMatch(/--password-stdin/)
    expect(wf).not.toMatch(/docker login[^\n]*\s(-p\s|--password\s)/)
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
    expect(wf).not.toMatch(/if:\s*always\(\)/)
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

  // ⑨ [계약] paths-ignore ⊆ (.dockerignore ∪ {README.md}) — 스킵되는 건 이미지 무영향뿐(fail-safe).
  it('paths-ignore 각 항목이 .dockerignore 안전집합에 대응(미대응=fail-open 차단)', () => {
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
  it('checkout 은 레포 공통 SHA 핀 + persist-credentials:false', () => {
    const wf = workflow()
    expect(wf).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')
    expect(wf).toMatch(/persist-credentials:\s*false/)
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
  it(':latest 는 master-tip 가드 뒤 + gh api 스텝에 GH_TOKEN', () => {
    const wf = workflow()
    // master tip lookup(commits/master) 이 존재하고 :latest push 가 그 뒤에 온다.
    const tipIdx = wf.indexOf('commits/master')
    const latestPush = wf.search(/push\s+"?ghcr\.io\/[^"\s]*:latest/)
    expect(tipIdx).toBeGreaterThanOrEqual(0)
    expect(latestPush).toBeGreaterThan(tipIdx)
    // gh api 인증 — persist-credentials:false 라 GH_TOKEN 명시 필수(없으면 private 레포 401 hard-fail).
    expect(wf).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token/)
  })
})
