# CLI 세션 "연결 테스트" probe — 설계

- 날짜: 2026-06-26
- 트랙: 세션 등록 UX (provider parity / DX) — #145 항목3
- 이슈: #150 (부모 #145 · 메타 #27)
- 상태: 설계 승인 (Codex 독립 리뷰 조건부 승인 → P1×2 + 보정 반영)
- 근거: 머지된 `docs/superpowers/specs/2026-06-25-session-auth-picker-design.md` §7·§7a · 계획 「미해결/후속」

## 1. 배경 / 문제

CLI 세션(claude/codex/gemini)은 v1에서 인증을 **첫 실제 사용 시 lazy 검증**한다. `CliDetectionResult`는 `installed`/`version`만 보고하고 **로그인 상태 필드가 없다**(스펙 §7) — 재감지(`detectCli` = `--version`)로는 *설치*만 확인 가능, *로그인 성공*은 싸게 확인 불가. v1 정직성은 picker의 "미검증 배지" + "검증 없이 등록" 문구가 사전 고지로 담당하나, 사용자가 **등록 시점에 실제 로그인이 통하는지 능동 확인**할 수단이 없다.

이 스펙은 스펙 §7a가 "(선택, 비-v1)"로 미뤄둔 **"연결 테스트" secondary action** 을 정착한다.

## 2. 범위

- **포함**: picker 구독 CLI 등록 마법사에서 "연결 테스트" 1회 실행 → transient 결과 표시.
- **비목표 (YAGNI, solo pre-1.0)**: 기존 세션 카드 재테스트 · `authStatus` 저장 필드 · 모델 출력 파싱 · 다중 프롬프트/재시도 · 비용 사전 견적 · API 키 세션 probe(자체 검증 존재) · 자동 probe(등록 즉시 자동 호출).

## 3. 결정 (브레인스토밍 확정)

1. **검증 방식 = 실 모델 1회 왕복.** detect(`--version`)는 설치만 보므로, 로그인 검증은 어댑터 headless 호출 + 최소 프롬프트로 짧은 실 호출 1회(스펙 §7의 `claude -p "ok"` 의도). CLI별 비-모델 `auth status` 서브커맨드는 3 CLI 통일 계약 부재·버전 의존이라 기각. **세션ID 미지정 = ephemeral**(Fleet descriptor/state 오염 0).
2. **노출 범위 = picker 등록 시만 (v1).** "검증 없이 등록" 옆 "연결 테스트" secondary action. 결과는 **transient**(저장 필드 없음, §7a `authStatus` 미도입)·**실패해도 등록 비차단**·미검증 배지 유지.
3. **분류 = exit code + stderr.** 모델 출력은 파싱하지 않는다(실제 세션 실행 경로와 판단 기준 일치 — 분기하면 회귀면 증가).

## 4. 아키텍처

### 4.1 순수 함수 `probeCliAuth` — `src/main/core/cli/probe.ts` (신규)

```
probeCliAuth(adapter: CliAdapter, runner: CommandRunner = defaultRunner)
  → Promise<ProbeResult>
```

동작:
- argv = **`buildHeadlessArgs(adapter, PROBE_PROMPT)`** 재사용(Codex P1-1 — `{prompt}` 치환·미래 어댑터 흡수). `src/main/core/session/cli-session.ts:12` 의 기존 export.
- stdin = 기존 `stdinFor` 로직과 동형: `adapter.promptVia === 'stdin' ? PROBE_PROMPT : undefined`.
- 실행: `runner(adapter.command, argv, { timeoutMs: PROBE_TIMEOUT_MS, stdinInput })`. (v1 취소 UI 없음 → AbortSignal 미도입; bounding 은 runner 내부 timeout+kill-tree 가 담당 — YAGNI.)
- `PROBE_PROMPT` = 최소 프롬프트(예: `Reply with: ok`) — 토큰 최소화. **모델 출력 비검사**(exit + stderr 만).
- `PROBE_TIMEOUT_MS = 20_000` — 모델 왕복 여유 + kill-tree 보호(상수·테스트로 고정).

분류(우선순위 순):
| 조건 | 결과 |
|---|---|
| `res.spawnError === 'ETIMEDOUT' \|\| 'ABORTED'` | `{ status: 'timeout' }` |
| 그 외 `res.spawnError` (ENOENT·ENOBUFS 등) | `{ status: 'error', detail }` |
| `res.code === 0` | `{ status: 'ok' }` |
| `res.code !== 0` & `classifyCliAuthHint` 매치 | `{ status: 'auth', hint }` |
| `res.code !== 0` & 미매치 | `{ status: 'error', detail }` |

