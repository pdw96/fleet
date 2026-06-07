# 도구 실행 루프 + provider tool_result 매핑 (SP1) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API 세션이 모델의 도구 호출(toolCalls)을 실행하고 결과를 회신해 모델을 재호출하는 디스패치 루프와, 워크스페이스 읽기전용 내장 도구, OpenAI/Gemini tool_result 매핑을 추가한다.

**Architecture:** 새 순수-TS 코어 모듈 `src/main/core/tools/`(레지스트리·워크스페이스 도구·루프)를 만들고, `createApiSession.send()`가 워크스페이스 설정 시 단발 `provider.chat` 대신 `runToolLoop`로 분기한다. 루프는 `ApprovalGate`로 게이팅하고 감사 로그를 남긴다. provider 레이어는 OpenAI(`assistant.tool_calls` + `role:'tool'`)·Gemini(`functionResponse.name`) 매핑을 완성한다.

**Tech Stack:** TypeScript, Electron(메인 프로세스 코어, electron 비의존), Node `fs`/`path`, vitest.

**스펙:** `docs/superpowers/specs/2026-06-08-tool-execution-loop-sp1-design.md`
**브랜치:** `feat/tool-execution-loop` (스펙 커밋 `6ade84f` 이미 존재)

---

## 파일 구조

**신규**
- `src/main/core/tools/types.ts` — `FleetTool` · `ToolRegistry` · `ToolContext` · `ToolLoopDeps`
- `src/main/core/tools/registry.ts` — `createToolRegistry`
- `src/main/core/tools/registry.test.ts`
- `src/main/core/tools/workspace-tools.ts` — `createWorkspaceReadTools`
- `src/main/core/tools/workspace-tools.test.ts`
- `src/main/core/tools/loop.ts` — `runToolLoop`
- `src/main/core/tools/loop.test.ts`

**수정**
- `src/shared/types.ts` — `ApprovalRequest.kind`에 `'tool-call'` 추가
- `src/renderer/components/ApprovalModal.tsx` — `KIND_TITLE`에 `'tool-call'` 항목(typecheck 유지)
- `src/main/core/providers/types.ts` — `ToolResultBlock`에 `name?` 추가
- `src/main/core/providers/openai.ts` — 메시지 빌더 재작성(tool_calls + role:'tool')
- `src/main/core/providers/google.ts` — `functionResponse.name` 수정
- `src/main/core/providers/providers.test.ts` — OpenAI/Gemini 매핑 테스트 추가
- `src/main/core/session/api-session.ts` — `toolDeps` 옵션 + 루프 분기
- `src/main/core/session/session.test.ts` — toolDeps 테스트 추가
- `src/main/core/engine.ts` — `registerApiSession`에 toolDeps 클로저 주입
- `src/main/core/engine.test.ts` — 워크스페이스 도구 E2E 테스트 추가

**품질 게이트(매 커밋):** `npm run typecheck`, `npm run lint`, `npm test`. 최종 `npm run build`.

---

## Task 1: shared types — `tool-call` 승인 종류 추가

**Files:**
- Modify: `src/shared/types.ts:248`
- Modify: `src/renderer/components/ApprovalModal.tsx:12-17`

`ApprovalRequest.kind`는 IPC 표면 유니온이고, 렌더러 `KIND_TITLE`이 이 유니온을 키로 한 exhaustive `Record`라 union 멤버를 추가하면 두 곳을 함께 고쳐야 typecheck가 통과한다.

- [ ] **Step 1: `ApprovalRequest.kind`에 `'tool-call'` 추가**

`src/shared/types.ts`의 `ApprovalRequest` 인터페이스:

```ts
export interface ApprovalRequest {
  id: string
  kind: 'file-write' | 'file-delete' | 'shell' | 'apply-diff' | 'tool-call'
  summary: string
  /** 대상 경로 또는 명령 */
  target: string
  risk: RiskLevel
  ts: number
}
```

- [ ] **Step 2: 렌더러 `KIND_TITLE`에 항목 추가**

`src/renderer/components/ApprovalModal.tsx`:

```ts
/** 승인 종류별 모달 제목. apply-diff 는 작업 변경 적용 승인. */
const KIND_TITLE: Record<ApprovalRequest['kind'], string> = {
  'file-write': '위험 작업 승인',
  'file-delete': '위험 작업 승인',
  shell: '위험 작업 승인',
  'apply-diff': '변경 적용 승인',
  'tool-call': '도구 호출 승인',
}
```

