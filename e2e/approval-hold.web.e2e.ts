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
})
