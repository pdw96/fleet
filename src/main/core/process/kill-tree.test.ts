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

/** taskkill spawn 호출을 캡처하고 이벤트를 발사하는 fake spawn. */
function fakeSpawn() {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = []
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  const spawnFn: KillSpawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    return {
      on: (event, handler) => {
        handlers[event] = handler as (...a: unknown[]) => void
        return undefined
      },
      unref: () => {},
    }
  }
  return { spawnFn, calls, fire: (event: string) => handlers[event]?.() }
}

describe('killTree', () => {
  it('win32 에서는 시스템 taskkill 절대경로로 /pid <pid> /T /F 트리 전체를 죽인다', async () => {
    const { child, killed } = fakeChild(4242)
    const s = fakeSpawn()
    const p = killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(s.calls).toHaveLength(1)
    // bare 'taskkill' 가 아니라 System32 절대경로여야 한다(workspace cwd/PATH 하이재킹 차단).
    expect(s.calls[0].command.toLowerCase()).toContain('system32')
    expect(s.calls[0].command.toLowerCase()).toContain('taskkill.exe')
    expect(s.calls[0].args).toEqual(['/pid', '4242', '/T', '/F'])
    expect(killed()).toBe(0) // taskkill 이 트리를 죽이므로 셰임 child.kill 은 안 한다
    s.fire('exit')
    await expect(p).resolves.toBeUndefined()
  })

  it('win32 반환 Promise 는 taskkill 이 종료(=트리 force-kill 완료)한 뒤에야 resolve 한다', async () => {
    const { child } = fakeChild(7)
    const s = fakeSpawn()
    let resolved = false
    void killTree(child, { platform: 'win32', spawnFn: s.spawnFn }).then(() => {
      resolved = true
    })
    await Promise.resolve() // 마이크로태스크 flush
    expect(resolved).toBe(false) // taskkill 미종료 → 아직 resolve 안 함(호출자가 트리 종료를 기다릴 수 있게)
    s.fire('exit')
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  it('win32 에서 taskkill spawn 자체가 실패하면 child.kill 로 폴백하고 resolve 한다', async () => {
    const { child, killed } = fakeChild(4242)
    const s = fakeSpawn()
    const p = killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(killed()).toBe(0)
    s.fire('error')
    await p
    expect(killed()).toBe(1)
  })

  it('win32 에서 pid 가 없으면(spawn 실패) taskkill 없이 child.kill 만 하고 즉시 resolve 한다', async () => {
    const { child, killed } = fakeChild(undefined)
    const s = fakeSpawn()
    await killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
    expect(s.calls).toHaveLength(0)
    expect(killed()).toBe(1)
  })

  it('POSIX 에서는 셰임 경유가 없어 child.kill 로 충분하고 즉시 resolve 한다(taskkill 미사용)', async () => {
    const { child, killed } = fakeChild(4242)
    const s = fakeSpawn()
    await killTree(child, { platform: 'linux', spawnFn: s.spawnFn })
    expect(s.calls).toHaveLength(0)
    expect(killed()).toBe(1)
  })

  it('win32 taskkill 은 windowsHide + stdio ignore 로 조용히 띄운다', () => {
    const { child } = fakeChild(7)
    const s = fakeSpawn()
    void killTree(child, { platform: 'win32', spawnFn: s.spawnFn })
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

      await killTree(child) // taskkill 종료(=트리 force-kill 완료)까지 대기

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
