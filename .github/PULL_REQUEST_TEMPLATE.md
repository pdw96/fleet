<!-- AGENTS.md 루프 산출물. 해당 없는 항목은 지우지 말고 체크 해제로 둔다. -->

## 요약

<!-- 무엇을 · 왜 -->

Closes #

## 품질 게이트 (AGENTS.md — 변경 후 필수)

- [ ] `npm run verify` green (skills:lint·brain:check·format:check·typecheck·lint·test·build 집계 = 로컬 == CI)
- [ ] preload/IPC 변경 시 `npm run dev` 재시작 확인
- [ ] 코어 코드 변경 시 `npm run brain` 갱신 (verify 의 brain:check 가 강제)

## 리뷰

- [ ] Codex 봇 자동리뷰 대기 · 반영 (라이브러리·API·SDK·CLI·모델 지적은 context7 로 현행 문서 교차검증)

## 비고

<!-- 스크린샷 · 후속 작업 · 리스크 -->
