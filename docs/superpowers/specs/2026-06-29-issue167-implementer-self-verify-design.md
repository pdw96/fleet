# #167 — 스폰 CLI implementer 자기검증 도구승인 + 타임아웃 진단 (설계)

- 이슈: [#167](https://github.com/pdw96/fleet/issues/167) (parent #27, `area:orchestrator` · `bug` · `tier:next`)
- 발견: dogfood r4 (2026-06-29), 초안 `.dogfood/issue-drafts-r4.md` 이슈3
- 브랜치: `fix/167-implementer-self-verify-tools`

## 1. 문제

오케스트레이터가 spawn 한 **claude implementer 편집 세션**이 자기 산출물을 검증하지 못하고, 검증 도구 승인 게이트와 씨름하다 hang → `ETIMEDOUT` 으로 죽는다.

### 1A. 자기검증 갭 (핵심)

`src/main/core/cli/registry.ts:35` — claude edit 어댑터:

```ts
edit: { args: ['-p', '--permission-mode', 'acceptEdits'], parse: 'text' }
```

권위 확정(공식 docs, code.claude.com/docs/en/permission-modes.md): headless `claude -p --permission-mode acceptEdits` 는 **편집 도구 + 8개 파일시스템 Bash 명령**(mkdir·touch·rm·rmdir·mv·cp·sed)만 자동승인하고, **그 외 모든 Bash(`node --check` 포함)는 여전히 승인 프롬프트를 띄운다**. 헤드리스엔 인터랙티브 승인 경로가 없어 → 도구 호출이 **abort**(no-prompt). 그 결과 dogfood r4 에서:

- "Browser permission not granted. Let me verify syntax via PowerShell instead."
- "Both `node` and the browser require approval I don't have, so I'll verify by careful manual review of the full file."
- "The sandbox is restricting `node`" / "sandbox is blocking these read-only verification commands" 반복

→ 에이전트가 자기 산출물을 **수동 코드리뷰로만** 납품(품질·신뢰 저하).

`gemini` edit(`--approval-mode auto_edit`, registry.ts:95)도 동형 갭: auto_edit 는 편집만 자동승인하고 `run_shell_command` 는 확인 필요. `codex` edit(`-s workspace-write`, registry.ts:69)는 sandbox-as-boundary 구조라 워크스페이스 내 명령을 자동실행 → **갭 없음**(변경 대상 아님).

### 1B. 타임아웃 진단 모호

`src/main/core/orchestrator/orchestrator.ts:90` — `DEFAULT_TASK_TIMEOUT_MS = 900_000`(15분). implementer 가 hang(quota 소진이든 승인 게이트 교착이든)하면 15분 뒤 `detect.ts` 의 `terminate('ETIMEDOUT')` → `task.failed: 실행 오류 - claude 실행 실패: ETIMEDOUT`. 그런데 `task.progress`(에이전트의 실시간 사유)는 **영속하지 않으므로**(orchestrator.ts:108-109, 재생 로그 노이즈 방지) 사후에 quota 소진인지 승인 교착인지 **구분할 단서가 없다**.

## 2. 목표 / 비목표

**목표**
- (A) **claude** implementer 가 **read-only 검증**(JS 구문 `node --check`·TS 타입체크 `tsc --noEmit`)을 자동 승인받아 self-verify 한다.
- (B) implementer 실패 시 **마지막 진행 출력(tail)**을 영속 표면화해 quota vs 승인교착을 사후 구분한다.

**비목표**
- 브라우저/Computer Use 자기검증 — headless `-p` 에서 pre-approve 불가(공식 docs). 에이전트가 "브라우저 검증 불가" 사유만 표기하는 현 동작 유지.
- 임의 코드 실행·쓰기·네트워크 자동허용 — 기존 "전체 우회 아님" posture 유지(`bypassPermissions` 채택 안 함).
- **gemini 동작 변경 — 범위 제외(claude-only).** 실측(2026-06-29, gemini-cli 0.47.0): 개인/무료 티어 인증이 `IneligibleTierError`(→Antigravity)로 **죽어 세션 자체가 실행 불가** → edit allowlist 는 dead-path·검증 불가. 게다가 `--allowed-tools` 는 deprecated(1.0 제거 예정, Policy Engine 권장). 따라서 unverifiable 한 투기적 인자를 싣지 않는다. 발견은 #146(gemini ToS/Antigravity 트랙)에 입력으로 기록.
- codex 동작 변경 — 갭 없음. (방어적 approval_policy 추가도 본 PR 범위 밖.)
- Antigravity 어댑터 도입 — 별도 트랙 #124/#146(tier:later).
- ETIMEDOUT 자체의 근절(quota·hang 원인 제거) — (A)가 node 게이트 교착 일부를 제거하나, 본 PR 은 **진단 표면화**까지만.

## 3. 설계

### Part A — read-only 검증 allowlist (`registry.ts`)

claude edit 어댑터 인자에 read-only 검증 도구만 화이트리스트로 추가(gemini/codex 변경 없음):

```ts
edit: { args: ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_VERIFY_ALLOWED_TOOLS], parse: 'text' }
```

**`CLAUDE_VERIFY_ALLOWED_TOOLS`** (콤마결합 단일 값) = 순수 read-only 검증만:
- `Bash(node --check:*)` — JS 구문 파싱(무실행).
- `Bash(tsc --noEmit)` · `Bash(tsc --noEmit:*)` — TS 타입체크(무emit, 인자 유무 양쪽).

쓰기·임의 코드실행·네트워크 없음 → 기존 "전체 우회 아님" posture 유지. (Read/Grep/Glob·ls/cat/grep 등 read-only 빌트인은 이미 자동허용이라 별도 불필요. 워크스페이스 verify(typecheck/lint/test)는 Fleet 이 `verify/run.ts` 로 별도 실행하므로, 여기 allowlist 는 에이전트의 **편집 중 즉석 구문/타입 확인** 용도. npx 러너는 임의 명령 실행 표면이라 제외.)

**플래그 구문은 실측 확정(claude 2.1.195, 2026-06-29)** — silent 미적용 리스크 제거:
- `--allowedTools "Bash(node --check:*)"` → 에이전트가 `node --check bad.js`/`good.js` 실제 실행(exit 1 SyntaxError / exit 0). ✅
- **negative control**: allowlist 없이 동일 명령 → "requires your approval to run" 차단(=dogfood 증상). ✅ → fix 가 load-bearing.
- 콤마결합 다중 값(`Bash(node --check:*),Bash(node --version)`) → 두 번째 엔트리로만 허용되는 `node --version` 실행됨 → **콤마 분리 정상**. ✅
- 공식 docs(permissions.md): `:*` ≡ 공백 ` *`(동등), 컴파운드(`x && rm -rf /`)는 셸 연산자 분해 후 각 sub-command 매칭이라 우회 차단, `--allowedTools` 는 mode baseline 위에 레이어됨. ✅

### Part B — 스트림 tail 표면화 (`orchestrator.ts`)

작업 처리 함수에서 implementer 스트림 델타를 **rolling tail 버퍼**로 누적하고, 실패 시 영속 output 에 첨부한다.

- `try` 진입 **전**(catch 가독 범위)에 `let progressTail = ''` 선언.
- implementer.send 의 `onChunk` 에서: `progressTail = (progressTail + delta).slice(-TAIL_CAP)` (예 `TAIL_CAP = 1000`). 라이브 task.progress emit 은 종전대로(추가 영속 없음).
- catch 블록:
  - **abort(skipped)**: tail 미첨부(취소는 진단 대상 아님, 기존 동작 보존).
  - **failed**: tail 이 있으면 output·task.failed 메시지에 `\n\n[마지막 진행 출력]\n${progressTail}` 형태로 첨부. 없으면 종전 메시지 그대로.

`task.progress` 비영속 설계(라이브만)는 유지 — tail 은 실패 시점에만 1회 영속 output 에 들어간다.

## 4. 데이터 흐름 / 영향 경계

- `registry.ts`: 정적 어댑터 정의 변경(런타임 로직 무변). `CliAdapter` 타입 불변(edit.args 배열 길이만 증가).
- `orchestrator.ts`: 작업 처리 함수 내 지역 버퍼 + catch 메시지 조립만 변경. 이벤트 타입(task.failed)·data 스키마 불변. 다른 단계(planner/reviewer/summarizer/verify) 무영향.
- `cli-session.ts`/`detect.ts`: 무변경(allowlist 는 어댑터 args 로 자연히 흘러 `buildEditArgs` → spawn).

## 5. 에러 처리 / 엣지

- allowlist 인자가 비-claude 어댑터(codex·gemini)엔 없음(무회귀).
- tail 이 비어있는 실패(즉시 spawn 실패 등): 종전 메시지 그대로(빈 `[마지막 진행 출력]` 블록 미첨부).
- tail 길이 cap 으로 거대 출력이 output/이벤트를 부풀리지 않게 보장.
- tail 내용은 에이전트 텍스트(경로·민감정보 포함 가능) — 단, 이미 라이브 task.progress 로 노출되던 내용이고 실패 output 은 사용자 본인 세션에만 표시되므로 추가 노출면 없음.

## 6. 테스트 (TDD RED→GREEN)

- **registry.test.ts**
  - claude edit args 가 `--allowedTools` + read-only 검증 패턴(`Bash(node --check:*)`·`Bash(tsc --noEmit:*)`)을 포함.
  - claude allowlist 에 쓰기/실행 명령(bare `node`·`npm`·`rm`·`bash`)이 **미포함**(read-only 한정 단언).
  - gemini·codex edit args 에 allowlist 미포함(무회귀) — 기존 단언 유지.
- **session.test.ts**: edit 모드 실행이 allowlist 인자를 자식 argv 로 전달(buildEditArgs 경로).
- **orchestrator.test.ts**
  - implementer.send 실패(예외) 시 task output 에 `[마지막 진행 출력]` + tail 첨부.
  - abort(skipped) 시 tail 미첨부.
  - tail 길이가 cap 을 넘지 않음.
  - tail 없는 실패는 종전 메시지 유지.

## 7. 게이트 / 리뷰

- 4종 품질 게이트(typecheck·lint·test·format:check) green + windows vitest CI.
- 자가 적대 리뷰(다차원 find→refute).
- 체크포인트: 본 spec 을 #167 코멘트로 등재 + `@codex review`(메모리 워크플로). PR 단계에서 Codex+CodeRabbit 2봇 리뷰 반영 후 squash.

## 8. ADR 여부

운영 지속·교차 결정은 아님(특정 버그의 국소 수정). 별도 ADR 불필요 — 단, "헤드리스 CLI implementer 는 read-only 검증만 자동허용(전체 우회 금지)" 원칙이 반복 결정이 되면 그때 ADR 승격 검토.
