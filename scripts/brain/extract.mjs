// Fleet 설계도(Second Brain) 추출기.
//
// src/**/*.ts(x) 를 TypeScript 컴파일러 API 로 파싱해 그래프 모델을 만든다:
//   - 노드   = 파일
//   - 엣지   = import 의존(정적 import · export…from · 동적 import() · require)
//   - 오버레이 = 코드만 봐선 안 보이는 "배선": 렌더러→preload IPC, preload↔main 채널,
//                cli/api/mcp 세션 → 외부 런타임 경계(claude/codex/gemini · API · MCP)
//
// 전부 코드에서 derive 한다 — 손으로 좌표·연결을 두지 않으므로 코드가 바뀌면
// 다시 돌리기만 하면 동기화된다(drift 불가). 이 파일은 순수 Node + typescript 만 의존.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'src')
const DESC_FILE = path.join(HERE, 'descriptions.json')

// 비전공자용 쉬운 한국어 설명(파일/모듈/레이어/인트로). 코드를 읽어 한 번 생성한 뒤
// 손으로 다듬는 사이드카 — 구조는 코드에서 자동 동기화되지만, "무슨 역할인지"는 여기서 온다.
function loadDescriptions() {
  try {
    return JSON.parse(fs.readFileSync(DESC_FILE, 'utf8'))
  } catch {
    return {}
  }
}

// 테스트·선언파일은 설계도 노이즈라 제외(필요 시 토글 추가).
const IGNORE = /(\.test\.tsx?$)|(\.d\.ts$)/

// --- 파일 수집 --------------------------------------------------------------
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(abs, out)
    else if (/\.tsx?$/.test(ent.name) && !IGNORE.test(ent.name)) out.push(abs)
  }
  return out
}

// 절대경로 → src 기준 forward-slash id (예: main/core/engine.ts). src 밖이면 null.
function toId(abs) {
  const rel = path.relative(SRC, abs)
  if (rel.startsWith('..')) return null
  return rel.split(path.sep).join('/')
}

// --- import 추출(AST 전체 순회: 동적 import 는 함수 내부에도 있을 수 있다) ----
function collectSpecifiers(sf) {
  const specs = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const arg0 = node.arguments[0]
      const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      if ((isDynImport || isRequire) && arg0 && ts.isStringLiteral(arg0)) specs.push(arg0.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs
}

// 상대경로 specifier → 그래프 내부 파일 id. 확장자·index 후보를 순서대로 시도.
function resolveLocal(fromAbs, spec, fileSet) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromAbs), spec)
  const cands = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.d.ts',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  for (const c of cands) {
    const id = toId(c)
    if (id && fileSet.has(id)) return id
  }
  return null
}

