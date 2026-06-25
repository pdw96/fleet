/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelOption } from '../../shared/types'
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
  it('구독: registerCliSession 실패 → 에러 표시, onRegistered 미호출', async () => {
    const reg = vi.fn().mockRejectedValue(new Error('auth 실패함'))
    const onRegistered = vi.fn()
    mockFleet({ registerCliSession: reg })
    await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    fireEvent.click(await screen.findByRole('button', { name: /검증 없이 등록/ }))
    await act(async () => {})
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('등록 실패')
    expect(onRegistered).not.toHaveBeenCalled()
  })
  it('구독: 미설치 → 설치 안내(hint) 표시, 등록 버튼 없음', async () => {
    mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    expect(await screen.findByText(/npm i -g @anthropic-ai\/claude-code/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /검증 없이 등록/ })).toBeNull()
  })
  it('구독: stateful 체크 + CLI 모델 입력 → registerCliSession 에 반영', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    const onRegistered = vi.fn()
    mockFleet({ registerCliSession: reg })
    await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    await screen.findByRole('button', { name: /검증 없이 등록/ })
    // stateful 체크
    fireEvent.click(screen.getByLabelText(/stateful/i))
    // CLI 모델 오버라이드 입력
    fireEvent.change(screen.getByLabelText(/CLI 모델/i), { target: { value: 'claude-opus-4-8' } })
    fireEvent.click(screen.getByRole('button', { name: /검증 없이 등록/ }))
    await act(async () => {})
    expect(reg).toHaveBeenCalledWith('claude', { stateful: true, model: 'claude-opus-4-8' })
    expect(onRegistered).toHaveBeenCalled()
  })

  it('API: anthropic 키+모델 → registerApiSession (effort 선택 시 thinking 반영)', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    const onRegistered = vi.fn()
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-test' } })
    fireEvent.change(screen.getByLabelText(/thinking|effort/i), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    const cfg = reg.mock.calls[0][0]
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.apiKey).toBe('sk-test')
    expect(cfg.thinking?.effort).toBe('high')
    expect(onRegistered).toHaveBeenCalled()
  })
  it('API: anthropic cacheTtl=1h 선택 시 config 에 반영', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
    fireEvent.change(screen.getByLabelText(/cache/i), { target: { value: '1h' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    expect(reg.mock.calls[0][0].cacheTtl).toBe('1h')
  })
  it('API: listModels 성공 시 모델 옵션 datalist 표시', async () => {
    mockFleet({
      listModels: vi
        .fn()
        .mockResolvedValue([{ id: 'claude-opus-4-8', label: 'Opus' }] as ModelOption[]),
    })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
    // 버튼 게이트 — 명시적 클릭 후에만 조회
    fireEvent.click(screen.getByRole('button', { name: /모델 불러오기/ }))
    await waitFor(() => expect(screen.getByText('claude-opus-4-8', { exact: false })).toBeTruthy())
  })
  it('API: listModels 실패 시 자유 입력 폴백 (모델 input 직접 입력 가능)', async () => {
    mockFleet({ listModels: vi.fn().mockRejectedValue(new Error('no key')) })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
    fireEvent.click(screen.getByRole('button', { name: /모델 불러오기/ }))
    await act(async () => {})
    fireEvent.change(screen.getByLabelText(/모델/), { target: { value: 'claude-custom' } })
    expect((screen.getByLabelText(/모델/) as HTMLInputElement).value).toBe('claude-custom')
  })
  it('API: openai effort 선택 시 thinking 반영 (thinkingSupported parity)', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    const onRegistered = vi.fn()
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-openai' } })
    fireEvent.change(screen.getByLabelText(/thinking|effort/i), { target: { value: 'medium' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    const cfg = reg.mock.calls[0][0]
    expect(cfg.provider).toBe('openai')
    expect(cfg.thinking?.effort).toBe('medium')
    expect(onRegistered).toHaveBeenCalled()
  })
  it('API: openai-compatible 은 baseUrl 누락 시 등록 막고 오류 표시', async () => {
    const reg = vi.fn()
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 호환/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    expect(reg).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/base ?url/i)
  })
  it('API: google effort=high → thinking.effort 반영 (parity)', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    const onRegistered = vi.fn()
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
    fireEvent.click(screen.getByRole('button', { name: /Gemini/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-google' } })
    fireEvent.change(screen.getByLabelText(/thinking|effort/i), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    const cfg = reg.mock.calls[0][0]
    expect(cfg.provider).toBe('google')
    expect(cfg.thinking?.effort).toBe('high')
    expect(onRegistered).toHaveBeenCalled()
  })
  it('API: anthropic→openai 전환 시 cacheTtl 누출 없음', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    // 1) anthropic 선택 → API 키 단계 → cacheTtl=1h 설정
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-a' } })
    fireEvent.change(screen.getByLabelText(/cache/i), { target: { value: '1h' } })
    // 2) 뒤로 → provider 선택 → openai 선택
    fireEvent.click(screen.getByRole('button', { name: /뒤로/ }))
    fireEvent.click(screen.getByRole('button', { name: /뒤로/ }))
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-b' } })
    // 3) 등록 → cacheTtl 이 config 에 없어야 함
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    const cfg = reg.mock.calls[0][0]
    expect(cfg.provider).toBe('openai')
    expect(cfg.cacheTtl).toBeUndefined()
  })
  it('API: API 키 input 은 type="password" 로 마스킹된다', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    expect(screen.getByLabelText(/API 키/).getAttribute('type')).toBe('password')
  })
  it('API: 빈 API 키 → 등록 막힘 + 오류 표시', async () => {
    const reg = vi.fn()
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    // 키 미입력 상태로 등록 시도
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    expect(reg).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/API 키/)
  })
  it('API: openai-compatible 빈 모델 → 등록 막힘', async () => {
    const reg = vi.fn()
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 호환/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-test' } })
    fireEvent.change(screen.getByLabelText(/Base URL/i), {
      target: { value: 'https://api.example.com' },
    })
    // 모델 미입력 (PROVIDER_DEFAULTS['openai-compatible'] === '')
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    expect(reg).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/모델/)
  })
  it('API: displayName 에 모델 문자열 포함', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-test' } })
    fireEvent.change(screen.getByLabelText(/모델/), { target: { value: 'claude-opus-4-8' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    const cfg = reg.mock.calls[0][0]
    expect(cfg.displayName).toContain('claude-opus-4-8')
  })
  it('API: 등록 성공 후 apiKey 상태 초기화', async () => {
    const reg = vi.fn().mockResolvedValue(undefined)
    mockFleet({ registerApiSession: reg })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '등록' }))
    await act(async () => {})
    expect(reg).toHaveBeenCalled()
    // 등록 후 input 값이 비워져야 함
    expect((screen.getByLabelText(/API 키/) as HTMLInputElement).value).toBe('')
  })
  it('API: apiKey 변경 시 datalist 모델 옵션 즉시 초기화', async () => {
    mockFleet({
      listModels: vi
        .fn()
        .mockResolvedValue([{ id: 'claude-opus-4-8', label: 'Opus' }] as ModelOption[]),
    })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
    // 첫 키 입력 후 버튼 클릭 → 모델 옵션 표시 대기
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-first' } })
    fireEvent.click(screen.getByRole('button', { name: /모델 불러오기/ }))
    await waitFor(() => expect(screen.getByText('claude-opus-4-8', { exact: false })).toBeTruthy())
    // 키 변경 → 모델 옵션 즉시 초기화(새 listModels 응답 도착 전)
    fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-second' } })
    // onChange 핸들러에서 동기적으로 setModelOptions([]) → 즉시 사라져야 함
    expect(screen.queryByText('claude-opus-4-8', { exact: false })).toBeNull()
  })
})
