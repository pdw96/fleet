# #214 — CLI 샌드박스-in-컨테이너: 환경-인지 샌드박스 posture 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **이슈:** #214 (v3 메타 #193) · **스펙:** `docs/superpowers/specs/2026-07-07-issue214-cli-sandbox-in-container-design.md` (판사 지적 2건 반영판) · **날짜:** 2026-07-07

## 판사 패널 기록 (fleet-plan-panel)

- **초안 3**: A=리스크 우선 / B=MVP 우선 / C=계약 우선 — 각도 붕괴 없음(검증 전략·핀 밀도·시퀀싱 실질 상이, 두 판사 공히 판정).
- **채점**: judge A(공백 그룹) C 19 · A 18 · B 14 / judge B(Codex 강점 그룹) C 20 · A 16 · B 15 → **승자 C 만장일치**. 본 계획 = C 골격 + 이식 7건 + 공통 결함 보강 4건.
- **공백 그룹 지적(반영)**: 신뢰-디렉터리 스코프 실측이 RED 에 선행해야(→T0 병합·스펙 갱신) · gemini 라이브 증적 1런 추가(한계비용~0) · 부팅 거부=compose 재시작 루프 진단 README 1줄 · `docker logs` negative grep 명시 단언.
- **Codex 강점 그룹 지적(반영)**: session 경로 approval_policy 비대칭(→스펙 조정표 갱신: session 에도 `--config approval_policy="never"`) · `FLEET_DATA_DIR` 는 `?.trim()` 관례 예외(형제 스윕 서술 정정) · B 의 compose 핀 절삭 논거 REFUTED(라인 유실 시 부팅 정상→런타임 bwrap 재발=원증상 재현·진단 고비용 → **핀 유지**) · runtime `register()` 비변환 seam 핀 추가.
- **이식(출처)**: T0 확장·컨테이너-안 실측 강제·이슈 코멘트 증적(A) / `docker compose config` 보간 확인·라이브 사용자 개입 착수 전 확인(B).
- 이 구분 기록은 이후 Codex 체크포인트 리뷰와 대조해 렌즈 실효(비중복 지적 ≥1건)를 측정하는 데 쓴다.
- **Codex 체크포인트 1R(2026-07-07) 대조**: 지적 1건 — stateful resume 의 유효 argv 에서 `extraArgs()`(model/MCP)가 `{sessionId}` 뒤에 결합돼 템플릿 핀만으론 positional 계약을 못 지킨다(CONFIRMED·반영: T0 ⑥·T2 유효-argv 테스트·Global Constraints 단서). **판사 양 그룹 모두 미적발 = Codex 리뷰 비중복 실효 1건.**

**Goal:** 비특권 컨테이너(uid 1000)에서 codex bwrap(user namespace) 실패로 깨지는 런을 "컨테이너=유일 샌드박스 경계" posture 로 복구 — 실 codex/claude 런 `project.done` 완주 + 데스크톱 무회귀 + ADR-0010 + 환경-인지 스위칭 테스트.

**Tech:** TypeScript(strict) · vitest · 기존 seam 만(신규 dep 0). 브랜치 `feat/214-sandbox-boundary` · 커밋 prefix `feat(#214):` · PR `Closes #214`.

**착수 전 확인(운영 전제):** 라이브 검증(T7·T8)은 배포 호스트의 compose 재빌드 + Cloudflare Access 실로그인을 요구한다 — B6 때와 동일 환경 가용인지 착수 시점에 사용자 확인.

---

## 계약 명세 (전 태스크의 권위 — 구현은 이 표를 벗어나지 않는다)

### C1. env 계약 — `FLEET_SANDBOX_BOUNDARY`