- [ ] **Step 3: typecheck 통과 확인**

Run: `npm run typecheck`
Expected: 통과(에러 0). union/Record 정합이 맞아 다른 exhaustive 처리가 깨지지 않음을 확인.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/renderer/components/ApprovalModal.tsx
git commit -m "feat(safety): 승인 종류에 'tool-call' 추가 (#10 SP1)"
```

---

## Task 2: provider tool_result 매핑 — OpenAI + Gemini

**Files:**
- Modify: `src/main/core/providers/types.ts:30-35` (ToolResultBlock)
- Modify: `src/main/core/providers/openai.ts`
- Modify: `src/main/core/providers/google.ts:54`
- Test: `src/main/core/providers/providers.test.ts`

### 2A. ToolResultBlock에 `name?` 추가

- [ ] **Step 1: 타입 필드 추가**

`src/main/core/providers/types.ts`의 `ToolResultBlock`:

```ts
export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  /** 도구 이름. Anthropic/OpenAI 는 toolUseId 로 correlate 하지만 Gemini 는 함수 name 으로 correlate 한다. */
  name?: string
  content: string
  isError?: boolean
}
```

### 2B. Gemini functionResponse.name 수정 (TDD)

- [ ] **Step 2: 실패 테스트 작성**

`src/main/core/providers/providers.test.ts`의 `describe('GoogleProvider', ...)` 안에 추가:

```ts
it('tool_result 를 functionResponse.name(도구 이름)으로 매핑한다', async () => {
  const { http, calls } = mockHttp(() => ({
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
  }))
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.5-flash', apiKey: 'k' }, http)
  await p.chat([
    { role: 'user', content: '조회' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'lookup-0', name: 'lookup', input: { id: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'lookup-0', name: 'lookup', content: '값' }] },
  ])
  const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
  expect(body.contents.at(-1)!.parts[0]).toEqual({
    functionResponse: { name: 'lookup', response: { result: '값' } },
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "functionResponse.name"`
Expected: FAIL — 현재는 `name`이 `toolUseId`('lookup-0')로 들어감.

- [ ] **Step 4: 매핑 수정**

`src/main/core/providers/google.ts`의 `mapParts` 내 `tool_result` 분기:

```ts
      case 'tool_result':
        return { functionResponse: { name: b.name ?? b.toolUseId, response: { result: b.content } } }
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "functionResponse.name"`
Expected: PASS

### 2C. OpenAI tool_calls + role:'tool' 매핑 (TDD)

- [ ] **Step 6: 실패 테스트 작성**

`src/main/core/providers/providers.test.ts`의 `describe('OpenAiProvider', ...)` 안에 추가:

```ts
it('tool_use/tool_result 블록을 tool_calls + role:tool 메시지로 평탄화한다', async () => {
  const { http, calls } = mockHttp(() => ({
    body: JSON.stringify({ choices: [{ message: { content: '끝' }, finish_reason: 'stop' }] }),
  }))
  const p = createOpenAiProvider({ id: 'o', provider: 'openai', displayName: 'O', model: 'gpt-4o', apiKey: 'k' }, http)
  await p.chat([
    { role: 'user', content: '검색해' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'search', content: '결과' }] },
  ])
  const body = JSON.parse(calls[0].init.body) as { messages: Array<Record<string, unknown>> }
  expect(body.messages[1]).toEqual({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
  })
  expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '결과' })
})
```

- [ ] **Step 7: 테스트 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "tool_calls + role:tool"`
Expected: FAIL — 현재는 tool_use/tool_result가 text fallback으로 매핑됨.

- [ ] **Step 8: OpenAI 메시지 빌더 재작성**

`src/main/core/providers/openai.ts` 상단 import에 `TextBlock`을 추가:

```ts
import {
  ApiProviderError,
  defaultHttp,
  requireApiKey,
  textOf,
  type ApiCallOptions,
  type ApiProvider,
  type ChatResult,
  type ChatTurn,
  type ContentBlock,
  type FinishReason,
  type HttpClient,
  type TextBlock,
  type ToolUseBlock,
} from './types'
```

`mapContent` 함수 **바로 아래**에 `buildMessages`를 추가:

```ts
interface OpenAiMessage {
  role: string
  content: string | unknown[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/**
 * ChatTurn[] → OpenAI Chat Completions 메시지 배열.
 * - tool_result 블록을 가진 user 턴 → 블록당 role:'tool' 메시지로 평탄화(1턴이 N메시지).
 * - tool_use 블록을 가진 assistant 턴 → content + tool_calls 필드.
 * - 그 외(텍스트/이미지) → 기존 mapContent 로 단일 메시지.
 */
function buildMessages(turns: ChatTurn[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  for (const m of turns) {
    const blocks: ContentBlock[] | null = typeof m.content === 'string' ? null : m.content
    if (blocks?.some((b) => b.type === 'tool_result')) {
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content })
      }
      const text = blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('')
      if (text) out.push({ role: 'user', content: text })
      continue
    }
    if (blocks?.some((b) => b.type === 'tool_use')) {
      const toolCalls = blocks
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      const text = blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('')
      out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
      continue
    }
    out.push({ role: m.role, content: mapContent(m.content) })
  }
  return out
}
```

`chat()` 안에서 `body.messages` 빌드 줄을 교체:

```ts
      const body: Record<string, unknown> = {
        model: config.model,
        messages: buildMessages(messages),
      }
```

- [ ] **Step 9: 테스트 통과 확인 + 회귀**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: PASS (신규 2건 + 기존 전부 — 일반 텍스트 메시지 매핑 회귀 포함)

- [ ] **Step 10: Commit**

```bash
git add src/main/core/providers/types.ts src/main/core/providers/openai.ts src/main/core/providers/google.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): OpenAI/Gemini tool_result 매핑 완성 (#10 SP1)"
```

---

## Task 3: 도구 레지스트리 (`tools/types.ts` + `registry.ts`)

**Files:**
- Create: `src/main/core/tools/types.ts`
- Create: `src/main/core/tools/registry.ts`
- Test: `src/main/core/tools/registry.test.ts`

- [ ] **Step 1: 타입 정의 작성**

`src/main/core/tools/types.ts`:

```ts
import type { RiskLevel } from '../../../shared/types'
import type { ToolDefinition } from '../providers/types'
import type { ApprovalGate } from '../safety/approval'

/** 도구 실행 컨텍스트(취소 신호 등). */
export interface ToolContext {
  signal?: AbortSignal
}

/** 레지스트리에 등록되는 도구. IPC 직렬화되지 않으므로 함수 필드를 둔다. */
export interface FleetTool {
  /** 모델에 노출할 정의(name·description·parameters JSON Schema). */
  definition: ToolDefinition
  /** 입력 기반 위험도. 게이트 통과 후 execute 된다. */
  classify(input: unknown): RiskLevel
  /** 실행. 결과 문자열을 반환하고, 위반/오류는 throw 한다(루프가 isError 로 회신). */
  execute(input: unknown, ctx: ToolContext): Promise<string>
}

/** 이름→도구 조회 레지스트리. */
export interface ToolRegistry {
  /** 모델에 노출할 도구 정의 목록. */
  list(): ToolDefinition[]
  get(name: string): FleetTool | undefined
  has(name: string): boolean
}

/** 도구 루프가 받는 의존성. */
export interface ToolLoopDeps {
  registry: ToolRegistry
  gate: ApprovalGate
  /** 감사 로그 싱크(예: store.appendEvent 래퍼). */
  onAudit?: (type: string, data: Record<string, unknown>) => void
  /** 최대 반복 횟수(기본 8). */
  maxIterations?: number
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/main/core/tools/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createToolRegistry } from './registry'
import type { FleetTool } from './types'

function tool(name: string): FleetTool {
  return {
    definition: { name, description: name, parameters: { type: 'object' } },
    classify: () => 'safe',
    async execute() {
      return name
    },
  }
}

describe('createToolRegistry', () => {
  it('lists definitions and resolves by name', () => {
    const reg = createToolRegistry([tool('a'), tool('b')])
    expect(reg.list().map((d) => d.name)).toEqual(['a', 'b'])
    expect(reg.get('a')?.definition.name).toBe('a')
    expect(reg.has('b')).toBe(true)
    expect(reg.get('zzz')).toBeUndefined()
    expect(reg.has('zzz')).toBe(false)
  })

  it('throws on duplicate tool name (silent override 금지)', () => {
    expect(() => createToolRegistry([tool('dup'), tool('dup')])).toThrow(/충돌|dup/)
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/core/tools/registry.test.ts`
Expected: FAIL — `createToolRegistry` 미정의.

- [ ] **Step 4: 구현 작성**

`src/main/core/tools/registry.ts`:

