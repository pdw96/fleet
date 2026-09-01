# 2026-09-01 건강검진 후속 — 다음 세션용 실행 프롬프트

> 출처: [`2026-09-01-project-analysis.md`](./2026-09-01-project-analysis.md) §6 「다음에 할 일 추천」.
> 각 프롬프트는 자체 완결이라 새 세션 첫 메시지로 그대로 붙여넣으면 된다. 권장 순서 1→2→3→4→5
> (1 이 3·5 의 전제 문서·테스트 수정을 착지시킨다). 3 은 시작 시 (a)/(b) 결정을 묻는다.

---

## 프롬프트 1 — advisor 사이드 브랜치 머지 (P2-3, 최우선)

```
Fleet 레포 작업. 먼저 AGENTS.md 와 brain.md 를 읽고 시작할 것.

배경: 2026-08-24 선행 심층 진단의 산출물(docs/advisor/2026-08-24-deep.md, docs/adr/0017-*,
docs/adr/0018-*, .claude/skills/fleet-advisor/SKILL.md)과 "원격 세션에서 verify 실행 가능"
수정(.claude/hooks/session-start.mjs 신설 + src/main/core/workbench/active-instance.test.ts ·
coord-area.test.ts 의 root-비안전 테스트 가드)이 사이드 브랜치
`claude/project-advisor-prompt-94jds3`(tip 12fd71a)에만 있고 master 에 없다. 그 결과 이슈 #293
본문이 master 에 존재하지 않는 경로(ADR-0017/0018, docs/advisor/)를 권위로 참조하고 있다.
근거: 2026-09-01 진단 보고서 docs/reports/2026-09-01-project-analysis.md 의 [P2-3] 카드.

할 일:
1. 해당 브랜치를 최신 master 위로 정리(충돌 시 master 우선, 문서는 브랜치 내용 유지)하고
   PR 을 연다. 제목 예: "docs(advisor): 1차 심층 진단 산출물 + root-비안전 테스트 가드 착지".
2. docs/adr/README.md 인덱스에 0017/0018 행이 있는지 확인하고 없으면 추가한다.
3. npm run verify green 확인. PR 본문에 "Part of #293".
4. Codex 봇 자동 리뷰를 기다려 반영한 뒤(AGENTS.md 「Codex 봇 운영」), 머지는 사용자 확인 후.

완료 조건: master 에 위 파일들이 존재하고 #293 이 참조하는 경로가 전부 해소된다.
```

## 프롬프트 2 — 데스크톱 단일 인스턴스 락 (P2-1 = #293 W1 슬라이스)

```
Fleet 레포 작업. 먼저 AGENTS.md 와 brain.md, 그리고 이슈 #293 의 W1 절을 읽고 시작할 것.

배경: 데스크톱 앱에 이중 기동 배타가 전무하다 — 레포 전역에 requestSingleInstanceLock 0건,
src/main/index.ts:75 가 무배타로 fleet-store.json store 를 만들며, 두 인스턴스가 전체 스냅샷
덮어쓰기(last-writer-wins)로 서로의 데이터를 무성 소거한다. workbench/active-instance.ts 는
서버 표면 전용 설계(파일 주석 :18-21)라 대체가 안 된다. #293 B5 에서 CONFIRMED 된 기존
항목이고, 2026-09-01 보고서 [P2-1] 카드가 최신 상태를 재확인했다.

할 일 (TDD):
1. feat 브랜치 생성. src/main/index.ts 의 whenReady 이전에 app.requestSingleInstanceLock()
   — 실패 시 app.quit(), 'second-instance' 이벤트에서 기존 창 restore+focus. (~10줄)
2. 테스트: 락 실패 경로가 엔진/store 생성 없이 종료하는지 단위로 핀(모듈 추출이 필요하면
   main/ 의 crash-recovery.ts 처럼 소형 모듈 + 테스트 패턴을 따를 것). #293 W1 완료 조건인
   "이중 실행 차단 e2e" 추가 가능 여부도 검토(e2e/ 기존 스펙 패턴 참조).
3. npm run verify green (preload 는 안 건드리지만 main 변경이므로 dev 재시작 유의).
4. PR 본문 "Part of #293" (W1 은 멀티 슬라이스이므로 Closes 금지 — AGENTS.md 4단계 규칙).

완료 조건: 두 번째 실행이 즉시 종료되고 첫 창이 포커스되며, verify green.
```

