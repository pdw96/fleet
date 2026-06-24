# 워크플로 동기화 Phase 2 — 결정·감사 로그(ADR) 설계

> 상태: 설계(브레인스토밍 산출). 작성 2026-06-25. 트랙: #140(메타) ← #135 Phase 2(C).
> 후속: 이 스펙 승인 → `writing-plans` 로 구현 계획.
> 범위 결정(2026-06-25 사용자): **Phase 2 (ADR) 만**. Phase 3(추가 자동화)는 tier:later 유지.

## 0. 한 줄 요약

운영 **지속·교차 결정**(현재 #27 코멘트·전역 메모리·세션에만 흩어진)을 레포 안 **git-tracked ADR**
로 정착시켜 감사·재현 가능하게 한다. **load-bearing 한 자리에 "관례" 0**: 결정 내용=git 파일,
트리거=스킬 체크리스트(프로세스 강제), 부기=`adr:lint` 정합 체크(lint-staged/CI 강제).

## 1. 배경 & 문제

#140 이 추적하는 #135 Phase 2(C). 운영 결정(백로그 재랭킹 티어 정책·설계 선택·refute·게이트 정책 등)의
**근거가 휘발성 저장소에만** 산다:

- **#27 코멘트** — 루틴 재랭킹 verdict (적정 위치, 유지)
- **전역 메모리** `~/.claude/.../memory/` — 레포 밖, 세션 리콜 최적화용. 비감사·비재현.
- **세션** — 휘발.

결과: "왜 이렇게 결정했나"가 클론 가능한 레포에 없어 감사·재현 불가. Phase 1(#136)이 *프로세스 실행*을
레포로 정착시켰다면, Phase 2 는 *프로세스가 내린 결정의 근거*를 정착시킨다.

## 2. 설계 결정 (브레인스토밍 확정, 2026-06-25)

| # | 결정 | 값 |
|---|---|---|
| D1 | 범위 | **Phase 2 (ADR) 만**. Phase 3 자동화는 별도 tier:later. |
| D2 | 입도 | **지속·교차 결정만**. 루틴 재랭킹 verdict 은 #27 에 유지(ADR 중복 금지). |
| D3 | 백필 | **소규모 시드(4건) + 이후 전진**. 휘발성에만 있는 seminal 결정만. |
| D4 | 배선/강제 | **스킬 체크리스트(트리거) + `adr:lint` 정합 체크(부기)**. 결정에 CI 게이트는 없음. |
| D5 | 포맷 | **경량 하이브리드** — Nygard(맥락/결정/결과) + 명시적 「고려한 대안·기각」 절(refute 문화). 한국어. |

### 2.1 "관례" 제거 모델 (이 설계의 핵심 — 자기모순 회피)

관례를 강제화하려는 시스템이 스스로 관례에 의존하면 같은 실패 모드(휘발·망각)를 재생산한다. 따라서
세 자리를 분리하고 load-bearing 한 곳엔 관례를 두지 않는다:

| 자리 | 기계화 | 처리 |
|---|---|---|
| **결정 내용** (ADR 파일) | — | git-tracked = 영구·감사 기록. 어떻게 트리거됐든 산출물은 영속. |
| **트리거** (이 결정이 ADR감인가?) | ❌ 환원 불가(판단) | `fleet-*` 스킬의 **체크리스트 단계**에 박음 → 프로세스 따르면 강제됨(떠다니는 메모 아님). |
| **부기** (인덱스↔파일↔frontmatter 정합) | ✅ 결정적 | `adr:lint` zero-dep 체크 → lint-staged/CI 강제. `skills:lint` 와 **동급 무결성 검사**(결정 게이트 아님). |

## 3. 레이아웃

```
docs/adr/
  README.md                 # 인덱스 — ADR당 1줄: `[ADR-NNNN] 상태 · 제목` → 링크
  TEMPLATE.md               # 새 ADR 시작 템플릿
  0001-claude-전용-운영-범위.md
  0002-codex-required-게이트-보류.md
  0003-issue27-백로그-본문-다이어트.md
  0004-solo-pre-1.0-과설계-roi-경계.md
scripts/
  adr-lint.mjs              # zero-dep 정합 체크 (skills-lint.mjs 미러)
  adr-lint.test.ts          # vitest (TDD)
```

- 파일명: `NNNN-kebab.md`, 4자리 순차(0001…). 위치 `docs/adr/`(표준·발견성).
- 인덱스 패턴: 전역 메모리 `MEMORY.md`(한 줄/항목)와 동형이되, **여기선 관례가 아니라 `adr:lint` 가 강제**.

## 4. ADR 포맷 (D5)

```markdown
---
adr: 2
title: Codex 를 required CI 게이트로 만들지 않는다
status: Accepted          # Accepted | Proposed | Superseded | Deprecated
date: 2026-06-23          # 원 결정 날짜(백필은 당시 날짜)
deciders: [Dowon Park]
related:
  issues: [98]
  prs: []
  memory: [codex-ci-gate-auth]   # 가리키는 전역 메모리 슬러그(있으면)
supersedes: []            # 대체하는 ADR 번호
superseded_by: null       # 대체된 경우 ADR 번호
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
```

- `adr` 프론트매터 값(정수)은 파일명 `NNNN` 과 일치해야 함(`adr:lint` 강제).
- 포맷 대안(기각): 순수 Nygard(대안 절 없음 — refute 근거 유실), 풀 MADR(pros/cons 표 — solo 과중).

## 5. 시드 4건 (D3 — 휘발성에만 있는 교차 결정)

| ADR | 결정 | 현 위치(휘발성) | status/date |
|---|---|---|---|
| 0001 | Claude 전용 운영 범위 — 멀티-CLI 포터빌리티 기계장치 제거 | #135 스펙 §0·§13 | Accepted / 2026-06-24 |
| 0002 | Codex 를 required CI 게이트로 만들지 않음 | 메모리 `codex-ci-gate-auth` | Accepted / 2026-06-23 |
| 0003 | #27 백로그 본문 다이어트 — 완료 이력 누적 금지(코멘트/sub-issue/PR 위임) | 메모리 · #98 | Accepted / 2026-06-21 |
| 0004 | solo pre-1.0 과설계 ROI 경계 — 투기적 기능 다운그레이드 | #98 · 메모리 · 12차 재랭킹 | Accepted / 2026-06-22 |

- **제외**: Actions SHA-핀 정책(#137)은 이미 `.semgrep/guardian.yml` 선언정책으로 **레포에 정착됨** →
  중복이라 시드 제외(입도 원칙 D2 적용 — 이미 비휘발성).
- 각 시드 내용은 구현 단계에서 원 출처 대조 후 작성하고 **적대 리뷰**로 사실·맥락 정확성 검증.

## 6. 부기 강제 — `adr:lint` (D4)

`scripts/skills-lint.mjs` 구조(순수 함수 export + CLI 가드 + vitest + lint-staged + CI)를 미러링.

**검사 항목 (전부 결정적):**

1. **frontmatter 규약** — `adr`(정수, 파일명 `NNNN` 과 일치)·`title`·`status`(허용 집합)·`date` 존재.
2. **번호 유일성** — 중복 `NNNN` 금지.
3. **인덱스 정합** — `README.md` 에 모든 ADR 파일이 1줄로 존재(orphan 0), 인덱스의 모든 링크가 실존
   파일을 가리킴(dead link 0).
4. **경로·시크릿 스캔** — `skills-lint.mjs` 의 `scanText` 를 **import 재사용**(DRY)해 ADR md 에 개인
   절대경로·자격증명 차단(committed 콘텐츠 보호).

**실행 모델:**

- `scripts/adr-lint.mjs` 는 인자와 무관하게 **`docs/adr/` 디렉터리 전체**를 스캔(인덱스 정합은 cross-file
  이라 단일 파일 모델 부적합). lint-staged 는 *트리거*(`docs/adr/**` 변경 시 호출)만 담당.
- export 순수 함수: `parseFrontmatter`·`validateAdrFrontmatter(text, filename)`·`checkNumbering(files)`·
  `checkIndex(indexText, files)`. CLI 가드는 `import.meta.url` 패턴(skills-lint 동일).
- 배선: `package.json` scripts `"adr:lint": "node scripts/adr-lint.mjs"` + lint-staged glob
  `"docs/adr/**/*.md": ["node scripts/adr-lint.mjs"]` + `ci.yml` 에 `npm run adr:lint` step
  (`skills:lint` 옆).

> **결정 게이트 아님 (#98 경계 존중):** `adr:lint` 는 "결정을 내렸으면 ADR 을 써라"를 강제하지 **않는다**
> (그건 정의 불가). 오직 *존재하는 ADR 시스템의 내부 무결성*만 강제 = `skills:lint` 와 동급. ADR 강제·
> 자동 생성은 Phase 3 ROI 게이트 영역.

## 7. 트리거 배선 — 스킬 체크리스트 (D4)

- **AGENTS.md** 「운영 프로세스」: 짧은 절 추가 — "지속·교차 결정은 `docs/adr/` 에 ADR 로 기록(루틴
  verdict 은 #27). 새 ADR → `docs/adr/README.md` 인덱스 1줄 + `adr:lint` 통과."
- **`fleet-backlog-rerank` SKILL.md**: 티어 정책 변경·refute 확정 시 "결정 지점 — ADR 작성/갱신" 한
  단계 추가(참조, AGENTS.md 중복 금지).
- **`fleet-backlog-induction` SKILL.md**: 설계 선택(스펙 승인) 시 동일 단계 추가.
- **메모리 관계**: ADR = 레포 canonical 감사 기록 / 메모리 = 세션 리콜 인덱스(용도 다름, 삭제 안 함).
  백필된 결정의 메모리 파일은 `[[adr-NNNN]]` 류로 ADR 을 가리키게 갱신(레포 밖 변경 — PR diff 아님).

## 8. 테스트 / 검증

- **TDD 대상 = `adr-lint.mjs`** (RED→GREEN, `skills-lint.test.ts` 미러). 케이스: 정상 통과 / frontmatter
  누락·잘못된 status / adr↔파일명 불일치 / 중복 번호 / orphan 파일(인덱스 누락) / dead link(인덱스만
  존재) / ADR 내 차단패턴.
- **문서·프로세스 변경**(ADR md·AGENTS.md·SKILL.md)은 실행 코드 아님 → 그 부분 TDD N/A. ADR **내용**
  은 적대 리뷰로 검증.
- **품질 게이트 4종**(typecheck/lint/test/build) green. 신규 `adr-lint.mjs`·`.test.ts` 가 test 게이트
  포함되는지 확인(vitest 설정 glob).
- **eslint 사각 주의**: `docs/adr/**` 는 코드 아님(검사 불필요). `scripts/adr-lint.mjs` 는 `scripts/` 라
  eslint 대상(skills-lint 와 동일하게 통과 필요).

## 9. 완료 기준 (측정가능)

1. `docs/adr/` 에 `README.md`·`TEMPLATE.md`·시드 4건 존재, frontmatter 규약 통과.
2. `npm run adr:lint` green(정합 0 위반). 의도적 위반 주입 시 fail(exit 1) 실증.
3. `package.json`(adr:lint + lint-staged glob)·`ci.yml`(step) 배선.
4. AGENTS.md 1절 + 스킬 2개(rerank·induction) 체크리스트 단계 배선.
5. 품질 게이트 4종 green.
6. 시드 4건 ADR 내용 적대 리뷰 통과(사실·맥락 정확성).

## 10. 비범위 (명시)

- Phase 3 추가 자동화 · ADR 작성을 강제하는 결정 게이트 · ADR 자동 생성.
- 모든 과거 결정 전면 백필 · 루틴 재랭킹 verdict 의 ADR 화 · 전역 메모리 레포 이관.
- `.claude/settings.json` 등 Phase 1 비범위 항목.

## 11. 위험 & 완화

| 위험 | 완화 |
|---|---|
| ADR 시스템이 다시 관례로 썩음(원 문제 재발) | §2.1 — 부기는 `adr:lint` 강제, 트리거는 스킬 체크리스트. load-bearing 관례 0. |
| 입도 크립(루틴 verdict 까지 ADR 화 → 노이즈·#27 중복) | D2 — 지속·교차만. AGENTS.md 절에 "루틴 verdict 은 #27" 명시. |
| 시드 ADR 사실/맥락 부정확(백필 왜곡) | §5·§8 — 원 출처 대조 + 적대 리뷰. |
| `adr:lint` 가 #98 "솔로 과설계" 경계 침범 | §6 주석 — 결정 게이트 아님, `skills:lint` 동급 무결성만. Phase 3 와 선 그음. |
| cross-file 인덱스 검사와 lint-staged 단일파일 모델 충돌 | §6 — CLI 가 `docs/adr/` 전체 스캔, lint-staged 는 트리거만. |
| 롤백 | 단일 PR(docs/adr/·adr-lint·package.json·ci.yml·AGENTS.md·skill 2개) → 한 묶음 revert. |

## 12. 오픈 결정 (구현 계획서에서 확정)

- `adr:lint` 의 `status` 허용 집합 정확값(`Accepted|Proposed|Superseded|Deprecated` 잠정).
- 인덱스 `README.md` 의 정확한 줄 포맷(파싱 가능해야 — 링크·번호·상태 추출 정규식 결정).
- 번호 검사를 "유일성"만 할지 "연속성(gap 금지)"까지 할지(잠정: 유일성만 — gap 은 정당할 수 있음).
- 시드 ADR 4건의 원 출처 정확 인용 위치(구현 시 대조).
