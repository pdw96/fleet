# #174 테스트 하네스 성숙도 — 기계강제 트리오 (설계)

- **이슈**: #174 (tier:later, type:security) — 테스트 하네스 성숙도 + minimal-harness 정리
- **날짜**: 2026-06-30
- **상태**: 설계 승인 대기 (Codex 체크포인트 리뷰 ✅ Approve — [issue#174 comment-4842733254 스레드](https://github.com/pdw96/fleet/issues/174#issuecomment-4842733254))
- **브랜치**: `feat/174-test-harness-maturity`

## 1. 배경 / 문제

`tier:next` 부재로 `tier:later` 묶음 중 #174를 선정. 이슈는 5개 항목(ApprovalGate 라우팅 계약 · dead classifier 정리 · coverage · max-warnings · CI Node24 matrix)을 담고, 적대 검증으로 severity 하향된 저위험 묶음이다(보완통제 존재). 본 PR은 그중 **"관례→기계강제" 결이 같고 신규 runtime dep 0인 3개 항목**으로 범위를 좁힌다.

## 2. 범위 결정 (트리오) + 분리

**포함 (이번 PR)**
1. `eslint . --max-warnings 0` — 산문 게이트를 기계 게이트로.
2. dead classifier(`classifyCommandRisk`/`classifyFileRisk`/`DESTRUCTIVE_PATTERNS`) 삭제.
3. ApprovalGate 구조 가드 — tools/** raw fs 변형·spawn 기계 차단 + 행동 계약 테스트.

**분리 (별도 후속)**
- **report-first coverage** — 비강제 센서(이 이슈 자신의 minimal-harness 철학상 약함). floor 강제 시 신규 dep(`@vitest/coverage-v8`) + 임계 유지부담·ratchet 정책 논의 발생 → 독립 PR.
- **CI Node24 matrix** — CI 비용/시간/required check 운영과 결합. 현재 `npm run verify` 단일 집계 게이트(로컬==CI drift 방지) 구조에 matrix 추가는 별도 CI 트랙. 이슈도 "저순위" 표기.

## 3. Grounding (실측, 2026-06-30)

- `classifyCommandRisk`/`classifyFileRisk`: `src/main/core/safety/approval.test.ts`에서만 호출 → 라이브 경로 0건(dead 확정). `DESTRUCTIVE_PATTERNS`는 `classifyCommandRisk` 전용 → 함께 삭제 가능.
- `SENSITIVE_FILE`은 `orchestrator/diff-risk.ts`·`tools/workspace-tools.ts`·`workspace/ignored-baseline.ts`에서 광범위 사용 → **삭제 금지, 유지**.
- `npx eslint .` 현재 **경고 0 / 에러 0** → `--max-warnings 0` 즉시 통과(이후 회귀 차단).
- `src/main/core/tools/*.ts`(non-test): 실제 fs 변형/`child_process` **0건**(read-only: `opendir`/`stat`/`readFile`/`open`/`readdir`/`realpath`만). `*.test.ts`(`workspace-tools.test.ts`)는 임시 워크스페이스 준비로 fs 변형 사용 → tools 가드 블록에 **test ignores 필수**.
- core 전역은 `engine.ts`·`verify/run.ts`·`process/kill-tree.ts`에서 `child_process` 정당 사용 → child_process 금지는 **tools/**에만** 한정(core block엔 금지 X).
- ApprovalGate는 `tool.classify(call.input)` 결과를 그대로 `gate.request()`에 전달(`src/main/core/tools/loop.ts:171`). 즉 게이트의 실제 계약은 "risk 판정"이 아니라 "호출자 신고 risk 집행".

## 4. 설계

### 항목 1 — `--max-warnings 0`
- `package.json`: `"lint": "eslint ."` → `"lint": "eslint . --max-warnings 0"`.
- `eslint.config.mjs` react-hooks 블록 주석(현재 "eslint 가 --max-warnings 0 미사용이라 warn 은 CI 를 못 막음") 정정 — 이제 거짓. `react-hooks/exhaustive-deps: 'error'` 승격은 명시성 위해 유지하되 주석을 "max-warnings 0 으로 모든 warn 이 차단되며 exhaustive-deps 는 의도 명시를 위해 error 유지"로 갱신.
- AGENTS.md 「품질 게이트」의 "lint — eslint (경고도 0 으로 유지)" 산문이 이제 기계적으로 참(필요 시 enforcement 명시 보강).

### 항목 2 — dead classifier 삭제
- `src/main/core/safety/approval.ts`에서 `classifyCommandRisk`·`classifyFileRisk`·`DESTRUCTIVE_PATTERNS` 제거. `SENSITIVE_FILE`·`createApprovalGate`·`ApprovalGate`·`GateOptions`·`RiskLevel` import 유지.
- `approval.test.ts`에서 두 classifier 테스트만 제거(`createApprovalGate` 테스트 유지).
- `createApprovalGate` 주석 갱신(Codex 지적): "게이트는 무엇이 destructive 인지 *판정하지 않는다* — 호출자(도구)가 신고한 risk 를 집행할 뿐이다. 셸/명령 위험 분류는 코어가 아니라 sub-agent CLI 경계에 위임된다(#167/#170)." → "shell 이 코어 ApprovalGate 에서 denylist 로 risk-gated 된다"는 오해 제거.

### 항목 3 — ApprovalGate 구조 가드 (defense-in-depth)

#### 3a. eslint 기계 가드
`src/main/core/tools/**/*.ts` 신규 블록(`ignores: ['src/main/core/tools/**/*.test.ts']`).

**flat-config override 함정 처리**: tools 블록이 core 블록보다 뒤에 오고 동일 rule-key(`no-restricted-imports`/`no-restricted-syntax`)를 가지면 ESLint flat config 는 **병합이 아니라 교체**한다 → core 의 electron 보호가 tools/** 에서 유실. 방지 위해 electron 규칙을 **모듈 상단 공유 const 로 추출**하고 core·tools 양쪽에서 spread 한다(중복 제거 + override 안전). `no-restricted-globals`는 tools 블록에서 미선언 → core 블록 적용 유지.

- `no-restricted-imports` (tools): electron(공유 const) + **`child_process`/`node:child_process` 전면 금지** + **fs 변형 함수 직접 import 금지**(`node:fs`·`fs`·`node:fs/promises`·`fs/promises` 모듈의 mutation `importNames`). 후자는 `import { writeFile } from 'node:fs/promises'` 후 bare `writeFile()` 호출 누락(MemberExpression selector 미포착)을 봉쇄(Codex 지적).
- `no-restricted-syntax` (tools): electron 동적 import(공유 const) + **fs 변형 메서드 호출** selector:
  ```text
  MemberExpression[property.name=/^(writeFile|appendFile|rm|rmdir|unlink|mkdir|mkdtemp|rename|copyFile|cp|truncate|ftruncate|chmod|chown|lchmod|lchown|symlink|link|utimes|futimes|write|writev|createWriteStream)(Sync)?$/]
  ```
  anchored property-name 매칭이라 `truncated`·`writeFileReport` 같은 식별자는 미포착. `fs.writeFile`·`fs.promises.rm`·`nodeFs.unlinkSync` 등 객체명 무관 변형 메서드를 포착. 비-fs 객체 동명 멤버(`builder.mkdir()` 등) false-positive 는 inline disable(레포 기존 패턴) — safety-sensitive 영역이라 fail-closed 비용 < false-negative 비용.

mutation 이름 집합(member selector 와 importNames 공용; 모듈에 없는 이름은 무해하게 미발화):
`writeFile, appendFile, rm, rmdir, unlink, mkdir, mkdtemp, rename, copyFile, cp, truncate, ftruncate, chmod, chown, lchmod, lchown, symlink, link, utimes, futimes, write, writev, createWriteStream` (+ 각 `Sync` 변형).

현재 tools 의 fs named import 는 `promises`(`import { promises as fs }`)뿐 → mutation importNames 미해당, 위반 0. 멤버 접근(`fs.opendir` 등)도 read 계열뿐 → selector 위반 0.

#### 3b. config 자가단언 (`scripts/eslint-config-purity.test.ts` 확장, #173 zero-dep 패턴)
ESLint 프로그래매틱 실행 없이 flat config 객체 형태만 단언. tools 가드가 조용히 삭제/약화되면 lint 는 여전히 green(위반 0)이라 무신호 → 게이트 자체를 핀. 단언 항목(Codex 목록):
- tools 블록 존재 · `files` 가 `src/main/core/tools/**/*.ts` · `ignores` 에 test 패턴 포함.
- `no-restricted-imports` 가 `child_process`·`node:child_process` 금지 + fs mutation importNames 보유.
- `no-restricted-syntax` 가 fs mutation selector 보유.
- electron 정적 import 보호 **재선언**(공유 const spread 확인).
- electron 동적 import 보호 **재선언**.
- 기존 core 블록 단언(electron/DOM 가드)은 그대로 유지(공유 const 추출 후에도 객체 형태 불변이라 통과).

#### 3c. 행동 계약 테스트 (`workspace-tools.test.ts` 확장)
`createWorkspaceReadTools(root)` 의 모든 도구가 실행해도 워크스페이스를 변경하지 않음을 단언:
1. temp 워크스페이스 생성(`fs.mkdtemp`) — 파일 2~3개 + 하위 디렉터리.
2. 스냅샷 함수: 루트 재귀 순회, 각 엔트리 `{ relPath, kind('file'|'dir'|'symlink'), size(file), sha256(file content), linkTarget(symlink) }` 정렬 배열. **mode 는 Windows flaky 라 제외**(Codex).
3. 각 도구 execute 를 대표 입력으로 호출(`read_file`={path:파일}, `list_directory`={path:'.'}, `grep`={pattern:'.'}, `glob`={pattern:'**/*'}), AbortController 제공, 예상 에러는 swallow.
4. 재스냅샷 → `toEqual` deep-equal(변형 0).
5. finally 로 temp 정리.

회귀 포착: read-only 도구에 캐시/인덱스 파일 생성, chmod/symlink 조정, refactor 중 temp 파일을 워크스페이스 내부에 쓰는 경우 등. **한계(명시)**: 워크스페이스 밖 mutation·child_process spawn·네트워크/env/홈디렉터리 side effect·mutation 후 원상복구는 미포착 → 3a eslint 가드의 **대체가 아니라 보완 레이어**.

## 5. TDD 순서
1. **3b RED**: tools 블록 단언 추가 → tools 블록 부재로 실패.
2. **3a**: 공유 const 추출 + tools 블록 추가 → 3b GREEN. `npx eslint .` 위반 0 확인.
3. **3c**: 행동 계약 테스트 추가 → 즉시 통과(현 도구 read-only) = 회귀 가드.
4. **항목 2**: dead classifier + 테스트 제거, 주석 갱신 → typecheck/test green.
5. **항목 1**: `package.json` 스크립트 + 주석/문서 정정.
6. 최종 `npm run verify` green.

## 6. 영향 파일 (신규 runtime dep 0)
- `package.json` (lint 스크립트)
- `eslint.config.mjs` (공유 const + tools 블록 + 주석)
- `scripts/eslint-config-purity.test.ts` (tools 블록 단언)
- `src/main/core/safety/approval.ts` (dead 삭제 + 주석)
- `src/main/core/safety/approval.test.ts` (테스트 제거)
- `src/main/core/tools/workspace-tools.test.ts` (행동 계약 테스트)
- `AGENTS.md` (lint 산문 — 필요 시)

## 7. 수용 기준
- [ ] `npm run lint` 가 `--max-warnings 0` 으로 실행되고 경고 1건이라도 있으면 fail(현 baseline 0 통과).
- [ ] `classifyCommandRisk`/`classifyFileRisk`/`DESTRUCTIVE_PATTERNS` 가 코드베이스에서 제거됨(`SENSITIVE_FILE` 유지·전 사용처 동작).
- [ ] tools/** 에 raw fs 변형 메서드·`child_process` import·fs mutation named import 추가 시 `npm run lint` fail(test 파일 제외).
- [ ] tools 블록이 electron 정적/동적 import 보호를 유지(공유 const, config 자가단언 통과).
- [ ] 행동 계약 테스트: 등록 도구 실행 후 워크스페이스 스냅샷 불변 단언.
- [ ] `npm run verify` 전 게이트 green.

## 8. Out of scope
report-first/floor coverage · CI Node24 matrix · 직접 fs writer(`workspace/git.ts`·`store/json-file.ts`·`workspace/ignored-baseline.ts`)의 게이트 라우팅(by-design 내부 인프라, LLM 구동 도구 아님) · gemini/codex implementer self-verify(#170).

## 9. 참조
- Codex 체크포인트 리뷰: issue #174 comment(2026-06-30, Approve with minor cautions).
- #173 PR#177 `3ba3b3a` — 코어 순수성 eslint 게이트 + zero-dep config 자가단언 패턴(본 설계가 확장).
- #167 PR#169 `4e4cee6` / #170 — implementer self-verify·셸 위험 위임 경계.
