# #137 — GitHub Actions SHA 핀 + `.semgrep/guardian.yml` 핀 정책 (설계)

- 출처: PR #136(워크플로 동기화 Phase 1) CodeRabbit 리뷰. #98(GitHub 플랫폼 위생) 트랙의 「관례→플랫폼강제」 연장.
- 트래커: 이슈 #137 (`area:devx`·`type:security`).
- 브랜치: `feat/137-actions-sha-pin-guardian`.

## 문제

레포의 GitHub Actions 핀 관례는 **의도된 정책이 아니라 검토 안 된 관행**이다:

- `.semgrep/guardian.yml` = 0바이트 빈 파일 → 핀 강제 정책 **부재**(미작성 흔적).
- **미핀 `actions/*` 13곳**(4 워크플로): `checkout@v7`(×6)·`setup-node@v6`(×4)·`upload-artifact@v7`·`attest-build-provenance@v4`·`dependency-review-action@v5`.
- **부수 실측**: `actions/dependency-review-action@v5` 는 태그가 아니라 **`v5` 브랜치 ref** 로 해석된다(브랜치 HEAD = 태그보다 더 가변). 공급망 노출이 더 크다.

가변 ref 는 작성자/계정 탈취 시 악성 커밋으로 이동 가능(2025-03 `tj-actions/changed-files` 공격이 정확히 이 방식). 유지비용은 ≈0 — 레포가 Dependabot github-actions(weekly)로 SHA 핀도 자동 bump(`# vN` 주석 포함)하므로 태그의 유일한 실익(업데이트 편의)이 무의미.

## 해석된 SHA (GitHub API, 전량 검증)

| 액션 | 커밋 SHA | 주석 |
|---|---|---|
| `actions/checkout` | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` | `# v7` (기존 핀과 일치) |
| `actions/setup-node` | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` | `# v6` |
| `actions/upload-artifact` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | `# v7` |
| `actions/attest-build-provenance` | `a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32` | `# v4` |
| `actions/dependency-review-action` | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | `# v5` (=v5.0.0; 브랜치ref였음) |

이미 핀된 참조(레퍼런스): `checkout@9c091bb… # v7`, `anthropics/claude-code-action@80b3… # v1` (backlog-rerank.yml·cutoff-gap-audit.yml).

## 결정: enforcement 엔진 = `scripts/skills-lint.mjs` 확장 (zero-dep)

대안 비교 후 사용자 승인:

- **(A) 실제 semgrep CI 도입** — 이슈 문구 그대로. Node/Electron CI 에 Python 툴체인(semgrep) 추가(~30-60s·semgrep 자체 공급망 표면). YAML `uses:` 매칭이 까다로움.
- **(B) skills-lint 확장 (채택)** — `.semgrep/guardian.yml` 은 **선언적 정책 문서**(유효 semgrep 룰, 로컬/Cloud 실행 가능)로 작성해 빈 placeholder 에 목적 부여. **강제는 기존 zero-dep `scripts/skills-lint.mjs`** 에 SHA-핀 검사를 더한다. 새 CI 의존성 0, 기존 게이트 재사용, vitest TDD. 비용: 정책이 2곳(룰+JS)에 인코딩 → 동기화 필요(상호 주석으로 완화).
- **(C) 하이브리드** — 양쪽 다. 핀 PR 에 서드파티 액션(semgrep-action)을 추가하는 아이러니·최대 무게.

채택 = **(B)**. 레포의 zero-dep 커스텀 린터 철학(`skills-lint.mjs`)과 정합, 기존에 이미 `.github/workflows/*.yml` 을 린트하는 게이트 재사용, TDD 친화. `guardian.yml` 은 여전히 실재(파일 목적 충족 + 온디맨드 semgrep 실행 가능).

## 작업 명세

### 1. 전 워크플로 SHA 핀 (13곳)

위 표의 SHA + `# vN` 주석으로 전환:

- `ci.yml`: `checkout@v7`×2, `setup-node@v6`×2
- `release.yml`: `checkout@v7`×2, `setup-node@v6`×2, `attest-build-provenance@v4`
- `e2e.yml`: `checkout@v7`, `setup-node@v6`, `upload-artifact@v7`
- `dependency-review.yml`: `checkout@v7`, `dependency-review-action@v5`

### 2. `.semgrep/guardian.yml` — 선언적 정책

유효한 semgrep 룰 `gha-pin-actions-to-sha`(severity ERROR) 작성. 헤더 주석에 **권위적 강제 = `scripts/skills-lint.mjs`**, 이 룰은 동일 정책의 미러(로컬/Semgrep Cloud 용)임을 명시. semgrep 은 CI 에서 실행하지 않는다.

### 3. `scripts/skills-lint.mjs` 확장 (강제)

- 새 순수함수 `scanWorkflowPins(text)` — 텍스트의 각 줄에서 `uses:` 스텝/잡 참조를 검사:
  - `owner/repo@<ref>` 형태에서 `<ref>` 가 **40자 소문자 hex SHA 가 아니면** 위반(태그·브랜치·짧은 SHA 전부 차단).
  - 로컬 액션(`./…`, `../…`) → 허용(핀 불요).
  - 게이트는 **완전 SHA 존재만** 강제. `# vN` 주석 부재는 실패 아님(Dependabot 이 주석 재작성 → over-enforcement·false positive 회피).
- `lintFile`: 경로가 `.github/workflows/` 아래 `.yml`/`.yaml` 이면 `scanWorkflowPins` 실행, 위반을 메시지 배열에 추가.
- `scripts/skills-lint.test.ts`: RED→GREEN 단위테스트(미핀 태그 적발, 핀 SHA 통과, 로컬액션 통과, 주석유무 무관).
- **CI 배선 불요** — `ci.yml` 의 `skills:lint` 스텝이 이미 `.github/workflows/*.yml` 글롭을 넘긴다. 신규 액션도 이 게이트가 자동 검사.

### 4. `persist-credentials: false` (이슈 선택항목)

push 불요·안전한 checkout 에만 적용: `ci.yml`(×2)·`e2e.yml`(×1)·`dependency-review.yml`(×1). **`release.yml` 제외** — 서명/publish 흐름 민감, 이 보안 PR 스코프 최소화(release publish 는 `GH_TOKEN` env 사용이라 git 자격증명과 무관하나 회귀 리스크 회피). 이미 핀된 AI 워크플로 2개는 기존에 `persist-credentials: false` 보유.

### 5. Dependabot 검증

SHA 핀 bump 는 github-actions ecosystem 의 문서화된 동작(주석도 재작성). 코드변경 아님 → **머지 후 다음 주간 Dependabot run 1회 확인**을 후속 메모로 남김(PR 차단 안 함).

## 품질 게이트 / 검증

- 4종 게이트: `typecheck`·`lint`·`format:check`·`test`(vitest, 신규 skills-lint 테스트 포함) green.
- `npm run skills:lint .github/workflows/*.yml` 로 실제 워크플로 전수 통과 확인(역설계: 일부러 미핀으로 만들면 fail 하는지).
- 적대 리뷰(다렌즈) 후 PR. 본문 `Closes #137`. Codex/CodeRabbit 봇 리뷰 대기·반영.

## 비-목표 (YAGNI)

- 실제 semgrep CI 실행(대안 A) — 채택 안 함.
- `docker://` 다이제스트 핀 강제 — 레포에 미사용, 룰 스코프 밖.
- release.yml `persist-credentials` 변경.
- `# vN` 주석 형식의 하드 강제.