## 프롬프트 3 — verify 무승인 실행 전제의 기록 (P2-2)

```
Fleet 레포 작업. 먼저 AGENTS.md(특히 「아키텍처 규칙」의 ApprovalGate 예외 절)와
docs/reports/2026-09-01-project-analysis.md 의 [P2-2] 카드를 읽고 시작할 것.

배경: verify 단계(src/main/core/verify/run.ts:162-184)는 워크스페이스 package.json 의
typecheck/lint/test 스크립트를 npm run 으로 실행한다. 그 스크립트·테스트 파일은 에이전트
(implementer)가 방금 쓴 코드이므로, verify = 에이전트 산출 코드의 무승인·비샌드박스 실행이다.
package.json 은 SENSITIVE_FILE(safety/approval.ts:10) 비매치, 소형 diff 는 caution 이라 승인
모달 없음(orchestrator/diff-risk.ts). 인접 기록(#166 정직성, #167 세션 경계, #170 self-verify,
ADR-0010 컨테이너 한정) 어디에도 이 전제의 수용 기록이 없다 — 그것이 발견의 본체다.

할 일:
1. 먼저 사용자에게 처리 수위를 확인하라(AskUserQuestion):
   (a) ADR 로 위험 수용만 기록 (코드 0줄) — 추천 기본값
   (b) 프로젝트 실행당 1회 caution 승인 추가 (engine 또는 orchestrator 에서 verify 첫 실행 전
       gate.request, +2파일+테스트)
2. (a)라면: docs/adr/TEMPLATE.md 복사로 새 ADR 작성 — 결정: "데스크톱 verify 는 에이전트 산출
   코드를 게이트 없이 실행한다(수용)", 대안(승인 1회·샌드박스·package.json 특별취급)과 기각
   이유(테스트 파일 벡터로 우회돼 특별취급은 불충분), 재평가 트리거(멀티유저·1.0 외부 사용자)
   명시. docs/adr/README.md 인덱스 1행 추가.
3. (b)라면 TDD 로 구현 + ADR 도 함께(결정 기록).
4. #293 W3(비-npm verify 스킵, B3)와 같은 파일을 만지므로 그 작업과 순서 조율을 PR 본문에 명시.
5. npm run verify green → PR.

완료 조건: 이 실행 전제가 ADR 로 리뷰 가능해지고(선택 시 승인 게이트 실재), verify green.
```

## 프롬프트 4 — README/DESIGN 문서 드리프트 일괄 정정 (P3-2·P3-3)

```
Fleet 레포 작업. 먼저 AGENTS.md 와 brain.md 를 읽고 시작할 것. 코드 무변경, 문서 2파일만.

배경(2026-09-01 보고서 [P3-2]·[P3-3] 카드, 전부 실물 대조 완료):
- README.md:30-38 구조도가 실재하지 않는 core 하위 "fileops"와 "src/main/ipc/" 를 열거하고,
  실재하는 workbench/·workspace/·safety/·secret/·mcp/·tools/·process/ 와 src/server/ 를 누락.
- README.md:58-62 역량 시드 표에 'openai-compatible' → ['implementer'] 행 누락
  (src/main/core/engine.ts:67 의 DEFAULT_CAPABILITIES 가 권위).
- DESIGN.md §7(:127-129)이 "DESTRUCTIVE 패턴 거부 리스트"를 기술하나 실제 안전 모델은 정반대 —
  코어 내 명령 denylist 없음, 위험 분류는 sub-agent CLI 경계에 위임하고 게이트는 신고된 위험도를
  집행(src/main/core/safety/approval.ts:41-42 독스트링이 권위).
- DESIGN.md §4(:68-81)의 NodePtyTransport/PipeTransport/node-pty 는 폐기된 설계(의존성 부재,
  실제는 cross-spawn 파이프 단일 경로 — docs/superpowers/specs/2026-06-25-session-auth-picker-design.md D3).
- DESIGN.md §11-10(:204)·§12 의 "autoUpdater 는 후속(#74)"은 낡음 — src/main/auto-update.ts 로
  구현 완비(채널 가드 포함).

할 일:
1. README 구조 블록을 실제 트리로 고치되 장황한 재열거 대신 "권위는 brain.md(자동 생성)" 위임
   한 줄을 명시. 역량 표에 1행 추가.
2. DESIGN §7 을 위임 모델로 2~3줄 정정, §4 PTY 절을 현행(파이프 단일)으로, §11-10/§12 의
   autoUpdater 서술을 현행으로. 과거 계획을 지우기보다 "현행: …" 로 짧게 갱신.
3. npm run verify green(format:check 유의 — prettier). 문서만이라 brain 재생성 불요.
4. PR 1건으로 묶는다. 근거로 docs/reports/2026-09-01-project-analysis.md [P3-2][P3-3] 링크.

완료 조건: 문서의 경로·표·안전 모델 서술이 코드 실물과 일치.
```

