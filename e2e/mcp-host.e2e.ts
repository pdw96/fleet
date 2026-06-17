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
 * MCP 호스트 GUI e2e — 실제 Electron 빌드를 띄워 "04 — MCP" 패널에서 로컬 목 MCP 서버에 연결하고,
 * 도구가 mcp__<server>__<tool> 로 노출되는지(UI)와 감사 이벤트(mcp.servers.set/mcp.server.connected)가
 * 기록되는지(listEvents) 관측한다. 목 서버는 stdio JSON-RPC 만 응답하므로 키·네트워크 없이 결정론적이다.
 */

interface AuditEvent {
  type: string
  data: Record<string, unknown>
}

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  // userData 를 임시 디렉터리로 격리(실제 사용자 store 오염 방지).
  userDataDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-mcp-'))
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

test('MCP 서버를 연결하고 도구 노출·감사 이벤트를 관측한다', async () => {
  const mockServer = resolve(__dirname, 'fixtures', 'mock-mcp-server.mjs')
  // JSON.stringify 로 Windows 경로 백슬래시까지 안전하게 직렬화한다.
  const specJson = JSON.stringify([{ name: 'mock', command: 'node', args: [mockServer] }])

  await page.getByRole('button', { name: '세션', exact: true }).click() // nav 탭만(‘세션 등록’ 버튼과 구분)
  await page.getByLabel(/MCP 서버/).fill(specJson)
  await page.getByRole('button', { name: 'MCP 적용' }).click()

  // 새 MCP 서버 spawn 은 ApprovalGate(shell)를 통과해야 한다 — 승인 모달을 승인한다.
  await page.getByRole('button', { name: '승인' }).click()

  // UI 관측: 연결 상태(도구 수) + 프리픽스된 도구 이름.
  await expect(page.getByText('mcp__mock__echo')).toBeVisible()
  await expect(page.getByText('1 tools')).toBeVisible()
  await page.screenshot({ path: 'e2e/__screenshots__/mcp-01-connected.png' })

  // 감사 이벤트 관측: listEvents() 로 MCP 연결 라이프사이클을 확인한다.
  const events = await page.evaluate(
    () =>
      (
        window as unknown as { fleet: { listEvents(): Promise<AuditEvent[]> } }
      ).fleet.listEvents() as Promise<AuditEvent[]>,
  )
  const mcpEvents = events.filter((e) => e.type.startsWith('mcp.'))
  console.log('관측된 MCP 감사 이벤트:', JSON.stringify(mcpEvents, null, 2))

  const types = mcpEvents.map((e) => e.type)
  expect(types).toContain('mcp.servers.set')
  expect(types).toContain('mcp.server.connected')
  const connected = mcpEvents.find((e) => e.type === 'mcp.server.connected')
  expect(connected?.data).toMatchObject({ name: 'mock', toolCount: 1 })
})
