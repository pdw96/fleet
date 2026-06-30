# 의도 elicitation 1차 슬라이스 (선택형 폼) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ProjectPanel goal 입력 위에 분야 무관 선택형 elicitation 폼을 추가하고, "goal에 반영" 버튼이 폼 답을 결정적으로 합성해 goal textarea 에 써넣는다(렌더러 ONLY·무회귀).

**Architecture:** 순수 모듈 `elicitation.ts`(타입·필드 메타·`composeGoal`·공유 헬퍼)를 만들고, `ProjectPanel.tsx` 가 그 모듈로 폼 UI + 접합 버튼 + dirty-form 힌트를 배선한다. 실행 경로(`run()` → `runProject({ goal })`)와 main/IPC/orchestrator/shared 타입은 **무변경** — textarea `goal` 상태가 단일 source of truth.

**Tech Stack:** TypeScript · React 19 · Vitest + @testing-library/react (jsdom) · electron-vite.

## Global Constraints

- **렌더러 ONLY** — `src/main/**`·`src/preload/**`·`src/shared/types.ts` 무변경. `RunProjectRequest` 미확장.
- **`run()` 은 절대 `composeGoal` 을 호출하지 않는다** — 실행 입력은 항상 textarea `goal` 상태.
- **`composeGoal` 은 결정적 함수(멱등 아님)** — 중복 방지는 "접합 후 폼 비움" UI 규칙.
- **부재(absent) 판정 단일화** — 텍스트 `trim().length>0` / select `''` 아님. compose 와 dirty-form 힌트가 같은 `hasAnyPresent` 사용.
- 참고 레퍼런스 필드 = **텍스트-only**(링크/스샷=future).
- 품질 개선은 이번 수용기준 아님 — 성공기준 = goal 보강 UX + 무회귀.
- 품질 게이트 4종 green: `npm run typecheck` · `npm run lint`(경고도 0) · `npm test` · `npm run build`. 푸시 전 `npm run format:check` 통과(필요 시 `npx prettier --write`).
- 스펙: `docs/superpowers/specs/2026-06-30-issue171-intent-elicitation-design.md`.

---

## 파일 구조

- **Create** `src/renderer/components/elicitation.ts` — `ElicitationFields`·`Completeness` 타입, `EMPTY_FIELDS`, `ELICITATION_FIELDS`(메타·순서), `isPresent`·`hasAnyPresent`, `composeGoal`. React 비의존·부수효과 0.
- **Create** `src/renderer/components/elicitation.test.ts` — `composeGoal`·헬퍼 단위테스트.
- **Modify** `src/renderer/components/ProjectPanel.tsx` — elicitation 상태·폼 UI(textarea 위)·"goal에 반영" 버튼·dirty-form 힌트. `run()` 무변경.
- **Modify** `src/renderer/components/ProjectPanel.test.tsx` — 접합/비움/무회귀/힌트 테스트 추가.

---

## Task 1: 순수 모듈 `elicitation.ts` (composeGoal + 헬퍼)

**Files:**
- Create: `src/renderer/components/elicitation.ts`
- Test: `src/renderer/components/elicitation.test.ts`

**Interfaces:**
- Produces:
  - `type Completeness = '' | 'prototype' | 'standard' | 'high'`
  - `interface ElicitationFields { completeness: Completeness; audience: string; reference: string; success: string; constraints: string }`
  - `const EMPTY_FIELDS: ElicitationFields`
  - `interface FieldMeta { key: keyof ElicitationFields; label: string; kind: 'text' | 'select'; placeholder?: string; options?: { value: Completeness; label: string }[] }`
  - `const ELICITATION_FIELDS: FieldMeta[]`
  - `function isPresent(value: string): boolean`
  - `function hasAnyPresent(fields: ElicitationFields): boolean`
  - `function composeGoal(base: string, fields: ElicitationFields): string`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/components/elicitation.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  composeGoal,
  hasAnyPresent,
  isPresent,
  EMPTY_FIELDS,
  type ElicitationFields,
} from './elicitation'

