# #167 — 스폰 CLI implementer 자기검증 도구승인 + 타임아웃 진단 (설계)

- 이슈: [#167](https://github.com/pdw96/fleet/issues/167) (parent #27, `area:orchestrator` · `bug` · `tier:next`)
- 발견: dogfood r4 (2026-06-29), 초안 `.dogfood/issue-drafts-r4.md` 이슈3
- 브랜치: `fix/167-implementer-self-verify-tools`

## 1. 문제

오케스트레이터가 spawn 한 **claude implementer 편집 세션**이 자기 산출물을 검증하지 못하고, 검증 도구 승인 게이트와 씨름하다 hang → `ETIMEDOUT` 으로 죽는다.

### 1A. 자기검증 갭

`src/main/core/cli/registry.ts` — claude edit 어댑터:

```ts
edit: { args: ['-p', '--permission-mode', 'acceptEdits'], parse: 'text' }
```

권위 확정(공식 docs, code.claude.com/docs/en/permission-modes.md): headless `claude -p --permission-mode acceptEdits` 는 **편집 도구 + 8개 파일시스템 Bash 명령**(mkdir·touch·rm·rmdir·mv·cp·sed)만 자동승인하고, **그 외 모든 Bash(`node --check` 포함)는 승인 프롬프트를 띄운다**. 헤드리스엔 승인 경로가 없어 거부된다. dogfood r4 에서:

- "Browser permission not granted. Let me verify syntax via PowerShell instead."
- "Both `node` and the browser require approval I don't have, so I'll verify by careful manual review."
- "The sandbox is restricting `node`" / "sandbox is blocking these read-only verification commands" 반복

→ 에이전트가 자기 산출물을 **수동 코드리뷰로만** 납품(품질·신뢰 저하).

### 1B. 타임아웃 진단 모호

`src/main/core/orchestrator/orchestrator.ts` — `DEFAULT_TASK_TIMEOUT_MS = 900_000`(15분). implementer 가 hang(quota 소진이든 승인 게이트 교착이든)하면 15분 뒤 `detect.ts` 의 `terminate('ETIMEDOUT')` → `task.failed: 실행 오류 - claude 실행 실패: ETIMEDOUT`. 그런데 `task.progress`(에이전트의 실시간 사유)는 **영속하지 않으므로**(orchestrator.ts:108-109, 재생 로그 노이즈 방지) 사후에 quota 소진인지 승인 교착인지 **구분할 단서가 없다**.

## 2. 목표 / 비목표

**목표**
- (B) implementer 실패 시 **마지막 진행 출력(tail)**을 영속 표면화해 quota vs 승인교착을 사후 구분한다. — **본 PR 의 출하 항목.**
- (A) **검토 항목**: 스폰 implementer 에 read-only 검증 도구 자동허용 여부 — **검토 결과 불채택**(§3 Part A, RCE 위험).

**비목표 / 불채택**
- **(A) 검증 도구 자동허용 — 불채택(보안 P1).** `node --check` 등을 `--allowedTools` 로 자동허용하면 prefix allow 규칙이 node preload 플래그(`--require`/`--import`/`--experimental-loader`)를 통과시켜 `--check` 에서도 코드를 실행한다(실측 RCE). acceptEdits 의 "쓰기만·실행 차단" 경계를 깨므로 채택 불가. §3 참조.
- 브라우저/Computer Use 자기검증 — headless `-p` 에서 pre-approve 불가(공식 docs). 현 동작 유지.
- `bypassPermissions`/전체 우회 — 채택 안 함(prompt-injection 무방비, docs 경고).
- **gemini 동작 변경 — 범위 제외.** 실측(2026-06-29, gemini-cli 0.47.0): 개인/무료 티어 인증이 `IneligibleTierError`(→Antigravity)로 세션 실행 불가 + `--allowed-tools` deprecated. 발견은 #146 에 기록.
- codex 동작 변경 — 갭 없음(sandbox-as-boundary).
- Antigravity 어댑터 도입 — 별도 트랙 #124/#146(tier:later).
- ETIMEDOUT 자체의 근절(quota·hang 원인 제거) — 본 PR 은 **진단 표면화**까지만.

## 3. 설계

### Part A — 검증 도구 자동허용: **검토 후 불채택 (보안 P1)**

당초 claude edit 어댑터에 `--allowedTools "Bash(node --check:*),Bash(tsc --noEmit:*)…"` 를 추가하려 했으나, 자가 적대 리뷰 + 실측에서 **임의 코드실행(RCE) 채널**임이 확인되어 **폐기**했다.

**근본 결함**: Claude Code 의 Bash allow 규칙은 prefix/wildcard 문자열 매칭이고 위험 플래그 의미 검사가 없다(docs: permissions.md). `Bash(node --check:*)` 는 `node --check ` 로 시작하는 **임의 후행 인자** 명령을 자동승인하는데, node 의 preload 플래그는 `--check`(구문검사 전용) 에서도 코드를 실행한다.

**실측(출하 런타임 node v24.16.0 / claude 2.1.195, 2026-06-29)**:
- `node --check --require ./pre.js ok.js` → preload 모듈 실행(`PRELOAD_RAN`), exit 0.
- `node --check --import "data:text/javascript,console.log('EXEC_NO_FILE')" ok.js` → **파일 0건**으로 인라인 실행.
- claude `-p --permission-mode acceptEdits --allowedTools "Bash(node --check:*)"` 로 위 preload 명령 → **승인 프롬프트 없이 자동 실행**(`matcher_proof.txt` 작성 확인). 대조: 순수 `node --check ok.js` 는 무실행.

preload 모듈은 child_process(임의 exec)·net/fetch(유출)·fs(워크스페이스 밖 쓰기) 전권 → acceptEdits 가 막던 "코드 실행 차단" 경계를 무력화. prefix allow 규칙으로는 `--require`/`--import`/`--loader` **부정 제약을 표현할 수 없어** 구조적으로 안전화 불가.

**결정**: claude edit 어댑터를 **종전 `['-p', '--permission-mode', 'acceptEdits']` 그대로 유지**(allowlist 미추가). implementer 는 read-only 빌트인(Read/Grep/Glob)으로 검토하고, 실제 verify(typecheck/lint/test)는 Fleet 이 `verify/run.ts` 로 별도 실행한다. registry.ts·registry.test.ts 에 결정 근거 주석 + 회귀 가드 테스트(allowlist/우회 플래그 부재 단언)를 남겨 naive 재도입을 막는다.

**안전 후속(미구현·별도 이슈 후보)**: 헤드리스 self-verify 가 꼭 필요하면, 인자를 sanitize 하고 preload 플래그를 차단하는 **Fleet 번들 검증 래퍼**를 절대경로로 `Bash(node <wrapper>:*)` 만 allow 하는 방식이 유일하게 안전.

### Part B — 스트림 tail 표면화 (`orchestrator.ts`) — **출하**

작업 처리 함수(`runTaskIn`, 순차·병렬 공용)에서 implementer 스트림 델타를 **rolling tail 버퍼**로 누적하고, 실패 시 영속 output 에 첨부한다.

- `try` 진입 **전**(catch 가독 범위, task 별 지역 변수)에 `let progressTail = ''` 선언 — 병렬 실행 간 격리.
- implementer.send 의 `onChunk` 에서: `progressTail = (progressTail + delta).slice(-IMPL_PROGRESS_TAIL_CAP)`(=1000). 라이브 task.progress emit 은 종전대로(추가 영속 없음).
- catch 블록:
  - **abort(skipped)**: 먼저 return → tail 미첨부(취소는 진단 대상 아님).
  - **failed**: `progressTail.trim()` 이 있으면 output 에 `\n\n[마지막 진행 출력]\n${tail}` 첨부. 없으면 종전 메시지 그대로. task.failed event message 는 간결 유지(tail 은 output 에만).
- 병렬 allSettled-rejected 경로(checkpoint/worktree 등 implementer 스트림 **전** 실패)는 progressTail 이 없으므로 tail 미첨부 — 정합.

`task.progress` 비영속 설계(라이브만)는 유지 — tail 은 실패 시점에만 1회 영속 output 에 들어간다.

## 4. 데이터 흐름 / 영향 경계

- `registry.ts`: **변경 없음**(Part A 불채택). 결정 근거 주석만 추가.
- `orchestrator.ts`: `runTaskIn` 내 지역 버퍼 + onChunk 누적 + catch failed 분기 메시지 조립만 변경. 이벤트 타입(task.failed)·data 스키마 불변. 다른 단계(planner/reviewer/summarizer/verify) 무영향.
- `cli-session.ts`/`detect.ts`: 무변경.

## 5. 에러 처리 / 엣지 (Part B)

- abort(skipped): tail 미첨부(취소 분기 early return).
- 빈 tail(즉시 spawn 실패 등): 종전 메시지 그대로(빈 `[마지막 진행 출력]` 블록 미첨부).
- cap(1000자)으로 거대 출력이 output 을 부풀리지 않게 보장 — 여러 chunk 누적도 마지막 cap 자만 슬라이딩 유지.
- 병렬: progressTail 은 task 별 지역 변수라 작업 간 출력이 섞이지 않음.
- tail 내용은 에이전트 텍스트(경로·민감정보 가능) — 단 이미 라이브 task.progress 로 노출되던 내용이고, 외부 전송 없이 사용자 본인 세션 store 에만 1회 영속하며 `.trim()` 적용. cap 으로 노출면 최소.

## 6. 테스트 (TDD RED→GREEN)

- **registry.test.ts** (Part A 가드)
  - claude·codex·gemini edit args 에 `--allowedTools`/`--allowed-tools`/`--dangerously-skip-permissions`/`bypassPermissions` **부재** 단언(보안 회귀 가드).
  - claude edit args === `['-p', '--permission-mode', 'acceptEdits']`(종전 유지).
- **orchestrator.test.ts** (Part B)
  - 실패(예외) 시 output 에 `[마지막 진행 출력]` + tail(예: "require approval") 첨부.
  - abort(skipped) 시 tail 미첨부.
  - cap 경계: 식별 마커로 head 탈락·tail 보존·**정확히 cap 길이** 단언(head/under/over-truncation 회귀 차단).
  - 멀티 chunk 누적: 여러 delta 가 슬라이딩되며 앞 chunk 식별 토큰 탈락·마지막 chunk 보존.
  - 빈 tail(onChunk 없는 실패)은 종전 메시지 유지.

## 7. 게이트 / 리뷰

- 4종 품질 게이트(typecheck·lint·test·format:check) green + windows vitest CI.
- 자가 적대 리뷰(다차원 find→refute) — **P1(node --check preload RCE) 적발 → Part A 폐기**. Codex 체크포인트 리뷰 blind-spot(#2 shell expansion·#6/#7 병렬/abort tail) 실측·코드로 해소.
- 체크포인트: spec 을 #167 코멘트로 등재 + `@codex review`(메모리 워크플로). PR 단계에서 Codex+CodeRabbit 2봇 리뷰 반영 후 squash.

## 8. ADR 여부

운영 지속·교차 결정은 아님(특정 버그의 국소 수정). 별도 ADR 불필요. 단 "헤드리스 CLI implementer 에 Bash 검증 도구를 prefix allow 규칙으로 자동허용하지 않는다(preload RCE)" 는 재현 가능한 보안 원칙이라, 동류 결정이 반복되면 ADR 승격 검토.
