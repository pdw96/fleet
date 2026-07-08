# CD 파이프라인 — GHCR pull 기반 배포 (구현 계획)

> 대상: **#222** (Part of #98) · 스펙: `docs/superpowers/specs/2026-07-08-cd-ghcr-pull-design.md`
> 브랜치: `feat/cd-ghcr-pull` · 커밋 prefix: `feat(#222):`

## 판사 패널 판정 (머리말)

**파이프라인**: fleet-planner ×3(리스크/MVP/계약 각도) → fleet-plan-judge ×2(공백 그룹·Codex 강점 그룹) → 메인 루프 합성.

| judge \ 초안 | A(리스크) | B(MVP) | C(계약) | 승자 |
| --- | --- | --- | --- | --- |
| 공백 그룹(프레임·비용·커버리지·동적검증) | **14** | 14 | 13 | **A** (동적검증 엄밀성·비용 정직성) |
| Codex 강점(계약drift·보안·race) | **14** | 8 | 14 | **A** (계약 풋건 구조 제거·보안 소진) |

**승자 = 초안 A(리스크 우선), 두 judge 만장일치.** 승자 불일치 없어 강등 규칙 미적용. 각도 붕괴 아님(load-bearing 분기 뚜렷: `GHCR_TAG` 분리[A만]·actor-ban 핀[C만]·push 순서[B는 latest-먼저=결함]·provenance 결정[A만]·flock[C만]·Dockerfile LABEL[B만]).

**이 계획 = A 골격 + 이식(공백 그룹·Codex 강점 지적 구분 기록 — 이후 Codex 체크포인트와 대조해 렌즈 실효 측정):**

- **[Codex 강점 그룹]** ← C: 4-way 리터럴 이름 핀 · paths-ignore⊆.dockerignore 의미매핑 테스트 · **namespace actor-ban 핀** · push 순서(sha-먼저) 핀 · SHA `/sha-[0-9a-f]{12}/` regex 핀 · cron **flock** · 계약 명세 표.
- **[공백 그룹]** ← B: **MVP 경계 표**(지금 실검증 vs 위임 슬라이스) · Dockerfile **`org.opencontainers.image.source` LABEL** · `gh api …/packages/container/…/versions` 관측 명령.
- **[공백 그룹]** ← C: **workflow_run vs master-push 프레임** 열린질문 → README 명문화.

**계약 drift 3쟁점 판정**: ① namespace = **`${{ github.repository_owner }}`(소문자)** + actor 금지 핀(로그인 `-u`는 actor 무방 — 토큰이 권위) ② IMAGE_TAG 분리 = **신규 `GHCR_TAG`**(A — `.env.example:66 IMAGE_TAG=local` 복사 풋건 소거) ③ SHA = **12 hex** regex 핀.

**공통 결함 8종 반영** (두 judge가 세 초안 모두에서 발견): 아래 §7 표에 태스크로 매핑.

---

## MVP 경계 (B 이식 — 지금 실검증 vs 위임)

**핵심 전제: 24/7 서버가 아직 없다.** CD 후반부(pull→recreate→라이브)는 지금 실검증 불가, 파이프라인(GHCR **발행**)만 지금 실검증된다.

| 계층 | 태스크 | 지금 검증 |
| --- | --- | --- |
| **① 발행(1순위·지금 실동작)** | T0 핀 · T1 deploy.yml+LABEL | 머지 시 GHCR에 4태그 실발행 = 지금 라이브 검증 |
| **② 서버측(저술·부분 검증)** | T2 override+canary · T3 pull-deploy.sh | override 병합·문법은 지금 로컬 검증 / pull→recreate는 서버 후 |
| **③ 문서(저술)** | T4 README+.env.example | 지금 완성 |
| **④ 라이브(위임)** | pull→recreate→터널·롤백 실증 | 서버 마련 후 사용자 환경(§8) |

