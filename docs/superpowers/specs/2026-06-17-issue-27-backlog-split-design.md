# 이슈 #27 로드맵 → 개별 이슈 분리 설계

- **날짜**: 2026-06-17
- **대상**: GitHub 이슈 #27 `메타: 백로그 우선순위 / 로드맵 (코드 검증 기반)` (pdw96/fleet)
- **유형**: 이슈 트래킹 재구성 (코드 변경 아님)

## 배경 / 문제

이슈 #27은 7차까지 재랭킹된 살아있는 백로그 로드맵(본문 ~85KB)이다. 가치는 크지만,
실제로 **착수 가능한 열린 작업들이 밀집 불릿 안에 묻혀** 있어 개별 할당·참조·완료
추적이 어렵다. 사용자 요청: "내용물을 개별 이슈로 만들자."

### 핵심 제약 (조사로 확인)
- 현재 열린 이슈는 5개뿐: `#11 #12 #13 #14 #27`. 이 중 `#11~#14`는 이미 "후속"
  umbrella 이슈로, #27의 일부 항목과 직접 겹친다 → **중복 생성 금지**.
- #27 본문의 대부분은 **✅완료 ~35건(머지된 PR로 추적됨)** + **🗑Drop ~10건(적대검증
  으로 일부러 기각)**. 이들은 이슈로 만들면 노이즈이거나 settled 판단의 재론이 된다.
- 따라서 "전부 개별 이슈로"는 비채택. **열린 actionable 항목만** 추출한다.

## 결정 (사용자 승인 완료)

1. **추출 범위**: 열린 actionable 항목만. 완료·Drop·refuted 제외.
2. **구조**: GitHub 네이티브 **sub-issue**. #27을 부모 메타 트래커로 유지, 각 항목을
   #27의 자식 이슈로 링크 → 진행률 자동 집계.
3. **목록 범위**: 실용적인 것만. 투기적/저가치(MCP Tasks·Streamable HTTP epic·
   self-improving skill loop·shared scratchpad)는 **이슈로 만들지 않고 #27 아카이브에
   잔류**, 추후 승격.
4. **#11 처리**: thinking/structured/caching 하위항목이 이미 머지 완료 → 잔여 granular
   2건을 새 이슈로 분리하고 #11은 정리 코멘트 후 **close**.
5. **라벨**: 기존 `enhancement` 재사용. 새 라벨 체계 도입 안 함.

## 작업 분해

### A. 기존 이슈 재사용 (생성 ❌, #27 sub-issue로 편입)

| 이슈 | #27 항목 | 메모 |
|---|---|---|
| **#12** | 풀 replan (오케스트레이터 재계획 루프) | #12 슬라이스는 PR #36/#44로 완료, 풀 루프는 미완 |
| **#13** | 기본 모델 ID 라이브 조회 (capability-api / 하드코딩 표류) | Later 항목과 동일 |
| **#14** | 개발 위생 (Node 핀·Prettier·pre-commit) | 7차서 가치 2로 강등(engines+.nvmrc 2줄만 클린 윈) |

### B. #11 정리 후 close

- 완료 하위항목 명시: thinking 파싱+노브 (PR #37/#38), structured output (PR #26),
  prompt caching (PR #43).
- 잔여 항목은 새 granular 이슈 C-1·C-2로 분리됨을 코멘트로 남기고 close.

### C. 신규 이슈 생성 (9건) — 점수는 #27 7차 (value/effort/risk)

**Provider 옵션 (granular):**
1. `anthropic-extended-cache-ttl-1h` (3/2/2) — bare `cache_control`에 `ttl:'1h'` +
   `extended-cache-ttl-2025-04-11` 베타 헤더 (현재 5m). >5m 꼬리(긴 빌드/느린 MCP)
   에서만 가치 — 얕은 조건부 채택.
2. `gemini① 2.5 effort→정수 thinkingBudget` (2/3/3) — effort 티어가 전부
   `thinkingBudget=-1`(AUTO)로 붕괴 중. 서브모델 range-detection 블로커 존재.

**Electron / 툴체인 (의존 순서 있음):**
3. `electron-packaging-pipeline` (2/4/3) — electron-builder/forge/autoUpdater 부재.
   유저 0명·DESIGN.md §11 MVP 제외·유료 코드서명 필요. CVE 페이로드가 유저에게
   닿으려면 이게 prereq.
4. `toolchain 번프` — Vite6 · Vitest 2→4 · electron-vite 2→5 · @types/node.
   electron major의 선행.
5. `electron 33→41/42 메이저` (3/3/4) — `electron ^33` EOL. **의존: 4 선행.**
6. `React 18.3→19` — 독립.

**MCP 신스펙:**
7. `MCP protocol 2025-11-25 + structuredContent + progress` — net-new (저가치지만 실재).
8. `Gemini Interactions API` (3/5/4) — net-new, 큰 작업.

**오케스트레이터 (Hermes 비교 채택 후보):**
10. `병렬 독립작업 실행 + mixture_of_agents` — 현 오케스트레이터가 순차 `await`로 실행
    하는 **신규 갭**. Hermes #344 비교서 도출.

> (목록의 9·11·12 = MCP Tasks/Streamable HTTP·self-improving·shared scratchpad는
> 결정 3에 따라 제외 — #27 아카이브 잔류.)

### D. #27 본문 변환

- 🟡Next/⚪Later의 밀집 불릿을 → 생성된 sub-issue 링크 체크리스트로 치환
  (`- [ ] #NN <제목>`).
- 랭킹표·코드검증 통찰·완료 이력·🔬컷오프갭 공급원·🗑Drop 섹션은 **그대로 보존**
  (아카이브 가치).
- 상단 리드 블록에 "착수 항목은 sub-issue로 분리됨 (2026-06-17, 8차 정리)" 한 줄 추가.

## 실행 방식

ultracode 환경 → 워크플로로:
1. **병렬 초안**: 신규 9건 각각의 이슈 본문을 #27 아카이브 산문에서 디테일 추출해
   초안 (1에이전트/이슈). 본문 = 배경·범위·근거(점수/refute 이력)·의존성·완료조건.
2. **생성**: 초안 검토 후 `issue_write`로 9건 생성 (라벨 `enhancement`).
3. **sub-issue 배선**: 신규 9 + 기존 #12/#13/#14를 #27의 sub-issue로 `sub_issue_write`.
4. **#11 정리**: 코멘트 후 close.
5. **#27 본문 편집**: D대로 치환.

## 검증 (완료 조건)

- [ ] 신규 9건 생성됨, 각자 `enhancement` 라벨·의존성 명시.
- [ ] #12/#13/#14 + 신규 9 = 총 12건이 #27 sub-issue로 링크됨 (#27에서 진행률 보임).
- [ ] #11 close, 잔여 분리 코멘트 존재.
- [ ] #27 본문: Next/Later 불릿 → sub-issue 체크리스트, 아카이브 섹션 보존 확인.
- [ ] 중복 이슈 0 (기존 #12/#13/#14를 새로 만들지 않았음).

## 비목표 (YAGNI)

- 완료·Drop·refuted 항목 이슈화 (노이즈/재론).
- 새 라벨/마일스톤 체계 (구조 결정 = sub-issue only).
- 투기적 항목(MCP Tasks/Streamable HTTP·Hermes self-improving·scratchpad) 이슈화.
- #27 아카이브/통찰 섹션 삭제 (보존).