```ts
import type { FleetTool, ToolRegistry } from './types'

/** FleetTool 배열로 이름→도구 레지스트리를 만든다. 중복 이름은 충돌로 throw 한다. */
export function createToolRegistry(tools: FleetTool[]): ToolRegistry {
  const map = new Map<string, FleetTool>()
  for (const t of tools) {
    const name = t.definition.name
    if (map.has(name)) throw new Error(`도구 이름 충돌: '${name}' 이 중복 등록되었습니다.`)
    map.set(name, t)
  }
  return {
    list: () => [...map.values()].map((t) => t.definition),
    get: (name) => map.get(name),
    has: (name) => map.has(name),
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/tools/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/core/tools/types.ts src/main/core/tools/registry.ts src/main/core/tools/registry.test.ts
git commit -m "feat(tools): 도구 레지스트리 + 타입 계약 (#10 SP1)"
```

---

## Task 4: 워크스페이스 읽기전용 도구 (`tools/workspace-tools.ts`)

**Files:**
- Create: `src/main/core/tools/workspace-tools.ts`
- Test: `src/main/core/tools/workspace-tools.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/tools/workspace-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/tools/workspace-tools.test.ts`
Expected: FAIL — `createWorkspaceReadTools` 미정의.

- [ ] **Step 3: 구현 작성**

`src/main/core/tools/workspace-tools.ts`:

```ts
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

/** root 하위 파일을 재귀 순회(스킵 디렉터리 제외). */
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
        re = new RegExp(pattern) // 비전역 — re.test 반복 안전
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
        if (SENSITIVE_FILE.test(rel)) continue // 민감파일 제외
        scanned++
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

/** 단순 글롭→정규식: `**​/`=선택적 경로, `**`=모든 경로, `*`=슬래시 제외, `?`=한 글자. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 3
      } else {
        re += '.*'
        i += 2
      }
    } else if (c === '*') {
      re += '[^/]*'
      i++
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp(`^${re}$`)
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
      const re = globToRegExp(pattern)
      const rootReal = await fs.realpath(root)
      const out: string[] = []
      for await (const file of walk(rootReal)) {
        if (out.length >= MAX_GLOB_RESULTS) break
        const rel = path.relative(rootReal, file).split(path.sep).join('/')
        if (SENSITIVE_FILE.test(rel)) continue
        if (re.test(rel)) out.push(rel)
      }
      return out.length ? out.sort().join('\n') : '(일치 없음)'
    },
  }
}

/** 워크스페이스 루트(root)를 기준으로 한 읽기전용 도구 세트. 모두 root 내부로 격리된다. */
export function createWorkspaceReadTools(root: string): FleetTool[] {
  return [readFileTool(root), listDirectoryTool(root), grepTool(root), globTool(root)]
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/tools/workspace-tools.test.ts`
Expected: PASS (심볼릭 링크 테스트는 권한 없으면 자동 스킵)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/tools/workspace-tools.ts src/main/core/tools/workspace-tools.test.ts
git commit -m "feat(tools): 워크스페이스 읽기전용 도구(read/list/grep/glob) (#10 SP1)"
```

---

## Task 5: 도구 디스패치 루프 (`tools/loop.ts`)

**Files:**
- Create: `src/main/core/tools/loop.ts`
- Test: `src/main/core/tools/loop.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/tools/loop.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { ApiProvider, ChatResult, ChatTurn, ToolResultBlock, ToolUseBlock } from '../providers/types'
import type { ApprovalGate } from '../safety/approval'
import { createToolRegistry } from './registry'
import { runToolLoop } from './loop'
import type { FleetTool } from './types'

const approveAll: ApprovalGate = { async request() { return 'approved' } }
const rejectAll: ApprovalGate = { async request() { return 'rejected' } }

const echoTool: FleetTool = {
  definition: { name: 'echo', description: 'e', parameters: { type: 'object' } },
  classify: () => 'safe',
  async execute(input) {
    return `echoed:${JSON.stringify(input)}`
  },
}

const toolUse = (id: string, name: string, input: unknown): ToolUseBlock => ({ type: 'tool_use', id, name, input })

/** 호출 순서대로 ChatResult 를 돌려주는 스크립트 provider(마지막 항목 고정). */
function scriptedProvider(script: ChatResult[]): { provider: ApiProvider; calls: ChatTurn[][] } {
  const calls: ChatTurn[][] = []
  let i = 0
  const provider: ApiProvider = {
    id: 'fake',
    provider: 'anthropic',
    model: 'm',
    async chat(messages) {
      calls.push(structuredClone(messages))
      return script[Math.min(i++, script.length - 1)]
    },
  }
  return { provider, calls }
}

