# #166 오케스트레이션 최종 status 정직화 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오케스트레이션 종료 시 최종 project status 가 task 집계를 반영(`partial` 신설)하고, no-op verify 스크립트를 "검증 통과"로 위장하지 않도록 정직화한다.

**Architecture:** 두 독립 축. (A) `orchestrator.ts` 최종 status 계산을 `store.listTasks()` 집계 기반으로 바꾸고 `Project.status` union 에 `partial` 추가. (B) `verify/run.ts` 가 워크스페이스 `package.json` 스크립트를 읽어 no-op 을 태깅하고, `emitVerify` 가 전부 no-op 이면 메시지를 바꾼다. event type(`project.done`·`verify.passed`)·`data.projectId` 는 불변.

**Tech Stack:** TypeScript, Electron(main core), vitest. 순수 core(Electron import 없음).

## Global Constraints
- **event type `'project.done'`·`data.projectId` 는 절대 변경 금지** — engine `activeRuns` 정리·렌더러 running 잠금이 event-type 기반으로 의존. 오직 project status 값·메시지 텍스트만 바꾼다.
- **`verify.*` event type 은 `passed`/`failed` 2종 유지** — 새 type 추가 금지(렌더러 전이 ripple 회피).
- **단일 breakdown 문자열**을 verify-fail·partial·집계-failed 메시지가 공유(포맷 drift 방지).
- **`isNoOpScript` 는 false negative 감수·false positive 0** — `'' | 'exit 0' | 'true' | ':'`(+끝 `;` 1개)만.
- 품질 게이트 4종 green: `npm run typecheck` · `npm run lint` · `npm run test` · `npm run format:check`.
- `npmVerifyCommands` 는 **동기 유지**(호출부 `engine.ts:216` ripple 회피).

## File Structure
- `src/shared/types.ts` — `Project.status` union += `'partial'`; `VerificationResult` += `noop?: boolean`.
- `src/main/core/verify/run.ts` — `VerifyCommand` += `noop?`; 신규 `isNoOpScript`; `npmVerifyCommands` package.json 읽기; `runVerification` noop 전파.
- `src/main/core/verify/run.test.ts` — Bug B 단위 테스트.
- `src/main/core/orchestrator/orchestrator.ts` — `emitVerify` all-noop 메시지; 최종 status 집계 + breakdown 메시지.
- `src/main/core/orchestrator/orchestrator.test.ts` — partial/failed 집계·noop 메시지 테스트 + 기존 2건 기대값 갱신.
- `src/renderer/ui.ts` — `statusColor` `partial` 케이스.
- `src/renderer/ui.test.ts` — `statusColor('partial')`.

---

### Task 1: Bug B — verify 레이어 no-op 태깅

**Files:**
- Modify: `src/shared/types.ts` (`VerificationResult`)
- Modify: `src/main/core/verify/run.ts` (`VerifyCommand`·`isNoOpScript`·`npmVerifyCommands`·`runVerification`)
- Test: `src/main/core/verify/run.test.ts`

**Interfaces:**
- Produces: `isNoOpScript(body?: string): boolean`; `VerifyCommand.noop?: boolean`; `VerificationResult.noop?: boolean`; `npmVerifyCommands(cwd)` 가 각 명령에 `noop` 태깅.

- [ ] **Step 1: 실패 테스트 작성** — `src/main/core/verify/run.test.ts` 의 import 에 `isNoOpScript, npmVerifyCommands` 추가(기존 import 블록 2-9행에 병합), 파일 끝에 describe 추가.

```ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('isNoOpScript', () => {
  it('자명한 no-op 만 true (보수적)', () => {
    for (const s of ['', '   ', 'exit 0', 'true', ':', 'exit 0;', ' exit 0 ;']) {
      expect(isNoOpScript(s)).toBe(true)
    }
    for (const s of ['echo ok', 'npm run test:unit', 'tsc', 'exit 1', 'exit 0;;', undefined]) {
      expect(isNoOpScript(s)).toBe(false)
    }
  })
})

describe('npmVerifyCommands', () => {
  it('package.json 스크립트가 no-op 이면 noop:true, 실제면 noop:false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verify-noop-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { typecheck: 'exit 0', lint: 'exit 0', test: 'exit 0' } }),
      )
      expect(npmVerifyCommands(dir).every((c) => c.noop === true)).toBe(true)

      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest run' } }),
      )
      expect(npmVerifyCommands(dir).every((c) => c.noop === false)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('package.json/스크립트 누락 시 noop 미설정(undefined)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verify-nopkg-'))
    try {
      expect(npmVerifyCommands(dir).every((c) => c.noop === undefined)).toBe(true)
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }))
      const cmds = npmVerifyCommands(dir)
      expect(cmds.find((c) => c.kind === 'typecheck')?.noop).toBe(false)
      expect(cmds.find((c) => c.kind === 'lint')?.noop).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: runVerification noop 전파 테스트 추가** — `describe('runVerification', …)` 안에 추가.

```ts
  it('cmd.noop 을 결과로 전파한다', async () => {
    const runner: VerifyRunner = async () => ({ code: 0, stdout: '', stderr: '' })
    const r = await runVerification(
      { kind: 'test', command: 'npm', args: ['test'], noop: true },
      { runner },
    )
    expect(r.noop).toBe(true)
  })
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/core/verify/run.test.ts`
Expected: FAIL — `isNoOpScript`/`npmVerifyCommands` 의 `noop` 미존재, import 오류.

- [ ] **Step 4: 타입 추가** — `src/shared/types.ts` `VerificationResult` 에 필드 추가(기존 `durationMs: number` 다음 줄).

```ts
  /** verify 스크립트가 자명한 no-op(exit 0 류)이라 실제 검사를 안 했음 (있을 때만). */
  noop?: boolean
```

- [ ] **Step 5: run.ts 구현** — `src/main/core/verify/run.ts` 수정.

상단 import 에 추가:
```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
```

`VerifyCommand` 인터페이스에 필드 추가:
```ts
  /** package.json 스크립트가 자명한 no-op 인지(npmVerifyCommands 가 태깅). */
  noop?: boolean
```

`isNoOpScript` 추가(파일 끝):
```ts
/**
 * package.json 스크립트 본문이 "아무 검사도 안 하는" 자명한 no-op 인지.
 * 보수적 — false negative(놓침)는 감수하고 false positive(실제 검사 오판) 0 을 우선한다.
 * 끝 세미콜론은 1개만 허용(`exit 0;;` 는 비-noop). `echo`·`|| true`·wrapper 는 제외.
 */
export function isNoOpScript(body?: string): boolean {
  if (body === undefined) return false
  const n = body.trim().replace(/;$/, '').trim()
  return n === '' || n === 'exit 0' || n === 'true' || n === ':'
}

/** <cwd>/package.json 의 scripts 맵 (읽기/파싱 실패·없음 → undefined = 알 수 없음). */
function readPackageScripts(cwd: string): Record<string, string> | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return pkg.scripts
  } catch {
    return undefined
  }
}
```

`npmVerifyCommands` 교체:
```ts
/** JS/TS 프로젝트 표준 검증 명령 세트 (npm 스크립트 기반). package.json 을 읽어 no-op 을 태깅한다. */
export function npmVerifyCommands(cwd: string): VerifyCommand[] {
  const scripts = readPackageScripts(cwd)
  const mk = (kind: VerifyKind, name: string, args: string[]): VerifyCommand => {
    const cmd: VerifyCommand = { kind, command: 'npm', args, cwd }
    const body = scripts?.[name]
    if (body !== undefined) cmd.noop = isNoOpScript(body)
    return cmd
  }
  return [
    mk('typecheck', 'typecheck', ['run', 'typecheck']),
    mk('lint', 'lint', ['run', 'lint']),
    mk('test', 'test', ['test']),
  ]
}
```

`runVerification` 의 두 return(spawnError 분기·정상 분기) 마지막에 `noop: cmd.noop,` 추가:
```ts
  // spawnError 분기 return { … durationMs } 에 추가:
      durationMs,
      noop: cmd.noop,
    }
  // 정상 분기 return { … durationMs } 에 추가:
    durationMs,
    noop: cmd.noop,
  }
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx vitest run src/main/core/verify/run.test.ts`
Expected: PASS (전체 describe).

- [ ] **Step 7: 커밋**

```bash
git add src/shared/types.ts src/main/core/verify/run.ts src/main/core/verify/run.test.ts
git commit -m "feat(#166): verify 레이어 no-op 스크립트 태깅 (isNoOpScript·package.json 읽기)"
```

---

### Task 2: Bug B — orchestrator emitVerify all-noop 메시지

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts` (`emitVerify`, 804-817)
- Test: `src/main/core/orchestrator/orchestrator.test.ts`

