import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { SENSITIVE_FILE } from '../safety/approval'
import type { FleetTool } from './types'

const MAX_FILE_BYTES = 256 * 1024
const MAX_GREP_FILES = 2000
const MAX_GREP_MATCHES = 200
const MAX_GLOB_RESULTS = 500
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'coverage'])

/** 입력 경로를 root 내부로 격리한다. realpath 로 심볼릭 링크 탈출까지 차단. 밖이면 throw. */
async function resolveWithin(root: string, p: string): Promise<string> {
  const rootReal = await fs.realpath(root)
  const abs = path.resolve(rootReal, p)
  let real: string
  try {
    real = await fs.realpath(abs) // 존재하면 심볼릭 해소
  } catch {
    real = abs // 미존재(곧 ENOENT) — 정규화 경로로 컨테인먼트만 검사
  }
  const rel = path.relative(rootReal, real)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return real
  throw new Error(`경로가 워크스페이스 밖입니다: ${p}`)
}

/**
 * root 하위 파일을 재귀 순회(스킵 디렉터리 제외).
 * 심볼릭 링크는 건너뛴다 — readdir(withFileTypes) 의 Dirent.isFile()/isDirectory() 는 심볼릭 링크에
 * false 를 반환하므로 링크 파일은 yield 되지 않고 링크 디렉터리는 재귀하지 않는다(샌드박스 보장).
 * 이 가정에 grep/glob 의 격리가 의존하므로 walk 를 symlink-follow 로 바꾸면 격리를 재점검할 것.
 */
async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full)
    } else if (e.isFile()) {
      yield full
    }
  }
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function readFileTool(root: string): FleetTool {
  return {
    definition: {
      name: 'read_file',
      description: '워크스페이스 내 텍스트 파일을 읽는다. path 는 워크스페이스 루트 기준 상대경로.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '워크스페이스 루트 기준 파일 경로' } },
        required: ['path'],
      },
    },
    classify(input) {
      const p = asStr((input as { path?: unknown })?.path) ?? ''
      return SENSITIVE_FILE.test(p) ? 'destructive' : 'safe'
    },
    async execute(input) {
      const p = asStr((input as { path?: unknown })?.path)
      if (!p) throw new Error('read_file: path 인자가 필요합니다.')
      const abs = await resolveWithin(root, p)
      const stat = await fs.stat(abs)
      if (!stat.isFile()) throw new Error(`read_file: 파일이 아닙니다: ${p}`)
      const buf = await fs.readFile(abs)
      if (buf.byteLength > MAX_FILE_BYTES) {
        return `${buf.subarray(0, MAX_FILE_BYTES).toString('utf8')}\n…(${buf.byteLength}바이트 중 ${MAX_FILE_BYTES}바이트만 표시)`
      }
      return buf.toString('utf8')
    },
  }
}

function listDirectoryTool(root: string): FleetTool {
  return {
    definition: {
      name: 'list_directory',
      description: '워크스페이스 내 디렉터리 항목을 나열한다(path 생략 시 루트). 디렉터리는 / 접미사.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '워크스페이스 루트 기준 디렉터리 경로(생략 시 루트)' } },
      },
    },
    classify: () => 'safe',
    async execute(input) {
      const p = asStr((input as { path?: unknown })?.path) ?? '.'
      const abs = await resolveWithin(root, p)
      const entries = await fs.readdir(abs, { withFileTypes: true })
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
      return lines.length ? lines.join('\n') : '(빈 디렉터리)'
    },
  }
}

