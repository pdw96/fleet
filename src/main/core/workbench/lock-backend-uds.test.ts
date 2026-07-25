import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createAbstractSocketBackend } from './lock-backend-uds'
import { createLockScope, endpointFor, type LockBackend } from './locks'
import { newUlid } from './ulid'

/**
 * #251 PR1b — 실 추상 소켓 어댑터 계약(§3-T7·T8·T10·T10d·T22).
 *
 * **플랫폼 게이트는 `describe.skipIf` 만 쓴다.** `it` 본문 조기 `return` 형은 skip 이 아니라 **PASSED 로
 * 집계**되므로(레포 7건 선례) 「Linux 행이 실제로 skip 됐다」를 요약에서 확인할 수 없다.
 *
 * 이름은 **테스트마다 무작위화**한다 — 추상 네임스페이스는 net namespace **전역**이라 파일 순차 실행이
 * 아니라 이름 유일성이 올바른 격리 수단이다(§3.2 의 「mkdtemp 격리」는 pathname 시절 유물).
 *
 * 자식은 **`node -e` 인라인**이다(레포 유일 관용구 · §3-T8 문면과 일치 · `fork` 선례 0건).
 * ⚠ endpoint 는 선행 **NUL** 을 포함하므로 argv·env 로 그대로 넘길 수 없다(C 문자열이 NUL 에서 끊긴다) —
 * NUL 을 뗀 이름만 넘기고 자식이 다시 붙인다.
 */

const IS_LINUX = process.platform === 'linux'

const freshEndpoint = (): { endpoint: string; bare: string; digest: string } => {
  const digest = randomBytes(16).toString('hex')
  const ep = endpointFor(digest, { kind: 'repo' })
  if (ep.status !== 'ok') throw new Error('픽스처 오류')
  return { endpoint: ep.endpoint, bare: ep.endpoint.slice(1), digest }
}

const children: ChildProcess[] = []
const tmpDirs: string[] = []

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 자식을 띄우고 지정 토큰이 stdout 에 나올 때까지 기다린다(조기 종료는 reject — `web-server.ts` 규율). */
const spawnChild = (
  script: string,
  env: Record<string, string>,
  token: string,
): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    const onData = (d: Buffer): void => {
      out += d.toString()
      if (out.includes(token)) {
        child.stdout?.off('data', onData)
        resolve(child)
      }
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) =>
      reject(new Error(`자식이 토큰(${token}) 전에 종료: code=${code} out=${out}`)),
    )
  })

const readAll = (child: ChildProcess): Promise<string> =>
  new Promise((resolve) => {
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.once('exit', () => resolve(out))
  })

/** 락을 잡고 계속 살아 있는 자식. */
const HOLDER = `
const net = require('node:net')
const s = net.createServer()
s.on('error', (e) => { console.log('ERR ' + e.code); process.exit(1) })
s.listen({ path: '\\0' + process.env.FLEET_TEST_LOCK_NAME }, () => console.log('HELD'))
setInterval(() => {}, 3600000)
`

