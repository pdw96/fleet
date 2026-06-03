import { useEffect, useState } from 'react'
import type { ChatMessage, ChatRoom, LlmDescriptor } from '../../shared/types'
import { button, buttonGhost, card, colors, input } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

function authorName(msg: ChatMessage, sessions: LlmDescriptor[]): string {
  const author = msg.author
  if (author.type === 'user') return '사용자'
  if (author.type === 'system') return '시스템'
  return sessions.find((s) => s.id === author.llmId)?.displayName ?? author.llmId
}

export function ChatPanel({ sessions }: Props) {
  const [rooms, setRooms] = useState<ChatRoom[]>([])
  const [activeRoom, setActiveRoom] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [newRoomTitle, setNewRoomTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [rounds, setRounds] = useState(1)

  useEffect(() => {
    void refreshRooms()
  }, [])

  useEffect(() => {
    if (activeRoom) void refreshMessages(activeRoom)
  }, [activeRoom])

  async function refreshRooms() {
    const r = await window.fleet.listRooms()
    setRooms(r)
    if (!activeRoom && r.length > 0) setActiveRoom(r[0].id)
  }

  async function refreshMessages(roomId: string) {
    setMessages(await window.fleet.roomHistory(roomId))
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
    try {
      await window.fleet.askLlm(activeRoom, llmId)
      await refreshMessages(activeRoom)
    } finally {
      setBusy(false)
    }
  }

  async function discuss() {
    if (!activeRoom || sessions.length < 2) return
    setBusy(true)
    try {
      await window.fleet.discussRoom(activeRoom, sessions.map((s) => s.id), rounds)
      await refreshMessages(activeRoom)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, height: '100%' }}>
      <aside style={{ ...card, display: 'grid', gap: 8, alignContent: 'start' }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>작업방</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={input} placeholder="새 방 이름" value={newRoomTitle} onChange={(e) => setNewRoomTitle(e.target.value)} />
          <button style={button} onClick={createRoom}>
            +
          </button>
        </div>
        {rooms.map((r) => (
          <button
            key={r.id}
            style={{ ...buttonGhost, textAlign: 'left', background: r.id === activeRoom ? colors.panel2 : 'transparent' }}
            onClick={() => setActiveRoom(r.id)}
          >
            {r.title}
          </button>
        ))}
      </aside>

      <section style={{ ...card, display: 'grid', gridTemplateRows: '1fr auto auto', gap: 10, minHeight: 420 }}>
        {!activeRoom && <p style={{ color: colors.muted }}>방을 만들거나 선택하세요.</p>}

        <div style={{ overflow: 'auto', display: 'grid', gap: 8, alignContent: 'start' }}>
          {messages.map((m) => (
            <div key={m.id} style={{ padding: '8px 10px', background: colors.panel2, borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: colors.accent, marginBottom: 2 }}>
                {authorName(m, sessions)}
                {m.role && <span style={{ color: colors.muted, marginLeft: 6 }}>· {m.role}</span>}
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.content}</div>
            </div>
          ))}
        </div>

        {activeRoom && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={{ ...button, background: colors.green, opacity: busy || sessions.length < 2 ? 0.5 : 1 }}
                disabled={busy || sessions.length < 2}
                onClick={discuss}
              >
                {busy ? 'AI 토론 중…' : '🤖 AI 자동 토론'}
              </button>
              <label style={{ fontSize: 12, color: colors.muted }}>라운드</label>
              <select style={{ ...input, width: 64 }} value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
              {sessions.length < 2 && <span style={{ fontSize: 11, color: colors.amber }}>세션 2개 이상 필요</span>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sessions.map((s) => (
                <button key={s.id} style={{ ...buttonGhost, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => ask(s.id)}>
                  {busy ? '…' : `${s.displayName}에게 묻기`}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeRoom && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={input}
              placeholder="메시지 입력 (개입/지시)"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void postMessage()
              }}
            />
            <button style={button} onClick={postMessage}>
              전송
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