function grepTool(root: string): FleetTool {
  return {
    definition: {
      name: 'grep',
      description: '워크스페이스 내 파일 내용을 정규식으로 검색한다. 결과는 "상대경로:줄번호:내용".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '검색할 JS 정규식' },
          path: { type: 'string', description: '검색 시작 디렉터리(생략 시 루트)' },
        },
        required: ['pattern'],
      },
    },
    classify: () => 'safe',
    async execute(input) {
      const pattern = asStr((input as { pattern?: unknown })?.pattern)
      if (!pattern) throw new Error('grep: pattern 인자가 필요합니다.')
      if (pattern.length > 200) throw new Error('grep: pattern 이 너무 깁니다(최대 200자).')
      let re: RegExp
      try {
        re = new RegExp(pattern) // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- 패턴 작성자는 오케스트레이션 모델(준신뢰), 대상은 사용자 워크스페이스 파일. 길이 200자 제한 + 스캔/매치 바운드로 ReDoS 영향 한정.
      } catch (err) {
        throw new Error(`grep: 잘못된 정규식: ${err instanceof Error ? err.message : String(err)}`)
      }
      const rootReal = await fs.realpath(root)
      const start = await resolveWithin(root, asStr((input as { path?: unknown })?.path) ?? '.')
      const out: string[] = []
      let scanned = 0
      for await (const file of walk(start)) {
        if (scanned >= MAX_GREP_FILES || out.length >= MAX_GREP_MATCHES) break
        const rel = path.relative(rootReal, file).split(path.sep).join('/')
        scanned++ // 민감파일 스킵도 스캔 한도에 포함(다수 민감파일로 한도 우회 방지)
        if (SENSITIVE_FILE.test(rel)) continue // 민감파일 제외
        let content: string
        try {
          const buf = await fs.readFile(file)
          if (buf.byteLength > MAX_FILE_BYTES) continue // 대형/바이너리 추정 스킵
          content = buf.toString('utf8')
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && out.length < MAX_GREP_MATCHES; i++) {
          if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`)
        }
      }
      return out.length ? out.join('\n') : '(일치 없음)'
    },
  }
}

/**
 * 글롭 패턴을 세그먼트 배열로 파싱한다.
 * 각 세그먼트는 일반 문자(literal), 단일 와일드카드(*), 임의 깊이(**)를 나타낸다.
 */
type GlobSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'star' } // * — 슬래시 제외
  | { kind: 'starstar' } // ** — 모든 경로
  | { kind: 'question' } // ? — 한 글자(슬래시 제외)

function parseGlob(glob: string): GlobSegment[] {
  const segments: GlobSegment[] = []
  let i = 0
  let lit = ''
  const flushLit = () => {
    if (lit) {
      segments.push({ kind: 'literal', value: lit })
      lit = ''
    }
  }
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      flushLit()
      segments.push({ kind: 'starstar' })
      i += 2
      if (glob[i] === '/') i++ // **/ — 슬래시 소비
    } else if (c === '*') {
      flushLit()
      segments.push({ kind: 'star' })
      i++
    } else if (c === '?') {
      flushLit()
      segments.push({ kind: 'question' })
      i++
    } else {
      // 정규식 특수문자를 리터럴로 보존(glob 이스케이프 불필요 — 직접 비교)
      lit += c
      i++
    }
  }
  flushLit()
  return segments
}

/**
 * 글롭 세그먼트 배열로 경로 문자열을 매칭한다(재귀).
 * new RegExp 를 전혀 사용하지 않아 semgrep "non-literal RegExp" 경고가 없다.
 */
function globMatchSegments(segs: GlobSegment[], si: number, str: string, ci: number): boolean {
  // 세그먼트 소진
  if (si === segs.length) return ci === str.length

  const seg = segs[si]

  if (seg.kind === 'literal') {
    const v = seg.value
    if (str.startsWith(v, ci)) return globMatchSegments(segs, si + 1, str, ci + v.length)
    return false
  }

  if (seg.kind === 'question') {
    if (ci >= str.length || str[ci] === '/') return false
    return globMatchSegments(segs, si + 1, str, ci + 1)
  }

  if (seg.kind === 'star') {
    // * 는 슬래시를 넘을 수 없음 — 현재 세그먼트 내에서만 탐색
    for (let j = ci; j <= str.length; j++) {
      if (j > ci && str[j - 1] === '/') break // 슬래시 직전까지만
      if (globMatchSegments(segs, si + 1, str, j)) return true
    }
    return false
  }

  // starstar: 0개 이상의 경로 컴포넌트를 건너뜀
  // 남은 패턴이 현재 위치부터 맞는지 먼저 시도하고, 다음 '/' 이후로 점프 반복
  if (seg.kind === 'starstar') {
    // ** : 0개 이상의 임의 문자(슬래시 포함)를 건너뛴다. 현재 위치부터 끝까지 모든 분기를 시도해
    // bare '**'(전체 매칭)와 '**/x'(선택적 디렉터리) 양쪽을 올바르게 처리한다.
    for (let j = ci; j <= str.length; j++) {
      if (globMatchSegments(segs, si + 1, str, j)) return true
    }
    return false
  }

  return false
}

/** 글롭 패턴으로 상대경로를 매칭한다. new RegExp 를 사용하지 않는다. */
function globMatch(pattern: string, relPath: string): boolean {
  const segs = parseGlob(pattern)
  return globMatchSegments(segs, 0, relPath, 0)
}

function globTool(root: string): FleetTool {
  return {
    definition: {
      name: 'glob',
      description: '워크스페이스 내 파일을 글롭 패턴으로 찾는다(예: **/*.ts). 상대경로 목록 반환.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: '글롭 패턴(*, **, ? 지원)' } },
        required: ['pattern'],
      },
    },
    classify: () => 'safe',
    async execute(input) {
      const pattern = asStr((input as { pattern?: unknown })?.pattern)
      if (!pattern) throw new Error('glob: pattern 인자가 필요합니다.')
      const rootReal = await fs.realpath(root)
      const out: string[] = []
      for await (const file of walk(rootReal)) {
        if (out.length >= MAX_GLOB_RESULTS) break
        const rel = path.relative(rootReal, file).split(path.sep).join('/')
        if (SENSITIVE_FILE.test(rel)) continue
        if (globMatch(pattern, rel)) out.push(rel)
      }
      return out.length ? out.sort().join('\n') : '(일치 없음)'
    },
  }
}

/** 워크스페이스 루트(root)를 기준으로 한 읽기전용 도구 세트. 모두 root 내부로 격리된다. */
export function createWorkspaceReadTools(root: string): FleetTool[] {
  return [readFileTool(root), listDirectoryTool(root), grepTool(root), globTool(root)]
}
