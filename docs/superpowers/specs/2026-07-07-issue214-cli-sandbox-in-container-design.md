# #214 설계 — CLI 샌드박스-in-컨테이너: 환경-인지 샌드박스 posture

> **이슈:** #214 (v3 메타 #193 · 적발: #197-B6 라이브 PR #213) · **날짜:** 2026-07-07
> **상태:** 스펙 초안(체크포인트 전) — 계획은 fleet-plan-panel 로 별도 산출.

## 배경 / 문제

비특권 컨테이너(uid 1000, 기본 seccomp)는 **중첩 user namespace 생성을 불허**한다. codex CLI 는
Linux 에서 bubblewrap(bwrap `--unshare-user`)을 기본 FS 샌드박스로 쓰므로(context7 `/openai/codex`
linux-sandbox README 실측) 컨테이너 안에서 파일 작업이 깨진다:

- `bwrap: No permissions to create a new namespace` → `apply_patch` 실패 → 런이 "변경 0개"로 실패.
- `codex: Not inside a trusted directory and --skip-git-repo-check was not specified`
  (codex 자체 신뢰-디렉터리 검사 — git `safe.directory` 와 별개).

B6 코드 회귀가 아니라 별개 통합 이슈. 스택 전역(문① ttyd 인터랙티브도 동일).

## 핵심 결정 (확정)

**컨테이너를 유일한 샌드박스 경계로 신뢰하고, 컨테이너 모드에서 CLI 내부 샌드박스를 끈다.**
전환은 **명시적 env opt-in** 으로만 — 자동 감지 금지(감지 오판 = 데스크톱/베어호스트 샌드박스
무단 제거). 이 posture 는 **ADR-0010** 으로 기록한다.

기각·보류한 대안:

- **(b) compose seccomp/userns 완화** (`security_opt: seccomp=unconfined` 등) — 기각.
  컨테이너 syscall 필터(우리가 신뢰하기로 한 바로 그 경계)를 약화시키고, Docker Desktop 커널
  `unprivileged_userns` 설정에 따라 동작 자체가 불확실.
- **(c) codex legacy Landlock 폴백** (`-c use_legacy_landlock=true`) — 보류(후속 후보).
  user namespace 없이 동작할 여지가 있으나 upstream 이 legacy 로 표기·커널 LSM/seccomp 의존이
  배포마다 달라 결정론이 없다. 컨테이너 실측 결과가 좋으면 read-only 분석 경로 한정 재도입을
  별도 이슈로 검토.

### 결정 세부

1. **env 계약**: `FLEET_SANDBOX_BOUNDARY` ∈ `cli`(기본) | `container`.
   - `cli` = 현행(CLI 내부 샌드박스 유지). 미설정 시 기본 → 데스크톱·베어호스트 서버 무회귀.
   - `container` = CLI unsandboxed posture 적용.
   - 그 외 값 = **부팅 거부(loud fail)** — B6 `resolveBindHost` 이중 게이트 관례와 동일
     (조용한 강등 금지).
2. **주입점**: 서버 `boot` 이 env 를 파싱해 **container-posture 어댑터로 시드한 `cliRegistry`
   를 엔진에 주입**한다(기존 `opts.cliRegistry` seam · engine.ts). 코어 엔진·cli-session 빌더
   무변경, 데스크톱 경로(기본 시드) 무변경. 런타임 `registry.register()` 확장분은 변환하지
   않는다(문서화).
3. **어댑터 variant 는 데이터로**: `registry.ts` 에 컨테이너-posture 어댑터를 기본 어댑터의
   diff-spread 로 정의(파생 함수 1개). 코드 문자열 수술(치환) 금지 — args 배열을 통째로 선언해
   기본 args 와 나란히 두고 드리프트를 한 파일에서 보이게 한다.

### CLI 별 조정표 (container posture)

