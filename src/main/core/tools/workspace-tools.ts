import { promises as fs, realpathSync } from 'node:fs'
import * as path from 'node:path'
import safe from 'safe-regex'
import { SENSITIVE_FILE } from '../safety/approval'
import type { FleetTool } from './types'

const MAX_FILE_BYTES = 256 * 1024
const MAX_GREP_FILES = 2000
const MAX_GREP_MATCHES = 200
const MAX_GLOB_RESULTS = 500
const MAX_GLOB_SCAN = 20000
const MAX_DIR_ENTRIES = 1000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'coverage'])

/** 워크스페이스 도구의 자원/출력 한도. 미지정 시 기본값을 쓴다(테스트에서 작은 값 주입 가능). */
export interface WorkspaceToolLimits {
  maxFileBytes?: number
  maxGrepFiles?: number
  maxGrepMatches?: number
  maxGlobResults?: number
  maxGlobScan?: number
  maxDirEntries?: number
}
type ResolvedLimits = Required<WorkspaceToolLimits>

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
 * opendir 스트리밍으로 디렉터리당 메모리를 O(1)로 바운드한다 — readdir 는 거대 디렉터리(수십만 엔트리)
 * 전체를 한 번에 적재해 스캔 캡 적용 전에 메모리 스파이크를 낼 수 있다. for await 종료/예외/소비측
 * break(이터레이터 return) 시 핸들이 자동 close 되어 fd 누수가 없다.
 * 심볼릭 링크는 건너뛴다 — Dirent.isFile()/isDirectory() 는 심볼릭 링크에 false 를 반환하므로
 * 링크 파일은 yield 되지 않고 링크 디렉터리는 재귀하지 않는다(샌드박스 보장). symlink-follow 로 바꾸면 격리 재점검.
 */
async function* walk(dir: string): AsyncGenerator<string> {
  const handle = await fs.opendir(dir)
  for await (const e of handle) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full)
    } else if (e.isFile()) {
      yield full
    }
  }
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function readFileTool(root: string, lim: ResolvedLimits): FleetTool {
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
      if (SENSITIVE_FILE.test(p)) return 'destructive'
      // 심볼릭 링크가 민감 파일을 가리키면(원 인자는 무해해 보여도) 실제 대상 기준으로 destructive 로 승격한다.
      // (자동승인 우회 방지 — execute 의 realpath 해소와 위험도 분류를 일치시킨다.)
      try {
        if (SENSITIVE_FILE.test(realpathSync(path.resolve(root, p)))) return 'destructive'
      } catch {
        // 미존재 등은 무시 — execute 의 resolveWithin/stat 가 처리한다.
      }
      return 'safe'
    },
    async execute(input) {
      const p = asStr((input as { path?: unknown })?.path)
      if (!p) throw new Error('read_file: path 인자가 필요합니다.')
      const abs = await resolveWithin(root, p)
      const stat = await fs.stat(abs)
      if (!stat.isFile()) throw new Error(`read_file: 파일이 아닙니다: ${p}`)
      if (stat.size > lim.maxFileBytes) {
        // 대형 파일은 전체를 메모리에 적재하지 않고 앞부분만 읽는다.
        const fh = await fs.open(abs, 'r')
        try {
          const head = Buffer.alloc(lim.maxFileBytes)
          const { bytesRead } = await fh.read(head, 0, lim.maxFileBytes, 0)
          return `${head.subarray(0, bytesRead).toString('utf8')}\n…(${stat.size}바이트 중 ${lim.maxFileBytes}바이트만 표시)`
        } finally {
          await fh.close()
        }
      }
      const buf = await fs.readFile(abs)
      return buf.toString('utf8')
    },
  }
}

function listDirectoryTool(root: string, lim: ResolvedLimits): FleetTool {
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
      if (lines.length === 0) return '(빈 디렉터리)'
      // 거대 디렉터리의 무제한 출력(메인 프로세스 블록 + 거대 프롬프트) 방지 — 캡 + 절단 마커.
      if (lines.length > lim.maxDirEntries) {
        return `${lines.slice(0, lim.maxDirEntries).join('\n')}\n…(${lines.length}개 항목 중 ${lim.maxDirEntries}개만 표시 — 목록 불완전)`
      }
      return lines.join('\n')
    },
  }
}

