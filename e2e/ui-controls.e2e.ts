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
 * 라이브 GUI 관측: 최근 머지된 UI 표면 두 가지를 실제 Electron 앱에서 확인한다.
 *  - #47/#54 effort 게이트: SessionsPanel 의 Thinking effort 셀렉트가 anthropic·openai·google
 *    에서 모두 보이고 provider 별 안내문이 전환된다(#54 가 게이트를 google 까지 확장 → 기존
 *    'google 숨김' 기대는 stale 정정 · #73 은 이후 Gemini 2.5 thinkingBudget 매핑을 정교화).
 *  - #44 #12 replan 슬라이스 활성화: ProjectPanel 의 '보정 재계획' 셀렉트가 공유 상수
 *    MAX_REPLAN_ROUNDS 에서 파생된 옵션(비활성/1회/2회/3회)으로 렌더된다(데드코드였던 배선의 UI 표면).
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

test('#47/#54 Thinking effort 게이트가 anthropic·openai·google 에서 보이고 provider 별 안내문이 전환된다', async () => {
  // nav 버튼만 정확히 잡는다 — 세션 탭의 '세션 등록' 버튼들과 substring 충돌 방지(exact).
  await page.getByRole('button', { name: '세션', exact: true }).click()
  const effort = page.getByLabel('Thinking effort (선택)')

  // 기본 provider=anthropic → 게이트 열림
  await expect(effort).toBeVisible()

  // openai → 여전히 열림(#47 이 anthropic→anthropic|openai 로 원자 확장한 부분)
  await page.getByLabel('Provider').selectOption('openai')
  await expect(effort).toBeVisible()
  await expect(page.getByText(/reasoning 모델\(o-series/)).toBeVisible() // openai 전용 모델-인지 안내문
  await page.screenshot({ path: 'e2e/__screenshots__/05-effort-gate-openai.png' })

  // google → 여전히 열림(#54 가 thinkingSupported 게이트를 google 까지 확장 — #53 의 google
  // thinkingConfig 배선을 UI 에서 활성화. #73 은 이후 Gemini 2.5 thinkingBudget 매핑 정교화).
  // SessionsPanel.test.tsx 의 'Google thinking effort … config 에 thinking 이 실린다' 단위 테스트와 짝.
  await page.getByLabel('Provider').selectOption('google')
  await expect(effort).toBeVisible()
  await expect(page.getByText(/Gemini 2\.5 는 동적 사고/)).toBeVisible() // gemini 전용 안내문

  // anthropic 으로 복귀 → 다시 열림
  await page.getByLabel('Provider').selectOption('anthropic')
  await expect(effort).toBeVisible()
})

test('#44 보정 재계획 셀렉트가 MAX_REPLAN_ROUNDS 파생 옵션으로 렌더된다', async () => {
  await page.getByRole('button', { name: '프로젝트', exact: true }).click()
  const replan = page.getByLabel('보정 재계획')
  await expect(replan).toBeVisible()

  // 옵션은 공유 상수 MAX_REPLAN_ROUNDS(=3)에서 파생: 비활성/1회/2회/3회 — 기본은 비활성(opt-in 무회귀).
  await expect(replan.locator('option')).toHaveText(['비활성', '1회', '2회', '3회'])
  await expect(replan).toHaveValue('0')

  // 값 선택이 반영된다(UI→IPC→engine 배선의 입력 측 — 데드코드 해소).
  await replan.selectOption('2')
  await expect(replan).toHaveValue('2')
  await page.screenshot({ path: 'e2e/__screenshots__/06-replan-select.png' })
})
