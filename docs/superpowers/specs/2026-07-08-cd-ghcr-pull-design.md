# CD 파이프라인 — GHCR pull 기반 배포 (설계)

> 상태: 설계 승인됨(2026-07-08) · 구현 대기
> 관련: `deploy/`(Phase A #195 · Phase B #197) · `docs/adr/0008-saas-전환-v3-터널-셀프호스트-채택.md`
> 배포 타깃: 24/7 상시 가동 Linux 서버(종류 미정) · 레포 `pdw96/fleet`(private)

## 1. 배경 — 왜 CD인가

지금 자동화된 것:

- `ci.yml` — master push/PR마다 `npm run verify`(품질 게이트 6종 + brain:check + format:check) + windows/node24 테스트.
- `release.yml` — `v*` 태그 → **데스크톱 Electron 앱** 빌드 + GitHub Release 발행.
- `e2e.yml` — 수동 dispatch + nightly cron.

빠진 것 **두 개**:

1. **CI에 deploy 스택 검증이 없다.** `ci.yml`은 JS 번들·vitest만 돌린다. C1/C2 같은 `src/` 변경이
   `fleet` 서버 이미지에 반영되려면 이미지를 재빌드해야 하는데, CI는 Docker 이미지를 빌드하지도
   `deploy/smoke.sh`를 돌리지도 않는다. 즉 **"CI 통과 = 배포 이미지 무결"이 아니다** — deploy 회귀는 지금
   아무도 안 잡는다.
2. **CD가 없다.** `docker-compose.yml`은 `image: fleet-server:${IMAGE_TAG:-local}` + 로컬 `build:`다.
   레지스트리 푸시도, 원격 배포도 없다. C1/C2를 머지한 뒤 라이브(터널 뒤 `fleet` 서버)에 반영하려면
   배포 호스트에서 `docker compose ... up -d --build`를 손으로 쳐야 했고, 매번 폰으로 수동 라이브 검증을 했다.

이 설계는 두 갭을 **하나의 GHCR pull 파이프라인**으로 닫는다: 이미지를 클라우드에서 빌드·smoke 검증해
GHCR에 발행하면 갭①이 닫히고, 24/7 서버가 그 이미지를 pull→recreate 하면 갭②(완전 자동 CD)가 닫힌다.

## 2. 목표 · 비목표

**목표**

- master 머지 → 클라우드가 `fleet`·`ttyd` 이미지를 빌드·smoke 검증 → GHCR 발행(**완전 자동 파이프라인**).
- 24/7 서버가 새 이미지를 pull → recreate → 헬스체크(**서버측 무인 갱신**).
- deploy 스택의 **"인바운드 포트 0 · 아웃바운드 터널만"** 철학 유지(서버는 GHCR로 아웃바운드 pull만).
- CI 갭①(deploy 이미지 검증)을 파이프라인의 smoke 게이트로 흡수.

**비목표(명시)**

- **PR 단계 사전 deploy 검증** — deploy 변경 빈도가 낮아 solo pre-1.0에선 ROI 낮음. 배포 직전 smoke 게이트로 충분.
- **제로 다운타임/blue-green 롤백** — `compose up -d`의 짧은 재시작 갭을 수용. 롤백은 이전 `:sha` 태그 재pull(수동).
- **다중 인스턴스·스케일링·오케스트레이터(k8s 등)** — Phase B의 **단일 인스턴스** 전제를 계승.
- **`release.yml`(데스크톱 앱)과의 통합** — 서버 스택 CD는 완전 별개 워크플로. 서로 트리거·산출물 무간섭.
- **서버 프로비저닝 자동화(IaC)** — 서버가 미정이라 가이드 문서로 대체.

## 3. 아키텍처

```
master 머지 (paths-ignore: docs/**·**/*.md·.claude/** 등 런타임 무관만)  또는  workflow_dispatch
  └─ .github/workflows/deploy.yml   [ubuntu-latest 클라우드 러너]
       1. checkout (SHA 핀 · persist-credentials:false)
       2. GHCR 로그인 (GITHUB_TOKEN, packages:write)
       3. smoke 게이트  — bash deploy/smoke.sh
                          (ttyd·fleet 이미지 빌드 + 컨테이너 불변식 13종)
                          FAIL → 잡 실패 → 푸시 없음 → 라이브 무변경
       4. 태그 + 푸시  — ghcr.io/pdw96/fleet-server:{latest, sha-<short>}
                          ghcr.io/pdw96/fleet-webterminal:{latest, sha-<short>}
 ─────────────────────────────── 아웃바운드 경계(인바운드 0) ───────────────────────────────
  24/7 Linux 서버 (미래):
    cron(기본) 또는 watchtower(옵션)
       → docker compose … pull           (GHCR read:packages 인증)
       → docker compose … up -d --wait   (변경분만 recreate + healthcheck 대기)
       → docker image prune -f           (오래된 레이어 회수)
```

**신뢰 경계**: 클라우드 러너는 이미지를 빌드·검증·발행만 한다(서버에 대한 지식 0). 서버는 GHCR에서
pull만 한다(인바운드 0). 둘을 잇는 유일한 매개는 **GHCR의 이미지 태그**다 — SSH도, self-hosted runner도,
서버로의 인바운드 연결도 없다.

## 4. 컴포넌트

### ① GHCR 빌드/푸시 워크플로 — `.github/workflows/deploy.yml`

- **트리거**: `on.push.branches: [master]` + `on.push.paths-ignore`(**역필터**) + `workflow_dispatch`(수동 재발행).
  **allowlist가 아니라 역필터인 이유(Codex 스펙 리뷰 P1)**: `deploy/fleet/Dockerfile`이 `COPY . .`로 **전체
  레포**를 빌드 컨텍스트에 넣고 `npm run build`를 돌리므로, 이미지 입력은 `src/**`보다 훨씬 넓다 — 루트
  빌드 설정(`vite.server.config.ts`·`electron.vite.config.*`·`tsconfig*.json`·`.npmrc`·`.dockerignore` 등)이
  이미지를 바꾼다. allowlist는 그런 파일을 빠뜨리면 **재빌드를 안 해 fail-open**(서버가 stale `:latest` 유지).
  대신 `.dockerignore`가 빌드 컨텍스트에서 빼거나 런타임에 무관한 경로만 `paths-ignore`로 스킵한다:
  `docs/**`·`**/*.md`·`.claude/**`·`.dogfood/**`·`**/*.png`·`coverage/**`·`.vscode/**`·`.idea/**`·`fleet-brain.html`.
  나머지(빌드 설정 전부)는 트리거를 탄다 = **fail-safe(애매하면 빌드)**. 새 파일은 스킵 목록에 없으면 기본
  트리거라 drift 방향도 안전. (`README.md`는 `.dockerignore` `!README.md`로 이미지에 포함되나 런타임 무관
  = 문서 레이어일 뿐 → `**/*.md` 스킵 허용.)
- **concurrency**: `group: deploy-ghcr`, `cancel-in-progress: true`(최신 머지만 발행 — stale 이미지 push 방지).
- **permissions**: `contents: read` + `packages: write`(GHCR 발행). 그 외 none.
- **잡**(ubuntu-latest, `HUSKY: 0`):
  1. `actions/checkout`(SHA 핀 · `persist-credentials: false`).
  2. GHCR 로그인 — `docker login ghcr.io -u ${{ github.actor }} --password-stdin`(`secrets.GITHUB_TOKEN`).
  3. **smoke 게이트** — `bash deploy/smoke.sh`. 이 스크립트가 `--profile tunnel`로 `fleet-webterminal:local`·
     `fleet-server:local`을 빌드하고 컨테이너 불변식 13종을 검증한다. FAIL이면 `exit 1` → 잡 실패 → 이후
     push 스텝 미실행 → 라이브 무변경. **기존 검증 자산 재사용**(신규 검증 로직 0).
  4. **태그 + 푸시** — smoke가 남긴 로컬 이미지에 GHCR 태그를 달아 push:
     - `docker tag fleet-server:local ghcr.io/pdw96/fleet-server:sha-<short>` + `:latest`
     - `docker tag fleet-webterminal:local ghcr.io/pdw96/fleet-webterminal:sha-<short>` + `:latest`
     - 4개 태그 push(`sha-<short>` = `github.sha` 앞 12자).
- **의존**: `deploy/smoke.sh`(게이트), Docker(ubuntu-latest 사전설치), GHCR(GITHUB_TOKEN 권한).
- **SHA 핀 게이트 준수**: 기존 `scanWorkflowPins`(zero-dep 강제 게이트)가 이 새 워크플로의 모든 `uses:`를
  커밋 SHA로 강제한다 → checkout/login 액션은 SHA 핀 필수.

> **smoke.sh의 CI 적합성**: `smoke.sh`는 `.env`를 optional로 취급(`[ -f .env ] && --env-file`)하고,
> fleet 컨테이너 기동 검증(step 11)은 **loopback 모드**(access env 불요)라 시크릿 없이 CI에서 완주한다.
> `--profile tunnel`은 `compose config`가 fleet 서비스를 포함하게 할 뿐(터널 실기동 아님).

### ② 서버측 pull — compose override + 갱신 스크립트

- **`deploy/docker-compose.ghcr.yml`**(override) — base compose의 `build:`를 GHCR `image:`로 대체해 서버가
  **로컬 빌드 없이 pull만** 하게 한다. 이미지 참조는 `ghcr.io/pdw96/fleet-{server,webterminal}:${IMAGE_TAG:-latest}`.
  (정확한 build-무력화 메커니즘 — compose `!reset`/prefix 변수/`--pull always` — 은 plan에서 확정.)
- **`deploy/pull-deploy.sh`**(서버 갱신 스크립트) — 멱등:
  ```
  docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel pull
  docker compose … up -d --wait        # --wait = compose healthcheck GREEN까지 블록
  docker image prune -f                # dangling 레이어 회수
  ```
  `set -euo pipefail`. pull 실패(네트워크/인증)·healthcheck 실패 시 loud fail + `docker compose logs --tail` 진단.
- **트리거(서버)**: **cron**(기본 권장) — `*/5 * * * * /path/pull-deploy.sh >> ~/fleet-deploy.log 2>&1`.
  단순·투명·데몬 없음(solo pre-1.0 정합). **watchtower**는 문서 옵션(라벨로 fleet/ttyd만 감시).
- **의존**: base `docker-compose.yml`, `.env`(서버 로컬·커밋 금지), GHCR 인증(`docker login`, `read:packages` PAT).

### ③ 프로비저닝 + 배포 가이드 — `deploy/README.md` 확장

- 새 절 「GHCR CD」: 서버 요구사항(Docker/Compose·아웃바운드망), GHCR 인증(`read:packages` PAT로
  `docker login ghcr.io`), override 사용법, cron/watchtower 설정, 롤백 절차(`IMAGE_TAG=sha-xxx` 핀→pull→up).
- **서버 권장**(미정이므로 옵션): 저가 VPS(상시가동·고정IP·백업 용이) vs 홈서버/미니PC(비용0·전기·가정망).
  둘 다 아웃바운드 pull이면 충분 — 인바운드 0.
- 「라이브 완료 체크리스트」에 CD 항목 추가(§9).

## 5. 핵심 설계 결정

1. **트리거 = master push + `paths-ignore` 역필터**(태그·allowlist 아님). fleet 이미지가 `COPY . .`로 전체
   레포를 빌드하므로 allowlist는 루트 빌드 파일을 빠뜨려 **fail-open**(Codex 스펙 리뷰 P1). `.dockerignore`
   정합 역필터로 docs-only만 스킵 = **fail-safe**. `workflow_dispatch`로 수동 강제 발행 보강.
2. **서버 갱신 = cron+compose 기본, watchtower 옵션**. watchtower는 편의 데몬이나, solo pre-1.0에선
   cron+`compose pull`이 더 단순·투명(무엇이 언제 갱신되는지 로그로 명확). watchtower는 원하는 이에게 문서로.
3. **태깅 = `:latest` + `:sha-<short>`**. `:latest`는 cron pull이 추적, `:sha-<short>`는 immutable 추적·롤백 핀.
4. **smoke를 push 전 게이트로**. 통과해야 발행 → 깨진 이미지가 GHCR `:latest`에 오르지 않음 → 서버가
   깨진 걸 pull하지 않음(fail-closed).
5. **`release.yml`과 완전 별개**. 데스크톱 앱(Electron/GitHub Release)과 서버 스택(Docker/GHCR)은 산출물·
   트리거·수명주기가 다르다. 워크플로 이름 충돌 없이 `deploy.yml` 신설.
6. **인증 = GITHUB_TOKEN(발행) / read:packages PAT(서버 pull)**. 발행은 잡 토큰으로 충분(추가 시크릿 0).
   서버 pull은 private 패키지라 PAT 필요 — 서버에 1회 `docker login`으로 `~/.docker/config.json` 영속.

## 6. 실패 모드 · 에러 처리

| 실패 지점 | 처리 |
| --- | --- |
| smoke 게이트 FAIL | 잡 실패 → push 스텝 미실행 → GHCR `:latest` 무변경 → 서버는 직전 정상 이미지 유지 |
| GHCR push 실패(권한/네트워크) | 잡 실패(loud) → 다음 머지/재-dispatch로 복구. 부분 push는 태그 원자성으로 완화 |
| 서버 pull 실패(인증 만료/네트워크) | `pull-deploy.sh` loud fail + 로그 → 이전 컨테이너 계속 가동(무중단) → 로그인 갱신 후 재시도 |
| 서버 up 후 healthcheck 실패 | `--wait`가 비정상 종료 → 로그 tail 진단 → 롤백(`IMAGE_TAG=이전 sha` 핀→pull→up) |
| concurrency 경합(연속 머지) | `cancel-in-progress`로 최신만 발행 → stale 이미지 push 없음 |

## 7. 테스트 전략

- **파이프라인 게이트**: `deploy.yml`은 `deploy/smoke.sh`(기존 13종 불변식)를 게이트로 재사용 — 신규 테스트
  로직 없이 이미지 회귀를 방어.
- **override 유효성**: `docker-compose.ghcr.yml`이 base와 병합돼 유효한지 `docker compose … config`로 검증
  (smoke.sh 또는 별도 lint 스텝에 canary 추가 가능).
- **워크플로 핀 게이트**: 기존 `scanWorkflowPins`가 새 워크플로의 액션 SHA 핀을 CI에서 강제(자동).
- **라이브 완주**(pull→recreate→터널): 서버가 있어야 실행 → §9 체크리스트로 위임(사일런트 캡 아님, 명시).

## 8. 파일 변경(예상)

- 신규 `.github/workflows/deploy.yml` — GHCR 빌드/smoke/푸시.
- 신규 `deploy/docker-compose.ghcr.yml` — build→GHCR image override.
- 신규 `deploy/pull-deploy.sh` — 서버측 멱등 갱신 스크립트.
- 수정 `deploy/README.md` — 「GHCR CD」 절 + 라이브 체크리스트 항목.
- (조정 가능) `deploy/docker-compose.yml` — 이미지 참조 prefix 매개변수화(override 방식에 따라).

## 9. 정직한 한계 · 라이브 완료 체크리스트

**지금 실검증되는 것**: 이미지가 smoke(13종 불변식) 통과 후 GHCR에 실제 발행되는 것까지(파이프라인 층).

**서버 마련 후 사용자가 라이브에서 완료할 항목**:

- [ ] 서버에 `docker login ghcr.io`(read:packages PAT) → private 이미지 pull 성공
- [ ] `docker-compose.ghcr.yml` override로 서버가 **로컬 빌드 없이** GHCR 이미지로 기동
- [ ] cron(또는 watchtower) 설정 → master 머지 후 새 이미지가 자동 pull→recreate 되는지 관측
- [ ] 갱신 후 터널 뒤 `fleet`·`ttyd` 정상(폰 브라우저 접속·오케스트레이션 UI 로드)
- [ ] 롤백 절차 실증 — `IMAGE_TAG=sha-<이전>` 핀 → pull → up 으로 이전 버전 복귀

**이유**: pull→recreate→터널 완주는 실 24/7 서버·GHCR private pull·실 터널이 있어야 하므로, Phase A/B와
동일하게 이 라이브 항목을 사용자 환경에 위임한다. 파이프라인(발행)은 지금 CI에서 실검증된다.
