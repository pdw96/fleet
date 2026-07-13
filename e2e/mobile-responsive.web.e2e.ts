import { expect, test, type Page } from '@playwright/test'
import { startFleetWebServer, type RunningWebServer } from './web-server'

/**
 * #221 모바일 반응형 e2e 판정기(PR1: 셸+전역+위저드) — 실 chromium 이 ≤640px 미디어쿼리를 적용하므로
 * (jsdom 미레이아웃) 폰 뷰포트의 가로 오버플로·앵커·터치 타깃을 실측한다.
 *
 * 스크롤 아키텍처(스펙 §2): body{overflow:hidden} + .main{overflow:auto} — 패널 오버플로는 .main 이
 * 트랩하므로 documentElement.scrollWidth 단언은 topbar/footer(셸)만 커버한다. 패널 가로 스크롤 0 의
 * 권위 단언은 `.main.scrollWidth <= .main.clientWidth`.
 *
 * RED 정직성(계획 공통 규율): 구현 0줄에서 RED 가 실제로 발화해야 단언이 blind 가 아님이 증명된다.
 * PR2 활성화 예정 케이스는 test.fail() 로 "지금은 실패가 정상"을 기계 선언(GREEN 전환 시 자동 경보).
 */

const TABS = ['세션', '프로젝트', '채팅'] as const

// 파일 수준 단일 서버 — 케이스는 전부 읽기 전용(레이아웃 측정)이라 공유해도 간섭 없음.
let server: RunningWebServer

test.beforeAll(async () => {
  server = await startFleetWebServer()
})
test.afterAll(async () => {
  await server?.stop()
})

/** 폰/데스크톱 공통 진입 — reduced-motion(애니 결정론)·뷰포트·폰트 로딩 완료 후 측정. */
async function openApp(page: Page, url: string, width: number, height: number) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width, height })
  await page.goto(url)
  await page.getByText('FLEET').first().waitFor()
  // 폰트 스왑(woff2·font-display:swap)으로 측정 폭이 변하는 flake 방지 — 로딩 완료 대기.
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

async function switchTab(page: Page, tab: (typeof TABS)[number]) {
  await page.getByRole('button', { name: tab, exact: true }).click()
}

/** 가로 오버플로 측정 — doc(셸 표면)·main(패널 스크롤 컨테이너) 각각. */
async function overflowOf(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('.main')
    if (!main) throw new Error('.main 부재')
    return {
      doc: document.documentElement.scrollWidth - window.innerWidth,
      main: main.scrollWidth - main.clientWidth,
    }
  })
}

/** boundingBox 가 뷰포트 사각형 안(C2 교훈 — y+h≥X 식 단언은 오프스크린을 통과시킨다). */
function expectInViewport(
  box: { x: number; y: number; width: number; height: number } | null,
  vw: number,
  vh: number,
  label: string,
) {
  expect(box, `${label} boundingBox 없음`).not.toBeNull()
  if (!box) return
  expect(box.x, `${label} 좌측 이탈`).toBeGreaterThanOrEqual(-1)
  expect(box.y, `${label} 상단 이탈`).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width, `${label} 우측 이탈`).toBeLessThanOrEqual(vw + 1)
  expect(box.y + box.height, `${label} 하단 이탈`).toBeLessThanOrEqual(vh + 1)
}