**실측 전제**(3 planner Grep 교차검증): smoke.sh cleanup(L37-41)은 컨테이너·볼륨만 rm·**이미지 잔존** → `fleet-{server,webterminal}:local` 태그 재사용 가능 · CI엔 `deploy/.env` 없어 `${IMAGE_TAG:-local}` 결정론적 `local` · scanWorkflowPins가 `.github/workflows/*.yml` SHA 핀 자동 강제 · vitest include `scripts/**/*.test.ts`·coverage floor `src/main/core/**` 한정(핀 테스트 무영향) · **코드 계약 ripple 0**(YAML·shell·docs 전용 → `npm run brain` 불요).

---

## 태스크 분해 (TDD — 계약/보안 핀 먼저 RED)

의존: `T0(핀 RED) → T1(deploy.yml GREEN)` · `T2(override+canary)` · `T3(pull-deploy.sh)` · `T4(문서)` · `T5(verify)`. 병렬 착수 가능 {T0/T1, T2, T3}. T4는 T2·T3 후. T5 최종.

### T0 — 계약·보안 회귀 핀 (정적 테스트 · RED 먼저)

> 리스크·계약 각도 합류: 구현 재량으로 보안/fail-safe/계약이 조용히 약화돼도 무신호가 안 되게 코드보다 테스트를 먼저 둔다. `scripts/`에 두면 vitest include로 **PR마다 상시 실행**(Docker 불요), coverage floor 무영향.

- **파일**: `scripts/deploy-cd-pin.test.ts` (신규 · `scripts/deploy-sandbox-boundary-pin.test.ts` 동형).
- **RED 단언** (deploy.yml·docker-compose.ghcr.yml 부재로 실패 → T1/T2가 GREEN):
  1. **[보안] 권한 최소성 음성 핀**: `permissions:`가 `contents: read` + `packages: write`만 — `id-token`/`attestations`/`issues`/`contents: write` **부재** 정규식.
  2. **[보안] 시크릿 유출 밴**: `--password-stdin` 존재 **AND** `docker login … -p `/`--password ` 리터럴 **부재**.
  3. **[fail-safe] 역필터 핀**: `on.push`에 `paths-ignore:` 존재 **AND** `paths:`(allowlist) **부재**(`^on:`~다음 최상위 키 앵커로 스텝 내 오매칭 회피). allowlist로 뒤집히면 RED(fail-open 재도입 차단 — Codex 스펙 P1의 load-bearing 결정).
  4. **[fail-closed] 발행 순서 핀**: `bash deploy/smoke.sh` 라인 < 첫 `docker push` 라인 · push 스텝에 `if: always()`/`continue-on-error: true` 부재.
  5. **[race] 태그 순서 핀** ← C: `:sha-` push가 `:latest` push보다 **앞**(롤백 타깃 선보장).
  6. **[계약] namespace actor-ban 핀** ← C: image 경로에 `ghcr.io/${{ github.actor }}` **부재**(봇/dependabot 트리거 오push 차단) · `ghcr.io/${{ github.repository_owner }}` 또는 소문자 리터럴 사용.
  7. **[계약] SHA regex 핀** ← C: `/sha-[0-9a-f]{12}/` 또는 생성식 `${GITHUB_SHA::12}`/`${GITHUB_SHA:0:12}` 존재(12 hex 고정).
  8. **[계약] 4-way 이름 리터럴 일치** ← C: base `docker-compose.yml`의 `fleet-{server,webterminal}` basename == deploy.yml push target == `docker-compose.ghcr.yml` image == (smoke 폴백 `:local`). 바이트-동일.
  9. **[계약] paths-ignore ⊆ (.dockerignore ∪ {README.md}) 의미매핑** ← C: paths-ignore 각 항목이 `.dockerignore` 제외에 대응하거나 README.md 명시 예외. 미대응 항목 = FAIL(fail-open 사전 차단). 역방향(불필요 빌드)은 미검사 = fail-safe.
  10. **[공급망] checkout SHA 균일 핀**: deploy.yml checkout이 `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`(ci.yml·release.yml 실측 동일) + `persist-credentials: false`.
  11. **override 파일 핀**: `docker-compose.ghcr.yml`에 fleet·ttyd 각 `build:\s*!reset` + `ghcr.io/…/fleet-{server,webterminal}` image + `GHCR_TAG`.
