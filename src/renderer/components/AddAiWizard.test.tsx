/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddAiWizard } from './AddAiWizard'

function mockFleet(overrides: Record<string, unknown> = {}) {
  ;(window as unknown as { fleet: unknown }).fleet = {
    detectClis: vi.fn().mockResolvedValue([
      {
        id: 'claude',
        displayName: 'Claude Code',
        command: 'claude',
        kind: 'cli',
        installed: true,
        version: '1.0.0',
      },
    ]),
    registerCliSession: vi.fn().mockResolvedValue(undefined),
    registerApiSession: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}
async function renderSettled(ui: Parameters<typeof render>[0]) {
  const r = render(ui)
  await act(async () => {})
  return r
}
afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('AddAiWizard', () => {
  it('provider 선택 → method 단계 전이', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    expect(screen.getByRole('button', { name: /구독/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })
  it('openai-호환 은 구독 방식 미노출', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 호환/ }))
    expect(screen.queryByRole('button', { name: /구독/ })).toBeNull()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })
  it('구독: gemini 경고 배너 + API 권장', async () => {
    mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Gemini/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    expect(screen.getByText(/제한·탐지 대상/)).toBeTruthy()
  })
  it('구독: copy-only — 클릭 가능한 link role 이 없다 (§6a)', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    await act(async () => {})
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('https://docs.anthropic.com/en/docs/claude-code')).toBeTruthy()
  })
  it('구독: 설치됨 → "검증 없이 등록" → registerCliSession + onRegistered', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    const onRegistered = vi.fn()
    mockFleet({ registerCliSession: reg })
    await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    fireEvent.click(await screen.findByRole('button', { name: /검증 없이 등록/ }))
    await act(async () => {})
    expect(reg).toHaveBeenCalledWith('claude', { stateful: false })
    expect(onRegistered).toHaveBeenCalled()
  })
  it('구독: 미설치 → 설치 안내(hint) 표시, 등록 버튼 없음', async () => {
    mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    expect(await screen.findByText(/npm i -g @anthropic-ai\/claude-code/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /검증 없이 등록/ })).toBeNull()
  })
})
