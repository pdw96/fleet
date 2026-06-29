# 오케스트레이터 리뷰 루프 수정 — 설계 (이슈 #162)

작성: 2026-06-29 · 브랜치 `fix/orchestrator-review-loop` · Closes #162
검토: Codex 2라운드(1차 조건부 승인 → v2 가 조건 충족, 반박 없이 동일 구현으로 확인).

## 1. 문제

Fleet 오케스트레이터의 멀티태스크 빌드가 사실상 "리뷰어가 우연히 승인할 때만" 동작한다.
첫 태스크가 리뷰에서 거부되면 의존 태스크 전부가 cascade skip 되어 산출물이 안 나온다.

## 2. 근본 원인 (격리 재현으로 확정)

`src/main/core/orchestrator/review.ts` `buildReviewPrompt` 가 **"비판적으로 검토하라" + 이진
approve/reject** 를 요구한다. 어떤 LLM이든 "비판적 리뷰"를 요청받으면 거의 항상 트집을 잡아
`approved:false` 를 낸다.

실제 리뷰 프롬프트에 3줄짜리 명백히 올바른 `add(a,b)` diff(작업: "두 수를 더하는 함수 추가")를
넣어 양쪽 CLI 직접 호출:

- `claude -p` → `{"approved": false, "feedback": "테스트 없음 / 입력검증 없음 / EOL 없음"}`
- `codex exec --json` → `{"approved": false, "feedback": "TDD 단위 테스트 필요"}`

→ 작업을 올바로 달성한 변경조차 "개선 여지"를 거부 사유로 승격. `maxReviewRounds=2`(UI 미노출·
기본 고정)라 첫 태스크가 거의 항상 2라운드 내 미승인 → `task.failed(미승인, 재검토 한도 초과)` →
의존 태스크 cascade skip.

**파싱 버그 아님**: `cli-session.ts` 가 `responseSchema` 를 무시하지만 프롬프트가 JSON 출력을
지시 → 모델이 깨끗한 JSON 반환 → `parseReviewVerdict` 정상 파싱, verdict 가 genuine `false`.

발견 맥락: #161(win32 verify fix) dogfood 재구동 중. reviewer=Claude(r2)·reviewer=Codex(r3)
둘 다 task1 2라운드 거부 → 동일하게 게임 미빌드(8태스크 중 1 실패 → 7 skip).

## 3. 수정 (독립 레버 2개)

### 레버 1 — 리뷰 프롬프트 재작성 (`buildReviewPrompt`)

"비판적으로 검토"를 **대칭적·구체적** 기준으로 교체:

```text
승인(approved:true) — 아래를 모두 만족:
- 작업 설명을 실질적으로 달성함.
- 명백한 버그·요구사항 위반·런타임/타입/테스트 실패 가능성이 없음.
- 잘못된 파일·범위 외 변경이 없음.
→ 추가 테스트·더 넓은 입력 검증·스타일·리팩터 제안은 feedback에 적을 수 있으나
  approved:false 사유가 아니다.

거부(approved:false) — 아래 중 하나라도 해당:
- 작업 미완성(요구된 것을 안 함).
- diff가 요구사항과 충돌.
- 구체적인 런타임/타입/테스트 실패 가능성.
- 잘못된 파일·범위 외 변경.

feedback: 거부면 무엇을 어떻게 고칠지 구체적으로. 승인이어도 advisory 개선 제안 허용.
출력: {"approved": boolean, "feedback": string} JSON만(설명/마크다운 금지).
```

- `REVIEW_SCHEMA`(approved/feedback) 유지. `parseReviewVerdict` 는 이미 approved 무관하게
  feedback 보존 → `approved:true`+advisory feedback 그대로 파싱됨(추가 영속 머신리 불필요 = YAGNI).

### 레버 2 — accept-with-warnings 최종 라운드 (`orchestrator.ts` 리뷰 루프)

```text
for round in 0..maxRounds:
  implement → collectDiff → ignored changes → destructive gate(거부 시 fail+return, 불변)
  reviewer verdict
  approved → break (승인 keep, 불변)
  reject:
    isLastRound = (round === maxRounds-1)
    !isLastRound → rollback(실패 시 hard-fail+return, 불변) + feedback로 재시도
    isLastRound  → rollback 안 함, 루프 종료
after loop, !approved:                # 마지막 reviewer reject만 도달
  keepHash = ws.keep("[title] accept-with-warnings ...")
  task.status = done; output += 경고(마지막 feedback)
  emit task.accepted_with_warnings { taskId, round, feedback }
  done.add(taskId); return { keepHash, ignoredTouched }
```

