# Fleet 프로젝트 건강검진 보고서 (2026-09-01)

> 기준 head: `af7ef12` (= origin/master) · 검사 환경: 원격 컨테이너(root, git 2.43.0, Node 22.22.2)
> 방법: 지도 문서(README→DESIGN→AGENTS→brain→ADR 16건→최근 스펙) → 기계 검사 → 렌즈 L1~L20
> fan-out 탐사(fleet-finder ×7) → 적대 반증(fleet-refuter ×3, find≠verify 분리) → 생존 발견만 등재.
> 환경 변경은 `npm ci`(락파일 그대로, 소스 무변경) 1회뿐. 코드 수정 없음 — 이 보고서 파일만 신규.
> 선행 기록 대조: 이슈 #27(43 sub-issues)·**#293 1차 심층 진단(2026-08-24, `docs/advisor/2026-08-24-deep.md`
> — 단 이 문서는 master 가 아니라 사이드 브랜치 `claude/project-advisor-prompt-94jds3` 에만 존재)**.

---

## 0. 한 문단 요약

Fleet 은 "여러 AI(설치된 CLI + API)를 한 작업방에 모아 역할을 나눠 목표를 완수시키는" Electron
데스크톱 앱이다. 속(엔진)은 놀랄 만큼 튼튼하다 — 위험한 파일 접근은 lint 가 구조로 봉인하고, 서버
문은 3중 자물쇠(일회용 표·출처 확인·서명 토큰)로 잠겨 있고, AI 호출 실패엔 우산(재시도·상한)이
있으며, 문서와 코드가 어긋나면 기계가 잡는 장치가 4겹이다. 이번 검진에서 **당장 사고 나는 곳(P0)과
새로운 계약 위반(P1)은 찾지 못했다**. 아픈 곳은 대부분 이미 8월 24일 선행 진단(#293)이 정확히 짚은
곳들("두 번 켜면 데이터 유실", "로그 파일이 없어 지원 불가", "자기검토 붕괴 무신호")인데 — **문제는
그 처방전 자체가 8일째 약국(master)에 도착하지 않았고(사이드 브랜치 방치, 하위 이슈 13건 착수 0),
그 사이 새로 찾은 것은 안전 모델의 기록 공백 1건(P2)과 문서·테스트·경계의 잔가지들(P3)** 이다.

---

## 1. 잘하고 있는 것 (5개)

1. **fs 접근 봉인이 산문이 아니라 기계 계약이다.** `eslint.config.mjs` 의 CORE_FS_ALLOWLIST 가
   정적/동적 import·require·createRequire·`process.binding`·별칭·재-export 를 형태 단위로 막고,
   `scripts/approval-gate-exceptions.test.ts`(21개 전부 통과 확인)가 allowlist ↔ AGENTS.md 8모듈
   열거 ↔ 근거 절을 양방향 대조한다. 이번 감사에서 **알려진 한계 외 신규 우회 형태를 찾지 못했다.**
2. **서버 표면 인증·시크릿 위생.** nonce 선소모 → Origin exact → RS256 핀 JWT(exp 필수) →
   identity 바인딩 → 소켓 exp-시한 종료(`src/server/boot.ts:637-655`). 키·토큰·env 를 로그에 통째
   찍는 곳 전수 검색 0건, MCP 승인 표시는 env 키 이름만 노출(`mcp/host.ts:28-35`), 자식 프로세스
   env allowlist(`server/child-env.ts`)까지 — 유출 경로가 체계적으로 닫혀 있다.
3. **실패 내성 공통 계층.** `providers/resilient.ts` 가 429/5xx 한정 재시도·`Retry-After`(초·날짜
   양식) 준수·60s clamp·취소 즉시 전파를 3사 provider 공통으로 제공하고, 오케스트레이터의 모든
   루프(리뷰·verify-fix·replan·툴루프 8회)에 상한과 정직한 종착(failed/skipped)이 있다.
4. **자원 정리 규율.** preload 6채널 구독 해제 짝을 `ipc-parity.test.ts` 가 구조로 강제하고,
   타이머·소켓·자식 프로세스 dispose 경로(`engine.ts:907-921`, will-quit 3초 백스톱)가 일관된다.
   전 src 에 방치성 TODO 는 1건(이슈 참조 보유)뿐.
5. **드리프트를 잡는 자동 장치 4겹.** brain.md 신선도 게이트(`brain:check` 통과 확인), engines
   범위 교집합 대수(`engines-floor.mjs` 정합 확인), 승인 게이트 예외 대조 테스트, 브리지 3면
   패리티 + 컴파일타임 시그니처 대조(`server/handlers.ts` AssertExact). 솔로 프로젝트에서 이례적.

---

## 2. 발견 요약표

같은 등급 안에서는 고치는 비용이 적은 순. 「기존」= 선행 기록(#293/advisor 문서·이슈·주석)에 이미
있는 항목 — 새로 알아낸 델타만 상세 카드에 적었다.

| # | 심각도 | 렌즈 | 한 줄 요약 | 증거(대표) | 고치는 비용 |
|---|---|---|---|---|---|
| P2-1 | P2 | L7 | 데스크톱 이중 기동 배타 전무 — 나중에 쓴 쪽이 상대 데이터를 무성 소거 (**기존** #293-B5, 미착수) | `src/main/index.ts:75`, 전역 `requestSingleInstanceLock` 0건 | 1파일 ~10줄 |
| P2-2 | P2 | L4 | verify 단계 = 에이전트가 방금 쓴 코드의 **무승인·비샌드박스 실행** — 이 설계 전제가 어디에도 수용 기록 안 됨 (신규) | `verify/run.ts:162-184`, `cli/registry.ts:34-42` | ADR 1건 (또는 +2파일) |
| P2-3 | P2 | L15·L16 | 1.0 복구 트랙(#293)의 권위 문서(ADR-0017/0018·advisor 보고서)와 테스트 수정이 **master 밖 사이드 브랜치에 8일째 방치**, 하위 이슈 13건 착수 0 (**기존** B1 의 연장 — 델타: 참조 무결성 깨짐) | #293 본문 ↔ `docs/advisor/` master 부재(ls 확인) | 브랜치 머지 |
| P3-1 | P3 | L6·L9 | `maxReviewRounds` 만 신뢰 경계 clamp 누락 — 자기 선언 불변식("렌더러는 신뢰 경계 밖") 위반 (신규) | `engine.ts:713-719` vs `:749` | 2파일 |
| P3-2 | P3 | L15 | README 구조도가 실재하지 않는 `fileops/`·`ipc/` 를 열거하고 실재 8개 디렉토리 누락 + 역량 표 `openai-compatible` 행 누락 (신규) | `README.md:30-38,58-62` vs `engine.ts:67` | 1파일 |
| P3-3 | P3 | L15 | DESIGN.md 드리프트 3건 — §7 안전 모델이 실제와 **정반대**(denylist 없음이 실제) · §4 PTY/node-pty 폐기 설계 잔존 · §11-10 "autoUpdater 후속"인데 이미 완비 (신규) | `DESIGN.md:127-129` vs `safety/approval.ts:41-42` | 1파일 |
| P3-4 | P3 | L7·L11 | `casUpdateRef` fail-closed 계약이 git 버전 의존 — stock git 2.43(우분투 LTS)·배포 런타임 2.39.5 에서 미성립, 해당 테스트 RED (신규 — 실측 재현) | `git-repo-ops.test.ts:266-280`, 재현 exit 0 | 1~2파일 |
| P3-5 | P3 | L8·L10 | 채팅 messages 만 cap 부재 — events cap 5000(#126) 패턴 미적용, 전량 동기 재기록과 결합해 장기 비대 (신규 델타) | `store/memory.ts:183-195` vs `:71-83` | 1파일+테스트 |
| P3-6 | P3 | L17 | 역량·업데이트채널 토글 칩이 색 단독 표현 + `aria-pressed` 부재 — capability-scored 핵심 설정 표면 (신규) | `SessionsPanel.tsx:214-227,285-298` | 1파일 2곳 |
| P3-7 | P3 | L2 | ChatPanel 브리지 실패(방 생성·전송·취소)만 무표기 — LLM 실패는 말풍선 표기됨 (부분 기존 #197 B4) | `ChatPanel.tsx:274,285,345` | 1파일 |
| P3-8 | P3 | L3 | `RiskLevel` 동명이의 타입 — shared 계약과 renderer 로컬이 같은 이름·다른 값 (신규) | `authBanners.ts:3` vs `shared/types.ts:326` | 1파일 개명 |
| P3-9 | P3 | L11 | 테스트 스위트의 환경 전제 — root 실행 시 3건·구식 git 시 1건 FAIL (root 수정은 사이드 브랜치에 존재 = P2-3 과 동근) | 이 환경 실측 4 FAIL/3009 | P2-3 에 포함 |
| P3-10 | P3 | L1 | 세션 1개/CLI+API 구성의 자기검토 붕괴 무신호 (**기존** #293-B2 CONFIRMED — 델타: 사후 `→ 이름` 칩 가시성은 확인됨, 사전 경고만 공백) | `engine.ts:698-712` | W2 트랙 |
| P3-11 | P3 | L10 | ChatPanel 스트리밍 리렌더가 방 크기에 비례 — 단 실측 사고 0, **트리거 기반 보류** 권고 (신규) | `ChatPanel.tsx:133-137,388-406` | 보류 |

**P4 관찰(등급 밖 — 원하면 1줄씩 하드닝, 전부 반증에서 하향됨):** MCP host gate 미주입 시
fail-open 기본값(테스트 핀 존재, `mcp/types.ts:108` 명시) · `discussRoom` rounds 무상한(취소 가능) ·
loopback 무인증 vs dataDir 0700(ADR-0009 수용 기록) · SENSITIVE_FILE 패턴 갭(`.netrc`·`.npmrc` 등,
워크스페이스 한정이라 실효 낮음) · diff-risk 내용 전소 미계수(60KB 절단·revert 가 상쇄) ·
fleet-store.json umask 기본 · attestation 이 피드 yml 비대상(`release.yml:98-101` 명시 설계) ·
`form-data` override 근거 레포 내 무기록 · 코어 DOM 전역 가드가 `*.ts` 확장자만(`eslint.config.mjs:648`).

---

## 3. 상세 카드

### [P2-1] 앱을 두 번 켜면 나중에 저장한 쪽이 이긴다 — 기존 항목(#293 B5), 여전히 미착수

- **무슨 일이 일어나나**: Fleet 아이콘을 두 번 누르면 두 앱이 다 뜨고, 둘 다 같은 공책
  (`fleet-store.json`)에 "전체 내용 덮어쓰기" 방식으로 저장한다. 한쪽에서 만든 세션·대화가
  다른 쪽 저장 한 번에 조용히 사라진다.
- **증거**: `src/main/index.ts:75`(무배타 store 생성) · 레포 전역 `requestSingleInstanceLock|second-instance`
  0건(grep) · `store/json-file.ts:42` 고정 이름 tmp · 로드는 부팅 1회뿐(`json-file.ts:45-58`).
- **반증 시도**: ① workbench `active-instance.ts` 가 대체하나? → 소비자 0(미배선) + 자체 주석
  (`:18-21`)이 **서버 표면 전용** 설계임을 명시 — 데스크톱 대체 불가. ② 문서화된 수용? →
  ADR-0013·deploy 문서의 단일 인스턴스 논의는 전부 컨테이너 표면이고 "데스크톱 Electron 은
  무관(#255)" 명시 — 수용 기록 아님. 생존. 단 고정 tmp 경합의 실제 종착은 파일 붕괴보다
  last-writer-wins 유실이 대부분이라 P1→P2 하향.
- **보완 제안**: `app.requestSingleInstanceLock()` 실패 시 quit + `second-instance` 에서 기존 창
  focus — 1파일 ~10줄(선행 진단 W1 슬라이스와 동일).
- **기존 기록**: #293 B5 **CONFIRMED**·W1 트랙. 새로 알아낸 점 = active-instance 로는 못 닫는다는
  구조 확인, 그리고 8/24 확정 후에도 착수 0 이라는 사실.

### [P2-2] "검증" 단계가 에이전트가 방금 쓴 코드를 승인 없이 실행한다 — 그 전제가 어디에도 기록돼 있지 않다 (신규)

- **무슨 일이 일어나나**: AI(implementer)가 워크스페이스에 코드를 쓰면, Fleet 은 그 결과를
  `npm run typecheck/lint/test` 로 "검증"한다(`verify/run.ts:162-184`). 그런데 그 npm 스크립트
  자체가 방금 AI 가 쓴(혹은 고쳐 쓴) 파일이다 — 즉 검증 단계는 **에이전트 산출 코드를 사람 승인
  없이, 샌드박스 없이, 사용자 실제 디렉토리에서 실행**하는 통로다. `package.json` 은
  SENSITIVE_FILE 비매치·소형 diff 는 caution 이라 승인 모달도 안 뜬다(`diff-risk.ts:18-35`).
- **왜 문제인가(시나리오)**: implementer 가 `"test": "<임의 셸>"` 을 심거나 악성 `*.test.ts` 를
  추가하면, verify 가 사용자 홈 권한으로 그 셸을 돌린다. git revert 는 이미 실행된 부수효과를
  되돌리지 못한다.
- **반증 시도**: ① "테스트 실행은 본질 위험, 수용된 설계 아닌가?" → 그럴 수 있으나 **수용 기록이
  없다**. 레포는 인접 경계를 정밀하게 지킨다 — `cli/registry.ts:34-42`(#167)는 implementer 세션의
  `node --check` preload RCE 까지 막으며 "실제 verify 는 Fleet 이 별도 실행한다"고 적었는데, 바로
  그 별도 실행이 이 에스컬레이션 통로다. #166(정직성)·#167(세션 경계)·#170(안전 self-verify)·
  ADR-0010(컨테이너 한정) 어디에도 데스크톱 verify 의 이 전제는 없다. ② package.json 특별취급으로
  닫히나? → 안 닫힌다(테스트 파일 벡터 동일) — 그래서 지적을 "패턴 갭"이 아니라 "기록 공백"으로
  재프레임. 생존(P2).
- **보완 제안**: 최소 = 이 위험 수용을 ADR 1건으로 기록(AGENTS.md 예외 절 스타일 — "왜 게이트를
  거치지 않는가"). 한 단계 위 = 프로젝트 실행당 1회 "이 워크스페이스에서 검증 명령을 실행합니다"
  caution 승인. (#293 W3 의 비-npm verify 스킵 작업과 같은 파일을 만지므로 동승 가능.)
- **기존 기록**: 없음(인접 이슈 #170·S1 은 각각 세션 경계·테스트 삭제만 다룸).

### [P2-3] 처방전이 약국에 도착하지 않았다 — #293 트랙의 권위 문서·수정이 master 밖에 방치 (기존 B1 의 연장)

- **무슨 일이 일어나나**: 8/24 선행 심층 진단은 blocker 5건을 확정하고 ADR-0017/0018 로 결정을
  기록했다 — 그런데 그 ADR 2건, 진단 보고서(`docs/advisor/2026-08-24-deep.md`), 그리고 "원격
  세션에서 verify 실행 가능"하게 만드는 root-비안전 테스트 수정까지 전부 **사이드 브랜치
  `claude/project-advisor-prompt-94jds3` 에만 있고 master(af7ef12, 8/13)에 없다**. #293 본문은
  master 에 없는 경로를 권위로 참조하고, 하위 이슈 13건은 9/1 현재 착수 0.
- **증거**: `ls docs/advisor` → 부재 · `docs/adr/` 최종 0016 · `git ls-tree` 로 사이드 브랜치에서
  3파일 확인 · #293 `sub_issues_summary: 13 total, 0 completed`.
- **왜 문제인가**: 이 레포의 강점이 "문서=기계 계약"인데, 가장 중요한 최신 결정이 그 체계 밖에
  있다. 다음 에이전트/재랭킹이 master 만 보면 ADR-0017/0018 이 "없는 결정"이 된다(실제로 이번
  감사도 초반에 그 함정에 빠질 뻔했다). 선행 진단의 결론(B1: 출하 루프 정지)이 그 진단 자체에
  재귀 적용되고 있는 셈이다.
- **반증 시도**: 브랜치가 리뷰 대기 중인 정상 흐름일 가능성 → PR 목록·8일 경과·이 레포의 평소
  머지 리듬(문서 PR 은 당일 처리 관례)과 불일치. 생존.
- **보완 제안**: 해당 브랜치를 PR 로 올려 머지(문서+테스트 수정뿐이라 저위험) → #293 참조 무결성
  복구 → W1(P2-1 포함) 착수.
- **기존 기록**: B1(출하 정지)은 기존 — 이 카드의 델타는 "복구 트랙 자체의 방치와 참조 깨짐".

### [P3-1] `maxReviewRounds` 만 신뢰 경계 보정이 빠졌다 (신규)

- **무슨 일이**: 엔진은 `maxReplanRounds` 를 "렌더러는 신뢰 경계 바깥"이라는 명시 근거로 상한
  clamp 하는데(`engine.ts:713-719`), 6줄 아래 `maxReviewRounds` 는 무보정 통과(`:749`,
  `orchestrator.ts:94-95` 는 하한만). 웹 표면은 `handler(...frame.args)` 로 args 를 검증하지
  않으므로(`ws-host.ts:66`) 인증된 클라가 10억 라운드를 실을 수 있다.
- **반증 시도**: `taskTimeoutMs` 가 총량을 막나? → per-send 타임아웃이라 못 막는다(`orchestrator.ts:296`).
  완화는 실재: `cancelRun` 존재, UI 는 이 필드를 아예 안 보냄(기본 2), destructive diff 는 매
  라운드 사람 승인. 실해 = 취소 전까지 토큰 비용 러너웨이 → P2→P3.
- **보완 제안**: replan 과 동형의 clamp 1곳 + 테스트. 동반 1줄로 `discussRoom` rounds 상한(P4)도.
- **기존 기록**: 없음(#241 ws 한도는 페이로드 축 — 별건).

### [P3-4] fail-closed 라고 적었지만 구형 git 에서는 조용히 성공한다 (신규 — 실측)

- **무슨 일이**: `git-repo-ops.test.ts:260-280` 은 "`--no-deref` 는 dangling symref 자리 발행을
  128 로 거부한다(fail-closed)"를 계약으로 핀한다. 이 환경의 git 2.43.0(우분투 24.04 LTS 기본)
  실측: **exit 0 으로 성공하고 symref 가 정상 ref 로 치환**된다(테스트 FAIL). 네임스페이스 탈출
  (`refs/heads/other` 생성)은 구버전에서도 없음 — 원 위협(#268 P1)은 재발하지 않고, 약화되는 건
  심층방어 불변식뿐.
- **왜 문제인가**: 레포 스스로 git 2.39.5(배포 Dockerfile)·2.43/2.44 를 지원 매트릭스로 실측
  명기하는데(`workspace/git.ts:439-440,691`), 이 계약은 그 매트릭스에서 미성립일 개연성이 높다.
  또 stock-distro git 개발환경에서 `npm test` 가 RED — 신뢰할 수 없는 게이트는 무시를 학습시킨다.
  (CI 는 hosted 러너 최신 git 이라 GREEN — 그래서 지금껏 무신호.)
- **반증 시도**: casUpdateRef 프로덕션 소비자 → 0(전부 테스트) = 현행 실해 없음 → P3.
- **보완 제안**: 테스트에 git 버전 가드(skipIf) 또는 구현에 선제 `symbolic-ref` 존재 검사 폴백 +
  계약 주석에 "≥2.4x 한정(정확 버전 미검증)" 명시. workbench txn 실배선(PR3+) 시점에 2.39.5
  실측 필수.
- **기존 기록**: 없음.

### [P3-2·P3-3] 첫 지도 두 장이 낡았다 — README 구조도·DESIGN 3건 (신규)

- **무슨 일이**: ① `README.md:30-38` 구조도는 실재하지 않는 `fileops/`·`ipc/` 를 열거하고
  실재하는 core 디렉토리 8개(workbench·workspace·safety·secret·mcp·tools·process, 그리고
  `src/server/` 전체)를 누락 — 승인 게이트 위치를 fileops 로 오도한다. 역량 표(`:58-62`)는
  `openai-compatible` 행 누락(`engine.ts:67` 에 실재). ② `DESIGN.md:127-129` §7 은 "DESTRUCTIVE
  패턴 거부 리스트"를 기술하나 실제 안전 모델은 **정반대**(코어 내 denylist 없음 — 위험 분류를
  CLI 경계에 위임하고 게이트는 집행만: `safety/approval.ts:41-42`). §4 의 NodePtyTransport/
  node-pty 는 폐기된 설계(스펙 D3 확정, 의존성 부재), §11-10 "autoUpdater 후속"은 이미 구현 완비
  (`auto-update.ts` 226줄 + 채널 가드).
- **왜 문제인가**: 14차 재랭킹 실측 교훈 그대로 — stale 문서가 오탐 후보를 양산한다(이번 감사의
  기각 후보 다수도 문서 기인). 특히 §7 은 보안 리뷰 기준을 오도한다.
- **반증 시도**: brain.md·코드 주석이 정정하나? → 한다. 그러나 README/DESIGN 은 읽기 순서 1·2번
  이고 스스로 낡았다고 표시하지 않는다. 생존(문서 한정 P3).
- **보완 제안**: README 구조 블록을 brain.md 위임 한 줄로 교체 + 역량 표 1행 · DESIGN §7 2줄
  정정 + §4/§11-10 각 1줄. 총 2파일.
- **기존 기록**: 없음(선행 진단 S12 는 설치 절 부재만 다룸).

### [P3-5] 대화 공책만 낱장 제한이 없다 (신규 델타 — #126 패턴 미적용)

- **무슨 일이**: events 는 #126 으로 cap 5000 + 폐기 카운트가 있는데(`memory.ts:71-83` — O(N²)
  논거까지 주석에 기록), 채팅 `messages` 는 `push(); save()` 뿐(`memory.ts:183-195`) — cap·삭제
  API 모두 없다. 매 append 가 전체 store 의 structuredClone + pretty-print 동기 재기록
  (`json-file.ts:65`)이라 장기 사용 시 append 당 비용이 계속 자란다.
- **반증 시도**: 고빈도 경로는 이미 닫혀 있다(토큰 델타 비영속 `orchestrator.ts:115-116`, 스트리밍
  도 턴당 1회 append) — 절벽 도달은 사람 페이스라 "마비"가 아니라 지연. P2→P3.
- **보완 제안**: events 와 동형의 방당(또는 전역) cap + 폐기 카운트 — 1파일+테스트. **단 상한값은
  데이터 삭제 정책이므로 사용자 결정 필요(§7).**
- **기존 기록**: #126(events 한정) — messages 미적용이 델타.

### [P3-6·P3-7·P3-8·P3-9·P3-10·P3-11] 소형 생존 발견 (요약)

- **P3-6 토글 칩 접근성**: `SessionsPanel.tsx:214-227`(역량)·`:285-298`(채널) 이 on/off 를
  `color` 단독 표현, `aria-pressed` 부재 — capability-scored 의 핵심 설정 표면. 다른 표면은
  a11y 패턴 보유(`role="alert"` 등)라 이 두 칩만 공백. 수정 = `aria-pressed={active}` 2곳.
- **P3-7 ChatPanel 브리지 실패 무표기**: LLM 실패는 말풍선에 `⚠` 로 표기됨(`:154-161,432-433` —
  탐지 후보의 절반은 반증됨). 남는 건 방 생성·전송·취소의 브리지 실패(`:274,285,345`) — #197 B4
  reject audit 주석이 있으나 데스크톱 IPC 실패엔 재시도 세대가 안 온다. 토스트 1곳.
- **P3-8 RiskLevel 동명이의**: `authBanners.ts:3`('clean|caution|warning') vs
  `shared/types.ts:326`('safe|caution|destructive') — 자동 import 오배선 벡터. 개명 1곳.
- **P3-9 테스트 환경 전제**: root 실행 시 chmod 기반 3건 FAIL(이 환경 실측 — 수정이 사이드
  브랜치에 이미 존재 = P2-3), git 2.43 에서 1건 FAIL(P3-4). stock 환경 `npm test` 신뢰 회복은
  P2-3 머지 + P3-4 가드로 완성.
- **P3-10 자기검토 무신호**: 기존 #293-B2 CONFIRMED(W2 트랙). 델타 = 사후 가시성(작업 보드
  `→ 이름` 칩, `ProjectPanel.tsx:614-621`)은 실재 — 공백은 사전 경고뿐임을 확인.
- **P3-11 ChatPanel 렌더 스케일링**: 델타 무배칭 방출(`engine.ts:346-353`) + 전량 map 렌더 사실.
  단 CLI 델타는 라인 단위라 빈도 낮고 실측 사고 0 — ADR-0003 기준 **트리거 기반 보류**(긴 방에서
  입력 지연 실측 시 착수)로 판정.

---

## 4. 버린 후보 (반증으로 기각 — 다음 사람이 같은 길을 안 가도록)

- store 스키마 버전 부재 → 로드가 미지 키 보존(`{...EMPTY,...parsed}` + memory.ts:258-263 전방호환
  주석)이라 다운그레이드 유실 주장 불성립. 버전이 필요한 곳(coord-area)엔 이미 있음.
- store fsync 부재 → 피해 상한이 `.corrupt` 격리(원본 잔존)이고 durable-fs 로의 전환이 선행 진단
  post-1.0 큐에 이미 기록(1~2일 견적 포함). P4 이하.
- persist 실패 무성/`.corrupt` 덮어씀/형 붕괴 부분 방어 → 각각 문서화된 결정(json-file.ts:34)·
  복합 전제·도달 경로 외부 편집뿐. (배너는 #293 W1 로그 sink 묶음이 커버.)
- unsigned + 자동 업데이트 → DESIGN·스펙·ADR-0017(사이드 브랜치) 3중 수용 + sha512·attestation·
  채널 가드 실재. 새 발견 아님.
- GHCR `:latest` 자동 배포 → sha-핀 권고 문서화 + 선행 반증 I3(ruleset 이 발행을 게이트) + 개인
  서버 1대 규모. 기각.
- 머지 hook(1,413줄) 유지비 과대 → 실사고 기반(페이지네이션 누락)·선행 반증 J1 재확인. 단 이번
  감사 중 무해한 heredoc python 명령이 실제로 오탐 차단되는 것을 실측 — 오탐 비용은 설계가 수용을
  명시(fail-closed 흡수)하므로 기록만 남긴다.
- `main/index.ts` 무테스트 → 1줄 위임 + 패리티 2종 + e2e 12스펙 커버, 로직은 모듈 추출·테스트
  보유. accept-with-warnings done 집계 → #162 스펙의 명시 결정(destructive 불변 보존). API 키
  무검증 → 선행 S9 에서 리라벨로 기각. MCP 자식 env 상속 → ADR-0009 3중 기록. locks↔authority
  순환 → type-only(런타임 순환 아님). MCP gate/discussRoom/loopback/SENSITIVE_FILE/전소/umask →
  §2 P4 관찰로 하향.

## 5. 렌즈별 커버리지

| 렌즈 | 살펴봄? | 못 본 부분과 이유 |
|---|---|---|
| L1 약속↔실제 | ✅ | MVP 10항목 전부 코드 대조 — 전부 실구현(껍데기 0) |
| L2 온보딩 | ✅ | 실기동 UX 는 미확인(디스플레이 없음) — 코드·문구 기준 |
| L3 경계 | ✅ | 코어 electron/DOM 0건 전수 확인 |
| L4 승인 게이트 | ✅ | 예외 8모듈 근거 절 8/8 확인 · 대조 테스트 21 통과 |
| L5 비밀 | ✅ | 로그 유출 전수 grep 0건 |
| L6 두 표면 | ✅ | 47채널 대조 · 패리티 테스트 실질성 확인 |
| L7 동시성 | ✅ | workbench 는 미배선 상태로 검토(#251 스테이징) |
| L8 저장소 | ✅ | — |
| L9 실패 내성 | ✅ | 실네트워크 장애 주입은 미실시(코드 검토) |
| L10 자원 | ✅ | 런타임 프로파일링 미실시(정적 검토) |
| L11 테스트 신뢰도 | ✅ | 커버리지 최저 파일 10개 목록은 미확인(coverage 요약 미보존) — floor 스코프·테스트 분포로 대체 |
| L12 배포·업데이트 | ✅ | 액션 SHA 핀·권한 최소 확인 |
| L13 컨테이너 | ✅ | ADR-0010/0011/0013 ↔ compose·smoke 정합 확인(실행은 안 함) |
| L14 의존성 | ✅ | `npm audit` 미실행(네트워크 명령 자제) — 락파일·사용처 검토로 대체 |
| L15 드리프트 | ✅ | — |
| L16 프로세스 ROI | ✅ | verify 총 소요 실측은 부분(개별 단계만 — install 33s+test 33s 등) |
| L17 접근성 | ✅ | 실 스크린리더 검증 미실시 |
| L18 다국어 | ✅ | 한국어 단일 — 구조상 불가능하지 않음, 현 규모 적정(P4) |
| L19 관측성 | ✅ | 핵심 갭(로그 sink)은 기존 #293-B4 |
| L20 복잡도 | ✅ | TODO 1건·순환 없음·거대 파일은 #251 스테이징 인지 |

기계 검사: `brain:check` ✓ · `typecheck` ✓ · `lint` ✓ · `test:coverage` 3009 통과/4 실패(전부 환경
요인 규명: root 3 + git 버전 1 — P3-9) · `approval-gate-exceptions` 21/21 ✓ · `engines-floor` 정합 ✓.

## 6. 다음에 할 일 추천 (상위 5, 순서대로)

1. **advisor 사이드 브랜치 머지**(P2-3) — ADR-0017/0018·진단 보고서·root 테스트 수정이 한 번에
   착지, #293 참조 무결성 복구. 저위험 문서+테스트 diff.
2. **단일 인스턴스 락 ~10줄**(P2-1 = #293 W1 첫 슬라이스) — 비용 대비 사용자 데이터 보호 최대.
3. **verify 무승인 실행 전제의 ADR 기록**(P2-2) — 코드 0줄로도 가능, W3 verify 작업과 동승 권장.
4. **문서 드리프트 일괄 정정**(P3-2·P3-3, 2파일) — 이 레포의 "문서=권위" 체계 복원. README 역량
   표·구조도, DESIGN §4/§7/§11-10.
5. **clamp 1곳 + git 버전 가드**(P3-1·P3-4, 각 1~2파일) — 자기 선언 불변식과 게이트 신뢰 회복.

## 7. 사용자에게 묻고 싶은 것

1. **P2-2 처리 수위**: verify 의 무승인 실행을 (a) ADR 로 수용만 기록할지, (b) 프로젝트 실행당
   1회 caution 승인을 넣을지 — (b)는 실행 UX 에 클릭 1회를 추가한다. 혼자 정하면 안 되는 UX·안전
   트레이드오프다.
2. **이 보고서의 발견을 #27/#293 sub-issue 로 등재할까?** — 등재는 쓰기 작업이라 승인 전 미실행
   (선행 진단의 「원칙 9」와 동일하게 보류).
3. **messages cap 기본값**(P3-5): 방당 상한이 데이터 삭제 정책이 되므로 값(예: 방당 2,000 +
   폐기 카운트)과 고지 방식은 사용자 결정 사항.