describe.skipIf(!IS_LINUX)('실 추상 소켓 어댑터 — 획득·판정(§W-3)', () => {
  const backend: LockBackend = createAbstractSocketBackend()

  it('bind 성공 = 획득 · 커널이 이름을 배타 할당한다', async () => {
    const { endpoint } = freshEndpoint()
    const r = await backend.bind(endpoint)
    expect(r.status).toBe('bound')
    if (r.status !== 'bound') return
    expect(r.endpoint.isBound()).toBe(true)
    r.endpoint.close()
  })

  it('같은 이름 재bind = in-use(EADDRINUSE → held)', async () => {
    const { endpoint } = freshEndpoint()
    const first = await backend.bind(endpoint)
    expect((await backend.bind(endpoint)).status).toBe('in-use')
    if (first.status === 'bound') first.endpoint.close()
  })

  // 커널 네임스페이스 거주의 **양성 증거**. `address()` 는 입력 에코라 증거가 되지 못한다(정정 ⑮).
  it('/proc/net/unix 에 `@<name>` 이 정확히 1행 등록된다', async () => {
    const { endpoint, bare } = freshEndpoint()
    const r = await backend.bind(endpoint)
    expect(r.status).toBe('bound')
    const { readFileSync } = await import('node:fs')
    const rows = readFileSync('/proc/net/unix', 'utf8')
      .split('\n')
      .filter((l) => l.endsWith(` @${bare}`))
    expect(rows).toHaveLength(1)
    if (r.status === 'bound') r.endpoint.close()
  })

  /**
   * EADDRINUSE 가 **아닌** 오류는 전부 `error`(→ 스코프 층 `unavailable`)로 매핑된다. 이 분기는 win32 에서
   * EINVAL 로도 밟히지만(아래 win32 describe) Linux 에서도 밟혀야 매핑이 플랫폼 무관임이 확인된다.
   * 실측 근거: 쓸 수 없는 디렉터리의 pathname 소켓 = `EACCES`(버전 무관).
   */
  it('EADDRINUSE 가 아닌 오류는 error 로 매핑된다(fail-closed · held 로 오분류 금지)', async () => {
    const r = await backend.bind('/proc/fleet-없는-경로/lock.sock')
    expect(r.status).toBe('error')
    if (r.status !== 'error') return
    expect(r.code).not.toBe('EADDRINUSE')
  })

  it('close() 직후 isBound 는 false 이고 같은 이름을 즉시 재획득할 수 있다', async () => {
    const { endpoint } = freshEndpoint()
    const first = await backend.bind(endpoint)
    if (first.status !== 'bound') throw new Error('픽스처 오류')
    first.endpoint.close()
    expect(first.endpoint.isBound()).toBe(false)
    const second = await backend.bind(endpoint)
    expect(second.status).toBe('bound')
    if (second.status === 'bound') second.endpoint.close()
  })

  /**
   * `release()`(=`close()`)가 `'close'` 이벤트를 기다리면 **영구 대기**한다 — 커넥션이 남아 있으면 그
   * 콜백이 발화하지 않기 때문이다(실측). 기다리는 구현이면 이 행이 타임아웃으로 RED.
   */
  it('커넥션이 유입된 상태에서도 해제가 즉시 끝난다', async () => {
    const { endpoint } = freshEndpoint()
    const r = await backend.bind(endpoint)
    if (r.status !== 'bound') throw new Error('픽스처 오류')
    await new Promise<void>((resolve, reject) => {
      const client = connect({ path: endpoint }, () => resolve())
      client.once('error', reject)
    })
    r.endpoint.close()
    expect(r.endpoint.isBound()).toBe(false)
    expect((await backend.bind(endpoint)).status).toBe('bound')
  })
})

describe.skipIf(!IS_LINUX)('§3-T7 — 커널 endpoint 는 삭제 대상이 아니다', () => {
  const backend = createAbstractSocketBackend()

  it('파일시스템에 아무 항목도 만들지 않는다(영역 파일 0개 증가)', async () => {
    const area = mkdtempSync(join(tmpdir(), 'fleet-251-lock-'))
    tmpDirs.push(area)
    writeFileSync(join(area, 'area.json'), '{}')
    const before = readdirSync(area).sort()
    const { endpoint } = freshEndpoint()
    const r = await backend.bind(endpoint)
    expect(r.status).toBe('bound')
    expect(readdirSync(area).sort()).toEqual(before)
    if (r.status === 'bound') r.endpoint.close()
  })

  /**
   * 스펙 §3-T7 의 **두 번째 절**(계획 문안에서 탈락했던 것 · 정정 ㉔): 「파일시스템 어디를 지워도 보유
   * 중인 락이 영향받지 않음」. 「파일 0개 증가」는 *쓰기* 를 잡고 이 행은 *읽기 의존* 을 잡는다 —
   * 보유·판정이 영역 파일 존재를 부수 조건으로 보는 구현은 다른 단언 전부를 통과한다.
   */
  it('영역 디렉터리를 전삭제해도 보유·판정·해제가 그대로다', async () => {
    const area = mkdtempSync(join(tmpdir(), 'fleet-251-lock-'))
    tmpDirs.push(area)
    writeFileSync(join(area, 'area.json'), '{}')

    const { digest } = freshEndpoint()
    const scope = createLockScope({ digest, backend })
    const benchId = newUlid()
    const repo = await scope.tryAcquire({ kind: 'repo' })
    const bench = await scope.tryAcquireBenchLease(benchId)
    const slot = await scope.tryAcquire({ kind: 'slot', index: 0 })
    if (repo.status !== 'acquired' || bench.status !== 'acquired' || slot.status !== 'acquired') {
      throw new Error('픽스처 오류')
    }

    rmSync(area, { recursive: true, force: true })

    // ⓐ 2차 획득은 여전히 held
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('held')
    // ⓑ 보유 핸들의 재검증은 여전히 owned
    expect(repo.handle.revalidate()).toEqual({ kind: 'owned' })
    expect(bench.lease.revalidate()).toEqual({ kind: 'owned' })
    // ⓒ 해제 후에는 재획득 성공
    repo.handle.release()
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('acquired')
    bench.handle.release()
    slot.handle.release()
  })
})