- **never-throws 계약**(등록 비차단) — `runner` 호출을 try/catch 로 감싸 reject 까지 `{status:'error'}` 로 정규화(주입 runner·미래 구현 방어, Codex 계획 리뷰 P1). 테스트로 고정.
- `detail` = **stderr 우선(비면 stdout 폴백) → ANSI/제어시퀀스 제거 → 길이 truncation(500자)**. 작은 `stripControlSeq` 유틸(과설계 금지·기존 `cleanCliOutput`엔 ANSI 제거 없음 확인). 계정/경로/토큰 일부·codex JSONL stdout 노출·색코드 깨짐 방지(Codex 설계+스펙 리뷰 보정).

### 4.2 타입 `ProbeResult` — `src/shared/types.ts`

renderer/preload/main 공유 IPC 반환 타입이므로 shared 에 둔다(Codex 보정).

```ts
export type ProbeStatus = 'ok' | 'auth' | 'error' | 'timeout'
export interface ProbeResult {
  status: ProbeStatus
  hint?: string    // status==='auth' (classifyCliAuthHint 결과)
  detail?: string  // status==='error' (truncated stderr/spawnError)
}
```

### 4.3 엔진 `engine.probeCli(adapterId)` — `src/main/core/engine.ts`

`cliRegistry.get(adapterId)` 조회 → 없으면 `{ status: 'error', detail: 'unknown adapter' }`(non-throwing 일관) → 있으면 `probeCliAuth(adapter, runner)`. `detectClis` 와 동일 `runner` 사용.

### 4.4 IPC — parity 3곳

- main(`src/main/index.ts`): `ipcMain.handle('fleet:cli:probe', (_e, adapterId: CliAdapterId) => engine.probeCli(adapterId))` — IPC 경계 런타임 값 불신, registry lookup 으로 검증(`fleet:external:openDocs` 패턴).
- preload(`src/preload/index.ts`): `probeCli: (adapterId) => ipcRenderer.invoke('fleet:cli:probe', adapterId)`.
- shared(`FleetBridge`): `probeCli(adapterId: CliAdapterId): Promise<ProbeResult>`.

### 4.5 렌더러 — `src/renderer/components/AddAiWizard.tsx` 구독(subscription) step

(picker 마법사 = `AddAiWizard`, `SessionsPanel` 이 `<AddAiWizard>` 로 렌더. probe 버튼은 `installed` 분기의 "검증 없이 등록" 옆.) **"연결 테스트"** secondary 버튼. 클릭 → 스피너 → `window.fleet.probeCli(adapterId)` → transient 인라인 결과:
- `ok` → `✓ 방금 연결 테스트 성공 — 이 결과는 저장되지 않습니다`
- `auth` → `⚠ {hint}`
- `error` → `⚠ 연결 테스트 실패 — 그래도 등록할 수 있습니다 ({detail})`
- `timeout` → `⏱ 시간 초과 — 그래도 등록할 수 있습니다`

**등록·배지·descriptor 불변**(비저장). 미검증 배지(`로그인 미검증·첫 메시지에서 확인`)는 유지 — 저장 상태와 일회성 결과를 텍스트로 분리(Codex P1-2). 버튼 보조문구(비용 고지): `연결 테스트는 선택한 CLI로 짧은 실제 모델 호출을 1회 실행합니다. 구독/쿼터/요금이 사용될 수 있습니다.`

## 5. 데이터 흐름

렌더러 클릭 → IPC `fleet:cli:probe` → `engine.probeCli` → `probeCliAuth` → `defaultRunner`(headless argv · stdin · `PROBE_TIMEOUT_MS`) → `CommandResult` → 분류 → `ProbeResult` → IPC 반환 → 렌더러 transient 표시.

## 6. 에러 / 엣지 / 보장

- **프로세스 hang은 timeout + kill-tree 로 bounded**(Codex — "신규 위험 0" 과장 하향). runner 의 stdin-EOF + timeout + killTree + grace SIGKILL 재사용. (CLI 자체가 브라우저 로그인 플로우/네트워크 내부 정지여도 Fleet 관점에서는 bounded.)
- 출력 폭주 → `ENOBUFS` terminate → `error`.
- 어떤 실패든 등록 흐름 무영향(never-throws).
- exit 0 오판(드묾): 실제 세션 실행도 exit code/spawnError 를 신뢰하므로 probe 만 출력 파싱하면 판단 기준이 갈라져 회귀면 증가 → 동일 기준 유지.

## 7. 보안 / ToS