test.describe('#221 모바일 반응형(PR1 셸) — 390×844', () => {
  test('G2 셸(3탭 공통): documentElement 가로 오버플로 0 + G1 세션 탭 .main 오버플로 0', async ({
    page,
  }) => {
    await openApp(page, server.url, 390, 844)
    for (const tab of TABS) {
      await switchTab(page, tab)
      const o = await overflowOf(page)
      expect(o.doc, `${tab} 탭 문서(셸) 가로 오버플로`).toBeLessThanOrEqual(0)
      if (tab === '세션') {
        expect(o.main, '세션 탭 .main 가로 오버플로').toBeLessThanOrEqual(0)
      }
    }
  })

  // PR2(#221)에서 .chat/.project-layout 1열 전환 후 활성화 — 232px 사이드바 그리드가 미수정이라
  // 지금은 실패가 정상(test.fail). PR1 시점에 이 단언을 강제하면 즉시 fail, 빼면 false-green(스펙 §7).
  //
  // RED 정직성 메타규칙 발동 기록(PR1 T2 실측): 채팅 탭은 232px 그리드에서도 .main 가로 오버플로가
  // 발생하지 않는다(그리드가 짜부라져 조작 불능일 뿐 스크롤 없음) — 오버플로 단언 단독은 채팅 탭에
  // blind 로 판정, "1열 스택(고정 232px 트랙 부재) + 본문 폭 점유율" computed 단언으로 교체·강화.
  for (const [tab, layoutSel, mainSel] of [
    ['채팅', '.chat', '.chat-main'],
    ['프로젝트', '.project-layout', '.project-main'],
  ] as const) {
    test(`G1/G9 ${tab} 탭 폰 1열 스택 + .main 가로 오버플로 0 — PR2 활성화`, async ({ page }) => {
      test.fail(true, `PR2(#221): ${layoutSel} 232px 그리드 미수정 — 1열 전환 후 활성화`)
      await openApp(page, server.url, 390, 844)
      await switchTab(page, tab)
      const o = await overflowOf(page)
      expect(o.main, `${tab} 탭 .main 가로 오버플로`).toBeLessThanOrEqual(0)
      const layout = await page.evaluate(
        ([lSel, mSel]) => {
          const layout = document.querySelector(lSel)
          const main = document.querySelector('.main')
          const body = document.querySelector(mSel)
          if (!layout || !main || !body) throw new Error(`${lSel}/${mSel} 부재`)
          return {
            columns: getComputedStyle(layout).gridTemplateColumns,
            bodyWidth: body.getBoundingClientRect().width,
            mainWidth: main.clientWidth,
          }
        },
        [layoutSel, mainSel] as const,
      )
      // 1열 스택 = 고정 232px 사이드바 트랙 부재(computed 는 px 목록으로 나온다).
      expect(layout.columns, `${tab} 탭 grid-template-columns`).not.toContain('232px')
      // 본문이 가용 폭을 실질 점유(짜부라진 2열 그리드의 blind 통과 방지 — 폰 조작성의 대리 지표).
      expect(layout.bodyWidth, `${tab} 탭 본문 폭 점유`).toBeGreaterThanOrEqual(
        layout.mainWidth * 0.8,
      )
    })
  }

  // PR2 활성화 케이스(test.fail)가 셀렉터 rename 시 "부재 throw = 계속 expected-fail" 로 경보가
  // 영구 침묵하는 경로 차단(자체 적대 리뷰 P3-1) — 셀렉터 존재 자체는 항상-GREEN 계약으로 분리.
  test('PR2 셀렉터 계약 — .chat/.chat-main·.project-layout/.project-main 존재', async ({
    page,
  }) => {
    await openApp(page, server.url, 390, 844)
    await switchTab(page, '채팅')
    await expect(page.locator('.chat')).toHaveCount(1)
    await expect(page.locator('.chat-main')).toHaveCount(1)
    await switchTab(page, '프로젝트')
    await expect(page.locator('.project-layout')).toHaveCount(1)
    await expect(page.locator('.project-main')).toHaveCount(1)
  })

  test('G3 내비 3탭 뷰포트내 앵커 + G4 터치 타깃 ≥44px(내비·위저드 bare 버튼·.btn 표본)', async ({
    page,
  }) => {
    await openApp(page, server.url, 390, 844)
    // G3: 세그먼트 내비 3버튼 전부 뷰포트 사각형 안.
    for (const tab of TABS) {
      const box = await page.getByRole('button', { name: tab, exact: true }).boundingBox()
      expectInViewport(box, 390, 844, `내비 [${tab}]`)
    }
    // G4: 내비 터치 타깃.
    for (const tab of TABS) {
      const box = await page.getByRole('button', { name: tab, exact: true }).boundingBox()
      expect(box, `내비 [${tab}]`).not.toBeNull()
      if (box) expect(box.height, `내비 [${tab}] 높이`).toBeGreaterThanOrEqual(44)
    }
    // G4: 위저드 bare 버튼(.wizard 래퍼 스코프 — 다른 표면의 무클래스 버튼 혼입 차단·CodeRabbit).
    const bareButtons = page.locator('.wizard button:not([class])')
    const bareCount = await bareButtons.count()
    expect(bareCount, '위저드 bare 버튼 표본 존재').toBeGreaterThan(0)
    // 실측 실행 횟수 단언 — invisible/box 부재 무음 skip 으로 루프가 공허해지는 미래 변경을 적발
    // (자체 적대 리뷰 P2-3: 위저드 접힘 기본값 전환 등).
    let measured = 0
    for (let i = 0; i < bareCount; i++) {
      const b = bareButtons.nth(i)
      if (!(await b.isVisible())) continue
      const box = await b.boundingBox()
      if (!box) continue
      expect(box.height, `위저드 bare 버튼 #${i} 높이`).toBeGreaterThanOrEqual(44)
      measured++
    }
    expect(measured, '위저드 bare 버튼 실측 수(공허 루프 방지)').toBeGreaterThan(0)
    // G4: .btn 표본(세션 카드 삭제 버튼 — FLEET_E2E 시드 세션 2개로 존재 보장).
    const btn = page.locator('.main .btn').first()
    const btnBox = await btn.boundingBox()
    expect(btnBox, '.btn 표본').not.toBeNull()
    if (btnBox) expect(btnBox.height, '.btn 높이').toBeGreaterThanOrEqual(44)
  })

  test('G5 폼 필드 computed 16px(iOS 자동 줌 방지) — .field + 위저드 bare input 실경로', async ({
    page,
  }) => {
    await openApp(page, server.url, 390, 844)
    // 표본 1: .field(#mcp-servers — 세션 탭 유일 .field 라 두 셀렉터는 같은 노드였다: 자체 적대 리뷰 P2-1).
    const fieldSize = await page.evaluate(() => {
      const t = document.querySelector('#mcp-servers')
      return t ? getComputedStyle(t).fontSize : 'missing'
    })
    expect(fieldSize, '.field(#mcp-servers) computed font-size').toBe('16px')
    // 표본 2: 위저드 bare input — 요소 셀렉터(input) 규칙의 존재 이유. 초기 스텝엔 input 이 없어
    // 실경로(프로바이더→API 키)로 진입해 측정한다(요소 규칙 축소 회귀를 e2e 층에서도 적발).
    await page.locator('.wizard button:not([class])').first().click() // 프로바이더 선택
    await page.getByRole('button', { name: 'API 키', exact: true }).click()
    const bareInput = page.locator('.wizard input').first()
    await bareInput.waitFor()
    const bareSize = await bareInput.evaluate((el) => getComputedStyle(el).fontSize)
    expect(bareSize, '위저드 bare input computed font-size').toBe('16px')
  })
})