- **검증**: `npx vitest run scripts/deploy-cd-pin.test.ts` → T1/T2 전 RED, 후 GREEN. `scanWorkflowPins`(액션 SHA 핀)는 skills:lint가 자동 강제하므로 이 파일에서 중복 안 함(단 #10 checkout SHA 균일은 별개 계약이라 유지).
- **ripple**: 신규 테스트 파일. 소비처 0. coverage floor 무영향.

### T1 — `.github/workflows/deploy.yml` + Dockerfile LABEL (GREEN)

- **파일**: `.github/workflows/deploy.yml`(신규) · `deploy/fleet/Dockerfile`·`deploy/webterminal/Dockerfile`(각 LABEL +1줄).
- **deploy.yml**:
  - `on: push: { branches: [master], paths-ignore: [docs/**, **/*.md, .claude/**, .dogfood/**, **/*.png, coverage/**, .vscode/**, .idea/**, fleet-brain.html] } · workflow_dispatch: {}`.
  - `concurrency: { group: deploy-ghcr, cancel-in-progress: true }`.
  - `permissions: { contents: read, packages: write }`.
  - job(ubuntu-latest, `env: { HUSKY: 0 }`):
    1. `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7` (`persist-credentials: false`, full checkout — 빌더 `COPY . .` 요구).
    2. **GHCR 로그인**(raw·서드파티 액션 0 ← A 결정③): `echo "$GHCR_TOKEN" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin` (`env: GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}` — argv 미노출·GHA 마스킹).
    3. **smoke 게이트**: `bash deploy/smoke.sh` (13종 불변식+시크릿 미baking L144-149 재사용). exit 1 → 이후 스텝 스킵(fail-closed).
    4. **이미지 원자 선점검** ← A: `docker image inspect fleet-server:local fleet-webterminal:local >/dev/null` (한 번에 **둘 다** — 부분 push 방지).
    5. **태그+push**(sha 먼저·둘 다 → latest 둘 다 ← C 순서):
       ```bash
       SHORT="${GITHUB_SHA::12}"; OWNER="${{ github.repository_owner }}"; O="${OWNER,,}"
       for svc in server webterminal; do docker tag "fleet-$svc:local" "ghcr.io/$O/fleet-$svc:sha-$SHORT"; docker push "ghcr.io/$O/fleet-$svc:sha-$SHORT"; done
       for svc in server webterminal; do docker tag "fleet-$svc:local" "ghcr.io/$O/fleet-$svc:latest";   docker push "ghcr.io/$O/fleet-$svc:latest";   done
       ```
- **Dockerfile LABEL** ← B/C (양 파일): `LABEL org.opencontainers.image.source="https://github.com/pdw96/fleet"` — GHCR 패키지↔레포 자동 링크·private-inherit 가시성(첫-발행 갭 완화). 빌드 라벨이라 smoke step2/10 불변식 무영향.
- **검증**: 사전 = `npx vitest run scripts/deploy-cd-pin.test.ts`(T0) · `npm run skills:lint`(액션 SHA 핀) · `npm run format:check`. 권위(라이브) = **master 머지/`workflow_dispatch` → Actions 로그 4태그 push + `gh api /users/pdw96/packages/container/fleet-server/versions`로 `latest`·`sha-<12>` 확인** ← B 관측 명령.
- **fail 방향**: smoke·login·inspect·push 실패 전부 push 이전/중 잡 실패 → GHCR `:latest` 무변경 → 서버 직전 이미지 유지(fail-closed). concurrency 경합 → 최신만.
- **ripple**: deploy.yml → skills:lint·T0 핀·GHCR. Dockerfile LABEL → smoke 재빌드(무행동). **코드/타입 ripple 0**.

### T2 — `deploy/docker-compose.ghcr.yml` override + `.env.example` GHCR_TAG + smoke canary

- **파일**: `deploy/docker-compose.ghcr.yml`(신규) · `deploy/.env.example`(수정) · `deploy/smoke.sh`(canary 섹션 append).
- **override** (`build: !reset null` ← 3 planner 만장일치·§미결정①):
  ```yaml
  # 서버측 pull override (#222 CD) — base build:를 GHCR image:로 대체(로컬 빌드 없이 pull).
  # 요구: Docker Compose 2.24+(!reset). 인증: docker login ghcr.io (read:packages PAT).
  services:
    ttyd:  { build: !reset null, image: "ghcr.io/pdw96/fleet-webterminal:${GHCR_TAG:-latest}" }
    fleet: { build: !reset null, image: "ghcr.io/pdw96/fleet-server:${GHCR_TAG:-latest}" }
  ```
  (블록 표기로 작성 — 위는 압축. cloudflared는 registry image라 무변경. base `docker-compose.yml` **무변경** = smoke·로컬 dev 경로 보존.)
- **`.env.example`** ← A(GHCR_TAG 분리): `GHCR_TAG=latest` 추가(신규 변수 — `IMAGE_TAG`와 **분리**). 근거: 공유 `.env`의 `IMAGE_TAG=local`(L66)을 override가 재사용하면 서버가 `ghcr.io/…:local`(부재) pull → 실패. GHCR_TAG로 디커플: 로컬 빌드(`IMAGE_TAG`) vs 서버 pull(`GHCR_TAG`). **크로스이미지 일관성**(§7-①)도 이 변수로 해결 — 서버가 `GHCR_TAG=sha-<N>` 단일 핀 시 두 이미지 동일 커밋 세트 보장.
- **smoke canary** (override 병합 실증 · 빌드 없음): smoke.sh 말미에 `docker compose -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel config -q`(병합 유효 = `!reset` 수용) + config 출력에서 fleet/ttyd 블록에 `image: ghcr.io/…` 존재 AND `build:` 부재(step12 awk 블록 추출 재사용). canary 실패 = loud FAIL(false-GREEN 금지).
- **검증**: `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.ghcr.yml --profile tunnel config -q`(Linux/WSL2 — **지금 로컬 검증**) · `bash deploy/smoke.sh`(canary GREEN) · `npx vitest run scripts/deploy-cd-pin.test.ts`(#8·#11).
- **경계값**: GHCR_TAG 미설정 → `:latest`. 롤백 = `GHCR_TAG=sha-<이전12>`. Compose <2.24 → `config -q` loud-fail(fail-closed) → README fallback.
- **ripple**: override → pull-deploy.sh(T3)·smoke canary·README(T4)·T0 핀. base 무변경 → smoke 로컬 경로 무회귀.

### T3 — `deploy/pull-deploy.sh` (서버측 멱등 갱신)

- **파일**: `deploy/pull-deploy.sh`(신규 · `set -euo pipefail`).
- **절차** (A 골격 + flock[C] + 런타임시크릿 전제[§7-③]):
  1. **Compose 버전 가드**: `docker compose version` 파싱 → <2.24면 loud-fail(`!reset` 미지원 명시).
  2. **flock 단일화** ← C: `flock -n` 로 cron `*/5` 겹침 방지(이전 pull/up 진행 중이면 이번 회차 skip).
  3. **롤백 타깃 기록**: pull 전 현재 이미지 digest 로그.
  4. `docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel pull`.
  5. `… up -d --wait` (healthcheck GREEN까지 블록).
  6. `docker image prune -f` (dangling만 — `-a` 금지: 이전 `:sha` 롤백 보존).
  7. 실패 시 `… logs --tail` 진단.
- **fail 방향**: pull/up 실패 → set -e loud abort + logs → 이전 컨테이너 계속 가동(무중단·fail-safe). 자동 승격 없음.
- **검증**: 지금 = `bash -n deploy/pull-deploy.sh`(문법) + T0 pull-deploy 계약 핀(`--profile tunnel`·두 `-f`·`--wait`·`set -euo pipefail`·prune는 up 뒤). 완주 = **서버 후 라이브 위임**(§8).
- **ripple**: pull-deploy.sh → cron(서버)·README(T4). 소비 코드 0.

### T4 — `deploy/README.md` 「GHCR CD」 절 (문서 = 라이브 미검증 갭의 안전망)

- **파일**: `deploy/README.md`(신규 절).
- **내용** (A 런북 + 공통 결함 반영):
  - **파이프라인**: master 머지 → deploy.yml smoke 후 `ghcr.io/pdw96/fleet-{server,webterminal}:{latest,sha-<12>}` 발행. `release.yml`(데스크톱)과 별개.
  - **갭① 프레임 정직화** ← C: "발행 게이트 = smoke(컨테이너 불변식) **only** · 코드 정합은 **PR CI 선행 전제**. smoke는 머지-후만 돌아 Dockerfile/compose를 깨는 PR은 CI green으로 머지되고 발행 실패로 사후 발현(§7-③)." `workflow_run`(CI green 후) 승격은 후속 판단으로 명시.
  - **서버 요구**: Docker + Compose **2.24+**(`!reset`) · 아웃바운드망만(인바운드 0).
  - **GHCR 인증 런북** ← A: fine-grained PAT `read:packages`만 · `echo <PAT> | docker login ghcr.io -u <user> --password-stdin` · `chmod 600 ~/.docker/config.json` · 만료+로테이션.
  - **런타임 시크릿 전제** ← Codex judge §7-③: `up --wait` GREEN은 서버 `.env`의 `FLEET_ACCESS_*`·`FLEET_SECRET_KEY` 완비 시에만(resolveBindHost 이중게이트). access env 누락 타임아웃은 "배포 실패"가 아니라 config 갭 — 분리 진단.
  - **갱신**: cron `*/5 * * * * /path/deploy/pull-deploy.sh >> ~/fleet-deploy.log 2>&1`(기본 권장·단순·투명). watchtower는 옵션 1문단.
  - **크로스이미지 일관성 권장** ← Codex judge §7-①: 프로덕션 서버는 `:latest` 추종 대신 **`GHCR_TAG=sha-<N>` 단일 핀**으로 두 이미지 동일 커밋 세트 고정(스큐·`:latest` 회귀 pull 동시 방어). `:latest`는 편의(자동 최신), sha 핀은 안전(재현·롤백).
  - **롤백**: `GHCR_TAG=sha-<이전12>` → pull → up -d --wait.
  - **서버 권장**(미정·YAGNI 옵션 2): 저가 VPS(상시·고정IP) vs 홈서버/미니PC(비용0·전기). 둘 다 아웃바운드 pull 충분.
  - **첫-발행 부트스트랩** ← 공백 judge §7-④: GITHUB_TOKEN이 미존재 private 패키지 최초 생성 시 403 가능 → 첫 push 후 GHCR UI에서 패키지 가시성·레포 링크 1회 확인(안 되면 수동 부트스트랩).
  - **retention 경고** ← 공백 judge §7-①: 매 머지가 immutable `:sha-<12>` 누적 → private 스토리지 증가. 주기적 정리(`gh api -X DELETE …/versions/<id>` 또는 후속 keep-last-N cleanup 워크플로) 필요 명시(T6 후속).
  - **라이브 완료 체크리스트**(§8): 서버 login→private pull / override로 로컬빌드 없이 기동 / cron 자동 pull→recreate / 터널 뒤 fleet·ttyd 정상 / 롤백 실증.
- **검증**: `npm run format:check`(README prettier).

### T5 — `npm run verify` GREEN (최종 1회)

- `npm run verify`(skills:lint[deploy.yml SHA 핀]·brain:check[**무변경 — src 미수정**]·format:check·typecheck·lint·test:coverage[T0 핀]·build) GREEN. `deploy/*.sh`는 prettier 대상 아님 → `bash -n`은 T3에서 개별.
- **경계값**: `| tail -1`로 exit code 가리지 말 것(false-green 교훈). `npm run brain` 불요(src 무변경).

---

## 미결정 결정 (합성 확정)

1. **compose build 무력화 = `build: !reset null`(Compose 2.24+)** — 3 planner 만장일치. vs `--ignore-buildable`(buildable 서비스 pull **스킵** = fleet/ttyd 안 받음 = 정반대·기각) vs `--pull always`(build 잔존·버전별 모호 #9730·기각) vs prefix 변수(정적 단언 약화·기각). `!reset`은 config 출력에서 build 키 제거 → 계약이 아티팩트에 물성화(canary grep 가능). 구버전 compose는 `config` loud-fail = fail-safe.
2. **롤백 태그 = 신규 `GHCR_TAG`(A) — IMAGE_TAG와 분리.** 두 judge 판정: `.env.example:66 IMAGE_TAG=local` 활성 라인 + "복사해 `.env`로" 부트스트랩 → 재사용 시 첫 배포가 `ghcr:local` 404. GHCR_TAG 디커플이 happy-path에서 풋건 소거(B/C의 문서-only 완화보다 우월).
3. **namespace = `${{ github.repository_owner }}`(소문자) + actor-ban 정적 핀(C).** `github.actor`는 dispatch/dependabot 시 봇 오push. 로그인 `-u`는 actor 무방(토큰이 권위).
4. **provenance/서명 = 보류(A 결정②).** 서버 이미지 attest는 `id-token:write`+`attestations:write` 스코프 확대 필요 → "packages:write만" 최소화와 충돌. 단일 사용자·private repo·read-only pull 위협모델에서 이득<리스크. 대체: immutable `:sha` + 서버 sha 핀 + digest 로그 캡처.
5. **GHCR 로그인 = raw `docker login --password-stdin`(A 결정③)** — 서드파티 액션 0(공급망 최소). 유일 `uses:` = checkout.

---

## 계약 명세 표 (C 이식)

| 경계 | 입력 | 출력 | 불변식 | 검증(fail 방향) |
| --- | --- | --- | --- | --- |
| 트리거 | 변경 파일셋 | 실행/스킵 | paths-ignore ⊆ (.dockerignore ∪ {README.md}) | T0#9(미대응=FAIL) |
| GHCR 태그 | github.sha | 4태그 | latest advance ⇒ sha 존재(sha 먼저); ns=owner; 12hex | T0#5·#6·#7 |
| 이미지 이름 | basename | GHCR repo | base==smoke폴백==push target==override(4-way) | T0#8 |
| compose 병합 | base+ghcr,--profile tunnel | merged config | fleet/ttyd build 부재·image=ghcr·fleet 포함 | T2 canary |
| smoke↔발행 | `:local` | push source | 발행 source==smoke 산출 | T0#8 + smoke |
| pull-deploy | .env,2 compose | exit·컨테이너 | pipefail·profile·2×-f·--wait·flock·prune는 up 뒤 | T0 pull-deploy 핀 |
| GHCR_TAG 의미 | 서버 .env | pull 태그 | 서버 unset(→latest)/sha; local 금지 | README/.env.example + 라이브 |
| release.yml 무간섭 | 트리거 | 산출물 | tag(v*)↔branch(master) 배타·Release↔GHCR 배타·group 상이 | 정적 검토 + 관측 |

---

## 검증 전략 (지금 vs 서버-후)

**지금 로컬/CI 실검증**: `npx vitest run scripts/deploy-cd-pin.test.ts`(계약·보안·race 핀) · `npm run skills:lint`(액션 SHA 핀) · `npm run format:check` · `bash -n deploy/pull-deploy.sh` · `docker compose … config -q`(override 병합 = `!reset` 실동작) · `bash deploy/smoke.sh`(13불변식+canary) · **라이브 최상위 산출물**: master 머지/dispatch → Actions 4태그 push + `gh api …/packages/container/…/versions` 확인.

**서버 필요 = 라이브 위임**(§8 · 사일런트 캡 아님·명시): private pull · 로컬빌드 없는 기동 · cron 자동 pull→recreate · 터널 정상 · 롤백 실증.

---

## 공통 결함 반영 (§7 · 두 judge가 세 초안 모두에서 발견)

| # | 결함(judge) | 반영 |
| --- | --- | --- |
| ① | 크로스이미지 일관성(4태그 비원자 push+서버 비원자 pull → server@N+webterminal@N-1 스큐) [Codex] | **GHCR_TAG=sha-<N> 단일 핀 권장**(T4) — A 인프라로 해결. push는 sha 먼저·둘 다(T1) |
| ② | `:latest` 회귀 pull(옛 SHA dispatch가 latest 덮어씀) [Codex] | 서버 sha 핀 권장(T4) · `:sha` immutable 관례 명시 |
| ③ | 갭① 부정확(smoke 머지-후만·Dockerfile 깨는 PR은 CI green 통과) [공백] | README 프레임 정직화 + workflow_run 후속(T4) |
| ④ | up --wait가 런타임 시크릿(FLEET_ACCESS_*·SECRET_KEY)에 의존 [Codex] | README 분리 진단 명시(T4) |
| ⑤ | GHCR retention 부재(무한 스토리지) [공백] | README 경고 + 후속 keep-last-N cleanup 워크플로(T6 후속, MVP 밖) |
| ⑥ | 총빌드 비용 무정량(무캐시 8~15분/머지) [공백] | README에 추정 명시 + `type=gha` 캐시 후속(MVP 밖) |
| ⑦ | 첫-발행 부트스트랩 403 리허설 불가 [공백] | README + 라이브 체크리스트(T4) |
| ⑧ | GHCR_TOKEN 러너 잔존(ephemeral라 저심각) [Codex] | 참고 — 무조치(ephemeral 러너) |

---

## 열린 질문 (구현 중/라이브에서 확정)

1. **GHCR 첫 발행 권한** — GITHUB_TOKEN이 미존재 private 패키지 최초 생성에 성공하나(403 가능)? LABEL로 자동 링크 의도. 첫 머지에서 실측 → 안 되면 1회 수동 부트스트랩(T4 명시).
2. **retention 정책** — keep-last-N cleanup을 후속 워크플로로 언제(스토리지 임계 도달 시). MVP 밖.
3. **workflow_run 승격** — deploy를 CI green 후로 게이트할지(§7-③). 우선 master push 유지(PR CI 선행 전제), 후속 판단.
4. **cron 주기** — `*/5` vs 더 긴 주기. flock으로 겹침 방어(T3). 서버 운영서 확정.

---

## 리스크·롤백

- **발행 오배선**(태그/ns 오타): T0 핀 + 첫 dispatch Actions 로그 즉시 감지 → deploy.yml revert(서버 미영향 — 아직 pull 안 함).
- **smoke false-GREEN**: exit1 게이트 + push 별도 후속 스텝(fail-closed) + canary가 병합 무효 차단.
- **paths allowlist 회귀**(fail-open): T0#3 역필터 핀 RED.
- **namespace actor 오염**: T0#6 ban 핀 RED.
- **서버 pull 실패**(PAT 만료/망): set -e loud + logs → 이전 컨테이너 계속 서빙(무중단).
- **배포 후 회귀**: `GHCR_TAG=sha-<이전>` → pull → up(무재빌드).
- **전역 안전판**: 인프라 전용·코드 계약 ripple 0 → 데스크톱 앱·CI/e2e·smoke 로컬 경로 무회귀(base compose 무변경). 최악도 "발행/갱신 안 됨"이지 라이브 파손 아님(fail-safe).

---

## 파일 변경 요약

| 파일 | 종류 | 요지 |
| --- | --- | --- |
| `scripts/deploy-cd-pin.test.ts` | 신규 | 계약·보안·race 핀 11종(권한·stdin·역필터·순서·actor-ban·SHA regex·4-way·paths매핑·checkout SHA·override) |
| `.github/workflows/deploy.yml` | 신규 | paths-ignore 역필터·concurrency·packages:write·checkout(SHA핀)·raw GHCR login·smoke 게이트·원자 선점검·4태그(sha먼저) |
| `deploy/fleet/Dockerfile` | +1줄 | `LABEL org.opencontainers.image.source` |
| `deploy/webterminal/Dockerfile` | +1줄 | 동일 LABEL |
| `deploy/docker-compose.ghcr.yml` | 신규 | `build: !reset null` + GHCR image(`GHCR_TAG`) override |
| `deploy/.env.example` | 수정 | `GHCR_TAG=latest` 추가 + IMAGE_TAG 용법 주석 |
| `deploy/smoke.sh` | +섹션 | override 병합 canary(`config -q`+image존재·build부재) |
| `deploy/pull-deploy.sh` | 신규 | pipefail·버전가드·flock·pull→up --wait→prune·loud-fail |
| `deploy/README.md` | +절 | 「GHCR CD」: 파이프라인·갭①정직·인증런북·런타임시크릿전제·cron·크로스이미지 sha핀·롤백·부트스트랩·retention·라이브 체크리스트 |
