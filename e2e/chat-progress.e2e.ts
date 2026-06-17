import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * 회귀 가드: 진행 중인 토론이 탭 전환(ChatPanel 언마운트→리마운트)에도 살아남아야 한다.
 * 실제 Electron 빌드를 FLEET_E2E 로 띄워 — 페이크 러너가 토큰 1개를 흘린 뒤 발언을 in-flight 로 고정 —
 * 진행 표시("AI 토론 중…")와 라이브 말풍선이 탭 왕복 후 복원되는지 실제 GUI 에서 검증한다.
 */

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  // userData 를 임시 디렉터리로 격리(실제 사용자 store 오염 방지) — Electron 이 --user-data-dir 를 존중.
  userDataDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'))
  app = await electron.launch({
    args: [resolve(__dirname, '..', 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, FLEET_E2E: '1', NODE_ENV: 'production' },
  })
  page = await app.firstWindow()
  await page.getByText('FLEET').first().waitFor()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('진행 중 토론이 탭 전환(언마운트/리마운트) 후에도 유지된다', async () => {
  // 채팅 탭 진입(방은 시드로 자동 선택됨) → 토론 시작
  await page.getByRole('button', { name: '채팅' }).click()
  await page.getByRole('button', { name: /AI 자동 토론/ }).click()

  // 진행 표시 + 라이브 말풍선(누적 토큰)이 보여야 한다
  await expect(page.getByText('AI 토론 중…')).toBeVisible()
  await expect(page.getByText('진행 중 응답')).toBeVisible()
  await page.screenshot({ path: 'e2e/__screenshots__/01-busy-before-switch.png' })

  // 다른 탭으로 이동 → ChatPanel 언마운트(진행 표시 사라짐) → 다시 채팅 탭으로 리마운트
  await page.getByRole('button', { name: '세션' }).click()
  await expect(page.getByText('AI 토론 중…')).toHaveCount(0)
  await page.getByRole('button', { name: '채팅' }).click()

  // 핵심 단언: main 스냅샷(getChatActivity)으로 진행 표시와 라이브 말풍선이 복원된다(버그면 끝난 것처럼 보임)
  await expect(page.getByText('AI 토론 중…')).toBeVisible()
  await expect(page.getByText('진행 중 응답')).toBeVisible()
  await page.screenshot({ path: 'e2e/__screenshots__/02-busy-after-remount.png' })
})
