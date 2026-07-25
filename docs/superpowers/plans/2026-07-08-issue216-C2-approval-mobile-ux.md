# C2 구현 계획 — 승인 카드 모바일 UX·다중 pending·재접속 UX (#216 Phase C · Part of #193)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

스펙: `docs/superpowers/specs/2026-07-08-issue216-C2-approval-mobile-ux-design.md`(Codex 체크포인트 2 "진행
가능"·P2 반영 clean). 소형(렌더러 2 소스파일·신규 계약 0) → 판사 패널 생략·writing-plans 단일 패스.

**Goal:** 승인 모달을 반응형(폰 바텀시트/데스크톱 중앙)·다중 pending 내비(집중 카드 + 미니칩·화살표·스와이프)·
mm:ss 카운트다운으로 끌어올려 "외출 중 폰 승인" UX 를 실사용 품질로 만든다. C1 안전/하이드레이션/tombstone/skew 계약은 전부 보존.

**Architecture:** 단일 컴포넌트 `ApprovalModal.tsx` 를 `useReducer`(queue+focusedId 원자 전이)로 리팩터.
표시=집중 카드 1장 + `queue.length>1` 일 때 미니칩 스트립(각 pending=탭 가능 버튼·현재 강조)·위치 텍스트.
이동(칩 탭/`←→`/가로 스와이프)=focus만, 결정(거부/승인 버튼)=respondApproval. 레이아웃은 `styles.css`
`@media (max-width:640px)` 하나로 바텀시트 분기(데스크톱 무변경). 신규 계약·채널·server·preload 없음.

**Tech Stack:** React 18(useReducer/useEffect/useRef)·TypeScript·vitest+jsdom+@testing-library/react·CSS(디자인
토큰 재사용).

## Global Constraints

- **브랜치** `feat/216-c2-approval-mobile-ux`(master 직접 커밋 금지·ruleset). PR 본문 `Part of #216`(마지막 phase 아님).
- **순수 렌더러/CSS** — `src/renderer/components/ApprovalModal.tsx`·`src/renderer/styles.css`·`.../ApprovalModal.test.tsx` **만**. FleetBridge·channels·preload·server·handlers **무변경**.
- **C1 계약 보존(회귀 0)**: 오조준 intent 가드·거부-우선 포커스·Escape=거부·Tab 트랩(document)·Enter no-op·
  하이드레이션(nonce/재시도)·tombstone·skew(로컬 시계 카드 드롭 금지·카운트다운만 0 클램프)·서버 권위 expiresAt.
- **테스트 환경** `/** @vitest-environment jsdom */`. jsdom 은 실 레이아웃/제스처 미평가 → 반응형·스와이프는 CSS 텍스트/이벤트 수준 유닛 + 웹 e2e/라이브 위임.
- **각 태스크 커밋** = tsc + 해당 테스트 GREEN. `npm run verify`(7게이트)는 각 태스크 로컬·최종 T7.
- **brain 규율(MEMORY)**: `npm run brain` 재생성은 **모든 src 변경 후 최종 1회**·**별도 커밋**(lint-staged prettier 재포맷→brain stale→CI brain:check fail 회피). 게이트에 `| tail -1` 금지(exit code 은폐).
- **파괴적 승인 안전 방향 불변**: 자동 승인 경로 0·모든 안전 백스톱은 거부 방향.

---

### Task 1: mm:ss 카운트다운 (`formatCountdown` 순수 함수)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`(순수 export 추가 + `remaining` 배선)
- Test: `src/renderer/components/ApprovalModal.test.tsx`(포맷 경계 테스트 + 기존 카운트다운 단언 갱신)

**Interfaces:**
- Produces: `export function formatCountdown(ms: number): string` — 남은 ms → `"m:ss"`(ceil 초·0 클램프).

- [ ] **Step 1: 실패 테스트 작성** — `ApprovalModal.test.tsx` 상단 import 에 `formatCountdown` 추가 후:

```tsx
import { ApprovalModal, formatCountdown } from './ApprovalModal'

describe('formatCountdown', () => {
  it('남은 ms 를 m:ss 로(ceil·0 클램프)', () => {
    expect(formatCountdown(600_000)).toBe('10:00')
    expect(formatCountdown(573_000)).toBe('9:33')
    expect(formatCountdown(65_000)).toBe('1:05')
    expect(formatCountdown(5_000)).toBe('0:05')
    expect(formatCountdown(1)).toBe('0:01') // ceil — 0 초과는 최소 0:01
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-1_000)).toBe('0:00')
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx -t formatCountdown`
  Expected: FAIL(`formatCountdown` is not exported / not a function).

- [ ] **Step 3: 구현 + 배선** — `ApprovalModal.tsx`:

```tsx
/** 남은 ms → "m:ss"(예 573000→"9:33", 5000→"0:05", 0/음수→"0:00"). ceil 초·max(0) 클램프.
 *  서버 권위 카운트다운 표시 전용 — 로컬 만료로 카드를 제거하지 않는다(§C-4·skew 계약). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
```

`remaining` 파생을 문자열로 교체(기존 `ApprovalModal.tsx:129`):

```tsx
const remaining = current ? formatCountdown(current.expiresAt - now) : '0:00'
```

카운트다운 JSX(기존 `:227`) `{remaining}s 후 자동 거부` → `{remaining} 후 자동 거부`.

- [ ] **Step 4: 기존 카운트다운 단언 갱신** — `ApprovalModal.test.tsx` 의 `#27`·skew 케이스:
  - `#27`: `fire({...REQ, id:'exp-1', expiresAt: t0 + 3000})` 후 `'3s 후 자동 거부'` → `'0:03 후 자동 거부'` ·
    advance 후 `'0s 후 자동 거부'` → `'0:00 후 자동 거부'`.
  - skew 테스트 2건: `'0s 후 자동 거부'` → `'0:00 후 자동 거부'`.

- [ ] **Step 5: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx`
  Expected: PASS(전 케이스). `npx tsc --noEmit` GREEN.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#216-C2): 카운트다운 mm:ss 순수 formatCountdown (Part of #216)"
```

---

### Task 2: 상태 모델 — `useReducer`(queue + focusedId 원자 전이)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`(State/Action/reducer export·useReducer 리팩터·current/position 파생·효과가 dispatch)
- Test: `src/renderer/components/ApprovalModal.test.tsx`(reducer 순수 유닛 테스트 추가·기존 DOM 테스트 GREEN 유지)

**Interfaces:**
- Produces: `export type ApprovalAction`·`export function approvalReducer(state, action): State`.
  - `State = { queue: ApprovalRequest[]; focusedId: string | null }`
  - Actions: `{type:'UPSERT', req}` · `{type:'REMOVE', id}` · `{type:'FOCUS', id}` · `{type:'FOCUS_DELTA', delta}` · `{type:'HYDRATE', pending, preHydrationIds}`
- Consumes(Task 3+): `dispatch({type:'FOCUS', id})`·`dispatch({type:'FOCUS_DELTA', delta})`.

- [ ] **Step 1: reducer 실패 테스트 작성** — 신규 describe:

```tsx
import { ApprovalModal, formatCountdown, approvalReducer } from './ApprovalModal'
import type { ApprovalAction } from './ApprovalModal'

const mk = (id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id, kind: 'file-write', summary: id, target: `/ws/${id}`, risk: 'destructive',
  ts: 1, expiresAt: 2_000, ...over,
})

describe('approvalReducer', () => {
  it('UPSERT 는 큐 뒤 추가·focus 불변(얌체 점프 방지)', () => {
    const s0 = { queue: [mk('A'), mk('B')], focusedId: 'B' }
    const s1 = approvalReducer(s0, { type: 'UPSERT', req: mk('C') })
    expect(s1.queue.map((r) => r.id)).toEqual(['A', 'B', 'C'])
    expect(s1.focusedId).toBe('B') // 새 라이브에도 집중 불변
  })

  it('UPSERT 는 같은 id 갱신(dedupe·비파괴)', () => {
    const s0 = { queue: [mk('A', { summary: 'old' })], focusedId: null }
    const s1 = approvalReducer(s0, { type: 'UPSERT', req: mk('A', { summary: 'new' }) })
    expect(s1.queue).toHaveLength(1)
    expect(s1.queue[0].summary).toBe('new')
  })

  it('REMOVE(집중 카드) → 이웃으로 focus(다음, 없으면 이전)', () => {
    const s0 = { queue: [mk('A'), mk('B'), mk('C')], focusedId: 'B' }
    const s1 = approvalReducer(s0, { type: 'REMOVE', id: 'B' })
    expect(s1.queue.map((r) => r.id)).toEqual(['A', 'C'])
    expect(s1.focusedId).toBe('C') // idx=1 자리의 다음 카드
    const s2 = approvalReducer({ queue: [mk('A'), mk('B')], focusedId: 'B' }, { type: 'REMOVE', id: 'B' })
    expect(s2.focusedId).toBe('A') // 마지막이면 이전
    const s3 = approvalReducer({ queue: [mk('A')], focusedId: 'A' }, { type: 'REMOVE', id: 'A' })
    expect(s3.focusedId).toBeNull() // 마지막 1건이면 null
  })

  it('REMOVE(비집중 카드) → 집중 불변(id 추적 이점·조용한 스왑 없음)', () => {
    const s0 = { queue: [mk('A'), mk('B'), mk('C')], focusedId: 'C' }
    const s1 = approvalReducer(s0, { type: 'REMOVE', id: 'A' }) // 앞 카드 제거
    expect(s1.focusedId).toBe('C') // index 추적이면 스왑됐을 상황 — id 추적이라 불변
  })

  it('FOCUS 는 큐에 있는 id 만 채택', () => {
    const s0 = { queue: [mk('A'), mk('B')], focusedId: 'A' }
    expect(approvalReducer(s0, { type: 'FOCUS', id: 'B' }).focusedId).toBe('B')
    expect(approvalReducer(s0, { type: 'FOCUS', id: 'Z' }).focusedId).toBe('A') // 없는 id 무시
  })

  it('FOCUS_DELTA 는 최신 큐 기준 ±1 클램프(순환 없음)', () => {
    const q = [mk('A'), mk('B'), mk('C')]
    expect(approvalReducer({ queue: q, focusedId: 'A' }, { type: 'FOCUS_DELTA', delta: 1 }).focusedId).toBe('B')
    expect(approvalReducer({ queue: q, focusedId: 'A' }, { type: 'FOCUS_DELTA', delta: -1 }).focusedId).toBe('A') // 경계 clamp
    expect(approvalReducer({ queue: q, focusedId: 'C' }, { type: 'FOCUS_DELTA', delta: 1 }).focusedId).toBe('C') // 경계 clamp
    // focusedId=null 이면 큐 앞(queue[0]) 기준
    expect(approvalReducer({ queue: q, focusedId: null }, { type: 'FOCUS_DELTA', delta: 1 }).focusedId).toBe('B')
  })

  it('HYDRATE reconcile — 스냅숏 부재 pre-hydration 제거·라이브-fresh 보존·스냅숏 upsert', () => {
    const s0 = { queue: [mk('stale'), mk('fresh')], focusedId: 'fresh' }
    const s1 = approvalReducer(s0, {
      type: 'HYDRATE', pending: [], preHydrationIds: new Set(['stale']),
    })
    expect(s1.queue.map((r) => r.id)).toEqual(['fresh']) // stale 제거·fresh(preHydration 밖) 보존
    expect(s1.focusedId).toBe('fresh') // 여전히 큐에 있음
    const s2 = approvalReducer(
      { queue: [mk('stale')], focusedId: 'stale' },
      { type: 'HYDRATE', pending: [], preHydrationIds: new Set(['stale']) },
    )
    expect(s2.focusedId).toBeNull() // 집중 카드가 사라지면 null 폴백(→ current=queue[0])
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx -t approvalReducer`
  Expected: FAIL(`approvalReducer` not exported).

- [ ] **Step 3: reducer 구현** — `ApprovalModal.tsx`(upsert 헬퍼는 reducer 로 흡수):

```tsx
export type ApprovalState = { queue: ApprovalRequest[]; focusedId: string | null }
export type ApprovalAction =
  | { type: 'UPSERT'; req: ApprovalRequest }
  | { type: 'REMOVE'; id: string }
  | { type: 'FOCUS'; id: string }
  | { type: 'FOCUS_DELTA'; delta: number }
  | { type: 'HYDRATE'; pending: ApprovalRequest[]; preHydrationIds: Set<string> }

export function approvalReducer(state: ApprovalState, action: ApprovalAction): ApprovalState {
  switch (action.type) {
    case 'UPSERT': {
      const i = state.queue.findIndex((r) => r.id === action.req.id)
      if (i >= 0) {
        const queue = [...state.queue]
        queue[i] = action.req
        return { ...state, queue }
      }
      return { ...state, queue: [...state.queue, action.req] } // 뒤 추가·focus 불변
    }
    case 'REMOVE': {
      const idx = state.queue.findIndex((r) => r.id === action.id)
      if (idx < 0) return state
      const queue = state.queue.filter((r) => r.id !== action.id)
      if (state.focusedId !== action.id) return { ...state, queue } // 비집중 제거 — focus 불변
      const neighbor = queue[idx] ?? queue[idx - 1] ?? null // 다음, 없으면 이전, 없으면 null
      return { queue, focusedId: neighbor ? neighbor.id : null }
    }
    case 'FOCUS':
      return state.queue.some((r) => r.id === action.id) ? { ...state, focusedId: action.id } : state
    case 'FOCUS_DELTA': {
      if (state.queue.length === 0) return state
      const cur = state.queue.findIndex((r) => r.id === (state.focusedId ?? state.queue[0].id))
      const ni = Math.min(state.queue.length - 1, Math.max(0, cur + action.delta))
      return { ...state, focusedId: state.queue[ni].id }
    }
    case 'HYDRATE': {
      const snapshotIds = new Set(action.pending.map((r) => r.id))
      // reconcile(C1 §C-3): 스냅숏에 있거나(권위) preHydration 밖(라이브-fresh)인 카드 유지.
      const queue = state.queue.filter((r) => snapshotIds.has(r.id) || !action.preHydrationIds.has(r.id))
      for (const req of action.pending) {
        const i = queue.findIndex((r) => r.id === req.id)
        if (i >= 0) queue[i] = req
        else queue.push(req)
      }
      const focusedId =
        state.focusedId && queue.some((r) => r.id === state.focusedId) ? state.focusedId : null
      return { queue, focusedId }
    }
  }
}
```

- [ ] **Step 4: 컴포넌트 useReducer 리팩터** — `useState<queue>` 제거, `const [{ queue, focusedId }, dispatch] = useReducer(approvalReducer, { queue: [], focusedId: null })`. tombstone(ref)·now(1s 틱)·pointerIntent·rejectRef·cardRef 유지. 파생·효과 배선:

```tsx
const current = queue.find((r) => r.id === focusedId) ?? queue[0]
const position = current ? queue.findIndex((r) => r.id === current.id) + 1 : 0

// 라이브 요청 — tombstone 선필터 후 UPSERT(마운트 1회)
useEffect(() => {
  return window.fleet.onApprovalRequest((req) => {
    if (!tombstone.current.has(req.id)) dispatch({ type: 'UPSERT', req })
  })
}, [])

// 이탈 통지 — tombstone 기록 + REMOVE(마운트 1회)
useEffect(() => {
  return window.fleet.onApprovalWithdrawn((id) => {
    tombstone.current.add(id)
    dispatch({ type: 'REMOVE', id })
  })
}, [])

// 재하이드레이션(nonce) — preHydrationIds 포착·tombstone 선필터·제한 재시도·HYDRATE
useEffect(() => {
  let cancelled = false
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const preHydrationIds = new Set(queue.map((r) => r.id))
  const fetchSnapshot = (): void => {
    window.fleet
      .listPendingApprovals()
      .then((pending) => {
        if (cancelled) return
        const clean = pending.filter((r) => !tombstone.current.has(r.id)) // apply 시점 tombstone 재확인
        dispatch({ type: 'HYDRATE', pending: clean, preHydrationIds })
      })
      .catch(() => {
        if (cancelled || retries >= 3) return
        retries += 1
        retryTimer = setTimeout(fetchSnapshot, 400 * retries)
      })
  }
  fetchSnapshot()
  return () => {
    cancelled = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [nonce])
```

`decide` 는 REMOVE dispatch 로(respondApproval 후):

```tsx
const decide = (approved: boolean): void => {
  if (!current) return
  const intent = pointerIntent.current
  pointerIntent.current = null
  if (intent !== null && intent !== current.id) return
  const id = current.id
  void window.fleet.respondApproval(id, approved).catch(() => undefined)
  dispatch({ type: 'REMOVE', id })
}
```

`upsertApproval` 자유 함수·기존 `useState` 큐 로직 제거(reducer 로 대체). `now` 틱·`current?.id` 포커스 effect·키보드 트랩 effect 는 유지(트랩 복귀는 T4 에서 수정).

- [ ] **Step 5: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx`
  Expected: reducer 유닛 + **기존 DOM 테스트 전부 GREEN**(하이드레이션·tombstone·skew·오조준·큐 1건씩·포커스·트랩). `npx tsc --noEmit` GREEN.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#216-C2): queue+focusedId useReducer 원자 전이(neighbor·id 추적) (Part of #216)"
```

---

### Task 3: 다중 pending 내비 UI (미니칩 스트립 + 위치 + 화살표/탭)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`(`KIND_LABEL`·미니칩 스트립 렌더·화살표 키·칩 탭 → dispatch)
- Test: `src/renderer/components/ApprovalModal.test.tsx`(내비 테스트 + 기존 `#25` 갱신)

**Interfaces:**
- Consumes: `dispatch({type:'FOCUS'|'FOCUS_DELTA'})`(Task 2).
- Produces: 미니칩 = `<button aria-label="{종류} · {위험} ({i}/{N})" aria-current>`.

- [ ] **Step 1: 실패 테스트 작성** — 먼저 파일 상단(REQ 아래)에 파일 레벨 헬퍼 `mkReq` 추가(RED 컴파일용):

```tsx
function mkReq(
  id: string, summary: string, kind: ApprovalRequest['kind'], risk: RiskLevel,
): ApprovalRequest {
  return { id, kind, summary, target: `/ws/${id}`, risk, ts: 1, expiresAt: Date.now() + 60_000 }
}
```

이어 내비 describe:

```tsx
describe('다중 pending 내비', () => {
  const three = (fire: (r: ApprovalRequest) => void) => {
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
    fire(mkReq('C', '변경 적용', 'apply-diff', 'safe'))
  }

  it('queue>1 이면 위치 텍스트·미니칩 스트립 표시', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: /도구 호출.*주의.*1\/3/ })).toBeTruthy()
  })

  it('→ 키로 다음 카드 focus·경계 clamp', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    expect(screen.getByText('도구 호출 승인')).toBeTruthy() // A(tool-call) current
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(screen.getByText('위험 작업 승인')).toBeTruthy() // B(shell) current
  })

  it('미니칩 탭으로 그 카드 focus + aria-current', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    const chipC = screen.getByRole('button', { name: /변경 적용.*안전.*3\/3/ })
    fireEvent.click(chipC)
    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(chipC.getAttribute('aria-current')).toBe('true')
  })

  it('임의 순서 결정 — 2건째로 이동 후 승인 → 그 id 결정·나머지 유지', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' }) // B focus
    const approve = screen.getByRole('button', { name: '승인' })
    fireEvent.pointerDown(approve)
    fireEvent.click(approve)
    expect(respondApproval).toHaveBeenCalledWith('B', true)
    expect(screen.getByText('2 / 2')).toBeTruthy() // A·C 남음(current=이웃 C)
  })

  it('이동≠결정 — 화살표/칩 탭은 respondApproval 미호출', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    fireEvent.click(screen.getByRole('button', { name: /변경 적용.*안전/ }))
    expect(respondApproval).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run ... -t "다중 pending 내비"` Expected: FAIL(위치/칩 미렌더).

- [ ] **Step 3: 구현** — `ApprovalModal.tsx`:

`KIND_LABEL`(칩용 짧은 라벨) 추가:

```tsx
/** 미니칩·스트립용 짧은 라벨(모달 제목 KIND_TITLE 과 별도). */
const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  'file-write': '파일 쓰기', 'file-delete': '파일 삭제', shell: 'shell 실행',
  'apply-diff': '변경 적용', 'tool-call': '도구 호출',
}
```

화살표 키 — 키보드 트랩 effect 상단에 추가(Escape/Tab 앞):

```tsx
if (e.key === 'ArrowRight') { e.preventDefault(); dispatch({ type: 'FOCUS_DELTA', delta: 1 }); return }
if (e.key === 'ArrowLeft') { e.preventDefault(); dispatch({ type: 'FOCUS_DELTA', delta: -1 }); return }
```

미니칩 스트립 — 기존 `.modal-pending` 텍스트 블록(`queue.length>1 && ...`)을 교체:

```tsx
{queue.length > 1 && (
  <div className="modal-nav" role="group" aria-label="대기 중 승인 이동">
    <div className="modal-chips">
      {queue.map((r, i) => (
        <button
          key={r.id}
          type="button"
          className={`modal-chip${r.id === current.id ? ' is-current' : ''}`}
          aria-current={r.id === current.id ? 'true' : undefined}
          aria-label={`${KIND_LABEL[r.kind]} · ${RISK_LABEL[r.risk]} (${i + 1}/${queue.length})`}
          onClick={() => dispatch({ type: 'FOCUS', id: r.id })}
        >
          <span className="modal-chip-kind">{KIND_LABEL[r.kind]}</span>
          <span className="modal-chip-risk" data-risk={r.risk}>{RISK_LABEL[r.risk]}</span>
        </button>
      ))}
    </div>
    <span className="modal-pos">{position} / {queue.length}</span>
  </div>
)}
```

(테스트 헬퍼 `mkReq` 는 Step 1 에서 파일 상단에 이미 추가함.)

- [ ] **Step 4: 기존 `#25` 갱신** — `screen.getByText('대기 중 2건')` → `screen.getByText('1 / 3')`(A current·3건 큐). 주석도 갱신.

- [ ] **Step 5: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx` Expected: PASS. `npx tsc --noEmit` GREEN.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#216-C2): 다중 pending 미니칩 내비·화살표·임의 순서 결정 (Part of #216)"
```

---

### Task 4: 포커스 트랩 복귀 고정 (Codex 체크포인트 2 P2)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`(이탈 복귀 target → `rejectRef`)
- Test: `src/renderer/components/ApprovalModal.test.tsx`(P2 회귀 4건 + 기존 document-트랩 테스트 칩 존재로 강화)

**Interfaces:** 변경 없음(내부 트랩 규칙만).

- [ ] **Step 1: 실패 테스트 작성**:

```tsx
describe('포커스 트랩(미니칩 존재·Codex P2)', () => {
  const two = (fire: (r: ApprovalRequest) => void) => {
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
  }

  it('#11 포커스가 모달 밖으로 샜을 때 Tab → 거부 복귀(첫 칩 아님)', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    two(fire) // 미니칩 버튼이 액션 버튼보다 DOM 앞
    const reject = screen.getByRole('button', { name: '거부' })
    const bg = document.createElement('button')
    document.body.appendChild(bg)
    act(() => bg.focus())
    fireEvent.keyDown(bg, { key: 'Tab' })
    expect(document.activeElement).toBe(reject) // 첫 미니칩 아니라 거부
    bg.remove()
  })

  it('#12 미니칩 상태서도 Escape=거부·거부-우선 초기 포커스 유지', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' })) // 초기 포커스
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(respondApproval).toHaveBeenCalledWith('A', false)
  })

  it('#13 칩 포함 상태서 Tab/Shift+Tab 이 모달 밖 탈출 안 함', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const card = screen.getByRole('dialog').querySelector('.modal-card') as HTMLElement
    const buttons = Array.from(card.querySelectorAll('button'))
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(first) // last→first 순환(탈출 없음)
    first.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last) // first→last 순환
  })

  it('#14 미니칩 focus 중 Enter 는 이동만·respondApproval 미호출', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const chipB = screen.getByRole('button', { name: /shell 실행.*위험.*2\/2/ })
    chipB.focus()
    fireEvent.keyDown(chipB, { key: 'Enter' }) // dialog 트랩은 Enter no-op
    fireEvent.click(chipB) // Enter 의 네이티브 click = FOCUS(이동)
    expect(respondApproval).not.toHaveBeenCalled()
    expect(screen.getByText('2 / 2')).toBeTruthy() // B 로 이동됨(위치 갱신)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run ... -t "포커스 트랩(미니칩"` Expected: FAIL(#11 이탈 복귀가 첫 칩으로).

- [ ] **Step 3: 구현** — 키보드 트랩 effect 의 이탈 복귀만 수정(기존 `ApprovalModal.tsx:181-183`):

```tsx
if (!card.contains(active)) {
  e.preventDefault()
  rejectRef.current?.focus() // 이탈 복귀는 항상 거부(첫 focusable=칩일 수 있음·Codex P2)
} else if (e.shiftKey && active === first) {
  e.preventDefault()
  last.focus()
} else if (!e.shiftKey && active === last) {
  e.preventDefault()
  first.focus()
}
```

(Tab 순환의 first/last 는 전체 focusable 유지 — 칩 포함 순환은 정상 a11y.)

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx` Expected: PASS(신규 4 + 기존 트랩 3종). `npx tsc --noEmit` GREEN.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#216-C2): 트랩 이탈 복귀=거부 고정(칩 선행 DOM 안전·Codex P2) (Part of #216)"
```

---

### Task 5: 반응형 레이아웃 (폰 바텀시트 + 데스크톱 중앙)

**Files:**
- Modify: `src/renderer/styles.css`(`@media (max-width:640px)` 바텀시트·미니칩 스트립·위치·reduced-motion)
- Test: `src/renderer/components/ApprovalModal.test.tsx`(CSS 텍스트 회귀 스모크)

**Interfaces:** 없음(CSS·마크업 클래스 계약만).

- [ ] **Step 1: CSS 회귀 스모크 테스트 작성**(jsdom 은 레이아웃 미평가 → styles.css 텍스트 단언):

```tsx
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('반응형 CSS(회귀 가드)', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
  it('폰 바텀시트 미디어쿼리·엄지 버튼 규칙 존재', () => {
    expect(css).toMatch(/@media \(max-width: *640px\)/)
    expect(css).toContain('.modal-chips') // 미니칩 스트립 스타일
    expect(css).toMatch(/prefers-reduced-motion/) // 시트 슬라이드 무애니 가드
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run ... -t "반응형 CSS"` Expected: FAIL(규칙 부재).

- [ ] **Step 3: 구현** — `styles.css` 승인 모달 섹션(`:1050` 뒤)에 추가:

```css
/* 다중 pending 미니칩 내비(§C-5) */
.modal-nav { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.modal-chips { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 2px; }
.modal-chip {
  flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
  background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 9px;
  padding: 6px 9px; color: var(--dim); font: inherit; font-size: 11px; cursor: pointer;
}
.modal-chip.is-current { border-color: var(--signal-line); color: var(--text); }
.modal-chip-risk[data-risk='destructive'] { color: var(--bad); }
.modal-chip-risk[data-risk='caution'] { color: var(--warn); }
.modal-pos { align-self: center; font-size: 11px; color: var(--faint); }

/* 폰 — 바텀시트(엄지 조작·큰 타입) */
@media (max-width: 640px) {
  .modal-overlay { place-items: end stretch; padding: 0; }
  .modal-card {
    max-width: none; width: 100%; border-radius: 18px 18px 0 0;
    max-height: 82vh; overflow-y: auto; padding: 16px 18px 24px;
    animation: sheetUp 0.24s ease both;
  }
  .modal-card .panel-title { font-size: 20px; }
  .modal-summary { font-size: 15px; }
  .modal-actions { gap: 12px; }
  .modal-actions .btn { flex: 1; padding: 14px 0; font-size: 15px; }
  .modal-countdown { flex-basis: 100%; text-align: center; order: -1; margin: 0 0 6px; }
}
@keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) {
  .modal-card { animation: none; }
}
```

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx` Expected: PASS. `npm run format:check`(prettier) GREEN.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/styles.css src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#216-C2): 폰 바텀시트 반응형·미니칩 스트립 스타일 (Part of #216)"
```

---

### Task 6: 스와이프 (진행적 향상 · 폰 가로 제스처)

**Files:**
- Modify: `src/renderer/components/ApprovalModal.tsx`(카드에 pointer 핸들러 — 가로 스와이프 임계 → FOCUS_DELTA)
- Test: `src/renderer/components/ApprovalModal.test.tsx`(pointer 이벤트로 스와이프 검증·jsdom 가능 범위)

**Interfaces:** 없음(카드 onPointer* 내부).

- [ ] **Step 1: 실패 테스트 작성**:

```tsx
describe('스와이프(진행적 향상)', () => {
  it('가로 스와이프(임계 초과)로 focus 이동·이동만(결정 아님)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
    const card = screen.getByRole('dialog').querySelector('.modal-card') as HTMLElement
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 130, clientY: 108 }) // 좌로 70px(>임계·수평)
    expect(screen.getByText('2 / 2')).toBeTruthy() // 다음(B) 로 이동
    expect(respondApproval).not.toHaveBeenCalled()
  })

  it('세로 우세 제스처는 이동 안 함(시트 스크롤 보존)', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
    const card = screen.getByRole('dialog').querySelector('.modal-card') as HTMLElement
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 190, clientY: 200 }) // 세로 우세
    expect(screen.getByText('1 / 2')).toBeTruthy() // 이동 없음
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run ... -t 스와이프` Expected: FAIL(핸들러 없음).

- [ ] **Step 3: 구현** — 스와이프 시작 좌표 ref + 카드 onPointerDown/onPointerUp:

```tsx
const swipeStart = useRef<{ x: number; y: number } | null>(null)
const onCardPointerDown = (e: React.PointerEvent): void => {
  swipeStart.current = { x: e.clientX, y: e.clientY }
}
const onCardPointerUp = (e: React.PointerEvent): void => {
  const s = swipeStart.current
  swipeStart.current = null
  if (!s) return
  const dx = e.clientX - s.x
  const dy = e.clientY - s.y
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return // 임계·수평 우세만
  dispatch({ type: 'FOCUS_DELTA', delta: dx < 0 ? 1 : -1 }) // 좌 스와이프=다음
}
```

카드 요소(`.modal-card`)에 `onPointerDown={onCardPointerDown} onPointerUp={onCardPointerUp}`. 버튼/칩의
pointerdown 은 자체 핸들러가 있고 스와이프는 up-델타 기반이라 탭과 충돌하지 않음(작은 이동=임계 미달=무시).

- [ ] **Step 4: 통과 확인** — `npx vitest run src/renderer/components/ApprovalModal.test.tsx` Expected: PASS(불가 환경이면 라이브 위임 주석). `npx tsc --noEmit` GREEN.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ApprovalModal.tsx src/renderer/components/ApprovalModal.test.tsx
git commit -m "feat(#216-C2): 가로 스와이프 카드 이동(진행적 향상·세로=스크롤 보존) (Part of #216)"
```

---

### Task 7: verify · e2e · brain · 라이브

**Files:** 없음(검증·재생성).

- [ ] **Step 1: 로컬 verify** — `npm run verify`(7게이트: tsc·eslint·prettier·vitest·brain:check 등). Expected: GREEN. 실패 시 해당 태스크로 회귀.
- [ ] **Step 2: electron e2e 무회귀** — `npm run test:e2e`(또는 `--project=electron`). Expected: 9/9 PASS(데스크톱 승인 무회귀).
- [ ] **Step 3: 웹 e2e 폰 뷰포트(가능)** — `e2e/` 에 폰 뷰포트(`page.setViewportSize({width:390,height:844})`) 다중 pending 승인 시나리오 추가 시도(바텀시트·미니칩 이동·mm:ss). 불가 시 라이브로 대체.
- [ ] **Step 4: brain 재생성(별도 커밋)** — 모든 src 변경 후 1회:

```bash
npm run brain
git add brain.md
git commit -m "chore(#216-C2): brain 재생성 (Part of #216)"
```

- [ ] **Step 5: 라이브 터널 폰 실측** — access 모드 실 터널·실 폰: 위험 작업 승인 hold → 폰 바텀시트 카드(엄지 버튼)·다중 pending 미니칩 이동·mm:ss 카운트다운·재접속 스냅숏 재제시·거부/승인 종단. 관찰 기록.
- [ ] **Step 6: PR** — `feat/216-c2-approval-mobile-ux` 푸시 → PR 본문 `Part of #216`(마지막 phase 아님). Codex+CodeRabbit 자동리뷰 대기·인라인 스레드 resolve·`@codex review` 순수 한 줄 재트리거·자체 적대리뷰(fleet-pr-review)·사용자 확인 후 squash.

## 자체 리뷰 (계획↔스펙 대조)

- **스펙 커버리지**: C-1 표시모델→T3 · C-2 focusedId→T2 · C-3 반응형→T5 · C-4 mm:ss→T1 · C-5 미니칩→T3 · 1.8 불변식①(안전 보존)→T2/T4 전 태스크 기존 테스트 GREEN · ②focus 안정→T2 · ③이동≠결정→T3/T4 · ④스와이프 향상→T6 · ⑤skew→T1(카운트다운만·드롭 금지) · ⑥reduced-motion→T5. **P2(트랩 복귀)→T4.** §3 테스트 1~14 전부 태스크에 매핑(1~10 T1~T3/T6·11~14 T4). **누락 없음.**
- **플레이스홀더 스캔**: 각 스텝에 실 코드·경로·명령·기대출력 명시. "적절한 에러처리" 류 없음.
- **타입 일관성**: `approvalReducer`·`ApprovalAction`·`formatCountdown`·`KIND_LABEL`·`dispatch` 시그니처가 T2 정의↔T3/T4/T6 소비 일치. `mkReq`/`mk` 테스트 헬퍼 T1/T2 도입·이후 재사용.
- **범위**: 렌더러 2 소스파일·신규 계약 0·단일 PR. C1 중복 없음(재하이드레이션=C1 재사용)·C3/C5 미혼입.

## 검증 게이트 · PR 경계

- **단일 PR** `feat/216-c2-approval-mobile-ux`·prefix `feat(#216-C2):`·6 구현 커밋(T1~T6·각 tsc+GREEN) + brain 별도 커밋. `Part of #216`.
- **brain 규율**: src 먼저 커밋 → 최종 brain 재생성 → brain.md 별도 커밋(lint-staged prettier 순서 주의·중간 재생성 금지).
- PR open 후 Codex+CodeRabbit 2봇 인라인 스레드 resolve(unresolved=0 머지통과)·자체 적대리뷰(fleet-pr-review·opus/sonnet).
