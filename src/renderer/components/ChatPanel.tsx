import { useEffect, useRef, useState } from 'react'
import type {
  AgentRole,
  ChatMessage,
  ChatRoom,
  ChatStreamEvent,
  LlmDescriptor,
  ToolStep,
} from '../../shared/types'
import { agentHue, cx, vars } from '../ui'
import { useHydration } from '../bridge/hydration'

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
  /** text·steps 에 반영된 마지막 이벤트 seq(델타·도구 단계 공유). 이보다 큰 것만 적용해 멱등·정렬을 보장한다. */
  seq: number
  /** 관측된 도구 단계(id 로 in-place 갱신된 최신 상태). 라이브 도구 칩 렌더용. */
  steps: ToolStep[]
  /** 방출된 에러 메시지(있으면 말풍선을 에러 표시로 렌더). */
  error?: string
}

/** 도구 단계 phase 별 아이콘(라이브 칩). */
const STEP_ICON: Record<ToolStep['phase'], string> = { running: '⏳', ok: '✓', error: '⚠' }

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
  const [rounds, setRounds] = useState(1)
  // 진행(busy) 표시의 권위는 main(getChatActivity/busy·idle) — 탭 언마운트로 이 컴포넌트가 사라져도
  // 재마운트 시 스냅샷으로 복원된다. 로컬 boolean 대신 방별 진행 집합을 들고 활성 방으로 파생한다.
  const [busyRooms, setBusyRooms] = useState<Set<string>>(new Set())
  // 라이브 말풍선은 streamId 로 평면 보관하고(각 말풍선이 roomId 보유) 렌더 시 활성 방만 필터한다.
  // 방 전환에도 비우지 않으므로 백그라운드 방의 진행 중 스트림이 유지된다.
  const [streams, setStreams] = useState<Record<string, StreamBubble>>({})
  // 비동기 콜백이 '도착 시점'의 활성 방을 알 수 있게 최신 activeRoom 을 ref 로 추적(스테일 클로저 방지).
  const activeRoomRef = useRef<string | null>(null)
  // 하이드레이션 레이스 가드: getChatActivity 스냅샷이 resolve 되기 전 도착한 라이브 종료를 기록해,
  // 스테일 스냅샷이 이미 끝난 스트림/방을 되살리지 않게 한다(라이브 우선). 마운트 1회용이라 누적은 무해.
  const endedStreamsRef = useRef<Set<string>>(new Set())
  const idledRoomsRef = useRef<Set<string>>(new Set())
  // 하이드레이션 레이스 가드(델타 유실 방지): start 를 못 받은 스트림으로 스냅샷 resolve 전 도착한
  // 델타를 streamId 별로 버퍼링했다가, 머지 시 스냅샷 seq 보다 큰 것만 이어 붙인다(이중 집계 방지).
  // 스냅샷 머지 완료 후엔 더 버퍼링하지 않는다(이후의 미상 델타는 진짜 고아 → 무시).
  const pendingDeltasRef = useRef<Record<string, { seq: number; delta: string }[]>>({})
  // 도구 단계의 동형 버퍼 — start 를 못 받은 스트림으로 하이드레이션 윈도우 중 도착한 단계 이벤트를
  // 보관했다가, 스냅샷 머지 시 텍스트 델타와 함께 seq 순으로 재생한다(ok 유실로 칩이 running 에 멈추는 것 방지).
  const pendingToolsRef = useRef<Record<string, { seq: number; step: ToolStep }[]>>({})
  const hydratedRef = useRef(false)
  const { nonce: hydrateNonce } = useHydration()
  // 하이드레이션 윈도우 중 라이브로 도착한 busy 방 / start 스트림 — 스냅샷 replace 시 보존 대상(라이브 우선).
  const liveBusyRef = useRef<Set<string>>(new Set())
  const liveStartedStreamsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // fire-and-forget 갱신은 reject 를 직접 처리해야 한다 — 안 그러면 일시적 IPC 실패가
    // unhandled rejection 으로 샌다(앱·테스트 양쪽). 최선노력 갱신이라 로그만 남기고 무시한다.
    refreshRooms().catch((e) => console.error('방 목록 갱신 실패', e))
    // 마운트 + 웹 재접속 세대(hydrateNonce)에 방 목록 재조회. refreshRooms 는 activeRoom 이 이미 있으면
    // 자동선택하지 않으므로 방 전환마다 재실행되지 않는다(데스크톱은 nonce 0 고정 — 마운트 1회).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateNonce])

  useEffect(() => {
    activeRoomRef.current = activeRoom
    if (activeRoom) refreshMessages(activeRoom).catch((e) => console.error('메시지 갱신 실패', e))
    // hydrateNonce: 웹 재접속 세대마다 활성 방 히스토리 재조회(데스크톱은 0 고정 — refreshMessages 는 ref만 클로저해 안정).
  }, [activeRoom, hydrateNonce])

  // 채팅 토큰 스트림 구독 — 마운트 1회. 방 필터는 렌더에서 하므로 activeRoom 클로저에 의존하지 않는다.
  useEffect(() => {
    const unsub = window.fleet.onChatStream((e: ChatStreamEvent) => {
      if (e.kind === 'start') {
        if (!hydratedRef.current) liveStartedStreamsRef.current.add(e.streamId)
        setStreams((prev) => ({
          ...prev,
          [e.streamId]: {
            streamId: e.streamId,
            roomId: e.roomId,
            llmId: e.llmId,
            role: e.role,
            text: '',
            seq: 0,
            steps: [],
          },
        }))
      } else if (e.kind === 'tool') {
        // 도구 단계: id 로 칩을 in-place 갱신(running→ok/error). seq 멱등은 텍스트 델타와 공유 카운터.
        // 하이드레이션 윈도우엔 델타와 동형으로 버퍼링해(setStreams 갱신부 밖) start 미수신 스트림의
        // 단계 이벤트(특히 ok 전이) 유실로 칩이 running 에 멈추지 않게 한다.
        if (!hydratedRef.current) {
          ;(pendingToolsRef.current[e.streamId] ??= []).push({ seq: e.seq, step: e.step })
        }
        setStreams((prev) => {
          const cur = prev[e.streamId]
          if (!cur) return prev // start 못 받은 스트림 — 스냅샷 catch-up(+버퍼)이 steps 를 복원한다
          if (e.seq <= cur.seq) return prev // 멱등: 이미 반영한(중복/역순) 이벤트 무시
          const i = cur.steps.findIndex((s) => s.id === e.step.id)
          const steps =
            i >= 0 ? cur.steps.map((s, j) => (j === i ? e.step : s)) : [...cur.steps, e.step]
          return { ...prev, [e.streamId]: { ...cur, steps, seq: e.seq } }
        })
      } else if (e.kind === 'delta') {
        // start 를 못 받은 스트림(탭 언마운트 등)은 합성 말풍선을 만들지 않는다 — 작성자 미상이므로.
        // 다만 하이드레이션 윈도우에선 버퍼링해(setStreams 갱신부 밖, StrictMode 이중호출 무관)
        // 스냅샷 머지가 작성자 정보와 함께 복원할 때 이어 붙일 수 있게 한다.
        if (!hydratedRef.current) {
          ;(pendingDeltasRef.current[e.streamId] ??= []).push({ seq: e.seq, delta: e.delta })
        }
        setStreams((prev) => {
          const cur = prev[e.streamId]
          if (!cur) return prev
          if (e.seq <= cur.seq) return prev // 멱등: 이미 반영한(중복/역순) 델타는 무시
          return { ...prev, [e.streamId]: { ...cur, text: cur.text + e.delta, seq: e.seq } }
        })
      } else if (e.kind === 'end') {
        endedStreamsRef.current.add(e.streamId) // 하이드레이션 레이스 가드(스냅샷 되살림 방지)
        liveStartedStreamsRef.current.delete(e.streamId) // 윈도우 중 종료 — replace 보존 대상서 제외
        // 라이브 말풍선 제거(어느 방이든) + 영속 메시지를 활성 방에 한해 낙관적 추가(토론 중간 발언 즉시 표시).
        setStreams((prev) => {
          if (!prev[e.streamId]) return prev
          const next = { ...prev }
          delete next[e.streamId]
          return next
        })
        if (e.message.roomId === activeRoomRef.current) {
          setMessages((prev) =>
            prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message],
          )
        }
      } else if (e.kind === 'error') {
        endedStreamsRef.current.add(e.streamId) // 에러도 종료 — 스냅샷 되살림 방지
        liveStartedStreamsRef.current.delete(e.streamId) // 윈도우 중 종료 — replace 보존 대상서 제외
        // 말풍선을 에러 표시로 전환(다음 ask/discuss 시 정리됨).
        setStreams((prev) => {
          const cur = prev[e.streamId]
          if (!cur) return prev
          return { ...prev, [e.streamId]: { ...cur, error: e.message } }
        })
      } else if (e.kind === 'busy') {
        // 방 진행 시작 — main 권위 신호. 활성 방이면 렌더에서 진행 표시로 파생된다.
        if (!hydratedRef.current) liveBusyRef.current.add(e.roomId)
        setBusyRooms((prev) => (prev.has(e.roomId) ? prev : new Set(prev).add(e.roomId)))
      } else {
        // idle: 방의 마지막 연산 종료.
        idledRoomsRef.current.add(e.roomId) // 하이드레이션 레이스 가드(스냅샷 되살림 방지)
        liveBusyRef.current.delete(e.roomId) // 윈도우 중 idle — replace 보존 대상서 제외
        setBusyRooms((prev) => {
          if (!prev.has(e.roomId)) return prev
          const next = new Set(prev)
          next.delete(e.roomId)
          return next
        })
      }
    })
    return unsub
  }, [])

  // 마운트·웹 재접속(hydrateNonce) 시 진행 상태 스냅샷 복원 — 스냅샷은 권위(replace). merge(추가만)면
  // 끊긴 사이 idle/end 된 방·스트림의 stale 진행 표시(유령 말풍선·영구 busy)가 남는다(#197 B4).
  // 라이브-우선 가드(ended/idled/liveBusy/liveStarted)와 델타 버퍼는 이 하이드레이션 윈도우 기준으로 리셋한다.
  useEffect(() => {
    hydratedRef.current = false
    endedStreamsRef.current = new Set()
    idledRoomsRef.current = new Set()
    liveBusyRef.current = new Set()
    liveStartedStreamsRef.current = new Set()
    pendingDeltasRef.current = {}
    pendingToolsRef.current = {}
    let cancelled = false
    window.fleet
      .getChatActivity()
      .then((a) => {
        if (cancelled) return // 더 새 하이드레이션 세대가 시작됨 — 이 스냅샷은 stale
        const pending = pendingDeltasRef.current
        pendingDeltasRef.current = {}
        const pendingTools = pendingToolsRef.current
        pendingToolsRef.current = {}
        hydratedRef.current = true
        setBusyRooms(() => {
          // replace: 윈도우 중 라이브 busy(liveBusyRef) ∪ 스냅샷 busy(윈도우 중 idle 된 방 제외).
          const next = new Set(liveBusyRef.current)
          for (const r of a.busyRooms) if (!idledRoomsRef.current.has(r)) next.add(r)
          return next
        })
        setStreams((prev) => {
          const merged: Record<string, StreamBubble> = {}
          // 윈도우 중 라이브 start 로 생긴 스트림만 보존 — 그 외 prev(재접속 전 잔존)는 스냅샷에 없으면
          // 끊긴 사이 종료된 유령이므로 폐기한다(스냅샷 권위 · 스냅샷에 있으면 아래 루프가 복원).
          for (const [id, s] of Object.entries(prev)) {
            if (liveStartedStreamsRef.current.has(id)) merged[id] = s
          }
          for (const s of a.streams) {
            if (s.streamId in merged) continue // 라이브가 이미 아는 스트림 — 덮어쓰지 않음
            if (endedStreamsRef.current.has(s.streamId)) continue // 윈도우 중 종료 — 되살리지 않음
            // 스냅샷(seq 까지 반영) + 윈도우 중 버퍼된 더 새로운 이벤트(seq>스냅샷)를 seq 순으로 재생.
            let { text, seq } = s
            const steps = [...s.steps]
            const buffered: ({ seq: number; delta: string } | { seq: number; step: ToolStep })[] = [
              ...(pending[s.streamId] ?? []),
              ...(pendingTools[s.streamId] ?? []),
            ].sort((x, y) => x.seq - y.seq)
            for (const ev of buffered) {
              if (ev.seq <= seq) continue
              if ('step' in ev) {
                const i = steps.findIndex((x) => x.id === ev.step.id)
                if (i >= 0) steps[i] = ev.step
                else steps.push(ev.step)
              } else {
                text += ev.delta
              }
              seq = ev.seq
            }
            merged[s.streamId] = { ...s, text, seq, steps }
          }
          return merged
        })
      })
      .catch((e) => console.error('채팅 활동 스냅샷 복원 실패', e)) // 재접속 하이드레이션이 재시도(#197 B4)
    return () => {
      cancelled = true
    }
    // hydrateNonce: 마운트 + 웹 재접속 세대 — 그 외 상태에 비의존(윈도우 리셋이 정확성 조건)이라 의도적 한정.
    // (effect 는 setter·ref·window.fleet 만 참조 — 리액티브 누락 deps 없음.)
  }, [hydrateNonce])

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
    try {
      const room = await window.fleet.createRoom(
        title,
        sessions.map((s) => s.id),
      )
      setNewRoomTitle('')
      await refreshRooms()
      setActiveRoom(room.id)
    } catch (e) {
      console.error('방 생성 실패', e) // 전송 단절 포함 — 재접속 후 재시도 가능(#197 B4 reject audit)
    }
  }

  async function postMessage() {
    if (!activeRoom || !text.trim()) return
    try {
      await window.fleet.postUserMessage(activeRoom, text.trim())
      setText('')
      await refreshMessages(activeRoom)
    } catch (e) {
      console.error('메시지 전송 실패', e) // 입력은 보존(setText 미실행) — 재전송 가능
    }
  }

  // 진행(busy) 해제는 main 의 idle 이벤트가 권위. 여기선 round-trip 동안의 중복 클릭만 낙관적으로 막는다.
  function markBusy(roomId: string) {
    setBusyRooms((prev) => (prev.has(roomId) ? prev : new Set(prev).add(roomId)))
  }

  // 새 ask/discuss 시작 시 해당 방의 직전 말풍선(에러 등)만 정리하고, 다른 방의 진행 중 스트림은 보존한다.
  // (전역 비우기는 백그라운드 방의 라이브 버블을 없애 — 복귀 시 진행 표시가 유실됐다.)
  function clearRoomStreams(roomId: string) {
    setStreams((prev) => {
      let changed = false
      const next: Record<string, StreamBubble> = {}
      for (const [id, s] of Object.entries(prev)) {
        if (s.roomId === roomId) changed = true
        else next[id] = s
      }
      return changed ? next : prev
    })
  }

  async function ask(llmId: string) {
    if (!activeRoom) return
    const room = activeRoom
    markBusy(room)
    clearRoomStreams(room) // 이 방의 직전 에러 말풍선만 정리(다른 방 스트림 보존)
    try {
      await window.fleet.askLlm(room, llmId)
      await refreshMessages(room) // 성공 시에만 store 기준 정합(에러 시 'error' 말풍선 유지)
    } catch {
      // 실패는 스트림 'error' 이벤트가 말풍선으로 이미 표시함 — 미처리 거부만 흡수.
    }
  }

  async function discuss() {
    if (!activeRoom || sessions.length < 2) return
    const room = activeRoom
    markBusy(room)
    clearRoomStreams(room)
    try {
      await window.fleet.discussRoom(
        room,
        sessions.map((s) => s.id),
        rounds,
      )
      await refreshMessages(room)
    } catch {
      // 한 턴 실패 시 해당 턴의 'error' 말풍선이 표시됨 — 미처리 거부만 흡수.
    }
  }

  // 진행 중 발언(ask/discuss)을 취소한다 — main 의 AbortController 를 abort 해 in-flight LLM 호출을 끊는다.
  // 진행 해제(idle)는 main 의 이벤트가 권위라 여기서 busy 를 직접 끄지 않는다(에러/idle 스트림이 정리).
  async function cancelChat() {
    if (!activeRoom) return
    try {
      await window.fleet.cancelChat(activeRoom)
    } catch (e) {
      console.error('채팅 취소 실패', e)
    }
  }

  // 활성 방이 진행 중인지 — 진행 표시(버튼 라벨/비활성)의 단일 근거.
  const busy = activeRoom ? busyRooms.has(activeRoom) : false
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
          <button className="btn btn-sm" onClick={() => void createRoom()}>
            +
          </button>
        </div>
        {rooms.map((r) => (
          <button
            key={r.id}
            className="room-btn"
            data-active={r.id === activeRoom}
            onClick={() => setActiveRoom(r.id)}
          >
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
                  style={
                    m.author.type === 'llm'
                      ? vars({ '--hue': agentHue(m.author.llmId) })
                      : undefined
                  }
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
                  {s.steps.length > 0 && (
                    <div className="tool-steps">
                      {s.steps.map((step) => (
                        <span
                          key={step.id}
                          className={cx('tool-chip', step.phase)}
                          title={step.summary}
                        >
                          {STEP_ICON[step.phase]} {step.name}
                        </span>
                      ))}
                    </div>
                  )}
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
                <button
                  className="btn btn-live btn-sm"
                  disabled={busy || sessions.length < 2}
                  onClick={() => void discuss()}
                >
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
                {busy && (
                  <button
                    className="btn btn-danger btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => void cancelChat()}
                  >
                    취소
                  </button>
                )}
              </div>
              <div className="chiprow">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    className="ask-btn"
                    disabled={busy}
                    onClick={() => void ask(s.id)}
                  >
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
              <button className="btn" onClick={() => void postMessage()}>
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