**Interfaces:**
- Consumes: `VerificationResult.noop` (Task 1).
- Produces: 전부 no-op 통과 시 `verify.passed` event message = `검증 항목 없음 (no-op 스크립트 — 실제 검사 없음)`.

- [ ] **Step 1: 실패 테스트 작성** — `orchestrator.test.ts` 에 추가(기존 verify 테스트 근처). `OrchestratorEvent` 는 이미 import 됨.

```ts
  it('#166: verify 결과가 전부 no-op 이면 "검증 항목 없음" 으로 표면화한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const events: OrchestratorEvent[] = []
    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      onEvent: (e) => events.push(e),
      verify: async () => [
        { kind: 'typecheck', command: 'npm run typecheck', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, noop: true },
        { kind: 'test', command: 'npm test', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, noop: true },
      ],
    })
    const v = events.find((e) => e.type === 'verify.passed')
    expect(v?.message).toContain('검증 항목 없음')
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts -t "전부 no-op"`
Expected: FAIL — message 가 `검증 통과`.

- [ ] **Step 3: emitVerify 구현** — `orchestrator.ts` 의 `emitVerify`(804-817) 교체.

```ts
    const emitVerify = (v: readonly VerificationResult[]): void => {
      if (v.length === 0) return // 실행 오류는 verifyOnce 가 이미 방출
      const ok = v.every((r) => r.passed)
      const allNoop = v.every((r) => r.noop) // 전부 자명한 no-op = 실제 검사 0
      emit({
        type: ok ? 'verify.passed' : 'verify.failed',
        message: ok
          ? allNoop
            ? '검증 항목 없음 (no-op 스크립트 — 실제 검사 없음)'
            : '검증 통과'
          : `검증 실패: ${v
              .filter((r) => !r.passed)
              .map((r) => r.kind)
              .join(', ')}`,
        data: { projectId: project.id },
      })
    }
```

