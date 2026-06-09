# 설계: append-only 보정 replan 슬라이스 (planner-in-the-loop)

- 날짜: 2026-06-09
- 출처: GitHub 이슈 #12(planner-in-the-loop replan)의 **슬라이스**. 이슈 #27 로드맵의 🟡 Next 1순위
  (가치 3 / 노력 3 / 리스크 3). 풀 재계획(#12 전체)이 아니라 **append-only 보정 replan** 한 조각.
- 범위: verify-fix 루프가 소진된 뒤에도 검증이 실패하면, planner 에게 검증 실패를 되먹여 **보정 작업만**
  분해(append-only)하고 기존 `runTask` 로 순차 실행한 뒤 재검증한다. 기본 비활성(`maxReplanRounds` 기본 0).

## 배경 / 문제

현재 `runProject`(`orchestrator.ts`)는 단발 계획(`planTasks`) 후 실행하며, 작업별 review→revise·
프로젝트 단위 verify→fix 루프는 있으나 **planner 가 중간 결과(검증 실패)를 보고 작업 그래프를 확장하지는
않는다**. verify-fix 루프(L308-391)는 *같은 자리에서* implementer 를 재실행해 in-place 수정만 시도하고,
maxVerifyFixRounds 소진 시 그대로 실패로 종료한다.

핵심 사실(코드 검증, 2026-06-09):

- `runTask`(L139-243)는 `runProject` 내부 **클로저**다 → verify 블록 이후 지점에서 호출 가능
  (체크포인트 → 직접편집 → diff 교차리뷰 → 위험게이트 → keep/revert 전 과정 포함).
- verify-fix 루프는 `if (opts.verify && !opts.signal?.aborted)` 블록(L312-391) 안에서 `verifyOnce`·
  `emitVerify`·`fixImplementer`(cli) 가드를 이미 구성한다 → 보정 루프를 **이 블록 안, for-loop 직후**에
  두면 전부 재사용한다.
- `maxVerifyFixRounds` 는 `RunProjectRequest`(IPC)에 **없다**. engine 이 `runProject` 로 넘기지 않고
  오케스트레이터 기본값(2)만 쓰는 RunOptions-only 노브다(L314-315 클램프 idiom: `>= 0`, 0=비활성).
- `plan.ts`의 `PLANNER_SCHEMA`·`parsePlannedTasks`(공개) 재사용 가능. 단 `parsePlannedTasks`는
  **빈 배열을 에러로 throw**한다 — 보정 맥락에서 빈 목록은 "수정 불필요"인 **정상** 결과라 별도 처리 필요.
- 렌더러는 이벤트를 `if (e.type === ...)` **허용형 필터**로 소비(exhaustive switch 아님,
  `ProjectPanel.tsx:122-144`) → 새 이벤트 타입 추가는 typecheck 무파손, 새 작업은 `refreshTasks`(L144)로
  보드에 자동 반영. 렌더러 변경 0.

## 계약 / 노브

### RunOptions (orchestrator.ts) — 결정 ①A: RunOptions-only, 기본 0

```ts
/** 검증 실패 시 planner 에게 보정 작업을 받아 append+실행+재검증하는 최대 라운드. 0/음수/NaN → 0(비활성). */
maxReplanRounds?: number
```

- `maxVerifyFixRounds` 와 **동일 패턴**: engine 이 전달하지 않음 → 기본 0 → **프로덕션에서 off 로 착지**.
- IPC(`RunProjectRequest`)·preload·renderer·engine **무변경** → AGENTS.md "preload/IPC 변경 후 재시작"
  함정 회피. UI 노출/프로덕션 활성화는 명시적 후속(비범위).
- 클램프 idiom 은 verify-fix(L314-315) 복제: `const requested = Math.floor(opts.maxReplanRounds ?? 0);
  const maxReplan = Number.isFinite(requested) && requested >= 0 ? requested : 0`.

### 이벤트 (shared/types.ts) — 결정 ③: `'replan'` 1개만

`OrchestratorEventType` 유니온에 `'replan'` 추가(+1줄). 추가 작업/보정 없음/보정계획 실패를 모두 `message`로
구분(별도 타입 추가 안 함 → IPC 표면 최소). `data`에 `{ projectId, round, count? }`.

## 동작 (bounded loop)

삽입 위치: verify-fix for-loop **직후**(L390 다음), `if (opts.verify…)` 블록 **안**, 상태결정(L395) **전**.

```
const requested = Math.floor(opts.maxReplanRounds ?? 0)
const maxReplan = Number.isFinite(requested) && requested >= 0 ? requested : 0
for (
  let round = 1;
  round <= maxReplan &&
  verifications.some((v) => !v.passed) &&
  !!opts.workspace && !!fixImplementer && fixImplementer.descriptor.kind === 'cli' &&
  !opts.signal?.aborted;
  round++
) {
  const failing = verifications.filter((v) => !v.passed)
  let corrective: PlannedTask[]
  try {
    corrective = await planCorrectiveTasks(goal, failing, planner, opts.signal)
  } catch (err) {
    emit({ type: 'replan', message: `보정 계획 실패: …`, data: { projectId, round } }) // 표면화(비-silent)
    break
  }
  if (corrective.length === 0) {
    emit({ type: 'replan', message: '보정 작업 없음 — replan 종료', data: { projectId, round, count: 0 } })
    break // 결정론적 조기 종료
  }
  emit({ type: 'replan', message: `보정 작업 ${corrective.length}개 추가 (라운드 ${round})`,
         data: { projectId, round, count: corrective.length } })
  for (const ct of corrective) {
    if (opts.signal?.aborted) break
    const created = store.createTask({ projectId, title: ct.title, description: ct.description,
                                       role: ct.role ?? 'implementer' }) // append-only
    await runTask(created) // 기존 클로저: 체크포인트/리뷰/위험게이트/keep 전부 상속
  }
  verifications = await verifyOnce()
  emitVerify(verifications)
}
```

### 불변식 / 안전

- **append-only**: 기존 작업을 수정·취소·재정렬하지 않는다. 보정 작업만 `store.createTask` 로 추가.
  보정 작업은 의존성 없는 평면 목록 → 위상 sweep 불필요, 순차 실행.
- **종료 보장(무한루프 방지)**: `maxReplan` 상한 + planner 빈 목록 조기 `break`. `runProject` 재진입 없음.
- **위험 게이트 상속**: `runTask` 내부가 이미 `classifyDiffRisk`+`gate` 를 통과 → 보정 편집도 자동 게이팅.
- **재검증 후 상태결정 정합**: replan 이 `verifications` 를 갱신 → 기존 L395-397 `verifyFailed` 가 자연히
  반영(전부 통과면 'done', 아니면 'failed'). 상태결정 분기 자체는 **무변경**.
- **취소 정합**: 루프 조건·내부 작업 루프 모두 `opts.signal?.aborted` 확인 → 취소 시 즉시 중단.
- **#7(silent failure) 준수**: 보정 계획 파싱/호출 실패는 `replan` 이벤트로 **표면화**하고 중단(흡수 금지).

## plan.ts 추가

### `parsePlannedTasks` — 결정 ②: allowEmpty 옵션 (하위호환)

```ts
export function parsePlannedTasks(text: string, opts?: { allowEmpty?: boolean }): PlannedTask[] {
  const arr = coerceTaskArray(text)
  if (!Array.isArray(arr)) throw new Error('계획은 JSON 배열이어야 합니다.')
  if (arr.length === 0) {
    if (opts?.allowEmpty) return []          // 보정 맥락: 빈 목록 = 수정 불필요(정상)
    throw new Error('분해된 작업이 없습니다(빈 계획).') // 기존 동작 보존(기본)
  }
  return arr.map(/* 기존 정규화 그대로 */)
}
```

- 파싱 실패(`coerceTaskArray`→`extractJsonArray` throw)는 그대로 전파 → silent 흡수 없음.
- 기존 호출부(`planTasks`)는 인자 미전달 → 빈 계획 throw 유지(회귀 0).

### `buildReplanPrompt` / `planCorrectiveTasks` (신규)

```ts
/** 검증 실패를 planner 에 되먹여 '추가 보정 작업'만 분해(풀 재계획 아님). 보정 불필요면 빈 배열. */
export function buildReplanPrompt(goal: string, failures: readonly VerificationResult[]): string
export async function planCorrectiveTasks(
  goal: string, failures: readonly VerificationResult[], planner: LlmSession, signal?: AbortSignal,
): Promise<PlannedTask[]>
```

- 프롬프트: 목표 + 각 실패의 `kind`·`command`·`analysis ?? stderr` 요약 + "실패 해소용 추가 작업만 분해,
  불필요하면 빈 배열 `{"tasks":[]}`" 명시. 출력 형식은 `buildPlannerPrompt` 와 동일한 `{"tasks":[...]}`.
- 호출: `planner.send(prompt, { fresh:true, signal, responseSchema:{ name:'plan', schema:PLANNER_SCHEMA },
  bypassTools:true })` → `parsePlannedTasks(reply, { allowEmpty: true })`.
- `VerificationResult` 타입은 `shared/types.ts` 에서 import(`plan.ts` 신규 의존).

## TDD 계획 (코어 변경엔 *.test.ts 동반 — AGENTS.md)

`plan.test.ts`:
- `parsePlannedTasks('{"tasks":[]}', { allowEmpty:true })` → `[]`.
- `parsePlannedTasks('{"tasks":[]}')`(옵션 없음) → throw(기존 동작 보존).
- `buildReplanPrompt` 가 실패 요약(kind/command)을 포함.
- `planCorrectiveTasks` 가 빈 목록·정상 목록 모두 처리(fake planner 세션).

`orchestrator.test.ts`(verify-fix 테스트 idiom 복제 — L842 패턴):
- **기본 0=비실행**: `maxReplanRounds` 미지정 시 verify 실패해도 planner 추가 호출 0, 작업 수 불변.
- **보정→통과**: verify 1차 실패 → replan 1회(보정 1개 실행) → 2차 통과 → 프로젝트 'done',
  store 에 보정 작업 append 확인, `replan` 이벤트 방출.
- **상한 소진**: `maxReplanRounds: 2`, planner 가 매번 보정 1개, verify 계속 실패 → replan 정확히 2회
  (off-by-one 가드), 프로젝트 'failed'.
- **빈 목록 조기 종료**: planner 가 `{"tasks":[]}` → replan 0회 실행(작업 추가 없음) + break.
- **append-only**: 기존 작업 status/내용 불변, 보정 작업만 신규 추가.
- 품질 게이트 4종: `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

## 영향 파일 (코어 한정)

- `src/shared/types.ts` — `OrchestratorEventType` 에 `'replan'`(+1줄).
- `src/main/core/orchestrator/orchestrator.ts` — `RunOptions.maxReplanRounds?` + 보정 replan 루프.
- `src/main/core/orchestrator/plan.ts` — `parsePlannedTasks` allowEmpty + `buildReplanPrompt` +
  `planCorrectiveTasks` + `VerificationResult` import.
- `src/main/core/orchestrator/orchestrator.test.ts`, `src/main/core/orchestrator/plan.test.ts` — 위 TDD.

## 비범위 (YAGNI)

- **프로덕션 활성화 / UI 노출**: `maxReplanRounds` 를 `RunProjectRequest`·engine·preload·renderer 로
  배선하는 작업. 기본 0 으로 착지하고 후속 PR 에서 노출(결정 ①A).
- **#12 풀 replan**: 실행 중 작업 그래프 전체 재계획·취소·재구성(`runProject` 재진입화). 이 슬라이스로
  가치 증명 후 승격(로드맵 ⚪ Later).
- **#26 후속(b) 스트리밍 400 가드**: 현재 latent(결합 호출자 0). 스트리밍 planner 활성 지점과 동반 머지 —
  이 슬라이스는 비스트리밍 planner 만 사용하므로 동반 불필요.
- 보정 작업 간 의존성 그래프 / 위상 정렬 — 보정은 평면 목록으로 충분(순차 실행).

## 미해결 / 라이브 검증 사항

- 단위 테스트(fake 세션)로 루프 계약·종료·append-only 를 고정한다. **실제 LLM 이 유용한 보정 작업을
  생성하는지는 라이브 키로 별도 확인**(이 PR 범위는 루프 메커니즘 + 파싱까지). 기본 0 이라 회귀 0.
