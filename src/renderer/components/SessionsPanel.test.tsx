/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliDetectionResult, ModelOption } from '../../shared/types'
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
    getUpdaterChannel: vi.fn().mockResolvedValue('stable'), // #98 마운트 시 채널 조회
    setUpdaterChannel: vi.fn().mockResolvedValue(undefined),
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

  it('모델 불러오기 클릭 → listModels 결과를 datalist 옵션으로 노출한다 (#13)', async () => {
    const fleet = mockFleet({
      listModels: vi.fn().mockResolvedValue([
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      ]),
    })
    const result = await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: '모델 불러오기' }))

    await waitFor(() => expect(fleet.listModels).toHaveBeenCalled())
    const cfg = (fleet.listModels as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.apiKey).toBe('key-1')

    await waitFor(() => {
      const opts = [...result.container.querySelectorAll('datalist option')].map(
        (o) => (o as HTMLOptionElement).value,
      )
      expect(opts).toEqual(['claude-sonnet-4-6', 'claude-opus-4-8'])
    })
  })

  it('listModels 실패 시 에러를 표시하고 모델 입력 자유입력 폴백을 유지한다 (#13)', async () => {
    mockFleet({ listModels: vi.fn().mockRejectedValue(new Error('조회 실패함')) })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: '모델 불러오기' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('조회 실패함')
    // 입력란은 하드코딩 기본값(PROVIDER_DEFAULTS.anthropic)을 유지한다 — 자유입력 폴백.
    expect((screen.getByLabelText('모델') as HTMLInputElement).value).toBe('claude-sonnet-4-6')
  })

  it('조회 중 provider 를 바꾸면 늦게 온 stale 응답이 datalist 를 덮어쓰지 않는다 (#13 레이스 가드)', async () => {
    let resolveList!: (v: ModelOption[]) => void
    const listModels = vi.fn(
      () =>
        new Promise<ModelOption[]>((r) => {
          resolveList = r
        }),
    )
    mockFleet({ listModels })
    const result = await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: '모델 불러오기' }))
    await waitFor(() => expect(listModels).toHaveBeenCalled())

    // 응답 도착 전에 provider 변경 → in-flight 요청 무효화
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } })
    // 늦게 도착한 이전(anthropic) 결과
    await act(async () => {
      resolveList([{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }])
    })

    const opts = [...result.container.querySelectorAll('datalist option')].map(
      (o) => (o as HTMLOptionElement).value,
    )
    expect(opts).toEqual([]) // stale 결과 미반영(provider 변경으로 비워진 상태 유지)
    // 로딩 상태는 풀려야 한다(스피너 '불러오는 중…' 영구 고정 방지 — Codex P2). 버튼 라벨이 복귀했는지로 검증.
    expect(screen.getByRole('button', { name: '모델 불러오기' })).toBeTruthy()
  })

  it('조회가 settle 되기 전에 입력을 바꾸면 응답을 기다리지 않고 즉시 로딩이 풀려 재시도 가능하다 (#13 Codex P2)', async () => {
    // listModels 를 영원히 pending 으로 둬 in-flight 상태를 고정(느린/불통 엔드포인트 모사).
    const listModels = vi.fn(() => new Promise<never>(() => {}))
    mockFleet({ listModels })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: '모델 불러오기' }))
    await waitFor(() => expect(listModels).toHaveBeenCalled())
    // 로딩 중 — 버튼 라벨이 '불러오는 중…' 으로 바뀌어 '모델 불러오기' 는 사라진다.
    expect(screen.queryByRole('button', { name: '모델 불러오기' })).toBeNull()

    // 요청이 settle 되기 전에 provider 변경 → 즉시 로딩 해제(응답 대기 없이 재시도 가능)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } })
    expect(screen.getByRole('button', { name: '모델 불러오기' })).toBeTruthy()
  })

  it('openai-compatible 에서 baseUrl 미입력이면 모델 불러오기 버튼이 비활성이다 (#13 UX dead-end 방지)', async () => {
    mockFleet({ listModels: vi.fn() })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })

    const btn = screen.getByRole('button', { name: '모델 불러오기' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true) // baseUrl 비어 있음 → 비활성(침묵 무반응 방지)

    fireEvent.change(screen.getByLabelText(/Base URL/i), {
      target: { value: 'https://openrouter.ai/api/v1' },
    })
    expect(btn.disabled).toBe(false) // baseUrl 채우면 활성
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

  it('#98 베타 클릭 → setUpdaterChannel(beta) 호출 + 마운트 시 채널 하이드레이트', async () => {
    const fleet = mockFleet()
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    expect(fleet.getUpdaterChannel).toHaveBeenCalled() // 마운트 하이드레이트
    fireEvent.click(screen.getByRole('button', { name: /베타/ }))
    await waitFor(() => expect(fleet.setUpdaterChannel).toHaveBeenCalledWith('beta'))
  })

  it('#98 마운트 시 main 의 현재 채널(beta)을 반영한다', async () => {
    mockFleet({ getUpdaterChannel: vi.fn().mockResolvedValue('beta') })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    expect(await screen.findByText(/프리릴리스를 먼저/)).toBeTruthy() // 베타 안내문 = 채널 beta
  })

  it('#98 사용자 토글 후 늦게 도착한 채널 하이드레이션은 무시된다(레이스 가드)', async () => {
    let resolveHydrate!: (c: 'stable' | 'beta') => void
    const fleet = mockFleet({
      getUpdaterChannel: vi.fn().mockReturnValue(
        new Promise((r) => {
          resolveHydrate = r
        }),
      ),
    })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /베타/ })) // 하이드레이션 미정 중 토글
    await waitFor(() => expect(fleet.setUpdaterChannel).toHaveBeenCalledWith('beta'))
    resolveHydrate('stable') // 늦은 stable 하이드레이션 — 사용자 선택을 덮으면 안 됨
    await act(async () => {})
    expect(screen.getByText(/프리릴리스를 먼저/)).toBeTruthy() // 여전히 beta
  })

  it('#98 하이드레이션 전 stable 클릭도 setUpdaterChannel(stable) 전송(첫 클릭 유실 방지)', async () => {
    let resolveHydrate!: (c: 'stable' | 'beta') => void
    const fleet = mockFleet({
      getUpdaterChannel: vi.fn().mockReturnValue(
        new Promise((r) => {
          resolveHydrate = r
        }),
      ),
    })
    await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    // 하이드레이션 미정 — 표시는 기본 stable. 실제 persisted 가 beta 여도 사용자의 stable 클릭은 반영돼야 함.
    fireEvent.click(screen.getByRole('button', { name: /안정/ }))
    await waitFor(() => expect(fleet.setUpdaterChannel).toHaveBeenCalledWith('stable'))
    resolveHydrate('beta') // 늦은 beta 하이드레이션 — 사용자 선택(stable)을 덮으면 안 됨
    await act(async () => {})
    expect(screen.getByText(/정식 릴리스만/)).toBeTruthy() // 여전히 stable
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

  it('CLI 세션 카드에 presentational 미검증 배지를 표시한다 (§7a)', async () => {
    mockFleet()
    await renderSettled(
      <SessionsPanel
        sessions={[{ id: 's1', kind: 'cli' as const, displayName: 'Claude Code', ref: 'claude' }]}
        onRefresh={vi.fn()}
      />,
    )
    expect(screen.getByText(/로그인 미검증/)).toBeTruthy()
  })
  it('API 세션 카드에는 미검증 배지를 표시하지 않는다', async () => {
    mockFleet()
    await renderSettled(
      <SessionsPanel
        sessions={[{ id: 's2', kind: 'api' as const, displayName: 'Claude API', ref: 'cfg1' }]}
        onRefresh={vi.fn()}
      />,
    )
    expect(screen.queryByText(/로그인 미검증/)).toBeNull()
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