**accept-with-warnings에 절대 도달하지 않는 경로**(전부 더 앞에서 hard-fail/우회 — 코드로 확인.
도입이 이 방어들을 약화하지 않는다):

| 경로 | 처리 | 위치 |
|---|---|---|
| destructive gate 미승인 | `위험 변경 미승인` failed + return (reviewer 호출 전) | orchestrator.ts:330-344 |
| 민감 ignored baseline capture 실패 | failed + return (루프 전) | :247-261 |
| 중간 라운드 reject 후 rollback 실패 | `리뷰 거절 후 되돌리기 실패` failed + return | :378-391 |
| LLM 호출 오류 / abort | catch → failed / skipped + return | :424+ |
| no-reviewer | `approved=true` → 승인 keep 경로(accept-with-warnings 아님) | :348-351 |

즉 바꾸는 코드는 `if (!approved)` 블록(:394-408)뿐이고, 그 분기는 **루프가 깨끗이 미승인
종료한 경우만** 도달한다.

## 4. 안전 framing

- **destructive `ApprovalGate` = 안전 경계**(불변, hard-block). accept-with-warnings 는 비-destructive
  리뷰 거부에만 적용.
- **verify(typecheck/lint/test) = 최종 smoke 백스톱.** "충분히 안전" 이 아니라 — semantic 결함은
  warning 으로 표면화되고, verify 가 깨질 결함은 verify-fix/실패 경로가 잡는다.

## 5. 이벤트/타입 계약

- `src/shared/types.ts` `OrchestratorEventType` 유니온에 `'task.accepted_with_warnings'` 추가.
- 이벤트 `data = { taskId, round, feedback }`. `task.output` 에 마지막 feedback 포함.
- `TaskStatus` 는 늘리지 않음(`done` 유지) → UI/의존성 스케줄러 영향 최소.
- 병렬 worktree 통합: `done.add(taskId)` + `keepHash` 반환 → 일반 done 과 동일 cherry-pick.
  `changedFiles.length===0` 은 기존 "변경 없는 done" 과 동일 취급.
- renderer 가 이벤트 타입을 exhaustive 처리하면 새 케이스 1줄 추가(구현 중 확인).

## 6. 테스트 (TDD, RED→GREEN)

`review.test.ts`
- 새 프롬프트 framing: "개선 여지 ≠ 거부 사유" + "실제 결함만 거부" 문구 포함, approved/feedback/diff
  키워드 유지.

`orchestrator.test.ts`
1. **계약 반전**: 기존 "never approves → `failed`(commits 0)" → "accept-with-warnings(`done`·commits 1·
   `task.accepted_with_warnings` emit·output에 feedback)".
2. 중간 거부는 rollback, 마지막 거부만 keep (maxReviewRounds=2: r1 reject→revert, r2 reject→keep 1).
3. **destructive gate 미승인은 accept 안 됨** — reviewer 거부 여부 무관 `failed` + keep 0.
4. 중간 라운드 rollback 실패는 여전히 hard-fail.
5. 의존 태스크 cascade 방지 + 부모 경고가 이벤트/출력에서 가시.
6. **accept-with-warnings 후 verify 실패 → 프로젝트가 최종 성공으로 보이지 않음**(verify 실패 정책 경로).
7. no-reviewer 경로 무회귀(새 이벤트 오방출 안 함).
- 승인 경로 테스트(orchestrator.test.ts:390)는 그대로 green.

행동 증거(프롬프트가 실제로 add()를 승인)는 LLM 비결정성으로 단위 테스트 불가 → 프롬프트 framing은
텍스트 단위 테스트로, 동작은 격리 재현(이미 수행)으로 가드.

## 7. 범위 밖 (YAGNI)

- `maxReviewRounds` UI 노출/기본 상향 — 안 함(프롬프트 수정으로 라운드 거의 불필요, cascade는
  accept-with-warnings 가 방지).
- approve-feedback 전용 영속/표면화 머신리 — 안 함.

## 8. 품질 게이트

코어 변경(순수 TS)만 → `typecheck · lint · test · build` 4종. preload/IPC 시그니처 불변
(이벤트 타입만 shared/types 유니온에 추가). `windows vitest` 회귀 잡 무관(verify 경로 미변경).
