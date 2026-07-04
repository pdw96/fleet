import { expect, test } from '@playwright/test'
import { startFleetWebServer, type RunningWebServer } from './web-server'

/**
 * 웹모드 브라우저 스모크(#197 B4) — 실 chromium 이 fleet-server(빌드 번들)의 정적 renderer 를 열고
 * ws-bridge 로 오케스트레이션을 구동한다(문 ② e2e). ① 목표 입력→런 개시 + 리로드 후 WS 스냅샷
 * 재하이드레이션 복원(데스크톱 탭전환 스모크의 웹 등가) ② 서버 단절→같은 포트 재기동 재접속 배너·복구
 * ③ 완주 러너로 목표 입력→project.done(이슈 완료 정의 "런 완주").
 */

test.describe('런 개시·복원 (기본 hang 러너)', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer()
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('목표 입력→런 개시, 리로드 후 WS 재하이드레이션으로 잠금 복원', async ({ page }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    await expect(page.locator('footer')).toContainText('Web') // runtime 게이팅 — 웹 footer

    await page.getByRole('button', { name: '프로젝트' }).click()
    await page.getByPlaceholder(/사용자 인증/).fill('웹 스모크 — 진행 고정 목표')
    await page.getByRole('button', { name: '오케스트레이션 실행' }).click()
    await expect(page.getByRole('button', { name: '취소' })).toBeVisible()
    await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()

    // 새 페이지 = 새 브리지 = 마운트 하이드레이션이 WS 스냅샷(getRunActivity)으로 복원해야 한다.
    await page.reload()
    await page.getByText('FLEET').first().waitFor()
    await page.getByRole('button', { name: '프로젝트' }).click()
    await expect(page.getByRole('button', { name: '취소' })).toBeVisible()
    await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()
  })
})

test.describe('연결 끊김→복구 (기본 hang 러너)', () => {
  // 계획 편차(T10 실측): playwright `context.setOffline(true)` 는 이 chromium 에서 이미 열린 WebSocket 을
  // 끊지 않아(새 요청만 차단) ws-bridge 가 단절을 관측하지 못한다. 대신 서버를 실제로 내려 소켓을 끊고
  // 같은 포트로 재기동해 재접속을 유발한다 — in-memory 실행 상태는 소실되지만 배너/재하이드레이션 통지
  // (체크포인트 2-R 노트 3)만 검증하므로 충분하다. 서버 수명은 이 테스트가 직접 관리한다.
  test('서버 단절→같은 포트 재기동: 재접속 배너와 스냅숏 권위 통지', async ({ page }) => {
    let srv = await startFleetWebServer()
    const port = new URL(srv.url).port
    try {
      await page.goto(srv.url)
      await page.getByText('FLEET').first().waitFor()
      await srv.stop() // 소켓 단절 → ws-bridge 백오프 재접속
      await expect(page.getByRole('status').filter({ hasText: '재접속 중' })).toBeVisible({
        timeout: 20_000,
      })
      srv = await startFleetWebServer({ FLEET_PORT: port }) // 같은 포트 재기동 → 재접속 → hello → nonce+1
      await expect(page.getByRole('status').filter({ hasText: '스냅숏이 권위' })).toBeVisible({
        timeout: 25_000,
      })
    } finally {
      await srv.stop()
    }
  })
})

test.describe('런 완주 (완주 러너 opt-in)', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer({ FLEET_E2E_RUNNER: 'complete' })
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('목표 입력→런 완주(project.done — 요약 표시·잠금 해제)', async ({ page }) => {
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()
    await page.getByRole('button', { name: '프로젝트' }).click()
    await page.getByPlaceholder(/사용자 인증/).fill('웹 스모크 — 완주 목표')
    await page.getByRole('button', { name: '오케스트레이션 실행' }).click()
    // 완주: 요약 패널이 뜨고(런 결과), 실행 버튼이 재활성(잠금 해제 = project.done)된다.
    await expect(page.getByText('최종 요약 / 누락 점검')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByRole('button', { name: '오케스트레이션 실행' })).toBeEnabled()
  })
})
