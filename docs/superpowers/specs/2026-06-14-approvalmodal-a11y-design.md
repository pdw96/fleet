# 설계: 승인 모달 키보드 접근성 (approvalmodal-a11y)

- 날짜: 2026-06-14
- 출처: GitHub 이슈 #27 백로그(🟡 Next · 랭크7 `approvalmodal-a11y`, 가치3·노력1·리스크1).
  6차 재랭킹 식별: `ApprovalModal.tsx:48-74` 의 `div[role=dialog][aria-modal]` 에 `onKeyDown`/Escape·
  autoFocus·포커스 트랩이 **전무**. destructive 작업 승인 모달인데 키보드 사용자가 Escape 로 거부할 수
  없고, 포커스가 모달에 들어가지/갇히지 않는다(자동 거부 타임아웃 `:33-39` 가 유일 백스톱).
- 범위(이 슬라이스): **렌더러 `ApprovalModal.tsx` 단일 파일**. WAI-ARIA dialog 패턴의 키보드 접근성 4종
  (Escape→거부 · 초기 포커스 거부 버튼 · 포커스 트랩 · aria-labelledby/describedby)을 추가한다.
- 착지 방식: focus-trap 라이브러리 **미도입**(repo 무-의존 철학 — `window-guards.ts` 선례, 모달 포커스
  요소가 버튼 2개뿐). 인라인 구현(별도 훅 미추출 — 유일 모달, YAGNI). IPC/preload/main **무변경**.

> **순수 렌더러 변경.** shared 타입·preload·main 어디에도 닿지 않는다. 메인 측 승인 권위(자동 거부
> 타임아웃·`respondApproval` 계약)는 불변 — 이 슬라이스는 키보드 UX 만 더한다.

## 배경 / 문제 (코드 검증)

`ApprovalModal.tsx` 현 상태:
- `:49` `div.modal-overlay[role=dialog][aria-modal=true]` — `onKeyDown` 핸들러 없음 → Escape 무반응.
- 초기 포커스 이동 없음 → 모달이 떠도 포커스가 배경에 남는다(스크린리더/키보드 사용자가 모달 인지·조작 불가).
- 포커스 트랩 없음 → Tab 이 배경 요소로 샌다(`aria-modal` 은 시맨틱 힌트일 뿐 실제 포커스를 가두지 않음).
- dialog 가 제목(`h2`)·요약(`p`)을 `aria-labelledby`/`aria-describedby` 로 참조하지 않음 → 스크린리더가
  dialog 이름/설명을 못 읽음.

### 안전 기본값 (사용자 합의)

destructive 승인이므로 키보드 상호작용은 **안전 방향**으로 설계한다(자동 거부 백스톱과 일관):
- **Escape → 거부**(승인 아님). 무결정=거부인 자동 타임아웃과 같은 방향.
- **초기 포커스 = 거부 버튼**. Enter 가 거부로 떨어져 destructive 오승인을 방지.

## 구현 — `ApprovalModal.tsx` (단일 파일, 4종)

### 1. Escape → 거부

dialog div 에 `onKeyDown` 핸들러:
```tsx
const onKeyDown = (e: React.KeyboardEvent): void => {
  if (e.key === 'Escape') {
    e.preventDefault()
    decide(false) // 거부 — 자동 거부 백스톱과 일관
    return
  }
  // Tab 트랩(아래 3)
}
```

### 2. 초기 포커스 = 거부 버튼

```tsx
const rejectRef = useRef<HTMLButtonElement>(null)
useEffect(() => {
  if (current) rejectRef.current?.focus()
}, [current?.id]) // 모달 열림·큐 전진(다음 요청)마다 거부 버튼에 포커스
```
거부 `<button ref={rejectRef} …>`.

### 3. 포커스 트랩 (Tab/Shift+Tab wrap)