test.describe('#221 모바일 반응형(PR1 셸) — 360×740 최소 폭 계약', () => {
  test('G3 재단언: 360px 에서도 내비 3탭 뷰포트내(스펙 §7 "360px 폭 수용" 문면)', async ({
    page,
  }) => {
    await openApp(page, server.url, 360, 740)
    for (const tab of TABS) {
      const box = await page.getByRole('button', { name: tab, exact: true }).boundingBox()
      expectInViewport(box, 360, 740, `내비 [${tab}]`)
    }
    const o = await overflowOf(page)
    expect(o.doc, '360px 문서(셸) 가로 오버플로').toBeLessThanOrEqual(0)
  })
})

// R1 데스크톱 무회귀 가드 — §6 "640px 블록은 >640px 완전 비활성"의 기계 판별. 초안 B의 "기존 web e2e
// 가 데스크톱 겸임" 가정은 반증됨(approval-hold/handoff 가 390×844) — 명시 가드가 유일한 기계 게이트.
// 이 케이스들은 구현 전 GREEN(현행 값 핀)이어야 하고, 640px 블록이 새면 즉시 적발한다.
test.describe('#221 데스크톱 무회귀 가드 — 641×900(경계 최소 초과)·1280×800(대표)', () => {
  for (const [w, h] of [
    [641, 900],
    [1280, 800],
  ] as const) {
    test(`R1 ${w}×${h}: topbar/main/footer·타이포 유지(폰 분기 미적용)`, async ({ page }) => {
      await openApp(page, server.url, w, h)
      // footer 는 getAppInfo() 비동기 완료 후 조건부 렌더(App.tsx) — 대기 없이 computed 를 읽으면
      // 느린 기동에서 '.footer 부재' throw 로 flaky(Codex PR 1R P2).
      await page.locator('.footer').waitFor()
      const computed = await page.evaluate(() => {
        const q = (sel: string) => {
          const el = document.querySelector(sel)
          if (!el) throw new Error(`${sel} 부재`)
          return getComputedStyle(el)
        }
        const topbar = q('.topbar')
        const footer = q('.footer')
        return {
          gap: topbar.gap,
          // 4변 padding — shorthand→additive 재작성의 산술 실수를 기계 핀(자체 적대 리뷰 P3-3)
          topbarPad: [
            topbar.paddingTop,
            topbar.paddingRight,
            topbar.paddingBottom,
            topbar.paddingLeft,
          ],
          footerPad: [footer.paddingTop, footer.paddingBottom, footer.paddingLeft],
          mainPad: q('.main').paddingLeft,
          brandFont: q('.brand h1').fontSize,
          fieldFont: q('#mcp-servers').fontSize,
          bodyFont: getComputedStyle(document.body).fontSize,
          tagVisible: q('.brand .tag').display !== 'none',
        }
      })
      expect(computed.gap, 'topbar gap').toBe('28px')
      expect(computed.topbarPad, 'topbar padding 4변').toEqual(['16px', '26px', '16px', '26px'])
      expect(computed.footerPad, 'footer padding').toEqual(['9px', '9px', '26px'])
      expect(computed.mainPad, '.main padding').toBe('26px')
      expect(computed.brandFont, 'brand h1').toBe('27px')
      expect(computed.fieldFont, '.field(#mcp-servers) font-size').toBe('13px')
      expect(computed.bodyFont, 'body font-size').toBe('13px')
      expect(computed.tagVisible, '.brand .tag 가시(데스크톱)').toBe(true)
    })
  }
})
