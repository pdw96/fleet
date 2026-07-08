/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ChatActivity, ChatRoom, ChatStreamEvent, LlmDescriptor } from '../../shared/types'
import { HydrationContext } from '../bridge/hydration'
import { ChatPanel } from './ChatPanel'

const SESSIONS: LlmDescriptor[] = [
  { id: 'llm-1', kind: 'cli', displayName: 'Claude', ref: 'claude' },
  { id: 'llm-2', kind: 'cli', displayName: 'Codex', ref: 'codex' },
]
const ROOM: ChatRoom = { id: 'r1', title: '토론방', participants: ['llm-1', 'llm-2'], createdAt: 1 }
const ROOM2: ChatRoom = {
  id: 'r2',
  title: '토론방2',
  participants: ['llm-1', 'llm-2'],
  createdAt: 2,
}

function mockFleet(overrides: Record<string, unknown> = {}) {
  let emit: ((e: ChatStreamEvent) => void) | undefined
  const fleet = {
    listRooms: vi.fn().mockResolvedValue([ROOM]),
    roomHistory: vi.fn().mockResolvedValue([]),
    getChatActivity: vi
      .fn()
      .mockResolvedValue({ busyRooms: [], streams: [] } satisfies ChatActivity),
    createRoom: vi.fn().mockResolvedValue(ROOM),
    postUserMessage: vi.fn().mockResolvedValue(undefined),
    askLlm: vi.fn().mockResolvedValue(undefined),
    discussRoom: vi.fn().mockResolvedValue(undefined),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    onChatStream: vi.fn((cb: (e: ChatStreamEvent) => void) => {
      emit = cb
      return () => {
        emit = undefined
      }
    }),
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return Object.assign(fleet, {
    fire: (e: ChatStreamEvent) => act(() => emit?.(e)),
  })
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('ChatPanel — 진행 상태 복원(단일 소스 오브 트루스)', () => {
  it('마운트 시 getChatActivity 로 진행 표시(busy)를 복원한다', async () => {
    // 탭 재진입(remount) 시 활성 방이 진행 중이면 토론 버튼이 진행 라벨을 보여야 한다.
    mockFleet({
      getChatActivity: vi
        .fn()
        .mockResolvedValue({ busyRooms: ['r1'], streams: [] } satisfies ChatActivity),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('AI 토론 중…')).toBeTruthy()
  })

  it('마운트 시 라이브 스트림 말풍선을 복원한다(자리 비운 동안의 타이핑 catch-up)', async () => {
    mockFleet({
      getChatActivity: vi.fn().mockResolvedValue({
        busyRooms: ['r1'],
        streams: [
          {
            streamId: 's1',
            roomId: 'r1',
            llmId: 'llm-1',
            text: '복원된 부분 응답',
            seq: 2,
            steps: [],
          },
        ],
      } satisfies ChatActivity),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('복원된 부분 응답')).toBeTruthy()
  })

  it('busy/idle 이벤트로 진행 표시를 라이브 토글한다', async () => {
    const fleet = mockFleet()
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('🤖 AI 자동 토론')).toBeTruthy() // 초기: 비진행

    fleet.fire({ kind: 'busy', roomId: 'r1' })
    expect(await screen.findByText('AI 토론 중…')).toBeTruthy() // busy → 진행

    fleet.fire({ kind: 'idle', roomId: 'r1' })
    expect(await screen.findByText('🤖 AI 자동 토론')).toBeTruthy() // idle → 비진행
  })

  it('busy 일 때 취소 버튼을 노출하고 클릭 시 cancelChat(활성 방)을 호출한다', async () => {
    const fleet = mockFleet()
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')
    expect(screen.queryByText('취소')).toBeNull() // 비진행 시 취소 버튼 없음

    fleet.fire({ kind: 'busy', roomId: 'r1' }) // 활성 방(r1) 진행 시작
    const cancelBtn = await screen.findByText('취소')

    await act(async () => {
      cancelBtn.click()
    })
    expect(fleet.cancelChat).toHaveBeenCalledWith('r1')
  })

  it('다른 방의 busy 에서는 활성 방 취소 버튼을 노출하지 않는다', async () => {
    const fleet = mockFleet()
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')

    fleet.fire({ kind: 'busy', roomId: 'OTHER' }) // 다른 방만 진행
    // 활성 방(r1)은 비진행 → 취소 버튼 없음
    expect(screen.queryByText('취소')).toBeNull()
  })

  it('다른 방의 busy 는 현재 활성 방의 진행 표시에 영향을 주지 않는다', async () => {
    const fleet = mockFleet()
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('🤖 AI 자동 토론')).toBeTruthy()

    fleet.fire({ kind: 'busy', roomId: 'OTHER' }) // 다른 방 진행
    // 활성 방(r1)은 여전히 비진행
    expect(screen.getByText('🤖 AI 자동 토론')).toBeTruthy()
    expect(screen.queryByText('AI 토론 중…')).toBeNull()
  })

  it('하이드레이션 윈도우 중 도착한 idle 은 스냅샷 busy 로 되살아나지 않는다(라이브 우선)', async () => {
    let resolveActivity: (a: ChatActivity) => void = () => {}
    const fleet = mockFleet({
      getChatActivity: vi.fn(() => new Promise<ChatActivity>((res) => (resolveActivity = res))),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('🤖 AI 자동 토론')).toBeTruthy() // 스냅샷 펜딩 → 아직 비진행

    fleet.fire({ kind: 'idle', roomId: 'r1' }) // 윈도우 중 r1 이 끝남
    // 늦게 온 스냅샷이 r1 을 busy 로 보고하지만, 라이브 idle 이 우선해야 한다.
    await act(async () => resolveActivity({ busyRooms: ['r1'], streams: [] }))

    expect(screen.getByText('🤖 AI 자동 토론')).toBeTruthy() // 좀비 busy 아님
    expect(screen.queryByText('AI 토론 중…')).toBeNull()
  })

  it('하이드레이션 윈도우 중 종료된 스트림을 스냅샷이 되살리지 않는다', async () => {
    let resolveActivity: (a: ChatActivity) => void = () => {}
    const fleet = mockFleet({
      getChatActivity: vi.fn(() => new Promise<ChatActivity>((res) => (resolveActivity = res))),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')

    // 스냅샷이 적용되기 전에 s1 이 end 로 끝난다.
    fleet.fire({
      kind: 'end',
      streamId: 's1',
      roomId: 'r1',
      message: {
        id: 'm1',
        roomId: 'r1',
        author: { type: 'llm', llmId: 'llm-1' },
        content: '끝난 응답',
        ts: 1,
      },
    })
    await act(async () =>
      resolveActivity({
        busyRooms: [],
        streams: [
          { streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '좀비 타이핑', seq: 1, steps: [] },
        ],
      }),
    )

    expect(screen.queryByText('좀비 타이핑')).toBeNull() // 종료된 스트림은 되살아나지 않음
  })

  it('새 ask 는 활성 방 말풍선만 정리하고 다른 방의 진행 중 스트림은 보존한다', async () => {
    const fleet = mockFleet({ listRooms: vi.fn().mockResolvedValue([ROOM, ROOM2]) })
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론') // r1 활성

    // 배경 방(r2)에서 스트림이 진행 중
    fleet.fire({ kind: 'start', streamId: 's2', roomId: 'r2', llmId: 'llm-1' })
    fleet.fire({ kind: 'delta', streamId: 's2', roomId: 'r2', delta: '배경 응답', seq: 1 })

    // 활성 방(r1)에서 ask 시작 → r1 만 정리(전역 비우기 아님)
    await act(async () => {
      screen.getByText('Claude에게 묻기').click()
    })

    // r2 로 전환하면 배경 스트림이 살아있어야 한다(예전엔 setStreams({}) 로 유실)
    await act(async () => {
      screen.getByText('토론방2').click()
    })
    expect(screen.getByText('배경 응답')).toBeTruthy()
  })

  it('하이드레이션 윈도우 중 도착한 미상 스트림 델타를 버퍼링해 스냅샷 머지 후 복원한다', async () => {
    let resolveActivity: (a: ChatActivity) => void = () => {}
    const fleet = mockFleet({
      getChatActivity: vi.fn(() => new Promise<ChatActivity>((res) => (resolveActivity = res))),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')

    // start 를 못 받은 스트림 s1 의 델타가 스냅샷 resolve 전 먼저 도착(레이스)
    fleet.fire({ kind: 'delta', streamId: 's1', roomId: 'r1', delta: '실시간 토큰', seq: 1 })
    expect(screen.queryByText('실시간 토큰')).toBeNull() // 아직 미상 — 버블 없음

    // 스냅샷은 델타 이전(seq 0, 빈 텍스트)을 보고 → 버퍼된 델타가 머지 후 이어 붙어야 한다
    await act(async () =>
      resolveActivity({
        busyRooms: ['r1'],
        streams: [{ streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '', seq: 0, steps: [] }],
      }),
    )

    expect(screen.getByText('실시간 토큰')).toBeTruthy() // 유실되지 않고 복원
  })

  it('스냅샷이 이미 반영한 델타는 버퍼가 중복 적용하지 않는다(seq 가드)', async () => {
    let resolveActivity: (a: ChatActivity) => void = () => {}
    const fleet = mockFleet({
      getChatActivity: vi.fn(() => new Promise<ChatActivity>((res) => (resolveActivity = res))),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')

    fleet.fire({ kind: 'delta', streamId: 's1', roomId: 'r1', delta: '가', seq: 1 }) // 버퍼됨
    // 스냅샷이 이 델타까지 이미 반영(seq 1, text '가') — 버퍼가 다시 붙이면 '가가' 가 된다
    await act(async () =>
      resolveActivity({
        busyRooms: ['r1'],
        streams: [{ streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '가', seq: 1, steps: [] }],
      }),
    )

    expect(screen.getByText('가')).toBeTruthy()
    expect(screen.queryByText('가가')).toBeNull() // seq 가드로 이중 집계 안 됨
  })

  it('tool 이벤트로 도구 칩을 렌더하고 같은 id 는 phase 를 in-place 전이한다 (#10 SP3)', async () => {
    const fleet = mockFleet()
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')

    fleet.fire({ kind: 'start', streamId: 's1', roomId: 'r1', llmId: 'llm-1' })
    fleet.fire({
      kind: 'tool',
      streamId: 's1',
      roomId: 'r1',
      step: { id: 't1', name: 'read_file', phase: 'running' },
      seq: 1,
    })
    expect(screen.getByText('⏳ read_file')).toBeTruthy()

    // 같은 id 의 ok 이벤트 → 칩이 추가되지 않고 phase 만 전이(running 사라지고 ok 1개)
    fleet.fire({
      kind: 'tool',
      streamId: 's1',
      roomId: 'r1',
      step: { id: 't1', name: 'read_file', phase: 'ok' },
      seq: 2,
    })
    expect(screen.queryByText('⏳ read_file')).toBeNull()
    expect(screen.getByText('✓ read_file')).toBeTruthy()

    // 역순/중복 도착(seq=1 running 재도착)은 seq 가드로 무시 — ok 로 유지(running 으로 회귀 안 함)
    fleet.fire({
      kind: 'tool',
      streamId: 's1',
      roomId: 'r1',
      step: { id: 't1', name: 'read_file', phase: 'running' },
      seq: 1,
    })
    expect(screen.getByText('✓ read_file')).toBeTruthy()
    expect(screen.queryByText('⏳ read_file')).toBeNull()
  })

  it('마운트 시 스냅샷의 steps 로 도구 칩을 복원한다 (#10 SP3)', async () => {
    mockFleet({
      getChatActivity: vi.fn().mockResolvedValue({
        busyRooms: ['r1'],
        streams: [
          {
            streamId: 's1',
            roomId: 'r1',
            llmId: 'llm-1',
            text: '',
            seq: 2,
            steps: [{ id: 't1', name: 'grep', phase: 'ok' }],
          },
        ],
      } satisfies ChatActivity),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('✓ grep')).toBeTruthy()
  })

  it('하이드레이션 윈도우 중 도착한 미상 스트림 도구 단계를 버퍼링해 스냅샷 머지 후 복원한다 (#10 SP3)', async () => {
    let resolveActivity: (a: ChatActivity) => void = () => {}
    const fleet = mockFleet({
      getChatActivity: vi.fn(() => new Promise<ChatActivity>((res) => (resolveActivity = res))),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    await screen.findByText('🤖 AI 자동 토론')

    // start 못 받은 s1 의 ok 단계(seq=2)가 스냅샷 resolve 전 먼저 도착(레이스) — 버블이 아직 없어 드롭될 위험
    fleet.fire({
      kind: 'tool',
      streamId: 's1',
      roomId: 'r1',
      step: { id: 't1', name: 'grep', phase: 'ok' },
      seq: 2,
    })
    expect(screen.queryByText('✓ grep')).toBeNull() // 아직 미상 — 버블 없음

    // 스냅샷은 running(seq=1)까지만 봄 → 버퍼된 ok(seq=2)가 머지 후 칩을 ok 로 전이시켜야 한다(running 멈춤 방지)
    await act(async () =>
      resolveActivity({
        busyRooms: ['r1'],
        streams: [
          {
            streamId: 's1',
            roomId: 'r1',
            llmId: 'llm-1',
            text: '',
            seq: 1,
            steps: [{ id: 't1', name: 'grep', phase: 'running' }],
          },
        ],
      }),
    )

    expect(screen.getByText('✓ grep')).toBeTruthy() // 유실되지 않고 ok 로 복원
    expect(screen.queryByText('⏳ grep')).toBeNull() // running 에 멈추지 않음
  })
})

function renderWithNonce(ui: ReactElement, nonce: number) {
  return render(
    <HydrationContext.Provider value={{ nonce, connection: 'connected', draining: false }}>
      {ui}
    </HydrationContext.Provider>,
  )
}

describe('재접속 재하이드레이션(#197 B4 — 스냅샷 권위 replace)', () => {
  it('끊긴 사이 idle 된 방의 stale busy 를 스냅샷이 내린다', async () => {
    mockFleet({
      listRooms: vi.fn().mockResolvedValue([ROOM]),
      getChatActivity: vi
        .fn()
        .mockResolvedValueOnce({ busyRooms: [ROOM.id], streams: [] } satisfies ChatActivity) // 최초: busy
        .mockResolvedValue({ busyRooms: [], streams: [] } satisfies ChatActivity), // 재접속: idle 됐음
    })
    const { rerender } = renderWithNonce(<ChatPanel sessions={SESSIONS} />, 0)
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'AI 토론 중…' })).toBeTruthy()
    // 재접속(nonce+1) → 스냅샷 재조회 → busy 해제(replace)
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected', draining: false }}>
        <ChatPanel sessions={SESSIONS} />
      </HydrationContext.Provider>,
    )
    await act(async () => {})
    expect(screen.getByRole('button', { name: '🤖 AI 자동 토론' })).toBeTruthy()
  })

  it('끊긴 사이 종료된 라이브 스트림(유령 말풍선)을 스냅샷이 걷어낸다', async () => {
    const fleet = mockFleet({
      listRooms: vi.fn().mockResolvedValue([ROOM]),
      getChatActivity: vi
        .fn()
        .mockResolvedValue({ busyRooms: [], streams: [] } satisfies ChatActivity),
    })
    const { rerender } = renderWithNonce(<ChatPanel sessions={SESSIONS} />, 0)
    await act(async () => {})
    fleet.fire({ kind: 'start', streamId: 'st1', roomId: ROOM.id, llmId: SESSIONS[0].id })
    expect(screen.getByText(/응답 대기 중/)).toBeTruthy()
    // 재접속: 스냅샷에 st1 없음(끊긴 사이 end 유실) → 말풍선 제거
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected', draining: false }}>
        <ChatPanel sessions={SESSIONS} />
      </HydrationContext.Provider>,
    )
    await act(async () => {})
    expect(screen.queryByText(/응답 대기 중/)).toBeNull()
  })

  it('재하이드레이션 윈도우 중 라이브 start 로 생긴 스트림은 보존한다(라이브 우선)', async () => {
    let resolveActivity!: (a: ChatActivity) => void
    const fleet = mockFleet({
      listRooms: vi.fn().mockResolvedValue([ROOM]),
      getChatActivity: vi
        .fn()
        .mockResolvedValueOnce({ busyRooms: [], streams: [] } satisfies ChatActivity)
        .mockImplementationOnce(() => new Promise<ChatActivity>((r) => (resolveActivity = r))), // 재접속 스냅샷은 지연
    })
    const { rerender } = renderWithNonce(<ChatPanel sessions={SESSIONS} />, 0)
    await act(async () => {})
    rerender(
      <HydrationContext.Provider value={{ nonce: 1, connection: 'connected', draining: false }}>
        <ChatPanel sessions={SESSIONS} />
      </HydrationContext.Provider>,
    )
    // 윈도우 중 라이브 start 도착 → 스냅샷(빈)이 나중에 resolve 돼도 보존돼야 한다
    fleet.fire({ kind: 'start', streamId: 'st-live', roomId: ROOM.id, llmId: SESSIONS[0].id })
    await act(async () => resolveActivity({ busyRooms: [], streams: [] }))
    expect(screen.getByText(/응답 대기 중/)).toBeTruthy()
  })
})
