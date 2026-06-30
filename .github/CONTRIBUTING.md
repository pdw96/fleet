# 기여 가이드

이 프로젝트의 에이전트·기여자 작업 가이드는 [`AGENTS.md`](../AGENTS.md) 가 **단일 진실 원천**이다.
품질 게이트·아키텍처 규칙·함정·백로그 절차를 거기서 읽어라. (이 파일은 GitHub 표준 위치를 위한
얇은 포인터일 뿐 — 내용을 복제하지 않는다. drift 방지.)

## 빠른 시작

- **품질 게이트**(변경 후 필수): `npm run verify` — skills:lint·brain:check·format:check·typecheck·lint·test·build 집계(로컬 == CI)
- **브랜치**: 기본 브랜치 직접 작업 금지 — `feat/<slug>` 특성 브랜치에서 작업한다.
- **커밋/PR**: 작게 나눈다. PR 본문에 `Closes #<N>`. 머지 전 **Codex 봇 자동리뷰를 대기·반영**한다.
- **설계 문서**: [`README.md`](../README.md) · [`DESIGN.md`](../DESIGN.md).
