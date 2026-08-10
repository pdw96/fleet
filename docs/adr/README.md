# 결정 기록 (ADR — 운영·설계 Decision Records)

운영 **지속·교차 결정**(설계 선택·정책·refute)의 근거를 git-tracked 로 정착시키는 인덱스.
루틴 백로그 verdict 은 #27 에 남긴다(여기 중복 금지). 새 ADR = `TEMPLATE.md` 복사.

> 트랙: #140 (워크플로 동기화 Phase 2). 설계: `docs/superpowers/specs/2026-06-25-issue140-phase2-adr-design.md`.
> 강제 모델: 부기 시크릿/경로 스캔은 `skills:lint` 강제, 구조 정합은 사람 눈(ADR-0004 가 자동화 보류·재도입 트리거 기록).

| ADR | 상태 | 결정 |
|---|---|---|
| [0001](0001-codex-required-게이트-보류.md) | Accepted | Codex 를 required CI 머지 게이트로 만들지 않는다 |
| [0002](0002-issue27-백로그-본문-다이어트.md) | Accepted | 메타 백로그 #27 본문에 완료 이력을 누적하지 않는다 |
| [0003](0003-solo-pre-1.0-과설계-roi-경계.md) | Accepted | 솔로 pre-1.0 단계에선 가치가 입증된 것만 등재한다 |
| [0004](0004-adr-시스템-경량-시작.md) | Accepted | ADR 시스템을 경량으로 시작하고 구조 정합 lint 는 보류한다 |
| [0005](0005-picker-docs-외부열기.md) | Accepted | picker 문서 외부열기는 main 매개 정적 URL handoff 로만 허용한다 |
| [0006](0006-coderabbit-advisory-채택.md) | Accepted | CodeRabbit 을 advisory 보조 리뷰어로 채택한다(비-required) |
| [0007](0007-클라우드-스킬-계약강제-human-gated-write.md) | Superseded ([0012](0012-클라우드-에이전트-워크플로-폐기-로컬-스킬-일원화.md)) | 클라우드 자동화 스킬은 계약을 기계 강제하고 write 는 human-gated 로 둔다 |
| [0008](0008-saas-전환-v3-터널-셀프호스트-채택.md) | Accepted | SaaS 전환의 첫 단계로 v3 터널 셀프호스트(컨테이너+터널)를 채택한다 |
| [0009](0009-b6-자식-소켓-격리-경계.md) | Accepted | B6 격리는 서버 env 시크릿(allowlist)·토큰 수명(소켓 exp)까지, cli-auth 파일 격리는 Phase C |
| [0010](0010-컨테이너-샌드박스-경계-cli-unsandboxed.md) | Accepted | 컨테이너 배포는 컨테이너를 유일 샌드박스 경계로 신뢰하고 CLI 내부 샌드박스를 끈다(명시 opt-in·미지값 loud fail) |
| [0011](0011-graceful-drain-경계-drainTimeout-grace-조율.md) | Accepted | graceful drain 의 drainTimeout↔stop_grace_period 조율은 코드가 아니라 문서·페어링 env·smoke canary 로 강제한다 |
| [0012](0012-클라우드-에이전트-워크플로-폐기-로컬-스킬-일원화.md) | Accepted | 클라우드 에이전트 워크플로(claude-code-action)를 폐기하고 두 스킬을 로컬 전용으로 일원화한다(#228·ADR-0007 폐쇄) |
| [0013](0013-인스턴스-배타-커널-endpoint-우선-container_name-배포집행.md) | Accepted | 인스턴스 배타는 커널 endpoint 를 먼저 잡고, 그 안전 전제는 compose container_name 이 파일로 집행한다(#251) |
| [0014](0014-자가리뷰-봇공백-렌즈-계층화-티어-하향.md) | Accepted | 자가 적대리뷰는 봇 공백 렌즈로 계층화(축소 전제=머지 전 Codex 완료 확인)하고 서브에이전트 fan-out 은 티어를 하향한다 |
| [0015](0015-vite-8-차단-electron-vite-미지원.md) | Accepted | Vite 8(@vitejs/plugin-react 6) 은 electron-vite 가 stable 로 지원할 때까지 차단하고, 해제 조건과 동반 검증을 문서로 집행한다(#261) |