describe.skipIf(!IS_LINUX)('§3-T8·T10·T10d — 자동 해제와 회수(실 프로세스)', () => {
  const backend = createAbstractSocketBackend()

  /**
   * 회수 = **커널 배타성 단독**. 연령·pid·사용자 승인을 근거로 쓰지 않는다(L-1).
   * ⚠ **양성 통제 필수**(감사 ripple ③): SIGKILL 후 획득만 단언하면 「자식이 실제로 그 이름을 점유했다」가
   * 검증되지 않아 false-GREEN 이다 — kill **전에** `held` 를 먼저 단언한다.
   */
  it('자식이 락을 보유 → SIGKILL → 즉시 재획득(wx·mkdir·pid 구현이면 RED)', async () => {
    const { endpoint, bare } = freshEndpoint()
    const child = await spawnChild(HOLDER, { FLEET_TEST_LOCK_NAME: bare }, 'HELD')

    // 양성 통제 — 자식이 정말 점유 중임을 먼저 증명한다.
    expect((await backend.bind(endpoint)).status).toBe('in-use')

    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))

    const after = await backend.bind(endpoint)
    expect(after.status).toBe('bound')
    if (after.status === 'bound') after.endpoint.close()
  })

  /**
   * §3-T10d — A 가 보유 중인 동안 **어떤 파일시스템 조작으로도** B 가 획득할 수 없다.
   * pathname 소켓 구현이면 소켓 파일을 지우고 재bind 해 획득에 성공하므로 RED 다.
   */
  it('보유 중에는 파일시스템을 어떻게 조작해도 획득할 수 없다', async () => {
    const { endpoint, bare } = freshEndpoint()
    await spawnChild(HOLDER, { FLEET_TEST_LOCK_NAME: bare }, 'HELD')
    expect((await backend.bind(endpoint)).status).toBe('in-use')

    // pathname 소켓 구현이 뚫릴 만한 조작을 전부 시도한다: 같은 이름의 파일/디렉터리 생성·삭제.
    const area = mkdtempSync(join(tmpdir(), 'fleet-251-lock-'))
    tmpDirs.push(area)
    for (const candidate of [bare, `${bare}.s`, 's']) {
      const p = join(area, candidate.replace(/[^\w.-]/g, '_'))
      writeFileSync(p, '')
      rmSync(p, { force: true })
    }
    rmSync(area, { recursive: true, force: true })

    expect((await backend.bind(endpoint)).status).toBe('in-use')
  })
})

/**
 * §3-T22 — 실 프로세스 2개 배타성. **in-process Map 뮤텍스 구현으로는 통과 불가**한 것이 존재 이유다.
 */