| 항목 | 내용 |
|---|---|
| 시그니처 | `export type SandboxBoundary = 'cli' \| 'container'` · `export function resolveSandboxBoundary(env: NodeJS.ProcessEnv): SandboxBoundary` — `src/server/boot.ts`(`resolveBindHost`/`resolvePort` 동거. 코어에 boundary 개념 미노출 — 엔진은 registry 데이터만 받는다) |
| 파싱 관례 | `env['FLEET_SANDBOX_BOUNDARY']?.trim() \|\| undefined` — 빈/공백 = 미설정 |
| 유효값 | 미설정 → `'cli'`(기본 — 데스크톱·베어호스트 무회귀) · `'cli'` · `'container'`. trim 후 **소문자 exact 만** |
| 실패 모드 | 그 외 전부 → **throw(부팅 거부·loud fail)** — 메시지에 env 이름·수신값·유효값. 조용한 강등 금지 |
| 호출 위치 | `bootServer` 최상단, `resolveSecurityConfig` 직후·**모든 부수효과(mkdirSync 등) 이전** fail-fast |

### C2. CliAdapter container variant — 데이터 계약

| 항목 | 내용 |
|---|---|
| 시그니처 | `export function containerCliAdapters(base: readonly CliAdapter[] = DEFAULT_CLI_ADAPTERS): readonly CliAdapter[]` — `src/main/core/cli/registry.ts`, `DEFAULT_CLI_ADAPTERS` 바로 아래(드리프트 한 파일 가시화) |
| 순수성 | base 불변(비파괴 diff-spread) · 호출마다 새 배열 · env/IO 0 · 함수 필드 0(`CliAdapter` 타입 무변경·`src/shared/types.ts` 무수정) |
| **T0 확정판** | 아래 codex 4행 = T0 실측 verdict(CODEX_VERSION 0.142.5 컨테이너 · #214 코멘트 `4900663228`). skip 4경로 전부·resume `--config sandbox_mode` 라우트 |
| codex headless | `['exec','--json','--sandbox','danger-full-access','--config','approval_policy="never"','--skip-git-repo-check']` — read-only→full-access 교체·승인 억제 유지·trust-dir(T0④ 발화) skip 부여 |
| codex session.startArgs | `['exec','--json','--sandbox','danger-full-access','--config','approval_policy="never"','--skip-git-repo-check']` — 샌드박스·승인 CLI config 기본값 의존 제거(서버 모드 승인 UI 없음 — hang 방지)+skip |
| codex session.resumeArgs | `['exec','resume','--json','--config','sandbox_mode="danger-full-access"','--config','approval_policy="never"','--skip-git-repo-check','{sessionId}']` — **T0① 실측: resume 은 `--sandbox` 거부(clap exit 2)** → `--config sandbox_mode` 라우트 확정(openai/codex#26602). `{sessionId}` 마지막 positional. `sandbox_mode` 키 `--strict-config` 인식 |
| **유효 argv 주의(Codex 1R → T0⑥ 확정: 수용)** | `cli-session.ts` `execute()` 가 템플릿 **뒤에** `extraArgs()`(`--model`·MCP)를 덧붙여 model 설정 시 유효 argv 는 `… resume <sessionId> --model <m>`. **T0⑥ 실측: clap 오류 없이 세션 조회 도달 = 수용** → `session/**` 무변경 전제 충족·현행 조립 유지. T2 유효-argv 테스트(fake runner 캡처)로 이 수용 형태를 단언(계약 회귀 방지) |
| codex edit | `['exec','--json','-C','{workspace}','-s','danger-full-access','--skip-git-repo-check']` |
| trust-dir 스코프 | **T0④ 실측 확정: `codex exec` 전 경로 공통 게이트** — 비-git cwd 에서 headless·edit·session 모두 발화 → `--skip-git-repo-check` codex 4경로 전부(서버 cwd=`/app` 비-git) |
| claude / gemini | **무조정** — base 그대로(`toEqual` 핀). 차단 실측 시에만 contingency(T8) |
| 금지 | 문자열 치환 파생 · `--dangerously-bypass-approvals-and-sandbox`(`--yolo`) · `--allowedTools`/`--dangerously-skip-permissions` 류(#167 스윕 variant 확장) |

### C3. boot→engine registry 주입 계약

| 항목 | 내용 |
|---|---|
| seam | 기존 `FleetEngineOptions.cliRegistry`(engine.ts:95 · `opts.cliRegistry ?? createCliRegistry()` engine.ts:200) — **engine.ts 무수정** |
| 주입 규칙 | `'container'` → `cliRegistry: createCliRegistry(containerCliAdapters())` · `'cli'`/미설정 → **옵션 미전달**(undefined — 기본 시드 경로 바이트 동일) |
| 비변환 | 런타임 `registry.register()` 확장분 비변환 — 주석 + ADR + **seam 테스트로 핀**(judge B 이식: 문서화만으론 재량 회귀 무신호) |
| 파급 시맨틱 | variant 는 CLI 세션·probe(headless args 공용)·`listAdapters()`(IPC 표시)까지 흐른다 — 단일 posture 범위, ADR 잔여 리스크 명기 |

### C4. compose env 표면 계약

| 항목 | 내용 |
|---|---|
| `deploy/docker-compose.yml` | fleet environment 에 `FLEET_SANDBOX_BOUNDARY: ${FLEET_SANDBOX_BOUNDARY:-container}` (`FLEET_PUBLIC_ORIGIN` 아래) |
| `deploy/.env.example` | 유효값·미지값=부팅 거부·**기본값 비대칭 명시**(코드 기본 `cli`=데스크톱/베어호스트, compose 기본 `container`=컨테이너 배포) |
| 핀 | 신규 `scripts/deploy-sandbox-boundary-pin.test.ts`(electron-builder-pin 동형) — compose 라인+`.env.example` 문서화 라인 존재 단언. **유지 판정 근거**: 라인 유실 시 부팅은 정상 성공(미설정→`cli`)하고 런타임 codex bwrap 에러로만 발현 = #214 원증상 재현·진단 고비용(judge B REFUTED B 절삭안) |
| `deploy/README.md` | posture 설명·운영 롤백(`=cli`)·**부팅 거부 시 compose 재시작 루프 — `docker logs` 에서 env 메시지 확인** 1줄·문① ttyd 수동 설정(`~/.codex/config.toml` `sandbox_mode = "danger-full-access"` — cli-auth 볼륨이 `/home/node` 마스킹·비목표 승계)·CODEX_VERSION 상향 시 T0 재실측 1줄 |

### C5. ADR-0010 문구 계약

| 항목 | 내용 |
|---|---|
| 파일 | `docs/adr/0010-컨테이너-샌드박스-경계-cli-unsandboxed.md` + `docs/adr/README.md` 인덱스 1줄 |
| 결정 | 컨테이너 배포에서 컨테이너=유일 샌드박스 경계, CLI 내부 샌드박스 off. `FLEET_SANDBOX_BOUNDARY` **명시 opt-in 만**(자동 감지 금지 — 오판 방향이 보안 완화) · 미지값 loud fail |
| 기각 대안 | 자동 감지(cgroup/.dockerenv) — 기각 · compose seccomp/userns 완화 — 경계 자체 약화·기각 · codex legacy Landlock — upstream legacy·커널 의존 비결정·**보류**(후속 이슈 후보) |
| 잔여 리스크 | codex headless read-only 상실 = **역할 규율** 상실(보안 경계 아님 — ignored-baseline 오케스트레이터 층이 방어) · probe 동일 posture · 컨테이너 탈출 시 CLI 층 2차 방어 부재 |
| 재검토 트리거 | legacy Landlock upstream 승격 · rootless userns 확산 · Phase C 다중 사용자 파일 격리 착수 |

---

## Global Constraints

- **데스크톱 무회귀**: src 변경 허용 = `src/main/core/cli/registry.ts`(+test)·`src/server/boot.ts`(+test·신규 seam test) 뿐. `engine.ts`·`session/**`·`shared/types.ts`·`index.ts`·preload·renderer **무변경**.
  - **단서(Codex 1R)**: `session/**` 무변경은 **T0 ⑥(positional 뒤 트레일링 옵션)이 수용으로 판정되는 경우의 전제**다. 거부 판정 시 contingency 중 택1로 스코프를 명시 확장한다 — (a) `cli-session.ts` 조립을 positional-마지막 보존형으로 조정(+타 어댑터 무회귀 테스트), (b) stateful codex + model 조합을 미지원으로 loud reject(문서화+테스트). 어느 쪽이든 별도 커밋·계획 갱신 후 진행.
- 기존 테스트(#165 exact 핀·#167 스윕·직렬화 핀) **무수정 GREEN** = 기본 시드 무변경의 증거.
- 매 태스크 GREEN 커밋. **brain 재생성은 모든 src 변경 후 최종 1회**(T6 — src 커밋→brain 재생성→brain 별도 커밋. T8 contingency 로 src 재변경 시 재수행).
- codex 플래그 결정은 학습 지식 금지 — 실 CLI/context7 실측만.
- 형제 env 파싱 관례: boot 의 FLEET_* 는 `?.trim()` — 단 `FLEET_DATA_DIR`(boot.ts:254 `?? 'fleet-data'`, trim 없음)는 기존 예외(judge B 실측 정정 — 신규 파싱이 이 예외를 따라가지 말 것).

---

### Task 0: 실측 게이트 — codex 플래그·검사 스코프 (구현 착수 게이트 · 코드 0)

**목표:** C2 의 미확정 2건을 실측으로 확정. **선행:** 없음.

- [ ] **컨테이너 안 실측 강제**(A 이식): `docker compose --env-file .env build fleet` 후 `docker compose run --rm --entrypoint bash fleet` — 핀 버전(CODEX_VERSION 0.142.5)·비특권 uid 1000·cli-auth 볼륨 조건에서만. **로컬 codex 대체 금지**(조건 결여 실측은 trust-dir 재현 실패 위험).
- [ ] ① `codex exec resume --help` OPTIONS 에 `-s, --sandbox`·`--config`·`--skip-git-repo-check` 존재 여부 ② `codex exec resume --json --sandbox danger-full-access <가짜id>` 파싱 통과 판별(세션-미존재 에러=통과·usage 에러=거부) ③ 거부 시 폴백(`--config sandbox_mode="danger-full-access"`) 동일 시험.
- [ ] ④ **신뢰-디렉터리 검사 스코프**: 비-git cwd 에서 edit(`-C {workspace}`)·headless(서버 cwd)·session start/resume 각각 `Not inside a trusted directory` 발화 여부 → **발화 경로가 edit 밖이면 스펙 조정표를 3경로 확장으로 갱신하고 그 표 기준으로 T2 RED 작성**(실측→스펙 갱신→RED 순서 — judge A 최우선 이식).
- [ ] ⑤ session 경로 `approval_policy="never"` 명시가 resume 하위서도 수용되는지(headless 와 동형 `--config` 배치).
- [ ] ⑥ **positional 뒤 트레일링 옵션 수용**(Codex 1R): `codex exec resume --json <가짜id> --model <m>` — Fleet 의 `extraArgs()` 가 `{sessionId}` 뒤에 붙는 실제 조립 형태가 파싱 통과하는지(세션-미존재 에러=통과). 데스크톱 현행에도 해당하는 pre-existing 조립이므로 컨테이너 posture 와 무관하게 판정 필요.
- [ ] **산출**: verdict 를 이슈 #214 코멘트로 기록(명령·stdout/stderr 원문 — 체크포인트 워크플로 정합·A 이식) + C2 args 확정.

**검증:** verdict 코멘트에 ①~⑤ 전항 O/X + 채택 템플릿 명시.

### Task 1: C1 고정 — env 파싱·loud-fail 계약

**Files:** `src/server/boot.ts` · `src/server/boot.test.ts`. **선행:** 없음(T0 과 병행 가능).

- [ ] **RED**(`resolveBindHost` 단위 테스트와 형제 배치) — 경계값 전수: 미설정/`''`/`'   '` → `'cli'` · `'cli'`/`'container'`/`' container '` → 정상 · `'CONTAINER'`·`'Container'`·`'docker'`·`'1'`·`'true'` → throw(메시지에 env 이름·수신값 포함).
- [ ] **RED** — 부수효과-이전 fail-fast: `bootServer({FLEET_SANDBOX_BOUNDARY:'bogus', FLEET_DATA_DIR:<미존재 임시경로>, FLEET_PORT:'0'})` reject + dataDir **미생성** 단언.
- [ ] **GREEN** — C1 대로 구현(판정만 — 주입 배선은 T3).
- [ ] 검증: `npx vitest run src/server/boot.test.ts`

### Task 2: C2 고정 — container variant 데이터 계약 → 파생 함수

**Files:** `src/main/core/cli/registry.ts` · `src/main/core/cli/registry.test.ts`. **선행:** T0(args 확정).

- [ ] **RED** — describe `'container posture variant (#214)'`:
  - codex 4경로(headless·session.start·session.resume·edit) args **`toEqual` exact 전량 핀**(T0 확정 표 그대로 — `toContain` 금지).
  - 비-args 필드 승계 핀: `parse`·`idSource`·`promptVia`·`auth`·`install` base 와 동등.
  - claude/gemini 무조정 핀: `toEqual`(base 해당 어댑터).
  - 순수성: 호출 전후 `DEFAULT_CLI_ADAPTERS` 스냅샷 불변 · 2회 호출 결과 상호 독립.
  - 직렬화: JSON 왕복 `toEqual`(함수 필드 0).
  - **#167 스윕 확장**: 금지 플래그 루프를 `createCliRegistry(containerCliAdapters())` 에도 적용 + codex variant 전 경로 `--dangerously-bypass-approvals-and-sandbox`/`--yolo` 부재 + headless·session 에 `approval_policy="never"` **잔존** 핀(#165 hang 회귀 방지).
  - `{sessionId}`/`{workspace}` 토큰 정확 1회·위치 보존(resumeArgs 는 마지막 positional).
  - **유효-argv 테스트(Codex 1R)**: `createCliSession(descriptor{model 설정}, containerCliAdapters codex, fakeRunner, {stateful:true})` 로 start→resume 2회 send — fake runner 가 캡처한 **실제 argv** 가 T0 ⑥ verdict 의 수용 형태와 일치함을 단언(템플릿 핀만으론 `extraArgs()` 후행 결합을 못 잡는다). 테스트 파일은 registry.test 또는 session.test 확장 — src 의 `session/**` 는 T0 ⑥ 수용 시 무변경.
  - 기존 테스트 무수정 GREEN.
- [ ] **GREEN** — `containerCliAdapters()` 구현: codex 만 diff-spread(args 배열 통째·기본과 나란히), claude/gemini 통과. 주석: 근거(bwrap userns·trust-dir·T0 verdict 참조)·read-only 상실=역할 규율(ADR-0010)·runtime `register()` 미변환.
- [ ] 검증: `npx vitest run src/main/core/cli/registry.test.ts`

### Task 3: C3 고정 — boot→engine 주입 seam

**Files:** `src/server/boot.ts` · 신규 `src/server/boot-sandbox-seam.test.ts`. **선행:** T1·T2.

- [ ] **RED**(childenv-seam 동형 전용 파일·vi.mock 캡처):
  - `'container'` 부팅 → `opts.cliRegistry` defined + codex headless 에 `danger-full-access` 포함·`read-only` 부재 + edit 에 `--skip-git-repo-check` + claude 는 기본과 동일.
  - **미설정** 부팅 → `opts.cliRegistry === undefined` · **`'cli'` 명시** 부팅 → 동일 undefined(미설정과 등가).
  - **runtime `register()` 비변환 핀**(A 이식): container 모드 레지스트리에 register 로 추가한 어댑터가 그대로 나오는지 단언.
  - (미지값 loud fail 은 T1 커버 — 중복 금지.)
- [ ] **GREEN** — `cliRegistry: sandboxBoundary === 'container' ? createCliRegistry(containerCliAdapters()) : undefined` + load-bearing 주석(이 줄 삭제 = 컨테이너 bwrap 재파손·전 테스트 GREEN 무신호 — seam 테스트가 핀).
- [ ] 검증: `npx vitest run src/server/boot-sandbox-seam.test.ts src/server/boot.test.ts src/server/boot-childenv-seam.test.ts`

### Task 4: C4 — 배포 표면 배선 + 설정 핀

**Files:** `deploy/docker-compose.yml` · `deploy/.env.example` · `deploy/README.md` · 신규 `scripts/deploy-sandbox-boundary-pin.test.ts`. **선행:** T3.

- [ ] **RED** — 핀 테스트: compose 라인 + `.env.example` 문서화 라인 존재 단언(C4 표 유지 근거 명기).
- [ ] **GREEN** — C4 표대로 3파일 갱신(README: posture·롤백·**재시작 루프 진단 1줄**·문① 수동 설정·재실측 절차).
- [ ] `docker compose config` 로 보간 확인(B 이식 — 텍스트 핀이 못 잡는 문법 오류).
- [ ] 검증: `npx vitest run scripts/deploy-sandbox-boundary-pin.test.ts`

### Task 5: C5 — ADR-0010 작성

**선행:** T0(실측 근거 인용). **Files:** `docs/adr/0010-*.md` · `docs/adr/README.md`.

- [ ] TEMPLATE 준수·C5 표 문구·개인 절대경로 인용 금지.
- [ ] 검증: `npm run skills:lint`

### Task 6: 게이트 통과 + brain 최종 재생성

**선행:** T1–T5.

- [ ] src 변경 전부 커밋 확인 → `npm run brain` → brain.md **별도 커밋** → `npm run verify` GREEN(win32 flake 시 `--no-file-parallelism`).

### Task 7: 라이브 컨테이너 검증 — 실 codex 런 완주 (완료조건 ①)

**선행:** T6. B6 라이브 방식 재사용(Playwright MCP 실브라우저 + Access 실로그인 또는 WS 클라이언트).

- [ ] `docker compose --env-file .env --profile tunnel up -d --build` 재배포 → 부팅 로그 정상(sandbox boundary 거부 없음).
- [ ] **음성 대조**: 임시 `FLEET_SANDBOX_BOUNDARY=bogus` → 부팅 거부 로그(재시작 루프) 실관측 후 원복(loud-fail 라이브 증거).
- [ ] 실 codex 런: ① edit 경로 실파일 산출 ② headless(planner/reviewer) 경로 정상 ③ `project.done`(`.proj-status=done`) ④ stateful start→resume 2턴 왕복(T0 확정 플래그 라이브 증거) ⑤ **`docker logs` negative grep**: `bwrap:`·`Not inside a trusted directory` **부재**(A 이식 — 명시 단언).
- [ ] 데스크톱 무회귀 스팟: 로컬 `npm run dev` → listAdapters/detect 기본 어댑터(read-only 등) 그대로 1항목.
- [ ] 증적(스크린샷/로그)을 PR 본문에 기록.

### Task 8: claude 무조정 실측 + gemini 증적 (스펙 조건부 결정의 검증)

**선행:** T7 스택 재사용.

- [ ] 실 claude 런(edit 포함) 완주 실측 — 무차단이면 ADR·registry 주석에 "실측 무차단(날짜·버전)" 기록으로 종결.
- [ ] **gemini 1런 증적**(judge A 공통 결함 — 한계비용 ~0·완료조건 확장 아님): 동일 스택에서 gemini 런 1회 완주 관측.
- [ ] claude **차단 실측 시 contingency 미니사이클**: 그 시점 context7 로 `--settings` sandbox 비활성 키 형태 확인 → T2 RED 갱신(무조정 핀 → variant 핀 교체) → GREEN → **brain 재생성 재수행** → T7 방식 재검증. 그 외 임의 플래그 추가 금지.
- [ ] 이슈 #214 코멘트에 verdict 기록.

---

## 리스크 · 롤백

- **운영 롤백(재배포 불요):** `FLEET_SANDBOX_BOUNDARY=cli` → 즉시 현행 posture 복귀(컨테이너선 #214 이전 파손으로의 회귀일 뿐 신규 파손 아님).
- **코드 롤백:** T3 revert = 주입 소멸(기본 시드 복귀) · T2 revert = variant 소멸. 데스크톱 미접촉·마이그레이션 0.
- **버전 드리프트:** CODEX_VERSION 상향 시 T0 재실측(README 절차) — exact 핀은 우리 쪽 드리프트만, CLI 쪽은 라이브만 잡음(잔여 수용).
- **레이트리밋(T7/T8):** 실런은 짧은 목표(파일 1개 산출)로 최소화, 실패 시 재시도 분리.

## 열린 질문

1. probe 가 container 모드에서 danger-full-access 로 흐르는 것(C3 파급)은 "단일 posture" 범위로 해석 — ADR 잔여 리스크 기재로 갈음(사용자 이견 시 조정).
2. T7/T8 라이브 환경(배포 호스트·Access 로그인) 가용 여부 — 착수 시점 사용자 확인(위 «착수 전 확인»).
