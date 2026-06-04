import { useEffect, useRef, useState } from 'react'
import type { AgentRole, ChatMessage, ChatRoom, ChatStreamEvent, LlmDescriptor } from '../../shared/types'
import { agentHue, cx, vars } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

/** 진행 중(in-flight) LLM 발언 — streamId 로 식별되는 라이브 말풍선. */
interface StreamBubble {
  streamId: string
  roomId: string
  llmId: string
  role?: AgentRole
  text: string
  /** 방출된 에러 메시지(있으면 말풍선을 에러 표시로 렌더). */
  error?: string
}

function llmName(llmId: string, sessions: LlmDescriptor[]): string {
  return sessions.find((s) => s.id === llmId)?.displayName ?? llmId
}

function authorName(msg: ChatMessage, sessions: LlmDescriptor[]): string {
  const author = msg.author
  if (author.type === 'user') return '사용자'
  if (author.type === 'system') return '시스템'
  return llmName(author.llmId, sessions)
}

export function ChatPanel({ sessions }: Props) {
  const [rooms, setRooms] = useState<ChatRoom[]>([])
  const [activeRoom, setActiveRoom] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [newRoomTitle, setNewRoomTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [rounds, setRounds] = useState(1)
  // 라이브 말풍선은 streamId 로 평면 보관하고(각 말풍선이 roomId 보유) 렌더 시 활성 방만 필터한다.
  // 방 전환에도 비우지 않으므로 백그라운드 방의 진행 중 스트림이 유지된다.
  const [streams, setStreams] = useState<Record<string, StreamBubble>>({})
  // 비동기 콜백이 '도착 시점'의 활성 방을 알 수 있게 최신 activeRoom 을 ref 로 추적(스테일 클로저 방지).
  const activeRoomRef = useRef<string | null>(null)

  useEffect(() => {
    void refreshRooms()
  }, [])

  useEffect(() => {
    activeRoomRef.current = activeRoom
    if (activeRoom) void refreshMessages(activeRoom)
  }, [activeRoom])

  // 채팅 토큰 스트림 구독 — 마운트 1회. 방 필터는 렌더에서 하므로 activeRoom 클로저에 의존하지 않는다.
  useEffect(() => {
    const unsub = window.fleet.onChatStream((e: ChatStreamEvent) => {
      if (e.kind === 'start') {
        setStreams((prev) => ({
          ...prev,
          [e.streamId]: { streamId: e.streamId, roomId: e.roomId, llmId: e.llmId, role: e.role, text: '' },
        }))
      } else if (e.kind === 'delta') {
        // start 를 못 받은 스트림(탭 언마운트 등)은 무시 — 작성자 미상 합성 말풍선을 만들지 않는다.
        setStreams((prev) => {
          const cur = prev[e.streamId]
          if (!cur) return prev
          return { ...prev, [e.streamId]: { ...cur, text: cur.text + e.delta } }
        })
      } else if (e.kind === 'end') {
        // 라이브 말풍선 제거(어느 방이든) + 영속 메시지를 활성 방에 한해 낙관적 추가(토론 중간 발언 즉시 표시).
        setStreams((prev) => {
          if (!prev[e.streamId]) return prev
          const next = { ...prev }
          delete next[e.streamId]
          return next
        })
        if (e.message.roomId === activeRoomRef.current) {
          setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]))
        }
      } else {
        // error: 말풍선을 에러 표시로 전환(다음 ask/discuss 시 정리됨).
        setStreams((prev) => {
          const cur = prev[e.streamId]
          if (!cur) return prev
          return { ...prev, [e.streamId]: { ...cur, error: e.message } }
        })
      }
    })
    return unsub
  }, [])

  async function refreshRooms() {
    const r = await window.fleet.listRooms()
    setRooms(r)
    if (!activeRoom && r.length > 0) setActiveRoom(r[0].id)
  }

  async function refreshMessages(roomId: string) {
    const history = await window.fleet.roomHistory(roomId)
    // 응답 도착 시점에 다른 방을 보고 있으면 적용하지 않는다(스테일 방 덮어쓰기 방지).
    if (activeRoomRef.current !== roomId) return
    setMessages(history)
  }

  async function createRoom() {
    const title = newRoomTitle.trim() || `작업방 ${rooms.length + 1}`
    const room = await window.fleet.createRoom(title, sessions.map((s) => s.id))
    setNewRoomTitle('')
    await refreshRooms()
    setActiveRoom(room.id)
  }

  async function postMessage() {
    if (!activeRoom || !text.trim()) return
    await window.fleet.postUserMessage(activeRoom, text.trim())
    setText('')
    await refreshMessages(activeRoom)
  }

  async function ask(llmId: string) {
    if (!activeRoom) return
    setBusy(true)
    setStreams({}) // 직전 에러 말풍선 정리
    try {
      await window.fleet.askLlm(activeRoom, llmId)
      await refreshMessages(activeRoom) // 성공 시에만 store 기준 정합(에러 시 'error' 말풍선 유지)
    } catch {
      // 실패는 스트림 'error' 이벤트가 말풍선으로 이미 표시함 — 미처리 거부만 흡수.
    } finally {
      setBusy(false)
    }
  }

  async function discuss() {
    if (!activeRoom || sessions.length < 2) return
    setBusy(true)
    setStreams({})
    try {
      await window.fleet.discussRoom(activeRoom, sessions.map((s) => s.id), rounds)
      await refreshMessages(activeRoom)
    } catch {
      // 한 턴 실패 시 해당 턴의 'error' 말풍선이 표시됨 — 미처리 거부만 흡수.
    } finally {
      setBusy(false)
    }
  }

  const liveBubbles = Object.values(streams).filter((s) => s.roomId === activeRoom)

  return (
    <div className="chat">
      <aside className="panel rooms">
        <span className="eyebrow">작업방</span>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="field"
            placeholder="새 방 이름"
            value={newRoomTitle}
            onChange={(e) => setNewRoomTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createRoom()
            }}
          />
          <button className="btn btn-sm" onClick={createRoom}>
            +
          </button>
        </div>
        {rooms.map((r) => (
          <button key={r.id} className="room-btn" data-active={r.id === activeRoom} onClick={() => setActiveRoom(r.id)}>
            {r.title}
          </button>
        ))}
        {rooms.length === 0 && <p className="empty">방이 없습니다.</p>}
      </aside>

      <section className="panel chat-main">
        {activeRoom ? (
          <>
            <div className="transcript">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={cx('msg', m.author.type === 'user' && 'user')}
                  style={m.author.type === 'llm' ? vars({ '--hue': agentHue(m.author.llmId) }) : undefined}
                >
                  <div className="msg-head">
                    <span className={cx('msg-author', m.author.type !== 'llm' && 'neutral')}>
                      {authorName(m, sessions)}
                    </span>
                    {m.role && <span className="msg-role">· {m.role}</span>}
                  </div>
                  <div className="msg-body">{m.content}</div>
                </div>
              ))}

              {liveBubbles.map((s) => (
                <div
                  key={s.streamId}
                  className={cx('stream', s.error && 'error')}
                  // 에러일 땐 인라인 --hue 를 주지 않아 .stream.error 의 --hue(빨강)가 작성자 색에 적용되게 한다.
                  style={s.error ? undefined : vars({ '--hue': agentHue(s.llmId) })}
                >
                  <div className="msg-head">
                    <span className="msg-author">{llmName(s.llmId, sessions)}</span>
                    {s.role && <span className="msg-role">· {s.role}</span>}
                  </div>
                  {s.error ? (
                    <div className="stream-err">⚠ {s.error}</div>
                  ) : (
                    <div className="stream-body">
                      {s.text || <span className="stream-wait">응답 대기 중…</span>}
                      <span className="caret" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="controls">
              <div className="chiprow">
                <button className="btn btn-live btn-sm" disabled={busy || sessions.length < 2} onClick={discuss}>
                  {busy ? 'AI 토론 중…' : '🤖 AI 자동 토론'}
                </button>
                <span className="field-label" style={{ margin: 0 }}>
                  라운드
                </span>
                <select
                  className="field"
                  style={{ width: 64, padding: '6px 8px' }}
                  value={rounds}
                  onChange={(e) => setRounds(Number(e.target.value))}
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
                {sessions.length < 2 && (
                  <span className="note-warn" style={{ fontSize: 11 }}>
                    세션 2개 이상 필요
                  </span>
                )}
              </div>
              <div className="chiprow">
                {sessions.map((s) => (
                  <button key={s.id} className="ask-btn" disabled={busy} onClick={() => ask(s.id)}>
                    {busy ? '…' : `${s.displayName}에게 묻기`}
                  </button>
                ))}
              </div>
            </div>

            <div className="composer">
              <input
                className="field"
                placeholder="메시지 입력 (개입/지시)"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void postMessage()
                }}
              />
              <button className="btn" onClick={postMessage}>
                전송
              </button>
            </div>
          </>
        ) : (
          <div className="placeholder-empty">방을 만들거나 선택하세요.</div>
        )}
      </section>
    </div>
  )
}