> **T0 실측 확정판(2026-07-07 · CODEX_VERSION 0.142.5 컨테이너 · #214 코멘트 `4900663228`).**
> 아래 표는 학습 지식이 아닌 핀 버전 컨테이너 실측 verdict 다.

| CLI | 경로 | 현행 | container 모드 | 근거 |
|---|---|---|---|---|
| codex | edit | `-s workspace-write` | `-s danger-full-access` + `--skip-git-repo-check` | bwrap 불가·신뢰-디렉터리 검사(라이브 실측 둘 다 적발) |
| codex | headless(분석) | `--sandbox read-only` | `--sandbox danger-full-access` + `--config approval_policy="never"` + `--skip-git-repo-check` | bwrap 은 경로 공통 — read-only 도 셸 실행 시 동일 실패. 단일 posture·조건분기 제거. trust-dir 는 T0 실측상 headless 도 발화 → skip 부여 |
| codex | session.start | 샌드박스·승인 플래그 없음(CLI 기본) | `--sandbox danger-full-access` + `--config approval_policy="never"` + `--skip-git-repo-check` | CLI config 기본값 의존 제거. 승인 정책 명시 — 서버 모드엔 codex 승인 UI 없어 config 기본이 인터랙티브면 hang(#165 동형). start=`codex exec` 라 `--sandbox` 수용 |
| codex | session.resume | 샌드박스·승인 플래그 없음(CLI 기본) | `--config sandbox_mode="danger-full-access"` + `--config approval_policy="never"` + `--skip-git-repo-check` | **`codex exec resume` 는 `--sandbox` 미수용(T0① 실측: clap `unexpected argument`, exit 2)** → `-c/--config sandbox_mode` 라우트(openai/codex#26602 선례). `{sessionId}` 마지막 positional 유지 |

**신뢰-디렉터리 검사 스코프(T0 실측 확정):** trust-dir 검사는 `codex exec` **전 경로 공통 게이트**다 —
비-git cwd(`/app`·`/tmp/nongit`)에서 headless·edit·session(start/resume) 모두
`Not inside a trusted directory and --skip-git-repo-check was not specified.`(exit 1) 발화(T0④).
서버 프로세스 cwd = `/app`(비-git)이므로 **codex 4경로 전부에 `--skip-git-repo-check` 부여**로
확정(스펙 갱신판 게이트 발동 — 실측이 RED 작성에 선행). resume `--sandbox` 거부·`--config sandbox_mode`
수용도 실측 확정(T0①②③⑤).

**positional 뒤 트레일링 옵션(T0⑥ 실측):** `codex exec resume … {sessionId} --model <m>` 은 clap 오류
없이 세션 조회까지 도달(수용) — Fleet `extraArgs()` 가 `{sessionId}` 뒤에 붙는 실제 조립이 유효 →
`session/**` 무변경 전제(Global Constraints 단서) 충족. T2 유효-argv 테스트는 이 수용 형태를 단언.
| claude | 전 경로 | `--permission-mode acceptEdits` 등 | **무조정(우선)** | Claude Code 샌드박스는 opt-in(`sandbox.enabled`)·미가용 시 기본=경고 후 unsandboxed 실행(docs·2.1.78 changelog). Fleet 은 sandbox 를 켜지 않음 → 차단 없을 개연성. **라이브 검증 태스크로 확인**, 차단 실측 시에만 variant 에 sandbox 명시 비활성(`--settings`) 추가 |
| gemini | 전 경로 | `--approval-mode auto_edit` 등 | 무조정 | gemini 내부 샌드박스는 opt-in(`--sandbox`)·Fleet 미사용 |

주의: codex headless 의 read-only 상실은 보안 경계가 아니라 **역할 규율**(분석 역할이 파일을
못 쓰게)의 상실이다. 컨테이너 안에서 잔여 리스크로 ADR 에 기록한다(워크스페이스 무결성은
ignored-baseline 등 오케스트레이터 층이 별도 방어).

## 배포 배선

- `deploy/docker-compose.yml` fleet 서비스 environment 에
  `FLEET_SANDBOX_BOUNDARY: ${FLEET_SANDBOX_BOUNDARY:-container}` (컨테이너 배포 기본 = container,
  운영자 override 허용).
- `deploy/.env.example` 주석 갱신 + `deploy/README.md` posture 설명(문① 포함).

## 비목표

- **문①(ttyd 인터랙티브 codex) 자동 구성** — cli-auth 볼륨이 `/home/node` 를 덮어 이미지에 구운
  `~/.codex/config.toml` 이 마스킹되므로 entrypoint 시드가 필요해 별도 후보로 분리. 이번엔
  `deploy/README.md` 에 수동 설정(`sandbox_mode = "danger-full-access"`) 문서화만.
- codex legacy Landlock 재도입(위 (c) — 후속 이슈 후보).
- 데스크톱 CLI 샌드박스 정책 변경 일절 없음.

## 검증 계획

0. **실측 게이트(구현 착수 전·코드 0)**: 핀 버전(CODEX_VERSION 0.142.5) 컨테이너 안에서
   resume 플래그 배치·신뢰-디렉터리 검사 스코프(3경로별) 실측 → 조정표 확정. verdict 는
   이슈 #214 코멘트로 기록(체크포인트 워크플로 정합).
1. **단위**: container variant args(codex 3경로 플래그·claude/gemini 무조정)·파생 함수 순수성.
2. **boot seam**: `FLEET_SANDBOX_BOUNDARY=container` → 엔진 registry 가 variant 어댑터 반환 /
   미설정 → 기본 어댑터 / 미지값 → 부팅 거부 (boot-childenv-seam 테스트 스타일).
3. **데스크톱 무회귀**: 기존 registry 테스트 불변(기본 시드 경로 무변경 확인).
4. **컨테이너 라이브**: 실 배포(compose --profile tunnel)에서 실 codex 런이 파일 산출물을 쓰고
   `project.done` 완주 + claude 경로 차단 여부 실측(무조정 결정의 검증). B6 라이브 검증 방식
   (Playwright MCP/실브라우저 또는 WS 클라이언트) 재사용.

## 완료 조건 (이슈 #214 초안 승계)

- [ ] 컨테이너 배포에서 실 codex/claude 런이 파일 산출물을 쓰고 완주(`project.done` 성공)
- [ ] 데스크톱은 CLI 내부 샌드박스 유지(무회귀)
- [ ] "컨테이너=샌드박스 경계, CLI unsandboxed" posture ADR-0010 기록
- [ ] 환경-인지 스위칭 테스트(단위+boot seam+미지값 loud fail)