const fields = (over: Partial<ElicitationFields> = {}): ElicitationFields => ({
  ...EMPTY_FIELDS,
  ...over,
})

describe('isPresent / hasAnyPresent', () => {
  it('treats empty and whitespace-only as absent', () => {
    expect(isPresent('')).toBe(false)
    expect(isPresent('   ')).toBe(false)
    expect(isPresent('x')).toBe(true)
  })

  it('hasAnyPresent is false for empty fields and select 미지정', () => {
    expect(hasAnyPresent(EMPTY_FIELDS)).toBe(false)
    expect(hasAnyPresent(fields({ completeness: '' }))).toBe(false)
    expect(hasAnyPresent(fields({ audience: '   ' }))).toBe(false)
  })

  it('hasAnyPresent is true when any field is present', () => {
    expect(hasAnyPresent(fields({ audience: '개발자' }))).toBe(true)
    expect(hasAnyPresent(fields({ completeness: 'high' }))).toBe(true)
  })
})

describe('composeGoal', () => {
  it('returns base unchanged when all fields absent (무회귀 핵심)', () => {
    const base = '할 일 앱 만들기'
    expect(composeGoal(base, EMPTY_FIELDS)).toBe(base)
  })

  it('ignores whitespace-only text and select 미지정', () => {
    const base = '앱'
    expect(composeGoal(base, fields({ audience: '   ', completeness: '' }))).toBe(base)
  })

  it('appends a single text field as a labeled line', () => {
    expect(composeGoal('앱', fields({ audience: '초등학생' }))).toBe(
      '앱\n\n[추가 맥락]\n- 대상 사용자: 초등학생',
    )
  })

  it('maps the completeness select to its phrase', () => {
    expect(composeGoal('앱', fields({ completeness: 'high' }))).toBe(
      '앱\n\n[추가 맥락]\n- 완성도 수준: 높은 완성도 (폴리시·엣지케이스·견고함까지 투자)',
    )
  })

  it('keeps fixed field order in one block for multiple fields', () => {
    expect(
      composeGoal(
        '앱',
        fields({ constraints: '바닐라 JS', audience: '개발자', completeness: 'standard' }),
      ),
    ).toBe(
      '앱\n\n[추가 맥락]\n- 완성도 수준: 표준 (실사용 가능한 완성도)\n- 대상 사용자: 개발자\n- 제약·필수: 바닐라 JS',
    )
  })

  it('omits leading blank lines when base is empty', () => {
    expect(composeGoal('', fields({ audience: '개발자' }))).toBe('[추가 맥락]\n- 대상 사용자: 개발자')
  })

  it('normalizes only trailing whitespace on the join boundary (preserves base body)', () => {
    expect(composeGoal('앱  \n', fields({ audience: '개발자' }))).toBe(
      '앱\n\n[추가 맥락]\n- 대상 사용자: 개발자',
    )
  })

  it('is deterministic (same input → same output)', () => {
    const f = fields({ success: '로그인 동작' })
    expect(composeGoal('앱', f)).toBe(composeGoal('앱', f))
  })

  it('is NOT idempotent — re-applying same fields duplicates the block (contract)', () => {
    const f = fields({ audience: '개발자' })
    const once = composeGoal('앱', f)
    expect(composeGoal(once, f)).not.toBe(once)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/components/elicitation.test.ts`
Expected: FAIL — `Failed to resolve import "./elicitation"` (module not yet created).

- [ ] **Step 3: Write the implementation**

Create `src/renderer/components/elicitation.ts`:

```typescript
/**
 * #171 의도 elicitation — 선택형 폼 답을 결정적으로 goal 에 접합하는 순수 모듈(렌더러).
 * React 비의존·부수효과 0. 실행 경로(run/IPC/orchestrator)와 무관 — 합성된 문자열은
 * 호출측이 goal textarea 에 써넣고, 기존 runProject({ goal }) 경로가 그대로 전송한다.
 */

/** 완성도 수준 select 값. ''=미지정(접합 미기여). */
export type Completeness = '' | 'prototype' | 'standard' | 'high'

export interface ElicitationFields {
  completeness: Completeness
  audience: string
  reference: string
  success: string
  constraints: string
}

export const EMPTY_FIELDS: ElicitationFields = {
  completeness: '',
  audience: '',
  reference: '',
  success: '',
  constraints: '',
}

/** completeness 옵션값 → planner 가 읽는 문구. '' 는 미포함이라 키 없음(planner 가 도메인 맥락에 맞게 해석). */
const COMPLETENESS_PHRASE: Record<Exclude<Completeness, ''>, string> = {
  prototype: '빠른 프로토타입 (핵심 동작 위주, 폴리시 최소)',
  standard: '표준 (실사용 가능한 완성도)',
  high: '높은 완성도 (폴리시·엣지케이스·견고함까지 투자)',
}

export interface FieldMeta {
  key: keyof ElicitationFields
  label: string
  kind: 'text' | 'select'
  placeholder?: string
  options?: { value: Completeness; label: string }[]
}

/** 폼 필드 메타 — 라벨·입력종류·접합 순서(이 배열 순서가 [추가 맥락] 블록 순서). 전부 분야 무관·선택. */
export const ELICITATION_FIELDS: FieldMeta[] = [
  {
    key: 'completeness',
    label: '완성도 수준',
    kind: 'select',
    options: [
      { value: '', label: '미지정' },
      { value: 'prototype', label: '빠른 프로토타입' },
      { value: 'standard', label: '표준' },
      { value: 'high', label: '높은 완성도' },
    ],
  },
  {
    key: 'audience',
    label: '대상 사용자',
    kind: 'text',
    placeholder: '누가 사용하나 (예: 초등학생, 사내 개발자)',
  },
  {
    key: 'reference',
    label: '참고 레퍼런스 / 원하는 결과물 느낌',
    kind: 'text',
    placeholder: '"이것처럼" (예: Stripe API처럼, 레트로 게임풍)',
  },
  {
    key: 'success',
    label: '성공 기준',
    kind: 'text',
    placeholder: '무엇이 되면 잘 된 것 (예: JWT 로그인 동작)',
  },
  {
    key: 'constraints',
    label: '제약·필수',
    kind: 'text',
    placeholder: '반드시/절대 (예: 바닐라 JS만, 외부 라이브러리 금지)',
  },
]

/** 필드 값이 present(부재 아님)인가. 텍스트·select 공통: trim 후 비어있지 않음(select '' = 미지정 = 부재). */
export function isPresent(value: string): boolean {
  return value.trim().length > 0
}

/** 폼에 present 필드가 하나라도 있는가 — composeGoal 과 dirty-form 힌트가 공유하는 단일 기준. */
export function hasAnyPresent(fields: ElicitationFields): boolean {
  return ELICITATION_FIELDS.some((f) => isPresent(fields[f.key]))
}

/** 접합 표시값 — select 는 문구 매핑, 텍스트는 trim 값. */
function displayValue(meta: FieldMeta, fields: ElicitationFields): string {
  const raw = fields[meta.key]
  if (meta.kind === 'select') return COMPLETENESS_PHRASE[raw as Exclude<Completeness, ''>] ?? ''
  return raw.trim()
}

/**
 * base goal 에 present 필드를 `[추가 맥락]` 블록으로 결정적 접합한다.
 * - 전 필드 부재 → base 그대로(===) 반환(무회귀).
 * - base 본문 보존, 접합 경계 trailing 공백만 정규화(정확히 한 빈 줄 구분).
 * 결정적이되 멱등 아님 — 같은 fields 반복 적용 시 블록 중복. 중복 방지는 호출측 "접합 후 폼 비움".
 */
export function composeGoal(base: string, fields: ElicitationFields): string {
  const lines = ELICITATION_FIELDS.filter((f) => isPresent(fields[f.key])).map(
    (f) => `- ${f.label}: ${displayValue(f, fields)}`,
  )
  if (lines.length === 0) return base
  const block = `[추가 맥락]\n${lines.join('\n')}`
  const head = base.trimEnd()
  return head ? `${head}\n\n${block}` : block
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/components/elicitation.test.ts`
Expected: PASS — all `isPresent / hasAnyPresent` and `composeGoal` cases green.

- [ ] **Step 5: Typecheck + lint the new module**

Run: `npm run typecheck && npm run lint`
Expected: PASS, 0 errors / 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/elicitation.ts src/renderer/components/elicitation.test.ts
git commit -m "feat(#171): elicitation 순수 모듈 — composeGoal 결정적 접합 + 공유 absent 헬퍼

Part of #171

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Dt3qgef3pAorW8597q9bDm"
```

---

## Task 2: ProjectPanel 배선 (폼 UI · 반영 버튼 · dirty 힌트 · 무회귀 가드)

**Files:**
- Modify: `src/renderer/components/ProjectPanel.tsx` (import 상단 line 1-4 · 상태 line 20 부근 · JSX textarea line 315 위 · `run()` 무변경)
- Test: `src/renderer/components/ProjectPanel.test.tsx` (describe 블록 끝에 추가)

**Interfaces:**
- Consumes (Task 1): `ELICITATION_FIELDS`, `EMPTY_FIELDS`, `composeGoal`, `hasAnyPresent`, `type ElicitationFields`.
- Produces: 새 export 없음(컴포넌트 내부 배선). 폼 라벨/버튼 접근명: 텍스트 `대상 사용자`·`참고 레퍼런스 / 원하는 결과물 느낌`·`성공 기준`·`제약·필수`, select `완성도 수준`, 버튼 `goal에 반영`, 힌트 텍스트 `…반영되지 않았습니다…`.

- [ ] **Step 1: Write the failing tests**

`src/renderer/components/ProjectPanel.test.tsx` — `describe('ProjectPanel', () => { … })` 블록 **맨 끝(line 797 `})` 직전)** 에 추가:

```typescript
  // elicitation(#171): "goal에 반영" 이 폼을 textarea goal 에 결정적 접합하고 폼을 비운다.
  it('folds elicitation fields into the goal textarea and clears the form on 반영', async () => {
    mockFleet()
    await renderSettled(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    const goalBox = screen.getByPlaceholderText(/사용자 인증/) as HTMLTextAreaElement
    fireEvent.change(goalBox, { target: { value: '할 일 앱' } })
    fireEvent.change(screen.getByLabelText('대상 사용자'), { target: { value: '초등학생' } })
    fireEvent.click(screen.getByRole('button', { name: 'goal에 반영' }))
    expect(goalBox.value).toBe('할 일 앱\n\n[추가 맥락]\n- 대상 사용자: 초등학생')
    expect((screen.getByLabelText('대상 사용자') as HTMLInputElement).value).toBe('')
  })

  // 빈 폼: 반영 버튼 비활성 + goal 불변(no-op).
  it('disables 반영 and leaves the goal unchanged when the form is empty', async () => {
    mockFleet()
    await renderSettled(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    const goalBox = screen.getByPlaceholderText(/사용자 인증/) as HTMLTextAreaElement
    fireEvent.change(goalBox, { target: { value: '할 일 앱' } })
    expect(
      (screen.getByRole('button', { name: 'goal에 반영' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(goalBox.value).toBe('할 일 앱')
  })

  // 반영 후 완성도 select 도 '' (미지정)로 초기화.
  it('resets the completeness select to 미지정 after 반영', async () => {
    mockFleet()
    await renderSettled(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '앱' } })
    fireEvent.change(screen.getByLabelText('완성도 수준'), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: 'goal에 반영' }))
    expect((screen.getByLabelText('완성도 수준') as HTMLSelectElement).value).toBe('')
  })

  // 무회귀 핵심: 실행은 textarea goal 만 전송, 폼(미반영분 포함)은 절대 전송 안 함.
  it('run sends only the textarea goal, never the elicitation fields', async () => {
    const fleet = mockFleet()
    await renderSettled(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '할 일 앱' } })
    // 폼을 채우되 반영하지 않는다 — 실행 입력에 새면 안 된다.
    fireEvent.change(screen.getByLabelText('대상 사용자'), { target: { value: '초등학생' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    })
    // 실행은 textarea goal 만 — 폼 필드(미반영분)는 요청에 새지 않는다.
    expect(fleet.runProject).toHaveBeenCalledTimes(1)
    expect(fleet.runProject).toHaveBeenCalledWith(expect.objectContaining({ goal: '할 일 앱' }))
    expect(fleet.runProject).not.toHaveBeenCalledWith(
      expect.objectContaining({ audience: expect.anything() }),
    )
  })

  // dirty-form 힌트: present 필드에만 표시(공백·미지정엔 미표시), 반영 후 사라짐.
  it('shows the dirty-form hint only while present fields are unreflected', async () => {
    mockFleet()
    await renderSettled(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '앱' } })
    expect(screen.queryByText(/반영되지 않았습니다/)).toBeNull() // 빈 폼
    fireEvent.change(screen.getByLabelText('대상 사용자'), { target: { value: '   ' } })
    expect(screen.queryByText(/반영되지 않았습니다/)).toBeNull() // 공백-only = absent
    fireEvent.change(screen.getByLabelText('대상 사용자'), { target: { value: '개발자' } })
    expect(screen.getByText(/반영되지 않았습니다/)).toBeTruthy() // present
    fireEvent.click(screen.getByRole('button', { name: 'goal에 반영' }))
    expect(screen.queryByText(/반영되지 않았습니다/)).toBeNull() // 반영 후
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/components/ProjectPanel.test.tsx`
Expected: FAIL — `getByLabelText('대상 사용자')` / `getByRole('button', { name: 'goal에 반영' })` not found (UI not yet added).

- [ ] **Step 3: Write the implementation**

**3a.** `src/renderer/components/ProjectPanel.tsx` — import 추가 (line 4 `import { statusColor } from '../ui'` 아래):

```typescript
import {
  ELICITATION_FIELDS,
  EMPTY_FIELDS,
  composeGoal,
  hasAnyPresent,
  type ElicitationFields,
} from './elicitation'
```

**3b.** 상태 추가 (line 20 `const [goal, setGoal] = useState('')` 아래):

```typescript
  const [fields, setFields] = useState<ElicitationFields>(EMPTY_FIELDS)
```

**3c.** 핸들러 추가 (line 264 `}` — `run()` 함수 끝 — 바로 아래, `const canRun = …` 위):

```typescript
  // 폼 → goal 결정적 접합(버튼 전용). run() 은 호출하지 않는다(실행 입력은 textarea goal 단일).
  // 접합 후 폼을 비워 재접합 중복을 막는다(composeGoal 비멱등 계약).
  function applyFields() {
    if (!hasAnyPresent(fields)) return // 빈 폼 no-op
    setGoal(composeGoal(goal, fields))
    setFields(EMPTY_FIELDS)
  }
  // 텍스트/셀렉트 공통 갱신 — 계산된 키 부분객체를 ElicitationFields 로 좁힌다(UI 가 값 도메인 보장).
  function updateField(key: keyof ElicitationFields, value: string) {
    setFields((s) => ({ ...s, [key]: value }) as ElicitationFields)
  }
  const formDirty = hasAnyPresent(fields)
```

**3d.** 폼 UI 추가 — `<textarea …/>`(line 315-320) **바로 위**에 삽입:

```tsx
          <div className="elicitation" style={{ marginBottom: 12 }}>
            <span className="eyebrow">의도 보강 (선택)</span>
            <div className="grid-2" style={{ marginTop: 8 }}>
              {ELICITATION_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="field-label" htmlFor={`elic-${f.key}`}>
                    {f.label}
                  </label>
                  {f.kind === 'select' ? (
                    <select
                      id={`elic-${f.key}`}
                      className="field"
                      value={fields[f.key]}
                      onChange={(e) => updateField(f.key, e.target.value)}
                    >
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`elic-${f.key}`}
                      className="field"
                      placeholder={f.placeholder}
                      value={fields[f.key]}
                      onChange={(e) => updateField(f.key, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="row" style={{ alignItems: 'center', marginTop: 8, gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={applyFields} disabled={!formDirty}>
                goal에 반영
              </button>
              {formDirty && (
                <span className="note-warn" style={{ margin: 0 }}>
                  폼 내용이 goal 에 반영되지 않았습니다 — [goal에 반영]
                </span>
              )}
            </div>
          </div>
```

> `run()`·`canRun`·textarea·실행 버튼은 **건드리지 않는다**. 폼은 별도 상태(`fields`)이며 `applyFields` 만 `goal` 을 갱신한다.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/components/ProjectPanel.test.tsx`
Expected: PASS — 새 5개 테스트 + 기존 ProjectPanel 테스트 전부 green(무회귀).

- [ ] **Step 5: 품질 게이트 4종 + 포맷**

```bash
npx prettier --write src/renderer/components/elicitation.ts src/renderer/components/elicitation.test.ts src/renderer/components/ProjectPanel.tsx src/renderer/components/ProjectPanel.test.tsx
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
```
Expected: 전부 PASS — typecheck 0 / lint 0 warning / vitest 전체 green / build 성공.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ProjectPanel.tsx src/renderer/components/ProjectPanel.test.tsx
git commit -m "feat(#171): ProjectPanel elicitation 폼 — goal 접합 버튼 + dirty 힌트 (무회귀)

Part of #171

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Dt3qgef3pAorW8597q9bDm"
```

---

## Self-Review

**1. Spec coverage:**
- §4 컴포넌트(elicitation.ts·ProjectPanel) → Task 1·2 ✓
- §5 접합 메커니즘 A(버튼·폼 비움·run 무변경) → Task 2 3c/3d ✓
- §6 composeGoal 계약(부재·base trimEnd·비멱등) → Task 1 구현+테스트 ✓
- §7 dirty-form 힌트(hasAnyPresent 공유) → Task 2 3c/3d + 힌트 테스트 ✓
- §8 불변식(run compose 미호출·RunProjectRequest 미확장) → Global Constraints + "run sends only the textarea goal" 테스트 ✓
- §10 필드 세트(5개·select 매핑·reference 텍스트-only) → Task 1 `ELICITATION_FIELDS`·`COMPLETENESS_PHRASE` ✓
- §11 테스트 목록 → Task 1·2 테스트 전수 매핑 ✓
- §9 PR 프레이밍 → 커밋/PR 본문 "goal 보강 UX + 무회귀"(품질검증 아님) ✓

**2. Placeholder scan:** TBD/TODO/"적절히 처리" 없음 — 모든 스텝에 실제 코드·명령·기대출력 포함 ✓

**3. Type consistency:** `ElicitationFields`·`EMPTY_FIELDS`·`composeGoal`·`hasAnyPresent`·`ELICITATION_FIELDS` 명칭이 Task 1 정의 ↔ Task 2 소비에서 일치 ✓ · `updateField(key: keyof ElicitationFields, value: string)` 가 select/text 양쪽 onChange 와 시그니처 일치 ✓

---

## Execution Handoff

계획 완료. 실행 옵션은 핸드오프 시 선택한다(subagent-driven 권장 / inline). 실행 후 적대 리뷰 → PR(`Closes #171`) → Codex+CodeRabbit 리뷰 대기 → squash.
