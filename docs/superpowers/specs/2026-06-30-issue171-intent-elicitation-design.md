# 설계: #171 의도 elicitation 앞단 — 1차 슬라이스 (선택형 폼)

- **이슈**: #171 (`[spike]` · `area:orchestrator` · `area:renderer`)
- **날짜**: 2026-06-30
- **상태**: 설계 확정 (브레인스토밍 + Codex 독립 체크포인트 통과 — [issue#171 comment](https://github.com/pdw96/fleet/issues/171#issuecomment-4840024877))
- **선행**: #167(PR #169) implementer self-verify 토론 · r5 도그푸드(2026-06-30, MOBA 빌드 품질 분석)

## 1. 배경·문제

r5 도그푸드에서 Fleet 이 8-task 로 MOBA 를 end-to-end 빌드했으나 품질(밸런스·게임필·시각 폴리시)이 낮았다.
원인: **산출물 품질이 GOAL 프롬프트의 제약에 직접 게이팅**된다("Canvas 도형만·바닐라·2~4파일"). 즉 결과 품질 ∝ 목표를 얼마나 잘 적었는가.

이는 비개발자에게 진입장벽이다 — 도메인 용어를 몰라 의도를 정밀 명세하지 못하고, 무엇이 품질을 가르는지 모른 채 under-specify 한다.

**현재 코드 경로** (의도를 끌어내는 앞단 없음, 검증됨):
```text
ProjectPanel goal textarea ─ run() ─ window.fleet.runProject({ goal })
  → engine.runProjectFlow(input)            (engine.ts:596)
  → runProject(input.goal, {...})           (engine.ts:681)
  → buildPlannerPrompt(goal)                (plan.ts:40 — "4~8개 작업으로 분해")
  → planner.send
```
한 줄 goal 이 곧장 planner 로 들어간다. 의도 elicitation 층이 없다.

## 2. 결정 요약 (브레인스토밍 + Codex 체크포인트)

| 결정 | 선택 | 근거 |
|---|---|---|
| 작동 방식 | **순수 결정적 폼 (LLM 없음)** | 비개발자 적합·결정적·테스트 100%·최소 슬라이스. LLM 적응질문은 future |
| 배치 | **폼 → textarea 합성** | 폼이 goal 을 보강, textarea 가 단일 source of truth |
| 스파이크 경계 | **기능 + 단위테스트만** | 품질 가설 검증은 다음 도그푸드로 이연 |
| 분야 | **분야 무관 일반 폼** | 문제·설계는 모든 분야 공통, 게임은 발견 매개 |

Codex 독립 리뷰 4개 정밀화 반영(§5·§6·§8·§9) + dirty-form 엣지(§7).

## 3. 범위

**포함**
- `ProjectPanel` goal 입력 위 선택형 elicitation 폼 + "goal에 반영" 버튼.
- 결정적 합성 함수 `composeGoal`.
- **렌더러 ONLY** — main/IPC/orchestrator/shared 타입 무변경. 기존 `runProject({ goal })` 경로 그대로.

**비포함 (명시)**
- LLM 적응형 질문·goal-타입 인식(Option 2)·채팅 인터뷰·레퍼런스 링크/스샷 역추론·품질 A/B 평가 하니스.

## 4. 아키텍처·컴포넌트

- **신규 `src/renderer/components/elicitation.ts`** (`authBanners.ts` 옆 — 렌더러 평면 헬퍼 컨벤션)
  - `ElicitationFields` 타입 · 필드 메타(키·라벨·placeholder·입력종류·select 옵션) · 순수 함수 `composeGoal(base, fields)` · 공유 헬퍼 `isPresent`/`hasAnyPresent`(§6·§7 동일 absent 기준).
  - React 비의존·부수효과 0 → 단위테스트 결정적.
- **`src/renderer/components/ProjectPanel.tsx`** 수정
  - elicitation 필드 상태(`useState<ElicitationFields>`), 폼 UI(textarea 위), "goal에 반영" 버튼, dirty-form 힌트.
  - **`run()` 무변경** — 계속 `goal.trim()` 전송.

## 5. 데이터 흐름 — 접합 메커니즘 A

```text
폼 필드 ─┐
         ├─[goal에 반영]→ setGoal(composeGoal(goal, fields)) + 폼 비움
textarea ┘                                                    ↓
                                  사용자 자유 편집 → run() → runProject({ goal })   (기존 경로 불변)
```

- **빈 폼 + 버튼 = no-op**(textarea 불변) · **폼 미접촉 = 기존 동작 그대로** → 무회귀.
- 1방향 접합 후 폼을 비워 재접합 중복을 막는다(§6 dedup 정책).
- 최종 텍스트는 textarea 에서 직접 편집.
- **대안 B(고려·비채택)**: base+addenda+read-only 라이브 프리뷰, `run()` 이 compose 전송 → 멱등하나 "보이는 textarea = 실행되는 값" 계약을 약화시키고 run 경로를 변경. A 채택.

## 6. composeGoal 계약 *(Codex 정밀화 1)*

`composeGoal(base: string, fields: ElicitationFields): string`

- 부재(absent) 판정은 **공유 헬퍼 `isPresent(value)`**(텍스트: trim 후 비어있지 않음 / select: `''`(미지정) 아님)로 단일화한다. `hasAnyPresent(fields)` = 하나라도 present. **이 헬퍼를 dirty-form 힌트(§7)도 공유**해 compose 와 힌트가 같은 기준을 쓰게 한다.
- **전 필드 부재 → `base` 그대로 반환**(문자열 동일 — 무회귀의 핵심).
- 그 외 → present 필드만 **정의 순서**대로 `- <라벨>: <값>` 으로 `[추가 맥락]` 블록 구성, base 뒤 접합.
  - **base 본문은 보존하되 접합 경계 공백만 정규화** *(Codex 스펙리뷰 보강 1)*: `head = base.trimEnd()` 로 trailing 공백만 제거(planner 무관·앞쪽 빈 줄 방지), `head ? head + '\n\n' + block : block`. 즉 비어/공백 base 면 블록만, 아니면 정확히 한 빈 줄로 구분.

> **결정적 함수이되 멱등 함수가 아니다.** 같은 입력 → 같은 출력은 보장되나, 같은 비-부재 `fields` 를 반복 적용하면 `base` 가 이미 보강된 문자열이라 `[추가 맥락]` 블록이 중복된다. **중복 방지는 함수 속성이 아니라 "접합 후 폼 비움"이라는 UI 운영 규칙으로 보장**한다. 유일한 멱등 케이스는 빈 폼: `composeGoal(base, {}) === base`.

## 7. 에러처리·엣지 *(dirty-form 힌트 — Codex 미언급, 자체 보강)*

- 공백 trim · 전필드 공백 → no-op · select '미지정' → 미기여 · 접합 순서 결정적.
- **폼 dirty-미반영 가드**: 폼에 present 필드가 있는데 "반영"을 안 누른 채 실행하면 폼 내용이 **조용히 누락**된다. → `run()` 은 순수하게 유지(아래 §8)하고, 대신 **렌더러 비차단 힌트**("폼 내용이 goal 에 반영되지 않았습니다 — [goal에 반영]") 만 표시. 자동 compose-on-run 은 §8 위반이라 하지 않는다.
  - **dirty 판정 = `hasAnyPresent(fields)`** (§6과 동일 기준) *(Codex 스펙리뷰 보강 2)*: 공백-only 텍스트·select 미지정은 dirty 가 아니다 → compose 가 아무것도 안 만드는데 힌트만 뜨는 false-alarm 방지.

## 8. 불변식 *(Codex 정밀화 2)*

1. **단일 source of truth = textarea `goal` 상태.** 폼 필드 상태는 실행 입력으로 직접 들어가지 않는다.
2. **`RunProjectRequest` 미확장** — 실행 입력 핵심은 `goal: string` 그대로.
3. **`run()` 은 절대 compose 를 호출하지 않는다** — "보이는 textarea 값"과 "전송되는 값"이 항상 동일.

## 9. PR 프레이밍 *(Codex 정밀화 4)*

- 이번 PR 성공기준 = **goal 보강 UX + 무회귀 경로 검증.** "품질 개선 검증 완료"가 아니다.
- PR 제목/본문/테스트가 품질 가설을 입증한 것처럼 보이지 않게 한다.

## 10. 필드 세트 (분야 무관 5개, 전부 선택)

| 키 | 라벨 | 입력 | placeholder/옵션 |
|---|---|---|---|
| `completeness` | 완성도 수준 | select | 미지정 / 빠른 프로토타입 / 표준 / 높은 완성도 |
| `audience` | 대상 사용자 | text | "누가 사용하나 (예: 초등학생, 사내 개발자)" |
| `reference` | 참고 레퍼런스 / 원하는 결과물 느낌 | text (**텍스트-only**, 링크/스샷=future *Codex 3*) | "\"이것처럼\" (예: Stripe API처럼, 레트로 게임풍)" |
| `success` | 성공 기준 | text | "무엇이 되면 잘 된 것 (예: JWT 로그인 동작)" |
| `constraints` | 제약·필수 | text | "반드시/절대 (예: 바닐라 JS만, 외부 라이브러리 금지)" |

select 값 매핑(planner 가 도메인 맥락에 맞게 해석):
- `prototype` → "빠른 프로토타입 (핵심 동작 위주, 폴리시 최소)"
- `standard` → "표준 (실사용 가능한 완성도)"
- `high` → "높은 완성도 (폴리시·엣지케이스·견고함까지 투자)"

## 11. 테스트 (단위)

**`elicitation.test.ts`**
- 전 필드 부재 → `base` 그대로 반환(`===`) — 무회귀 핵심.
- 각 필드 단독 → 올바른 라벨 줄 접합.
- 다필드 → 정의 순서·단일 `[추가 맥락]` 블록.
- 공백-only 텍스트·select 미지정 → 부재 처리(`isPresent`/`hasAnyPresent` 직접 단언 포함).
- 빈 base + 필드 → 선행 빈 줄 없는 블록 · **trailing 공백 base → `trimEnd` 후 한 빈 줄 구분**(보강 1).
- 결정성: 동일 입력 2회 → 동일 출력.
- 비멱등 계약 문서화: `composeGoal(composeGoal(base,f),f) !== composeGoal(base,f)`.

**`ProjectPanel.test.tsx`** (기존 확장)
- "반영" 버튼: 필드 채움 → 클릭 → textarea(goal) 갱신 + **폼 전 필드 비움(텍스트 `''` + select `''` 초기화 확인)** *(보강 3)*.
- 빈 폼 클릭 → no-op(goal 불변).
- **run 회귀 가드**: 실행이 여전히 textarea `goal` 값 전송(폼 필드는 미전송 — `runProject` mock 인자 단언).
- dirty-form 힌트: present 필드 존재 시 표시 · 반영 후 사라짐 · **공백-only/select 미지정에는 미표시**(absent 기준 일치, 보강 2).

## 12. 측정 프로토콜 (문서화만, 다음 도그푸드)

동일 goal-class 를 elicitation 유/무로 빌드(같은 모델·세션·workspace) → rubric(밸런스·게임필·시각폴리시·기능완성) 채점, 2~3 과제 반복으로 단일 과제 운 완화, 수용조건 충족률 + 비용 지표(질문 수·응답 시간·goal 길이·의도 부합) 병행. **품질 실측 하니스는 이번 슬라이스 밖.**

## 13. Future (입증 시)

- goal-타입 인식(Option 2): 게임/웹앱/CLI/API 별 맞춤 질문 — 일반 메타-차원 가치 입증 후.
- 참고 레퍼런스 링크/스크린샷 분석 · 사용 환경/플랫폼 필드(Codex optional, 1차 제외).
- 채팅 인터뷰(반응 반복 루프) — 채팅 전송계층 위 advanced mode.

## 14. 참조

- 이슈 #171 (본문 v3 코드 대조 11/11) · #167(PR #169) · #125(런타임 재정의 연계).
- Codex 체크포인트 리뷰: [issue#171#issuecomment-4840024877](https://github.com/pdw96/fleet/issues/171#issuecomment-4840024877).