- [ ] **Step 4: 테스트 통과 + 기존 verify 테스트 회귀 없음 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS (신규 + 기존 — noop 없는 verify 통과 테스트는 `allNoop=false` 라 `검증 통과` 유지).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(#166): 전부 no-op verify 를 '검증 항목 없음' 으로 정직화"
```

---

### Task 3: Bug A — `partial` status 타입 + 렌더러 색상

**Files:**
- Modify: `src/shared/types.ts:298` (`Project.status`)
- Modify: `src/renderer/ui.ts` (`statusColor`)
- Test: `src/renderer/ui.test.ts`

**Interfaces:**
- Produces: `Project.status` 가 `'partial'` 을 허용; `statusColor('partial') === 'var(--warn)'`.

- [ ] **Step 1: 실패 테스트 작성** — `src/renderer/ui.test.ts` 의 `statusColor` describe 안, `running…verifying` for-루프 다음 줄에 추가.

```ts
    expect(statusColor('partial')).toBe('var(--warn)')
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/ui.test.ts -t "statusColor"`
Expected: FAIL — `partial` 이 default `var(--dim)` 으로 떨어짐.

- [ ] **Step 3: 타입 + statusColor 구현**

`src/shared/types.ts:298` 교체:
```ts
  status: 'planning' | 'executing' | 'verifying' | 'done' | 'partial' | 'failed'
```

`src/renderer/ui.ts` `statusColor` 의 `case 'failed'` 위에 추가:
```ts
    case 'partial':
      // 부분 완료 — done(초록)/failed(빨강)과 구분되는 진행 톤(앰버).
      return 'var(--warn)'
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/ui.test.ts -t "statusColor"`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/renderer/ui.ts src/renderer/ui.test.ts
git commit -m "feat(#166): Project.status 에 partial 추가 + statusColor 매핑"
```

---

### Task 4: Bug A — orchestrator 최종 status 집계 + 메시지

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts` (최종 status 블록, 994-1011)
- Test: `src/main/core/orchestrator/orchestrator.test.ts` (신규 + 기존 2건 갱신 + 1건 단언 정밀화)

**Interfaces:**
- Consumes: `Project.status` `'partial'`(Task 3), `store.listTasks(projectId): Task[]`.
- Produces: 최종 status = aggregate(aborted/verifyFailed→failed → all done/빈→done → doneCount>0→partial → else failed); `project.done` 메시지에 breakdown.

- [ ] **Step 1: 신규 실패 테스트 — 기존 테스트 2건 기대값 갱신**

(a) `'marks a task failed and continues when the implementer throws'`(883행) — runProject 호출 전에 `const events: OrchestratorEvent[] = []` 선언, opts 에 `onEvent: (e) => events.push(e),` 추가, 말미 블록 교체:
```ts
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0].status).toBe('failed') // 첫 작업은 예외로 실패
    expect(result.tasks[1].status).toBe('done') // 둘째 작업은 계속 진행
    // #166: 1 done · 1 failed → 전체 실행은 계속되지만 최종 status 는 partial(거짓 done 금지)
    expect(store.getProject(result.projectId)?.status).toBe('partial')
    const done = events.find((e) => e.type === 'project.done')
    expect(done?.message).toContain('부분 완료')
    expect(done?.message).toContain('완료 1')
    expect(done?.message).toContain('실패 1')
```

(b) `'fails cyclic tasks instead of hanging'`(1039행) — 말미 교체:
```ts
    expect(result.tasks.every((t) => t.status === 'failed')).toBe(true)
    // #166: doneCount 0 → 최종 status failed(거짓 done 금지)
    expect(store.getProject(result.projectId)?.status).toBe('failed')
```

(c) `'검증 실패 실행의 project.done 메시지는 …'`(2419행) — 단언 정밀화(breakdown 의 "완료 N" 카운트와 충돌 회피, 의도=「프로젝트 완료」위장 금지 보존):
```ts
    expect(done?.message).toContain('실패') // 검증 실패를 '완료'로 위장하지 않는다
    expect(done?.message).not.toContain('프로젝트 완료')
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts -t "continues when the implementer throws"`
Expected: FAIL — 현재 status 가 `done`, 메시지에 breakdown 없음.

- [ ] **Step 3: 최종 status 블록 구현** — `orchestrator.ts` 994-1011 교체.

```ts
  // ── 7) 최종 status / 종료 메시지 ── task 집계를 반영(#166).
  // 취소·검증 실패는 항상 failed(검증=최종 품질 게이트, task 집계보다 우선). 그 외엔 task 집계:
  // 전부 done→done · 일부만 done→partial · 0 done→failed. (빈 플랜은 planTasks 가 throw 하므로
  // total===0 은 도달 불가 방어 가드 — done 으로 흡수.)
  const finalTasks = store.listTasks(project.id)
  const total = finalTasks.length
  const doneCount = finalTasks.filter((t) => t.status === 'done').length
  // 단일 breakdown — verify-fail·partial·집계-failed 메시지가 공유(포맷 drift 방지).
  const breakdown =
    `총 ${total} · 완료 ${doneCount} · 실패 ${finalTasks.filter((t) => t.status === 'failed').length}` +
    ` · 건너뜀 ${finalTasks.filter((t) => t.status === 'skipped').length}`

  const signalAborted = opts.signal?.aborted === true
  const verifyFailed =
    !!opts.verify &&
    !(
      verifications !== undefined &&
      verifications.length > 0 &&
      verifications.every((v) => v.passed)
    )

  let finalStatus: 'done' | 'partial' | 'failed'
  if (signalAborted || verifyFailed) finalStatus = 'failed'
  else if (total === 0 || doneCount === total) finalStatus = 'done'
  else if (doneCount > 0) finalStatus = 'partial'
  else finalStatus = 'failed'
  store.updateProject(project.id, { status: finalStatus })

  // project.done 메시지는 실제 종료 상태를 반영한다 — 취소/검증 실패/부분 완료를 '완료'로 위장하지 않는다(#7·#166).
  // 이벤트 타입('project.done')·data.projectId 는 불변 — engine activeRuns 정리·렌더러 running 잠금이 의존.
  const doneMessage = signalAborted
    ? `프로젝트 취소됨: ${project.title}`
    : verifyFailed
      ? `프로젝트 실패: ${project.title} (검증 실패 · ${breakdown})`
      : finalStatus === 'partial'
        ? `프로젝트 부분 완료: ${project.title} (${breakdown})`
        : finalStatus === 'failed'
          ? `프로젝트 실패: ${project.title} (${breakdown})`
          : `프로젝트 완료: ${project.title}`
  emit({ type: 'project.done', message: doneMessage, data: { projectId: project.id } })

  return { projectId: project.id, tasks: store.listTasks(project.id), summary, verifications }
}
```

> 주의: 교체 범위는 기존 994-1011(상태 계산 + emit)와 마지막 `return`(1013) 까지 포함한다. 기존 `return` 한 줄만 남기고 중복 금지.

- [ ] **Step 4: 대상 테스트 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts -t "continues when the implementer throws"`
그리고: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts -t "cyclic"`
Expected: 둘 다 PASS.

- [ ] **Step 5: orchestrator 전체 회귀 확인(누락 ripple 안전망)**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS. 실패 시 — 다른 `getProject().status` 기대값이 새 집계로 바뀌었는지 확인하고 의도대로 갱신(감사 완료분: 920→partial·1065→failed·2419 단언만 변경 예정).

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(#166): 최종 project status 를 task 집계로 결정 (partial 신설 + breakdown 메시지)"
```

