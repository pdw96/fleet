import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, CommandRunner } from './core/cli/detect'
import { PROBE_PROMPT } from './core/cli/probe'
import type { FleetEngine } from './core/engine'

/**
 * E2E 전용 훅(FLEET_E2E 환경변수로만 활성). 실제 CLI/네트워크 대신 결정론적 동작을 주입해
 * Playwright 가 GUI 회귀(예: 탭 전환 시 진행 상태 유실)를 흔들림 없이 검증하게 한다.
 * 프로덕션 경로는 FLEET_E2E 미설정 시 전혀 건드리지 않는다.
 */

/**
 * E2E 활성화는 FLEET_E2E === '1' 일 때만(엄격 핀). `0`/`false`/빈 값/대소문자 변형은
 * 모두 프로덕션 경로 — 이 술어가 느슨해지면 페이크 러너(영구 in-flight)·E2E 픽스처가
 * 프로덕션 런치로 샌다(AGENTS.md 「Fleet 특화 P1 신호」). 순수 함수라 단위 테스트로 핀한다.
 */
export function isE2EActive(env: NodeJS.ProcessEnv): boolean {
  return env['FLEET_E2E'] === '1'
}

/**
 * 페이크 명령 실행기:
 *  - `--version`(감지): 즉시 설치됨으로 응답해 세션 등록이 가능하게 한다.
 *  - 연결 테스트(probe): stdin 이 PROBE_PROMPT 인 헤드리스 호출은 결정론적 성공으로 응답한다
 *    (없으면 아래 never-settle 분기로 빠져 picker 의 "연결 테스트" 버튼이 probing 에 영구 고정된다).
 *  - 채팅 발언: claude-stream 토큰 1개를 흘린 뒤 영원히 in-flight 로 둔다. 진행(busy)·라이브 말풍선이
 *    관찰 가능한 상태로 멈춰, 탭 언마운트/리마운트 후 복원을 검증할 수 있다(앱 종료가 정리).
 */
export const e2eRunner: CommandRunner = (_command, args, opts, onStdout) => {
  if (args.includes('--version'))
    return Promise.resolve({ code: 0, stdout: 'fleet-e2e 9.9.9', stderr: '' })
  if (opts.stdinInput === PROBE_PROMPT)
    return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' })
  onStdout?.(
    '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"진행 중 응답"}}}\n',
  )
  return new Promise<CommandResult>(() => {}) // 의도적으로 resolve 안 함 — 진행 상태를 고정한다
}

/** 결정론적 픽스처: 페이크 세션 2개 + 방 1개 + 워크스페이스 — 채팅·프로젝트 탭이 즉시 동작하도록 시드한다. */
export function seedE2eFixtures(engine: FleetEngine): void {
  engine.registerCliSession('claude')
  engine.registerCliSession('codex')
  engine.createRoom('E2E 토론방', ['cli:claude', 'cli:codex'])
  // 프로젝트 탭 E2E: 워크스페이스를 임시 디렉터리로 시드해 오케스트레이션 실행을 가능하게 한다
  // (runProjectFlow 는 워크스페이스 필수). 페이크 러너가 planTasks 에서 hang 하므로 git 작업(ensureRepo)까지
  // 도달하지 않아 디렉터리 존재만으로 충분하다 — 실행이 project.created 직후 in-flight 로 고정돼
  // 취소 버튼·running 잠금의 탭 전환 복원(getRunActivity)을 관찰할 수 있다(앱 종료가 정리).
  engine.setWorkspace(mkdtempSync(join(tmpdir(), 'fleet-e2e-ws-')))
}

/**
 * 완주 러너(#197 B4 — 웹 스모크 "목표 입력→런 완주" 게이트 전용). 기본 e2eRunner 는 의도적 영구
 * in-flight(데스크톱 e2e 가 진행 고정에 의존)라 완주가 불가하다 — 이 러너는 프롬프트 내용으로 단계를
 * 판별해 결정론적으로 응답한다: 플래너→단일 작업 계획 JSON · 리뷰어→approved(빈 diff 도 승인이
 * 리뷰 프롬프트의 명시 계약) · 그 외(구현/요약)→고정 텍스트. 파일 무변경 실행이라 diff 는 항상 비고
 * verify 는 빈 워크스페이스(package.json 부재)에서 미구동 → project.done 까지 완주한다.
 * 활성화는 FLEET_E2E==='1' 안에서 FLEET_E2E_RUNNER==='complete' 로만(이중 opt-in — 프로덕션 격리).
 * (replan 프롬프트도 플래너 마커를 포함하지만 maxReplanRounds 기본 0=비활성이라 스모크 경로 미도달.)
 */
export const e2eCompletingRunner: CommandRunner = (_command, args, opts, onStdout) => {
  if (args.includes('--version'))
    return Promise.resolve({ code: 0, stdout: 'fleet-e2e 9.9.9', stderr: '' })
  if (opts.stdinInput === PROBE_PROMPT)
    return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' })
  const prompt = opts.stdinInput ?? ''
  const payload = prompt.includes('너는 소프트웨어 프로젝트 플래너다')
    ? '{"tasks":[{"title":"산출물 작성","description":"목표를 요약한 산출물을 만든다","role":"implementer","dependsOn":[]}]}'
    : prompt.includes('변경(diff)')
      ? '{"approved": true, "feedback": ""}'
      : 'E2E 완주 러너 응답'
  // 스트림 파서(누적 델타)와 stdout 수확 어느 경로든 같은 본문을 얻도록 두 채널 모두에 싣는다.
  onStdout?.(
    JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: payload } },
    }) + '\n',
  )
  return Promise.resolve({ code: 0, stdout: payload, stderr: '' })
}

/** e2e 러너 선택 — 완주 러너는 명시 opt-in(`complete`)만. 미지 값은 기본(hang) 러너로 fail-safe. */
export function resolveE2eRunner(env: NodeJS.ProcessEnv): CommandRunner {
  return env['FLEET_E2E_RUNNER'] === 'complete' ? e2eCompletingRunner : e2eRunner
}
