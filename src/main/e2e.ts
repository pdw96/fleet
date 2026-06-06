import type { CommandResult, CommandRunner } from './core/cli/detect'
import type { FleetEngine } from './core/engine'

/**
 * E2E 전용 훅(FLEET_E2E 환경변수로만 활성). 실제 CLI/네트워크 대신 결정론적 동작을 주입해
 * Playwright 가 GUI 회귀(예: 탭 전환 시 진행 상태 유실)를 흔들림 없이 검증하게 한다.
 * 프로덕션 경로는 FLEET_E2E 미설정 시 전혀 건드리지 않는다.
 */

/**
 * 페이크 명령 실행기:
 *  - `--version`(감지): 즉시 설치됨으로 응답해 세션 등록이 가능하게 한다.
 *  - 채팅 발언: claude-stream 토큰 1개를 흘린 뒤 영원히 in-flight 로 둔다. 진행(busy)·라이브 말풍선이
 *    관찰 가능한 상태로 멈춰, 탭 언마운트/리마운트 후 복원을 검증할 수 있다(앱 종료가 정리).
 */
export const e2eRunner: CommandRunner = (_command, args, _opts, onStdout) => {
  if (args.includes('--version')) return Promise.resolve({ code: 0, stdout: 'fleet-e2e 9.9.9', stderr: '' })
  onStdout?.('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"진행 중 응답"}}}\n')
  return new Promise<CommandResult>(() => {}) // 의도적으로 resolve 안 함 — 진행 상태를 고정한다
}

/** 결정론적 픽스처: 페이크 세션 2개 + 방 1개 — 채팅 탭이 즉시 토론 가능하도록 시드한다. */
export function seedE2eFixtures(engine: FleetEngine): void {
  engine.registerCliSession('claude')
  engine.registerCliSession('codex')
  engine.createRoom('E2E 토론방', ['cli:claude', 'cli:codex'])
}
