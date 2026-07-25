# C2 스펙 — 승인 카드 모바일 UX·다중 pending·재접속 UX (#216 Phase C · Part of #193)

C1(#219 머지 `08e12ae`)이 코어 계약(hold-with-expiry·`expiresAt` 서버권위·`listPendingApprovals`
스냅숏·`onApprovalWithdrawn` tombstone·id 기반 `respondApproval`·재하이드레이션)을 성립시켰다.
C2 는 그 위에 **표시/상호작용 층**만 얹는다 — 폰 가독·엄지 조작(바텀시트), 다중 pending 가시성·임의
순서 결정(집중 카드 + 점/미니칩 내비), 사람이 읽는 카운트다운(mm:ss). **순수 렌더러/CSS·신규 계약 0.**

이 문서는 **무엇(계약·불변식·테스트)** 을 정의하고 **어떻게(태스크 순서)** 는 체크포인트 3(계획)에 위임한다.

> **완료 정의(#216) 연계**: "외출 중 폰 승인 → PC 이어실행". C1 이 기능적 성립(라이브 폰 실증),
> C2 는 그 폰 경험을 실사용 가능한 품질로(엄지 도달·다중 pending 판단·가독) 끌어올린다.

## 0. 현행 상태 (C1 결과 — 코드 실측 · 근거 라인)

| 지점 | 현행 동작 | 근거 |
|---|---|---|
| 표시 모델 | `current = queue[0]` **단일 카드 FIFO**. 나머지는 `queue.length>1 && "대기 중 N건"` 텍스트뿐(내비 없음) | `ApprovalModal.tsx:127,246` |
| 큐 상태 | `queue: ApprovalRequest[]`(라이브 upsert)·`tombstone: Set`·`now`(1s 틱) | `ApprovalModal.tsx:50-53` |
| 재하이드레이션 | `useHydration().nonce` effect → `listPendingApprovals` upsert·reconcile·제한 재시도 | `ApprovalModal.tsx:79-117` |
| 카운트다운 | `Math.max(0, Math.ceil((expiresAt-now)/1000))` → `"{remaining}s 후 자동 거부"` | `ApprovalModal.tsx:129,227` |
| 안전(파괴적) | 오조준 intent 가드(pointerdown/keydown id 스냅숏)·거부-우선 포커스·Escape=거부·Tab 트랩(document)·Enter no-op | `ApprovalModal.tsx:54-56,134-196` |
| skew 처리 | 로컬 시계로 카드 **드롭 금지**(서버 권위)·카운트다운만 0 클램프 | `ApprovalModal.tsx:20-27,119-125` |
| 레이아웃 | `.modal-overlay`(grid place-items center)·`.modal-card`(max-width 480px). **폭 기반 @media 0개**(데스크톱 전용) | `styles.css:1005-1050` · @media 검색=reduced-motion 만 |
| viewport | `width=device-width, initial-scale=1.0`(폰 준비됨) | `index.html:5` |
| 테스트 | jsdom·@testing-library/react. 기존 27케이스(포커스·트랩·하이드레이션·tombstone·skew·오조준) | `ApprovalModal.test.tsx` |

**C2 가 바꾸는 것**: 표시 모델(단일→집중+내비)·레이아웃(중앙 전용→반응형 바텀시트)·카운트다운 형식.
**C2 가 보존하는 것**: 위 안전·skew·하이드레이션·tombstone 계약 **전부**(회귀 0).

## 1. 계약 (C2 확정)

### C-1. 표시 모델 — 집중 카드 + 다중 pending 내비

- **집중 카드 1장**을 크게 제시(파괴적 승인 = "한 번에 하나 집중"으로 오승인 억제 — C1 안전 모델 계승).
- 다중 pending 은 **미니칩 스트립(각 pending 의 종류·위험) + 위치 텍스트(N / 총)** 으로 가시화(폰·데스크톱 공통·§C-3 정정).
- 이동 수단: **미니칩 탭 · `←`/`→` 키 · (폰) 가로 스와이프**. 이동하면 그 카드가 집중 카드가 된다.
- **임의 순서 결정**: 어느 pending 이든 이동해 거부/승인(C1 `respondApproval(id)` out-of-order 지원). 큐 배열은
  FIFO 유지 — "리오더"=보는 위치 변경으로 먼저 처리할 수 있다는 의미(배열 재정렬 아님·드래그 아님).

### C-2. 상태 모델 — `focusedId`(NOT index)

집중 카드는 **id 로 추적**한다(위치 인덱스 아님):

```ts
const [queue, setQueue] = useState<ApprovalRequest[]>([])
const [focusedId, setFocusedId] = useState<string | null>(null)
// 파생: focusedId 가 큐에 있으면 그 카드, 없거나 null 이면 큐 앞(FIFO 기본).
const current = queue.find((r) => r.id === focusedId) ?? queue[0]
const position = current ? queue.findIndex((r) => r.id === current.id) + 1 : 0  // 1..N 표시
```

**index 아닌 id 추적 근거(불변식 §1.8-⑦)**: `focusedIndex` 로 추적하면 집중 카드보다 **앞** 순번의 카드가
withdrawn 될 때 배열이 앞으로 밀려 인덱스는 그대로인데 가리키는 카드가 바뀐다 = **조용한 집중 스왑 →
사용자가 읽지 않은 카드의 우발 결정 위험**(C1 오조준 가드가 막던 바로 그 부류의 위험을 상태 층에서 재생산).
id 추적은 앞 카드 제거에도 집중 카드가 불변.

상태 전이:
- **새 라이브 요청 도착**(`onApprovalRequest`): 큐 뒤 upsert. `focusedId` **불변**(사용자가 보던 카드 유지 —
  얌체 점프 방지). 큐가 비어 있었으면 `current`=새 카드(자연 파생).
- **집중 카드 이탈**(결정/`onApprovalWithdrawn`/reconcile 제거): 이탈 id===focusedId 이면 `focusedId` 를
  **이웃**(제거 시점의 다음 카드, 없으면 이전, 없으면 null)로 이동. 이탈 id≠focusedId 이면 `focusedId` 불변
  (집중 카드 무영향 — id 추적의 이점).
- **사용자 이동**(칩 탭/화살표/스와이프): `focusedId` = 대상 카드 id. 화살표는 큐 순서로 ±1(경계 clamp·미순환).
- **카드 전환**(current.id 변화)마다 **거부 버튼 재포커스**(C1 안전 방향 — 기존 `[current?.id]` effect 계승).
- **Tab 트랩·포커스 이탈 복귀**(Codex 체크포인트 2 P2 편입): 미니칩·내비가 `<button>` 으로 액션 버튼보다
  DOM **앞**에 오므로, 현행 document 트랩의 `querySelectorAll('button')` **첫 요소** 기반 복귀는 이탈 시
  **첫 칩**으로 복귀 = 거부-우선 붕괴. → **포커스 이탈 복귀(모달 밖으로 샜을 때) target 을 항상 `rejectRef`(거부)
  로 고정**(DOM 순서 무관). Tab **순환**은 모든 focusable(칩/내비/거부/승인) 포함(a11y — 키보드로 칩 도달·순환은
  첫/마지막 focusable 경계 유지·모달 밖 탈출 없음). 칩/내비 focus 중 **Enter=이동만**(결정 아님·불변식③).

### C-3. 반응형 레이아웃 (브레이크포인트 1개 = `max-width: 640px`)

- **폰(≤640px)**: `.modal-card` 를 **바텀시트**로 — 하단 고정·상단 라운드·핸들바·**시트 높이 Tall ≈ 76vh
  고정**(내용이 넘치면 시트 내부만 세로 스크롤·버튼/카운트다운은 바닥 고정 유지). 버튼 **풀폭·상하 14px
  패딩**(엄지 타깃). 타입 확대(제목 Fraunces 18px·요약 14px·대상 박스). 미니칩 스트립 표시. 시트 상향
  슬라이드 애니메이션(§reduced-motion 존중).
- **데스크톱(>640px)**: **현행 중앙 모달 그대로**(`.modal-overlay` grid center·max-width 480px). 내비는 폰과
  **동일 미니칩 스트립 + 위치 텍스트**(별도 점 컨트롤 없음)·`←→` 키(스와이프는 터치 전용이라 데스크톱 미적용).
- **단일 컴포넌트**·CSS 미디어쿼리로 앵커/치수만 분기(마크업 동일·JS 분기 없음) → 데스크톱 무회귀·테스트/코드 최소.

> **정정(적대 리뷰 F3/F9 반영)**: 초기 스펙은 "데스크톱=점(dots)+텍스트, 미니칩 폰 한정"이었으나 — (1) 미니칩이
> 점보다 종류·위험 정보량이 크고 데스크톱에서도 유용, (2) 폰/데스크톱 내비를 다르게 하면 마크업 분기로 코드·
> 테스트가 늘어 "단일 컴포넌트·JS 분기 없음" 원칙과 상충. → **미니칩+위치 텍스트를 양쪽 공통**으로 확정(별도
> 점 컨트롤 미구현·위치 텍스트가 대체). **스와이프만 터치 전용**(데스크톱 마우스/펜은 게이트 아웃 — 텍스트
> 선택·칩 스크롤 오발화 차단).
- 오버레이(`.modal-overlay`·backdrop)·`role=dialog aria-modal` 은 양쪽 공통 유지.

### C-4. 카운트다운 = mm:ss

- `"{remaining}s 후 자동 거부"` → **`"{m}:{ss} 후 자동 거부"`**(예 10분→`9:33`, 5초→`0:05`). `Math.max(0,…)`
  클램프 유지(로컬 만료 초과=`0:00`·카드 드롭 금지·서버 권위 불변 — C1 skew 계약).
- 순수 포맷터 `formatCountdown(ms): string`(`ss` 2자리 zero-pad·`m` 무제한). expiresAt 파생은 C1 그대로
  (서버 권위·공유상수 `APPROVAL_TIMEOUT_MS` 미소비 — 회귀 가드 유지).

### C-5. 미니칩 스트립 (폰 · 다중 pending 가시성)

- `queue.length>1` 일 때만. 각 pending 을 칩(종류 라벨 + 위험 chip)으로·가로 스크롤. 집중 칩 강조(앰버 보더).
- 칩 **탭 → 그 카드로 focus 이동**(setFocusedId). 접근성: 칩=`<button>`·`aria-current` 로 집중 표시·
  `aria-label`(종류·위험·위치).
- 데스크톱도 동일 미니칩 스트립 + 위치 텍스트(`N / 총`) 노출(별도 점 컨트롤 없음·마크업 공통). `←→` 키 내비(§C-3 정정).

### 1.8 불변식 (구현 전 확정)

- **① C1 안전 계약 보존**: 오조준 intent 가드·거부-우선 포커스·Escape=거부·Tab 트랩(document)·Enter no-op —
  표시/내비 변경에도 전부 동일 동작(기존 테스트 GREEN 유지가 핀). **Tab 트랩 이탈 복귀 target=`rejectRef` 고정**
  (§C-2 — 미니칩/내비 버튼으로 DOM 첫 버튼≠거부가 되어도 거부-우선 복귀 불변·Codex 체크포인트 2 P2).
- **② focus 안정성**: 집중 카드는 **id 로 고정**(§C-2). 앞 순번 카드 제거·새 라이브 append 가 집중 카드를
  조용히 바꾸지 않는다.
- **③ 이동≠결정**: 칩 탭/화살표/스와이프는 focus만 옮긴다(결정 아님). 결정은 거부/승인 버튼(오조준 가드 경유)만.
- **④ 스와이프는 진행적 향상(터치 전용)**: 가로 스와이프(임계 초과)만 이동·**`pointerType==='touch'` 게이트**
  (데스크톱 마우스/펜 미발화). 칩·화살표가 완전 대체(스와이프 없이도 전 기능 도달 — a11y·데스크톱). 세로 제스처는
  시트 스크롤(가로만 가로챔). **버튼/칩서 시작한 제스처는 stopPropagation 으로 스와이프 배제**(카드 본문 시작만·적대 리뷰 F1/F7).
- **⑤ skew·서버권위 보존**: 로컬 시계로 카드 드롭 금지·카운트다운만 `0:00` 클램프·제거는 서버(withdrawn/
  reconcile) 권위(C1 §C-3 계승).
- **⑥ reduced-motion 존중**: 바텀시트 슬라이드/전환 애니메이션은 `prefers-reduced-motion: reduce` 에서 무애니(styles.css 기존 규율 계승).

## 2. 변경 표면 (렌더러 전용 · 신규 계약 0)

| 파일 | 변경 |
|---|---|
| `src/renderer/components/ApprovalModal.tsx` | `focusedId` 상태·`current`/`position` 파생·이동 핸들러(칩/화살표/스와이프)·미니칩 스트립·`formatCountdown`·카드 전환 시 focusedId clamp. **C1 안전/하이드레이션/tombstone/skew 로직 보존.** |
| `src/renderer/styles.css` | `@media (max-width:640px)` 바텀시트(앵커·핸들·풀폭 버튼·타입 확대)·미니칩 스트립·점 내비 스타일. 데스크톱 규칙 무변경. |
| `src/renderer/components/ApprovalModal.test.tsx` | 형식 변경 테스트 갱신(`대기 중 N건`→점/칩·`Ns`→mm:ss) + 신규(내비·focus 안정·clamp·포맷 경계·반응형). |

**parity 표면 없음**: FleetBridge·채널·preload·server·handlers **무변경**(C1 계약 재사용). 데스크톱/웹 공용 컴포넌트라 electron·web 양 e2e 자동 커버.

## 3. 코어 계약 테스트 (완료 조건)

**보존(회귀 0 — 기존 케이스 GREEN 유지):** 렌더/승인/거부/큐 1건씩 전진/Escape/거부-우선 포커스/Tab 트랩(3종)/aria/
Enter no-op/reject 흡수/하이드레이션(#24·#24b)/upsert dedupe(#25)/reconcile(#P2)/tombstone(#26)/skew(2종)/오조준(2종).
→ 형식 의존 케이스만 갱신: **#25** `"대기 중 2건"`→점/위치 단언 · **#27·skew** `"Ns 후 자동 거부"`→mm:ss.

**신규:**
1. **다중 내비 — 화살표**: 3건 큐·`→` → position 2 카드가 current·`←` 경계 clamp(1에서 `←`=무이동).
2. **다중 내비 — 미니칩 탭**: 칩 탭 → 그 카드 current·`aria-current` 이동.
3. **임의 순서 결정**: 2건째로 이동 후 승인 → `respondApproval(2번id,true)`·1번 pending 유지·current=1번(이웃 이동).
4. **focus 안정(id 추적·불변식②)**: 집중=2번일 때 1번(앞) withdrawn → current 여전히 2번(인덱스였으면 스왑됐을 상황).
5. **새 라이브 미점프**: 집중=2번일 때 새 라이브 도착 → current 불변(2번)·큐 뒤 추가·position N 증가.
6. **집중 카드 이탈 clamp + 거부 재포커스**: 집중 카드 결정/withdrawn → 이웃으로 focus·거부 버튼 재포커스.
7. **mm:ss 포맷**: `formatCountdown` 경계 — `600000→"10:00"`·`5000→"0:05"`·`0/음수→"0:00"`·`65000→"1:05"`.
8. **이동≠결정(불변식③)**: 화살표/칩 탭이 `respondApproval` 미호출.
9. **반응형 스모크**: styles.css 에 `max-width:640px` 규칙 존재(회귀 가드) — 바텀시트 클래스/미디어쿼리 단언
   (jsdom 은 실 레이아웃 미평가 → CSS 텍스트/클래스 존재 수준·실 앵커는 웹 e2e·라이브).
10. **스와이프(가능 범위)**: pointer/touch 이벤트로 가로 스와이프 임계 초과 → focus 이동(불가 시 라이브 위임 명시).
11. **Tab 트랩 이탈 복귀=거부**(Codex P2): 미니칩 존재 다중 pending·포커스가 모달 밖(배경)으로 샜을 때 Tab →
    **거부** 버튼 복귀(첫 칩/내비 아님). 기존 document-트랩 테스트를 신규 DOM(칩 선행)에 맞춰 갱신·강화.
12. **미니칩 상태서 C1 안전 GREEN**(Codex P2): 미니칩 있는 다중 pending 에서 `Escape=거부`·`Enter no-op`·
    거부-우선 초기 포커스 기존 계약 유지(칩 추가가 안전 계약을 깨지 않음).
13. **트랩 순환 비탈출**(Codex P2): 칩/내비 포함 상태서 `Tab`/`Shift+Tab` 이 모달 밖으로 탈출하지 않음
    (첫/마지막 focusable 경계 순환).
14. **칩/내비 Enter=이동만**(Codex P2·불변식③): 칩/내비 버튼 focus 중 `Enter` 는 focus 이동만·`respondApproval` 미호출.

**e2e/라이브:** electron e2e 9/9 무회귀 · (가능) 웹 e2e 폰 뷰포트(`page.setViewportSize`) 다중 pending 승인 시나리오 ·
라이브 터널 폰 실측(바텀시트 엄지 조작·미니칩 이동·mm:ss).

## 4. 비목표 (명시)

- **신규 계약/채널/서버 변경 없음** — C1 계약 재사용(있으면 스코프 초과).
- **드래그 리오더 없음** — "리오더"=focus 이동에 의한 임의 순서 결정뿐(배열 재정렬 아님).
- **Web Push 없음**(C4) · **graceful drain 무관**(C3) · **다중 사용자/재시작 생존 없음**(C1 비목표 계승).
- **모든 pending 동시 결정(일괄 승인) 없음** — 파괴적 승인은 한 번에 하나(안전). 일괄은 재평가 대상 아님.
- **데스크톱 UX 재설계 아님** — 중앙 모달 유지 + 점 내비만 additive(무회귀).

## 5. 검증 요청 포인트 (체크포인트 2 리뷰 대상)

1. **C-2 focusedId 추적**이 앞 카드 제거·새 라이브 append 의 조용한 집중 스왑(오승인 위험)을 옳게 닫는가.
   index 추적 대비 잔여 엣지(이웃 선택 규칙·null 폴백)·이탈 시 focus 이동 방향이 안전(파괴적 미노출)한가.
2. **C-1/C-5 내비**(칩/화살표/스와이프 = 이동, 버튼 = 결정)의 분리가 오승인 표면을 넓히지 않는가.
   스와이프 진행적 향상(불변식④)이 세로 스크롤과 충돌하지 않고 미지원서 완전 대체되는가.
3. **C-3 반응형 단일 컴포넌트**(CSS-only 분기·데스크톱 무회귀)가 마크업/JS 분기보다 안전·충분한가.
   바텀시트 Tall 에서 긴 summary/target 의 세로 스크롤·엄지 버튼 고정이 성립하는가.
4. **테스트 적정성** — §3 보존/신규가 표시 모델 전환의 회귀(특히 안전 계약)·신규 상태(focusedId)의 엣지를
   충분히 고정하는가. jsdom 이 못 보는 실 레이아웃/제스처의 e2e·라이브 위임이 타당한가.
5. **범위** — C2(모바일 UX)로 적정한가, C1 로 이미 충족돼 뺄 것 / C3·C5 로 미룰 것이 섞여 있지 않은가.
