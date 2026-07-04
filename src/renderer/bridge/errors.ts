import { TransportError } from './ws-bridge'

/**
 * 사용자 표시용 오류 문구(#197 B4 reject audit) — 전송층 유래(TransportError)를 "연산 실패"와
 * 구분한다. 단절 reject 는 연산의 성패 미상(서버에선 계속 진행 중일 수 있음) — 재접속 재하이드레이션이
 * RunActivity/ChatActivity 스냅샷으로 상태를 복원하므로 그 안내를 싣는다.
 */
export function describeError(err: unknown): string {
  if (err instanceof TransportError) {
    if (err.reason === 'timeout') {
      return '요청 시간 초과 — 서버 응답이 없습니다. 잠시 후 다시 시도하세요.'
    }
    return '서버 연결이 끊겨 결과를 확인하지 못했습니다 — 재접속되면 상태가 자동 복원됩니다.'
  }
  return err instanceof Error ? err.message : String(err)
}
