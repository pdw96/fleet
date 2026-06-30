import { createHash } from 'node:crypto'
import { promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

type SnapEntry = {
  rel: string
  kind: 'file' | 'dir' | 'symlink'
  size?: number
  hash?: string
  link?: string
}
// 워크스페이스 트리 스냅샷(경로·타입·크기·content hash·symlink 대상). mode 는 Windows flaky 라 제외.
async function snapshotTree(dirRoot: string): Promise<SnapEntry[]> {
  const out: SnapEntry[] = []
  async function walk(dir: string): Promise<void> {
    const dirents = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const d of dirents) {
      const full = path.join(dir, d.name)
      const rel = path.relative(dirRoot, full).split(path.sep).join('/')
      if (d.isSymbolicLink()) {
        out.push({ rel, kind: 'symlink', link: await fs.readlink(full) })
      } else if (d.isDirectory()) {
        out.push({ rel, kind: 'dir' })
        await walk(full)
      } else if (d.isFile()) {
        const buf = await fs.readFile(full)
        out.push({
          rel,
          kind: 'file',
          size: buf.length,
          hash: createHash('sha256').update(buf).digest('hex'),
        })
      }
    }
  }
  await walk(dirRoot)
  return out
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
    expect(
      createWorkspaceReadTools(root)
        .map((t) => t.definition.name)
        .sort(),
    ).toEqual(['glob', 'grep', 'list_directory', 'read_file'])
  })

  it('read_file 은 워크스페이스 내 파일을 읽는다', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'read_file').execute(
      { path: 'a.txt' },
      {},
    )
    expect(out).toContain('hello world')
  })

  it('list_directory 는 항목 수가 한도를 넘으면 절단 마커를 붙인다', async () => {
    const out = await pick(
      createWorkspaceReadTools(root, { maxDirEntries: 2 }),
      'list_directory',
    ).execute({ path: '.' }, {})
    expect(out).toContain('목록 불완전')
  })

  it('grep 은 매치 한도 도달 시 불완전 마커를 붙인다', async () => {
    const out = await pick(createWorkspaceReadTools(root, { maxGrepMatches: 1 }), 'grep').execute(
      { pattern: 'e' },
      {},
    )
    expect(out).toContain('결과 불완전')
  })

  it('glob 은 스캔 한도 도달 시 불완전 마커를 붙인다', async () => {
    const out = await pick(createWorkspaceReadTools(root, { maxGlobScan: 1 }), 'glob').execute(
      { pattern: '**/*' },
      {},
    )
    expect(out).toContain('불완전')
  })

  it('glob 은 다중 ** 패턴을 메모이제이션으로 정확히 매칭한다', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'glob').execute(
      { pattern: '**/**/b.ts' },
      {},
    )
    expect(out).toContain('sub/b.ts')
  })

  it('grep 은 취소 신호가 켜져 있으면 즉시 중단한다', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      pick(createWorkspaceReadTools(root), 'grep').execute(
        { pattern: 'hello' },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(/취소/)
  })

  it('glob 은 취소 신호가 켜져 있으면 즉시 중단한다', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      pick(createWorkspaceReadTools(root), 'glob').execute(
        { pattern: '**/*' },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(/취소/)
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
    const out = await pick(createWorkspaceReadTools(root), 'list_directory').execute(
      { path: '.' },
      {},
    )
    expect(out).toContain('a.txt')
    expect(out).toContain('sub/')
  })

  it('grep 은 내용을 검색하고 민감파일을 제외한다', async () => {
    const tool = pick(createWorkspaceReadTools(root), 'grep')
    expect(await tool.execute({ pattern: 'hello' }, {})).toContain('a.txt:1:')
    expect(await tool.execute({ pattern: 'SECRET' }, {})).toBe('(일치 없음)')
  })

  it('glob 은 패턴으로 파일을 찾는다', async () => {
    const out = await pick(createWorkspaceReadTools(root), 'glob').execute(
      { pattern: '**/*.ts' },
      {},
    )
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
    expect(pick(createWorkspaceReadTools(root), 'read_file').classify({ path: 'config.txt' })).toBe(
      'destructive',
    )
  })

  it('[#128-B2] resolveWithin 통일 — "..foo" 정상 파일 읽기 가능(오거부 회귀 방지)', async () => {
    // root 는 기존 테스트 헬퍼가 만든 임시 워크스페이스 사용
    writeFileSync(join(root, '..foo'), 'hello')
    const tools = createWorkspaceReadTools(root)
    const readFileTool = tools.find((t) => t.definition.name === 'read_file')!
    const out = await readFileTool.execute({ path: '..foo' }, { signal: undefined } as never)
    expect(out).toBe('hello')
  })

  it('read_file 은 대형 파일을 전체 적재 없이 앞부분만 반환한다', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(300 * 1024))
    const out = await pick(createWorkspaceReadTools(root), 'read_file').execute(
      { path: 'big.txt' },
      {},
    )
    expect(out).toContain('바이트만 표시)')
    expect(out.length).toBeLessThan(300 * 1024)
  })

  it('grep 은 대형 파일을 읽기 전에 건너뛴다', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), 'NEEDLE'.padEnd(300 * 1024, '_'))
    const out = await pick(createWorkspaceReadTools(root), 'grep').execute(
      { pattern: 'NEEDLE' },
      {},
    )
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

// #174 행동 계약: ApprovalGate 는 tool.classify() 자가신고만 신뢰하므로(loop.ts:171), read 도구가
// 실행 중 워크스페이스를 변경하면 무프롬프트 통과가 된다. 등록 도구 전체가 read-only 임을 스냅샷
// 불변으로 단언 — 3a eslint 가드(raw fs 변형 차단)의 행동 보완 레이어(대체 아님).
describe('워크스페이스 read 도구 read-only 행동 계약 (#174)', () => {
  it('등록 도구 실행은 워크스페이스를 변경하지 않는다(스냅샷 불변)', async () => {
    const before = await snapshotTree(root)
    const tools = createWorkspaceReadTools(root)
    const inputs: Record<string, unknown> = {
      read_file: { path: 'a.txt' },
      list_directory: { path: '.' },
      grep: { pattern: 'x' },
      glob: { pattern: '**/*' },
    }
    // fail-fast: 신규/개명 도구가 fixture 없이 추가되면 `{}` fallback+swallow 로 실 코드경로를 안 타
    // false-green 이 된다(이 가드가 잡으려는 미래-도구 케이스 자체). 도구명 집합 == fixture 키 집합 단언.
    expect(new Set(tools.map((t) => t.definition.name))).toEqual(new Set(Object.keys(inputs)))
    const ac = new AbortController()
    for (const t of tools) {
      // 입력은 위 단언으로 보장됨. 실행 에러(예: 한도/패턴)는 무시 — 검증 대상은 변형 부재.
      await t.execute(inputs[t.definition.name], { signal: ac.signal }).catch(() => undefined)
    }
    const after = await snapshotTree(root)
    expect(after).toEqual(before)
  })
})