// bare specifier → 패키지명(서브패스 제거). node:fs/promises → node:fs, @scope/p/x → @scope/p.
function externalName(spec) {
  if (spec.startsWith('.')) return null
  if (spec.startsWith('node:')) return spec.split('/')[0]
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

// --- 분류: 도메인(group=색 클러스터) · 레이어 -------------------------------
function classify(id) {
  const p = id.split('/')
  if (p[0] === 'shared') return { layer: 'shared', group: 'shared' }
  if (p[0] === 'preload') return { layer: 'preload', group: 'preload' }
  if (p[0] === 'renderer') return { layer: 'renderer', group: 'renderer' }
  if (p[0] === 'main') {
    if (p[1] === 'core') {
      // core 직속 파일(engine.ts 등)은 파일명을 그룹으로 → 허브가 도드라진다.
      if (p.length === 3) return { layer: 'core', group: p[2].replace(/\.tsx?$/, '') }
      return { layer: 'core', group: p[2] }
    }
    return { layer: 'main', group: 'main' }
  }
  return { layer: 'other', group: 'other' }
}

const ENTRY = new Set(['main/index.ts', 'preload/index.ts', 'renderer/main.tsx', 'main/e2e.ts'])

// --- 메인 빌드 --------------------------------------------------------------
export function buildGraph() {
  const files = walk(SRC)
  const ids = files.map(toId).filter(Boolean)
  const fileSet = new Set(ids)
  const absById = new Map(files.map((abs) => [toId(abs), abs]))

  const nodes = new Map()
  const linkMap = new Map() // "src|tgt|kind" -> {source,target,kind,count}
  const overlayLinks = []
  const channelSet = new Set()

  const addLink = (source, target, kind) => {
    if (source === target) return
    const key = `${source}|${target}|${kind}`
    const ex = linkMap.get(key)
    if (ex) ex.count++
    else linkMap.set(key, { source, target, kind, count: 1 })
  }

  for (const id of ids) {
    const abs = absById.get(id)
    const text = fs.readFileSync(abs, 'utf8')
    const sf = ts.createSourceFile(
      id,
      text,
      ts.ScriptTarget.Latest,
      true,
      id.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const externals = new Set()
    for (const spec of collectSpecifiers(sf)) {
      const local = resolveLocal(abs, spec, fileSet)
      if (local) addLink(id, local, 'import')
      else {
        const ext = externalName(spec)
        if (ext) externals.add(ext)
      }
    }

    const meta = classify(id)
    nodes.set(id, {
      id,
      label: id.split('/').pop(),
      path: id,
      dir: id.split('/').slice(0, -1).join('/'),
      layer: meta.layer,
      group: meta.group,
      loc: text.split('\n').length,
      externals: [...externals].sort(),
      degree: 0,
      entry: ENTRY.has(id),
      registry: id.endsWith('/registry.ts'),
      gate: id === 'main/core/safety/approval.ts',
    })

    // IPC 오버레이(파생): 렌더러가 window.fleet 를 참조하면 preload 브리지로 런타임 배선.
    if (
      meta.layer === 'renderer' &&
      /window\.fleet/.test(text) &&
      fileSet.has('preload/index.ts')
    ) {
      overlayLinks.push({ source: id, target: 'preload/index.ts', kind: 'ipc' })
    }
    if (id === 'preload/index.ts') {
      for (const m of text.matchAll(/fleet:[a-z]+:[A-Za-z]+/g)) channelSet.add(m[0])
    }
  }

  const links = [...linkMap.values()]
  for (const l of links) {
    const a = nodes.get(l.source)
    const b = nodes.get(l.target)
    if (a) a.degree++
    if (b) b.degree++
  }

  // preload ↔ main: 모든 채널은 invoke(preload) ↔ handle(main) 라 한 가닥 레인으로 표상.
  if (fileSet.has('preload/index.ts') && fileSet.has('main/index.ts')) {
    overlayLinks.push({
      source: 'preload/index.ts',
      target: 'main/index.ts',
      kind: 'ipc',
      label: `${channelSet.size} IPC channels`,
    })
  }

  // 외부 런타임 경계(설계도 하단의 "계기 출구") — 해당 세션 파일이 있을 때만.
  const overlayNodes = []
  const boundary = (extId, label, fromId, sub) => {
    if (!fileSet.has(fromId)) return
    overlayNodes.push({
      id: extId,
      label,
      group: 'runtime',
      layer: 'runtime',
      external: true,
      sub,
      degree: 1,
    })
    overlayLinks.push({ source: fromId, target: extId, kind: 'runtime' })
  }
  boundary(
    'ext:cli',
    'claude · codex · gemini',
    'main/core/session/cli-session.ts',
    'CLI 프로세스 (PTY/pipe)',
  )
  boundary(
    'ext:api',
    'Anthropic · OpenAI · Google',
    'main/core/session/api-session.ts',
    'API provider (HTTP/SSE)',
  )
  boundary(
    'ext:mcp',
    'MCP servers',
    fileSet.has('main/core/mcp/stdio.ts') ? 'main/core/mcp/stdio.ts' : 'main/core/mcp/host.ts',
    'stdio 도구 호스트',
  )

  // 허브 표시: 연결 상위 6개에 글로우 강조.
  ;[...nodes.values()]
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 6)
    .forEach((n) => {
      n.hub = true
    })

  // 설명(사이드카) 병합 — 구조는 코드에서 자동, "무슨 역할인지"는 descriptions.json 에서.
  const desc = loadDescriptions()
  for (const n of nodes.values()) {
    const d = desc.files && desc.files[n.id]
    if (d) {
      n.role = d.role
      n.detail = d.detail
    }
  }
  for (const en of overlayNodes) {
    const d = desc.externals && desc.externals[en.id]
    if (d) {
      en.role = d.role
      en.detail = d.detail
    }
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      root: ROOT.split(path.sep).join('/'),
      fileCount: nodes.size,
      linkCount: links.length,
      channels: channelSet.size,
      groups: [...new Set([...nodes.values()].map((n) => n.group))].sort(),
      intro: desc.intro || '',
      layers: desc.layers || {},
      modules: desc.modules || {},
    },
    nodes: [...nodes.values()],
    links,
    overlayNodes,
    overlayLinks,
  }
}

// 직접 실행(`node scripts/brain/extract.mjs`)하면 그래프 JSON 을 stdout 으로.
// (import 로 불러올 땐 process.argv[1] 이 없을 수 있어 가드.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(buildGraph(), null, 2) + '\n')
}