const firstResult = (turns: ChatTurn[]): ToolResultBlock => (turns[2].content as ToolResultBlock[])[0]

describe('runToolLoop', () => {
  it('도구를 실행하고 tool_result 를 회신한 뒤 종료한다', async () => {
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', { a: 1 })], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    const audit = vi.fn()
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      onAudit: audit,
    })
    expect(out.text).toBe('완료')
    expect(calls[1].map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(firstResult(calls[1])).toMatchObject({
      type: 'tool_result',
      toolUseId: 't1',
      name: 'echo',
      content: 'echoed:{"a":1}',
    })
    expect(audit).toHaveBeenCalledWith('tool.executed', expect.objectContaining({ name: 'echo' }))
  })

  it('도구 호출이 없으면 첫 결과를 반환하고 turns 를 변경하지 않는다', async () => {
    const { provider } = scriptedProvider([{ text: '바로답', toolCalls: [], finishReason: 'stop' }])
    const turns: ChatTurn[] = [{ role: 'user', content: 'go' }]
    const out = await runToolLoop(provider, turns, {}, { registry: createToolRegistry([echoTool]), gate: approveAll })
    expect(out.text).toBe('바로답')
    expect(turns).toHaveLength(1)
  })

  it('최대 반복을 초과하면(여전히 tool_use) 에러를 던진다', async () => {
    const { provider } = scriptedProvider([{ text: '', toolCalls: [toolUse('t', 'echo', {})], finishReason: 'tool_use' }])
    await expect(
      runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
        registry: createToolRegistry([echoTool]),
        gate: approveAll,
        maxIterations: 3,
      }),
    ).rejects.toThrow(/최대 3회/)
  })

  it('도구 실행 오류는 isError tool_result 로 회신하고 루프는 계속된다', async () => {
    const boom: FleetTool = {
      definition: { name: 'boom', parameters: { type: 'object' } },
      classify: () => 'safe',
      async execute() {
        throw new Error('펑')
      },
    }
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'boom', {})], finishReason: 'tool_use' },
      { text: '수습', toolCalls: [], finishReason: 'stop' },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([boom]),
      gate: approveAll,
    })
    expect(out.text).toBe('수습')
    expect(firstResult(calls[1])).toMatchObject({ isError: true, content: '펑' })
  })

  it('게이트가 거부하면 isError tool_result 로 회신한다', async () => {
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', {})], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: rejectAll,
    })
    const r = firstResult(calls[1])
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/거부/)
  })

  it('미존재 도구는 게이트 없이 isError 로 회신한다', async () => {
    const gate = { request: vi.fn(async () => 'approved' as const) }
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'nope', {})], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate,
    })
    expect(gate.request).not.toHaveBeenCalled()
    expect(firstResult(calls[1])).toMatchObject({ isError: true, name: 'nope' })
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
Expected: FAIL — `runToolLoop` 미정의.

- [ ] **Step 3: 구현 작성**

`src/main/core/tools/loop.ts`:

```ts
import type {
  ApiCallOptions,
  ApiProvider,
  ChatResult,
  ChatTurn,
  ContentBlock,
  ToolResultBlock,
} from '../providers/types'
import type { ToolLoopDeps } from './types'

const DEFAULT_MAX_ITERATIONS = 8

/**
 * provider.chat 를 도구 호출이 끝날 때까지 반복한다. turns 를 in-place 로 확장
 * (assistant tool_use + user tool_result)하고 최종 ChatResult 를 반환한다.
 * 최대 반복을 넘겨도 여전히 tool_use 면 미완성 응답을 성공으로 위장하지 않고 throw 한다(#7).
 */
export async function runToolLoop(
  provider: ApiProvider,
  turns: ChatTurn[],
  opts: ApiCallOptions,
  deps: ToolLoopDeps,
): Promise<ChatResult> {
  const max = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const audit = deps.onAudit ?? (() => {})
  const tools = deps.registry.list()

  for (let iter = 0; iter < max; iter++) {
    const result = await provider.chat(turns, { ...opts, tools, toolChoice: 'auto' })
    if (result.finishReason !== 'tool_use' || result.toolCalls.length === 0) return result

    // 어시스턴트 턴 재구성: (텍스트 있으면) + tool_use 블록들.
    const assistant: ContentBlock[] = []
    if (result.text) assistant.push({ type: 'text', text: result.text })
    assistant.push(...result.toolCalls)
    turns.push({ role: 'assistant', content: assistant })

    const results: ToolResultBlock[] = []
    for (const call of result.toolCalls) {
      const tool = deps.registry.get(call.name)
      if (!tool) {
        audit('tool.failed', { name: call.name, reason: 'unknown' })
        results.push({ type: 'tool_result', toolUseId: call.id, name: call.name, content: `알 수 없는 도구: ${call.name}`, isError: true })
        continue
      }
      const risk = tool.classify(call.input)
      audit('tool.requested', { name: call.name, risk })
      const decision = await deps.gate.request({
        kind: 'tool-call',
        summary: `도구 호출: ${call.name}`,
        target: call.name,
        risk,
      })
      if (decision !== 'approved') {
        audit('tool.failed', { name: call.name, reason: 'rejected' })
        results.push({ type: 'tool_result', toolUseId: call.id, name: call.name, content: `승인 거부됨: ${call.name}`, isError: true })
        continue
      }
      try {
        const content = await tool.execute(call.input, { signal: opts.signal })
        audit('tool.executed', { name: call.name })
        results.push({ type: 'tool_result', toolUseId: call.id, name: call.name, content })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        audit('tool.failed', { name: call.name, reason: message })
        results.push({ type: 'tool_result', toolUseId: call.id, name: call.name, content: message, isError: true })
      }
    }
    turns.push({ role: 'user', content: results })
  }
  throw new Error(`도구 루프가 최대 ${max}회 반복을 초과했습니다(모델이 여전히 도구 호출을 요청).`)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
Expected: PASS (6건)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/tools/loop.ts src/main/core/tools/loop.test.ts
git commit -m "feat(tools): 도구 디스패치 루프(게이팅·감사·결정론적 종료) (#10 SP1)"
```

---

## Task 6: api-session 통합 (`toolDeps` 옵션 + 루프 분기)

**Files:**
- Modify: `src/main/core/session/api-session.ts`
- Test: `src/main/core/session/session.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/session/session.test.ts` 상단 import에 추가:

```ts
import { createToolRegistry } from '../tools/registry'
```

`describe('createApiSession', ...)` 안에 추가:

```ts
  it('toolDeps 가 있으면 도구 루프로 처리해 최종 텍스트를 반환한다', async () => {
    let n = 0
    const provider: ApiProvider = {
      id: 'fake',
      provider: 'anthropic',
      model: 'm',
      async chat() {
        return n++ === 0
          ? { text: '', toolCalls: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }], finishReason: 'tool_use' }
          : { text: '최종', toolCalls: [], finishReason: 'stop' }
      },
    }
    const registry = createToolRegistry([
      { definition: { name: 'echo', parameters: { type: 'object' } }, classify: () => 'safe', async execute() { return 'r' } },
    ])
    const gate = { async request() { return 'approved' as const } }
    const s = createApiSession(apiDesc, provider, { toolDeps: () => ({ registry, gate }) })
    expect(await s.send('go')).toBe('최종')
  })

  it('toolDeps 가 undefined 를 반환하면(워크스페이스 없음) 단발 chat 으로 동작한다(회귀)', async () => {
    const { provider } = fakeProvider()
    const s = createApiSession(apiDesc, provider, { toolDeps: () => undefined })
    expect(await s.send('hi')).toBe('echo:hi')
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/session/session.test.ts -t "toolDeps"`
Expected: FAIL — `toolDeps` 옵션 미지원(타입 에러/런타임 미분기).

- [ ] **Step 3: api-session 수정**

`src/main/core/session/api-session.ts` 전체를 아래로 교체:

```ts
import type { LlmDescriptor } from '../../../shared/types'
import type { ApiCallOptions, ApiProvider, ChatResult, ChatTurn } from '../providers/types'
import { runToolLoop } from '../tools/loop'
import type { ToolLoopDeps } from '../tools/types'
import type { LlmSession, SendOptions } from './types'

/**
 * ChatResult 를 레거시 string send() 계약으로 환원한다.
 * 텍스트도 도구호출도 없는데 콘텐츠/안전 필터로 차단된 경우(과거 조용히 '' 로 흡수되던 케이스)는
 * 명확한 에러로 표면화한다 — silent truncation/refusal 방지(#7).
 */
function unwrap(provider: string, result: ChatResult): string {
  if (result.text === '' && result.toolCalls.length === 0 && result.finishReason === 'content_filter') {
    throw new Error(`[${provider}] 응답이 콘텐츠/안전 필터로 차단되었습니다 (finish=${result.rawFinishReason ?? 'unknown'}).`)
  }
  return result.text
}

/**
 * API 기반 LLM 세션. 대화 히스토리를 누적하여 멀티턴을 지원한다.
 * (요구사항 2B → 동일 오케스트레이션 계층에서 사용)
 *
 * opts.toolDeps 가 주어지고 호출 시점에 truthy 를 반환하면(워크스페이스 설정 등) provider.chat 대신
 * 도구 디스패치 루프(runToolLoop)로 처리한다. 클로저라 런타임 워크스페이스 변경을 추종한다.
 */
export function createApiSession(
  descriptor: LlmDescriptor,
  provider: ApiProvider,
  opts: { system?: string; toolDeps?: () => ToolLoopDeps | undefined } = {},
): LlmSession {
  const history: ChatTurn[] = []
  if (opts.system) history.push({ role: 'system', content: opts.system })

  // 도구 의존성이 활성이면 루프, 아니면 단발 chat. turns 는 루프가 in-place 확장(도구 왕복 턴).
  const runChat = (turns: ChatTurn[], callOpts: ApiCallOptions): Promise<ChatResult> => {
    const deps = opts.toolDeps?.()
    return deps ? runToolLoop(provider, turns, callOpts, deps) : provider.chat(turns, callOpts)
  }

  return {
    id: descriptor.id,
    descriptor,
    async send(prompt: string, sendOpts: SendOptions = {}): Promise<string> {
      // onChunk 가 있으면 provider 의 토큰 델타를 그대로 전달(스트리밍). 호출 여부를 추적해
      // 스트리밍된 경우 끝에서 중복 방출하지 않고, 비스트리밍이면 최종 텍스트를 1회 방출한다.
      // (도구 루프 경로는 tools 동봉으로 provider 가 버퍼링하므로 onToken 이 호출되지 않음 → 최종 1회.)
      let streamed = false
      const onToken = sendOpts.onChunk
        ? (delta: string): void => {
            streamed = true
            sendOpts.onChunk!(delta)
          }
        : undefined
      const callOpts: ApiCallOptions = { signal: sendOpts.signal, onToken }
      const emit = (reply: string): string => {
        if (sendOpts.onChunk && !streamed) sendOpts.onChunk(reply)
        return reply
      }

      if (sendOpts.fresh) {
        // 독립 1회 호출: 누적 history 를 참조하지도 변경하지도 않는다(오케스트레이터 독립성).
        const turns: ChatTurn[] = opts.system
          ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }]
          : [{ role: 'user', content: prompt }]
        return emit(unwrap(provider.provider, await runChat(turns, callOpts)))
      }
      history.push({ role: 'user', content: prompt })
      const reply = unwrap(provider.provider, await runChat(history, callOpts))
      history.push({ role: 'assistant', content: reply })
      return emit(reply)
    },
    async dispose(): Promise<void> {
      history.length = 0
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인 + 회귀**

Run: `npx vitest run src/main/core/session/session.test.ts`
Expected: PASS (신규 2건 + 기존 createApiSession 회귀 전부)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/session/api-session.ts src/main/core/session/session.test.ts
git commit -m "feat(session): API 세션 도구 루프 분기(toolDeps) (#10 SP1)"
```

---

## Task 7: 엔진 배선 + E2E

**Files:**
- Modify: `src/main/core/engine.ts` (import 추가 + `registerApiSession`)
- Test: `src/main/core/engine.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/engine.test.ts` 상단 import에 추가:

```ts
import type { HttpClient } from './providers/types'
```

파일 내 헬퍼 영역(예: `roleRunner` 정의 아래)에 추가:

```ts
/** 호출 순서대로 응답 본문을 돌려주는 mock HTTP(요청 본문 캡처). */
function scriptedHttp(bodies: string[]): { http: HttpClient; calls: string[] } {
  const calls: string[] = []
  let i = 0
  const http: HttpClient = async (_url, init) => {
    calls.push(init.body)
    return { ok: true, status: 200, text: async () => bodies[Math.min(i++, bodies.length - 1)] }
  }
  return { http, calls }
}
```

`describe('FleetEngine', ...)` 안에 테스트 추가:

```ts
  it('워크스페이스가 설정되면 API 세션이 도구 루프로 워크스페이스 파일을 읽는다 (#10 SP1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-engine-tools-'))
    writeFileSync(join(dir, 'note.txt'), '메모 내용')
    const { http, calls } = scriptedHttp([
      JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'note.txt' } }],
        stop_reason: 'tool_use',
      }),
      JSON.stringify({ content: [{ type: 'text', text: '확인 완료' }], stop_reason: 'end_turn' }),
    ])
    const engine = createFleetEngine({ http })
    engine.setWorkspace(dir)
    engine.registerApiSession({ id: 'a', provider: 'anthropic', displayName: 'A', model: 'claude-sonnet-4-6', apiKey: 'k' })
    const room = engine.createRoom('r', ['api:a'])
    const msg = await engine.askLlm(room.id, 'api:a')

    expect(msg.content).toBe('확인 완료')
    expect(calls).toHaveLength(2) // 도구 왕복 = chat 2회
    expect(calls[1]).toContain('메모 내용') // 2번째 요청에 tool_result(파일 내용) 포함
    rmSync(dir, { recursive: true, force: true })
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t "도구 루프로 워크스페이스 파일"`
Expected: FAIL — 워크스페이스가 있어도 API 세션에 도구가 주입되지 않아 `read_file` 미실행(calls 길이 1, 또는 tool_use가 그대로 노출).

- [ ] **Step 3: 엔진 import 추가**

`src/main/core/engine.ts` import 영역에 추가(`./session/api-session` import 부근):

```ts
import { createToolRegistry } from './tools/registry'
import { createWorkspaceReadTools } from './tools/workspace-tools'
```

- [ ] **Step 4: `registerApiSession` 배선**

`src/main/core/engine.ts`의 `registerApiSession`에서 `sessions.add(...)` 줄을 교체:

```ts
      sessions.add(
        createApiSession(descriptor, createApiProvider(config, http), {
          // 워크스페이스가 설정돼 있을 때만 읽기전용 도구를 노출한다. 클로저로 런타임 변경을 추종.
          toolDeps: () =>
            workspaceDir
              ? {
                  registry: createToolRegistry(createWorkspaceReadTools(workspaceDir)),
                  gate,
                  onAudit: appendAudit,
                  maxIterations: 8,
                }
              : undefined,
        }),
      )
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/engine.test.ts`
Expected: PASS (신규 1건 + 기존 엔진 테스트 회귀 전부)

- [ ] **Step 6: Commit**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(engine): 워크스페이스 설정 시 API 세션에 읽기전용 도구 배선 (#10 SP1)"
```

---

## Task 8: 전체 품질 게이트 + 마무리

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 전체 게이트 실행**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: 4개 모두 통과(경고 0). lint 경고가 있으면 해당 파일에서 수정 후 재실행.

- [ ] **Step 2: 스펙 커버리지 자가 점검**

스펙 §컴포넌트/안전/종료/테스트 각 항목이 Task 1–7로 구현됐는지 확인:
- 레지스트리(T3) · 워크스페이스 도구(T4) · 루프(T5) · provider 매핑(T2) · api-session(T6) · engine 배선(T7) · 'tool-call' kind(T1) · 감사 이벤트(T5 loop) · 경로/민감파일 안전(T4) · 결정론적 종료(T5).

- [ ] **Step 3: (게이트 모두 통과 후) 정리 커밋(있으면)**

lint/typecheck 보정이 있었다면:

```bash
git add -A
git commit -m "chore: SP1 도구 루프 품질 게이트 보정 (#10 SP1)"
```

게이트 보정이 없으면 이 단계는 생략.

---

## Self-Review 결과(작성자 점검)

**1. 스펙 커버리지:** 스펙의 모든 컴포넌트/수정 항목이 Task에 매핑됨(위 §스펙 커버리지). 누락 없음.

**2. Placeholder 스캔:** "TBD/TODO/적절히 처리" 류 없음. 모든 코드 스텝에 완전한 코드 포함.

**3. 타입 일관성:** `FleetTool`/`ToolRegistry`/`ToolLoopDeps`(T3) ↔ `runToolLoop`(T5) ↔ api-session `toolDeps: () => ToolLoopDeps | undefined`(T6) ↔ engine 클로저(T7) 시그니처 일치. `ToolResultBlock.name`(T2) ↔ 루프가 `name` 채움(T5) ↔ Gemini가 `name` 사용(T2) 일치. `createToolRegistry`/`createWorkspaceReadTools` 이름 호출처(T3/T4/T7) 일치.
