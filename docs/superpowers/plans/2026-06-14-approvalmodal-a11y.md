# 승인 모달 키보드 접근성 (approvalmodal-a11y) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ApprovalModal.tsx` 에 WAI-ARIA dialog 키보드 접근성 4종(Escape→거부 · 초기 포커스 거부 버튼 · 포커스 트랩 · aria-labelledby/describedby)을 추가해, destructive 승인 모달을 키보드/스크린리더로 안전하게 조작 가능하게 한다.

**Architecture:** 렌더러 단일 파일 변경. dialog overlay div 에 인라인 `onKeyDown`(Escape=거부, Tab=모달 내 버튼 wrap) + 거부 버튼 `useRef` + `current?.id` 키 포커스 effect + aria id/참조. focus-trap 라이브러리 미도입(repo 무-의존, 버튼 2개뿐). IPC/preload/main 무변경. 안전 기본값(Escape·초기 포커스 모두 거부 방향).

**Tech Stack:** React(hooks), TypeScript, Vitest + @testing-library/react + jsdom(`fireEvent.keyDown`·`document.activeElement` — user-event 미설치).

**Spec:** `docs/superpowers/specs/2026-06-14-approvalmodal-a11y-design.md`

---

## File Structure

- **Modify** `src/renderer/components/ApprovalModal.tsx` — `useRef` import + 거부 버튼 ref + 포커스 effect + dialog 인라인 `onKeyDown`(Escape+Tab) + aria id/참조.
- **Modify** `src/renderer/components/ApprovalModal.test.tsx` — 신규 a11y 테스트(기존 7 그린 유지).

기존 컨벤션: 이벤트 핸들러는 인라인 `onKeyDown={(e) => …}`(ChatPanel.tsx:287·394 — 타입 추론, 명시 import 없음).

---

## Task 1: Escape → 거부

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`
- Test: `src/renderer/components/ApprovalModal.test.tsx`

- [ ] **Step 1: 실패하는 테스트 추가**

`ApprovalModal.test.tsx` 의 `describe('ApprovalModal', …)` 안 마지막 테스트(`shows queued requests…`) 뒤에 추가:

```tsx
  it('rejects the current request on Escape (safe default)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(respondApproval).toHaveBeenCalledWith('req-1', false)
    expect(screen.queryByRole('dialog')).toBeNull() // 디큐 — 다음 요청 없으면 모달 사라짐
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx -t "Escape"`
Expected: FAIL — Escape 무반응이라 `respondApproval` 미호출(`expect(...).toHaveBeenCalledWith` 실패).

- [ ] **Step 3: 구현 — dialog 에 onKeyDown(Escape 분기)**

`ApprovalModal.tsx` 의 `return (` 안 최상위 `<div className="modal-overlay" role="dialog" aria-modal="true">` 를 다음으로 교체(인라인 onKeyDown 추가):

```tsx
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        // 키보드 접근성: Escape=거부(자동거부 백스톱과 일관한 안전 방향).
        if (e.key === 'Escape') {
          e.preventDefault()
          decide(false)
        }
      }}
    >
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx`
Expected: PASS — 신규 1 + 기존 7 = 8 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(a11y): 승인 모달 Escape=거부 (#27 approvalmodal-a11y)"
```

---

## Task 2: 초기 포커스 = 거부 버튼 (열림·큐 전진 시)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`
- Test: `src/renderer/components/ApprovalModal.test.tsx`

- [ ] **Step 1: 실패하는 테스트 추가**

Task 1 의 Escape 테스트 뒤에 추가:

```tsx
  it('focuses the 거부 button when a request appears', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' }))
  })

  it('refocuses 거부 on the next queued request after a decision', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fire({ ...REQ, id: 'req-2', summary: '파일 쓰기: secret.pem', target: '/ws/secret.pem' })
    fireEvent.click(screen.getByRole('button', { name: '승인' })) // req-1 승인 → req-2 표시
    expect(screen.getByText('파일 쓰기: secret.pem')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' }))
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx -t "focuses the 거부"`
Expected: FAIL — 포커스 이동 없어 `document.activeElement` 가 거부 버튼 아님(body).

- [ ] **Step 3: 구현 — useRef import + ref + 포커스 effect**

3-1. import 줄(`ApprovalModal.tsx:1`)에 `useRef` 추가:
```tsx
import { useEffect, useRef, useState } from 'react'
```

3-2. `const [remaining, setRemaining] = useState(0)` 바로 아래에 ref 선언 추가:
```tsx
  const rejectRef = useRef<HTMLButtonElement>(null)
```

3-3. 카운트다운 effect(`}, [current?.id])` 로 끝나는 두 번째 useEffect) 바로 아래에 포커스 effect 추가:
```tsx
  // 모달 열림·큐 전진(다음 요청)마다 거부 버튼에 초기 포커스 — Enter 가 거부로 떨어져 destructive 오승인 방지.
  useEffect(() => {
    if (current) rejectRef.current?.focus()
  }, [current?.id])
```