function grepTool(root: string, lim: ResolvedLimits): FleetTool {
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
    async execute(input, ctx) {
      const pattern = asStr((input as { pattern?: unknown })?.pattern)
      if (!pattern) throw new Error('grep: pattern 인자가 필요합니다.')
      if (pattern.length > 200) throw new Error('grep: pattern 이 너무 깁니다(최대 200자).')
      // ReDoS 방어: 파국적 백트래킹(중첩 수량자 등) 패턴을 사전 거부한다. 길이 제한만으로는
      // (a+)+$ 같은 짧은 패턴이 긴 라인에서 메인 프로세스를 멈출 수 있어 safe-regex 로 차단한다.
      // (safe-regex 는 휴리스틱이라 모든 케이스를 잡지는 않으나 대표적 파국 클래스를 막는다.)
      if (!safe(pattern)) {
        throw new Error('grep: 잠재적 ReDoS(파국적 백트래킹) 패턴이라 거부합니다. 더 단순한 정규식을 쓰세요.')
      }
      let re: RegExp
      try {
        re = new RegExp(pattern) // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- 패턴 작성자는 오케스트레이션 모델(준신뢰), 대상은 사용자 워크스페이스 파일. 길이 200자 제한 + 스캔/매치 바운드로 ReDoS 영향 한정. + safe-regex 사전검증
      } catch (err) {
        throw new Error(`grep: 잘못된 정규식: ${err instanceof Error ? err.message : String(err)}`)
      }
      const rootReal = await fs.realpath(root)
      const start = await resolveWithin(root, asStr((input as { path?: unknown })?.path) ?? '.')
      const out: string[] = []
      let scanned = 0
      let truncated = false
      for await (const file of walk(start)) {
        if (ctx.signal?.aborted) throw new Error('grep: 취소되었습니다.') // 취소 시 즉시 중단(fast-fail)
        if (scanned >= lim.maxGrepFiles || out.length >= lim.maxGrepMatches) {
          truncated = true
          break
        }
        const rel = path.relative(rootReal, file).split(path.sep).join('/')
        scanned++ // 민감파일 스킵도 스캔 한도에 포함(다수 민감파일로 한도 우회 방지)
        if (SENSITIVE_FILE.test(rel)) continue // 민감파일 제외
        let content: string
        try {
          const st = await fs.stat(file)
          if (st.size > lim.maxFileBytes) continue // 대형/바이너리 추정 — 전체 적재 전에 스킵
          content = (await fs.readFile(file)).toString('utf8')
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && out.length < lim.maxGrepMatches; i++) {
          if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`)
        }
      }
      // 매치 캡에 정확히 도달한 채 순회가 끝난 경우도 불완전으로 표시한다(silent partial 방지 — #7).
      if (out.length >= lim.maxGrepMatches) truncated = true
      if (out.length === 0) return truncated ? '(일치 없음 — 스캔 한도 도달로 결과 불완전)' : '(일치 없음)'
      return truncated ? `${out.join('\n')}\n…(스캔/매치 한도 도달 — 결과 불완전)` : out.join('\n')
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
 * 글롭 세그먼트 배열로 경로 문자열을 매칭한다(재귀 + (si,ci) 실패상태 메모이제이션).
 * new RegExp 를 쓰지 않는다. 메모이제이션으로 다중 starstar 의 지수 백트래킹을 O(segs×len) 으로
 * 바운드해, starstar 세그먼트가 여러 개인 비매칭 패턴이 한 경로에서 메인 프로세스를 freeze 하는 것을 막는다.
 * (매칭 결과는 (si,ci) 에만 의존 — segs/str 은 호출 내 불변 — 이라 실패만 캐시해도 정확하다.)
 */
function globMatchSegments(
  segs: GlobSegment[],
  si: number,
  str: string,
  ci: number,
  failed: Set<number>,
  stride: number,
): boolean {
  if (si === segs.length) return ci === str.length
  const key = si * stride + ci
  if (failed.has(key)) return false

  const seg = segs[si]
  let ok = false
  if (seg.kind === 'literal') {
    ok = str.startsWith(seg.value, ci) && globMatchSegments(segs, si + 1, str, ci + seg.value.length, failed, stride)
  } else if (seg.kind === 'question') {
    ok = ci < str.length && str[ci] !== '/' && globMatchSegments(segs, si + 1, str, ci + 1, failed, stride)
  } else if (seg.kind === 'star') {
    // * 는 슬래시를 넘을 수 없음 — 현재 세그먼트 내에서만 탐색
    for (let j = ci; j <= str.length; j++) {
      if (j > ci && str[j - 1] === '/') break // 슬래시 직전까지만
      if (globMatchSegments(segs, si + 1, str, j, failed, stride)) {
        ok = true
        break
      }
    }
  } else {
    // ** : 0개 이상의 임의 문자(슬래시 포함)를 건너뛴다. 현재 위치부터 끝까지 모든 분기를 시도해
    // bare '**'(전체 매칭)와 '**/x'(선택적 디렉터리) 양쪽을 올바르게 처리한다.
    for (let j = ci; j <= str.length; j++) {
      if (globMatchSegments(segs, si + 1, str, j, failed, stride)) {
        ok = true
        break
      }
    }
  }
  if (!ok) failed.add(key) // 실패상태 캐시 → 동일 (si,ci) 재탐색 차단
  return ok
}

/** 글롭 패턴으로 상대경로를 매칭한다. new RegExp 를 사용하지 않는다. 호출마다 실패 캐시는 새로 만든다. */
function globMatch(pattern: string, relPath: string): boolean {
  const segs = parseGlob(pattern)
  return globMatchSegments(segs, 0, relPath, 0, new Set<number>(), relPath.length + 1)
}

function globTool(root: string, lim: ResolvedLimits): FleetTool {
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
    async execute(input, ctx) {
      const pattern = asStr((input as { pattern?: unknown })?.pattern)
      if (!pattern) throw new Error('glob: pattern 인자가 필요합니다.')
      const rootReal = await fs.realpath(root)
      const out: string[] = []
      let scanned = 0
      let truncated = false
      for await (const file of walk(rootReal)) {
        if (ctx.signal?.aborted) throw new Error('glob: 취소되었습니다.') // 취소 시 즉시 중단(fast-fail)
        if (scanned >= lim.maxGlobScan || out.length >= lim.maxGlobResults) {
          truncated = true // 매치가 적어도 순회를 바운드 — 불완전으로 표시(silent false-negative 방지)
          break
        }
        scanned++
        const rel = path.relative(rootReal, file).split(path.sep).join('/')
        if (SENSITIVE_FILE.test(rel)) continue
        if (globMatch(pattern, rel)) out.push(rel)
      }
      if (out.length === 0) return truncated ? '(일치 없음 — 스캔 한도 도달로 결과 불완전)' : '(일치 없음)'
      return truncated ? `${out.sort().join('\n')}\n…(스캔/결과 한도 도달 — 목록 불완전)` : out.sort().join('\n')
    },
  }
}

/** 워크스페이스 루트(root)를 기준으로 한 읽기전용 도구 세트. 모두 root 내부로 격리된다.
 *  한도(limits)는 미지정 시 기본값을 쓴다(테스트에서 작은 값 주입 가능). */
export function createWorkspaceReadTools(root: string, limits: WorkspaceToolLimits = {}): FleetTool[] {
  const lim: ResolvedLimits = {
    maxFileBytes: limits.maxFileBytes ?? MAX_FILE_BYTES,
    maxGrepFiles: limits.maxGrepFiles ?? MAX_GREP_FILES,
    maxGrepMatches: limits.maxGrepMatches ?? MAX_GREP_MATCHES,
    maxGlobResults: limits.maxGlobResults ?? MAX_GLOB_RESULTS,
    maxGlobScan: limits.maxGlobScan ?? MAX_GLOB_SCAN,
    maxDirEntries: limits.maxDirEntries ?? MAX_DIR_ENTRIES,
  }
  return [readFileTool(root, lim), listDirectoryTool(root, lim), grepTool(root, lim), globTool(root, lim)]
}
