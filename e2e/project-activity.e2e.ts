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
 * 회귀 가드(#27 Next②): 진행 중인 프로젝트 실행이 탭 전환(ProjectPanel 언마운트→리마운트)에도
 * 살아남아야 한다. 실제 Electron 빌드를 FLEET_E2E 로 띄워 — 페이크 러너가 planTasks 에서 hang 해
 * 실행을 project.created 직후 in-flight 로 고정 — 취소 버튼과 running 잠금이 탭 왕복 후 getRunActivity
 * 스냅샷으로 복원되는지(버그면 끝난 것처럼 보여 동시 2번째 실행이 가능) 실제 GUI 에서 검증한다.
 * 단위 테스트가 window.fleet 를 모킹하는 것과 달리, 여기선 실제 preload 브리지·IPC 채널을 통과한다.
 */

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
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

test('진행 중 프로젝트 실행이 탭 전환(언마운트/리마운트) 후에도 유지된다', async () => {
  // 프로젝트 탭 진입(워크스페이스는 시드됨) → 목표 입력 → 오케스트레이션 실행
  await page.getByRole('button', { name: '프로젝트' }).click()
  await page.getByPlaceholder(/사용자 인증/).fill('E2E 진행 표시 검증 목표')
  await page.getByRole('button', { name: '오케스트레이션 실행' }).click()

  // project.created 직후: 취소 버튼이 뜨고 실행 버튼이 '실행 중…'(비활성)으로 잠긴다(in-flight).
  await expect(page.getByRole('button', { name: '취소' })).toBeVisible()
  await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()
  await page.screenshot({ path: 'e2e/__screenshots__/03-run-before-switch.png' })

  // 다른 탭으로 이동 → ProjectPanel 언마운트(취소 버튼 사라짐) → 다시 프로젝트 탭으로 리마운트
  await page.getByRole('button', { name: '세션' }).click()
  await expect(page.getByRole('button', { name: '취소' })).toHaveCount(0)
  await page.getByRole('button', { name: '프로젝트' }).click()

  // 핵심 단언: main 스냅샷(getRunActivity)으로 취소 버튼과 running 잠금이 복원된다(버그면 끝난 것처럼 보임).
  await expect(page.getByRole('button', { name: '취소' })).toBeVisible()
  await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()
  await page.screenshot({ path: 'e2e/__screenshots__/04-run-after-remount.png' })

  // 🔍 프로브(동시 2번째 실행 차단): 새 목표를 입력해도 running 잠금이 살아 있어 실행 버튼이 비활성으로
  // 남는다 — 재마운트로 잠금이 풀려 두 번째 오케스트레이션을 시작할 수 있던 원래 버그가 막혔음을 확인한다.
  await page.getByPlaceholder(/사용자 인증/).fill('두 번째 동시 실행 시도')
  await expect(page.getByRole('button', { name: '실행 중…' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '오케스트레이션 실행' })).toHaveCount(0)
})