같은 `onKeyDown` 에서 — 모달 카드 내 focusable 을 동적 수집(미래 버튼 추가에도 견고):
```tsx
if (e.key === 'Tab') {
  const card = e.currentTarget.querySelector('.modal-card')
  const focusables = card ? Array.from(card.querySelectorAll<HTMLElement>('button')) : []
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
```
- `e.currentTarget` = dialog overlay div(핸들러 부착 대상). 그 안의 `.modal-card` 버튼들을 trap.
- 포커스가 모달 밖(배경)에 있다 Tab 하는 경우는 초기 포커스(2)가 항상 모달 안으로 들여놓으므로 실무상 미발생;
  방어적으로 first/last 경계에서만 wrap, 중간 Tab 은 브라우저 기본(거부↔승인 순방향) 유지.

### 4. aria 라벨링

- `h2` 에 `id="approval-title"`; dialog div 에 `aria-labelledby="approval-title"`.
- 요약 `<p className="modal-summary">` 에 `id="approval-summary"`; dialog div 에 `aria-describedby="approval-summary"`.
- 모달은 App 레벨 단일 인스턴스라 id 충돌 없음(동시 2개 모달 불가 — 큐로 순차 1개).

## TDD 계획 (렌더러 변경엔 *.test.tsx 동반 — AGENTS.md)

`ApprovalModal.test.tsx` 확장(기존 7 테스트 그린 유지 + 신규). testing-library/react + jsdom + `fireEvent`
(user-event 미설치 — `fireEvent.keyDown`·`document.activeElement` 사용):

- **Escape → 거부**: 요청 도착 후 `fireEvent.keyDown(dialog, { key: 'Escape' })` → `respondApproval(id, false)`
  호출 + 모달 디큐(다음 없으면 `.modal-overlay` 사라짐).
- **초기 포커스**: 요청 도착 시 `document.activeElement === screen.getByRole('button', { name: '거부' })`.
- **큐 전진 후 포커스**: 2건 큐 → 승인 클릭 → 다음 요청의 거부 버튼에 포커스 재설정.
- **포커스 트랩**: 승인 버튼에 포커스 둔 뒤 `fireEvent.keyDown(dialog, { key: 'Tab' })` → 거부로 wrap
  (`activeElement === 거부`); 거부에 포커스 두고 `{ key: 'Tab', shiftKey: true }` → 승인으로 wrap.
- **aria 라벨링**: dialog 가 `aria-labelledby="approval-title"`·`aria-describedby="approval-summary"` 보유,
  해당 id 요소가 제목/요약 텍스트.
- **무회귀**: 기존 클릭 승인/거부·큐 순차·타이틀 테스트 그린 유지.
- **4 게이트**(AGENTS.md): `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

## 영향 파일

- `src/renderer/components/ApprovalModal.tsx` — `useRef` import + `onKeyDown`(Escape+Tab) + 포커스 effect +
  거부 버튼 ref + aria id/참조.
- `src/renderer/components/ApprovalModal.test.tsx` — 신규 a11y 테스트.

## 비범위 (YAGNI / 후속)

- **포커스 복원**(닫힐 때 직전 포커스 요소로) — 모달이 main 비동기 이벤트로 떠 트리거 요소가 불명확,
  한계효용 낮아 제외.
- **`useFocusTrap` 훅 추출** — 유일 모달이라 미추출(둘째 모달 등장 시 추출).
- **inert/`aria-hidden` 배경 처리** — 포커스 트랩으로 키보드 탈출은 차단되므로 스크린리더 배경 격리는
  후속(과범위).

## 라이브 검증 사항

- 단위 테스트(jsdom)가 키 핸들러·포커스 이동·aria 참조를 격리 증명. jsdom 포커스는 실 브라우저와 미세
  차이가 있을 수 있어, 실 Electron 에서 Escape·Tab·초기 포커스 동작은 머지 후 수동 1회 확인(기존 e2e 는
  승인 모달 미커버 — 별도 e2e 는 과범위).
