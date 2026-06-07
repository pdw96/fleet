/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatActivity, ChatRoom, ChatStreamEvent, LlmDescriptor } from '../../shared/types'
import { ChatPanel } from './ChatPanel'

const SESSIONS: LlmDescriptor[] = [
  { id: 'llm-1', kind: 'cli', displayName: 'Claude', ref: 'claude' },
  { id: 'llm-2', kind: 'cli', displayName: 'Codex', ref: 'codex' },
]
const ROOM: ChatRoom = { id: 'r1', title: '토론방', participants: ['llm-1', 'llm-2'], createdAt: 1 }

function mockFleet(overrides: Record<string, unknown> = {}) {
  let emit: ((e: ChatStreamEvent) => void) | undefined
  const fleet = {
    listRooms: vi.fn().mockResolvedValue([ROOM]),
    roomHistory: vi.fn().mockResolvedValue([]),
    getChatActivity: vi.fn().mockResolvedValue({ busyRooms: [], streams: [] } satisfies ChatActivity),
    createRoom: vi.fn().mockResolvedValue(ROOM),
    postUserMessage: vi.fn().mockResolvedValue(undefined),
    askLlm: vi.fn().mockResolvedValue(undefined),
    discussRoom: vi.fn().mockResolvedValue(undefined),
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
      getChatActivity: vi.fn().mockResolvedValue({ busyRooms: ['r1'], streams: [] } satisfies ChatActivity),
    })
    render(<ChatPanel sessions={SESSIONS} />)
    expect(await screen.findByText('AI 토론 중…')).toBeTruthy()
  })

  it('마운트 시 라이브 스트림 말풍선을 복원한다(자리 비운 동안의 타이핑 catch-up)', async () => {
    mockFleet({
      getChatActivity: vi.fn().mockResolvedValue({
        busyRooms: ['r1'],
        streams: [{ streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '복원된 부분 응답', seq: 2 }],
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
      message: { id: 'm1', roomId: 'r1', author: { type: 'llm', llmId: 'llm-1' }, content: '끝난 응답', ts: 1 },
    })
    await act(async () =>
      resolveActivity({ busyRooms: [], streams: [{ streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '좀비 타이핑', seq: 1 }] }),
    )

    expect(screen.queryByText('좀비 타이핑')).toBeNull() // 종료된 스트림은 되살아나지 않음
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
      resolveActivity({ busyRooms: ['r1'], streams: [{ streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '', seq: 0 }] }),
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
      resolveActivity({ busyRooms: ['r1'], streams: [{ streamId: 's1', roomId: 'r1', llmId: 'llm-1', text: '가', seq: 1 }] }),
    )

    expect(screen.getByText('가')).toBeTruthy()
    expect(screen.queryByText('가가')).toBeNull() // seq 가드로 이중 집계 안 됨
  })
})
