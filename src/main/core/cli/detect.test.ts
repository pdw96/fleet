import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultResolver,
  defaultRunner,
  detectAll,
  detectCli,
  parseVersion,
  resolveCommandPath,
  type CommandRunner,
  type RunOpts,
} from './detect'
import { createCliRegistry, DEFAULT_CLI_ADAPTERS } from './registry'
import * as killTreeMod from '../process/kill-tree'
import type { CliAdapter } from '../../../shared/types'

const claude: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
}

describe('parseVersion', () => {
  it('extracts a semver from version output', () => {
    expect(parseVersion('claude 1.2.3')).toBe('1.2.3')
    expect(parseVersion('v2.1.154 (build abc)')).toBe('2.1.154')
    expect(parseVersion('1.0.0-beta.2')).toBe('1.0.0-beta.2')
  })

  it('returns undefined when there is no version', () => {
    expect(parseVersion('no version here')).toBeUndefined()
  })
})

describe('defaultResolver', () => {
  // 비동기 which 는 {nothrow} 를 무시하고 not-found 시 reject 한다 → defaultResolver 가
  // PathResolver 계약(null = not-found)을 지키도록 null 로 정규화함을 실측 단언.
  it('not-found 명령은 throw 하지 않고 null 로 정규화', async () => {
    await expect(defaultResolver('fleet-no-such-binary-zzz123')).resolves.toBeNull()
  })
})

describe('resolveCommandPath', () => {
  it('절대경로 → resolvedPath 설정, pathShadowRisk 없음', async () => {
    const r = await resolveCommandPath('claude', async () => '/usr/local/bin/claude')
    expect(r).toEqual({ resolvedPath: '/usr/local/bin/claude' })
  })
  it('상대경로 → pathShadowRisk true', async () => {
    const r = await resolveCommandPath('claude', async () => './claude')
    expect(r).toEqual({ resolvedPath: './claude', pathShadowRisk: true })
  })
  it('null(미해석) → 빈 객체', async () => {
    const r = await resolveCommandPath('claude', async () => null)
    expect(r).toEqual({})
  })
  it('resolver 예외 → 삼킴(빈 객체)', async () => {
    const r = await resolveCommandPath('claude', async () => {
      throw new Error('boom')
    })
    expect(r).toEqual({})
  })
})

describe('detectCli', () => {
  it('resolvedPath 병합(절대경로 → 위험 없음)', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3', stderr: '' })
    const r = await detectCli(claude, runner, 5000, async () => '/usr/local/bin/claude')
    expect(r.installed).toBe(true)
    expect(r.resolvedPath).toBe('/usr/local/bin/claude')
    expect(r.pathShadowRisk).toBeUndefined()
  })
  it('상대경로 해석 → pathShadowRisk true', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3', stderr: '' })
    const r = await detectCli(claude, runner, 5000, async () => './claude')
    expect(r.pathShadowRisk).toBe(true)
  })
  it('resolver 예외가 --version 감지를 깨지 않음', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3', stderr: '' })
    const r = await detectCli(claude, runner, 5000, async () => {
      throw new Error('boom')
    })
    expect(r.installed).toBe(true)
    expect(r.version).toBe('1.2.3')
    expect(r.resolvedPath).toBeUndefined()
  })
  it('marks installed and parses version on exit 0', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3\n', stderr: '' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(true)
    expect(r.version).toBe('1.2.3')
    expect(r.kind).toBe('cli')
  })

  it('marks not installed when command is missing (ENOENT)', async () => {
    const runner: CommandRunner = async () => ({
      code: null,
      stdout: '',
      stderr: '',
      spawnError: 'ENOENT',
    })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(false)
    expect(r.version).toBeUndefined()
    expect(r.error).toBe('ENOENT')
  })

  it('marks not installed on non-zero exit', async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: '', stderr: 'not found' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(false)
    expect(r.error).toContain('127')
  })

  it('reads version from stderr when stdout is empty', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: '', stderr: 'gemini 0.4.1' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(true)
    expect(r.version).toBe('0.4.1')
  })
})

