import { expect, test } from '@playwright/test'
import { startFleetWebServer, type RunningWebServer } from './web-server'

/**
 * C1 승인 보류 웹 종단 스모크(#216) — 실 chromium 이 fleet-server(빌드 번들·hold 정책)를 열고, 브라우저에서
 * MCP 서버 설정(destructive shell spawn) 승인을 유발한다. 서버는 presence 무관 **보류(hold)** 하고, 페이지
 * 리로드(새 마운트) 후 `listPendingApprovals` 스냅숏으로 held 카드를 **재제시**하며(외출 중 폰 승인 완료정의의
 * 로컬 loopback 등가), 거부 시 `fleet:approval:withdrawn` 브로드캐스트로 카드가 소멸한다. 실 Cloudflare Access
 * 터널 폰 승인 라이브는 C5(운영 문서+라이브)로 위임 — 이 테스트는 hold→스냅숏 재하이드레이션→tombstone 해소
 * 전송/렌더 경로를 실브라우저+실서버로 자동 검증한다.
 */
test.describe('C1 승인 보류(#216) — hold → 리로드 재하이드레이션 → 해소', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer()
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('MCP spawn 승인 hold → 리로드 스냅숏 재제시 → 거부 시 소멸', async ({ page }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()

    // 브라우저(ws-bridge)에서 MCP 서버 설정 → spawn 은 destructive shell 승인 게이트를 통과해야 한다.
    // hold 정책이라 응답 전까지 pending — setMcpServers promise 는 await 하지 않는다(승인/만료가 종착).
    await page.evaluate(() => {
      void (
        window as unknown as { fleet: { setMcpServers: (s: unknown[]) => Promise<unknown> } }
      ).fleet
        .setMcpServers([{ name: 'c1-hold', command: 'nonexistent-approval-probe' }])
        .catch(() => undefined)
    })

    // 라이브 승인 카드(fleet:approval:request 브로드캐스트) — hold 이므로 presence 무관 표시.
    await expect(page.getByText('MCP 서버 실행: c1-hold')).toBeVisible({ timeout: 10_000 })

    // 리로드 = 새 브리지·새 마운트 → listPendingApprovals 스냅숏 재하이드레이션으로 held 카드 재제시.
    await page.reload()
    await page.getByText('FLEET').first().waitFor()
    await expect(page.getByText('MCP 서버 실행: c1-hold')).toBeVisible({ timeout: 10_000 })

    // 거부 → respondApproval → 서버 resolve → onWithdraw 브로드캐스트 → 카드 소멸(tombstone).
    await page.getByRole('button', { name: '거부' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  // 사용자 폰 흐름을 실 UI 클릭으로 재현(세션 탭 04-MCP 섹션 → 적용 버튼 → 승인 카드 → 리로드 → 승인).
  test('UI 실클릭: MCP 적용 버튼 → 승인 카드 hold → 리로드 스냅숏 재제시 → 승인 카드 소멸', async ({
    page,
  }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    // 세션 탭이 기본 — "04 — MCP" 섹션의 JSON 텍스트박스에 입력하고 "MCP 적용" 클릭.
    await page
      .locator('#mcp-servers')
      .fill('[{"name":"c1-ui-test","command":"echo","args":["hi"]}]')
    await page.getByRole('button', { name: 'MCP 적용' }).click()
    // spawn 은 destructive shell 승인 게이트를 통과해야 하고 hold 라 승인 카드가 뜬다.
    await expect(page.getByText('MCP 서버 실행: c1-ui-test')).toBeVisible({ timeout: 10_000 })
    // 리로드 = 새 마운트 → listPendingApprovals 스냅숏으로 held 카드 재제시.
    await page.reload()
    await page.getByText('FLEET').first().waitFor()
    await expect(page.getByText('MCP 서버 실행: c1-ui-test')).toBeVisible({ timeout: 10_000 })
    // 승인 클릭(pointerdown+click) → respondApproval → 서버 resolve → withdrawn → 카드 소멸.
    await page.getByRole('button', { name: '승인' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  // C2(#216) 폰 뷰포트 — 실 chromium 이 ≤640px 미디어쿼리를 적용하므로(jsdom 미검) 바텀시트 앵커·
  // 풀폭·mm:ss 카운트다운·엄지 버튼 조작을 실측한다.
  test('C2 폰 뷰포트: 승인 카드가 바텀시트로 앵커·mm:ss 카운트다운·거부 버튼 소멸', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    await page.evaluate(() => {
      void (
        window as unknown as { fleet: { setMcpServers: (s: unknown[]) => Promise<unknown> } }
      ).fleet
        .setMcpServers([{ name: 'c2-phone', command: 'nonexistent-approval-probe' }])
        .catch(() => undefined)
    })
    const dialog = page.getByRole('dialog')
    await expect(page.getByText('MCP 서버 실행: c2-phone')).toBeVisible({ timeout: 10_000 })

    // 바텀시트 앵커: 카드가 좌측 끝·풀폭·하단 고정(≤640px). jsdom 은 레이아웃 미평가라 여기서만 검증.
    const box = await dialog.locator('.modal-card').boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.x).toBeLessThanOrEqual(1) // 좌측 끝(풀폭 stretch)
      expect(box.width).toBeGreaterThanOrEqual(388) // 뷰포트(390) 폭
      expect(box.y + box.height).toBeGreaterThanOrEqual(842) // 하단 앵커(엄지존)
    }

    // 서버 권위 mm:ss 카운트다운(Ns 아님).
    await expect(page.getByText(/\d+:\d{2} 후 자동 거부/)).toBeVisible()

    // 엄지 버튼(거부) 조작 → 서버 resolve → withdrawn → 카드 소멸.
    await page.getByRole('button', { name: '거부' }).click()
    await expect(dialog).toHaveCount(0)
  })
})
