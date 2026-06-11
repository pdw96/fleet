import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import spawn from 'cross-spawn'
import { killTree, type KillableChild, type KillSpawnFn } from './kill-tree'

/** kill 횟수를 세는 fake 자식. */
function fakeChild(pid?: number) {
  let killed = 0
  const child: KillableChild = {
    pid,
    kill: () => {
      killed += 1
      return true
    },
  }
  return { child, killed: () => killed }
}

/** taskkill spawn 호출을 캡처하는 fake spawn. */
function fakeSpawn() {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
  let errorHandler: ((err: Error) => void) | undefined
  const spawnFn: KillSpawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    return {
      on: (_event, handler) => {
        errorHandler = handler
        return undefined
      },
      unref: () => {},
    }
  }
  return { spawnFn, calls, fireError: () => errorHandler?.(new Error('taskkill 없음')) }
}

describe('killTree', () => {
  it('win32 에서는 taskkill /pid <pid> /T /F 로 트리 전체를 죽인다(셰임만 죽이는 child.kill 우회)', () => {
    const { child, killed } = fakeChild(4242)
    const s = fakeSpawn()
    killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].command).toBe('taskkill')
    expect(s.calls[0].args).toEqual(['/pid', '4242', '/T', '/F'])
    // taskkill 이 트리를 죽이므로 셰임 child.kill 은 호출하지 않는다.
    expect(killed()).toBe(0)
  })

  it('win32 에서 taskkill spawn 자체가 실패하면 child.kill 로 폴백한다', () => {
    const { child, killed } = fakeChild(4242)
    const s = fakeSpawn()
    killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(killed()).toBe(0)
    s.fireError()
    expect(killed()).toBe(1)
  })

  it('win32 에서 pid 가 없으면(spawn 실패) taskkill 없이 child.kill 만 한다', () => {
    const { child, killed } = fakeChild(undefined)
    const s = fakeSpawn()
    killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(s.calls).toHaveLength(0)
    expect(killed()).toBe(1)
  })

  it('POSIX 에서는 셰임 경유가 없어 child.kill 로 충분하다(taskkill 미사용)', () => {
    const { child, killed } = fakeChild(4242)
    const s = fakeSpawn()
    killTree(child, { platform: 'linux', spawnFn: s.spawnFn })
    expect(s.calls).toHaveLength(0)
    expect(killed()).toBe(1)
  })

  it('win32 taskkill 은 windowsHide + stdio ignore 로 조용히 띄운다', () => {
    const { child } = fakeChild(7)
    const s = fakeSpawn()
    killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(s.calls[0].options).toMatchObject({ windowsHide: true, stdio: 'ignore' })
  })
})

// 회귀(이 버그의 본질): cross-spawn 은 .cmd 셰임을 cmd.exe 경유로 띄우므로 child.kill() 은
// cmd.exe 껍데기만 죽이고 실제 CLI(node.exe 손자)는 살아남는다. killTree 는 손자까지 종료해야 한다.
// CI(ubuntu)에서는 taskkill 부재로 skip — Windows 개발 머신에서만 실행된다.
/** pid 가 살아있는지(signal 0 = 존재 검사). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms && !pred()) await new Promise((r) => setTimeout(r, 50))
}

describe.skipIf(process.platform !== 'win32')('killTree (Windows 프로세스 트리 통합)', () => {
  it('.cmd 셰임을 통해 띄운 손자(node) 프로세스까지 종료한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-killtree-'))
    // 손자 정리는 finally 에서 — 어서션이 (RED 처럼) 실패해도 불멸 node 좀비를 남기지 않는다.
    let grandchildPid = 0
    try {
      // 셰임(cmd.exe) → node 손자: 손자가 자기 pid 를 stdout 으로 알린 뒤 무한 대기한다.
      writeFileSync(
        join(dir, 'sleeper.cmd'),
        '@echo off\r\nnode -e "console.log(process.pid);setInterval(()=>{},1000)"\r\n',
      )
      // cross-spawn 은 명령을 PATH 로 해석하므로(cwd 아님) 셰임은 절대경로로 띄운다.
      const child = spawn(join(dir, 'sleeper.cmd'), [], { windowsHide: true })
      await new Promise<void>((resolve, reject) => {
        let buf = ''
        const t = setTimeout(() => reject(new Error('손자 pid 미수신')), 8000)
        child.stdout?.on('data', (c: Buffer) => {
          buf += c.toString()
          const m = buf.match(/\d+/)
          if (m) {
            grandchildPid = Number(m[0])
            clearTimeout(t)
            resolve()
          }
        })
        child.on('error', reject)
      })
      expect(isAlive(grandchildPid)).toBe(true)

      killTree(child)

      await waitUntil(() => !isAlive(grandchildPid), 5000)
      expect(isAlive(grandchildPid)).toBe(false)
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
  }, 20_000)
})