describe.skipIf(!IS_LINUX)('§3-T22 — 프로세스 경계 배타성', () => {
  const backend = createAbstractSocketBackend()

  /**
   * 1순위는 **결정론 핸드셰이크**다(계획 정정 ㉘ · PR1a 의 「실 동시성 대신 결정론」 규율 승계):
   * 자식 보유 → 부모 `held` → 자식 해제 → 부모 획득. 커널을 전혀 쓰지 않는 구현(모듈 Map)은 자식이
   * 보유 중일 때 곧바로 획득에 성공하므로 이 행에서 RED 다.
   */
  it('결정론: 자식 보유 중 부모는 held · 자식이 놓으면 부모가 획득', async () => {
    const { endpoint, bare } = freshEndpoint()
    const script = `
const net = require('node:net')
const s = net.createServer()
s.on('error', (e) => { console.log('ERR ' + e.code); process.exit(1) })
s.listen({ path: '\\0' + process.env.FLEET_TEST_LOCK_NAME }, () => console.log('HELD'))
process.stdin.resume()
process.on('SIGTERM', () => { s.close(); console.log('RELEASED'); process.exit(0) })
setInterval(() => {}, 3600000)
`
    const child = await spawnChild(script, { FLEET_TEST_LOCK_NAME: bare }, 'HELD')
    expect((await backend.bind(endpoint)).status).toBe('in-use')

    child.kill('SIGTERM')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))

    const got = await backend.bind(endpoint)
    expect(got.status).toBe('bound')
    if (got.status === 'bound') got.endpoint.close()
  })

  /**
   * 2순위는 **배리어 동시 경쟁**이다 — 「둘 다 성공하는 창이 없다」를 본다. 우연 의존을 피하기 위해
   * **자기검사를 먼저** 만족시킨다(§6 R6 패턴): 자식이 `WAITING` 을 낸 시점에 배리어 파일은 아직 없으므로,
   * 부모가 배리어를 만든 뒤에야 자식이 진행했음이 관측으로 확정된다.
   */
  it('배리어 동시 경쟁: 정확히 한쪽만 획득한다(자기검사 포함)', async () => {
    const { endpoint, bare } = freshEndpoint()
    const dir = mkdtempSync(join(tmpdir(), 'fleet-251-barrier-'))
    tmpDirs.push(dir)
    const barrier = join(dir, 'go')

    const script = `
const net = require('node:net')
const fs = require('node:fs')
console.log('WAITING')
const spin = () => {
  if (!fs.existsSync(process.env.FLEET_TEST_BARRIER)) { setImmediate(spin); return }
  const s = net.createServer()
  s.on('error', (e) => { console.log('RESULT BUSY ' + e.code); process.exit(0) })
  s.listen({ path: '\\0' + process.env.FLEET_TEST_LOCK_NAME }, () => { console.log('RESULT GOT'); process.exit(0) })
}
spin()
`
    const child = await spawnChild(
      script,
      { FLEET_TEST_LOCK_NAME: bare, FLEET_TEST_BARRIER: barrier },
      'WAITING',
    )
    // 자기검사: 이 시점에 배리어가 없다 = 자식은 아직 bind 를 시도하지 않았다.
    expect(readdirSync(dir)).toEqual([])

    const childResult = readAll(child)
    // 배리어 = **존재만** 신호다(내용이 없으므로 부분 파일 노출 위험이 없어 `wx` 로 충분하다).
    openSync(barrier, 'wx')
    const mine = await backend.bind(endpoint)
    const out = await childResult

    const parentGot = mine.status === 'bound'
    const childGot = out.includes('RESULT GOT')
    expect(out).toMatch(/RESULT (GOT|BUSY)/)
    // XOR — 둘 다 성공하면 이중 소유, 둘 다 실패하면 유령 점유다.
    expect(parentGot !== childGot).toBe(true)
    if (mine.status === 'bound') mine.endpoint.close()
  })
})

/**
 * win32 는 추상 네임스페이스가 없다. 이 행이 중요한 이유: 만약 `listen('\0x')` 이 **파일 이름 `\0x`
 * 로 취급되어 조용히 성공**한다면 win32 에서 락이 「성공하지만 배타성 없음」이 된다. 실측은 EINVAL 이고,
 * 어댑터는 그것을 `error`(=`unavailable` · fail-closed)로 매핑한다.
 */
describe.skipIf(process.platform !== 'win32')('win32 — 조용한 성공 없이 fail-closed', () => {
  it('추상 이름 bind 는 EINVAL 로 실패한다(파일 생성 0)', async () => {
    const { endpoint } = freshEndpoint()
    const r = await createAbstractSocketBackend().bind(endpoint)
    expect(r.status).toBe('error')
    if (r.status !== 'error') return
    expect(r.code).toBe('EINVAL')
  })

  it('스코프 층에서는 unavailable 로 관측된다(모호는 fail-closed)', async () => {
    const digest = randomBytes(16).toString('hex')
    const scope = createLockScope({ digest, backend: createAbstractSocketBackend() })
    expect((await scope.tryAcquire({ kind: 'repo' })).status).toBe('unavailable')
  })
})
