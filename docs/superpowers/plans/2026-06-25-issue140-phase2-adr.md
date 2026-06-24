# 워크플로 동기화 Phase 2 — ADR 결정·감사 로그 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 운영 지속·교차 결정의 근거를 레포 안 git-tracked ADR 로 정착시킨다(시드 3건 + 전진 1건 + 부기 시크릿 스캔 재사용 + 트리거 배선).

**Architecture:** `docs/adr/` 에 경량 하이브리드 마크다운 ADR(맥락/결정/고려한 대안·기각/결과). 부기 강제는 신규 코드 없이 기존 `scripts/skills-lint.mjs` 의 시크릿/경로 스캔을 `docs/adr/**` glob 에 재사용. 트리거는 AGENTS.md 「백로그 착수 절차」 + 스킬 2개 체크리스트(강제 아닌 환기). 구조 정합 자동화는 보류(ADR-0004 가 재도입 트리거 기록).

**Tech Stack:** Markdown · 기존 zero-dep `scripts/skills-lint.mjs`(ESM) · lint-staged · GitHub Actions(ci.yml). **신규 실행 코드 0.**

## Global Constraints

- **신규 스크립트 금지** — 구조 정합 검사 보류(스펙 D4). 부기는 기존 `skills-lint.mjs` 재사용만(#137 선례 = 별도 파일 금지).
- **시크릿/경로 위생** — 모든 ADR `.md` 는 `scanText` 차단 패턴(개인 절대경로 `C:\Users\…`·사용자명 `qkreh`·`ghp_`/`sk-` 키 등)을 담지 않는다. 출처 인용 시 일반화(실 경로 → `<repo-root>`).
- **언어** — 한국어(레포 #27·AGENTS.md·스펙 정합).
- **파일명** — `docs/adr/NNNN-kebab.md`, 4자리 순차.
- **frontmatter 5필드만** — `adr·title·status·date·related`. (deciders·supersedes·superseded_by·구조화 related 금지 — dead weight.)
- **입도** — 지속·교차 결정만(대안 있던 갈림길). 루틴 재랭킹 verdict 은 #27.
- **커밋 메시지 꼬리말** — 각 커밋에 다음 2줄:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN
  ```
- **이슈 키워드** — PR 본문은 `Part of #140`(메타 조기종료 방지 — `Closes` 금지).
- **검증 방식** — 신규 실행 코드가 없으므로 TDD(RED→GREEN) 대상 없음. 각 태스크의 "테스트"는 `skills:lint` 실행 + `grep` 마커 확인 + 품질 게이트.

---

### Task 1: ADR 디렉터리 스캐폴딩 + skills:lint 배선

기존 시크릿/경로 게이트를 `docs/adr/**` 로 확장하고 TEMPLATE·README 골격을 만든다. **이 태스크가 보안 게이트를 ADR 콘텐츠보다 먼저 잠근다.**

**Files:**
- Create: `docs/adr/TEMPLATE.md`
- Create: `docs/adr/README.md`
- Modify: `package.json`(lint-staged 블록, 현재 67-87행)
- Modify: `.github/workflows/ci.yml`(skills:lint step, 38-42행)

**Interfaces:**
- Consumes: 기존 `scripts/skills-lint.mjs`(`scanText` — ADR `.md` 는 `lintFile` 의 `endsWith('SKILL.md')`·`.github/workflows/` 분기에 안 걸려 `scanText` 만 받음).
- Produces: `docs/adr/**/*.md` 를 검사하는 lint-staged glob + ci.yml step 인자. 이후 모든 ADR 파일이 이 게이트 통과.

- [ ] **Step 1: TEMPLATE.md 작성**

`docs/adr/TEMPLATE.md`:
```markdown
---
adr: NNNN
title: <결정을 한 문장으로>
status: Accepted
date: YYYY-MM-DD
related: "<#이슈, memory:슬러그 등 자유형 — 출처추적용·비강제>"
---

## 맥락
왜 이 결정이 필요했나 — 강제력·제약·당시 상황.

## 결정
무엇을 정했나 — 한 문장 + 근거.

## 고려한 대안 / 기각 사유
- **대안 A**: … → 기각 이유.
- **대안 B**: … → 기각 이유.

## 결과 (Consequences)
좋은 점 / 감수하는 비용 / 후속·재검토 트리거.

<!-- 작성 지침: 대안이 없던 자명한 결정은 ADR 감이 아니다 — ADR 은 갈림길에서 한 길을
     고르고 나머지를 기각한 근거를 남기는 것. 지속·교차 결정만(루틴 verdict 은 #27).
     본문에 개인 절대경로·사용자명 인용 금지(시크릿 스캔 차단 — 일반화). -->
```

- [ ] **Step 2: README.md 인덱스 골격 작성(빈 표)**

`docs/adr/README.md`:
```markdown
# 결정 기록 (ADR — 운영·설계 Decision Records)

운영 **지속·교차 결정**(설계 선택·정책·refute)의 근거를 git-tracked 로 정착시키는 인덱스.
루틴 백로그 verdict 은 #27 에 남긴다(여기 중복 금지). 새 ADR = `TEMPLATE.md` 복사.

> 트랙: #140 (워크플로 동기화 Phase 2). 설계: `docs/superpowers/specs/2026-06-25-issue140-phase2-adr-design.md`.
> 강제 모델: 부기 시크릿/경로 스캔은 `skills:lint` 강제, 구조 정합은 사람 눈(ADR-0004 가 자동화 보류·재도입 트리거 기록).

| ADR | 상태 | 결정 |
|---|---|---|
```

- [ ] **Step 3: package.json lint-staged 에 glob 추가**

`package.json` 의 `lint-staged` 블록(`.github/workflows/*.{yml,yaml}` 항목 다음)에 한 줄 추가:
```json
    ".github/workflows/*.{yml,yaml}": [
      "node scripts/skills-lint.mjs"
    ],
    "docs/adr/**/*.md": [
      "node scripts/skills-lint.mjs"
    ]
```
(직전 항목의 닫는 `]` 뒤에 `,` 가 붙는 것 주의 — 마지막 항목이 바뀐다.)

- [ ] **Step 4: ci.yml skills:lint step 인자에 glob 추가**

`.github/workflows/ci.yml` 38-42행의 명령 끝에 `docs/adr/**/*.md` 추가:
```yaml
      - name: skills:lint (경로·시크릿 게이트)
        run: |
          shopt -s globstar
          node scripts/skills-lint.mjs .claude/*.md .claude/skills/**/*.md .claude/workflows/**/*.js .github/workflows/*.yml .github/workflows/*.yaml docs/adr/**/*.md
        shell: bash
```

- [ ] **Step 5: skills:lint 가 ADR 파일을 검사하는지 확인(통과)**

Run (Git Bash):
```bash
node scripts/skills-lint.mjs docs/adr/TEMPLATE.md docs/adr/README.md
```
Expected: `✓ skills:lint 통과 (2 파일)`

- [ ] **Step 6: fail-on-injection 실증(차단 패턴 주입 → fail → 제거)**

Run:
```bash
printf '%s\n' 'test path C:\Users\someone\secret' > docs/adr/_inject.md
node scripts/skills-lint.mjs docs/adr/_inject.md; echo "exit=$?"
rm docs/adr/_inject.md
```
Expected: `✗ skills:lint 위반 … 차단패턴[Windows 사용자 절대경로]` 출력 + `exit=1`. (제거 후 디렉터리 clean.)

- [ ] **Step 7: 품질 게이트 + 커밋**

Run:
```bash
npm run lint && npm run test
```
Expected: 둘 다 green(신규 실행 코드 0이라 test 영향 없음).

```bash
git add docs/adr/TEMPLATE.md docs/adr/README.md package.json .github/workflows/ci.yml
git commit -m "feat(#140): ADR 스캐폴딩 + skills:lint 를 docs/adr/** 로 확장

TEMPLATE·README 골격 + lint-staged/ci.yml glob. 신규 코드 0(scanText 재사용).

Part of #140

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN"
```

---

### Task 2: 시드 ADR 0001 — Codex required 게이트 보류

**Files:**
- Create: `docs/adr/0001-codex-required-게이트-보류.md`
- Modify: `docs/adr/README.md`(인덱스 표에 행 1개 추가)

**Interfaces:**
- Consumes: Task 1 의 README 골격(빈 표)·skills:lint glob.
- Produces: `docs/adr/0001-codex-required-게이트-보류.md`.

원 출처: 메모리 `codex-ci-gate-auth`(2026-06-23 다출처 검증 + Codex 봇·#98 토론 합의).

- [ ] **Step 1: ADR 0001 파일 작성**

`docs/adr/0001-codex-required-게이트-보류.md`:
```markdown
---
adr: 1
title: Codex 를 required CI 머지 게이트로 만들지 않는다
status: Accepted
date: 2026-06-23
related: "#98, memory:codex-ci-gate-auth"
---

## 맥락
Codex 리뷰를 GitHub required status check(머지 차단 게이트)로 만들 수 있는지 조사했다.
2026-06-23 다출처 검증 + Codex 봇과 #98 코멘트 토론으로 합의(Codex: "Claude 쪽 정정이 맞다").

## 결정
Codex 를 required CI 게이트로 만들지 **않는다**(보류). 솔로 pre-1.0 + 이미 봇 리뷰(Codex·CodeRabbit)
+ 사람 체크포인트 + ruleset `required_review_thread_resolution` 이 있어 ROI 가 낮고, 중복·flaky·플랜
한도·서드파티 리스크가 크다. 협업자 합류 또는 1.0 근처에서 재검토.

## 고려한 대안 / 기각 사유
- **공식 `openai/codex-action@v1`**: provider/API 키 필수 — 솔로 ChatGPT 구독-only 공식 경로 없음
  (`openai/codex-action` issue #92 = 미해결 기능 요청)·토큰당 과금. → 기각.
- **클라우드 코드리뷰 봇(`chatgpt-codex-connector`)을 게이트로**: commit status / check run 을 발행하지
  않고 리뷰 코멘트만 → required check 로 쓸 수 없음. → 기각.
- **`CODEX_ACCESS_TOKEN` + `codex exec`**: Business/Enterprise 워크스페이스 전용. → 기각(솔로 Plus).
- **ChatGPT-managed `auth.json` on CI**: trusted private runner 한정 advanced 경로·GitHub-hosted 러너
  부적합. OpenAI 도 "automation 인증은 API 키가 정답"이라 명시. → 기각.
- **서드파티 `JoeyTeng/codex-review-gate-action`**: GitHub 미인증. → 기각.

## 결과 (Consequences)
현 required check = `typecheck·lint·test·build` + `windows vitest`(ruleset id 17940177)만 유지.
Codex·CodeRabbit 는 비차단 어드바이저리 리뷰어로 운용(머지 전 대기·반영, 스레드 resolve).
**재검토 트리거**: 협업자 합류 또는 1.0 근처.
```

- [ ] **Step 2: README 인덱스에 행 추가**

`docs/adr/README.md` 표(`|---|---|---|` 다음 줄)에 추가:
```markdown
| [0001](0001-codex-required-게이트-보류.md) | Accepted | Codex 를 required CI 머지 게이트로 만들지 않는다 |
```

- [ ] **Step 3: skills:lint 통과 확인**

Run:
```bash
node scripts/skills-lint.mjs docs/adr/0001-codex-required-게이트-보류.md docs/adr/README.md
```
Expected: `✓ skills:lint 통과 (2 파일)` (차단 패턴 0).

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0001-codex-required-게이트-보류.md docs/adr/README.md
git commit -m "feat(#140): ADR-0001 Codex required 게이트 보류

Part of #140

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN"
```

---

### Task 3: 시드 ADR 0002 — #27 백로그 본문 다이어트

**Files:**
- Create: `docs/adr/0002-issue27-백로그-본문-다이어트.md`
- Modify: `docs/adr/README.md`

**Interfaces:**
- Consumes: Task 1 README·glob.
- Produces: `docs/adr/0002-issue27-백로그-본문-다이어트.md`.

원 출처: 메모리 `MEMORY.md` 위생 항목 · #98 🔵 Advanced 「#27 다이어트」(2026-06-21 실행).

- [ ] **Step 1: ADR 0002 파일 작성**

`docs/adr/0002-issue27-백로그-본문-다이어트.md`:
```markdown
---
adr: 2
title: 메타 백로그 #27 본문에 완료 이력을 누적하지 않는다
status: Accepted
date: 2026-06-21
related: "#27, #98"
---

## 맥락
메타 백로그 트래커 #27 본문이 변경이력·완료 백로그·구 통찰의 누적으로 22,374 bytes 까지 비대해졌다.
본문은 매 세션 로드되므로 비대화는 로드 비용 증가 + 라이브 큐 신호 희석을 낳는다.

## 결정
#27 본문을 «계약 헤더 · 현재 상태 · 차기 공급원 미착수 후보»만 담도록 다이어트하고, 향후 완료/머지
이력을 본문에 **누적하지 않는다**(코멘트·sub-issue·PR 로 위임). 2026-06-21 실행(22,374→3,666 bytes·83%↓,
#98 🔵 Advanced 「#27 다이어트」).

## 고려한 대안 / 기각 사유
- **`<details>` 로 접기**: 2026-06-15 시도했으나 본문 바이트는 그대로라 매 세션 로드 비용 잔존. → 기각.
- **그대로 누적**: 신호 희석·로드 비용 단조 증가. → 기각.

## 결과 (Consequences)
완료 상세는 PR·커밋·GitHub 편집이력·메모리에 보존(소실 없음). 트래커 본문은 라이브 큐만 유지.
이 ADR 이 #27 운영의 항구 규칙(`fleet-backlog-induction`·`fleet-backlog-rerank` 산출물의 기록 위치 결정).
**재검토 트리거**: 본문이 다시 비대해지면.
```

- [ ] **Step 2: README 인덱스에 행 추가**

```markdown
| [0002](0002-issue27-백로그-본문-다이어트.md) | Accepted | 메타 백로그 #27 본문에 완료 이력을 누적하지 않는다 |
```

- [ ] **Step 3: skills:lint 통과 확인**

```bash
node scripts/skills-lint.mjs docs/adr/0002-issue27-백로그-본문-다이어트.md docs/adr/README.md
```
Expected: `✓ skills:lint 통과 (2 파일)`

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0002-issue27-백로그-본문-다이어트.md docs/adr/README.md
git commit -m "feat(#140): ADR-0002 #27 백로그 본문 다이어트 정책

Part of #140

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN"
```

---

### Task 4: 시드 ADR 0003 — solo pre-1.0 과설계 ROI 경계

**Files:**
- Create: `docs/adr/0003-solo-pre-1.0-과설계-roi-경계.md`
- Modify: `docs/adr/README.md`

**Interfaces:**
- Consumes: Task 1 README·glob.
- Produces: `docs/adr/0003-solo-pre-1.0-과설계-roi-경계.md`.

원 출처: 메모리 `fleet-backlog-rerank-pending`(11차·12차 재랭킹, 2026-06-22) · #98.

- [ ] **Step 1: ADR 0003 파일 작성**

`docs/adr/0003-solo-pre-1.0-과설계-roi-경계.md`:
```markdown
---
adr: 3
title: 솔로 pre-1.0 단계에선 가치가 입증된 것만 백로그에 등재한다
status: Accepted
date: 2026-06-22
related: "#98, memory:fleet-backlog-rerank-pending"
---

## 맥락
백로그 재랭킹마다 컷오프 갭·기능 패리티 후보가 쏟아진다. 11차(2026-06-22)·12차(2026-06-22) 재랭킹에서
즉시등재 0 — 전 후보가 솔로/pre-1.0 ROI 렌즈로 다운그레이드됐다(12차는 18후보 전수).

## 결정
솔로 + pre-1.0 단계에선 투기적이거나 "다른 provider 엔 있는 보호의 비대칭 누수"에 불과한 기능은 등재하지
않는다. `register-now` 급은 가치가 입증된 net-new 발굴에서만 나온다. 과설계 경계를 명시적 ROI 게이트로 강제.

## 고려한 대안 / 기각 사유
- **컷오프 갭·패리티를 전부 등재**: 노이즈·과설계·영구 유지보수 부담. 솔로 1인엔 음수 ROI. → 기각.
- **전부 무시**: 실제 가치 갭(net-new)을 놓침. → 기각.

## 결과 (Consequences)
11차 "register-now = 비대칭 보호 누수만" · 12차 18후보 전수 다운그레이드로 실증. #98 보드 정량 커스텀필드도
같은 경계로 보류. 이 ADR 이 `fleet-backlog-rerank`·`fleet-backlog-induction`·기능 결정의 공통 ROI 게이트.
**재검토 트리거**: 협업자 합류 또는 1.0 근처(사용자 수·유지보수 분담이 ROI 계산을 바꿈).
```

- [ ] **Step 2: README 인덱스에 행 추가**

```markdown
| [0003](0003-solo-pre-1.0-과설계-roi-경계.md) | Accepted | 솔로 pre-1.0 단계에선 가치가 입증된 것만 등재한다 |
```

- [ ] **Step 3: skills:lint 통과 확인**

```bash
node scripts/skills-lint.mjs docs/adr/0003-solo-pre-1.0-과설계-roi-경계.md docs/adr/README.md
```
Expected: `✓ skills:lint 통과 (2 파일)`

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0003-solo-pre-1.0-과설계-roi-경계.md docs/adr/README.md
git commit -m "feat(#140): ADR-0003 솔로 pre-1.0 과설계 ROI 경계

Part of #140

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN"
```

---

### Task 5: 전진 ADR 0004 — ADR 시스템 경량 시작(도그푸드)

이번 브레인스토밍+적대 리뷰가 내린 결정을 전진 ADR 1호로 즉시 기록한다(시스템이 자기 결정을 기록 = 도그푸드).

**Files:**
- Create: `docs/adr/0004-adr-시스템-경량-시작.md`
- Modify: `docs/adr/README.md`

**Interfaces:**
- Consumes: Task 1 README·glob · ADR-0003(근거로 참조).
- Produces: `docs/adr/0004-adr-시스템-경량-시작.md`.

원 출처: 이 스펙(`2026-06-25-issue140-phase2-adr-design.md` §13) + 적대 리뷰 run `wf_3e7940c7-21c`.

- [ ] **Step 1: ADR 0004 파일 작성**

`docs/adr/0004-adr-시스템-경량-시작.md`:
```markdown
---
adr: 4
title: ADR 시스템을 경량으로 시작하고 구조 정합 lint 는 보류한다
status: Accepted
date: 2026-06-25
related: "#140, #137, ADR-0003"
---

## 맥락
Phase 2 ADR 시스템(#140) 설계 중 멀티에이전트 적대 리뷰(31건 중 확정 24건)가, 4-파일 규모에 구조 정합
lint(인덱스 orphan/dead-link·번호 유일성·frontmatter↔파일명)는 gold-plating 이라 판정했다. 또 그런 검사를
지으면 구현 함정 다발(정수↔zero-pad 비교·무인자 exit·TEMPLATE 자기 오탐·lint-staged untracked 형제·
Windows CLI 폴백)이 따라온다.

## 결정
ADR 시스템을 **최소로 시작**한다 — 부기는 기존 `skills:lint` 의 시크릿/경로 스캔만 `docs/adr/**` 에
재사용하고, 구조 정합 검사는 **보류**한다. 신규 `adr-lint.mjs` 를 만들지 않는다.

## 고려한 대안 / 기각 사유
- **구조 정합 lint 를 지금 도입**: 4건 규모에선 사람 눈이 즉시 검증 + 구현 함정 다발 + 영구 유지보수.
  [[0003-solo-pre-1.0-과설계-roi-경계]] 위반. → 기각(보류).
- **별도 `adr-lint.mjs` 파일**: #137 선례(`scanWorkflowPins` 를 기존 `skills-lint.mjs` 에 확장,
  "새 CI 의존성 0·기존 게이트 재사용")를 깨고 CLI 가드·배선·테스트 하네스를 두 벌 만듦. → 기각.
- **부기 강제 0(관례만)**: 시크릿/경로가 committed 콘텐츠에 누출될 위험(규모 무관 위협). → 기각.

## 결과 (Consequences)
ADR-0003(과설계 ROI 경계)을 ADR 시스템 자신에 적용한 도그푸드. 트리거(이 결정이 ADR 감인가)는 환원 불가한
판단이라 스킬+AGENTS.md 로 환기만 하며 관례가 잔존한다(제거 불가 — 정직).
**재도입 트리거**: ADR 이 ~12건을 넘거나 인덱스를 사람이 따라가기 어려워지면, 구조 정합 검사를
`skills-lint.mjs` 확장(#137 선례)으로 도입하고 그때 위 구현 함정을 처리한다.
```

- [ ] **Step 2: README 인덱스에 행 추가**

```markdown
| [0004](0004-adr-시스템-경량-시작.md) | Accepted | ADR 시스템을 경량으로 시작하고 구조 정합 lint 는 보류한다 |
```

- [ ] **Step 3: skills:lint 전체 통과 확인(4 ADR + README + TEMPLATE)**

```bash
node scripts/skills-lint.mjs docs/adr/*.md
```
Expected: `✓ skills:lint 통과 (6 파일)`

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0004-adr-시스템-경량-시작.md docs/adr/README.md
git commit -m "feat(#140): ADR-0004 ADR 시스템 경량 시작(구조 lint 보류·도그푸드)

Part of #140

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN"
```

---

### Task 6: 트리거 배선 — AGENTS.md + 스킬 2개

ADR 작성 트리거를 단일 권위(AGENTS.md)로 수렴시키고 스킬 2개에서 참조한다. **강제 아닌 환기**로 정직하게 기술.

**Files:**
- Modify: `AGENTS.md`(「백로그 착수 절차」 섹션, 111행~)
- Modify: `.claude/skills/fleet-backlog-rerank/SKILL.md`(「행동」 4단계)
- Modify: `.claude/skills/fleet-backlog-induction/SKILL.md`(「행동 (절차)」 3단계 부근)

**Interfaces:**
- Consumes: Task 1~5 의 `docs/adr/` 시스템.
- Produces: 리터럴 마커 "ADR 작성/갱신" 이 AGENTS.md + 두 SKILL.md 에 존재(§9.4 측정가능 마커).

- [ ] **Step 1: AGENTS.md 「백로그 착수 절차」에 결정 기록 절 추가**

`AGENTS.md` 의 「백로그 착수 절차」 섹션(111행 시작) 끝 — **다음 `## ` 최상위 헤딩 바로 앞**에 삽입:
```markdown
### 결정 기록 (ADR)

지속·교차 운영 결정(설계 선택·정책·refute — **대안이 있던 갈림길**)은 `docs/adr/` 에 ADR 로 **작성/갱신**
한다(`docs/adr/TEMPLATE.md` 복사·`README.md` 인덱스 1줄 추가). 루틴 재랭킹 verdict 과 자명한(대안 없던)
결정은 제외 — 전자는 #27, 후자는 ADR 감이 아니다. 이 절이 ADR 트리거의 단일 권위(스킬은 참조만).
부기 시크릿/경로 스캔은 `skills:lint` 강제, 구조 정합은 사람 눈(ADR-0004 가 자동화 보류 기록).
```

(삽입 위치 확인: `grep -n '^## ' AGENTS.md` 로 111행 다음 `## ` 헤딩 행번호를 찾아 그 **직전**에 둔다.)

- [ ] **Step 2: fleet-backlog-rerank SKILL.md 에 ADR 단계 추가**

`.claude/skills/fleet-backlog-rerank/SKILL.md` 「행동 (CLI 비종속)」의 4단계(산출) 뒤에 5번 추가:
```markdown
5. **결정 기록** — 티어 정책 변경·refute 확정 등 지속·교차 결정이면 **ADR 작성/갱신**
   (AGENTS.md 「백로그 착수 절차」 §결정 기록 참조 — 루틴 verdict 은 #27, 중복 금지).
```

- [ ] **Step 3: fleet-backlog-induction SKILL.md 에 ADR 단계 추가**

`.claude/skills/fleet-backlog-induction/SKILL.md` 「행동 (절차)」의 3단계(사이클) 항목 끝에 한 줄 덧붙임:
```markdown
3. **사이클** — 비자명하면 brainstorm → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`).
   TDD(RED→GREEN). 품질 게이트 4종 green. 적대 리뷰. **설계 선택이 지속·교차 결정이면 ADR 작성/갱신**
   (AGENTS.md 「백로그 착수 절차」 §결정 기록 참조).
```
(기존 3단계 문장에 마지막 굵은 절만 추가 — 나머지 문구 보존.)

- [ ] **Step 4: 마커 존재 확인(측정가능)**

Run:
```bash
grep -l "ADR 작성/갱신" AGENTS.md .claude/skills/fleet-backlog-rerank/SKILL.md .claude/skills/fleet-backlog-induction/SKILL.md
```
Expected: 3개 파일 경로 전부 출력.

- [ ] **Step 5: skills:lint(스킬 파일) + 커밋**

Run:
```bash
node scripts/skills-lint.mjs .claude/skills/fleet-backlog-rerank/SKILL.md .claude/skills/fleet-backlog-induction/SKILL.md
```
Expected: `✓ skills:lint 통과 (2 파일)`(frontmatter name/description 유지·차단 패턴 0).

```bash
git add AGENTS.md .claude/skills/fleet-backlog-rerank/SKILL.md .claude/skills/fleet-backlog-induction/SKILL.md
git commit -m "feat(#140): ADR 트리거 배선 — AGENTS.md 단일 권위 + 스킬 2개 참조

Part of #140

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MEay61Ay5yDz1dJzK4QQXN"
```

---

### Task 7: 시드 콘텐츠 적대 리뷰 + 전체 게이트 검증

**Files:** (검증·수정만 — 신규 파일 없음)

**Interfaces:**
- Consumes: Task 1~6 의 모든 산출물.
- Produces: 검증 완료된 PR-ready 브랜치.

- [ ] **Step 1: ADR 4건 내용 적대 리뷰(사실·맥락 정확성)**

4건(0001~0004)을 `fleet-pr-review` 렌즈(사실·맥락·출처대조·범위)로 적대 검토 — 각 ADR 의 결정·날짜·대안이
원 출처(메모리 `codex-ci-gate-auth`·`fleet-backlog-rerank-pending`·MEMORY.md·#98·이 스펙)와 일치하는지.
합격선 = **확정 P1 findings 0**. P1/P2 발견 시 해당 ADR 수정 후 재확인.

- [ ] **Step 2: 전체 skills:lint(배선된 전 범위)**

Run (Git Bash):
```bash
shopt -s globstar
node scripts/skills-lint.mjs .claude/*.md .claude/skills/**/*.md .claude/workflows/**/*.js .github/workflows/*.yml .github/workflows/*.yaml docs/adr/**/*.md
```
Expected: `✓ skills:lint 통과 (…파일)` — 0 위반(ci.yml 과 동일 인자로 CI 재현).

- [ ] **Step 3: 품질 게이트 4종**

Run:
```bash
npm run typecheck && npm run lint && npm run test && npm run build
```
Expected: 4종 전부 green(신규 실행 코드 0 → typecheck/test 영향 없음, lint 는 `.claude/**`·docs 무관).

- [ ] **Step 4: 완료 기준 점검(스펙 §9 측정가능 6항목)**

Run:
```bash
ls docs/adr/   # README.md TEMPLATE.md 0001..0004 = 6개
grep -l "ADR 작성/갱신" AGENTS.md .claude/skills/fleet-backlog-rerank/SKILL.md .claude/skills/fleet-backlog-induction/SKILL.md   # 3개
```
Expected: 6개 파일 + 3개 마커 매치. (§9.1·§9.4 충족.)

- [ ] **Step 5: finish — PR 생성**

`superpowers:finishing-a-development-branch` 로 마무리. PR 본문에 `Part of #140`(`Closes` 금지 — 메타
조기종료 방지), 적대 리뷰 결과 요약, 변경 범위(docs + 설정 glob 2줄·신규 코드 0). PR open 후 Codex(한도
소진 시 어드바이저리)·CodeRabbit 리뷰 대기·반영·스레드 resolve → 사용자 확인 후 squash.

---

## Self-Review (작성자 점검)

**1. Spec coverage** (스펙 §별 → 태스크):
- §3 레이아웃(README·TEMPLATE·시드3+0004) → Task 1·2·3·4·5 ✅
- §4 포맷(5필드 하이브리드) → 모든 ADR + TEMPLATE ✅
- §5 시드 3 + 전진 0004 → Task 2·3·4·5 ✅
- §6 부기(skills:lint 재사용·신규 코드 0) → Task 1 ✅
- §7 트리거(AGENTS.md 단일권위 + 스킬 2개·메모리 단방향) → Task 6 ✅
- §8 검증(코드 0=TDD 없음·게이트·ADR 적대리뷰) → Task 7 ✅
- §9 완료기준 6항목 → Task 7 Step 4 ✅
- §10 비범위(구조 lint·adr-lint.mjs·supersede 절차) → 계획에서 명시 제외 ✅

**2. Placeholder scan:** TEMPLATE.md 의 `NNNN`/`YYYY-MM-DD` 는 의도된 템플릿 토큰(시크릿 스캔만 적용,
구조 검증 없어 통과) — 플랜 placeholder 아님. 그 외 모든 ADR 본문은 실내용 완비. ✅

**3. Type/이름 일관성:** 파일명·인덱스 링크·frontmatter `adr` 번호(1~4) 일치. AGENTS.md 섹션명
「백로그 착수 절차」(실제 — 스펙 초안의 「운영 프로세스」 오류 교정 반영). 마커 문자열 "ADR 작성/갱신"
이 Task 6 삽입과 Task 7 grep 에서 동일. ✅
