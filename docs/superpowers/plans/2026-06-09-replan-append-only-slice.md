# append-only 보정 replan 슬라이스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** verify-fix 루프가 소진된 뒤에도 검증이 실패하면, planner 가 검증 실패를 되먹여 보정 작업만 분해(append-only)해 기존 `runTask` 로 순차 실행하고 재검증하는 슬라이스를 추가한다(기본 비활성).

**Architecture:** `runProject`(`orchestrator.ts`)의 verify-fix for-loop 직후, `if (opts.verify)` 블록 안에 bounded replan 루프를 추가한다. `verifyOnce`/`emitVerify`/`fixImplementer`/`planner`/`runTask` 클로저를 전부 재사용한다. 노브 `RunOptions.maxReplanRounds`(기본 0=비활성)는 `maxVerifyFixRounds` 와 동일하게 RunOptions-only(engine 미배선)로 두어 IPC/preload/renderer 무변경. plan.ts 에 `buildReplanPrompt`/`planCorrectiveTasks` 추가 + `parsePlannedTasks` 에 `allowEmpty` 옵션.

**Tech Stack:** TypeScript, Electron 비의존 순수 코어, vitest(헤드리스), `PLANNER_SCHEMA` 네이티브 구조화 출력.

**선행 참고:** 설계 스펙 `docs/superpowers/specs/2026-06-09-replan-slice-design.md`. 품질 게이트(AGENTS.md): `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

---

## File Structure

- `src/main/core/orchestrator/plan.ts` — **수정**: `parsePlannedTasks` 에 `allowEmpty` 옵션, `buildReplanPrompt`·`planCorrectiveTasks` 신규, `VerificationResult` import.
- `src/main/core/orchestrator/plan.test.ts` — **수정**: 위 3가지 단위 테스트.
- `src/shared/types.ts` — **수정**: `OrchestratorEventType` 에 `'replan'` 1개 추가.
- `src/main/core/orchestrator/orchestrator.ts` — **수정**: `RunOptions.maxReplanRounds?` + replan 루프, `planCorrectiveTasks`/`PlannedTask` import.
- `src/main/core/orchestrator/orchestrator.test.ts` — **수정**: replan 통합 테스트 4종.

---

## Task 1: `parsePlannedTasks` allowEmpty 옵션 (plan.ts)

**Files:**
- Modify: `src/main/core/orchestrator/plan.ts:79-94` (`parsePlannedTasks`)
- Test: `src/main/core/orchestrator/plan.test.ts` (`parsePlannedTasks` describe 블록)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/main/core/orchestrator/plan.test.ts` 의 `describe('parsePlannedTasks', ...)` 블록 안(L63 `})` 직전)에 추가:

```ts
  it('allowEmpty 옵션이면 빈 목록을 [] 로 반환한다(보정 맥락)', () => {
    expect(parsePlannedTasks('{"tasks":[]}', { allowEmpty: true })).toEqual([])
    expect(parsePlannedTasks('[]', { allowEmpty: true })).toEqual([])
  })

  it('allowEmpty 없이는 빈 {tasks:[]} 도 throw 한다(기존 동작 보존)', () => {
    expect(() => parsePlannedTasks('{"tasks":[]}')).toThrow()
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/plan.test.ts`
Expected: FAIL — `parsePlannedTasks('{"tasks":[]}', { allowEmpty: true })` 가 throw 하여 첫 단언 실패(현재 시그니처는 2번째 인자 무시 + 빈 배열 throw).

- [ ] **Step 3: 최소 구현**

`src/main/core/orchestrator/plan.ts` 의 `parsePlannedTasks`(L79-94)를 아래로 교체:

```ts
/** LLM 계획 출력 → PlannedTask[] (불완전 입력에 관대하게). allowEmpty 면 빈 계획을 [] 로 허용(보정 맥락). */
export function parsePlannedTasks(text: string, opts?: { allowEmpty?: boolean }): PlannedTask[] {
  const arr = coerceTaskArray(text)
  if (!Array.isArray(arr)) throw new Error('계획은 JSON 배열이어야 합니다.')
  if (arr.length === 0) {
    if (opts?.allowEmpty) return []
    throw new Error('분해된 작업이 없습니다(빈 계획).')
  }

  return arr.map((raw, i): PlannedTask => {
    const o = (raw ?? {}) as Record<string, unknown>
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `작업 ${i + 1}`
    const description = typeof o.description === 'string' ? o.description : ''
    const role = typeof o.role === 'string' && VALID_ROLES.has(o.role) ? (o.role as AgentRole) : undefined
    const dependsOn = Array.isArray(o.dependsOn)
      ? o.dependsOn.filter((n): n is number => typeof n === 'number')
      : undefined
    return { title, description, role, dependsOn }
  })
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/plan.test.ts`
Expected: PASS (기존 `throws when the task list is empty` 포함 전부 녹색 — 기본 동작 불변).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/plan.ts src/main/core/orchestrator/plan.test.ts
git commit -m "feat(plan): parsePlannedTasks allowEmpty 옵션 — 보정 맥락 빈 계획 허용 (#12)"
```

---

## Task 2: `buildReplanPrompt` + `planCorrectiveTasks` (plan.ts)

**Files:**
- Modify: `src/main/core/orchestrator/plan.ts:1` (import), 파일 끝(`planTasks` 뒤)에 신규 함수 2개
- Test: `src/main/core/orchestrator/plan.test.ts` (import + 신규 describe 2개)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/main/core/orchestrator/plan.test.ts` 상단 import(L1-3)를 아래로 교체(이름 추가 + 타입 import):

```ts
import { describe, expect, it } from 'vitest'
import type { VerificationResult } from '../../../shared/types'
import type { LlmSession } from '../session/types'
import {
  buildPlannerPrompt,
  buildReplanPrompt,
  extractJsonArray,
  parsePlannedTasks,
  planCorrectiveTasks,
  planTasks,
  PLANNER_SCHEMA,
} from './plan'
```

파일 끝(L96 `})` 다음, `describe('PLANNER_SCHEMA' ...)` 블록 뒤)에 추가:

```ts
describe('buildReplanPrompt', () => {
  it('목표와 검증 실패 요약(kind/command/analysis)을 포함한다', () => {
    const p = buildReplanPrompt('목표X', [
      { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'boom', analysis: '테스트 깨짐', durationMs: 1 },
    ])
    expect(p).toContain('목표X')
    expect(p).toContain('npm test')
    expect(p).toContain('테스트 깨짐')
    expect(p).toContain('tasks')
  })
})

describe('planCorrectiveTasks', () => {
  const fail: VerificationResult = { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', durationMs: 1 }

  it('보정 작업 목록을 분해한다', async () => {
    const tasks = await planCorrectiveTasks('g', [fail], fakeSession('{"tasks":[{"title":"수정","description":"d"}]}'))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('수정')
  })

  it('보정 불필요({tasks:[]})면 빈 배열을 반환한다', async () => {
    const tasks = await planCorrectiveTasks('g', [fail], fakeSession('{"tasks":[]}'))
    expect(tasks).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/plan.test.ts`
Expected: FAIL — `buildReplanPrompt`/`planCorrectiveTasks` 가 `./plan` 에 없어 import/타입 에러로 실패.

- [ ] **Step 3: 최소 구현**

`src/main/core/orchestrator/plan.ts` 의 import(L1)를 아래로 교체:

```ts
import type { AgentRole, VerificationResult } from '../../../shared/types'
```

파일 끝(`planTasks` 함수 뒤)에 추가:

```ts
/** 검증 실패를 planner 에 되먹여 '추가 보정 작업'만 분해하도록 요청한다(풀 재계획 아님 — append-only). */
export function buildReplanPrompt(goal: string, failures: readonly VerificationResult[]): string {
  const failureText = failures
    .map((f) => `- [${f.kind}] ${f.command}\n${(f.analysis ?? f.stderr ?? '').trim()}`)
    .join('\n')
  return [
    '너는 소프트웨어 프로젝트 플래너다. 아래 목표의 구현이 끝났으나 검증(테스트/빌드/린트 등)이 실패했다.',
    '실패를 해소하기 위한 추가 보정 작업만 분해하라(기존 작업 재작성 금지). 보정이 불필요하면 빈 배열을 반환하라.',
    '반드시 아래 형식의 JSON 객체만 출력하라(설명/마크다운 금지):',
    '{"tasks":[{"title":"작업명","description":"무엇을 어떻게","role":"implementer","dependsOn":[]}]}',
    '보정이 필요 없으면 {"tasks":[]} 를 출력하라.',
    '',
    '목표:',
    goal,
    '',
    '검증 실패:',
    failureText,
  ].join('\n')
}

/** planner 세션으로 검증 실패에 대한 보정 작업을 분해한다. 보정 불필요면 빈 배열(allowEmpty). */
export async function planCorrectiveTasks(
  goal: string,
  failures: readonly VerificationResult[],
  planner: LlmSession,
  signal?: AbortSignal,
): Promise<PlannedTask[]> {
  const reply = await planner.send(buildReplanPrompt(goal, failures), {
    fresh: true,
    signal,
    responseSchema: { name: 'plan', schema: PLANNER_SCHEMA },
    bypassTools: true,
  })
  return parsePlannedTasks(reply, { allowEmpty: true })
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/plan.test.ts`
Expected: PASS (신규 4 + 기존 전부 녹색).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/plan.ts src/main/core/orchestrator/plan.test.ts
git commit -m "feat(plan): buildReplanPrompt + planCorrectiveTasks — 검증 실패 되먹임 보정 분해 (#12)"
```

---

## Task 3: `'replan'` 이벤트 타입 (shared/types.ts)

**Files:**
- Modify: `src/shared/types.ts:319` (`OrchestratorEventType` 유니온)

- [ ] **Step 1: 타입 추가**

`src/shared/types.ts` 의 `OrchestratorEventType`(L305-321)에서 `| 'verify.fixing'`(L319) 다음 줄에 추가:

```ts
  | 'verify.fixing'
  | 'replan'
  | 'summary'
```

- [ ] **Step 2: 타입 검사로 회귀 없음 확인**

Run: `npm run typecheck`
Expected: PASS (렌더러는 허용형 `if (e.type === ...)` 필터라 exhaustive switch 파손 없음).

- [ ] **Step 3: 커밋**

```bash
git add src/shared/types.ts
git commit -m "feat(types): OrchestratorEventType 에 replan 이벤트 추가 (#12)"
```

---

## Task 4: orchestrator replan 루프 (orchestrator.ts)

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts:15` (import), `:32` (RunOptions), `:390` 직후(replan 루프 삽입)
- Test: `src/main/core/orchestrator/orchestrator.test.ts` (`describe('runProject', ...)` 안)

- [ ] **Step 1: 실패하는 핵심 테스트 작성(보정→통과 + append-only)**

`src/main/core/orchestrator/orchestrator.test.ts` 의 `describe('runProject', ...)` 안(예: L877 `})` 다음, verify-fix 테스트 근처)에 추가:

```ts
  it('replans (append corrective task) and re-verifies to pass when maxReplanRounds > 0', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return plannerCalls === 1
          ? '[{"title":"T","description":"d"}]' // 초기 계획
          : '{"tasks":[{"title":"보정","description":"fix"}]}' // 보정 계획
      }),
    )
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const events: OrchestratorEvent[] = []
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 0, // verify-fix 격리 — replan 경로만 검증
      maxReplanRounds: 1,
      onEvent: (e) => events.push(e),
      verify: async () => {
        verifyCalls++
        const passed = verifyCalls >= 2 // 1차 실패, 보정 실행 후 2차 통과
        return [
          { kind: 'test', command: 'npm test', passed, exitCode: passed ? 0 : 1, stdout: '', stderr: passed ? '' : 'boom', analysis: passed ? undefined : 'boom', durationMs: 1 },
        ]
      },
    })

    expect(verifyCalls).toBe(2) // 최초 + 보정 후 재검증
    expect(implCalls).toBe(2) // 초기 작업 + 보정 작업
    expect(events.some((e) => e.type === 'replan')).toBe(true)
    const tasks = store.listTasks(result.projectId)
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['T', '보정'])) // append-only
    expect(tasks.find((t) => t.title === 'T')?.status).toBe('done') // 기존 작업 불변
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: FAIL — `maxReplanRounds` 가 `RunOptions` 에 없어 컴파일 에러(또는 루프 부재로 '보정' 작업 미생성·project 'failed').

- [ ] **Step 3: RunOptions 노브 추가**

`src/main/core/orchestrator/orchestrator.ts` 의 `RunOptions` 인터페이스에서 `maxVerifyFixRounds?: number`(L32) 다음 줄에 추가:

```ts
  maxVerifyFixRounds?: number
  /** 검증 실패 시 planner 가 보정 작업을 분해→append→실행→재검증하는 최대 라운드. 0/음수/NaN → 0(비활성). */
  maxReplanRounds?: number
