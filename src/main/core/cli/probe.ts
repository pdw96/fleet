import type { CliAdapter, ProbeResult } from '../../../shared/types'
import { buildHeadlessArgs } from '../session/cli-session'
import { classifyCliAuthHint } from './authHint'
import { type CommandResult, type CommandRunner, defaultRunner } from './detect'

/** probe 최소 프롬프트 — 토큰 최소화. 모델 출력은 검사하지 않는다(exit+stderr만). */
export const PROBE_PROMPT = 'Reply with: ok'
/** probe 타임아웃 — 모델 왕복 여유 + runner kill-tree 보호. */
export const PROBE_TIMEOUT_MS = 20_000
const DETAIL_MAX = 500

// detail 에서 ANSI CSI escape(\x1b[ … 종결문자) + C0 제어문자(탭 09·개행 0a·CR 0d 제외)를 제거한다.
// renderer 인라인 표시 안정화 + 민감 토막(색코드 섞인 출력) 노출 최소화.
/* eslint-disable no-control-regex -- detail sanitize: ANSI/제어문자 strip 목적 */
const ANSI_CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g
const C0_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/* eslint-enable no-control-regex */

function sanitizeDetail(primary: string, fallback: string): string {
  const raw = (primary.trim() || fallback.trim()).replace(ANSI_CSI, '').replace(C0_CTRL, '').trim()
  return raw.slice(0, DETAIL_MAX)
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
    return { status: 'error', detail: sanitizeDetail(String(e), '') }
  }

  if (res.spawnError) {
    return res.spawnError === 'ETIMEDOUT' || res.spawnError === 'ABORTED'
      ? { status: 'timeout' }
      : { status: 'error', detail: res.spawnError }
  }
  if (res.code === 0) return { status: 'ok' }

  const hint = classifyCliAuthHint(adapter, res)
  if (hint) return { status: 'auth', hint }
  return { status: 'error', detail: sanitizeDetail(res.stderr, res.stdout) }
}
