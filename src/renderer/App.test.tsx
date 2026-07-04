/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

function mockFleet(runtime: 'electron' | 'web') {
  const fleet = {
    listSessions: vi.fn().mockResolvedValue([]),
    getAppInfo: vi.fn().mockResolvedValue({
      name: 'Fleet',
      version: '0.1.0',
      electron: '42.0.0',
      node: '24.0.0',
      chrome: '140',
      runtime,
    }),
    // App 하위 상시 마운트 컴포넌트(UpdateBanner·ApprovalModal)와 기본 탭(SessionsPanel) 표면
    onUpdateEvent: vi.fn(() => () => {}),
    getUpdateState: vi.fn().mockResolvedValue({ kind: 'idle' }),
    onApprovalRequest: vi.fn(() => () => {}),
    getUpdaterChannel: vi.fn().mockResolvedValue('stable'),
    getMcpStatus: vi.fn().mockResolvedValue([]),
    detectClis: vi.fn().mockResolvedValue([]),
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return fleet
}

async function renderSettled() {
  const r = render(<App />)
  await act(async () => {})
  return r
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('App runtime 게이팅(#197 B4)', () => {
  it('electron: footer 에 Electron/Node/Chrome, UpdateBanner 구독 활성', async () => {
    const fleet = mockFleet('electron')
    await renderSettled()
    expect(screen.getByText(/Electron 42\.0\.0/)).toBeTruthy()
    expect(fleet.onUpdateEvent).toHaveBeenCalled()
  })

  it('web: footer 는 Web/버전 표기, UpdateBanner 미마운트(구독 없음)', async () => {
    const fleet = mockFleet('web')
    await renderSettled()
    expect(screen.getByText(/Web/)).toBeTruthy()
    expect(screen.queryByText(/Electron/)).toBeNull()
    expect(fleet.onUpdateEvent).not.toHaveBeenCalled()
  })
})
