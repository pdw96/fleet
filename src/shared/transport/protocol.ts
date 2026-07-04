/**
 * WS 전송 프레임 프로토콜(#197 B2) — 클라(ws-bridge)·server(B3) 공유 순수 계약.
 *
 * Electron IPC 가 암묵 제공하던 네 시맨틱을 명시 프레임으로 재현한다:
 *  - 요청/응답 correlation : req.id ↔ res.id (동시 요청 다중화)
 *  - 응답 보장             : res.ok=true(value) | false(error) — 소켓 close 시 pending 전원 reject 로 대체
 *  - 푸시 구독             : push{ch,event} — webContents.send 브로드캐스트 대체
 *  - 재접속 커서           : hello{maxEventSeq,minRetainedEventSeq} — rotation gap 감지(B1 store.eventCursor)
 *
 * 직렬화 계약: 모든 프레임은 JSON round-trip 가능해야 한다(Error/Date/class instance/undefined 금지).
 * void(undefined) 반환은 res 프레임에서 `value` 키를 **생략**한다(null 과 구분 — null 은 정당한 값).
 */

/** 클라 → server 요청 프레임. args 는 JSON 직렬화 가능한 인자 튜플. */
export interface ReqFrame {
  t: 'req'
  /** 클라가 발급하는 단조 correlation id. */
  id: number
  ch: string
  args: unknown[]
}

/** server → 클라 성공 응답. void 반환이면 `value` 부재. */
export interface ResOkFrame {
  t: 'res'
  id: number
  ok: true
  value?: unknown
}

/** server → 클라 실패 응답. 스택 미노출(message 만). */
export interface ResErrFrame {
  t: 'res'
  id: number
  ok: false
  error: { message: string }
}

export type ResFrame = ResOkFrame | ResErrFrame

/** server → 클라 푸시(구독 채널 브로드캐스트). */
export interface PushFrame {
  t: 'push'
  ch: string
  event: unknown
}

/**
 * 접속 인사(server → 클라). 재접속 시 렌더러가 이벤트 커서로 gap 을 판정하는 워터마크를 싣는다(B1).
 *  - maxEventSeq         : 마지막 배정 seq(카운터). 커서 갱신 상한.
 *  - minRetainedEventSeq : 현재 보존 이벤트 중 최소 seq(폐기 발생 시 상승). 갭 판정에 씀.
 */
export interface HelloFrame {
  t: 'hello'
  maxEventSeq: number
  minRetainedEventSeq: number
}

/** server 가 클라로 보내는 프레임 합집합. */
export type ServerFrame = ResFrame | PushFrame | HelloFrame
/** 클라가 server 로 보내는 프레임 합집합. */
export type ClientFrame = ReqFrame

/**
 * 성공 응답 프레임 생성. `value===undefined`(void 반환)면 value 키를 생략한다 — JSON 왕복 후에도
 * undefined 로 복원되게 하는 프로토콜 고정 정책. null 은 정당한 값이라 그대로 싣는다.
 */
export function makeOkFrame(id: number, value: unknown): ResOkFrame {
  return value === undefined ? { t: 'res', id, ok: true } : { t: 'res', id, ok: true, value }
}

/** 실패 응답 프레임 생성. 스택/원인 객체를 노출하지 않고 message 만 싣는다. */
export function makeErrFrame(id: number, message: string): ResErrFrame {
  return { t: 'res', id, ok: false, error: { message } }
}

/**
 * 와이어 문자열을 ServerFrame 으로 안전 파싱. 깨진 JSON·비객체·미지 `t`·**필드 불변식 위반**은
 * null(호출부에서 무시). 신뢰 경계 — 판별자뿐 아니라 변형별 필수 필드까지 검증해야 하류(handleMessage)가
 * 무검증 역참조로 crash/영구 hang 하지 않는다(#197 B2 리뷰 P2). 불변식:
 *  - res  : id 는 number · ok 는 boolean · ok===false 면 error.message 가 string(스택 미노출)
 *  - push : ch 는 string(event 는 임의)
 *  - hello: maxEventSeq·minRetainedEventSeq 가 정수(비수치면 missed-gap 오판 — B1 방어 재개방 차단)
 */
export function decodeFrame(data: string): ServerFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const f = parsed as Record<string, unknown>
  switch (f['t']) {
    case 'res': {
      if (typeof f['id'] !== 'number' || typeof f['ok'] !== 'boolean') return null
      if (f['ok'] === false) {
        const err = f['error']
        if (
          typeof err !== 'object' ||
          err === null ||
          typeof (err as Record<string, unknown>)['message'] !== 'string'
        ) {
          return null
        }
      }
      return parsed as ServerFrame
    }
    case 'push':
      return typeof f['ch'] === 'string' ? (parsed as ServerFrame) : null
    case 'hello':
      return Number.isInteger(f['maxEventSeq']) && Number.isInteger(f['minRetainedEventSeq'])
        ? (parsed as ServerFrame)
        : null
    default:
      return null
  }
}

/**
 * 재접속 이벤트 gap 판정. 클라 커서 다음에 필요한 seq(=cursor+1)가 server 보존 최소보다 작으면
 * 폐기 구간(rotation)에 빠진 이벤트가 있어 증분 재생이 불가 → 스냅숏 권위로 강제 전체 재하이드레이션.
 * (store 계약: 커서가 minRetainedEventSeq-1 미만이면 갭 — B1 `Store.eventCursor` 주석 참조.)
 */
export function hasEventGap(
  clientCursor: number,
  hello: Pick<HelloFrame, 'minRetainedEventSeq'>,
): boolean {
  return clientCursor + 1 < hello.minRetainedEventSeq
}

/**
 * 와이어 문자열을 ClientFrame(req)으로 안전 파싱 — 서버측 신뢰 경계(#197 B3, decodeFrame 의 대칭).
 * 불변식 위반은 null — 호출부(ws-host)가 무시한다(응답 없음: id 를 신뢰할 수 없는 프레임엔
 * correlation 가능한 res 를 만들 수 없다). id 는 **양의 safe integer 한정**(체크포인트 3 P2-1):
 * correlation id 는 res 에 그대로 반사되므로 비정상 id(0/음수/unsafe/소수)를 허용하면 클라 pending
 * map 쪽에 추적 어려운 edge 가 생긴다(ws-bridge 는 ++lastId 로 1부터 발급 — 정상 경로 무영향).
 * args 원소의 내용 검증은 비범위(런타임 validator 비범위 정책 — 체크포인트 2 §1).
 */
export function decodeClientFrame(data: string): ReqFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const f = parsed as Record<string, unknown>
  if (f['t'] !== 'req') return null
  const id = f['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (typeof f['ch'] !== 'string') return null
  if (!Array.isArray(f['args'])) return null
  return parsed as ReqFrame
}