---

### Task 5: 전체 게이트 4종 + 전수 회귀

**Files:** (없음 — 검증만; 실패 시 해당 파일 수정)

- [ ] **Step 1: 전체 테스트**

Run: `npm run test`
Expected: PASS (전 스위트). 실패 시 root cause 수정 후 재실행.

- [ ] **Step 2: 타입체크**

Run: `npm run typecheck`
Expected: 에러 0.

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: 에러 0.

- [ ] **Step 4: 포맷**

Run: `npm run format:check`
Expected: 위반 0. 위반 시 `npm run format` 후 재확인·커밋.

- [ ] **Step 5: 게이트 통과 시 커밋(포맷 변경 있었을 때만)**

```bash
git add -A && git commit -m "chore(#166): 포맷·게이트 정리"
```

---

## Self-Review

**1. Spec coverage:**
- Bug A `partial` 타입 → Task 3. 집계 우선순위·breakdown 메시지 → Task 4. 렌더러 색상 → Task 3. ✓
- Bug B `isNoOpScript`·package.json 읽기·noop 전파 → Task 1. emitVerify all-noop 메시지 → Task 2. `VerificationResult.noop` → Task 1. ✓
- 기존 테스트 전수 감사(920→partial·1065→failed·2419 단언) → Task 4 Step 1·5. ✓
- `statusColor('partial')` 테스트 → Task 3. ✓
- 범위 밖(일부 no-op 메시지·새 event type·allPassed 변경) 미포함. ✓

**2. Placeholder scan:** 모든 step 에 실제 코드/명령 포함. TBD/TODO 없음. ✓

**3. Type consistency:** `isNoOpScript`·`npmVerifyCommands`·`VerifyCommand.noop`·`VerificationResult.noop`·`Project.status 'partial'`·`finalStatus: 'done'|'partial'|'failed'` 전 태스크 일관. `breakdown` 포맷 단일 문자열. ✓

**4. 도달불가 가드:** `total===0 → done` 은 빈 플랜이 `planTasks` 에서 throw(테스트 804·811 이 failed 로 고정)하므로 실제 도달 불가 — 별도 테스트 불필요(Codex 제안한 "빈 플랜 done" 테스트는 존재하지 않는 경로라 미작성).
