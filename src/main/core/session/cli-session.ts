import type { CliAdapter, LlmDescriptor } from '../../../shared/types'
import { defaultRunner, type CommandRunner } from '../cli/detect'
import type { LlmSession, SendOptions } from './types'

const DEFAULT_TIMEOUT_MS = 120_000

/** 헤드리스 실행 인자 빌드: '{prompt}' 토큰을 실제 프롬프트로 치환. */
export function buildHeadlessArgs(adapter: CliAdapter, prompt: string): string[] {
  const template = adapter.headless?.args ?? ['{prompt}']
  return template.map((a) => a.replaceAll('{prompt}', prompt))
}

/**
 * CLI(구독제/TUI) 기반 LLM 세션 (요구사항 2A).
 * MVP: 헤드리스 1회 실행(비대화형 print 모드)으로 프롬프트→응답을 주고받는다.
 * 영속 PTY TUI 세션(node-pty)은 동일 LlmSession 뒤로 추후 슬롯인 가능.
 */
export function createCliSession(
  descriptor: LlmDescriptor,
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): LlmSession {
  return {
    id: descriptor.id,
    descriptor,
    async send(prompt: string, opts: SendOptions = {}): Promise<string> {
      if (!adapter.headless) {
        throw new Error(`${adapter.displayName}는 헤드리스 1회 실행을 지원하지 않습니다.`)
      }
      const args = buildHeadlessArgs(adapter, prompt)
      const res = await runner(adapter.command, args, timeoutMs)

      if (res.spawnError) {
        throw new Error(`${adapter.command} 실행 실패: ${res.spawnError}`)
      }
      if (res.code !== 0) {
        throw new Error(`${adapter.command} 종료코드 ${res.code}: ${res.stderr.trim()}`)
      }
      const out = res.stdout.trim()
      opts.onChunk?.(out)
      return out
    },
    async dispose(): Promise<void> {
      // 1회 실행 모델이라 유지 리소스 없음. (PTY 도입 시 종료 처리)
    },
  }
}