```

- [ ] **Step 4: import 갱신**

`src/main/core/orchestrator/orchestrator.ts` 의 plan import(L15)를 아래로 교체:

```ts
import { planCorrectiveTasks, planTasks, type PlannedTask } from './plan'
```

- [ ] **Step 5: replan 루프 삽입**

`src/main/core/orchestrator/orchestrator.ts` 에서 verify-fix for-loop 의 닫는 `}`(L390) 다음, `if (opts.verify ...)` 블록의 닫는 `}`(L391) **직전**에 삽입:

```ts
      verifications = await verifyOnce()
      emitVerify(verifications)
    }

    // ── 5) (옵션) append-only 보정 replan ──
    // verify-fix 가 소진된 뒤에도 검증이 실패하면, planner 에게 검증 실패를 되먹여 '보정 작업'을
    // 받아 store 에 append(기존 작업 불변)하고 기존 runTask 로 순차 실행한 뒤 재검증한다.
    // 최대 maxReplanRounds 회(기본 0=비활성). planner 가 빈 목록을 주면 조기 종료(결정론).
    // 워크스페이스/CLI implementer 없거나 취소되면 생략(verify-fix 루프와 동일 가드).
    const requestedReplan = Math.floor(opts.maxReplanRounds ?? 0)
    const maxReplan = Number.isFinite(requestedReplan) && requestedReplan >= 0 ? requestedReplan : 0
    for (
      let round = 1;
      round <= maxReplan &&
      verifications.some((v) => !v.passed) &&
      !!opts.workspace &&
      !!fixImplementer &&
      fixImplementer.descriptor.kind === 'cli' &&
      !opts.signal?.aborted;
      round++
    ) {
      const failing = verifications.filter((v) => !v.passed)
      let corrective: PlannedTask[]
      try {
        corrective = await planCorrectiveTasks(goal, failing, planner, opts.signal)
      } catch (err) {
        // 보정 계획 실패는 완료된 작업을 무효화하지 않는다 — 표면화(비-silent)하고 replan 중단.
        emit({
          type: 'replan',
          message: `보정 계획 실패: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id, round },
        })
        break
      }
      if (corrective.length === 0) {
        emit({ type: 'replan', message: '보정 작업 없음 — replan 종료', data: { projectId: project.id, round, count: 0 } })
        break
      }
      emit({
        type: 'replan',
        message: `보정 작업 ${corrective.length}개 추가 (라운드 ${round})`,
        data: { projectId: project.id, round, count: corrective.length },
      })
      // append-only: 보정 작업은 의존성 없는 평면 목록 → store 에 추가하고 순차 실행(위상 sweep 불필요).
      for (const ct of corrective) {
        if (opts.signal?.aborted) break
        const created = store.createTask({
          projectId: project.id,
          title: ct.title,
          description: ct.description,
          role: ct.role ?? 'implementer',
        })
        await runTask(created)
      }
      verifications = await verifyOnce()
      emitVerify(verifications)
    }
  }
```

> 참고: 위 블록의 첫 3줄(`verifications = await verifyOnce()` … `}`)은 기존 verify-fix for-loop 의 마지막 부분으로, 삽입 위치를 잡기 위한 앵커다. 실제 추가분은 `// ── 5)` 주석부터 마지막 `}` 직전까지다.

- [ ] **Step 6: 핵심 테스트 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS (신규 replan 테스트 + 기존 verify-fix 테스트 전부 녹색).

- [ ] **Step 7: 가드 테스트 3종 추가(기본0 / 상한소진 / 빈목록)**

같은 `describe('runProject', ...)` 안, Step 1 테스트 다음에 추가:

```ts
  it('does not replan when maxReplanRounds is unset (default 0)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return '[{"title":"T","description":"d"}]'
      }),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 0,
      // maxReplanRounds 미지정 → 기본 0(비활성)
      verify: async () => [
        { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', analysis: 'x', durationMs: 1 },
      ],
    })
    expect(plannerCalls).toBe(1) // 초기 계획만, 보정 계획 호출 없음
    expect(store.listTasks(result.projectId)).toHaveLength(1)
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('runs exactly maxReplanRounds replan cycles before giving up', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return '{"tasks":[{"title":"보정","description":"fix"}]}' // 초기·보정 모두 1개
      }),
    )
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 0,
      maxReplanRounds: 2,
      verify: async () => {
        verifyCalls++
        return [
          { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', analysis: 'x', durationMs: 1 },
        ]
      },
    })
    expect(plannerCalls).toBe(3) // 초기 1 + 보정 2라운드 (off-by-one 이면 4)
    expect(verifyCalls).toBe(3) // 최초 + 보정 2라운드 재검증
    expect(implCalls).toBe(3) // 초기 작업 1 + 보정 작업 2
    expect(store.listTasks(result.projectId)).toHaveLength(3) // 초기 1 + 보정 2 append
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('stops replanning early when the planner returns no corrective tasks', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return plannerCalls === 1 ? '[{"title":"T","description":"d"}]' : '{"tasks":[]}'
      }),
    )
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 0,
      maxReplanRounds: 3,
      verify: async () => {
        verifyCalls++
        return [
          { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', analysis: 'x', durationMs: 1 },
        ]
      },
    })
    expect(plannerCalls).toBe(2) // 초기 + 보정계획 1회(빈 목록) → 조기 break
    expect(implCalls).toBe(1) // 초기 작업만, 보정 작업 실행 0
    expect(store.listTasks(result.projectId)).toHaveLength(1)
    expect(verifyCalls).toBe(1) // 빈 보정이라 재검증 없음
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })
```

- [ ] **Step 8: 전체 가드 테스트 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS (replan 4종 + 기존 전부 녹색).

- [ ] **Step 9: 커밋**

```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(orchestrator): append-only 보정 replan 루프 — 검증 실패 시 보정 작업 append+실행+재검증 (#12)"
```

---

## Task 5: 품질 게이트 4종 + 최종 확인

**Files:** (없음 — 검증만)

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: PASS (0 에러).

- [ ] **Step 2: lint(경고 0)**

Run: `npm run lint`
Expected: PASS (경고 0). `err`/`round`/`ct` 미사용 경고가 없어야 한다.

- [ ] **Step 3: 전체 테스트**

Run: `npm test`
Expected: PASS (기존 + 신규 전부 녹색).

- [ ] **Step 4: build(기동 smoke)**

Run: `npm run build`
Expected: 성공.

- [ ] **Step 5: 최종 커밋(필요 시 lint 자동수정 반영)**

lint/build 가 파일을 바꿨으면:

```bash
git add -A
git commit -m "chore(orchestrator): replan 슬라이스 게이트 통과 정리 (#12)"
```

바뀐 게 없으면 생략.

---

## Self-Review (작성자 점검 결과)

**1. Spec coverage** — 스펙 각 절 → 태스크 매핑:
- RunOptions.maxReplanRounds(①A) → Task 4 Step 3. ✓
- replan 이벤트(③) → Task 3. ✓
- bounded loop + append-only + 종료보장 + 위험게이트 상속 + 취소정합 → Task 4 Step 5. ✓
- parsePlannedTasks allowEmpty(②) → Task 1. ✓
- buildReplanPrompt/planCorrectiveTasks → Task 2. ✓
- TDD 5종(기본0/보정→통과/상한소진/빈목록/append-only) → Task 4 Step 1·7 (append-only 는 핵심 테스트에 단언 병합). ✓
- 게이트 4종 → Task 5. ✓

**2. Placeholder scan** — TBD/TODO/“적절히 처리” 없음. 모든 코드 스텝에 완전한 코드 포함. ✓

**3. Type consistency** — `parsePlannedTasks(text, { allowEmpty })` 시그니처가 Task 1(정의)·Task 2(`planCorrectiveTasks` 사용)에서 일치. `PlannedTask`·`VerificationResult`·`LlmSession` import 경로 일치. `store.createTask({ projectId, title, description, role })` 가 `store/types.ts` 시그니처와 일치. `'replan'` 이벤트 타입이 Task 3(정의)·Task 4(emit) 일치. ✓

---

## 비범위 / 후속 (이 PR 밖)

- `maxReplanRounds` 프로덕션 활성화(RunProjectRequest·engine·UI 배선) — 별도 PR.
- 이슈 #27 로드맵 표 갱신(#12 슬라이스 체크) — 머지 후.
- #26 후속(b) 스트리밍 400 가드 — latent, 별도.