- probe = **Fleet 가 이미 지원하는 동일 CLI 인증·실행 경로를 수동으로 1회 앞당기는 것**(신규 제3자 전송 경로·provider 계약 없음). 노출면은 기능적으로 동일하나 사용 시점·빈도는 버튼으로 새로 생긴다(Codex — "신규 노출면 0" 과장 하향).
- Gemini ToS 리스크는 기존 배너(§5)가 고지(#146). `docsUrl`/`loginCommand` 는 정적 registry 만.
- `detail` truncation 으로 출력 내 민감 토막 노출 최소화.

## 8. 테스트 (TDD: RED→GREEN, mock runner 전용)

- `probe.test.ts`(신규):
  - `ok`(exit 0) · `auth`(exit≠0 + stderr "not logged in" → hint 포함) · `error`(exit≠0 비-auth) · `timeout`(spawnError `ETIMEDOUT`/`ABORTED`) · **`ENOBUFS`→`error`**(timeout 아님) 단언.
  - argv = `buildHeadlessArgs(adapter, PROBE_PROMPT)` · `promptVia==='stdin'`이면 stdinInput=PROBE_PROMPT, 아니면 undefined · `timeoutMs===PROBE_TIMEOUT_MS` 단언.
  - **`promptVia:'arg'` + `headless.args:['run','{prompt}']` 어댑터** → stdinInput=undefined·argv에 PROBE_PROMPT 치환(미래 어댑터 계약 고정 — Codex 스펙 리뷰 near-mandatory).
  - **headless 없는 어댑터** → `buildHeadlessArgs` fallback `['{prompt}']`→`[PROBE_PROMPT]`.
  - **never-throws** 단언(모든 분기) + **runner reject → `{status:'error'}` 정규화**(Codex 계획 리뷰 P1).
  - `detail` = stderr 우선·stdout 폴백 시에도 truncation 적용·**ANSI/제어시퀀스 제거** 단언(긴 stderr 잘림 + `\x1b[31m...\x1b[0m` 제거).
- `engine.test.ts` 보강: `probeCli` adapterId→adapter 라우팅 · unknown id → `{status:'error'}`.
- 렌더러(vitest): "연결 테스트" 버튼 렌더(구독 분기) · 클릭→스피너→상태별 결과 표시 · **실패가 등록 버튼/플로우 비차단** · **성공 시 descriptor/session 저장값 불변**.
- IPC 가드: unknown adapterId 거부/일관 처리.
- **실 CLI 호출 테스트는 넣지 않는다**(CI/E2E 포함 mock 만).

## 9. Codex 독립 리뷰 반영 (2026-06-26, #150)

**1차 — 설계 리뷰 판정 「조건부 승인」** — P1×2 + 보정 전량 코드 검증 후 수용(반박 0):
1. P1-1: `buildHeadlessArgs` 재사용(`{prompt}`·`promptVia` 계약 흡수) — §4.1.
2. P1-2: transient 성공 문구 분리 — §4.5.
3. 보정: `ProbeResult`→shared(§4.2) · IPC parity 3곳(§4.4) · `detail` truncation+stderr 우선(§4.1·§7) · `ENOBUFS`→error 테스트(§8) · never-throws 고정(§4.1·§8) · `PROBE_TIMEOUT_MS` 상수+mock-only 테스트(§4.1·§8) · 비용 고지 강화(§4.5) · 절대 표현 하향(§6·§7) · 렌더러 비저장/비차단 테스트(§8).

**2차 — 스펙 리뷰 판정 「승인(P0/P1 블로커 없음)」** — 분류표 순서·`PROBE_PROMPT`·shared 타입·runner 주입·unknown-id non-throwing 정합 확인. 잔여 P2 2건 수용:
4. `detail` sanitize 에 **ANSI/제어시퀀스 제거** 추가(작은 유틸·과설계 금지) — §4.1·§8.
5. **`promptVia:'arg'` + headless-fallback 테스트**(buildHeadlessArgs 재사용 계약 고정) — §8.

**3차 — 계획 리뷰 판정 「조건부 승인」** — Task 분해·순서·IPC parity·재사용 타당 확인. P1 1건 + P2 수용(계획 문서 `docs/superpowers/plans/2026-06-26-cli-auth-probe.md`):
6. **P1: runner reject 까지 try/catch → `{status:'error'}` 정규화**(never-throws 완전화) + reject 테스트 — §4.1·§8.
7. P2: 렌더러 테스트는 기존 `fireEvent`+`mockFleet` 관용구 사용 · `DETAIL_MAX` 로컬 유지 · ANSI OSC 제거는 YAGNI 스킵.

## 10. 참고

- 재사용: `buildHeadlessArgs`(cli-session.ts:12) · `classifyCliAuthHint`(authHint.ts, #148 `a0d23cb`) · `defaultRunner`/`CommandResult`(detect.ts).
- 현행 IPC: main `fleet:cli:detect`/`adapters`/`session:registerCli`/`external:openDocs` · preload `detectClis`/`listAdapters`/`registerCliSession`/`openDocs`.
- PR 본문: `Closes #150` + `Part of #145`(멀티항목 부모 조기종료 방지).
