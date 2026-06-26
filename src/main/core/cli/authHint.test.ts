import { describe, expect, it } from 'vitest'
import type { CliAdapter } from '../../../shared/types'
import type { CommandResult } from './detect'
import { classifyCliAuthHint } from './authHint'

const baseAdapter = (over: Partial<CliAdapter> = {}): CliAdapter => ({
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
  headless: { args: ['-p', '{prompt}'] },
  auth: {
    loginCommand: 'claude auth login',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  ...over,
})
const codexAdapter = baseAdapter({
  id: 'codex',
  command: 'codex',
  auth: { loginCommand: 'codex login', docsUrl: 'https://developers.openai.com/codex/cli' },
})
const noAuthAdapter = baseAdapter({ auth: undefined })

const res = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 1,
  stdout: '',
  stderr: '',
  ...over,
})

describe('classifyCliAuthHint', () => {
  describe('positive — auth-형 실패면 loginCommand·docsUrl 포함 hint', () => {
    it('claude: not logged in', () => {
      const hint = classifyCliAuthHint(baseAdapter(), res({ stderr: 'Error: not logged in' }))
      expect(hint).toContain('claude auth login')
      expect(hint).toContain('https://docs.anthropic.com/en/docs/claude-code')
    })

    it('codex: unauthorized → codex login', () => {
      const hint = classifyCliAuthHint(codexAdapter, res({ stderr: 'Error: unauthorized' }))
      expect(hint).toContain('codex login')
    })

    it('authentication required', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: 'authentication required' })),
      ).not.toBeNull()
    })

    it('bare 401', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: 'request failed: 401' })),
      ).not.toBeNull()
    })

    it('session expired', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: 'session expired' }))).not.toBeNull()
    })

    it('invalid api key', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: 'invalid api key' }))).not.toBeNull()
    })

    it('please log in 변형', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: 'please log in to continue' })),
      ).not.toBeNull()
    })

    it('invalid credentials (복수) — credentials? 커버', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: 'invalid credentials' })),
      ).not.toBeNull()
    })

    it('not authorized — not authori[sz]ed 커버', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: 'not authorized' }))).not.toBeNull()
    })

    it('403 forbidden: invalid token (forbidden-context)', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: '403 forbidden: invalid token' })),
      ).not.toBeNull()
    })

    it('stderr 비고 stdout 에 unauthenticated (stdout 폴백)', () => {
      expect(
        classifyCliAuthHint(
          baseAdapter(),
          res({ stderr: '', stdout: '{"error":"unauthenticated"}' }),
        ),
      ).not.toBeNull()
    })
  })

  describe('negative — null', () => {
    it('rate limit + please login (exclude-first 가 strong-auth 이김)', () => {
      expect(
        classifyCliAuthHint(
          baseAdapter(),
          res({ stderr: 'rate limit exceeded; please login later' }),
        ),
      ).toBeNull()
    })

    it('forbidden 단독', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: 'forbidden' }))).toBeNull()
    })

    it('permission denied 단독', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: 'permission denied' }))).toBeNull()
    })

    it('syntax error', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: 'syntax error near token' })),
      ).toBeNull()
    })

    it('file not found', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: 'file not found' }))).toBeNull()
    })

    it('빈 stderr + 빈 stdout', () => {
      expect(classifyCliAuthHint(baseAdapter(), res({ stderr: '', stdout: '' }))).toBeNull()
    })

    it('code 0 (성공)', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ code: 0, stderr: 'not logged in' })),
      ).toBeNull()
    })

    it('auth 메타 없는 어댑터', () => {
      expect(classifyCliAuthHint(noAuthAdapter, res({ stderr: 'not logged in' }))).toBeNull()
    })

    it('spawnError 존재(auth stderr 여도)', () => {
      expect(
        classifyCliAuthHint(
          baseAdapter(),
          res({ code: null, stderr: 'not logged in', spawnError: 'ENOENT' }),
        ),
      ).toBeNull()
    })

    it('stdout 의 forbidden 은 strong 아님(stdout 은 strong-only)', () => {
      expect(
        classifyCliAuthHint(baseAdapter(), res({ stderr: '', stdout: 'forbidden' })),
      ).toBeNull()
    })

    it('stderr non-auth + stdout auth → null (폴백=stderr 비었을 때만)', () => {
      expect(
        classifyCliAuthHint(
          baseAdapter(),
          res({ stderr: 'syntax error', stdout: 'unauthenticated' }),
        ),
      ).toBeNull()
    })

    it('stderr exclude + stdout auth → null (stderr-primary + exclude-first)', () => {
      expect(
        classifyCliAuthHint(
          baseAdapter(),
          res({ stderr: 'rate limit exceeded', stdout: 'not logged in' }),
        ),
      ).toBeNull()
    })
  })
})
