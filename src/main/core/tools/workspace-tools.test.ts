import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceReadTools } from './workspace-tools'
import type { FleetTool } from './types'

let root: string
const pick = (tools: FleetTool[], name: string): FleetTool => {
  const t = tools.find((x) => x.definition.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-ws-'))
  await fs.writeFile(path.join(root, 'a.txt'), 'hello world\nsecond line')
  await fs.mkdir(path.join(root, 'sub'))
  await fs.writeFile(path.join(root, 'sub', 'b.ts'), 'export const x = 1')
  await fs.writeFile(path.join(root, '.env'), 'SECRET=123')
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('createWorkspaceReadTools', () => {
  it('exposes read_file/list_directory/grep/glob', () => {
    expect(createWorkspaceReadTools(root).map((t) => t.definition.name).sort()).toEqual([
      'glob',
      'grep',
      'list_directory',
      'read_file',
    ])
  })

  it('read_file 은 워크스페이스 내 파일을 읽는다', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'read_file').execute({ path: 'a.txt' }, {})
    expect(out).toContain('hello world')
  })

  it('list_directory 는 항목 수가 한도를 넘으면 절단 마커를 붙인다', async () => {
    const out = await pick(createWorkspaceReadTools(root, { maxDirEntries: 2 }), 'list_directory').execute({ path: '.' }, {})
    expect(out).toContain('목록 불완전')
  })

  it('grep 은 매치 한도 도달 시 불완전 마커를 붙인다', async () => {
    const out = await pick(createWorkspaceReadTools(root, { maxGrepMatches: 1 }), 'grep').execute({ pattern: 'e' }, {})
    expect(out).toContain('결과 불완전')
  })

  it('glob 은 스캔 한도 도달 시 불완전 마커를 붙인다', async () => {
    const out = await pick(createWorkspaceReadTools(root, { maxGlobScan: 1 }), 'glob').execute({ pattern: '**/*' }, {})
    expect(out).toContain('불완전')
  })

  it('read_file 은 워크스페이스 밖 경로를 거부한다(경로 탈출)', async () => {
    await expect(
      pick(createWorkspaceReadTools(root), 'read_file').execute({ path: '../../etc/hosts' }, {}),
    ).rejects.toThrow(/워크스페이스 밖/)
  })

  it('민감 파일 read 는 destructive, 일반 파일은 safe 로 분류된다', () => {
    const tool = pick(createWorkspaceReadTools(root), 'read_file')
    expect(tool.classify({ path: '.env' })).toBe('destructive')
    expect(tool.classify({ path: 'a.txt' })).toBe('safe')
  })

  it('list_directory 는 항목을 나열한다(디렉터리는 / 접미사)', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'list_directory').execute({ path: '.' }, {})
    expect(out).toContain('a.txt')
    expect(out).toContain('sub/')
  })

  it('grep 은 내용을 검색하고 민감파일을 제외한다', async () => {
    const tool = pick(createWorkspaceReadTools(root), 'grep')
    expect(await tool.execute({ pattern: 'hello' }, {})).toContain('a.txt:1:')
    expect(await tool.execute({ pattern: 'SECRET' }, {})).toBe('(일치 없음)')
  })

  it('glob 은 패턴으로 파일을 찾는다', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'glob').execute({ pattern: '**/*.ts' }, {})
    expect(out).toContain('sub/b.ts')
  })

  it('glob 은 민감 파일을 결과에서 제외한다', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'glob').execute({ pattern: '**' }, {})
    expect(out).toContain('a.txt')
    expect(out).not.toContain('.env')
  })

  it('list_directory 는 워크스페이스 밖 경로를 거부한다(경로 탈출)', async () => {
    await expect(
      pick(createWorkspaceReadTools(root), 'list_directory').execute({ path: '../..' }, {}),
    ).rejects.toThrow(/워크스페이스 밖/)
  })

  it('심볼릭 링크가 민감 파일을 가리키면 read_file 을 destructive 로 분류한다(자동승인 우회 방지)', async () => {
    try {
      await fs.symlink(path.join(root, '.env'), path.join(root, 'config.txt'))
    } catch {
      return // 심볼릭 링크 생성 권한 없음(Windows 비관리자) → 스킵
    }
    expect(pick(createWorkspaceReadTools(root), 'read_file').classify({ path: 'config.txt' })).toBe('destructive')
  })

  it('read_file 은 대형 파일을 전체 적재 없이 앞부분만 반환한다', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(300 * 1024))
    const out = await pick(createWorkspaceReadTools(root), 'read_file').execute({ path: 'big.txt' }, {})
    expect(out).toContain('바이트만 표시)')
    expect(out.length).toBeLessThan(300 * 1024)
  })

  it('grep 은 대형 파일을 읽기 전에 건너뛴다', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), 'NEEDLE'.padEnd(300 * 1024, '_'))
    const out = await pick(createWorkspaceReadTools(root), 'grep').execute({ pattern: 'NEEDLE' }, {})
    expect(out).toBe('(일치 없음)') // 대형 파일은 스캔 제외
  })

  it('grep 은 파국적 백트래킹 패턴(ReDoS)을 거부한다', async () => {
    await expect(
      pick(createWorkspaceReadTools(root), 'grep').execute({ pattern: '(a+)+$' }, {}),
    ).rejects.toThrow(/ReDoS|백트래킹/)
  })

  it('심볼릭 링크로 워크스페이스를 벗어나는 읽기를 차단한다', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-out-'))
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret')
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    } catch {
      return // 심볼릭 링크 생성 권한 없음(Windows 비관리자) → 스킵
    }
    await expect(
      pick(createWorkspaceReadTools(root), 'read_file').execute({ path: 'link.txt' }, {}),
    ).rejects.toThrow(/워크스페이스 밖/)
    await fs.rm(outside, { recursive: true, force: true })
  })
})
