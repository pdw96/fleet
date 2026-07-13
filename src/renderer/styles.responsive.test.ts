import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #221 모바일 반응형 계약 핀 — jsdom 은 실 레이아웃을 계산하지 않으므로 styles.css·index.html
// 문면으로 규칙 존재/패턴을 회귀 가드한다(선례: ApprovalModal.test.tsx «반응형 CSS(회귀 가드)»).
// 실 레이아웃은 e2e/mobile-responsive.web.e2e.ts(폰 뷰포트)·라이브 폰 실측이 검증.
// 주석 스트립 후 파싱 — 파서(중괄호 짝맞춤·문자열 매칭)가 주석 내 {}·리터럴 @media 문구에 깨져
// 블록 과확장→R10 false-green 이 되는 경로 차단(자체 적대 리뷰 P3-2).
const css = readFileSync(join(process.cwd(), 'src/renderer/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')

/** 지정 미디어쿼리의 블록 본문 전부를 중괄호 짝맞춤으로 추출한다(640px 블록은 C2 승인·신설 셸 2개 — naive first-match 는 blind). */
function mediaBlocks(source: string, query: string): string[] {
  const blocks: string[] = []
  let idx = 0
  for (;;) {
    const start = source.indexOf(query, idx)
    if (start === -1) break
    const open = source.indexOf('{', start)
    let depth = 1
    let i = open + 1
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    blocks.push(source.slice(open + 1, i - 1))
    idx = i
  }
  return blocks
}

/** 셀렉터의 rule 블록 본문 전부(전 소스 — 미디어쿼리 안팎 불문). */
function ruleBlocks(source: string, selector: string): string[] {
  const blocks: string[] = []
  let idx = 0
  const needle = `${selector} {`
  for (;;) {
    const start = source.indexOf(needle, idx)
    if (start === -1) break
    const open = start + needle.length - 1
    const close = source.indexOf('}', open)
    blocks.push(source.slice(open + 1, close))
    idx = close
  }
  return blocks
}

const mobile = mediaBlocks(css, '@media (max-width: 640px)')
// 셸 블록 식별 마커 = .topbar(신설) · C2 블록 마커 = .modal-overlay(기존 승인 바텀시트)
const shell = mobile.find((b) => b.includes('.topbar')) ?? ''

describe('#221 §6 열거 예외 — 전 뷰포트 diff 의 데스크톱 no-op 패턴 핀', () => {
  it('G6① dvh 폴백 병기 — vh 선행·dvh 후행 순서(순서 역전=구형 브라우저 파손)', () => {
    // .app 셸 높이
    expect(css).toMatch(/height: 100vh;\s*\n\s*height: 100dvh;/)
    // .chat 높이(calc)
    expect(css).toMatch(/height: calc\(100vh - 160px\);\s*\n\s*height: calc\(100dvh - 160px\);/)
  })

  it('G6② safe-area 는 additive 패턴만 — 모든 env() 출현 각각이 max()/calc() 내부·출현 ≥4', () => {
    // env 출현 **각각**의 부모 함수를 괄호 스코프로 판정 — 선언/라인 정규식은 다중 env 중 하나만
    // additive 여도 통과한다(자체 적대 리뷰 P3-4 + CodeRabbit).
    const insideAdditive = (decl: string, envIdx: number): boolean => {
      let depth = 0
      for (let j = envIdx - 1; j >= 0; j--) {
        const ch = decl[j]
        if (ch === ')') depth++
        else if (ch === '(') {
          if (depth === 0) return /(max|calc)$/.test(decl.slice(Math.max(0, j - 4), j))
          depth--
        }
      }
      return false
    }
    const decls = css.split(';').filter((d) => d.includes('env(safe-area-inset'))
    expect(decls.length).toBeGreaterThanOrEqual(4)
    for (const d of decls) {
      for (
        let i = d.indexOf('env(safe-area-inset');
        i !== -1;
        i = d.indexOf('env(safe-area-inset', i + 1)
      ) {
        expect(insideAdditive(d, i), `additive 밖 env 사용: ${d.trim()}`).toBe(true)
      }
    }
  })

  it('G6③ safe-area 대상 4셀렉터(.topbar·.footer·.update-banner·.modal-actions) 각각에 존재', () => {
    for (const sel of ['.topbar', '.footer', '.update-banner', '.modal-actions']) {
      const hasEnv = ruleBlocks(css, sel).some((b) => b.includes('env(safe-area-inset'))
      expect(hasEnv, `${sel} 에 safe-area additive 패딩 부재`).toBe(true)
    }
  })

  it('G7 viewport meta 확장 + CSP meta 불변(형제 계약)', () => {
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('interactive-widget=resizes-content')
    // CSP 는 이 작업의 비대상 — 문면 고정(window-hardening 형제 계약)
    expect(html).toContain(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
    )
  })

  it('G8 .summary 긴 무공백 토큰 줄바꿈(전 뷰포트 결함 수정 — 실물 셀렉터는 pre.summary 아닌 .summary)', () => {
    const hasWrap = ruleBlocks(css, '.summary').some((b) => b.includes('overflow-wrap: break-word'))
    expect(hasWrap).toBe(true)
  })
})

describe('#221 ≤640px 셸 블록 — 폰 분기 규칙 존재 핀(미감 수치는 핀 금지·계약 수치만)', () => {
  it('셸 640px 블록 존재(.topbar 규칙 포함 — C2 승인 블록과 별도)', () => {
    expect(shell).not.toBe('')
  })

  it('터치 타깃 44px·폼 16px(iOS 자동 줌 방지) 계약 수치 — 셀렉터 결합 핀(대체 충족 차단)', () => {
    // 존재-수준 핀은 다른 규칙이 대체 충족해 계약 셀렉터 삭제를 가린다(자체 적대 리뷰 P2-1/P3-4)
    // — 셀렉터 그룹과 선언을 결합해 핀.
    expect(ruleBlocks(shell, '.nav-btn').some((b) => b.includes('min-height: 44px'))).toBe(true)
    expect(shell).toMatch(
      /\.btn,\s*\.btn-sm,\s*\.room-btn,\s*\.ask-btn,\s*button\.chip,\s*\.field\s*\{[^}]*min-height: *44px/,
    )
    // 위저드 bare input 커버의 존재 이유가 요소 셀렉터다 — .field 만 남기는 축소를 적발.
    expect(shell).toMatch(/\.field,\s*input,\s*select,\s*textarea\s*\{[^}]*font-size: *16px/)
  })

  it('R6 인라인 고정폭 대응 — .row 랩 + .row > * max-width 100%(인라인 width 를 이기는 별개 속성)', () => {
    const rowInShell = ruleBlocks(shell, '.row')
    expect(rowInShell.some((b) => b.includes('flex-wrap: wrap'))).toBe(true)
    expect(shell).toMatch(/\.row > \*\s*\{[^}]*max-width: *100%/)
  })

  it('R5 .update-banner 폭 캡 — fixed 라 scrollWidth 단언이 못 잡는 표면(ConnectionBanner 공유)', () => {
    const bannerInShell = ruleBlocks(shell, '.update-banner')
    expect(bannerInShell.some((b) => b.includes('max-width'))).toBe(true)
  })

  it('.wizard 스타일 훅 — 규칙별 결합 핀(폭 100%·버튼/라벨 44px — 대체 충족 차단)', () => {
    expect(shell).toMatch(
      /\.wizard input:not\(\[type='checkbox'\]\),\s*\.wizard select\s*\{[^}]*width: *100%/,
    )
    expect(shell).toMatch(/\.wizard button\s*\{[^}]*min-height: *44px/)
    expect(shell).toMatch(/\.wizard label\s*\{[^}]*min-height: *44px/)
    // 구독 스텝 bare <code>(CLI 경로·로그인 명령) 긴 토큰 줄바꿈(Codex PR 1R P2)
    expect(shell).toMatch(/\.wizard code\s*\{[^}]*overflow-wrap: *anywhere/)
  })
})

describe('#221 R10 — reduced-motion 규율(§6-3: 640px 블록 밖 신규 추가 금지)', () => {
  it('640px 블록 밖 prefers-reduced-motion 출현 = 기존 2곳 고정(블록 안 중첩은 자유)', () => {
    // 640px 블록 전부를 제거한 나머지에서 카운트 — 전역 블록(:991)·modal-card 블록(:1149)
    let rest = css
    for (const b of mobile) rest = rest.replace(b, '')
    const count = (rest.match(/@media \(prefers-reduced-motion/g) ?? []).length
    expect(count).toBe(2)
  })
})
