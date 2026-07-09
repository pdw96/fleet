import { expect, test } from '@playwright/test'
import { startFleetWebServer, type RunningWebServer } from './web-server'

/**
 * C5 승인 핸드오프(#216) — 완료정의("외출 중 폰 승인 → PC 이어서") 코어의 로컬 loopback 회귀 하니스.
 * 컨텍스트 A(PC)에서 held 승인을 유발하고 **A 컨텍스트를 완전 close**(소켓 단절·presence→0)한 뒤, **fresh
 * 컨텍스트 B(폰뷰)**가 listPendingApprovals 스냅숏으로 카드를 재제시받아 승인 → withdrawn 을 검증한다.
 * 기존 approval-hold 테스트는 **같은 컨텍스트 reload** 만 증명 — 이 테스트는 **별도 컨텍스트 완전 teardown**
 * 후 재하이드레이션으로 진짜 presence 전이 정황을 증명한다(실 Access-인증 교차 핸드오프는 C5 §2b 라이브 위임).
 * loopback 은 컨텍스트별 auth/nonce 가 없어 clientCount 를 black-box 로 직접 단언할 수 없으므로, 주장은
 * "A close → 서버가 재하이드레이션으로 B 에 pending 재제시"로 한정한다(Codex 체크포인트 P2).
 */
test.describe('C5 승인 핸드오프(#216) — 컨텍스트 A close → fresh 컨텍스트 B 재하이드레이션', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer()
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('A held 승인 → A 완전 close → B(폰뷰) 스냅숏 재제시 → 승인 소멸', async ({ browser }) => {
    // 컨텍스트 A(PC) — MCP spawn(destructive) 게이트로 held 승인 유발.
    const ctxA = await browser.newContext()
    const pageA = await ctxA.newPage()
    await pageA.goto(server.url)
    await pageA.getByText('FLEET').first().waitFor()
    await pageA.evaluate(() => {
      void (
        window as unknown as { fleet: { setMcpServers: (s: unknown[]) => Promise<unknown> } }
      ).fleet
        .setMcpServers([{ name: 'c5-handoff', command: 'nonexistent-approval-probe' }])
        .catch(() => undefined)
    })
    await expect(pageA.getByText('MCP 서버 실행: c5-handoff')).toBeVisible({ timeout: 10_000 })

    // A 컨텍스트 완전 teardown — WS 소켓 단절, presence→0. hold 정책이라 held 승인은 생존해야 한다.
    await ctxA.close()

    // fresh 컨텍스트 B(폰뷰) — App mount 가 listPendingApprovals 스냅숏으로 카드 재제시.
    // (B 가 카드를 본다는 것 자체가 "A close 후 서버가 held 를 유지했다"는 증명 — withdrawn 이었으면 안 보임.)
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const pageB = await ctxB.newPage()
    await pageB.goto(server.url)
    await pageB.getByText('FLEET').first().waitFor()
    await expect(pageB.getByText('MCP 서버 실행: c5-handoff')).toBeVisible({ timeout: 10_000 })

    // B 에서 승인 → respondApproval → 서버 resolve → withdrawn → 카드 소멸.
    await pageB.getByRole('button', { name: '승인' }).click()
    await expect(pageB.getByRole('dialog')).toHaveCount(0)
    await ctxB.close()
  })
})
