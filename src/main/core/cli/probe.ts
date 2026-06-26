import type { CliAdapter, ProbeResult } from '../../../shared/types'
import { buildHeadlessArgs } from '../session/cli-session'
import { classifyCliAuthHint } from './authHint'
import { type CommandResult, type CommandRunner, defaultRunner } from './detect'

/** probe 최소 프롬프트 — 토큰 최소화. 모델 출력은 검사하지 않는다(exit+stderr만). */
export const PROBE_PROMPT = 'Reply with: ok'
/** probe 타임아웃 — 모델 왕복 여유 + runner kill-tree 보호. */
export const PROBE_TIMEOUT_MS = 20_000
const DETAIL_MAX = 500

// ESC 로 시작하는 시퀀스 + C0 제어문자(탭 09·개행 0a·CR 0d 제외)를 제거한다.
// renderer 인라인 표시 안정화 + 민감 토막(색코드 섞인 출력) 노출 최소화 + "제어뿐인 stderr"가
// strip 후 빈 값이 되어 stdout 폴백/auth 분류를 가리지 않게 한다(Codex 리뷰).
/* eslint-disable no-control-regex -- escape/제어문자 strip 목적 */
// ANSI/VT escape 전 범위 포괄(제어뿐인 stderr 가 strip 후 빈 값이 되어 stdout 폴백/auth 분류를 가리지
// 않도록). 순서=구체적인 것부터:
//  1) string control(OSC ESC] · DCS ESC P · SOS ESC X · PM ESC ^ · APC ESC _) … BEL|ST(ESC \)
//  2) CSI(ESC [ , 파라미터 0x30-3f · 중간 0x20-2f · 종결 0x40-7e)
//  3) nF escape(ESC + 중간바이트 0x20-2f+ + 종결 0x30-7e, 예: 문자셋지정 `ESC ( B`)
//  4) 단일바이트 Fe/Fs(ESC + 0x40-7e, 예: RIS `ESC c`)
// 남는 bare ESC 는 C0_CTRL 이 제거.
const ANSI_ESC =
  /\x1b[P\]X^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[@-~]|\x1b[\x20-\x2f]+[\x30-\x7e]|\x1b[@-~]/g
const C0_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/* eslint-enable no-control-regex */

/** escape 시퀀스·제어문자 제거 + 트림(절단은 호출부에서). */
function stripEsc(s: string): string {
  return s.replace(ANSI_ESC, '').replace(C0_CTRL, '').trim()
}

/**
 * CLI 세션 "연결 테스트"(#150) — headless 호출 1회로 로그인 여부를 transient 하게 확인한다.
 * never-throws: 모든 실패를 ProbeResult 로 정규화한다(등록 비차단). 결과는 저장하지 않는다.
 */
export async function probeCliAuth(
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
): Promise<ProbeResult> {
  const args = buildHeadlessArgs(adapter, PROBE_PROMPT)
  const stdinInput = adapter.promptVia === 'stdin' ? PROBE_PROMPT : undefined

  let res: CommandResult
  try {
    res = await runner(adapter.command, args, { timeoutMs: PROBE_TIMEOUT_MS, stdinInput })
  } catch (e) {
    // never-throws: runner 가 reject 해도(주입 runner·미래 구현) error 로 정규화한다.
    return { status: 'error', detail: stripEsc(String(e)).slice(0, DETAIL_MAX) }
  }

  if (res.spawnError) {
    return res.spawnError === 'ETIMEDOUT' || res.spawnError === 'ABORTED'
      ? { status: 'timeout' }
      : { status: 'error', detail: stripEsc(res.spawnError).slice(0, DETAIL_MAX) }
  }
  if (res.code === 0) return { status: 'ok' }

  // escape/제어 제거 후 stderr→stdout 선택. 제어문자뿐인 stderr 가 stdout 의 실제 auth/오류를 가리지
  // 않도록, 분류(classifyCliAuthHint)와 detail 모두 정제된 값을 쓴다(Codex 리뷰 P3-A/B).
  const stderr = stripEsc(res.stderr)
  const stdout = stripEsc(res.stdout)
  const hint = classifyCliAuthHint(adapter, { ...res, stderr, stdout })
  if (hint) return { status: 'auth', hint }
  return { status: 'error', detail: (stderr || stdout).slice(0, DETAIL_MAX) }
}