describe('detectAll', () => {
  it('detects across multiple adapters', async () => {
    const runner: CommandRunner = async (cmd) =>
      cmd === 'claude'
        ? { code: 0, stdout: '1.0.0', stderr: '' }
        : { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }

    const results = await detectAll(DEFAULT_CLI_ADAPTERS, runner)
    expect(results).toHaveLength(3)
    expect(results.find((r) => r.id === 'claude')?.installed).toBe(true)
    expect(results.find((r) => r.id === 'codex')?.installed).toBe(false)
    expect(results.find((r) => r.id === 'gemini')?.installed).toBe(false)
  })
})

describe('defaultRunner (integration)', () => {
  // 회귀: 러너가 자식 stdin 을 닫지 않으면 stdin 을 읽는 CLI(claude -p 등)가 멈춘다.
  it('closes child stdin so stdin-reading commands do not hang', async () => {
    const script =
      "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>process.stdout.write('done:'+n))"
    const res = await defaultRunner('node', ['-e', script], { timeoutMs: 10_000 })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('done:0')
  }, 15_000)

  // 회귀: stdinInput 이 주어지면 자식 stdin 으로 그대로 전달된 뒤 EOF 된다(긴 프롬프트 argv 한도 우회 경로).
  it('writes stdinInput to the child process stdin (UTF-8)', async () => {
    const script =
      "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('GOT:'+d))"
    const payload = '안녕 stdin '.repeat(2000) // argv 한도(>8191자)를 넘는 큰 입력도 stdin 으론 통과
    const res = await defaultRunner('node', ['-e', script], {
      timeoutMs: 10_000,
      stdinInput: payload,
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('GOT:' + payload)
  }, 15_000)

  // 회귀: maxBuffer 초과 시 child 를 죽이고 명시적 에러를 반환해야 한다(조용한 truncation / 무한 매달림 방지).
  it('errors with ENOBUFS when output exceeds the max buffer', async () => {
    const script = "process.stdout.write('x'.repeat(11*1024*1024))"
    const res = await defaultRunner('node', ['-e', script], { timeoutMs: 10_000 })
    expect(res.spawnError).toBe('ENOBUFS')
  }, 15_000)

  // 회귀(코드 리뷰 P2): overflow 가 여러 chunk 로 반복 트리거돼도 트리 킬은 한 번만 — 과거 child.kill()
  // 은 저렴했지만 killTree 는 매번 taskkill 프로세스를 스폰하므로 가드가 없으면 종료 중 프로세스가 폭주한다.
  it('overflow 가 반복돼도 트리 킬은 한 번만 한다', async () => {
    const killSpy = vi.spyOn(killTreeMod, 'killTree')
    try {
      const script = "process.stdout.write('x'.repeat(11*1024*1024))"
      const res = await defaultRunner('node', ['-e', script], { timeoutMs: 10_000 })
      expect(res.spawnError).toBe('ENOBUFS')
      // 미수정 시 finish 가 첫 overflow 에서 즉시 resolve 하고 남은 chunk 들이 백그라운드에서 onOverflow
      // 를 반복 호출하므로, drain 을 잠시 기다려 그 폭주가 spy 에 쌓이게 한 뒤 카운트한다.
      await new Promise((r) => setTimeout(r, 300))
      expect(killSpy).toHaveBeenCalledTimes(1)
    } finally {
      killSpy.mockRestore()
    }
  }, 15_000)

  it('runs the child in the given cwd', async () => {
    const res = await defaultRunner('node', ['-e', 'process.stdout.write(process.cwd())'], {
      timeoutMs: 10_000,
      cwd: tmpdir(),
    })
    expect(res.code).toBe(0)
    expect(res.stdout.length).toBeGreaterThan(0)
    const base = tmpdir().split(/[\\/]/).pop() ?? ''
    expect(res.stdout).toContain(base)
  }, 15_000)

  it('kills the child when the abort signal fires', async () => {
    const ac = new AbortController()
    const p = defaultRunner('node', ['-e', 'setTimeout(()=>{}, 60000)'], {
      timeoutMs: 30_000,
      signal: ac.signal,
    })
    ac.abort()
    const res = await p
    expect(res.spawnError).toBe('ABORTED')
  }, 15_000)
})

describe.skipIf(process.platform !== 'win32')(
  'defaultRunner (Windows .cmd shim regression)',
  () => {
    // 회귀: npm 설치 CLI(gemini.cmd 등)는 .cmd 배치 셰임이다. execFile 은 bare 이름을
    // PATHEXT 로 해석 못 해 ENOENT, .cmd 명시 시엔 Node 20+ 가드로 EINVAL. cross-spawn 이 둘 다 해결.
    it('resolves and runs a bare command name backed only by a .cmd shim', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'))
      const prevPath = process.env.PATH
      try {
        writeFileSync(join(dir, 'mycli.cmd'), '@echo off\r\necho mycli 7.8.9\r\n')
        process.env.PATH = `${dir};${prevPath ?? ''}`
        const res = await defaultRunner('mycli', ['--version'], { timeoutMs: 10_000 })
        expect(res.spawnError).toBeUndefined()
        expect(res.code).toBe(0)
        expect(parseVersion(res.stdout)).toBe('7.8.9')
      } finally {
        process.env.PATH = prevPath
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)

    // 보안 회귀: 임의 인자(헤드리스 {prompt})에 cmd.exe 메타문자가 있어도 명령 주입이 일어나지 않아야 한다.
    it('does not allow command injection via a malicious argument', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-inj-'))
      const marker = join(dir, 'pwned.txt')
      try {
        writeFileSync(join(dir, 'echoarg.cmd'), '@echo off\r\necho GOT %1\r\n')
        // 주입이 가능하면 체이닝된 'echo > marker' 가 실행되어 marker 파일이 생긴다.
        const payload = `x" & echo pwned> "${marker}" & echo "y`
        const res = await defaultRunner(join(dir, 'echoarg.cmd'), [payload], { timeoutMs: 10_000 })
        expect(res.spawnError).toBeUndefined()
        expect(existsSync(marker)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 15_000)
  },
)

describe.skipIf(process.platform !== 'win32')('defaultRunner (Windows 프로세스 트리 킬)', () => {
  // 회귀(이 버그의 본질): cross-spawn 은 .cmd 셰임을 cmd.exe 경유로 띄우므로 종료 시 child.kill() 은
  // cmd.exe 껍데기만 죽이고 실제 CLI(node.exe 손자)는 살아남는다 → 취소 후에도 편집 에이전트가
  // 워크스페이스를 계속 수정해 engine 의 revert 와 경합한다. 모든 종료 경로가 손자 트리까지 죽여야 한다.
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const waitUntil = async (pred: () => boolean, ms: number) => {
    const start = Date.now()
    while (Date.now() - start < ms && !pred()) await new Promise((r) => setTimeout(r, 50))
  }

  // .cmd 셰임(cmd.exe) → node 손자를 띄우고, 주어진 종료 경로(abort/timeout)로 끝낸 뒤
  // 손자까지 죽었는지 확인한다. 어서션이 (RED 처럼) 실패해도 finally 에서 손자를 정리한다(좀비 누수 방지).
  async function expectTreeKilled(opts: RunOpts, expectError: string, afterStart?: () => void) {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-tree-'))
    let grandchildPid = 0
    try {
      writeFileSync(
        join(dir, 'sleeper.cmd'),
        '@echo off\r\nnode -e "console.log(process.pid);setInterval(()=>{},1000)"\r\n',
      )
      const done = defaultRunner(join(dir, 'sleeper.cmd'), [], opts, (chunk) => {
        const m = chunk.match(/\d+/)
        if (m && !grandchildPid) grandchildPid = Number(m[0])
      })
      await waitUntil(() => grandchildPid > 0, 8000)
      expect(grandchildPid).toBeGreaterThan(0)
      expect(isAlive(grandchildPid)).toBe(true) // 손자 기동 확인

      afterStart?.() // 손자 기동 후 종료 트리거(abort). timeout 경로는 timeoutMs 경과로 자연 발화.
      const res = await done
      expect(res.spawnError).toBe(expectError)

      await waitUntil(() => !isAlive(grandchildPid), 5000)
      expect(isAlive(grandchildPid)).toBe(false) // 손자까지 종료됨
    } finally {
      if (grandchildPid && isAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid)
        } catch {
          /* 이미 종료 */
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('abort 시 .cmd 셰임이 띄운 손자(node)까지 종료한다', async () => {
    const ac = new AbortController()
    await expectTreeKilled({ timeoutMs: 30_000, signal: ac.signal }, 'ABORTED', () => ac.abort())
  }, 25_000)

  // overflow(ENOBUFS) 경로도 동일한 killTree(child) 를 호출한다(detect.ts) — abort/timeout 로 대표 커버.
  // timeoutMs 는 손자(node)의 cold-start + pid 출력보다 넉넉해야 한다 — 부하 걸린 windows CI 러너에서
  // 2s 면 timeout 이 pid 캡처 전에 발화해 false RED 가 날 수 있어 6s 로(25s 테스트 예산 내) 여유를 둔다.
  it('timeout 시에도 손자(node)까지 종료한다', async () => {
    await expectTreeKilled({ timeoutMs: 6000 }, 'ETIMEDOUT')
  }, 25_000)
})

describe.skipIf(process.platform === 'win32')('defaultRunner (취소 시 close 대기 — POSIX)', () => {
  // 회귀(코드 리뷰 P1): killTree 는 비동기(taskkill/SIGTERM)라 즉시 finish 하면 자식이 아직 살아
  // 워크스페이스를 쓰는 동안 호출자가 ABORTED 를 받고 revert 를 시작해 경합한다. abort 는 자식이
  // 실제로 close(트리 종료)된 뒤에 resolve 해야 한다 — SIGTERM 을 지연 처리하는 자식으로 경과시간 검증.
  it('abort 는 자식이 실제로 종료(close)된 뒤에야 ABORTED 로 resolve 한다', async () => {
    const script =
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));process.stdout.write('up');setInterval(()=>{},1000)"
    let up = false
    const ac = new AbortController()
    const p = defaultRunner(
      'node',
      ['-e', script],
      { timeoutMs: 30_000, signal: ac.signal },
      (c) => {
        if (c.includes('up')) up = true
      },
    )
    const start = Date.now()
    while (Date.now() - start < 5000 && !up) await new Promise((r) => setTimeout(r, 20))
    expect(up).toBe(true) // 자식 기동 확인

    const abortAt = Date.now()
    ac.abort()
    const res = await p
    expect(res.spawnError).toBe('ABORTED')
    // 자식이 SIGTERM 후 250ms 뒤 종료하므로, finish 가 close 를 기다렸다면 경과 ≥ ~180ms.
    expect(Date.now() - abortAt).toBeGreaterThanOrEqual(180)
  }, 15_000)
})

describe('createCliRegistry', () => {
  it('seeds with the default adapters', () => {
    const reg = createCliRegistry()
    expect(
      reg
        .list()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['claude', 'codex', 'gemini'])
  })

  it('allows registering a new CLI (extensibility)', () => {
    const reg = createCliRegistry()
    reg.register({
      id: 'cursor',
      displayName: 'Cursor CLI',
      command: 'cursor-agent',
      versionArgs: ['--version'],
    })
    expect(reg.get('cursor')?.command).toBe('cursor-agent')
    expect(reg.list()).toHaveLength(4)
  })

  // 회귀(gemini 침묵 버그): 긴 전사를 argv 로 넘기면 Windows 명령줄 한도에 걸린다(.cmd 셰임 cmd.exe ~8191자).
  // 기본 어댑터는 프롬프트를 stdin 으로 보내야 하며, 어떤 인자 템플릿에도 '{prompt}' 토큰이 남아 있으면 안 된다.
  it('default adapters send the prompt via stdin (no {prompt} token in any arg template)', () => {
    const promptTemplates = (a: (typeof DEFAULT_CLI_ADAPTERS)[number]): string[] => [
      ...(a.headless?.args ?? []),
      ...(a.session?.startArgs ?? []),
      ...(a.session?.resumeArgs ?? []),
      ...(a.streaming?.args ?? []),
      ...(a.edit?.args ?? []),
    ]
    for (const a of DEFAULT_CLI_ADAPTERS) {
      expect(a.promptVia).toBe('stdin')
      expect(promptTemplates(a)).not.toContain('{prompt}')
    }
  })
})
