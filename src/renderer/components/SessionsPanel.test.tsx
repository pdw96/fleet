/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliDetectionResult } from '../../shared/types'
import { SessionsPanel } from './SessionsPanel'

const installedCli: CliDetectionResult = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  kind: 'cli',
  installed: true,
  version: '1.0.0',
}

function mockFleet(overrides: Record<string, unknown> = {}) {
  const fleet: Record<string, unknown> = {
    detectClis: vi.fn().mockResolvedValue([installedCli]),
    registerCliSession: vi.fn().mockResolvedValue(undefined),
    setSessionCapabilities: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    registerApiSession: vi.fn().mockResolvedValue(undefined),
    getMcpStatus: vi.fn().mockResolvedValue([]), // 마운트 시 하이드레이트 호출
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return fleet
}

// 마운트 비동기 effect(detect·getMcpStatus)가 act() 안에서 정착하도록 flush한다.
// React 19 의 엄격한 act 환경에서 마운트-후 비동기 setState 가 act() 밖이라 뜨던 경고를 제거(동작 무변경).
async function renderSettled(ui: Parameters<typeof render>[0]) {
  const result = render(ui)
  await act(async () => {})
  return result
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  // jsdom 은 visibilityState 를 기본 'visible' 로 두지만, hidden 분기 테스트가 인스턴스 프로퍼티로
  // 덮어쓰므로 매 테스트 후 'visible' 로 되돌려 누수를 막는다.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.restoreAllMocks()
})

