import { expect, test } from '@playwright/test'
import { startFleetWebServerRaw, type RawWebServer } from './web-server'

/**
 * C5 graceful drain(#216 C3) 프로세스급 회귀 하니스 — hang 런(기본 e2e 러너가 planTasks 에서 hang)을 활성으로
 * 만든 뒤 서버 프로세스에 **실 SIGTERM** 을 보내, 드레인 시퀀스(draining 브로드캐스트/로그 → waitForRunDrain 이
 * 진행 런을 상한까지 대기 → force close → clean exit 0)를 단언한다. 유휴 서버 SIGTERM 은 즉시 종료(false-green)
 * 이므로 hang 런으로 activeProjectIds 를 채우고 **경과 ≥ 상한** canary 로 실제 대기를 증명한다.
 * win32 는 kill('SIGTERM')=강제 종료라 드레인 미발화 → skip(실 docker stop 조율은 C5 §2b 라이브 위임).
 */
test.describe('C5 graceful drain(#216 C3) — hang 런 활성 중 SIGTERM → 대기 → clean exit', () => {
  test.skip(
    process.platform === 'win32',
    'win32 kill=강제 종료 — 드레인 미발화(실 Linux SIGTERM 필요·§2b docker 위임)',
  )

  test('hang 런 활성 → SIGTERM → draining 로그 + drain 상한 대기(경과 canary) + clean exit 0', async ({
    browser,
  }) => {
    // 짧은 drain 상한(2500ms)으로 기동 — hang 런은 abort 를 미honor 하므로 상한까지 대기 후 force close.
    const server: RawWebServer = await startFleetWebServerRaw({ FLEET_DRAIN_TIMEOUT_MS: '2500' })
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()

    // hang 런 개시(기본 러너 planTasks hang) → activeProjectIds 비지 않음(취소 버튼 = 진행 잠금).
    await page.getByRole('button', { name: '프로젝트' }).click()
    await page.getByPlaceholder(/사용자 인증/).fill('C5 drain — hang 목표')
    await page.getByRole('button', { name: '오케스트레이션 실행' }).click()
    await expect(page.getByRole('button', { name: '취소' })).toBeVisible()

    // 실 SIGTERM → 드레인 시작. 브라우저(WS 클라)가 draining 배너 관측(broadcast 증명·best-effort·race 허용).
    server.sigterm()
    await expect(page.getByRole('status').filter({ hasText: '서버 종료 중' })).toBeVisible({
      timeout: 8_000,
    })

    // 프로세스가 drain 상한만큼 대기 후 종료. 경과 ≥ ~상한 = 진짜 대기(유휴 즉시종료 false-green 차단).
    const { code, elapsedMs, stdout } = await server.waitExit()
    expect(stdout).toContain('[fleet] draining') // 결정론 broadcast 관측(로그)
    expect(elapsedMs).toBeGreaterThanOrEqual(2000) // ≥ ~상한: 실제 드레인 대기 증명
    expect(code).toBe(0) // clean shutdown(exit 0)
    await ctx.close()
  })
})