## 프롬프트 5 — 신뢰 경계 clamp + git 버전 가드 (P3-1·P3-4)

```
Fleet 레포 작업. 먼저 AGENTS.md 와 brain.md, docs/reports/2026-09-01-project-analysis.md 의
[P3-1]·[P3-4] 카드를 읽고 시작할 것. 독립 결함 2건 — 커밋은 나눠도 PR 은 1건이면 충분.

결함 A (clamp 비대칭): src/main/core/engine.ts:713-719 는 maxReplanRounds 를 "렌더러는 신뢰
경계 바깥"이라는 명시 근거로 MAX_REPLAN_ROUNDS 로 clamp 하는데, 같은 함수 :749 의
maxReviewRounds 는 무보정 통과(orchestrator.ts:94-95 는 하한만). 서버 표면은
ws-host.ts:66 이 args 를 검증하지 않으므로 인증 클라가 1e9 라운드를 실을 수 있다.
- 할 일(TDD): replan 과 동형으로 MAX_REVIEW_ROUNDS 상수 + engine 경계 clamp + 테스트.
  동반 1줄로 discussRoom(engine.ts:845-861)의 rounds 상한도 두는 것을 권장(P4 하드닝).

결함 B (git 버전 의존 계약): src/main/core/workspace/git-repo-ops.test.ts:260-280 은
casUpdateRef 가 dangling symref 자리 발행을 --no-deref 로 exit 128 거부(fail-closed)한다고
핀하지만, git 2.43.0(우분투 24.04 stock) 실측에서는 exit 0 으로 성공하고 symref 가 정상 ref 로
치환된다(네임스페이스 탈출은 없음 — refs/heads/other 미생성 실측). 배포 런타임은 git 2.39.5
(deploy/fleet/Dockerfile, workspace/git.ts:439-440)라 계약이 지원 매트릭스와 모순. CI hosted
러너는 최신 git 이라 GREEN 이어서 무신호였다.
- 할 일: ① 해당 테스트에 git 버전 가드(skipIf) 또는 구현에 선제 symbolic-ref 존재 검사
  폴백을 넣어 stock git 에서도 계약이 성립하게 한다(폴백 구현 쪽 권장 — 심층방어 복원).
  ② 계약 주석을 "구버전 git 에선 128 대신 무성 치환(탈출 없음)" 실측으로 정정하고, 거부가
  도입된 정확한 git 버전은 미검증임을 명시. ③ workbench txn 실배선(#251 PR3+) 시 2.39.5
  실측이 필수라는 노트를 남긴다. 가능하면 시스템 git 버전별 분기를 테스트에서 감지(git
  --version 파싱)로 처리.

npm run verify green → PR. 근거 링크: 보고서 [P3-1][P3-4].
완료 조건: root 아닌 stock git 2.43 환경에서 npm test 가 이 두 축으로 RED 나지 않는다.
```

## (선택) 프롬프트 6 — 감사 발견의 백로그 등재

```
Fleet 레포 작업. AGENTS.md 「백로그 착수 절차」·「새 이슈 생성 시」 절을 읽고 시작할 것.

docs/reports/2026-09-01-project-analysis.md 의 발견 요약표를 기준으로, 아직 이슈가 없는
생존 발견(P2-2, P3-1, P3-4, P3-5, P3-6, P3-7, P3-8)을 개별 이슈로 생성해 #27 의 sub-issue 로
편입하라(gh issue create … --parent 27, area:*/tier:* 라벨). 기존 항목(P2-1=#293 B5,
P2-3=#293 트랙, P3-10=#293 B2)은 새 이슈를 만들지 말고 해당 이슈에 보고서 링크 코멘트만.
P3-5(messages cap)는 상한값이 사용자 결정 사항임을 이슈 본문에 명시. 생성 전 목록을 보여주고
사용자 승인 후 실행할 것.
```
