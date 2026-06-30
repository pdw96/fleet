# #175 — 레포 위생·CI 정합 기계화 (관례→강제 / 미검증→실측)

> 출처 이슈: pdw96/fleet#175 (parent #98). 스펙 = 이슈 본문 5개 체크박스.
> 본 계획 = 5건 실측 검증(워크플로 `wf_65668764-e52`, 5에이전트·적대 verify) 결과 + 구현 설계.

## 검증 요약 (실측, 모두 grounded)

| # | 주장 | 판정 | 핵심 근거 / 정정 |
|---|---|---|---|
| 1 | `.gitignore` 가 `.claude/settings.local.json`·`worktrees/` 미제외 | ✅ confirmed (medium) | repo `.gitignore` 18줄에 `.claude` 0개. fresh-clone(`core.excludesFile`=빈파일) 시뮬레이션서 `git add -A` 가 `settings.local.json`·`worktrees/`·런타임 저널 staged 확인. **정정**: 현 `settings.local.json` = 권한 allowlist만(라이브 키 아님) → severity medium |
| 2 | AGENTS.md 4게이트 vs CI 6게이트 drift | ✅ confirmed (low) | CI quality 잡 = typecheck·lint·**skills:lint**·**format:check**·test·build(6). AGENTS.md=4, CONTRIBUTING=5, PR템플릿=5+brain → **3문서 3숫자**. `verify` 스크립트 없음. **함정**: `npm run skills:lint` 무인자 시 exit 2(CI는 명시 글롭+bash globstar로만 동작) |
| 3 | release 안전장치 약화 회귀센서 부재 | ⚠️ partial (medium) | 핵심 갭 확정: scanWorkflowPins 는 `uses:` 만 봄(step 존재·`with:` 값 무시). **vector1**(attestation 삭제)·**vector2**(persist-credentials 플립) 무방비 확정. **정정 — vector3 refuted**: `allowDowngrade`/`allowPrerelease` 는 release.yml 에 없음(소스 `src/main/auto-update.ts`) → 이미 `auto-update.test.ts:66-80` 가드. release.yml 에 그 assert 추가는 theater |
| 4 | brain.md 신선도(67 vs 68) | ✅ confirmed (low) | 실측: 커밋 헤더 `67 files`, `node scripts/brain/build.mjs` 재생성 = `68 files`(elicitation.ts 누락, #171/#172). LOC drift 다수(ProjectPanel·orchestrator 등). AGENTS.md L12-13 "54개 파일·≈6K 토큰" stale. **함정 — 제안 fix 결함**: `git diff --exit-code` 는 `generatedAt`(extract.mjs:277 분단위 타임스탬프)로 **영구 false-RED** → 인메모리 정규화 비교 필요 + cross-OS tie-order 비결정성(localeCompare 보강) |
| 5 | skills-lint 비밀스캔 src/** 미포함 | ✅ confirmed (low, 최저) | 두 호출처(ci.yml:46·lint-staged) 모두 src 제외. src/** 126파일 현재 0히트(통과). **함정**: `scripts/**` 확대 시 `skills-lint.test.ts` 픽스처 self-match 10히트 → `src/**` 만 확대. 핀 패스는 path-gated 라 src 에 미발현 |

## 구현 설계 (TDD)

### 핵심 결정
- **CI 잡 이름 `typecheck · lint · test · build` 불변** — master ruleset required check. 6스텝을 단일 `npm run verify` 로 치환하되 잡 이름·`windows vitest` 잡 유지.
- **brain:check 를 verify 에 포함** — `npm run verify` 가 CI quality 잡이 돌리는 전부를 실행 → local==CI 완전 일치(사용자 선택 "완전 기계화").

### 항목별

**A. `.gitignore` allowlist (item 1)**
```gitignore
# Claude Code 운영 디렉터리 — 추적 자산(README·skills·workflows)만, 런타임/로컬 자산 제외
.claude/*
!.claude/README.md
!.claude/skills/
!.claude/workflows/
```
- allowlist > denylist: 런타임 산출물 목록이 계속 늘어남(scheduled_tasks.lock 등). gitignore 는 이미-추적 파일을 untrack 안 하므로 README.md·skills/ 안전.
- **`!.claude/workflows/` 필수(Codex 리뷰 #5)**: lint-staged(`package.json:83`)·ci.yml:46 이 `.claude/workflows/**/*.js` 를 추적 자산으로 참조 → workflows/ 는 의도된 추적 위치. 3줄 allowlist 는 이를 차단하므로 negation 추가. README 에 명시.
- **주의**: 공유 `.claude/settings.json` 도입 시 `!.claude/settings.json` 추가(현재 없음 → 지금 추가 금지).
- `.claude/README.md` §제외 산문 → "repo `.gitignore` 가 기계적으로 강제(README·skills·workflows 만 추적)" 로 갱신.
- 회귀 게이트: vitest 가 `.gitignore` **텍스트**에 3줄 존재 단언(NOT `git check-ignore` — 전역 ignore 때문에 false-GREEN).

**B. verify 집계 + drift 차단 (item 2)**
- `scripts/skills-lint.mjs`: 무인자 호출 시 **내부 기본 글롭셋**(`fs.globSync`, 브레이스 미사용 — 개별 패턴)으로 자립. 기본셋 = `.claude/*.md`·`.claude/skills/**/*.md`·`.claude/workflows/**/*.js`·`.github/workflows/*.yml`·`*.yaml`·`docs/adr/**/*.md`·`src/**/*.ts`·`src/**/*.tsx`(item5 포함). 인자 명시 시 종전대로(lint-staged 무영향). 정말 0매치만 exit 2.
- `package.json` `"verify"`: `skills:lint && brain:check && format:check && typecheck && lint && test && build` (cheapest-first; `&&` 는 cmd.exe·bash 양쪽 동작).
- `ci.yml` quality 잡: 6 게이트 스텝 → 단일 `- run: npm run verify`(잡 이름 불변).
- 불변식 vitest(`scripts/repo-hygiene.test.ts`): package.json `verify` 가 6게이트 체인 포함 + ci.yml 이 `npm run verify` 사용 & 개별 게이트 스텝 부재 단언(재drift 차단).
- 문서 정합: AGENTS.md(L19-29·26·77·127)·CONTRIBUTING.md:9·PR템플릿:11-15·fleet-backlog-induction SKILL.md:20 → `npm run verify` 단일 지목.

**C. release 회귀센서 (item 3, vector 1·2만)**
- `scripts/skills-lint.mjs` `scanReleaseSafety(text)`: ① uncommented `uses:` 줄에서 `attest-build-provenance@<40hex>` 존재(삭제·un-pin 둘 다 적발) ② **각 `- uses: actions/checkout@` 스텝 블록을 들여쓰기로 잘라**(다음 형제/상위 indent 까지) 그 안에 uncommented `persist-credentials: false` 존재 검사 — **단순 count 아님(Codex 리뷰 #4)**. 텍스트 count(`pc:false ≥ checkout`)는 stray/주석/중복 persist-credentials 로 false-GREEN → 블록워크로 차단. 주석은 `^\s*` 앵커로 자연 제외. CRLF 정규화(`split(/\r?\n/)`). 한계: checkout 이 uses-first 가 아닌 name-first 스텝이면 미발현(scanWorkflowPins 와 동일 가정·레포 컨벤션 uses-first).
- `lintFile` 에 `/release\.ya?ml$/i` 분기(기존 핀 분기 옆).
- 테스트: 단위 픽스처(통과/attest삭제/pc플립) + **실 release.yml `readFileSync` 통합 단언**(파일 부재/리네임 시 loud RED — file-absent false-GREEN 방지).
- 현행 값(day-1 green): attest `@0f67c3f4856b2e3261c31976d6725780e5e4c373`·checkout 2·pc:false 2.
- vector3 미구현(refuted).

**D. brain.md 신선도 (item 4)**
- `scripts/brain/check.mjs`: `buildGraph()`+`toMarkdown()` 인메모리 재생성 → 커밋 brain.md 와 비교. **타임스탬프만 정규화**(`생성 \d{4}-..T..:.. UTC` → placeholder; 파일수/배선수는 유지해 67↔68 적발). CRLF 정규화. 불일치 시 offending 줄 출력 + exit 1. git 트리 미변경(인메모리).
- `scripts/brain/markdown.mjs`: degree-정렬 tiebreaker 추가(L43·L66 `|| a.id.localeCompare(b.id)`, L98-105 `|| a[0].localeCompare(b[0])`) — win32(dev)↔ubuntu(CI) readdir 순서차 비결정성 제거.
- `package.json` `"brain:check"` 신설 → verify 에 포함.
- `brain.md` 재생성·커밋(68파일, tiebreaker 적용 결정적 순서).
- AGENTS.md L12-13: "54개 파일"·"(≈6K 토큰)" 제거 → brain.md 헤더 자체 권위 참조(헤더에 토큰수 없음 → 토큰 추정치는 삭제).

**E. skills-lint `src/**` 확대 (item 5)** — B 의 기본 글롭셋에 `src/**/*.ts`·`*.tsx` 포함으로 동시 달성. lint-staged 에 `"src/**/*.{ts,tsx}": ["node scripts/skills-lint.mjs"]` 추가. self-match 회피 위해 `scripts/**` 미포함. (착수 전 src 0히트 재확인 — TDD RED 로 검출.)

## 순서 / 게이트
1. RED: scanReleaseSafety·brain check·gitignore·verify-contract 테스트 먼저.
2. GREEN: skills-lint.mjs(기본글롭+scanReleaseSafety)·brain/check.mjs·markdown.mjs tiebreaker·.gitignore·package.json·ci.yml.
3. markdown.mjs tiebreaker 후 `npm run brain` 재생성·커밋(68).
4. 문서 정합 일괄.
5. `npm run verify` green(=신규 7체인) + windows 영향 점검.
6. 적대 자가리뷰(fleet-pr-review) → PR `Closes #175` → Codex/CodeRabbit 반영 → squash.

## 리스크
- `fs.globSync` 브레이스 미지원 가능 → 개별 패턴 사용.
- src/** 비밀스캔 = 모놀리식 banned-pattern 이 src 에도 적용(경로·사용자명 ban 포함). 현재 0히트지만 향후 정당한 예시키/경로 리터럴 시 suppression escape hatch 없음 — 최저순위라 수용, 필요 시 후속 분리.
- verify `&&` 체인 win32: skills:lint 자립(글롭 내부화) 후엔 셸 글롭 의존 제거되어 안전.
