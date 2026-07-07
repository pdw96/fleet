---
adr: 0010
title: 컨테이너 배포에서 컨테이너를 유일한 샌드박스 경계로 신뢰하고 CLI 내부 샌드박스를 끈다
status: Accepted
date: 2026-07-07
related: "#214, #197 (Phase B B6 라이브 적발), #193 (v3 메타), openai/codex#26602, memory:fleet-v3-tunnel-selfhost"
---

## 맥락

Phase B(#197-B6) 컨테이너 배포를 실 Cloudflare 터널로 라이브 검증하다 적발: 비특권 컨테이너(uid 1000,
기본 seccomp)는 **중첩 user namespace 생성을 불허**한다. codex CLI 는 Linux 에서 bubblewrap
(`bwrap --unshare-user`)을 기본 FS 샌드박스로 쓰므로(`-s read-only`/`workspace-write`), 컨테이너 안에서
파일 작업이 `bwrap: No permissions to create a new namespace` 로 깨진다 — `apply_patch` 실패 → 런이
"변경 0개"로 미승인·실패. 별개로 codex 자체 신뢰-디렉터리 검사(`Not inside a trusted directory` · git
`safe.directory` 와 무관)도 비-git cwd(`/app`·`/workspace`)에서 발화한다. B6 코드 회귀가 아니라 별개
통합 이슈이며 스택 전역(문① ttyd 인터랙티브도 동일)이다. "컨테이너를 유일 샌드박스 경계로 신뢰하고
CLI 를 unsandboxed 로 돌릴 것인가"의 결정이 필요했다.

## 결정

**컨테이너 배포에서 컨테이너를 유일한 샌드박스 경계로 신뢰하고, 컨테이너 모드에서 CLI 내부 샌드박스를
끈다.** 전환은 **명시적 env opt-in**(`FLEET_SANDBOX_BOUNDARY=container`)으로만 — **자동 감지 금지**
(감지 오판의 방향이 데스크톱/베어호스트 샌드박스의 무단 제거 = 보안 완화라, 안전한 실패는 "끄지 않음"이다).
미지값은 **부팅 거부(loud fail)**. 코드 기본은 `cli`(현행 CLI 샌드박스 유지 → 데스크톱·베어호스트 무회귀),
compose 기본은 `container`(컨테이너 배포). `container` 에서 codex 를 `danger-full-access`(no-sandbox) +
`--skip-git-repo-check` 로 돌린다(headless·session.start·session.resume·edit 전 경로). 이 플래그는 학습
지식이 아니라 **핀 버전(CODEX_VERSION 0.142.5) 컨테이너 실측 verdict**다(#214 T0): `codex exec resume`
는 `--sandbox` 를 미수용(clap `unexpected argument`, exit 2)이라 `--config sandbox_mode="danger-full-access"`
라우트를 쓰고(openai/codex#26602 선례), trust-dir 검사는 `codex exec` 전 경로 공통이라 skip 을 4경로 전부에
부여한다. claude/gemini 는 내부 샌드박스가 opt-in 이고 Fleet 이 켜지 않으므로 무조정.

## 고려한 대안 / 기각 사유

- **자동 감지(cgroup·`/.dockerenv`·`unshare` 프로브)**: env opt-in 대신 런타임이 컨테이너를 감지해 스스로
  unsandbox. 기각 — 오판(예: 컨테이너 안 데스크톱-유사 실행, 감지 우회)의 방향이 **샌드박스 무단 제거**라
  fail-open 이다. 명시 opt-in 은 오판해도 "샌드박스 유지"(fail-safe)로 떨어진다.
- **compose seccomp/userns 완화**(`security_opt: seccomp=unconfined` 등으로 bwrap namespace 허용): 기각.
  우리가 신뢰하기로 한 바로 그 경계(컨테이너 syscall 필터)를 약화시키고, Docker Desktop 커널의
  `unprivileged_userns` 설정에 따라 동작 자체가 불확실하다.
- **codex legacy Landlock 폴백**(`-c use_legacy_landlock=true`): **보류**(후속 후보). user namespace 없이
  동작할 여지가 있으나 upstream 이 legacy 로 표기하고 커널 LSM/seccomp 의존이 배포마다 달라 결정론이 없다.
  컨테이너 실측 결과가 좋으면 read-only 분석 경로 한정 재도입을 별도 이슈로 검토.

## 결과 (Consequences)

- **좋은 점**: 컨테이너 배포에서 실 codex 런이 파일 산출물을 쓰고 완주한다(bwrap userns 실패·trust-dir 차단
  해소). 데스크톱·베어호스트는 코드 기본 `cli` 라 CLI 내부 샌드박스 무변경(무회귀). 어댑터 args 는 데이터
  (`containerCliAdapters` diff-spread)라 드리프트가 한 파일에서 보이고, boot 주입 seam 한 줄이 posture 를
  경계짓는다(revert 즉시 복귀).
- **감수하는 비용**: (a) codex headless 의 read-only 상실은 보안 경계가 아니라 **역할 규율**(분석 역할이 파일을
  못 쓰게)의 상실이다 — 컨테이너 안 잔여 리스크로 수용하고, 워크스페이스 무결성은 ignored-baseline 등
  오케스트레이터 층이 별도 방어한다. (b) probe(연결 테스트)도 headless args 공용이라 동일 posture 로 흐른다
  (단일 posture 범위). (c) 컨테이너 탈출이 성립하면 CLI 층 2차 샌드박스가 없다 — 컨테이너 경계가 유일 방어라는
  전제를 받아들인다. (d) exact 핀은 우리 쪽 args 드리프트만 잡고 CLI 쪽 동작 변화는 라이브·T0 재실측이 잡는다
  (CODEX_VERSION 상향 시 재실측 절차 — `deploy/README.md`).
- **재검토 트리거**: codex legacy Landlock 의 upstream 승격, rootless/unprivileged userns 확산(bwrap 재가동
  여지), Phase C 다중 사용자 파일 격리(별도 uid/RO 마운트/per-run worktree) 착수.