3-4. 거부 `<button>` 에 ref 부착 — `<button className="btn btn-danger" onClick={() => decide(false)}>` 를:
```tsx
          <button ref={rejectRef} className="btn btn-danger" onClick={() => decide(false)}>
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx`
Expected: PASS — 신규 2 + 기존 8 = 10 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(a11y): 승인 모달 열림·큐 전진 시 거부 버튼 초기 포커스 (#27 approvalmodal-a11y)"
```

---

## Task 3: 포커스 트랩 (Tab/Shift+Tab wrap)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`
- Test: `src/renderer/components/ApprovalModal.test.tsx`

- [ ] **Step 1: 실패하는 테스트 추가**

Task 2 테스트 뒤에 추가:

```tsx
  it('wraps focus from 승인(last) to 거부(first) on Tab', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const approve = screen.getByRole('button', { name: '승인' })
    const reject = screen.getByRole('button', { name: '거부' })
    approve.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(reject)
  })

  it('wraps focus from 거부(first) to 승인(last) on Shift+Tab', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const approve = screen.getByRole('button', { name: '승인' })
    const reject = screen.getByRole('button', { name: '거부' })
    reject.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(approve)
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx -t "wraps focus"`
Expected: FAIL — Tab 처리 없어 wrap 안 됨(activeElement 불변).

- [ ] **Step 3: 구현 — onKeyDown 에 Tab 분기 추가**

Task 1 에서 만든 `onKeyDown` 핸들러의 Escape `if` 블록 **뒤에**(같은 핸들러 내부) Tab 분기 추가:

```tsx
      onKeyDown={(e) => {
        // 키보드 접근성: Escape=거부(자동거부 백스톱과 일관한 안전 방향).
        if (e.key === 'Escape') {
          e.preventDefault()
          decide(false)
          return
        }
        // 포커스 트랩: Tab/Shift+Tab 을 모달 내 버튼(거부↔승인)으로 가둔다 — 배경 탈출 차단.
        if (e.key === 'Tab') {
          const card = e.currentTarget.querySelector('.modal-card')
          const focusables = card ? Array.from(card.querySelectorAll<HTMLElement>('button')) : []
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }}
```

(Escape 블록에 `return` 추가됨 — Tab 분기로 흐르지 않도록.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx`
Expected: PASS — 신규 2 + 기존 10 = 12 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(a11y): 승인 모달 포커스 트랩(Tab wrap) (#27 approvalmodal-a11y)"
```

---

## Task 4: aria 라벨링 (labelledby / describedby)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`
- Test: `src/renderer/components/ApprovalModal.test.tsx`

- [ ] **Step 1: 실패하는 테스트 추가**

Task 3 테스트 뒤에 추가:

```tsx
  it('labels the dialog with its title and summary for screen readers', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('approval-title')
    expect(dialog.getAttribute('aria-describedby')).toBe('approval-summary')
    expect(document.getElementById('approval-title')?.textContent).toBe('위험 작업 승인')
    expect(document.getElementById('approval-summary')?.textContent).toBe('파일 쓰기: config/.env')
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx -t "labels the dialog"`
Expected: FAIL — aria-labelledby/describedby 미설정(`null`).

- [ ] **Step 3: 구현 — id + aria 참조 추가**

3-1. dialog div 에 aria 참조 속성 추가(`aria-modal="true"` 아래, `onKeyDown` 위):
```tsx
      aria-modal="true"
      aria-labelledby="approval-title"
      aria-describedby="approval-summary"
      onKeyDown={(e) => {
```

3-2. 제목 `h2` 에 id — `<h2 className="panel-title">{KIND_TITLE[current.kind]}</h2>` 를:
```tsx
          <h2 className="panel-title" id="approval-title">
            {KIND_TITLE[current.kind]}
          </h2>
```

3-3. 요약 `p` 에 id — `<p className="modal-summary">{current.summary}</p>` 를:
```tsx
        <p className="modal-summary" id="approval-summary">
          {current.summary}
        </p>
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/ApprovalModal.test.tsx`
Expected: PASS — 신규 1 + 기존 12 = 13 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(a11y): 승인 모달 dialog aria-labelledby/describedby (#27 approvalmodal-a11y)"
```

---

## Task 5: 4 게이트 전체 검증

**Files:** 없음(검증 전용)

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: PASS — 에러 0.

- [ ] **Step 2: lint (경고 0)**

Run: `npm run lint`
Expected: PASS — 경고 0.

- [ ] **Step 3: 전체 테스트**

Run: `npm test`
Expected: PASS — 기존 + 신규 6(Escape 1·포커스 2·트랩 2·aria 1) 그린. 베이스라인 test 647(권한가드 머지 후) → ApprovalModal 7→13 으로 653 전후.

- [ ] **Step 4: build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: 게이트 전부 그린이면 구현 완료** (검증만, 추가 커밋 없음).

---

## Self-Review 결과 (작성자 점검)

- **Spec coverage**: ① Escape→거부=Task 1 ✅. ② 초기 포커스 거부 버튼(열림·큐 전진)=Task 2 ✅. ③ 포커스 트랩=Task 3 ✅. ④ aria 라벨링=Task 4 ✅. 4 게이트=Task 5 ✅. 무회귀(기존 7 테스트)=각 Task Step 4 `npm test` 전체 실행으로 확인. 갭 0.
- **Placeholder scan**: TBD/TODO/"적절히 처리" 0건. 모든 코드 스텝 완전한 코드.
- **Type consistency**: `rejectRef`(Task 2 선언)↔거부 버튼 ref(Task 2 부착)·포커스 effect(Task 2) 일치. `onKeyDown` 핸들러는 Task 1(Escape)→Task 3(Tab 분기 추가)로 점증, Task 3 Step 3 이 Escape+Tab 통합 최종형을 전부 보여줌(부분 읽기 안전). id `approval-title`/`approval-summary`(Task 4)가 dialog 참조·h2/p 부착에서 동일.
- **인라인 핸들러 선택**: ChatPanel 컨벤션(인라인·타입추론)대로라 `KeyboardEvent` 타입 import/네임 셰도우 불필요. `e.currentTarget`=dialog overlay, 그 안 `.modal-card` 버튼 trap.
