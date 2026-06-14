import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * 회귀 가드: 윈도우 네비게이션 하드닝(installNavigationGuards)이 실제 Electron 에서 발화하는지 검증한다.
 * 단위 테스트는 페이크 webContents 로 헬퍼 배선만 증명하므로, 실 WebContents 가 setWindowOpenHandler 를
 * 존중하고 페이지발 네비게이션을 실제로 차단하는지는 빌드된 앱을 띄워 확인해야 한다(로드맵 '수동 기동 검증'의 자동화).
 */

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-harden-'))
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

test('window.open(새 창)을 거부한다 (setWindowOpenHandler deny)', async () => {
  // deny 핸들러면 window.open 은 null 을 반환하고 새 창이 뜨지 않는다.
  const opened = await page.evaluate(() => window.open('https://example.com/evil') !== null)
  expect(opened).toBe(false)
})

test('페이지발 top-level 네비게이션을 차단한다 (will-navigate preventDefault)', async () => {
  const before = page.url()
  // 드롭된 파일처럼 file:// 문서로의 location 변경 시도 — 가드가 없으면 즉시(네트워크 불필요) 그 문서로 commit 된다.
  // will-navigate preventDefault 로 차단되면 navigation 이 commit 되지 않아 page.url() 이 불변으로 남는다.
  await page
    .evaluate(() => {
      window.location.assign('file:///fleet-hardening-probe-should-be-blocked.html')
    })
    .catch(() => undefined) // 차단으로 컨텍스트가 흔들려도 무시(아래 URL 단언이 본질)
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before) // URL 불변 — top-level 네비게이션이 차단됨(허용됐다면 file:// 로 바뀜)
})