describe('SessionsPanel', () => {
  it('surfaces an error and does not refresh when CLI registration fails', async () => {
    mockFleet({ registerCliSession: vi.fn().mockRejectedValue(new Error('등록 실패함')) })
    const onRefresh = vi.fn()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={onRefresh} />)

    fireEvent.click(await screen.findByRole('button', { name: '세션 등록' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('세션 등록 실패')
    expect(alert.textContent).toContain('등록 실패함')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('refreshes after a successful CLI registration', async () => {
    const fleet = mockFleet()
    const onRefresh = vi.fn()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={onRefresh} />)

    fireEvent.click(await screen.findByRole('button', { name: '세션 등록' }))

    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(fleet.registerCliSession).toHaveBeenCalledWith('claude', { stateful: false })
  })

  it('Anthropic thinking effort 를 선택하면 registerApiSession config 에 thinking 이 실린다 (#11-thinking 활성화)', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/Thinking effort/i), { target: { value: 'xhigh' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.thinking).toEqual({ effort: 'xhigh' })
    // 세션 설정은 비영속·불가시라 displayName 에 노출해 어느 세션이 thinking 인지 확인 가능하게 한다.
    expect(String(cfg.displayName)).toContain('thinking:xhigh')
  })

  it('thinking 기본(끄기)이면 config 에 thinking 키 자체를 넣지 않는다', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect('thinking' in cfg).toBe(false)
    expect(String(cfg.displayName)).not.toContain('thinking')
  })

  it('OpenAI thinking effort 를 선택하면 config 에 thinking 이 실린다 (reasoning_effort 패리티)', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText(/Thinking effort/i), { target: { value: 'high' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(cfg.provider).toBe('openai')
    expect(cfg.thinking).toEqual({ effort: 'high' })
    expect(String(cfg.displayName)).toContain('thinking:high')
  })

  it('Google thinking effort 를 선택하면 config 에 thinking 이 실린다 (gemini-thinkingconfig UI 활성화 2단계)', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } })
    fireEvent.change(screen.getByLabelText(/Thinking effort/i), { target: { value: 'high' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(cfg.provider).toBe('google')
    expect(cfg.thinking).toEqual({ effort: 'high' })
    expect(String(cfg.displayName)).toContain('thinking:high')
  })

  it('openai-compatible 선택 시 Base URL 입력칸과 effort 셀렉트가 노출된다', async () => {
    mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } })
    expect(screen.getByLabelText(/Base URL/i)).toBeTruthy()
    expect(screen.getByLabelText(/Thinking effort/i)).toBeTruthy()
  })

  it('openai-compatible 등록 config 에 baseUrl·provider 가 실린다', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } })
    fireEvent.change(screen.getByLabelText(/Base URL/i), {
      target: { value: 'https://openrouter.ai/api/v1' },
    })
    fireEvent.change(screen.getByLabelText('모델'), { target: { value: 'qwen/qwen3-32b' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))
    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(cfg.provider).toBe('openai-compatible')
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(cfg.model).toBe('qwen/qwen3-32b')
  })

  it('anthropic·openai·google 모두 thinking effort 셀렉트를 노출한다(3사 thinking 패리티)', async () => {
    mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    // anthropic(기본) 노출
    expect(screen.getByLabelText(/Thinking effort/i)).toBeTruthy()
    // openai 노출(reasoning_effort 패리티)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    expect(screen.getByLabelText(/Thinking effort/i)).toBeTruthy()
    // google 노출(thinkingConfig 패리티 — gemini-thinkingconfig)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } })
    expect(screen.getByLabelText(/Thinking effort/i)).toBeTruthy()
  })

  it('anthropic 에서 캐시 TTL 1h 선택 → registerApiSession config 에 cacheTtl 가 실린다 (#72)', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/캐시 TTL/i), { target: { value: '1h' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.cacheTtl).toBe('1h')
    expect(String(cfg.displayName)).toContain('cache:1h')
  })

  it('비-anthropic provider 에는 캐시 TTL 컨트롤이 노출되지 않는다 (#72 anthropic 한정)', async () => {
    mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    // anthropic(기본)에는 노출
    expect(screen.getByLabelText(/캐시 TTL/i)).toBeTruthy()
    // openai 로 전환하면 비노출
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    expect(screen.queryByLabelText(/캐시 TTL/i)).toBeNull()
  })

  it('anthropic→1h 선택 후 openai 로 전환하면 stale cacheTtl 가 config 에 누출되지 않는다 (#72 provider 게이트)', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    // anthropic 에서 1h 선택 → provider 전환(셀렉트 onChange 는 cacheTtl state 를 리셋하지 않아 '1h' 잔존)
    fireEvent.change(screen.getByLabelText(/캐시 TTL/i), { target: { value: '1h' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    // provider 게이트(provider==='anthropic' &&)만이 stale '1h' 의 누출을 막는다 — 게이트 제거 뮤테이션 차단.
    expect(cfg.provider).toBe('openai')
    expect('cacheTtl' in cfg).toBe(false)
    expect(String(cfg.displayName)).not.toContain('cache:1h')
  })

  it('MCP 서버 JSON 을 적용하고 상태를 표시한다', async () => {
    const status = [
      { name: 'fs', connected: true, toolCount: 2, tools: ['mcp__fs__read', 'mcp__fs__write'] },
    ]
    const fleet = mockFleet({ setMcpServers: vi.fn().mockResolvedValue(status) })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/MCP 서버/i), {
      target: { value: '[{"name":"fs","command":"node","args":["server.js"]}]' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'MCP 적용' }))

    await waitFor(() =>
      expect(fleet.setMcpServers).toHaveBeenCalledWith([
        { name: 'fs', command: 'node', args: ['server.js'] },
      ]),
    )
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()
  })

  it('잘못된 MCP JSON 은 IPC 호출 없이 에러를 표시한다', async () => {
    const fleet = mockFleet({ setMcpServers: vi.fn() })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/MCP 서버/i), { target: { value: '깨진 json' } })
    fireEvent.click(screen.getByRole('button', { name: 'MCP 적용' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('MCP')
    expect(fleet.setMcpServers).not.toHaveBeenCalled()
  })

  it('마운트 시 현재 MCP 상태를 하이드레이트한다(탭 재마운트 복원)', async () => {
    const fleet = mockFleet({
      getMcpStatus: vi
        .fn()
        .mockResolvedValue([
          { name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] },
        ]),
    })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()
    expect(fleet.getMcpStatus).toHaveBeenCalled()
  })

  // 종료/크래시로 stale 상태를 재조회로 갱신하는 동적 상태 mock(처음=연결, 이후=종료).
  function dyingServerStatus() {
    return vi
      .fn()
      .mockResolvedValueOnce([
        { name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] },
      ])
      .mockResolvedValue([{ name: 'fs', connected: false, toolCount: 0, tools: [], error: 'exit' }])
  }

  it('윈도우 포커스 복귀 시 MCP 상태를 재조회해 stale 표시를 갱신한다', async () => {
    const fleet = mockFleet({ getMcpStatus: dyingServerStatus() })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    // 마운트 하이드레이트: 연결 상태(도구 노출) 표시
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()

    // 윈도우 포커스 복귀 → 재조회 → 종료 상태 반영
    fireEvent(window, new Event('focus'))

    expect(await screen.findByText('exit')).toBeTruthy()
    expect(screen.queryByText(/mcp__fs__read/)).toBeNull()
    expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)
  })

  it('탭 가시성 복귀 시 MCP 상태를 재조회한다', async () => {
    const fleet = mockFleet({ getMcpStatus: dyingServerStatus() })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()

    fireEvent(document, new Event('visibilitychange'))

    expect(await screen.findByText('exit')).toBeTruthy()
    expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)
  })

  it('활성 MCP 서버가 있으면 경량 폴링으로 상태를 갱신한다', async () => {
    vi.useFakeTimers()
    try {
      const fleet = mockFleet({ getMcpStatus: dyingServerStatus() })
      await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

      // 마운트 하이드레이트 promise flush → 연결 상태 + 폴링 타이머 가동
      await act(async () => {})
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1)

      // 폴링 간격 경과 → 재조회
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)

      // 두 번째 틱 → '반복' 인터벌임을 증명(setInterval→setTimeout 1회성 회귀 차단).
      // dyingServerStatus 는 종료 후에도 길이 1 배열을 반환 → hasMcpServers 유지 → 인터벌 지속.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('활성 서버가 사라지면(빈 배열 수신) 폴링을 중단한다', async () => {
    vi.useFakeTimers()
    try {
      const fleet = mockFleet({
        getMcpStatus: vi
          .fn()
          .mockResolvedValueOnce([
            { name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] },
          ])
          .mockResolvedValue([]),
      })
      await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
      await act(async () => {})
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1) // 마운트(연결)

      // 1회 폴링 → 빈 배열 수신 → hasMcpServers false 전이 → clearInterval
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)

      // 더 advance 해도 폴링 없음(타이머 해제 확인)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('MCP 서버 미설정 시 폴링 타이머를 만들지 않는다', async () => {
    vi.useFakeTimers()
    try {
      const fleet = mockFleet({ getMcpStatus: vi.fn().mockResolvedValue([]) })
      await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
      await act(async () => {})
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1) // 마운트 1회만

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1) // 폴링 없음
    } finally {
      vi.useRealTimers()
    }
  })

  it('탭이 숨김(hidden)으로 전환될 때는 재조회하지 않는다(visibility 가드)', async () => {
    const fleet = mockFleet({
      getMcpStatus: vi
        .fn()
        .mockResolvedValue([
          { name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] },
        ]),
    })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()
    expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1) // 마운트 1회

    // 숨김 전환 → 가드가 재조회를 막아야 한다(가드 제거 시 이 단언이 깨진다)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    fireEvent(document, new Event('visibilitychange'))
    expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1)

    // 가시성 복귀(visible) → 재조회
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2))
  })

  it('재조회가 실패(IPC reject)해도 기존 표시를 유지하고 크래시하지 않는다', async () => {
    const fleet = mockFleet({
      getMcpStatus: vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] },
        ])
        .mockRejectedValue(new Error('ipc down')),
    })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()

    // 포커스 재조회가 reject → .catch 로 무음 흡수, 직전 권위 상태를 그대로 유지
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/mcp__fs__read/)).toBeTruthy()
  })
})
