# #251 Workbench 코어 — 구현 계획 (체크포인트 3)

- **스펙(권위)**: `docs/superpowers/specs/2026-07-23-ade-workbench-spec.md` (Codex 2R Approved + 계획 체크포인트 반영판)
- **설계**: `docs/superpowers/specs/2026-07-22-ade-workbench-design.md` — **스펙 §0.1 정정 계약 12건이 설계 원문에 우선**
- **범위**: #251 코어. UI·bench 채널 = **#253** / 배포·nightly·라이브 = **#254**(둘 다 `blocked-by #251`)
- **표기**: 이 문서의 태스크 = `T0~Tn`. 스펙 계약 테스트는 항상 **`§3-T13`** 처럼 `§3-` 접두(번호 충돌 회피)

## 0. 판사 패널 결과 · 합성 근거

`fleet-planner` ×3(리스크 우선 A / MVP 우선 B / 계약 우선 C) → `fleet-plan-judge` ×2(공백 렌즈 / Codex 강점 렌즈).

| 항목 | 판사 A(공백) | 판사 B(Codex 강점) |
|---|:--:|:--:|
| 초안 A(리스크) | **30** | **30** |
| 초안 B(MVP) | 24 | 25 |
| 초안 C(계약) | **30**(동점) | **31**(합 1위) |
| **승자** | **A** | **A** |

**승자 일치 → 강등 규칙 불요.** 골격 = **A(리스크 우선)**, 2순위 = C. 두 판사가 공통으로 요구한 것:
**A 골격 + C 계약층 전량 이식 + B fail-open 3건 이식**.

승자 근거(두 판사 공통): ①가장 비싼 falsifier(컨테이너 UDS `listen`)를 코드 0줄 시점에 배치 ②"아래 층이
거짓이면 위 층 GREEN 이 무의미"를 **PR 순서 자체로** 표현 ③태스크마다 «어떤 잘못된 구현이 이 RED 에
걸리는가»를 명시(반증력) ④실측 최고 심각도 2건(L-5 충돌 · T58 구현 불가)이 A 산출.

> **방법론 정직성**: 판사에게 넘긴 3개 초안 파일은 메인 루프가 만든 **압축본**이었다(verbatim 아님).
> 그 결과 판사 A 의 R1·R5 감점 일부는 압축 손실 아티팩트다 — "A 가 §3-T10b·T11 매핑 누락"(원본 매핑표에 있음)
> · "A 가 `git.ts:194` 재귀 미언급"(원본 T17 ripple 에 있음) · "세 초안 어디에도 `--no-file-parallelism`
> 없음"(원본 A 에 다수). 실제 A 점수는 더 높았을 것이다. 다만 두 판사의 **실질 산출(공통 결함·스펙 이슈
> 확정)은 초안 텍스트가 아니라 레포·스펙 직접 검증에 근거**하므로 유효하며, 승자도 바뀌지 않는다.

## 1. 전제 (전 태스크 공통)

1. **TDD RED→GREEN.** 태스크마다 대응 `§3-T` 번호 명시. RED 목록이 비면 착수 금지.
2. **RED 는 반증력을 가져야 한다.** 각 위험 태스크에 «이 RED 가 어떤 잘못된 구현을 실제로 붉게 만드는가»를
   적는다. 관찰 불가능 서술·우연 의존 레이스는 계획 단계에서 거부한다.
3. **계약 단언은 전부 `verify` 층**(vitest · PR 필수 게이트). **`nightly(docker)` 는 현재 존재하지 않는
   게이트**이며 #254 범위 — 이 계획은 단 한 행도 nightly 에 의존시키지 않는다.
4. **폐기 API 이름 재유입 금지** — `readFreshSync`·`compareAndSwapSync`·"CAS 구간에 `await` 가 없다".
   살아있는 계약 = `readFresh` · `compareAndSwap(): Promise<CasResult>` · `withAuthority`.
5. **fs mock 금지** — `vi.spyOn(node:fs)` 는 win32 ESM 에서 조용히 skip(false-GREEN · 선례
   `ignored-baseline.test.ts:142-149,244-247`). 실패 주입은 **주입 `DurableFs` 페이크로만**.
6. **PR 상한 = 코드 순증 1,900행**(기준선 평균 1,447·최대 1,918). 초과 시 **사전 선언한 분할점**을 적용한다.
   **측정 시점 = 머지 직전 HEAD**(`git diff --numstat origin/master...HEAD` 의 `src/`+`scripts/`+`deploy/`+`e2e/`
   순증 · 테스트 포함 · `docs/` 제외). 최초 푸시 시점 측정 **금지** — 리뷰 라운드가 코드를 늘린다(정정 74:
   PR1b 는 1,581 로 기록됐으나 머지 트리 실측은 ≈2,430 이었다). 추정은 **「프로덕션 물리행 × 실측 배수
   2.69~3.34」**(정정 51 원안 2.66~3.28 → **정정 92 가 4 PR 전수 재측정해 갱신**) — 「§3 행 개수 × 행당
   비용」 모델은 세 번 연속 빗나갔으므로 쓰지 않는다. ⚠ **상한은 이미 두 번 초과됐다**(PR1b 2,432 ·
   PR1c 1,952) — 「상한 내였다」를 후속 PR 추정 근거로 상속하지 않는다. 착수 전 트리거는 순증이 아니라
   **프로덕션 물리행**(리뷰 라운드가 거의 늘리지 않는 축)으로 환산해 선언한다 = 1,900 ÷ 3.34 ≈ **569**.
7. **커버리지는 함수 수가 아니라 4메트릭 실측으로 관리**(§3.1). PR 마다 4수치를 PR 본문에 기록하고,
   신규 모듈 **자체 statements ≥86%** 를 태스크 완료 조건으로 둔다.
8. **엔진 미배선 불변식(정직 문안)**: PR0 을 제외한 PR1~PR5 는 `engine.ts`·`main/index.ts`·`server/boot.ts`·
   `server/handlers.ts` 를 변경하지 않는다. ⚠ **"프로덕션 경로 0줄"이라고 쓰지 않는다** — `git.ts`·
   `cli/detect.ts`·`mcp/stdio.ts` 는 레거시가 매 실행 통과하며, **주입 미사용 시 현행 동일**이 정확한 표현이다.
9. 커밋 `feat(#251-PRn): …`. **brain 재생성은 전 src 변경 후 최종 1회**(src 먼저 커밋 → brain 재생성 →
   brain 별도 커밋). verify 게이트에 `| tail -1` 금지.

## 2. 선행 실측 (착수 게이트)

계약을 통째로 바꿀 수 있는 사실은 **코드 한 줄 쓰기 전에** 확인한다.

| # | 실측 | 게이트 | 실패 시 |
|---|---|---|---|
| ~~M1~~ | ~~컨테이너 bind 마운트 위 UDS `listen` EACCES~~ — **폐기.** 로컬 검증에서 Docker Desktop 29.6.2 의 3종 마운트 전부 `listen` 성공으로 **재현되지 않았다**(구형 gRPC-FUSE/9p 한정 관측을 일반 사실로 인용했던 것). 추상 소켓 전환으로 애초에 무관 | — | — |
| ~~M1′~~ | ~~추상 소켓 `listen` 컨테이너 가능 여부~~ — **로컬 검증에서 이미 실측 완료**: `node:24-bookworm-slim` · `--user 1000:1000` · 기본 seccomp 에서 `listen('\0fleet.wb.…')` 성공(추가 권한 불요). `/proc/self/ns/net` · `/proc/1/stat` f22 · `boot_id` 전부 비특권 읽기 가능 | — | 완료 |
| **M2** | `safe.directory` × `/workbenches` | **PR4**(registry 생성) | worktree 생성 경로 전부 실패. B6 에서 리뷰 전량 통과 후 라이브에서만 적발된 계열 |
| ⚠ | **Docker Desktop 근사로는 M2·M3 를 대체할 수 없다**(#251 PR2c 실측) | — | PR2c 가 실 `fleet-server` 이미지 + 실 `/workspace` bind mount 위에서 13 단언을 통과시켰으나, 그때 `/workspace` 는 **`owner=0:0 mode=777`** 로 보였다 — **Docker Desktop 이 bind mount 의 uid·권한을 가상화**하기 때문이고 이는 **실 Linux 호스트보다 관대**하다. 실 호스트에서는 호스트 소유권이 그대로 보여 컨테이너 uid 1000 이 못 쓰는 상황이 실재한다(PR1a 실측 「git 이 성공해도 `.git` 소유자가 다르면 `mkdir` EACCES」와 같은 축). **「Docker 에서 통과했다」를 「배포에서 통과한다」로 인용하지 말 것** — PR2a 가 gRPC-FUSE 관측을 일반 사실로 인용했다 정정한 것의 **반대 방향 실수**다 |
| **M3** | named volume ↔ bind 마운트 2볼륨 토폴로지의 `worktree add` admin 파일 | PR4 | benchRoot 토폴로지 재결정. **`tmp/`→`authority/` rename 은 둘 다 `<common gitdir>/fleet/` 안이라 동일 볼륨이 구조적으로 보장** — 스펙 §5 가 둘을 섞어 서술했으나 실제 위험은 worktree admin 쪽뿐 |

**M1·M1′ 은 소멸했다**(위 표) — 락 백엔드가 커널 네임스페이스 endpoint 로 바뀌어 파일시스템 마운트 권한과
무관해졌고, 추상 소켓의 컨테이너 동작은 로컬 검증에서 이미 실측됐다. **남은 착수 게이트는 M2·M3(PR4)뿐**이다.

## 3. PR 분할

| PR | 제목 | 태스크 | 순증 | 분할점(사전 확정) |
|:--:|---|---|---:|---|
| **PR0** | **비가역 표면 선착지** | T0 | ~250 | 없음 |
| **PR1a** | ID · 코디네이션 영역(파일시스템·git 층) | T1·T2 | **실측 1,176** | 없음(상한 내) |
| **PR1b** | 자문 락 코어(커널 endpoint 층) · 서열 | T3·T4·T6 | 810~1,530 | 없음 |
| **PR1c** | 인스턴스 배타 · 배포 계약 집행 | T5 | 570~950 | 없음 |
| ~~**PR2**~~ | ~~계약 사슬 · 내구 쓰기 · 권위 CAS~~ | ~~T6b~T10~~ | ~~1,500~1,850~~ | ~~T9 종료 >1,500 → T10 을 PR2b~~ |
| **PR2a** | 계약 사슬 골격 · 내구 쓰기 seam | T6b·T7 | 1,300~1,600 | 없음 |
| **PR2b** | 권위 CAS 코어(`withAuthority`·`AuthorityTx`) | T8 | 1,500~1,900 | **프로덕션 물리행 >569** → 「불변식 검증기 + §3-T61 전수표」를 PR2b′(정정 92) |
| **PR2c** | rename 재시도 · per-retry L-6 · gated-orphan **분류** · launcher 브랜드 | T9·T10(**배선·순서고정 제외**) | 착지 480~1,050 / **머지 740~1,710** | **T9 종료 시 프로덕션 물리행 >230 → T10 전량을 PR2c′** |
| ~~**PR3**~~ | ~~`GitRepo` · 통합 WAL 저널 · 복구 판정~~ | ~~T11~T13~~ | ~~1,200~1,500~~ | ~~없음~~ |
| **PR3a** | `GitRepo` 완성(열거·프로브 포함 11메서드) · 능력 프로브 · R-5 삭제 없는 재시도 | T11·T12 | **실측 1,143**(프로덕션 272) | 없음(상한 내 · 60%) |
| **PR3b** | 통합 WAL 저널 · 복구 판정 · ref-앵커 · 크래시 tmp 수확기 | T13(+정정 70·78·85 이월분) | 900~1,500 | **journal 프로덕션 물리행 >250 → ref-앵커(§3-T34·T18b)를 PR3c** |
| **PR4** | slug · 레지스트리 · 태스크 경로 seam | T14~T17 | 1,400~1,750 | T16 종료 >1,400 → T17 을 PR4b |
| **PR5** | 통합 트랜잭션 · 완결 관측 · 승인 2-페이즈 | T18~T21 | 1,150~1,450 | 없음 |
| **PR6** | 파생 · 인가 전수 · 크로스 프로세스 | T22~T24 | 1,200~1,500 | 없음 |
| **PR7** | 엔진 배선 · 상한 · 자식 수명 · 마감 | T25~T30 | 1,600~1,900 | T28 종료 >1,450 → T29~T30 을 PR7b |

**총 10 PR**(PR2 3분할 반영 · 스펙 §7 "5~6" 대비 +4~5). **은폐하지 않는다** — 스펙 §5 의 1,900행 상한이 §7 의 PR 수 추정보다
**상위 규범**이고, §3 계약 테스트 74행 중 **66행이 #251 코어 귀속**(UI 3 · nightly 6)이라 UI·deploy 를 떼도
테스트 질량이 거의 줄지 않는다는 실측 때문이다.

> **서버 단일 표면 축소 반영(2026-07-23)**: 토폴로지 게이트·handoff·`locks/<key>.json`·epoch 판정이
> 계약에서 사라져 **PR1·PR2 가 축소**됐다(스펙 1,430→1,251행). PR7 의 win32 분기(npipe 백엔드·
> `file-only` 강등 소비)도 **#251 범위 밖**이 되어 §3.1 의 커버리지 플랫폼 비대칭 압박이 완화된다
> (win32 전용 코드가 분모에만 들어가는 문제의 주 원인이 npipe 백엔드였다).
> ~~**재산정 결과 7 PR** — PR2 를 PR1 로 흡수 가능한지는 착수 시 실측으로 판정한다.~~
> **착수 시 실측 결과는 반대였다**(정정 51): 흡수는커녕 PR2 자체가 3분할을 요구했다 — 형제 모듈 배수 모델로
> 계산한 총량이 상한의 1.3~2배였다. 현재 집계는 위 표(**10 PR**)가 권위다.

### PR0 을 신설한 이유 (판사 A 프레임 전복 채택)

세 초안 전부 `RunActivity.activeRuns`(required additive)를 **"유일한 비가역 표면"** 이라 규정해놓고 그것을
1,900행짜리 배선 PR 에 합장했다. 정답은 반대다 — **유일한 비가역 ripple 이 자기 리뷰·자기 revert 단위를
가져야 한다.** PR0 은 전부 `FLEET_WORKBENCH` 미설정 시 **동작 무변경**이므로 단독 랜딩이 안전하다.

## 4. 태스크

### PR0 — 비가역 표면 선착지 (~250행)

#### T0 — `RunActivity` 확장 · `hasLegacyRun` · benchId fail-closed · 킬스위치
- **대상**: `shared/types.ts` · `engine.ts`(반환만) · `main/index.ts:165` · `server/handlers.ts:125` ·
  `shared/transport/fixtures.ts:58` · `server/boot.ts`(env 파싱) · 테스트 더블 전량.
- **RED**: `hasLegacyRun(a)` 가 **`benchId` 부재 런만** 센다(R-2) · **미지/비활성 benchId 요청 fail-closed
  거부**(P-BENCHID — `main/index.ts:145` 가 `RunProjectRequest` 를 무검증 통과시키므로 이 핀이 "#253 전엔
  도달 불가"를 주장이 아니라 **증명**으로 만든다) · **`FLEET_WORKBENCH` 미설정 = 데스크톱·서버 양쪽 비활성**
  (킬스위치) · 운영자 env 오설정 = throw / 렌더러 값 = clamp(§3-T47 전반).
- **ripple 전수**: `types.ts:545-548`(`ActiveRunRef`·`activeRuns` required) / `engine.ts:787` /
  **`main/index.ts:165` → `hasLegacyRun`** / **`handlers.ts:125` → `hasLegacyRun`** /
  **`boot.ts:298,312` 무변경이 계약**(R-1: bench 포함 전체 집합이 드레인 권위) /
  **`fixtures.ts:58` 수동 등재 — `ChannelFixture.result: unknown` 이라 tsc 무신호** /
  `engine.test.ts:630,652,657,683,688` 정확일치 5건 / `boot-drain.test.ts:36-37` / `boot.test.ts:640` /
  `ProjectPanel.test.tsx` 목 12곳(타입 스윕) / **`ProjectPanel.tsx` 동작 스코프화는 #253**(P-BENCHID 가 봉쇄).
- **완료**: `npm run verify` GREEN · `FLEET_WORKBENCH` 미설정에서 기존 e2e 무회귀.

#### T0 실측 정정 (PR0 착수 중 발견 — 계획 원문 대비)

착수 전 ripple 전수 감사(5렌즈 fan-out + 독립 검증)와 구현 후 자체 적대 리뷰(5렌즈 · 29건 refute
검증)가 낸 정정이다. **PR1 이하가 같은 함정을 반복하지 않도록 여기 고정한다.**

| # | 계획 원문 | 실측 |
|---|---|---|
| ① | ripple 표에 `engine.ts:653` 단일 런 가드 **부재** | 그 가드가 `activeRuns` 를 공유하므로 R-1(bench 를 activeRuns 에 넣음)과 **정면 충돌**한다. bench 런 1건이 레거시 런까지 전부 거부한다. PR0 은 P-BENCHID 가 봉쇄해 무해 — **PR7 T25 가 반드시 스코프화**해야 한다 |
| ② | «미지 식별자 → fail-closed» 를 자명 전제로 둠 | 엔진에 **동형 선례가 fail-soft** 로 이미 있다(`probeCli` unknown adapter → `{status:'error'}`). 비대칭이므로 근거를 코드 주석에 명시했다 — 근거 없이 두면 계약 렌즈 리뷰가 「일관성 위반」으로 되짚는다 |
| ③ | env 관용구 2종(fail-fast throw / clamp) | 실제 **5종**이 공존하며, 열거형인데 throw 하지 않는 것도 있다(`resolveE2eRunner` — 미지값 fail-safe). 「열거형=throw」는 레포 합의가 아니라 2:1 이다. 실 분기 기준 = **운영자 env(throw) vs 테스트/모드 env(조용한 fail-safe)** |
| ④ | env 테스트를 리터럴 키로 작성 | `NodeJS.ProcessEnv` 인덱스 시그니처 때문에 **키 오타가 컴파일된다** — `{FLEET_WORKBECH:'1'}` 도 통과해 「미설정=비활성」 단언이 vacuous GREEN. env 이름을 **exported const 로 두고 테스트가 그 상수만 참조**해야 닫힌다 |
| ⑤ | `ProjectPanel.test.tsx` 목 **12곳** | 실측 **13곳**이고 그중 4곳은 목이 아니라 **인라인 구조 타입**(`{activeProjectIds: string[]}`)이라 타입 스윕 대상이 아니다. 인라인 타입은 `RunActivity` 를 참조하지 않아 갱신 누락 시 tsc·vitest 양쪽 무신호 |
| ⑥ | 소스 텍스트 스캔 테스트를 신설 | 형제 선례(`ipc-parity`·`bridge-parity`)의 **방어 2종을 반드시 이식**해야 한다: ⓐ`stripComments`(없으면 주석 한 줄로 false-GREEN/false-RED) ⓑ「호출 부위 수 == 매칭 수」(없으면 다른 술어를 쓰는 **3번째 호출부**가 무신호). 단일 파일 스캔은 간접 모듈 우회를 통과시키므로 **표면 전 소스 트리**를 훑는다 |
| ⑦ | 순수 resolver 단위 테스트로 충분 | **호출부 삭제가 전 게이트 무신호**다(실측). `bootServer` 통합 fail-fast 단언(선례 `resolveSandboxBoundary fail-fast`)을 함께 둬야 한다 |
| ⑧ | R-1 은 서버·데스크톱 공통 계약처럼 서술 | **웹 전용**이다. 데스크톱은 `will-quit` 이 곧장 `engine.dispose()` + 3s 하드 타이머로 끝내 드레인이 **아예 없다**(`waitForRunDrain` 호출부는 `boot.ts` 하나뿐). 데스크톱 Workbench(#255)는 R-1 을 자동 상속하지 않는다 |

**PR1 이월(PR0 범위 밖으로 확정)**:
- `FLEET_WORKBENCH` 를 `deploy/docker-compose.yml` environment allowlist + `.env.example` + README 에
  등재(현재 미등재 — compose 는 명시 allowlist라 컨테이너에 전달되지 않는다). 소비자가 생기는 PR1 에서
  등재하고, `scripts/deploy-sandbox-boundary-pin.test.ts` 동형의 **값 라인 exact 핀**을 함께 둔다.
- e2e 스폰 env 가 `...process.env` 로 호스트 셸을 상속한다(`e2e/web-server.ts` 외 5곳) — 개발자·CI 에
  `FLEET_WORKBENCH=1` 이 export 돼 있으면 「미설정 무회귀」 스위트가 실제로는 활성 상태를 검증한다.
  킬스위치가 무언가를 게이팅하기 시작하는 PR1 에서 스폰 env 를 **명시 오버라이드**한다.

### PR1 — 락 프리미티브 · 코디네이션 영역

가장 미검증인 층. (M1 은 소멸 — §2)

#### PR1 착수 전 실측 정정 (2026-07-25 · 5렌즈 ripple 감사 + 직접 재현)

PR0 이 확립한 「착수 전 ripple 전수 감사」를 PR1 에도 적용했다. 5렌즈 find 는 완주했고 **verify(refuter)
5기는 세션 한도로 전량 실패**했으므로, **하중을 받는 주장은 메인 루프가 직접 재현**했다(재현 명령·출력은
PR 본문에 인용). 아래는 재현까지 끝난 정정이다.

| # | 계획/스펙 원문 | 실측 | 조치 |
|---|---|---|---|
| ① | §1-8 「PR1~PR5 는 `server/boot.ts` 를 변경하지 않는다」 ∧ T5 「제거를 `shutdown()` 자원 정리에 편입」 | `shutdown()` 은 **`boot.ts` 안의 클로저**이고 `RunningServer` 에 정리 훅이 없다 → 두 문장이 **구조적으로 양립 불가** | **PR1 은 모듈 전용**으로 확정 — T5 는 `acquire/release` + 주입 seam 까지만 착지하고 **boot 배선은 PR7(엔진 배선)로 이월**한다. §3-T8c ⓓ(정상 종료 시 제거)는 모듈 층에서 `release()` 계약으로 검증한다. §1-8 무변 |
| ② | T4 의 유일한 RED = §3-T10b | §3 표 84행 전수 대조에서 **T10b 행 부재**(축소 때 T9 와 함께 삭제) → §1 전제 1 「RED 목록이 비면 착수 금지」에 걸림 | T10b 를 **이 계획에 행으로 신설**(아래 T4 문안). §3.1:1115 의 T9·T10b 참조는 stale |
| ③ | PR1 = T1~T5(§3 분할표) vs T1~T6(이슈 코멘트) · **T6 번호가 두 태스크에 중복** | 실재 충돌(PR1 락 서열 / PR2 계약 사슬) | **PR1 = T1~T6**(락 서열이 T6). PR2 의 「계약 사슬 골격」은 **T6b** 로 개명(T7~T30 시프트 회피) |
| ④ | PR1 순증 1,300~1,650 · 분할점 「T4 종료 >1,300 → T5 를 PR1b」 | 형제 모듈 실측 기반 추정 2,100~3,800 → **분할점이 상한을 회복시키지 못한다**(T5 만 떼도 1,530~2,850) | **3분할 사전 확정** — **PR1a = T1+T2**(파일시스템·git 층 · 실측 순증 1,176) · **PR1b = T3+T4+T6**(커널 endpoint 층) · **PR1c = T5**(인스턴스 배타 + 배포 계약). 경계 근거 = 두 층이 서로 다른 실패 모드·다른 실행 환경(win32 가용 ↔ Linux 전용)을 갖는다 |
| ⑤ | §3 「축소로 커버리지 플랫폼 비대칭이 **완화**된다」 | 반대다 — npipe 를 범위 밖으로 빼면 win32 에는 백엔드가 아예 없어 T3·T4·T6 프로덕션 행이 **로컬 분모에만** 들어간다(로컬 verify RED · CI GREEN) | §3.1 「필수 대응 택1」을 **ⓐ로 확정**: 락 백엔드를 `LockBackend` 주입 seam 뒤에 두고 **계약 테스트는 페이크로 양 OS**, 실 추상 소켓 어댑터만 `skipIf(platform!=='linux')`. 실 어댑터를 얇게 유지하는 것이 완료 조건 |
| ⑥ | §W-2 트리의 `locks/<key>.json`·`owner/<key>.json` | §W-3 은 `locks/` 를 명시 폐기했고 `owner/` 는 **어느 문서도 판정하지 않았다**. 남기면 L-6 「디스크 I/O 0」·§3-T10 「락 소유 권위 레코드 부재」와 충돌 | T2 가 만드는 것을 **영역 루트 + `area.json` 뿐**으로 확정하고 「`locks/`·`owner/` 미생성」을 **디렉터리 전수 단언**으로 고정(구현 완료 — 변이 주입 RED 확인) |
| ⑦ | 「경로 예산(108B) preflight 는 소멸했다」 | **존속한다** — 추상 소켓도 `sun_path` 를 쓰고 초과는 무성 절단이 아니라 **EINVAL**. 실측: 총 108 OK / 109 EINVAL(선행 NUL 포함) | 예산을 **성질 변경**으로 재기술(무성 충돌 → 하드 실패)하고, 이름 상한을 `endpointDigest` 길이(32 hex)로부터 컴파일 타임에 유도. `'fleet.wb.'(9)+digest(32)+'.'(1)+key(≤26)` = 최대 68 ≤ 107 |
| ⑧ | §3-T7·T8 이 「`wx`/mkdir/pid 구현이면 반드시 RED」 | **영역 밖 pathname UDS + unlink-before-bind** 구현은 둘 다 통과한다 — 두 단언은 「endpoint 가 커널 네임스페이스에 있음」을 강제하지 못한다 | T3 에 **양성 단언** 필수: ⓐ`server.address()` 가 코드포인트 0 으로 시작 ⓑLinux 한정 `/proc/net/unix` 에 `@<name>` 정확히 1행(둘 다 컨테이너 실측 확인) ⓒ영역 스냅숏 diff 를 「소켓 파일 0개」가 아니라 **파일 0개 증가**로 |
| ⑨ | 「PR1 선행 실측 0(M2·M3 는 PR4)」 | **PR1 에서 이미 도달 가능한 실패 2종**을 컨테이너에서 재현: ⓐ`safe.directory` 는 **정확 경로 일치**라 `/workspace` 등재가 하위 레포 `/workspace/proj-a` 를 커버하지 않아 `dubious ownership` ⓑgit 이 성공해도 `.git` 소유자가 다르면 `mkdir .git/fleet` = **EACCES**(=「git 성공 ⇒ 영역 생성 가능」이 거짓) | `AreaOpenResult` 에 **`repo-unsafe-ownership`·`io-failure` 분기 신설**(조용한 폴백 금지 · 고칠 대상이 서로 달라 사유를 구분). 배포측 `safe.directory` 커버리지는 **#254 로 이관** |
| ⑩ | `listWorktrees()` 는 worktree 경로를 답한다(자명 전제) | separate-git-dir·서브모듈에서 **메인 엔트리 경로가 워크트리가 아니라 gitdir** 이다(실 git 재현) · bare 엔트리엔 `HEAD`/`branch` 행이 아예 없다 | `WorktreeEntry` 에 그 사실을 **특성화 테스트로 고정**하고 「메인 엔트리 경로를 워크트리 경로로 신뢰하지 말 것」을 계약 주석에 명시(교정하려면 형태별 추가 git 호출이 필요한데 PR1 소비자가 없다) |
| ⑪ | PR0 이월 「`.env.example`·README 등재」 | 루트에 `.env.example` **부재** · 루트 README 에 `FLEET_` **0건** | 대상 = `deploy/.env.example` · `deploy/README.md` · `deploy/docker-compose.yml`. **PR1c 로 이월**(킬스위치 소비자가 그때 생긴다) |
| ⑫ | PR0 이월 「e2e 스폰 env 6곳」 | 실측 **7지점/6파일**이고, 킬스위치를 오염시킬 수 있는 것은 `e2e/web-server.ts` **2곳뿐**(나머지 5곳은 Electron e2e = 데스크톱에 소비자 구조적 부재) | **PR1c 에서 web-server 2곳만** 명시 오버라이드. Electron 5곳은 §3-T8f 와 중복 방어이므로 변경하지 않는다 |
| ⑬ | §5-2 증거 「`git.test.ts` **13개** 호출 무수정」 | 실측 **22개** | §5-2 정정(아래 반영). PR1a 가 실제로 건드리는 §5 항목 = **1(추가만)·12** |

**추가 관측(구현 중)**: 「realpath 정준화 제거」 변이가 **전 게이트 무신호**였다(win32 에서 symlink 행이
skip 되므로). 이식 가능한 falsifier(「git 이 말한 common gitdir 이 실재하지 않으면 `io-failure` · 없는
경로에 영역을 만들지 않는다」)를 추가해 닫았다 — PR0 이 확정한 「선언한 회귀를 실제로 못 잡는 테스트」
계열의 재발이다.

#### PR1b 착수 전 실측 정정 (2026-07-25 · 6렌즈 감사 + Docker 실 Linux 실측)

PR0·PR1a 가 확립한 「착수 전 ripple 전수 감사」를 PR1b(T3·T4·T6)에 적용했다. 6렌즈 find → 렌즈별 독립
refuter(**60 CONFIRMED · 19 PARTIAL · 0 REFUTED**), 그리고 **하중 프리미티브는 메인 루프가 Docker
컨테이너에서 직접 실측**했다(계획 §2 가 「doc-only」로 남긴 것을 measured 로 승격 — 실측 출력은 PR 본문 인용).

**실측 확정 사실(추상 유닉스 소켓 · `--user 1000:1000` · 기본 seccomp)**

| 사실 | Node 22.22.3(**필수 게이트**) | Node 24.18(프로덕션) |
|---|---|---|
| `listen({path:'\0name'})` | 성공 · `listening=true` | 동일 |
| 같은 이름 재bind | `EADDRINUSE` · `setImmediate` 턴 **0** | 동일 |
| 이름 총 107·108B | 성공 | 성공 |
| **이름 총 109B** | **성공(107B 로 무성 절단)** | **EINVAL** |
| **앞 107B 공유 109B 두 이름** | **EADDRINUSE = 무성 충돌** | (도달 불가 · EINVAL) |
| `close()` 직후 | `listening` 즉시 false · 콜백 미대기 재획득 성공 | 동일 |
| 커넥션 1개 유입 후 `close(cb)` | **cb 미발화(대기)** | 동일 |
| `unref()` 후 | 배타성 유지(EADDRINUSE) | 동일 |
| SIGKILL 소유자 | 즉시 재획득(턴 0) · 파일시스템 조작 무영향 | 동일 |
| `/proc/net/unix` | `@<name>` 정확 1행 | 동일 |
| `address()` | **입력 문자열과 동일 · `close()` 후에도 유지** | 동일 |
| win32 | `listen('\0x')` = **EINVAL**(조용한 성공 없음) | — |

| # | 계획/스펙 원문 | 실측 | 조치 |
|---|---|---|---|
| ⑭ | 정정 ⑦·§W-2 「초과는 EINVAL · 108 OK / 109 EINVAL」 | **런타임 메이저마다 다르다.** 필수 게이트(`.nvmrc`=22.22.3)에서 109B 는 **성공 + 107B 절단**이고, 앞 107B 를 공유하는 서로 다른 두 키는 **EADDRINUSE 로 충돌**한다(무성 이름 붕괴 — 스펙의 경로 예산 preflight 가 애초에 막으려던 바로 그 성질) | 예산 가드를 **우리 preflight 단독**으로 확정(libuv 위임 금지). 경계 테이블은 **순수 함수**로만 검증(양 OS·양 메이저 동일) — 실 소켓으로 109B 를 단언하면 **필수 게이트 RED / advisory GREEN**. 단위는 문자가 아니라 **`Buffer.byteLength`**(한글 36자=108B 실측) · 상한 상수 = 선행 NUL 포함 **108** |
| ⑮ | 정정 ⑧ 양성 단언 ⓐ 「`server.address()` 코드포인트 0 시작」 | `address()` 는 `_pipeName`(=`listen` 인자) **에코**이며 `close()` 후에도 그대로 남는다(양 메이저 실측 + `lib/net.js` 소스: Pipe 프로토타입에 `getsockname` 미등록) → **커널 증거가 아니다**. 보유·생존 판정에 쓰면 false-GREEN | ⓐ를 **이름 유도 순수 함수 반환값**의 단언으로 강등(양 OS) · 커널 양성 증거는 ⓑ(`/proc/net/unix` 정확 1행 · Linux 게이트) **단독** 귀속 · 「`address()` 가 판정 경로에 등장하지 않음」을 소스 스캔으로 핀 |
| ⑯ | 계획 T3 「L-2 조작화: `setImmediate` 턴 0 이 블로킹 재시도를 RED 로 만드는 **유일한** 형태」 | bind 결과는 `process.nextTick` 경유다(`setupListenHandle`). **nextTick 큐는 check 페이즈보다 먼저 드레인**되므로 nextTick·마이크로태스크 재시도 루프는 턴 0 을 **그대로 통과**한다 → 「유일한 형태」는 거짓 | **3중 조작화**: ①페이크 백엔드 **bind 시도 카운트 == 1**(주 falsifier) ②fake timers 下 `vi.getTimerCount()===0` ③턴 카운터 0(보조). ①②③을 한 `it` 에 합치지 않는다(fake timers 가 `setImmediate` 를 페이크) |
| ⑰ | 스펙 §W-2 「108바이트 초과면 **throw**」 · Node 문서 「will throw」 | 실제 경로는 throw 가 아니라 **`'error'` 이벤트**(`handle.bind()` 수치 반환 → `nextTick(emitErrorNT)`) | 예산 위반은 **우리 preflight 의 fail-closed 반환**(`unavailable`)으로 확정 · `toThrow()` 형 단언 금지 · 어댑터는 `once('error')`·`once('listening')` 을 **`listen()` 호출 전 동기 부착**(unhandled 'error' = 프로세스 크래시) |
| ⑱ | 계획 T4 「판정에 디스크 I/O 0 — 주입 `DurableFs`/fs 계층 호출 카운트 0」 | `DurableFs` 는 **PR2 T7 범위로 PR1b 에 존재하지 않는다**. 유일 대안 `vi.spyOn(node:fs)` 는 §1-5 금지 ∧ win32 에서 조용히 무동작(=spy 미동작 → 카운터 0 → **정의상 false-GREEN**) | 2층 재조작화: ⓐ**구조 단언** — 락 모듈이 `node:fs`·`node:fs/promises` 를 **0회 import**(스캔 + 앵커) ⓑ**행동 단언** — 페이크 백엔드 `calls[]` 로 판정 경로의 백엔드 조회 외 호출 0 + 같은 describe 에 ≥1회 호출 형제 행. `DurableFs` 참조는 T4 문안에서 **삭제**(PR2 이월) |
| ⑲ | 계획 T4 「`server.listening===false` 판정 · 양성 통제」 | 그 2종 방어는 「`listening` 을 읽는 구현」과 「자체 `released` 불리언을 읽는 구현」을 **구분하지 못한다**(둘 다 디스크 0 · 둘 다 양성 통제 통과) → T4 가 잡겠다고 선언한 결함이 실제로 안 잡힌다 | **out-of-band 무효화 행 신설**: `release()` 를 거치지 않고 밑단 endpoint 만 무효화(페이크 `forceLose`) 후 변이 시도 → `{kind:'lost',reason:'stolen'}`. 내부 플래그 구현은 **이 행에서만** RED |
| ⑳ | 계획 T4 「`lease-lost` fail-closed」 | `lease-lost` 는 스펙 **어떤 타입에도 없다**(산문 §W-3:278 1곳). 채택 API = `LeaseCheck = {kind:'owned'} \| {kind:'lost'; reason:'released'\|'stolen'}`(spec:346) · 소비 측 어휘는 `lease-invalid`(PR2) | 반환 타입은 **`LeaseCheck` 단일** · `lease-lost` 문자열 제거 · 실 어댑터는 `'released'` **만** 산출하고 `'stolen'` 은 **페이크 전용 경로**(PR2 T17c 가 재사용)임을 인터페이스 주석에 명시 |
| ㉑ | 계획 T6 「역순은 **tsc 가 막고** `@ts-expect-error` 로 핀한다」 | **루트 재민팅 한 줄로 완전 무력화**된다(실측: slot 보유 중 `withRepoLock(rootCtx())` = tsc 에러 0). 콜백 인자를 무시하고 루트를 새로 만들면 서열이 타입상 합법. 게다가 `as never`·`as unknown as`·`Parameters<>`·`keyof` **4종 우회 전부 tsc·현행 eslint 통과** | **3층 분리**: ①**런타임 서열 가드가 1차 방어** — `AsyncLocalStorage`(모듈 전역 변수는 **불가** — §W-12 가 동시 bench 2 이상을 강제하므로 허위 위반을 던진다)로 현재 레벨 추적 · 역순 = `lock-order-violation` ②루트 민팅 진입점 단일 + 호출부 **exact 핀** ③타입 핀은 「스레딩 사고 방지」로 재분류. 브랜드는 **미export `unique symbol` 필수**(문자열 프로퍼티 브랜드는 `{__level:0}` 리터럴로 위조 가능 — 실측) · 위조 핀 3종 등재 |
| ㉒ | 계획 T6 「`@ts-expect-error` 로 핀」 | `ban-ts-comment` 가 **error** 이고 **설명 ≥3자 필수**(레포 선례 정확히 1건) · 판정자는 vitest 가 아니라 `npm run typecheck`(테스트 파일이 프로그램에 포함됨 — 확인) | 모든 핀에 설명 문구 필수 · 「타입 핀의 유일 강제자는 typecheck」를 주석에 명시 |
| ㉓ | 스펙 §3-T11 「역순 경로 부재(구조 단언) **+ 데드락 부재**」 | 계획 T6 이 **「데드락 부재」 절을 탈락**시켰고, 「구조 단언」을 `@ts-expect-error` 로만 해석했다(모듈 내부 역순 호출·raw 프리미티브 실수 export 는 무신호) | 3행 추가: ⓐ락 모듈 **export 집합 exact 동치**(raw bind 미노출 — §0 「git export 정확히 8개」 선례) ⓑraw 프리미티브 이름 전 소스 스캔(stripComments + 앵커) ⓒ**데드락 부재 관측형** = 페이크로 3키 전부 held → 합성이 턴 0 에 `held` 반환·hang 없음 |
| ㉔ | 계획 T3 §3-T7 인용 | 스펙 원문의 **두 번째 절**(«파일시스템 어디를 지워도 보유 중인 락이 영향받지 않음»)이 탈락. 「파일 0개 증가」는 *쓰기* 를, 빠진 절은 *읽기 의존* 을 잡는다 — 영역 파일 존재를 부수 조건으로 보는 구현은 다른 단언 전부를 통과 | Linux 게이트 행 추가: 락 보유 중 `rm -rf <area>/*` → ⓐ2차 획득 여전히 `held` ⓑ보유 핸들 `revalidate()` 여전히 `owned` ⓒ`release()` 후 재획득 성공(실측 확인) |
| ㉕ | 계획 T3 「회수 뮤텍스·`connect` 프로브 전부 소멸」 | 방향은 옳으나 **§3-T60①·§0.1 C2 가 `connect`/ECONNREFUSED 를 여전히 요구**한다(§0.1 은 「설계에 우선」인 최상위 정정 표이고 폐기 표시가 없다) | 「§3-T60①·§0.1 C2 의 `connect`/ECONNREFUSED 문안은 §W-3 축소로 폐기 · 권위는 §W-3」을 명시하고 **PR 본문 「스펙 정정」절에 등재**(리뷰어가 §0.1 을 권위로 읽어 P1 을 되짚는 것을 선차단) |
| ㉖ | 계획 T3·T6 결정론 문안 | 2건 stale: 전역 `testTimeout: 20_000` 이 **PR1a 에 이미 랜딩**(「기본 5s / 각 it ≥15s」는 **하향**) · vitest 4.1.10 은 `--no-file-parallelism`·`fileParallelism`·projects 글롭을 **가진다**(「수단이 없다」는 반증 · 단 `poolOptions` 는 v4 에서 제거) | 명시 timeout 신설 금지(전역 20s 승계) · 병렬 제어는 **불요**로 확정 — 추상 이름공간은 net ns **전역**이라 파일 순차화가 아니라 **테스트별 이름 무작위화**가 올바른 격리 수단(§3.2 의 「mkdtemp 격리」는 pathname 시절 유물) |
| ㉗ | 계획 T6 「자식 스크립트는 `__testing__/` 에 두고 `coverage.exclude` 에 등재」 | 레포에 **`fork(` 0건 · vitest 안에서 자식 스크립트 파일을 띄우는 선례 0건** — 유일 관용구는 **`node -e` 인라인**(13곳). `.ts` 자식은 실행 자체가 불가(`allowImportingTsExtensions` 미설정 · `type` 필드 부재) | 자식은 **`node -e` 인라인**(§3-T8 문면 자신과 일치)으로 확정 → 자식용 `coverage.exclude` 등재는 **불요**. 단 **페이크 백엔드는 두 테스트 파일이 공유**하므로 `__testing__/*.ts`(import 전용 · 실행 안 함)로 두고 `coverage.exclude` + config 객체 핀은 **그 목적으로** 존속 |
| ㉘ | 계획 T6 「파일 배리어」 | 선례 0 · PR1a 는 경합 테스트에서 「실 동시성 대신 주입 시계」로 **정반대** 결정을 명문화했다 | 1순위 = **결정론 핸드셰이크**(자식 보유 → 부모 `held` 단언 → 자식 해제 → 부모 획득). 이것만으로도 in-process Map 구현은 RED = §3-T22 존재 이유 충족. 배리어 XOR 행은 **자기검사(자식이 실제로 배리어에 갇혔음을 관측) 먼저 GREEN** 후에만 추가(§6 R6 패턴 이식) |
| ㉙ | 계획 §1-7 「신규 모듈 자체 statements ≥86%」 · §3.1 「구속 메트릭은 statements」 | win32 로컬 실측 = **S 93.51%(3532/3777) · B 86.68% · F 94.30%(613/650) · L 95.12%** → 완전 미커버 추가 예산은 **functions 가 구속**(≤31개). 그리고 **PR1a 가 이미 win32 에서 84.94% 로 미달**(미커버 14행 중 10행은 win32 도달 불가 · 4행은 플랫폼 무관 오류 경로) · `vitest.config.ts:23` 주석 baseline 은 pre-PR1a stale | 완료 조건을 **절대 개수**로 재기술: 실 어댑터 ≤140물리행 ∧ 미커버 stmts ≤40 ∧ 미커버 funcs ≤10 · 「≥86%」의 **측정 권위는 ubuntu(CI)** 이고 플랫폼 게이트 파일은 win32 수치에서 명시 제외 · PR 본문에 **분자/분모 절대값** 기록 |
| ㉚ | 계획 「Linux 전용 행은 로컬 skip」 | ⓐ`it` 본문 조기 `return` 형 게이트는 skip 이 아니라 **PASSED 로 집계**(레포 7건 선례) ⓑ `coverage.thresholds` 를 단언하는 테스트가 **0건** → floor 하향이 완전 무신호(동형 config 핀 선례는 4건 존재) ⓒ레포에 **로컬 Linux 검증 절차 부재** · win32 `node_modules` 마운트는 vitest 기동 자체를 막는다(실측) | ⓐ`describe.skipIf` 만 사용 + 조기 `return` 금지를 스캔으로 강제(워크벤치 한정) ⓑ`scripts/vitest-config-pin.test.ts` 신설(커버리지 비용 0) ⓒ**레포 복사 + `npm ci`** 방식 컨테이너 하니스로 Linux 게이트 행을 실제 실행(검증 완료 — 절차를 PR 본문에 기록) |
| ㉛ | 「이 플랫폼에서 가용한 백엔드」 판정자 | 계획·스펙 **어디에도 문장이 없다**. PR1a 는 `supportedBackends` 를 호출자 주입으로 남겼고 프로덕션 호출부는 0건 | **PR1b 에 순수 판정 함수만** 착지 — `availableLockBackends(platform)`(`ownerMismatch` 선례와 동형 「판정만 떼어 양 OS 검증」) · 호출부는 **PR7**(§1-8 무변) |
| ㉜ | 계획 T6 L-5a 부칙(「`r` 보유 중 bench 리스 대기 금지」) | L-2 가 성립하는 한 프리미티브 층에 「대기」 상태가 없어 **관측 대상이 없다**(항진) — L-5a 는 **합성 층** 제약(재시도 루프를 `r` 임계구역 밖에 둠)이고 PR1b 엔 그 합성 소비자가 없다 | T6 에서 L-5a 를 **명시 미착지**로 선언하고 **PR5 T21 단독 귀속**으로 이월(계획:326 과 중복 제거). 「부칙」 모호 표기 제거 |
| ㉝ | 위협 모델(§W-2-a) | 추상 네임스페이스엔 **파일 권한이 없다** — 같은 net ns 의 비특권 프로세스(Fleet 이 spawn 한 CLI 자식 = 같은 컨테이너)가 endpoint 를 선점하면 「형제 엔진 보유」와 **구분 정보가 0**(`locks/`·`owner/` 폐기 · L-1 이 다른 근거 금지) → 조용한 영구 기능 정지. 또 임의 프로세스가 connect 할 수 있고 수락된 소켓이 이벤트 루프를 ref 한다 | ⓐ어댑터에 `connection` → **즉시 `socket.destroy()`**(핸들 누수 차단) ⓑ「같은 net ns 스쿼팅은 `held` 와 구분 불가」를 **명시 비목표로 코드 주석 + PR 본문에 등재**(은폐 금지). ttyd 는 **별개 net ns**(compose `fleet-net` bridge)라 현재 범위 밖 — 향후 `network_mode: host` 전환은 이 성질을 깨므로 전망 항목으로 기록 |
| ㉞ | 계획 T3 「`release()` 정준 링크 순서 소멸」 | 남은 하중 하나: `close()` 는 fd 를 **동기 해제**하지만 `'close'` **콜백은 커넥션이 남아 있으면 발화하지 않는다**(실측: 커넥션 1개 → 150ms 내 미발화) → `release()` 가 콜백을 await 하면 **영구 대기**(C3 드레인이 상한까지 끌려간다) | 「`release()` 는 `server.close()` 를 호출하고 `'close'` 를 **기다리지 않는다**」를 계약으로 명문화(스캔 핀) + 2행: ⓐrelease 직후 **같은 이름 즉시 재획득**(타이머 0) ⓑ커넥션 유입 중에도 release 즉시 해소 |
| ㉟ | 계획 §3 「T10b」 · §3-T62 | T10b 부재는 정정 ②가 이미 신설로 해소. 잔여: §3-T62 의 **「benchRoot env fail-fast」 분이 계획 전체에서 미귀속**(어떤 태스크도 RED 를 만들지 않는다) · `AreaRecord` 에 슬롯 개수·durability 필드 부재 | 전자는 **PR4/PR7(레지스트리·상한) 귀속**으로 등재 · 후자는 T6 이 **슬롯 개수를 어디서도 읽지 않는다**(개수는 호출자 주입)로 경계를 닫고, `AreaRecord` 확장과 「필드 부재 v1 레코드 관용 vs fail-closed」 결정을 **PR7/T29 사전 결정 항목**으로 이월 |

| ㊱ | `vitest.config.ts` 의 `coverage.all: true` 와 그 주석(「import 되지 않은 파일도 분모에」) | **vitest 4 가 `all` 을 제거했다** — `CoverageOptions` 에 필드가 없어 tsc 에러다(핀 테스트가 config 를 typecheck 프로그램에 끌어들여 발각). 즉 v4 업그레이드 이후 이 옵션은 **죽은 no-op** 이었다. 분모 완전성은 실제로 `include` 가 담당한다(실측: 아무 테스트도 import 하지 않는 코어 파일이 0% 로 보고서에 등장) | 죽은 옵션을 제거하고 주석을 v4 실제 기제로 정정 · `include` **exact 핀**이 분모 축소를 막는 유일 수단이므로 핀 테스트를 그 축으로 재작성(원래 계획했던 `all` 단언은 **죽은 옵션을 핀하는 것**이었다 — 그대로 랜딩했으면 「보호받고 있다」는 거짓 확신을 심었다) |

**PR1b 확정 범위**(위 정정 반영): 신설 = `locks.ts`(프리미티브: 이름 유도·예산 preflight·`LockBackend`
seam·실 추상 소켓 어댑터·핸들·`LeaseCheck`·`availableLockBackends`) · `lock-order.ts`(서열 합성 ·
phantom 레벨 · ALS 런타임 가드) · `__testing__/lock-backend-fake.ts`(페이크 · import 전용) ·
테스트 3파일 · `scripts/vitest-config-pin.test.ts` · eslint 신규 블록(`no-unsafe-type-assertion` 옵트인 —
**신규 2파일 한정**. 워크벤치 전체로 넓히면 PR1a 코드 5건이 즉시 RED 라 무관한 수정을 끌고 온다).
**미착지 명시**: L-5a 합성(→PR5 T21) · 슬롯 구현(→PR7 T29 · PR1b 는 키 문법 + 타입 시그니처만) ·
boot 배선(→PR7) · `DurableFs` 카운터 층(→PR2).

#### PR1c 착수 전 실측 정정 (2026-07-26 · 6렌즈 감사 + Docker 실 Linux 실측)

PR0·PR1a·PR1b 가 확립한 「착수 전 ripple 전수 감사」를 PR1c(T5)에 적용했다. 6렌즈 find → 렌즈별 독립
refuter(**28 CONFIRMED · 29 PARTIAL · 1 REFUTED**), 하중 프리미티브는 메인 루프가 Docker 컨테이너와
실 compose 로 직접 재측정했다.

**실측 확정 사실**

| 측정 | 결과 |
|---|---|
| `link(src, name)` — 기존 이름 / dangling symlink / live symlink / FIFO / 디렉터리 | **전부 `EEXIST`**(Linux) = 순수 create-only |
| `open(dangling symlink,'wx')` | `EEXIST` · **링크 대상은 생성되지 않음**(그러나 `readFileSync`·`writeFileSync` 는 링크를 추종) |
| `unlink(열린 파일)` | POSIX `OK` / **win32 도 `OK`**(→ win32 실패 주입 경로 없음) · `unlink` under 0500 부모 = `EACCES` |
| `/proc/1/stat` `statSync().size` | **0**(길이 힌트 기반 읽기는 빈 문자열) · comm = `docker run` 시 `MainThread` · compose(`init:true`)는 `docker-init` |
| `/proc/self/ns/pid` ino (비특권 uid 1000) | 읽힘 · **동시 두 컨테이너 = 4026532386 vs 4026532686(다름)** · `docker restart` 전후 = **동일**(ino 재사용)이나 f22 는 276512→277800 전진 |
| compose `container_name` + `up --dry-run -d --scale fleet=2`(`--profile tunnel`) | **EXIT 1** · `WARNING: … Remove the custom name to scale the service` |
| 같은 명령 `--scale fleet=1` / `container_name` 제거 후 `--scale fleet=2` | **EXIT 0 / EXIT 0** (양성·음성 통제 성립) |
| `up --dry-run` 부작용 | **네트워크·볼륨·컨테이너 생성 0건**(실측 확인) · `-f -`(stdin override) 지원 |
| `config` 출력의 `container_name` | base·GHCR 병합 **양쪽 모두** fleet 블록 안 4-space 들여쓰기(기존 awk 앵커와 정합) |

| # | 계획/스펙 원문 | 실측 | 조치 |
|---|---|---|---|
| ㊲ | §W-2-b ⓐⓑ 「커널 endpoint probe 로 생존 확인」 | **probe 대상 키가 어느 문서에도 없다.** 착지한 `LockKeySpec` 3종(`repo`·`bench`·`slot`)은 전부 변이 구간에만 잡히는 **일시 보유** 락이라 liveness 비콘이 될 수 없다 — `'r'` 로 대용하면 **락을 안 쥔 idle 인스턴스가 「사망」으로 오판**돼 회수(fail-open). 게다가 `LockScope.tryAcquire` 로 probe 하면 `locks-structure.test.ts:200` 의 raw 호출자 exact 핀이 즉시 RED | **인스턴스 endpoint 를 1급 계약으로 신설** — `LockKeySpec` 에 `{kind:'instance'}`(키 `'i'`) · `INSTANCE_LOCK_KEY` export(핀 9→10 갱신) · 인스턴스 모듈은 `LockScope` 를 쓰지 않고 **주입 `LockBackend.bind` 를 직접** 호출(서열 레벨 밖 = `lock-order` 합성 대상 아님을 주석 근거로 명시) · **`.bind(` 호출자 exact 핀 신설**(현재 무핀 — 두 번째 호출자가 무신호로 생긴다) |
| ㊳ | 스펙 §W-2-b ①「부팅 시 `open('wx')` 로 점유」(bind 시점 문장 없음) | **순서가 미판정**이고, `wx`-먼저 구현은 승자가 bind 하기 전 창에서 패자 probe 가 성공해 **같은 컨테이너 안에서 이중 인스턴스**가 성립한다 | **`bind` 먼저 → 성공 시에만 파일 점유**로 확정. 그 결과 스펙 4분기가 재사상된다: ⓐ`bind`=in-use → `instance-active`(**파일 미접촉** = 승인 조건 ① 충족). ⚠ 마커 **유도**는 그보다 앞선다 — 부수효과가 0(읽기뿐)이고, 유도 불가한 표면은 경합 여부와 무관하게 참여할 수 없어 `marker-unavailable` 이 더 정확한 진단이기 때문이다. ㊳이 구속하는 순서는 「bind 가 **파일 접근**보다 앞선다」다 / ⓑ bind 성공 + 마커 일치 → 회수(**커널 증명**) / ⓒ bind 성공 + 마커 불일치 → 회수(**배포 전제 의존** — 증거 등급을 값으로 구분해 기록) / ⓓ 해제. T8b 의 「패자 `listen()` 0」은 **「락 키(`r`·bench·slot) bind 0건 ∧ 인스턴스 키 bind 정확히 1건」** 으로 조작화(스펙 문면 정정 등재). **모든 `blocked` 경로에서 잡은 endpoint 를 반드시 close** 하는 것도 계약(누수 시 다음 부팅이 자기 자신을 「생존」으로 오판) |
| ㊴ | 스펙 §W-2-b 「`open('wx')` 점유」·「파일을 자기 신원으로 교체」 | ⓐ`wx` 는 **바이트 이전에 이름을 노출**해 크래시 시 「존재하는 빈 파일」이 남고, 그것이 「자동 삭제 금지」에 걸려 **크래시 1회 = 운영자 개입 없이 복구 불가**(고착이 소멸한 게 아니라 위치를 옮긴 것) ⓑ**회수는 create-only 가 아니다** — 두 회수자가 둘 다 성공 | 발행·회수 **둘 다 tmp+`link`**(coord-area.ts:304-348 형제 선례 · 실측상 `link` 는 모든 기존 이름에 EEXIST). 회수 = 종류 검증 → `unlink` → tmp+`link`, **여기서 EEXIST = 회수 경합 패배 → `instance-active`**(fail-closed · 재시도 상한 1). T8b RED 2행: ⓐ빈 상태 동시 ⓑ**잔재 상태에서 두 회수자 동시 → 정확히 하나**. T8b 문면은 `'wx'` 리터럴이 아니라 **create-only 경합 결과**로 재기술(내구성 fsync 는 PR2 `DurableFs` 소유임을 병기) |
| ㊵ | 회수 「4분기」 열거 | `open('wx')` 는 symlink·FIFO·디렉터리를 **EEXIST 하나로만** 답해 구분 정보를 주지 않는다. FIFO 면 `readFileSync` 가 **무기한 블록**(부팅 정지), symlink 면 **영역 밖 JSON 이 권위**가 되고 회수 쓰기가 영역 밖 파일을 덮어쓴다 | **5분기**로 고친다 — ⓔ`EEXIST` ∧ (비정규 파일 \| 판독 실패 \| JSON 파싱 실패 \| 마커 형태 위반) → **자동 삭제 금지 → `reconciliation-required`**(detail 에 고칠 대상 경로 필수). 구현은 `isLinkSync`=`'regular'` 선검사(coord-area.ts:181-186 이식)로 한 분기에 흡수. RED 3행(symlink·FIFO·디렉터리)은 POSIX 게이트(win32 는 symlink 생성이 EPERM — 실측) |
| ㊶ | 계획 「`sha256(bootId:pid1StartTicks)` 가 인스턴스마다 달라진다」 · 스펙 「마커 일치 = 같은 PID ns」 | **단사가 아니다** — f22 는 USER_HZ(10ms) 해상도라 동시 기동한 두 컨테이너가 같은 마커를 갖는다(감사 8기 병렬에서 2쌍 충돌). 즉 스펙 문면이 거짓 | 마커 = **`sha256(bootId : pid1StartTicks : pidNsIno : netNsIno)` 4성분**(실측: 동시 두 컨테이너 ns ino 상이 · restart 는 ino 재사용이지만 f22 전진 → 두 축이 서로의 사각을 덮는다). **네 번째 성분은 Codex PR#262 P1 반영** — 배타는 net ns 스코프인데 앞 3성분이 전부 PID ns·부팅 축이라 「PID ns 공유 + net ns 분리」에서 세 값이 **전부 같아**(실측: pidns 4026532386 동일·PID1 공유라 f22 동일) 침입자가 살아있는 소유자를 `kernel-proven` 으로 회수한다 → net ns ino(실측 4026532388 vs 4026532687)로 그 구성만 정직하게 강등. 스펙 §0.1 C8 문면 정정을 PR 본문에 등재. 계약 테스트는 **「두 인스턴스는 서로 다른 마커」를 불변식으로 단언하지 않는다**(부하 중 flaky) |
| ㊷ | 계획 T5 에 주입 seam·페이크·커버리지 대응 **0줄** | 마커 성분은 Linux 전용이므로 seam 없이 짜면 §3-T8c 4분기가 win32 로컬에서 전량 skip 되고 프로덕션 행이 **분모에만** 들어간다(정정 ⑤가 T3·T4·T6 에만 적용됐다). 또 마커를 페이크로만 검증하면 **상수 마커·필드 오프셋 오류·구분자 누락이 4분기 전부를 GREEN 통과** | 정정 ⑤의 대응 ⓐ를 T5 에 승계: `InstanceMarkerSource` **필수 주입** · 실 `/proc` 리더는 얇은 별도 파일 + `describe.skipIf(platform!=='linux')` · 판정은 페이크로 양 OS. **추가로 「산출 동치」 행 필수** — Linux 게이트 아래에서 **테스트가 `/proc` 를 독립 재계산**해 모듈 산출값과 `toBe`(상수 마커를 RED 로 만드는 유일한 형태) |
| ㊸ | 「`/proc/1/stat` f22」 · 「`/proc` 읽기」 | ⓐ`/proc` 파일은 `statSync().size===0` → 길이 힌트 기반 읽기가 **빈 문자열** → sha256 상수 축퇴 ⓑcomm 의 괄호·공백 때문에 naive split 은 조용히 틀린 값을 주는데, **프로덕션 PID1 은 `docker-init`(공백 없음)이라 실 컨테이너로만 검증하면 naive 도 통과**(vacuous 양성 통제) ⓒwin32 에서 `/proc/x` 는 `C:\proc\x` 로 해석돼 파일-존재 기반 플랫폼 가드는 위조 가능 | 읽기는 `readFileSync(path,'utf8')` 단독 · 파싱은 **`lastIndexOf(')')` 기준 + `rest.length>=50`** · 형태 검증(boot_id = 36자 UUID 문법 · ticks = 양의 정수) 위반은 throw 아닌 **`unavailable`**(fail-closed). **적대적 comm 픽스처**(`1 (ev) (il) S …`)가 파서 테스트의 유일한 양성 통제. 플랫폼 게이트는 `process.platform!=='linux'`(locks.ts:147 대칭) — `existsSync('/proc')` 금지를 구조 스캔으로 핀 |
| ㊹ | 계획 「§3-T8c ⓓ 는 모듈 층 `release()` 계약으로 검증」(단언 내용 공란) · 형제 선례 `release(): void` | 그대로 복사하면 **제거 실패가 조용히 삼켜져** 승인 조건 ⑤가 산문으로만 랜딩한다. 또 「무조건 unlink」 구현이 통과해 **회수당한 뒤 남의 살아있는 레코드를 지운다** | `release(): ReleaseOutcome` 판별 유니온 3종(`removed` / `removal-failed` / **`not-owned`**). RED 3행 — 특히 **not-owned 행 필수**(acquire → 테스트가 파일을 다른 신원으로 교체 → release → 파일 존속 ∧ 내용 불변 ∧ `not-owned` 보고). 실패 주입은 **POSIX 0500 부모**(실측 EACCES) + errno→결과 **순수 분류자**로 양 OS 검증(win32 는 열린 파일 unlink 도 성공해 실 조건 주입 경로가 없다 — 실측). 조건 ⑤의 **호출부 책임(종료 경로가 위장하지 않음)은 PR7 이월**로 명시 강등 |
| ㊺ | §3-T8c 「`held` 잔재로 영구 고착되는 경로가 존재하지 않음」 | **실존 부정형이라 조작화 불가** — 산문 그대로 착지하면 어떤 구현도 통과한다(§1-2 가 요구하는 반증력이 이 행에만 비어 있다) | **온디스크 상태표 `it.each`** 로 관측형 재작성: 7종(부재 / 유효+endpoint busy / 유효+free+마커일치 / 유효+free+마커불일치 / JSON 손상 / 빈 파일 / 비정규 파일) × ⓐ결과가 3종 중 **정확히 하나** ⓑ`instance-active` 를 제외한 상태에서 **재시도가 진행 가능**(고착 fixpoint 부재) ⓒ**표 길이 == 분기 개수 exact** 앵커. 추가로 「영원히 in-use」 페이크에서 **턴 0 에 hang 없이** `blocked` + 운영자 조치가 담긴 detail 반환 |
| ㊻ | L-1 재유입 가드·fs import 금지·`address()` 금지 구조 단언 | 전부 **하드코딩 `LOCK_SOURCES` 3파일**에만 걸려 있어 신규 모듈은 방어 밖이다. 레코드가 `acquiredAt` 을 들고 있어 「오래됐으면 회수」 한 줄이 **전 게이트를 통과**한다(디렉터리 전수로 넓혀도 현행 5패턴에 매칭 0 — 감사 실측) | `LOCK_SOURCES` 를 넓히지 않는다(coord-area 가 즉시 RED). 대신 **회수 판정을 순수 함수로 분리**하고 그 **본문 슬라이스**에 `acquiredAt`·`Date.now`·`mtime`·`pid` 0건 + 앵커를 단언(`endpointFor`↔`nameBudget` 배선 핀 동형). `acquiredAt` 은 **기록 전용 진단 필드**임을 계약 주석에 명시 |
| ㊼ | 계획 「compose `container_name` **값 라인 exact 핀**」(선례 `deploy-sandbox-boundary-pin.test.ts`) | **서비스 스코프가 없다** — 키를 `ttyd:` 블록으로 오배치하면 평문 regex 는 GREEN 인데 `--scale fleet=2` 가 EXIT 0 이 된다(실측). 부분문자열 `/fleet-server/` 는 `image:` 값 때문에 **변경 전부터 GREEN**. GHCR override 에 `container_name: !reset null` 을 넣으면 병합 config 에서 키가 사라지는데 base 텍스트 핀은 GREEN 유지(실측) | 핀 = **fleet 서비스 블록 스코프**(`^  fleet:` ~ 다음 `^  \w`) 안에서 값까지 exact + **파일 전체 출현 정확 1개** + **블록 추출 canary** + **ttyd 블록 음성 단언** + `docker-compose.ghcr.yml` 에 `container_name` **0건**. 이름은 **보간 없는 리터럴**로 고정해 compose·smoke base·smoke override·pin **4-way 문자열 일치**(선례 `deploy-cd-pin.test.ts:109-110`) |
| ㊽ | §3-T8e 「`--scale fleet=2` 행동 테스트 = nightly(docker)」 · 계획 §1-3 「nightly 는 존재하지 않는 게이트」 | **위임처가 레포에 없다**(유일 cron = e2e.yml electron 전용). 그런데 `up --dry-run` 은 **부작용 0·초 단위**로 3-way 판정이 가능하다(실측 표 참조) — 즉 미룰 이유가 사라졌다. 또 「exit≠0」 단독 단언은 `--profile tunnel` 누락만으로도 EXIT 1 이라 **vacuous** 이고, 거부 메시지는 `error` 가 아니라 `WARNING:` 접두다 | T8e 를 **`deploy/smoke.sh` §12 에 3-way 로 편입**: `--profile tunnel` 필수 · ⓐ`--scale fleet=2` EXIT≠0 ⓑ`--scale fleet=1` EXIT 0(양성 통제) ⓒ`-f -` stdin override 로 `container_name: !reset null` 주입 시 `--scale fleet=2` EXIT 0(음성 통제 = 거부가 **그 키에 귀속**됨을 증명). 판정은 **exit code**, 메시지는 보조. smoke 는 `set -euo pipefail` 이므로 **새 변수 캡처를 만들지 않고** 실패 기대 명령은 `if …; then bad; else ok; fi` 형만 쓴다(캡처 관용구 위반 시 FAIL 라인도 요약도 없이 조용히 abort — 실측). scripts 핀은 「smoke 에 블록이 존재」에 더해 **그 grep 패턴 리터럴이 compose 텍스트에 실제 매치됨**을 교차 단언(패턴 오타가 PR 게이트에서 무신호) |
| ㊾ | PR0 이월 「`FLEET_WORKBENCH` compose·`.env.example`·README 등재」 · 이월 ⑫ 「e2e 스폰 env 오버라이드」 | ⓐbare `${FLEET_WORKBENCH}` 는 매 compose 호출마다 stderr 경고(형제 관용구는 전부 기본값 표기) ⓑ`e2e/web-server.ts:22,95` 는 `...extraEnv` 가 **최후 우선순위**라 오버라이드를 spread **뒤**에 넣으면 향후 `extraEnv:{…:'1'}` opt-in 이 영구 무력화 ⓒ e2e 는 vitest include 밖이라 오버라이드 삭제가 **전 게이트 무신호** | `FLEET_WORKBENCH: ${FLEET_WORKBENCH:-0}` + `.env.example` 값 라인 + `/^FLEET_WORKBENCH=0\s*$/m` exact 핀. 「컨테이너는 항상 명시 `'0'` 을 주므로 resolver 의 **미설정 분기는 데스크톱·테스트 전용**」을 주석에 남겨 사문화 오인 삭제를 막는다. e2e 오버라이드는 `FLEET_DATA_DIR` 옆(= spread **앞**) + 위치가 계약임을 주석 · 핀은 **「명시 오버라이드 수 == `...process.env` 스프레드 수(2)」** + 키 문자열이 `boot.ts` 상수값과 일치함을 **텍스트 교차 단언**(e2e 는 `src/` 를 0건 import — boot.ts import 는 Playwright 하니스에 서버 전 그래프를 적재하므로 금지) |
| ㊿ | 계획 T5 「신규 `core/workbench/**` 는 env 이름을 **주석에도** 담을 수 없다」 · 「§3-T8f 는 PR0 에서 이미 GREEN」 | ⓐ**거짓** — PR0 스캔은 `stripComments` 를 매칭 **앞**에 적용한다(주석은 통과 · 실측). 반대로 스캔 walk 가 `__testing__` 을 제외하지 않아 **테스트 헬퍼도 같은 제약**인데 계획에 미기재 ⓑT8f 가 검증하는 것은 env 이름 2개뿐이라, `main/index.ts` 가 신설 workbench 모듈을 import·호출하는 변이가 **GREEN** 이다(스펙이 요구한 「초기화 진입점 구조적 부재」 미검증) | 문면을 「**코드(식별자·문자열 리터럴)** 에 담을 수 없다 — 주석은 허용(PR7 이월 근거를 주석에 남긴다) · `__testing__` 하위도 동일 제약」으로 정정. T8f 는 **`main/index.ts` 기준 정적 import 그래프 전이 폐포에 `core/workbench/**` 0건** 단언으로 승격(텍스트 스캔보다 우회가 어렵다). 부수: 반환 어휘는 `AreaDisabledReason` 에 **생산자 없는 멤버를 추가하지 않고**(exhaustive 소비자 0 = 무신호) 별도 판별 유니온 · eslint 캐스트는 **site 별 인라인 disable + 한국어 사유**(`eslint.config.mjs` 워크벤치 블록은 exact 핀 3개가 지키므로 손대지 않는다) · ADR 은 **0013** 소비(계획 §PR3 의 예약 번호는 랜딩 순서 원칙상 다음 번호로 밀린다) |

**PR1c 확정 범위**(위 정정 반영): 신설 = `active-instance.ts`(bind-먼저 점유 · 5분기 · 순수 판정 ·
`ReleaseOutcome`) · `instance-marker.ts`(성분 파싱·형태 검증·마커 합성 — 순수 · 양 OS) ·
`instance-marker-proc.ts`(실 `/proc` 리더 · Linux · 얇게) · 계약/구조 테스트 · `scripts` 핀 ·
`locks.ts` 에 `{kind:'instance'}`+`INSTANCE_LOCK_KEY`(export 핀 9→10) · compose·smoke·`.env.example`·
README·ADR-0013 · `e2e/web-server.ts` 2곳.
**미착지 명시**: boot 배선(부팅 시 acquire · `shutdown()` 에서 release · 조건 ⑤의 호출부 위장 금지) = **PR7** ·
내구 fsync(`DurableFs`) = **PR2** · `--scale` 행동의 PR-게이트 실행(smoke 는 머지 후 deploy.yml) = **#254**.
**분할점 사전 선언**(정정 ㉜ 계열 재발 방지): 산정 기준 = `git diff --numstat` 의 `src/`+`scripts/`+`deploy/`+`e2e/`
순증(테스트 포함 · `docs/` 제외). 모듈 층(신규 3파일 + 계약/구조 테스트) 종료 시점에 순증 **>1,500** 이면
README·ADR·e2e 핀을 **PR1c′** 로 분리한다(상한 1,900 · §1-6).

> **분할점 발동(2026-07-26 · 실측)**: 자체 적대 리뷰 반영까지 마친 시점의 순증이 **2,175**(모듈 층만
> **1,854**)로 상한을 넘었다. 선언한 분할(README·ADR·e2e 핀만 분리)은 **상한을 회복시키지 못한다**
> (≈2,089) — PR1a 정정 ④와 같은 계열이다. 따라서 **배포 계약 집행 전체를 PR1c′ 로 재분할**한다:
> **PR1c = 모듈 층**(`src/` 1,854 + docs) · **PR1c′ = 배포 계약 + 이월분**(`deploy/`·`scripts/` 핀·
> `e2e/` = 321). 경계 근거 = 두 덩어리는 **의존이 없고**(모듈은 deploy 를 읽지 않는다) 리뷰 단위가 다르며,
> 두 층 모두 이 시점에 **소비자 0**(부팅 미배선)이라 사이 구간의 런타임 노출이 없다.
> ⚠ 그 사이 「단일 인스턴스」는 **운영 규칙으로만** 지켜진다 — ADR-0013 「감수하는 비용 ⓓ」에 명시.

- **T1 ULID** — §3-T1(문법·**단사**: 검증 통과한 두 id 가 win32 case-fold 후에도 같은 경로로 정규화되지 않음).
  경계값: 25/26/27자 · 소문자 · `I/L/O/U` · `..` · `/` · 제어문자 · 전각. **거부(정규화 금지)**.
- **T2 코디네이션 영역 + `GitRepo` 도입 2메서드**(`commonGitDir`·`listWorktrees`) — §3-T5(실 git 5형태) ·
  §3-T6(`--path-format=absolute` 부재 시 상대 `.git` 오판 회귀 — **`process.cwd()` 기준으로 해소하는 구현이
  RED**. `resolve(root,…)` 는 5형태 전부에서 정답이므로 그 자체는 falsifier 가 아니다 — 실측) ·
  §3-T54(git 위생 7명령 후 전량 생존) · §3-T56(L-4 재정의 = **전방호환 미지값 거부**).
  실패는 `AreaOpenResult` 로 계약화하고 **`repo-unsafe-ownership`·`io-failure` 를 포함**한다(정정 ⑨).
  ⚠ **소켓 디렉터리(`s/`)를 만들지 않는다** — 락 endpoint 는 커널 네임스페이스에 있다(축소 반영).
  ⚠ **만드는 것 = 영역 루트 + `area.json` 뿐**(정정 ⑥ — `locks/`·`owner/` 미생성을 전수 단언으로 고정).
  ⚠ 경로 예산은 **소멸이 아니라 성질 변경**(정정 ⑦) — T3 의 이름 유도로 이월.
  ⚠ 정준화는 **`realpathSync.native` 단일 함수**만 쓴다(git 원문·`samePath` 재사용 금지 — 후자는 소문자화까지
  하므로 저장용 정준값이 아니다). `listWorktrees()` 의 메인 엔트리 경로는 **신뢰 대상이 아니다**(정정 ⑩).
- **T3 자문 락 코어(축소판)** — §3-T8(순수 JS `node -e` 자식 SIGKILL 후 **즉시 재획득** — `wx`/mkdir/pid
  구현이면 **반드시 RED**) · §3-T10(회수 = **커널 배타성 단독** · 연령·pid·승인 미사용을 주입 계층 스파이로 ·
  **락 소유 권위 레코드 부재** 구조 단언) · §3-T10d(`key==='r'` 이중 소유 불가 — A 보유 중 B 는 EADDRINUSE ·
  **A 가 살아있는 동안 어떤 파일시스템 조작으로도 B 가 획득 못 함**) · §3-T7(영역에 소켓 파일 **0개**) ·
  **T62 의 L-2 분**(논블로킹 · 미지 errno → `unavailable`).
  ⚠ **회수 뮤텍스·`connect` 프로브·ino 재검증·`release()` 정준 링크 순서·L-7 은 전부 소멸**했다 —
  이것들이 1~3R 실패의 산물이었고, 커널 네임스페이스 endpoint 로 바꾸면서 근거 계약이 사라졌다.
  **§3-T60 은 축소로 stale**(①이 폐기된 `connect` 프로브의 존재를 요구) → 재작성해 여기 귀속한다:
  «생존 판정의 유일 근거가 `listen` 결과이며 연령·mtime·pid·`connect`·파일 존재를 **어떤 경로에서도**
  읽지 않음(주입 계층 호출 0 + 양성 통제)».
  ⚠ **커버리지 대응 ⓐ 확정**(정정 ⑤) — `LockBackend` 주입 seam · 계약 테스트는 **페이크로 양 OS** ·
  실 추상 소켓 어댑터만 `describe.skipIf(process.platform !== 'linux')`. 실 어댑터를 **얇게** 유지한다.
  ⚠ **양성 단언**(정정 ⑧ → **⑮로 재정정**): ~~`server.address()` 코드포인트 0 시작~~ — `address()` 는
  `listen()` 인자의 에코이며 `close()` 후에도 남아 **커널 증거가 아니다**(실측). 살아있는 양성 단언 =
  Linux 한정 `/proc/net/unix` 의 `@<name>` 정확히 1행 · 영역 스냅숏 **파일 0개 증가** · **영역 전삭제 후에도
  보유·판정·해제 불변**(§3-T7 둘째 절 · 정정 ㉔). 이름 코드포인트 0 은 **순수 함수 반환값**으로 강등해 양 OS 검증.
  ⚠ **이름 예산**(정정 ⑦ → **⑭로 보강**): `'fleet.wb.' + digest(32 hex) + '.' + key` ≤ 107(선행 NUL 포함
  총 ≤108). ~~초과는 EINVAL~~ — **런타임 메이저마다 다르다**: Node 24 는 EINVAL 이지만 **필수 게이트
  런타임(Node 22.22.3)은 성공 + 107B 무성 절단 → 서로 다른 키가 EADDRINUSE 충돌**(실측). 따라서 경계
  테이블은 **순수 함수(`nameBudget`)로만** 검증하고 실 소켓으로 109B 를 단언하지 않는다(필수 게이트 RED).
  단위는 문자 수가 아니라 `Buffer.byteLength`.
  ⚠ **L-2 조작화**(→ **⑯으로 정정**): ~~턴 카운터 0 이 유일한 형태~~ — bind 결과가 `process.nextTick`
  경유라 nextTick·마이크로태스크 재시도 루프는 턴 0 을 **그대로 통과**한다. 채택 형태 = **3중**
  (①페이크 bind 시도 카운트 == 1 = 주 falsifier ②fake timers 下 `getTimerCount()===0` ③턴 0 = 보조) +
  **실 어댑터 턴 0 행 별도**(페이크 전용 조작화는 실물 성질을 증명하지 않는다).
  ⚠ **결정론**(§3.2 위임 이행 · → **㉖으로 정정**): ~~각 `it` 에 명시 timeout ≥15s(기본 5s)~~ — PR1a 가
  전역 `testTimeout: 20_000` 을 이미 랜딩했으므로 15s 는 **하향**이다. ~~vitest 4 는 병렬 제어 수단이 없다~~
  — `--no-file-parallelism`·`fileParallelism` 이 실재한다(다만 **불요**: 추상 이름공간이 net ns 전역이라
  올바른 격리 수단은 파일 순차화가 아니라 **테스트별 이름 무작위화**다).
- **T4 L-6 보유자 재검증(축소판)** — **§3-T10b 는 §3 표에 부재하므로(정정 ②) 여기서 행을 신설한다**:
  «해제된(또는 소유권을 잃은) 리스 핸들로 변이를 시도하면 fail-closed» — 단 **정정 ⑱·⑲·⑳ 적용**:
  ⓐ반환 어휘는 `LeaseCheck`(spec:346) **단일**(~~`lease-lost`~~ 는 스펙 타입에 없다) ⓑ「디스크 I/O 0」은
  ~~주입 `DurableFs` 카운터~~(PR2 소유라 PR1b 에 없다)가 아니라 **구조 단언**(락 모듈이 `node:fs` 를 정적·
  동적 어느 형태로도 import 하지 않음) + **행동 단언**(페이크 호출 계측 + 양성 통제) 2층 ⓒ**out-of-band
  무효화 행 필수** — `release()` 를 거치지 않고 밑단 endpoint 만 무효화(`forceLose`)했을 때 `stolen` 이어야
  「자체 released 불리언」 구현이 RED 가 된다(그 행이 없으면 T4 가 선언한 결함을 실제로 못 잡는다).
  추상 소켓에서 소유자 생존 중 endpoint 상실이 불가능하므로 이는 **in-process 오사용(해제 후 계속 변이)
  방어**이며 cross-process 방어는 커널이 담당한다.
- **T5 인스턴스 배타 · 배포 계약 집행(서버 단일 표면 축소판 · §W-2-b)** — `open(<area>/active-instance.json,
  'wx')` 점유 · 잔재 회수 4분기(마커 일치+EADDRINUSE=대기 / 마커 일치+listen 성공=회수 / **마커 불일치=회수** /
  정상 종료 시 제거) · `deploy/docker-compose.yml` 의 `fleet` 서비스에 **`container_name` 고정** +
  `deploy/smoke.sh` 에 **그 키 존재 단언**.
  ⚠ **PR1c 는 모듈 전용**(정정 ①) — boot 배선(부팅 시 acquire · `shutdown()` 에서 release)은 **PR7 로 이월**해
  §1-8 불변식을 지킨다. §3-T8c ⓓ 는 모듈 층 `release()` 계약으로 검증한다.
  ⚠ **verify 층 핀 필수**(감사 L4-3) — `deploy/smoke.sh` 는 **PR 게이트에서 한 번도 실행되지 않는다**
  (유일 실행처 = 머지 후 `deploy.yml`). 따라서 `scripts/*.test.ts` 가 ⓐcompose `container_name` **값 라인
  exact 핀** ⓑ`smoke.sh` 에 그 검사 블록이 **실재함**을 함께 핀한다(선례 `deploy-sandbox-boundary-pin.test.ts`).
  smoke 단언은 **base 블록 + GHCR override 블록 2곳**(선례 `stop_grace_period` 대칭 · 프로덕션 pull 경로가
  override 병합이라 base 만 두면 무신호).
  ⚠ 마커 성분은 컨테이너 실측 확인됨 — `boot_id` 는 3회 재기동 내내 **동일**(호스트 값)이고 `/proc/1/stat`
  f22 만 변한다 → `sha256(bootId:pid1StartTicks)` 가 인스턴스마다 달라진다.
  ⚠ §3-T8f 는 **PR0 에서 이미 GREEN**(정정: RED 로 선언하지 않는다). 대신 **구현 제약**으로 승계 —
  PR0 스캔이 `src/main/**` 을 재귀 순회하므로 신설 `core/workbench/**` 는 킬스위치 env 이름·resolver 이름을
  **주석에도** 담을 수 없다(코어는 env 를 읽지 않고 해소된 값만 주입받는다는 레포 규율과 같은 방향).
  RED: §3-T8b(배리어 동시 `wx` → 정확히 한쪽 · 패자는 `listen()` 0 · git/WAL 0) · §3-T8c(회수 4분기 +
  **`held` 잔재로 영구 고착되는 경로 부재** 단언 + **마커 손상 시 자동 삭제 금지 → reconciliation**) ·
  §3-T8d(배포 계약이 **문면이 아니라 파일로** 집행됨) · §3-T8f(**Electron 이 `FLEET_WORKBENCH=1` 만으로
  우회 활성화되지 않음** — 서버 전용 범위의 구현·문서·킬스위치 3면 일관).
  **§3-T8e(`docker compose --scale fleet=2` 가 실제로 거부되는 행동 테스트)는 nightly(docker)** — 키 존재
  단언만 두면 compose 버전 변화로 거부가 사라져도 무신호다(Codex 승인 조건 ④).
  정상 종료 시 `active-instance.json` 제거를 **C3 `shutdown()` 자원 정리에 편입**하고, 제거 실패를
  **성공 종료로 위장하지 않는다**(조건 ⑤).
  ⚠ 이 태스크가 §W-16 ②(마커 종료 증거)의 **안전 전제를 만든다** — `wx` 가 동시 기동을 배제해야
  "마커가 다른데 둘 다 살아있다"가 성립하지 않고, 그래야 마커 판정이 fail-open 이 아니게 된다.
  ⚠ **`locks/<key>.json` 을 만들지 않는다**(§W-3 축소 — epoch·state·netNsId 판정 전량 삭제).
- **T6 락 서열 · 실 fork 배타** — §3-T11(서열 `r → <benchId> → slot` · 역순 경로 부재 구조 단언 ·
  **L-5a 부칙**: `r` 보유 중 bench 리스 **대기 금지**) ·
  ⚠ **「함수 합성으로만」은 과잉 제약**(감사 L4-5) — bench 리스를 `r` 없이 획득하는 것은 스펙 자신의 정상
  상태라 중첩 합성은 정상 경로를 타입 에러로 만든다. 채택 형태 = **미export 브랜드 phantom 레벨(단조 증가)
  + raw 프리미티브 모듈 비공개**: `withRepoLock(ctx: Held<0>)` / `withBenchLease(ctx: Held<0|1>)` /
  `trySlot(ctx: Held<0|1|2>)`. ~~역순은 tsc 가 막는다~~ → **정정 ㉑**: 타입은 **스레딩 사고만** 막는다
  (루트 재민팅 한 줄로 무력화됨을 실측). 1차 방어 = **`AsyncLocalStorage` 런타임 가드**, 2차 = 구조 단언
  (**raw 획득 호출자 exact 핀** · 브랜드 캐스트 개수 핀 · export 집합), 3차 = `@ts-expect-error` 핀
  (설명 ≥3자 필수 · 판정자는 `typecheck`). 브랜드는 **미export `unique symbol` 필수**(문자열 프로퍼티
  브랜드는 리터럴로 위조 가능 — 실측).
  ⚠ **실 fork 결정론 부품**(레포 선례 0건 — 감사 L4-7): 배리어 = `open(...,'wx')` 원자성만 쓰는 파일 배리어 ·
  자식 준비 신호 = stdout 토큰 핸드셰이크(`e2e/web-server.ts` 선례) · 각 `it` 명시 timeout ≥15s ·
  자식 스크립트는 `__testing__/` 에 두고 `vitest.config.ts` `coverage.exclude` 에 등재(+ config 객체 단언 핀 ·
  `all:true` + `include: src/main/core/**` 라 임포트 없이도 분모에 들어간다).
  §3-T22(실 `fork` 2 프로세스 + 파일 배리어 — **in-process Map 뮤텍스로는 통과 불가**함이 존재 이유) ·
  §3-T10(회수 = 커널 배타성 단독 · **락 소유 권위 레코드 부재** 구조 단언).

### PR2 — 계약 사슬 · 내구 쓰기 · 권위 CAS

#### PR2 착수 전 실측 정정 (2026-07-27 · 6렌즈 감사 + 3면 런타임 실측)

PR0~PR1c′ 가 확립한 「착수 전 ripple 전수 감사」를 PR2 에 적용했다. 6렌즈 find → 렌즈별 독립
refuter(**88 후보 · 56 CONFIRMED · 30 PARTIAL · 2 REFUTED**), 그리고 **하중 프리미티브는 메인 루프가
3면에서 직접 실측**했다 — win32 로컬(Node 24.16.0) · Docker `node:22.22.3`(필수 CI 게이트 런타임) ·
`node:24-bookworm-slim --user 1000:1000`(프로덕션 근사). 동일 스크립트를 세 면에 태웠다.

**실측 확정 사실 — `DurableFs` 프리미티브는 플랫폼별로 정확히 반대다**

| 측정 | win32 24.16.0 | linux 22.22.3 | linux 24.18.0 |
|---|---|---|---|
| `openSync(dir,'r')` → `fsyncSync` | OK → **EPERM** | OK → **OK** | OK → **OK** |
| `openSync(dir,'r+')` → `fsyncSync` | **OK → OK** | **EISDIR** | **EISDIR** |
| `fsyncSync(**파일** `'r'` fd)` | **EPERM** | OK | OK |
| `fsyncSync(닫힌 fd)` | EBADF | EBADF | EBADF |
| `opendirSync()` 의 fd 노출 | **없음** | 없음 | 없음 |
| `openSync(new,'wx',0o600)` 후 mode | **0o666** | 0o600 | 0o600 |
| `mkdirSync(mode:0o700)` 후 mode | **0o666** | 0o700 | 0o700 |
| **rename (대상이 fd 로 열림)** | **EPERM** | OK | OK |
| rename (소스가 fd 로 열림) | OK | OK | OK |
| rename → 기존 디렉터리 | EPERM | EISDIR | EISDIR |
| `writeSync` 8MiB 1회 | 부분쓰기 없음 | 없음 | 없음 |

| # | 계획/스펙 원문 | 실측 | 조치 |
|---|---|---|---|
| 51 | §3 분할표 「PR2 = T6b~T10 · 1,500~1,850 · 분할점 T10 을 PR2b」 | **코드 0줄 시점에 초과가 계산된다.** 형제 모듈 전수 실측으로 「총 순증 = 프로덕션 물리행 × **2.66~3.28**」 밴드가 확정된다(workbench 프로덕션 8파일 1,665 + 페이크 91 → 테스트 10파일 3,621 = 3.06배 · PR1c 독립 검산 566→1,854 = 3.28배 · PR1a 가 하한). 보수적으로 프로덕션 900 만 잡아도 총 ≥2,400 이고, T10 을 후하게 700 으로 떼도 1,700 은 **가장 낙관적 조합에서만** 상한 이내다 — PR1a 정정 ④·PR1c 분할점 발동의 **세 번째 동형 재발** | **착수 전 3분할 확정**(§3 표 갱신): **PR2a = T6b+T7** / **PR2b = T8** / **PR2c = T9+T10(배선 제외)**. 경계 근거 = ⓐ서로 다른 실패 모드(파일시스템 내구성 ↔ 인메모리 직렬화·revision 충돌 ↔ 재시도·기동 순서) ⓑ의존 **단방향**(store 가 `DurableFs` 를 소비 · 역방향 0) ⓒ각 경계 시점 **소비자 0**(엔진 미배선 · §1-8). 추정 방법을 「§3 행 개수 × 행당 비용」이 아니라 **「프로덕션 물리행 × 실측 배수 밴드」**로 §1 에 규범화 |
| 52 | 계획 T10 「spawn seam 2곳」 · 스펙 §W-16:906 「`detect.ts`·`mcp/stdio.ts` 를 계약에 명시」 | **PR1c 가 랜딩한 §3-T8f 승격판이 이를 즉시 RED 로 만든다.** `src/server/boot-workbench.test.ts:214-219` = 「폐포에 `core/workbench/**` 0건」 `expect(hits).toEqual([])`. 간선 추출 정규식(:192 `/(?:from\|import\|require)\s*\(?\s*['"]([^'"]+)['"]/g`)이 **`import type` 을 구분하지 않고** 폐포는 전이적이다. `cli/detect.ts`·`mcp/stdio.ts` 는 `engine.ts:27,41` 을 통해 데스크톱 폐포 안이고 같은 테스트 :210 이 그 도달을 앵커로 단언한다 → **타입 한 줄 import 로도 RED**. 타입을 다른 파일로 옮겨도 그 파일이 authority 를 참조하면 전이로 걸린다 | **T10 의 spawn seam 배선 2곳을 PR7 로 이월**(정정 ①이 boot 배선에 한 것과 동형). PR2c 는 **workbench 안에서** `BenchLauncher` 타입·`createBenchLauncher(commit)` 팩토리·commit 단일사용까지만 착지하고 **소비자 0** 을 유지한다. 폐포 핀을 「타입 전용 간선 예외」로 개정하는 안은 **기각** — 그 핀이 증명하는 것이 정확히 「서버 전용 범위」이고, 파서 없이 정규식으로 `import {type X}` 혼합형을 구분할 수 없어 개정이 곧 무신호다. eslint bench-spawn 가드(§3-T16c)도 **같은 이유로 PR7 동반 이월**(정정 64) |
| 53 | §3-T16 「`fsync-file`/`rename`/**`fsync-dir`** 각각 throw 시 `io-failure{step}` · lifecycle 무변」 ∧ §3-T17e·§W-4:396-398 「rename 성공 후 dir fsync 실패 = **`commit-uncertain`** · 디스크 revision 전진」 | **같은 주입에 상반된 반환을 요구한다.** 내구 순서(§W-4:471-474)상 `fsync-dir` 은 **항상 rename 뒤**이므로 도달 시 반드시 충돌한다 → 계획대로면 T8 과 T9 가 서로를 RED 로 만든다. 권위는 T17e(Codex 체크포인트 2 P1-5 로 이미 닫힌 구분). 게다가 `io-failure{step: DurableWriteStep}`(spec:395)의 `DurableWriteStep`(spec:516-517)이 `'open-dir'\|'fsync-dir'\|'close-dir'` 를 포함해 **타입 자체가** spec:394 주석(「rename 성공 전 실패」)과 모순 = tsc 무신호 | `DurableWriteStep` 을 **`PreCommitStep`(mkdir·open-tmp·write·fsync-file·close-tmp·rename) + `PostCommitStep`(open-dir·fsync-dir·close-dir)** 으로 쪼개고 `io-failure.step: PreCommitStep` 으로 좁힌다(타입이 오답을 거부). §3-T16 의 주입 대상은 **rename 성공 전 단계 한정**으로 축소, `fsync-dir` 은 T17e 단독 귀속. ⚠ 잔여 구멍도 함께 닫는다 — `open-dir`·`close-dir` 실패는 현재 **어느 종별에도 귀속되지 않는다**(`commit-uncertain.step` 은 리터럴 `'fsync-dir'` 단일) → `commit-uncertain.step: PostCommitStep` 으로 확장 |
| 54 | 스펙 §W-4:355 「`BenchLeaseToken.identity: BenchAuthorityIdentity`」 · 계획 T6b 「타입 배치표 전량 확정」 | **민팅 지점에 채울 데이터가 구조적으로 없다.** `createLockScope` 가 받는 것은 `LockScopeOptions{digest, backend}` 뿐(locks.ts:279-283)이고 `digest` 는 sha256 단방향(coord-area.ts:95-97)이라 `commonGitDir` 역산 불가 · `benchRoot` 는 랜딩된 워크벤치 **데이터 구조 어디에도 없다**(src 전수: 주석 2건뿐) · `locks.ts` 는 `fs`·`path` 를 **어떤 표기로도** import 금지(locks-structure.test.ts:59-65)라 정준화 자체가 불가. 즉 **public 시그니처 변경**이고 호출부 4곳 갱신을 요구한다 | `LockScopeOptions` 를 **`{ identity: { commonGitDir, benchRoot }, backend }`** 로 확장하고 `digest` 는 **옵션 안에서 `endpointDigest(identity.commonGitDir)` 로 유도**(digest↔commonGitDir 불일치 창을 타입에서 제거). 정준화·검증은 **호출자 책임**(PR7)임을 주석에 명시 — PR2 는 문자열을 받기만 한다. 호출부 4곳(locks.test.ts:197 · lock-backend-uds.test.ts:247,417 · lock-order.test.ts:23)을 ripple 표에 등재 |
| 55 | 스펙 §W-4:349-362 가 `BENCH_LEASE`·`LeaseCheck`·`BenchLeaseToken` 을 **다시 선언**(펜스 헤더 없음 · 앞 펜스는 `// authority.ts`) | 같은 3종이 **이미 `locks.ts` 에 랜딩**돼 있다(:211-213,224,230-238). `unique symbol` 은 선언마다 별개 타입이라 재선언하면 locks 가 민팅한 토큰이 authority 의 동명 타입에 **비대입**이다. 다만 실패 모드는 조용하지 않다(typecheck 즉시 RED = fail-loud) | 소유 = **`locks.ts`**(PR1b 랜딩) · `authority.ts` 는 **`import type` 단방향 소비**. `verbatimModuleSyntax`(tsconfig.base.json:15)라 타입 import 는 런타임 소거되어 값 순환 없음. T6b 배치표에 못 박고 PR 본문 「스펙 정정」에 등재 |
| 56 | 스펙 §W-4:333 「`IntegrationStage`(§W-7)」 · §3 분할표가 §W-7 을 **PR3** 에 배정 | `BenchAuthorityRecord.currentIntegrationStage` 가 참조하므로 **PR2 가 정의하지 않으면 컴파일되지 않는다**(PR3 소유 타입을 PR2 가 필드로 쓰는 순환) | 어휘는 §0.1 **C7 이 이미 확정**(`prepared → composed → published → finalized` + `abandoned`)이므로 창작이 아니다 → **`authority.ts` 가 소유**, PR3 `journal` 이 import(방향 journal→authority = 비순환) |
| 57 | 스펙 §W-4:333 「`SpawnOpts`(현행 `detect.ts` 타입 **재사용**)」 · §W-16:894 「`SpawnOpts` 에 `detached?`」 | **그런 타입은 레포에 없다**(src 전수 0건). `detect.ts` 가 가진 것은 **`RunOpts`**(:17-36 — `timeoutMs`·`cwd`·`signal`·`stdinInput`·`env`)이고 이는 **spawn 인자가 아니다**(실제 spawn 옵션은 :138-142 의 **이름 없는 인라인 리터럴** `{windowsHide, cwd, ...(env)}`). 두 스펙 문장도 상호 모순 — §333 이 참이면 `SpawnOpts ≡ RunOpts` 이므로 §894 의 「`RunOpts` 확장은 선택」이 성립 불가 | **신규 정의로 확정**(재사용 아님): `BenchSpawnOptions = node child_process `SpawnOptions` 의 사용 부분집합`(`windowsHide`·`cwd?`·`env?`·`stdio?`·`detached?`). 두 호출부의 shape 가 다르므로(stdio.ts:17 은 `stdio` 를 준다) **합집합**이어야 한다. 스펙 문면 정정을 PR 본문에 등재 |
| 58 | 스펙 §W-4:500 `createCommandRunner(deps:{launcher?}): CommandRunner` + §W-4:498 4-arg `BenchLauncher` | **합성 불가**다. `CommandRunner`(detect.ts:42-47)는 `(command,args,opts:RunOpts,onStdout?)` 로 확정돼 **commit 을 실어 나를 채널이 없다** → 반환된 러너가 `launcher(...,commit)` 을 부를 때 4번째 인자의 출처가 없다. 스펙 자신(§W-16:909-910)은 「활동 컨텍스트는 `RunOpts` 에 싣지 않고 **클로저 주입**」이라 반대 방향을 규정 | 브랜드 강제를 **팩토리 인자**로 옮긴다: `createBenchLauncher(commit: AuthorityCommit): (cmd,args,opts)=>ChildProcess`. §3-T16b(`@ts-expect-error`)의 대상도 호출부가 아니라 **팩토리 호출**로 정정. 「AuthorityCommit 없이는 인자 부족으로 컴파일되지 않는다」는 1차 방어는 그대로 성립한다(한 단계 위로 이동) |
| 59 | §W-5:516-528 `DurableFs` 9메서드 | **파일 종류·크기 판별 프리미티브가 없다.** 그런데 형제 2모듈은 「읽기 전 종류 확인」을 계약으로 굳혔다(coord-area.ts:181-186 `isLinkSync`=`'regular'` 선검사 · active-instance 5분기 정정 ㊵). 그 근거는 이 레포 실측 — **FIFO 면 `readFileSync` 가 무기한 블록**(부팅 정지) · **symlink 면 영역 밖 JSON 이 권위**가 된다. 현 인터페이스로는 ⓐ그 방어를 드롭(형제 대비 회귀)하거나 ⓑ store 안에서 `node:fs` 직접 호출(§W-5:531 「IO 전량 주입」 파기 + 페이크 검증 불가) 둘 중 하나가 강제된다 | `DurableFs` 에 **`statKind(path): {kind:'regular'\|'missing'\|'other'; size:number}`** 를 추가해 형제 규율을 **주입 seam 위에서** 재현한다. 권위 레코드 읽기는 `statKind` → `'regular'` 아닌 경우 **`invalid`(자동 삭제 금지)** 로 분기. §W-5 인터페이스 확장을 PR 본문에 등재 |
| 60 | §W-4:471-474 「[POSIX] openDir→fsync(dirFd) / [win32] **생략**」 ∧ §W-5:534 「내구 등급은 **부팅 1회 실측 프로브**로 결정」 | **판정자가 둘이라 어긋나는 조합이 실재한다**: ⓐwin32 에서 프로브가 성공하면 등급이 `'file+dir'` 로 **승격**되는데 쓰기 경로는 여전히 '생략' → **갖지 않은 내구성을 레코드가 주장** ⓑLinux 에서 프로브가 실패하면 등급은 `'file-only'` 인데 쓰기 경로는 플랫폼 기준이라 계속 `openDir` 을 호출해 매 CAS 가 `commit-uncertain` | **프로브 결과를 유일 권위로 통일**(쓰기 경로가 그 값을 소비 · 플랫폼 리터럴 분기 제거) + **프로브는 강등만 가능**하도록 win32 를 `'file-only'` 로 **상한 고정**(U4 「조용한 강등 금지」의 쌍대 = **조용한 승격 금지**). §3-T18 에 「win32 에서 프로브가 성공해도 등급은 `'file-only'`」 1행 추가 |
| 61 | §0.1 C3 · §W-4:474 「win32: `fsyncSync(dirFd)` = **EPERM**」을 `'file-only'` 강등의 근거로 제시 | **사실은 맞으나 원인 귀속이 틀렸다** — 3면 실측: win32 는 `'r+'` 로 열면 **디렉터리 fsync 가 성공**하고, 반대로 **파일**도 `'r'` fd 면 EPERM 이다. 원인은 「디렉터리」가 아니라 **권한**이다: `FlushFileBuffers` 는 **`GENERIC_WRITE` 를 요구**하고(MS Learn 원문) libuv `fs__sync_impl` 은 디렉터리 검사 없이 그 에러를 번역하며 `fs__open` 은 `FILE_FLAG_BACKUP_SEMANTICS` 를 **무조건** 설정한다. 게다가 Linux 는 `'r+'` 가 **EISDIR** 이라 같은 코드로 양 OS 를 못 탄다 | 강등은 **유지**하되 근거를 재기술: ⑴`'r'` fd 는 양 종류 모두 EPERM ⑵`'r+'` 는 API 성공이나 **MS 문서가 디렉터리 핸들 의미론을 규정하지 않는다**(별도 규정은 *볼륨* 핸들뿐 · 관리자 권한 필요) → POSIX 등가 보장 아님 ⑶Linux 는 `'r+'` 가 EISDIR. `openDir` 구현 = **`openSync(path,'r')`**(POSIX) — `opendirSync` 는 fd 를 주지 않는다(양 OS 실측). 정정 60 의 「승격 금지」가 ⑵의 직접 귀결이다 |
| 62 | §3-T17 「rename EPERM 재시도(win32 **실측 고정**)」 · 감사 후보 L3-4 「win32 실패 주입이 성립 안 할 공산」(PR1c 가 `unlink(열린 파일)` = OK 를 실측했으므로) | **성립한다 — 실측으로 확정**: 대상 파일을 `openSync(tgt,'r')` 로 보유한 채 `renameSync` ×3 = `EPERM,EPERM,EPERM` → `closeSync` → **4회차 성공** · 내용 교체 · 소스 소멸. `unlink` 와 `rename` 의 공유 모드 요구가 다르다. Linux 는 대상이 열려 있어도 rename 이 **성공**한다 | §3-T17·T17b(「첫 3회 EPERM, 4회차 성공 = 정확히 1 commit」)를 **실 파일시스템 위에서** win32 게이트로 조작화(`describe.skipIf(platform!=='win32')`). 페이크 전용 조작화는 실물 성질을 증명하지 않으므로(PR1b 확립) **페이크(양 OS) + 실 FS(win32) 2층**. CI 의 `windows vitest` 잡이 실행처다 |
| 63 | 계획 391 「`default: assertNever` 강제는 **eslint selector 로**」(적용 범위 미지정) | ⓐ「`no-restricted-syntax` 는 금지형이라 존재 요구를 표현 못 한다」는 통념은 **거짓** — `SwitchStatement:not(:has(SwitchCase[test=null] CallExpression[callee.name='assertNever']))` 가 **레포 설치본(ESLint 10.7.0)에서 실측 동작**한다(default 없는 switch·default 는 있으나 미호출 switch **둘 다** error · 정상형은 통과). ESLint 공식 selector 문서에 `:has()` 가 없다는 지적은 문서 누락이지 미지원이 아니다 ⓑ**범위가 공백**이고, 워크벤치 전체에 걸면 **랜딩된 `locks.ts` 의 switch 2곳이 즉시 RED**(둘 다 반환 타입으로 exhaustive 를 보장하며 `default:` 없음) | selector 채택 · 스코프는 **PR2 신규 파일 한정 옵트인**(PR1b `no-unsafe-type-assertion` 선례 동형). ⚠ **신규 블록으로 분리**해야 한다 — 기존 워크벤치 블록에 룰 키를 추가하면 `scripts/eslint-config-purity.test.ts:200-201` 의 **rules 키 집합 exact 동치 핀**이 RED 다(그 핀은 「코어 보호 룰을 재선언하지 않는다」는 보증 문장이라 완화가 곧 방어 축소). 신규 블록의 `files` 가 `'src/main/core/workbench/**/*.ts'` 를 **포함하지 않으므로** `find` 기반 `brandBlock` 조회와 무충돌(실측 확인) |
| 64 | 계획 386-390 「bench-spawn `no-restricted-syntax` 가드 + config 객체 단언 핀(§3-T16c)」 | **가드의 `files` 스코프가 계획·스펙 어디에도 없고, 두 후보가 모두 무효다**: ⓐ워크벤치 스코프면 워크벤치에 spawn 이 **0건**이라 vacuous(막는 것이 없는데 T16c 는 GREEN) ⓑ코어 전역이면 **정당한 지점이 즉시 위반**이라 lint RED | 가드는 **정정 52 와 함께 PR7 로 이월**한다 — 막아야 할 우회로(러너를 안 거치는 직접 spawn)의 소비자가 PR7 에 생기므로 그 전에는 어느 스코프에서도 조작화가 성립하지 않는다. PR7 착지 형태를 **미리 고정**: 「코어 전역 + `detect.ts`·`mcp/stdio.ts` 만 `ignores`」 + T16c 핀에 **`ignores` 배열 exact 동치**(3번째 spawn 지점 신설 = RED). PR2a 의 §3-T16c 는 **assertNever 블록의 config 객체 단언**으로 대체 귀속 |
| 65 | §W-5:520 `mkdirRecursive(path): void` | **mode 파라미터가 없다.** 권위 디렉터리(`<area>/authority/`)가 이 메서드로 생기는데 mode 를 못 주면 `0o777 & ~umask`(통상 0755)가 되어 §3-T59 의 **0700 단언을 주입 seam 위에서 만족할 수 없다**(형제 `coord-area.ts` 는 0700 을 명시 생성) | 시그니처를 **`mkdirRecursive(path, mode)`** 로 확정(§W-5 인터페이스 정정 등재). 실 어댑터는 `mkdirSync(path,{recursive:true,mode})` · win32 에서 mode 가 무시되는 것은 정정 67 의 게이트가 흡수 |
| 66 | §W-5:522 `writeAll(fd, data: string): void` | `fs.writeSync` 는 **부분 쓰기가 가능**하고 Node 자신이 `writeFileSync` 에서 루프를 돈다. 그런데 시그니처가 `string` 이라 **재개가 원리적으로 틀린다**(문자 오프셋 ≠ 바이트 오프셋 · 멀티바이트 경계 절단). 3면 실측에서 8MiB 1회 호출은 전량 기록됐으나 **보장이 아니다** | 구현은 **`Buffer.from(data,'utf8')` 로 1회 변환 후 바이트 오프셋 루프**. 이름이 `writeAll` 인 이유(부분 쓰기 재개가 계약)를 주석에 명시하고, 페이크가 **부분 쓰기를 주입**하는 행을 §3-T15 에 추가(루프 없는 구현이면 RED — 실 FS 로는 재현 불가하므로 이것이 유일한 조작화) |
| 67 | §3-T59 「0600/0700」 단언 | win32 는 `statSync().mode & 0o777` 이 **0o666**(파일)·**0o666**(디렉터리)을 답한다 — Node 문서가 「Windows 에서는 쓰기 권한만 변경 가능하고 group/others 구분이 없다」고 명시 | 모드 단언은 **POSIX 게이트**(`describe.skipIf(platform==='win32')`). win32 측 대응 행 = 「mode 인자를 **전달했음**」을 주입 페이크 호출 인자로 단언(양 OS) — 실 권한이 아니라 **계약 전달**을 검증 |
| 68 | §3-T17d 「배리어로 겹쳐도 stale draft 미커밋 — **뮤텍스 부재 구현이면 RED**」 | **괄호 안이 거짓이다.** 뮤텍스가 없어도 revision-CAS 만으로 stale draft 는 커밋되지 않는다(tx1.readFresh(rev=1) → tx2 가 rev=2 커밋 → tx1.CAS 는 `revision-mismatch`). 즉 T17d 는 **선언한 결함을 실제로 못 잡는다** — PR1b 정정 ⑲ 와 동형 | 조작화 재정의: 뮤텍스가 잡는 것은 **직렬화**이지 정합성이 아니므로, RED 를 «**두 `withAuthority` 가 겹쳐 실행되지 않는다**»의 관측으로 바꾼다 — 주입 `DurableFs` 가 기록하는 **단계 타임라인이 인터리브되지 않음**(tx1 의 `rename` 이 tx2 의 첫 `readFileUtf8` 보다 먼저) + 「뮤텍스 없는 대조 구현에서는 인터리브가 실제로 관측된다」는 **자기검사 행**을 함께 둔다(자기검사 없으면 이 단언도 vacuous) |
| 69 | §3-T13ⓑ 「커밋 후 디스크 레코드가 첫 draft 의 필드를 **하나도** 포함하지 않음」 | **불변식 9와 정면 모순이라 어떤 구현으로도 GREEN 이 될 수 없다** — `identity` 3필드는 「엔진 유도값과 정확 일치」가 강제되므로 두 draft 가 필연적으로 공유하고 `schemaVersion:1` 도 리터럴이라 항상 같다 | ⓑ를 «**두 번째 draft 가 실제로 바꾼 필드**에 한해 첫 draft 값이 남아 있지 않다»로 재기술(LWW 병합 구현이 RED 가 되는 성질은 보존). 대상 필드를 테스트가 **명시 열거**한다 |
| 70 | §3-T18b(file-only 롤백 시뮬레이션) | **계획 전문에 `T18b` 문자열이 0건** — 어떤 태스크도 이 RED 를 만들지 않는다(정정 ②·㉟ 과 동형 계열). PR2 가 win32 `'file-only'` 를 출하하는 순간 「revision 단조성이 깨지는 표면의 안전 논증」이 산문으로만 남는다 | T18b 의 판정식(**ref-앵커 재조정** = git ref 열거)이 §W-7 소유라 PR2 에 앵커가 없다 → **PR3 T13 에 명시 귀속**(§3-T34 와 같은 행에서 검증). PR2 는 「`'file-only'` 표면의 안전 논증은 **PR3 의 ref-앵커에 의존**하며 PR2 단독으로는 미완결」을 `authority.ts` 계약 주석 + PR 본문에 **명시 선언**(조용한 누락 금지) |
| 71 | §3.2 「`DurableFs` 훅에서 자식이 자살(`node -e`)하고 부모가 디스크를 관측하는 **실 프로세스 행** 최소 1행」 | **PR2 에서 조작화 불가**다. PR1b 에서는 자식이 *적대자*(순수 Node 프리미티브 재현)라 `node -e` 가 성립했으나, 여기서는 **자식이 프로덕션 코드를 실행하는 주체**여야 한다: `.ts` 자식 실행 불가(정정 ㉗) · `tsx`/`ts-node` devDep **0건** · `out/` 은 verify 체인상 vitest **뒤** · 자식으로 프로덕션 모듈을 적재하는 선례 **0건**. `node -e` 로 쓰면 자식이 내구 순서를 **JS 로 재구현**하게 되어 검증 대상이 프로덕션이 아니다 | **역할 재배치**로 재기술: 자식은 JS 로 「각 단계 직후의 **디스크 상태**」만 만들고(적대자 역할 유지 · 이것이 「도달 가능 상태」의 증거), **부모가 프로덕션 `readFresh`·복구 판정을 그 상태에 대고 실행**한다. 테스트 헤더에 «무엇이 프로덕션이고 무엇이 픽스처인가»를 명시(정직성). esbuild 번들 자식은 신규 기제라 **기각**(ADR-0003 ROI) |
| 72 | §W-5:534-535 「내구 등급을 **`area.json`** + 레코드에 기록」 | `AreaRecord` 는 4필드(`schemaVersion`·`lockBackend`·`createdAt`·`createdBy`)이고 **`durability` 자리가 없다**. 그 확장은 정정 ㉟ 이 이미 **PR7/T29 사전 결정 항목으로 이월**했다(「필드 부재 v1 레코드 관용 vs fail-closed」 포함) | PR2 는 ⓐ`probeDurability()` **순수 판정만** 착지 ⓑ레코드 `writtenBy.durability` 에만 기록. `area.json` 기록은 **호출자(부팅)가 §1-8 로 부재**하므로 PR7 이월을 계획에 명시 |
| 73 | §W-4:465 「`revision` 은 저장소만 배정 — `BenchAuthorityDraft = Omit<…>` 로 호출자 조작 불가」 | `Omit` 은 **객체 리터럴에만** 초과 프로퍼티 검사를 건다 — `const rec: BenchAuthorityRecord = …; tx.compareAndSwap(read, rec)` 는 구조적 서브타이핑으로 **tsc 를 그대로 통과**한다(즉 「조작 불가」는 타입이 주는 보장이 아니다) | 런타임 방어를 계약에 추가: `compareAndSwap` 이 **`revision`·`writtenBy` 키의 존재 자체를 거부**(`invariant-violation`)하고, 그 행을 §3-T13ⓒ 에 **행동 단언**으로 편입(타입 핀은 「스레딩 사고 방지」로 강등 — PR1b 정정 ㉑ 과 동형 처리) |
| 74 | §1-6 「PR 상한 = 코드 순증 1,900행」(측정 시점 미규정) | **PR1b 의 기록이 머지 트리와 어긋난다** — PR#259 본문 「순증 1,581」 vs 머지 실측 ≈**2,430**(신설 9파일 현재 합 2,433 − PR1c 증분 ≈20 + config 수정). 차이의 원인은 **측정 시점**이다(PR1c 는 「자체 적대 리뷰 반영까지 마친 시점」에 측정해 정합) | §1-6 에 **측정 시점 명문화**: 「**머지 직전 HEAD 기준** `git diff --numstat origin/master...HEAD`」. 최초 푸시 시점 측정 **금지**(리뷰 라운드가 코드를 늘린다). §3 표의 PR1a·PR1b 칸이 서로 다른 기준의 숫자를 섞고 있음을 각주로 등재하고, 「PR1b 는 상한 내였다」를 PR2 추정 근거로 **상속하지 않는다** |
| 75 | 계획 T7 「`DurableFs` 실 어댑터 + 등급 프로브」(플랫폼 커버리지 대응 없음) | 정정 ⑤·㉙ 이 확정한 대응 ⓐ(주입 seam + 페이크로 양 OS + 실 어댑터만 플랫폼 게이트)가 T7 에 **승계되지 않았다**. 그리고 PR2 는 앞선 PR 들과 달리 **양쪽 OS 에 각자 도달 불가 행이 생긴다**(POSIX dir fsync ↔ win32 rename EPERM 재시도) — 손실이 양방향이다 | 대응 ⓐ 를 T7 에 명시 승계 + **양방향 게이트**를 선언: POSIX 전용(dir fsync 성공 경로)과 win32 전용(rename EPERM 재시도 · mode 무시)을 각각 `describe.skipIf` 로 분리하고 **판정 로직은 전부 페이크로 양 OS**. 실 어댑터 완료 조건 = **코드 ≤110행 ∧ 미커버 stmts ≤45**(물리행은 안전망 280 — 구속하지 않는다)(PR1b 정정 ㉙ 의 절대 개수 규율 승계). 기준선 = 착수 시점 win32 로컬 실측 **S 3770/4040 · B 2450/2828 · F 663/704 · L 3318/3497**<br>⚠ **착지 시 개정(자체 적대 리뷰 R1-5·R2-1·R4-1·R5-2 가 4렌즈 독립 확인)**: 원안 「≤160 물리행」은 PR1b 어댑터(≤140)에서 외삽한 **추정**이었고 착지물(178행)이 즉시 위반이었다. 이 레포는 「왜 이렇게 했는가」를 주석으로 남기는 것이 규율이라 물리행의 절반 가까이가 주석이다(178행 중 **코드 96행**) — 그래서 **구속력 있는 수치를 코드행으로 옮기고** 물리행은 보조로 둔다. 상한은 실측 + 여유 12% 이며 회귀 가드(`authority-structure.test.ts`)와 이 표가 **같은 수치**를 쓴다<br>⚠ **재개정(실 Linux 검증 중 발각)**: 물리행 200 은 랜딩 직후 곧바로 역효과를 냈다 — 「부분 쓰기 근거는 API 계약이지 관측이 아니다」라는 **정직성 주석을 추가하자 203/200 으로 RED** 가 됐다. 이 레포는 근거를 주석으로 남기는 것이 규율이므로 물리행을 조이는 것은 **주석을 줄이라는 압력**이고, 그것은 이 가드의 목적(규칙이 어댑터로 새지 않음)과 무관하다 → **구속은 코드행 단독**, 물리행은 안전망 280 |

**PR2a 확정 범위**(위 정정 반영): 신설 = `authority.ts`(§W-4 **타입 전량** + `IntegrationStage` +
`PreCommitStep`/`PostCommitStep` · 값 구현은 PR2b) · `durable-fs.ts`(`DurableFs`+`statKind` ·
`createNodeDurableFs` · `probeDurability` · `writeAllBytes`) · ~~`__testing__/durable-fs-fake.ts`~~
(**착지 시 취소** — 자체 적대 리뷰 R5-7·R4-7·R6-7. PR2a 의 소비자는 판정 규칙 테스트 하나뿐이라 공유
페이크가 **파일 하나에서만 import 되는 `__testing__` 모듈**이 된다. 10 프리미티브를 전부 계측하는 로컬
`stubFs`(20행)로 충분하고 ADR-0003 ROI 게이트에 맞는다. **PR2b 가 단계 시퀀스·실패 주입 페이크를 두
파일에서 공유하게 되는 시점에 신설**한다 — 그때가 `coverage.exclude` 등재의 실제 근거가 생기는 지점이다) ·
계약/구조 테스트 ·
eslint **신규 블록**(assertNever selector · 신규 파일 한정 · `ELECTRON_DYNAMIC_IMPORT_SYNTAX` spread 재선언) ·
`scripts/eslint-config-purity.test.ts` 핀 추가 · `locks.ts` `LockScopeOptions`·`BenchLeaseToken.identity`
확장 + 호출부 4곳 · `src/shared/types.ts` `BenchLifecycle` 1줄.
**미착지 명시**: `withAuthority`/CAS 구현(→PR2b) · rename 재시도·`commit-uncertain`(→PR2c) ·
`BenchLauncher` 팩토리 런타임(→PR2c) · **spawn seam 배선 2곳 + bench-spawn eslint 가드**(→PR7 · 정정 52·64) ·
`area.json` 등급 기록(→PR7 · 정정 72) · §3-T18b ref-앵커(→PR3 · 정정 70).

**PR2a 자체 적대 리뷰 반영**(2026-07-27 · 6렌즈 → 렌즈별 독립 refuter · **62 후보 · 32 CONFIRMED ·
24 PARTIAL · 6 REFUTED · P1 0**). 착지 코드에 반영한 것:

| # | 지적 | 조치 |
|---|---|---|
| R1-5·R2-1·R4-1·R5-2 (4렌즈 독립) | 정정 75 의 완료 조건 「≤160 물리행」이 **착지물(178행)에서 즉시 위반**이고 회귀 가드는 240/120 이라는 다른 숫자였다 | 구속 수치를 **코드행**으로 옮기고(주석이 물리행의 절반 — 178 중 코드 96) 상한을 실측+12% 로 재산정. 정정 75 문면과 가드가 **같은 수치**(200/110)를 쓰도록 정합화 |
| R1-12·R3-4 | `writeAllBytes` 가 `write` 0 반환 시 **무한 루프** — 리스와 뮤텍스를 쥔 채 영구 고착 | 진행 보장 가드 + 계약 테스트. ⚠ **가드를 빼고 돌려 확인한 결과 vitest 러너가 멈췄다** — 동기 루프가 이벤트 루프를 막아 `it` timeout 조차 발화하지 않는다. 즉 이 회귀는 RED 가 아니라 **hang** 이며 그 사실을 주석에 등재 |
| R2-2·R2-8 | 테스트 스텁이 3개 메서드만 기록해 「호출 0」 단언이 «기록되는 것만 안 불렀다»만 증언 | **10 프리미티브 전부** 계측 + 인자 기록. fd 스레딩(열린 fd 를 그대로 fsync·close 하는가)·실패 시 close 누수 방지를 새 행으로 고정 |
| R2-3·R1-7 | 신규 eslint 블록의 electron 재선언 핀이 독립 `some` 2개라 **둘 중 하나만 남아도 통과**(#173 이 보완한 약점 재유입) | 두 selector 를 각각 exact `toContain` 으로(기존 코어 블록 핀과 동형) |
| R1-2 | `authority.ts` 가 실 어댑터를 **값 import** 해 「IO 전량 주입」을 깨도 전 게이트 GREEN(fs 술어가 `'./durable-fs'` 를 매칭하지 않는다) | 형제 선례 동형 **방향 핀** + 자기검사 앵커 추가 |
| R1-6·R4-4 | 인라인 `import('./locks').X` 는 brain 추출기가 방문하지 않아 **의존 간선이 구조 지도에서 소멸** | top-level `import type` 으로 전환(방출은 어느 쪽이든 0) |
| R5-3·R2-13 | 이 PR 이 스펙에 정정 블록을 넣어 **모든 `§W-4:NNN` 인용이 밀렸다** | 스펙 인용을 **행 번호 → 소절 이름**으로 전환(살아있는 문서라 행은 계속 밀린다). 코드 인용은 커밋으로 고정되므로 행 유지 |
| R5-8·R5-9 | `DurabilityLevel`·`AuthorityCommit` 주석이 **미착지 방어를 현재형으로 진술** | 소비자가 어느 PR 에 있는지 명시 |
| R6-8 | 스키마 상한과 기록값이 리터럴 2곳 | `schemaVersion: typeof SUPPORTED_AUTHORITY_SCHEMA` 로 결속 |
| R5-7·R4-7·R6-7 | 계획이 PR2a 산출물로 명시한 `__testing__/durable-fs-fake.ts` 미착지 | **취소를 명시**(위 확정 범위) — 소비자 1파일이라 공유 페이크의 근거가 없다. PR2b 에서 신설 |

**미반영(근거와 함께 남긴다)**: R2-9(POSIX 블록이 darwin 에서 실행 — 이 레포에 darwin CI 도 실측도 없다.
`platform === 'win32'` 단일 분기가 darwin 을 POSIX 로 사상하는 것은 §W-5 의 의도이며 `'platform-unsupported'`
거부는 §W-16 소관 = PR7) · R6-5(assertNever 가드가 대상 switch 0건인 채 착지 — 정정 64 가 bench-spawn 가드를
vacuous 로 판정해 이월한 것과 대칭이라는 지적. 차이는 **소비자 도착 시점**이다: `CasResult` switch 는 PR2b 가
즉시 만들고, spawn 우회는 PR7 까지 생기지 않는다. 그래도 비대칭이 남으므로 PR2b 착수 시 재검토 항목으로 등재).

#### PR2b 착수 전 실측 정정 (2026-07-28 · 6렌즈 감사 + 3면 JS 프리미티브 실측)

PR0~PR2a 가 확립한 「착수 전 ripple 전수 감사」를 PR2b 에 적용했다. 6렌즈 find → **렌즈별 독립 refuter**
(**78 후보 · 43 CONFIRMED · 33 PARTIAL · 2 REFUTED** · find 단계 P1 10건 중 refute 후 잔존 P1 **0**).
그리고 **하중 프리미티브를 메인 루프가 3면에서 직접 실측**했다 — win32 로컬(Node 24.16.0) ·
Docker `node:22.22.3`(필수 CI 게이트 런타임) · `node:24-bookworm-slim`.

⚠ **refuter 가 뒤집은 것도 기록한다**(감사의 자기검사): `concurrency-13`(취소 신호 부재 → 백오프 총합
150ms/CAS 라 드레인 상한에 무의미) · `gate-ripple-12`(폐포 핀 — 후보 자신이 「소비자 0 이면 GREEN」을 인정)
**2건 REFUTED**. `gate-ripple-6`(「구현이 authority.ts 밖으로 나갈 수 없다」)은 **전제가 거짓**으로 판정됐다 —
브랜드 프로퍼티 없는 객체는 대상 타입에 assignable 이라 다른 파일에서도 캐스트가 컴파일된다. 그래서 정정 97 의
단일 파일 결정은 **구속이 아니라 선택**이며, 근거는 「가드 3종·eslint `files`·purity 핀 무변경」이다.
그리고 메인 루프가 **에이전트 수치를 재측정해 정정한 것**이 둘 있다 — `budget-1` 의 「PR2a 배수 2.23 = 밴드
하한 미달」은 **거짓**(docs 포함 raw additions 를 쓴 오류 · 정정 74 정의로 재측정하면 **2.69 로 밴드 내**),
`invserial-1` 의 「수치 도메인을 하나도 검사하지 않는다」도 **과장**(⑧ 이 그것이다 — 정정 87 참조).

**실측 확정 사실 — PR2a 와 달리 PR2b 의 프리미티브는 플랫폼 대칭이다**

PR2a 는 `DurableFs` 가 fs 프리미티브라 3면이 정확히 반대였다(정정 61). PR2b 의 하중은 **JSON 왕복·복사
연산·마이크로태스크 순서**이고, 세 면이 **전부 동일**했다. 그래서 이 슬라이스에는 플랫폼 게이트가 필요 없다.

| 측정 | win32 24.16.0 / linux 22.22.3 / linux 24.18.0 (전면 동일) |
|---|---|
| `JSON.parse('{"__proto__":…}')` | own 데이터 프로퍼티 · **프로토타입 오염 없음** |
| `{...parsed}` 스프레드 | own 키 보존 · **오염 없음** |
| **`Object.assign(t, parsed)`** | **오염 발생**(`Object.getPrototypeOf(t) !== Object.prototype`) |
| **`for (k of keys) t[k]=…`** | **오염 발생**(Set 시맨틱) |
| `structuredClone(parsed)` | own 키 보존 · 오염 없음 |
| `Object.hasOwn(o,'__proto__')` | 적대 레코드 **true** · 평범 객체 **false** |
| `'__proto__' in o` | 적대·평범 **둘 다 true**(프로토타입 체인) |
| `JSON.parse(…, reviver)` 로 `__proto__` 제거 | 키 실제 제거됨(`Object.keys` = `['revision']`) |
| `{k: undefined}` | `in`·`hasOwn`·`Object.keys` 전부 잡힘 · `JSON.stringify` 는 **키 삭제** |
| `JSON.stringify(NaN\|Infinity)` | **`null`**(무성 변환) |
| `JSON.parse('9007199254740993')` | `…992`(정밀도 손실) · `Number.isSafeInteger` 가 `1.5·NaN·Infinity·2**53·'1'·null·true` 전부 거부 |
| promise-chain 뮤텍스 | `start1,end1,start2,end2,start3,end3`(FIFO 직렬) · **예외 후에도 후속 진입 가능** |
| 뮤텍스 **부재** 대조 구현 | `r1r2c1c2` — **200회 전부 동일**(자기검사 행이 결정론적 = flake 없음) |
| 뮤텍스 키 문자열 결합 | 공백 구분자는 **충돌**(`a␣b c␣d` ≡ `a␣b␣c d`) · `JSON.stringify([…])` 는 충돌 없음 |

**실측 확정 사실 2 — 배수 밴드와 상한 이력(메인 루프가 4 PR 전수 재측정)**

정정 51 이 선언한 밴드(2.66~3.28)를 **정정 74 의 측정 정의**(`src`+`scripts`+`deploy`+`e2e` 순증 · docs 제외)로
전수 재측정했다. 밴드는 유지되나 **상단이 더 높고**, 상한은 이미 **두 번 초과**됐다.

| PR | 총순증 | 프로덕션 순증 | 배수 |
|---|---:|---:|---:|
| PR1a | 1,708 | 574 | 2.98 |
| PR1b | 2,432 | 737 | **3.30** ⚠상한 초과 |
| PR1c | 1,952 | 585 | **3.34** ⚠상한 초과 |
| PR2a | 1,450 | 539 | 2.69 |

⇒ **실측 밴드 = 2.69~3.34** · 상한 1,900 역산 = **프로덕션 물리행 569(보수)~706(낙관)**.

| # | 계획/스펙 원문 | 실측·감사 | 조치 |
|---|---|---|---|
| 76 | §W-5:558 `createBenchAuthorityStore(fs: DurableFs, opts?: {...})` — `opts` 가 **문자 그대로 `{...}`** | **store 가 쓸 값이 하나도 정의돼 있지 않다**(4렌즈 수렴 · contract-chain-1·7 · budget-4 · invserial-12). ⓐ권위 경로 `<area>/authority/<benchId>.json` 의 `<area>` = `join(commonGitDir,'fleet')`(coord-area.ts:244)인데 `BenchAuthorityIdentity`(authority.ts:45-49)에 그 값이 없다 ⓑ`writtenBy.durability`(PR2b 기록처)를 채울 **등급의 출처**가 없다 — 프로브 호출자(부팅)는 §1-8 로 부재 ⓒ`writtenBy.at` 시계 seam 부재 | `opts` 를 **필수**로 확정: **`{ authorityDir: string; durability: DurabilityLevel; now: () => number }`**. 정준화·프로브 호출은 **호출자(PR7)** — 형제 `LockScopeOptions`(정정 54)와 동형. **재유도 금지를 구조 단언으로**: authority.ts 에 `AREA_DIR_NAME`·`'fleet'` 리터럴 0건 · `coord-area` import 0건 · **`process.platform`·`'win32'` 리터럴 0건**(등급 재판정 금지 = 정정 60 「판정자 이원화 금지」의 소비자 측 집행) + 각 술어에 자기검사 앵커 |
| 77 | §3-T15(PR2b)는 시퀀스에 **`[posix] fsync-dir` 포함** ∧ 정정 53 이 §3-T16 을 「rename 성공 전 한정」으로 축소 ∧ §3-T17e(`commit-uncertain`)는 **PR2c** 귀속 | **5렌즈 독립 수렴**(contract-chain-2 · concurrency-9 · gate-ripple-7 · testop-2 · budget-6). PR2b 는 POSIX 에서 post-commit 3단계를 **실행해야 하는데** 그 실패의 반환 종별이 배정 행 어디에도 없다 → throw·삼킴·`commit-uncertain` **세 구현이 전부 GREEN**. 타입은 이미 랜딩(authority.ts:227-237)돼 생산자 0 인 죽은 union 멤버가 된다 | PR2b 범위를 **「post-commit 실행 + `commit-uncertain` **반환**까지」**로 확장(추가 ≈15 코드행). **재시도·per-retry L-6·gated-orphan 회수만 PR2c 유지**. 동시에 스펙 §3-T16 문면의 `fsync-dir` 을 정정 53 에 맞춰 **삭제**(문면↔타입 모순 잔존 금지) |
| 78 | authority.ts:220 「rename 성공 전 실패 = 디스크 무변이(tmp 만 잔존 · **다음 CAS 가 회수**)」 | **4렌즈 수렴**(concurrency-2 · contract-chain-6 · invserial-7 · testop-13). ⓐ**더 하중받는 쪽**: tmp 이름이 `<benchId>.json.<ownerToken>.tmp`(spec:488)이고 `ownerToken` 은 **획득당 1회** 민팅(locks.ts:343)이라 **같은 리스의 모든 CAS 가 같은 tmp 경로**를 쓴다 → 실패 후 정리가 없으면 다음 CAS 의 `openExclusive`(create-only · durable-fs.ts:143)가 **EEXIST 로 자기잠금** ⓑ크래시 잔재는 `DurableFs` 10 프리미티브에 **열거가 없어**(durable-fs.ts:67-81) 원리적으로 회수 불가 | ⓐCAS 가 **`try/finally` 로 자기 tmp 를 `unlinkIfExists`**(PR1c 교훈 「수작업 정리는 try/finally 로 구조 승격」 승계) ⓑ§3-T16 에 **「같은 임계 구역에서 실패 직후 재-CAS 가 성공한다」 1행 추가**(EEXIST 자기잠금 falsifier — 이 행이 없으면 결함이 무신호) ⓒauthority.ts:220 을 **「같은 리스의 다음 CAS 가 자기 tmp 만 회수 · 크래시 잔재 수확기는 미착지(PR3 이월)」**로 정직 재기술 |
| 79 | §3-T14 「주입 `DurableFs.readFileUtf8` 호출 카운터로 `readFresh` 1회당 대상 경로 읽기가 **정확히 1회**」 | **정답 구현이 RED 다**(testop-5). 정정 59 가 신설한 `statKind` 선검사 + 랜딩된 durable-fs.ts:126-139(ENOENT → `{kind:'missing'}`)를 합치면 **부재 경로의 `readFileUtf8` 호출은 0회**다(authority.ts:140 「부재 레코드 = 0」·:167 `absent`). 또 정정 59 문면 「`'regular'` 아닌 경우 `invalid`」는 `'missing'` 까지 `invalid` 로 사상해 `absent` 종별과 충돌한다 | T14 를 **분해**: ⓐ`found` 경로에서 `readFileUtf8` **정확히 1회** ⓑ**전 경로**에서 `statKind` **정확히 1회** ⓒ같은 행에 **「`missing`→`absent` · `other`→`invalid`(자동 삭제 0)」 분류 단언**. 캐시 falsifier(외부 교체 후 새 revision)는 ⓐ에 유지 |
| 80 | §3-T13ⓐ 「두 상충 draft 를 순차 CAS 하면 두 번째가 **항상** `revision-mismatch`」 ∧ §3-T14 「같은 `FreshReadToken` 재사용 = `read-token-spent`」 | **같은 셋업에 상반된 반환을 요구한다**(testop-8). 가장 자연스러운 T13ⓐ 셋업(`readFresh` 1회 → CAS 2회)에서 **정답은 `read-token-spent`** 이므로 「항상 revision-mismatch」가 거짓이다. `CasResult` 는 두 종별을 나란히 싣기만 하고(authority.ts:196-200·218) **판정 순서 규정이 docs 전수 grep 상 0건** | 판정 순서를 **고정**: ①토큰 소진(`read-token-spent`) → ②리스 출처·identity(`lease-invalid`) → ③revision(`revision-mismatch`) → ④불변식(`invariant-violation`). T13ⓐ 셋업을 **「두 번의 독립 `readFresh`」**로 명시(각 임계 구역에서 1회씩 · 그래야 두 토큰이 같은 revision 을 관측한다) |
| 81 | 정정 69 가 재정의한 §3-T13ⓑ 「두 번째 draft 가 **실제로 바꾼 필드**에 한해 첫 draft 값이 남아 있지 않다」 + 「LWW 병합 구현이 RED 가 되는 성질은 **보존**」 | **그 주장이 거짓이다**(testop-3). `{...prev, ...draft2}` 는 draft2 가 **값을 준** 필드에서 정답 구현과 관측이 **동일**하다. 병합이 발현하는 자리는 **draft1 이 세우고 draft2 가 생략한 옵셔널**뿐이고 그런 필드가 실재한다(authority.ts:87 `archivedBranch` · :90-96 `currentIntegration*`/`completedIntegrationTxnId` · :97 `activeActivity`) | T13ⓑ 대상 필드를 **「draft1 이 세우고 draft2 가 생략한 옵셔널」로 명시 열거**해 테스트가 그 자리만 본다. ⚠ lifecycle 전이를 동반시키면 불변식 ⑥⑦ 이 **우연히** 잡아 반증력이 흐려지므로, 픽스처는 **lifecycle 무변**으로 고정 |
| 82 | §3-T17d 「두 `withAuthority` 호출을 **배리어로 겹쳐도**」 ∧ 정정 68 이 배리어 어휘를 유지한 채 술어만 변경 | **정답 구현이 deadlock 한다**(testop-6 · concurrency-14). 이 레포에서 「배리어」는 **랑데부**를 뜻하는 확립된 용례인데(계획 381 「배리어 = `open(…,'wx')` 원자성」), 상호배제가 성립하면 두 번째 `fn` 은 첫 `fn` 이 끝나기 전에 랑데부에 **도달할 수 없다**. §3.2 자신이 「배리어 타임아웃 flake 는 확률이 아니라 예정」이라 그 deadlock 이 flake 로 오진된다. 또 정정 68 이 필수화한 **자기검사 행의 조작화 기제가 미정**이라 가장 싼 구현이 **프로덕션에 「직렬화 끄기」 스위치**를 심는 형태가 된다 | **랑데부 금지**. 조작화 = ⓐ두 호출을 `Promise.all` 로 동시 시작하고 **주입 `DurableFs` 단계 타임라인이 인터리브되지 않음**을 단언(tx1 의 `rename` 이 tx2 의 첫 `statKind` 보다 앞) ⓑ자기검사는 **테스트 안의 뮤텍스-없는 대조 구현**으로만(프로덕션 표면에 우회 옵션 **신설 금지** — 옵션 키 집합 exact 핀으로 강제). 실측상 대조 구현의 인터리브는 **200회 결정론**(`r1r2c1c2`)이라 이 자기검사에 flake 가 없다 |
| 83 | §3-T61 「조건부 스키마 불변식 1~9 **전수 테이블**」 | **두 표면을 뭉갠다**(testop-11). 임계 구역은 read 검증과 CAS 검증 **둘 다** 돌리는데(§W-4) 관측이 다르다 — ⑧(`revision>=1 ∧ 정수`)은 **CAS 표면에서 도달 불가**(Draft 에 `revision` 이 없다 · authority.ts:113 · 정정 73 이 그 키의 **존재 자체**를 거부하게 만들었다) · ⑨는 read 가 `identity-mismatch`(authority.ts:176-180), CAS 가 `lease-invalid{identity-mismatch}`(:214-217)로 **종별 모양이 다르다** | T61 을 **2표로 분리**: 「read 표면 9행(기대 종별 명시)」+「CAS 표면 9행(도달 불가 행은 **그 사실을 단언**)」. 단일 표로 두면 한쪽이 통째로 미검증인 채 「전수」라는 이름이 붙는다 |
| 84 | §3-T53 「`StoreState` 키 집합 불변(권위 상태가 기존 store 에 새지 않음)」 | **런타임 열거로 조작화하면 false-GREEN**(testop-10 · **메인 루프 직접 확인**). `StoreState`(store/types.ts:50-69) = 필수 6 + **옵셔널 4**(`lastActiveProjectId`·`updaterChannel`·`droppedEventCount`·`eventSeq`)이고 `emptyState()`(memory.ts:5-12)는 **6키만** 반환한다 — 권위 누출의 전형이 **옵셔널 필드 추가**인데 `Object.keys(emptyState())` 는 그것을 영원히 못 잡는다. 레포 전수 grep 상 `keyof StoreState` 기반 핀은 **0건** | T53 을 **타입 수준 exact 핀**으로: `keyof StoreState` 를 리터럴 유니온과 상호 대입(`satisfies`/조건부 타입)해 **옵셔널 포함 전 키**를 고정한다. 런타임 `Object.keys` 열거는 **보조**로만 |
| 85 | §3-T20 「stale 전체 스냅숏 순차 기록이 최신 세대를 되돌리지 못함(revision-CAS)」 | **중복이거나 판정 불가다**(testop-12). CAS 경유로 읽으면 T13ⓐ 와 **동일 시나리오**이고, 「전체 스냅숏」을 문면대로 raw 쓰기로 읽으면(어휘가 spec:305-306 `createJsonFileStore` LWW 클로버를 가리킨다) store 에 막을 수단이 없고 탐지식은 §W-7 **ref-앵커**다 — 정정 70 이 **정확히 그 이유로** T18b 를 PR3 T13 에 귀속시켰는데 T20 에는 그 처분이 없다 | 정정 70 과 **동형 처분**: T20 의 raw 스냅숏 해석분을 **PR3 ref-앵커에 명시 귀속**하고, PR2b 는 「CAS 경유 stale 기록 거부」(=T13ⓐ 와 같은 성질)만 담당함을 **명시 선언**한다(조용한 누락 금지) |
| 86 | §3-T21c 「지원 범위 초과 `schemaVersion` → `incompatible-version` 분류」 | **하중받는 순서가 미핀이다**(invserial-3 · testop-9). I12 는 「문법 위반과 버전 스큐는 다른 사실」인데, **신 버전 레코드는 이 코드가 모르는 필드를 갖는다** — 문법 검사를 먼저 하면 `invalid` 로 오분류돼 **구 버전이 신 버전 권위를 삭제**한다. 형제 선례(coord-area.ts `probeRecord`)는 **문법 우선**이라 그대로 따르면 I12 가 무너진다. 게다가 T21c 의 「git 호출 0 · area 락 획득 시도 0」은 PR2b 에 셀 대상이 **구조적으로 부재**(budget-8) | ⓐ검사 순서를 **`schemaVersion` 최우선**으로 명시하고 **「신 버전 ∧ 문법 위반 동시」 픽스처**로 조작화(순서가 뒤집히면 `invalid` 가 나와 RED) ⓑ「git·락 0」은 **구조 단언**(authority.ts 가 git·락을 **값으로** import 0건 + 자기검사 앵커)으로 조작화하고, 행동 단언분은 **PR3/PR7 에 명시 귀속** |
| 87 | §W-4 「조건부 스키마 불변식(0단계 검증)」 9종 | **관계만 검사하고 형태를 검사하지 않는다**(invserial-1 · **메인 루프가 문면 재확인해 정정**). ⑧(`revision>=1 ∧ 정수`)은 수치 도메인을 검사하므로 「하나도 검사하지 않는다」는 **과장**이나, **유니온 멤버십 검사는 0건**이다 — `lifecycle`·`execGate`·`archivedBranch`·`currentIntegrationStage` 어느 것도 값 집합을 보지 않는다. 유니온 밖 `lifecycle:'zzz'` 를 가진 디스크 레코드는 ①②⑥⑦ 을 **vacuously 만족**하며 `found` 로 통과한다 | 0단계 검증을 **계층화**: **①형태(타입·유니온 멤버십·수치 도메인) → ②`schemaVersion`(정정 86 이 최우선으로 올린 것) → ③identity → ④불변식 1~9**. ⚠ ②가 ① 앞이어야 I12 가 서므로 최종 순서는 **`schemaVersion` → 형태 → identity → 불변식**이다(정정 86 과 정합) |
| 88 | (신규 — 3면 실측 산물) | `JSON.parse` 는 `__proto__` 를 **own 데이터 프로퍼티**로 만들어 그 자체로는 오염이 없으나, **`Object.assign` 과 키 대입 루프는 오염시킨다**(3면 동일 실측). 그리고 판별 술어로 `'__proto__' in o` 를 쓰면 **평범한 객체도 true** 라 무용하다 | 검증층 계약: ⓐ거부 술어는 **`Object.hasOwn(o,'__proto__')`**(적대 true·평범 false — 실측) ⓑ파싱 산출물에 **`Object.assign`·키 대입 루프 금지**(스프레드·`structuredClone` 은 안전 — 실측) ⓒ`found.record` 는 **필드 명시 재구성**으로 만든다(캐스트로 좁히면 `__proto__`·`constructor`·초과 키가 레코드에 실려 CAS 왕복으로 **디스크에 재기록**된다 · invserial-6) ⓓ`revision` 은 **`Number.isSafeInteger`**(실측: `1.5·NaN·Infinity·2**53·'1'·null·true` 전부 거부). ⚠ `JSON.stringify` 가 `NaN`/`Infinity` 를 **`null` 로 무성 변환**하므로 쓰기 검증이 이 검사를 **먼저** 통과시켜야 한다(invserial-4) |
| 89 | §W-4 `readFresh(): AuthorityReadResult` | **총체성이 계약에 없다**(invserial-2). 중첩 객체(`identity`·`activeActivity`·`writtenBy`)를 순진하게 역참조하면 **임계 구역 밖으로 throw 가 새고**, 그 경로의 뮤텍스 누수는 RED 가 아니라 **hang** 이다(PR2a 가 `writeAllBytes` 에서 실측한 계열 — durable-fs.ts:106-113) | ⓐ`readFresh` 는 **어떤 바이트에도 throw 하지 않는다**를 계약에 명문화(모든 실패는 판별 유니온) ⓑ뮤텍스 해제를 **`try/finally`** 로 구조 승격(정정 78 ⓐ와 같은 규율) ⓒ조작화 = 적대 바이트 표(잘린 JSON·배열·`null`·문자열·중첩 타입 오류·거대 파일) 전수 테이블 |
| 90 | `locks-structure.test.ts:104-130` 「브랜드 캐스트는 **인가된 2곳뿐**」 | **핀이 `LOCK_SOURCES` 한정이다**(gate-ripple-3 CONFIRMED · **메인 루프 직접 확인**). PR2b 는 `FreshReadToken`·`AuthorityCommit` 민팅에 **캐스트가 구조적으로 강제**되는데(브랜드가 `declare const` = 런타임 값 부재 · authority.ts:131,146) 그 새 forge 2곳은 **어떤 개수 핀에도 걸리지 않는다**. 게다가 브랜드 프로퍼티 없는 객체는 대상 타입에 assignable 이라 **다른 파일에서도 캐스트가 컴파일된다**(gate-ripple-6 이 「authority.ts 밖으로 못 나간다」를 반증) | forge 개수 핀을 **워크벤치 프로덕션 전수 스캔**으로 신설(형제 `locks-structure.test.ts:353` `readdirSync(HERE)` 관용구 승계) — 파일 분리 여부와 무관하게 닫힌다. 우회 vehicle(`as unknown as`·`as never`·`Parameters<`) 0건 + 앵글브래킷 형까지 세는 형제 술어를 그대로 재사용 |
| 91 | `authority-structure.test.ts` 의 세 술어(D-9 장기 핸들 · fs import 금지 · 브랜드 미export) | **전부 하드코딩 파일 목록**이다(budget-5 CONFIRMED · gate-ripple-8·10). 형제 `locks-structure.test.ts:353,364` 는 이미 「하드코딩 목록이 아니라 **디렉터리 전수**여야 한다(새 파일이 목록에 없으면 무신호)」를 명문화했는데 authority 쪽은 비대칭이다 | 세 술어를 **디렉터리 전수 + 파일 수 앵커**로 승격(신규 프로덕션 파일이 자동 편입). ⚠ `__testing__/*.ts` 는 `.test.ts` 가 아니라 **프로덕션으로 집계**되므로(gate-ripple-2·10 CONFIRMED) 신설 페이크도 이 스캔과 eslint `no-unsafe-type-assertion` 대상이다 — **페이크에 캐스트를 쓰지 않는 설계**가 강제된다 |
| 92 | §3 분할표 PR2b 칸 「1,500~1,700 · 분할점 = 불변식 9종 종료 >1,500 → §3-T61 전수표를 PR2b′」 | **트리거가 계획 자신이 금지한 측정 시점을 쓴다**(budget-1·2·3 · **메인 루프가 4 PR 전수 재측정**). 정정 74 는 유일 권위 측정을 「머지 직전 HEAD」로 고정했는데 「불변식 9종 종료」는 그보다 이른 시점이다. 그리고 선언된 레버(§3-T61 전수표)는 **약 200~280행(총량의 11~15%)뿐**이고, 프로덕션 검증기는 남아 §3.1 「신규 모듈 자체 ≥86%」와 spec:1112 가 닫은 무신호 구멍을 되돌린다 | ⓐ트리거를 **리뷰 라운드가 거의 늘리지 않는 축**으로 재정의: **「T8 프로덕션 물리행 ≤ 569」**(=1,900 ÷ 실측 상단 3.34). ⓑ분할점을 **「불변식 검증기(프로덕션) + T61 전수표」 한 쌍**으로 확장(레버 ≈270~350행 · 「검증기와 그 전수표는 같은 PR」 규율 유지). ⓒ2차 레버를 **사전 선언**: 「읽기 경로 / 쓰기 경로」 분리(둘이 거의 반씩 갈린다). ⓓ§1-6 밴드를 **2.69~3.34** 로 갱신하고 「상한은 PR1b·PR1c 에서 이미 두 번 초과됐다」를 각주로 등재 |
| 93 | §W-4 「`withAuthority` 는 bench identity 별 in-process 뮤텍스를 보유한 채 …」 | **진입 시 리스 출처 확인 요구가 없다**(concurrency-1 · contract-chain-3). 복제 토큰(`{...lease, identity: B}`)은 **캐스트 0개로 컴파일**되고(locks.ts:421-432 실측) **같은 `ownerToken` 을 그대로 들고 있어** `foreign-owner` 검사(authority.ts:206-212)를 통과한다 → 뮤텍스 키와 권위 파일 경로가 **B 로 유도**되는데 커널 배타는 A 에만 걸려 있다. PR#264 가 런타임 원장(`isMintedLease`)으로 닫은 구멍이 **소비자 층에서 재개방**된다 | `withAuthority` 가 **뮤텍스를 잡기 전에** `isMintedLease` 를 1회 집행하고, 실패 시 **어떤 fs·뮤텍스 부수효과도 없이** 모든 tx 메서드가 `lease-invalid{stolen}` 을 **값으로** 반환. 조작화 = **신규 행 「위조/복제 토큰 음성 통제(읽기·CAS 양 경로)」** — 복제 토큰 투입 시 주입 `DurableFs` **호출 0건** 단언(T14 에 얹지 않는다) |
| 94 | authority.ts:240 「임계 구역 안에서만 존재하는 핸들」 | **관찰 불가능한 서술이고 유출 경로가 열려 있다**(contract-chain-4 · concurrency-5). `fn` 이 `tx` 를 캡처해 `withAuthority` **반환 후** 호출하면 뮤텍스·리스 재검증 창 **밖**에서 CAS 가 돈다 — 스펙이 두 메서드를 tx 로 옮긴 근거(「뮤텍스 밖 호출이 정상 컴파일되면 경계가 규약으로 강등」)가 **한 단계 뒤에 그대로 재현**된다. 이를 잡는 §3 행이 없다 | 반환 시 **tx revoke**(클로저 플래그) + T17d 인접에 **신규 행 1개**. ⚠ **신규 종별을 만들지 않는다** — 만들면 assertNever 게이트 대상 switch 가 전부 갱신 대상이 되므로 기존 **`lease-invalid{released}` 재사용**이 싸다(리스가 이미 해제됐다는 것이 사실이기도 하다) |
| 95 | authority.ts:133-144 `FreshReadToken` 주석 「단일 사용이 계약이라 `readSeq` 를 싣는다」 | **`readSeq` 의 「모듈 내부 단조」 한정이 랜딩 주석에서 소실됐다**(contract-chain-8). 스펙 §W-4:380 은 「모듈 내부 단조」이고 §3-T19 는 **그 한정 위에** `vi.resetModules()` 2회 import 셋업과 「모듈 스코프 카운터가 B 에서 초기값」 자기검사를 세운다. store-지역 카운터로 구현해도 **PR2b 게이트 전부 GREEN** 이고 RED 는 PR6 에서야 난다 | `readSeq` 카운터와 read/commit **소비 원장을 모듈 스코프로** 주석 재기술 + **T8 행동 단언 1행**: 「같은 프로세스의 두 store 인스턴스가 seq 공간과 소비 원장을 **공유**한다 — A 의 토큰을 B 에 제출 = `read-token-spent`」 |
| 96 | `PathKind.size`(durable-fs.ts:59-62) | **소비자가 0건**이다(concurrency-12 · invserial-8 — refuter 가 후보보다 **근거를 강화**). 형제 `active-instance.ts` 는 같은 축에 **실측 기반 크기 상한을 이미 출하**했는데 권위 레코드에는 상한을 거는 주체가 없다 → 임계 구역 안의 **상한 없는 동기 읽기**가 뮤텍스+리스를 쥔 채 이벤트 루프를 막는다 | `readFresh` 가 `statKind().size` 를 **소비**해 상한 초과 시 `invalid`(자동 삭제 금지)로 분기. 상한값은 형제와 동형으로 **실측 근거와 함께** 고정 |
| 97 | 스펙 §W-5 코드펜스가 「소유 = `core/workbench/durable-fs.ts`」라 선언한 블록 **안**에 `createBenchAuthorityStore` 를 싣는다 | **파일 소유가 문면상 모순**이다(testop-14 · budget-10 · contract-chain-9). 문면대로 durable-fs.ts 에 두면 PR2a 가 착지시킨 **어댑터 두께 가드가 즉시 RED**(코드 110행 상한 · 현재 97행). 신규 3번째 파일에 두면 **세 가드가 전부 무적용**인데(eslint assertNever `files` 는 정확히 2파일 + purity 핀이 exact `toEqual`) 핀은 **GREEN 을 유지**한다 = #137·#173 계열 무신호 | **`authority.ts` 단일 파일 유지**로 확정(eslint `files`·purity 핀·구조 가드 3종 **전부 무변경**). 정정 91 의 전수 스캔 승격이 「장차 신규 파일」 위험도 함께 닫는다. 스펙 펜스 배치가 편집 아티팩트임을 **PR 본문 「스펙 정정」에 등재**. 또 「PR2b 가 만든 첫 `CasResult` switch 가 assertNever selector 를 **실제로 밟았다**」(선행 트립와이어 → 실효 전환)를 PR 본문에 기록(PR2a 가 R6-5 로 남긴 미결 항목의 종결) |
| 98 | §W-4 불변식 ③ 「`currentIntegrationStage`/`…Generation` 존재 ⟺ `currentIntegrationTxnId` 존재」 | **통합 4필드 중 3개만 덮는다**(invserial-11 · **메인 루프 직접 확인**) — `currentIntegrationResultOid` 는 **9개 불변식 어디에도 등장하지 않아** txnId 없는 **고아 resultOid** 가 정상 커밋된다 | 불변식 ③ 을 **통합 4필드 전체**(`Stage`·`Generation`·`ResultOid` ⟺ `TxnId`)로 확장하고 T61 두 표에 반영 |
| 99b | §3-T13ⓒ 「`revision` 이 호출자 draft 에서 오지 않음(**`Omit` 타입 핀**)」 | **스펙이 stale 이다**(invserial-9). 정정 73 이 「`compareAndSwap` 이 `revision`·`writtenBy` **키의 존재 자체**를 거부하고 그 행을 T13ⓒ 에 **행동 단언**으로 편입」이라 했는데 스펙 문면은 여전히 타입 핀만 말한다. 그리고 **실측상 판별자 선택이 결과를 바꾼다**: `{revision: undefined}` 는 `in`·`hasOwn`·`Object.keys` 에 **전부 잡히지만** 값 검사(`=== undefined`)는 **통과**하고, `JSON.stringify` 는 그 키를 **삭제**한다(3면 동일) | 판별자를 **`Object.hasOwn`** 으로 고정(정정 88 ⓐ와 같은 술어군)하고 T13ⓒ 를 **타입 핀 + 행동 단언 2층**으로 재기술. 테스트는 **`{revision: undefined}` 케이스를 반드시 포함**한다 — 값 검사 구현이 이 행에서만 RED 다. ⚠ 부작용 정직 기재: 이 거부는 가장 자연스러운 갱신 관용구(`{...prev, lifecycle:'archived'}`)를 **실패시킨다**(스프레드가 `revision` 을 실어 나른다 — 실측). 호출자는 구조분해로 두 키를 떼야 하며, 그 규율을 `BenchAuthorityDraft` 주석에 명시 |
| 99 | (잔여 · 개별 행 불요) | `gate-ripple-1`(P3) import 합칠 때 `authority-structure.test.ts:81` 앵커가 RED — 문장을 쪼개 회피하지 말고 **의미 단위 정규식으로 정당 갱신**(`:84-89` 자기검사는 유지되므로 약화 아님) · `gate-ripple-13`(P3) `brain:check` RED 는 **조건부가 아니라 확정**(brain.md:169 이 `authority … 260줄` 을 싣는다) → §1-9 순서 준수 · `budget-9`(P3) T15·T16·T17d 는 **전량 in-process 주입 페이크라 `--no-file-parallelism` 불요**(실 FS 행이 생기면 그때 등재) · `budget-11`(P3) **커버리지는 이 PR 의 구속이 아니다**(착수 실측 S 3815/4085=93.39% · B 2462/2840=86.69% · F 679/720=94.3% · L 94.93% · floor 대비 statements 슬랙 **97문**) — 구속은 **분량**이며 `coverage.exclude` 변경 **불요**(건드리면 exact 핀이 RED) · `testop-17`(P3) T16 의 「CLI 미실행」 절은 **런처 부재로 vacuous** 임을 명시(정직) | 각 항목을 해당 태스크 주석·PR 본문에 반영 |

**착지 후 분량 실측 — 정정 92 의 프록시 트리거가 55% 과대예측했다**

정정 92 는 착수 **전**에 쓸 수 있는 프록시로 「T8 프로덕션 물리행 ≤ 569」를 선언했다. 착지물은 그 축에서
**876행**(authority.ts 순증 666 + 페이크 210)이라 트리거가 발동했고, 밴드 상단으로 환산한 예측 총량은
876 × 3.34 ≈ **2,926** 이었다. **직접 실측은 1,887** 이다(`git diff --numstat` · src 4파일).

| 축 | 값 |
|---|---:|
| `authority.ts` | +666 / −1 |
| `authority-store.test.ts`(신설) | +794 |
| `authority-structure.test.ts` | +251 / −33 |
| `__testing__/durable-fs-fake.ts`(신설) | +210 |
| **총 순증** | **1,887** (상한 1,900) |
| 실측 배수 | **2.15** (밴드 2.69~3.34 **하한 미달**) |

원인은 이 PR 의 **프로덕션/테스트 비율이 비정형**이라는 것이다 — 형제 PR 들은 프로덕션 1행당 테스트 2~2.3행을
썼는데 여기는 **1.19행**이다(666 프로덕션 ↔ 794 테스트). 계약이 판별 유니온 반환이라 한 단언이 여러 종별을
동시에 덮고, 반대로 프로덕션 쪽은 검증 계층이 주석 밀도가 높다. 즉 **밴드는 이 슬라이스에 대한 예측자로
부적합**했다.

**그리고 실제로 초과했다.** 위 1,887 은 CAS **재독 창**(readFresh 와 rename 사이의 디스크 변화) 7행을
추가하기 전 값이다. 그 분기들 — 파일 소멸·손상 교체·신 버전 교체·타 레포 identity·재독 IO 실패·**L-6 변이
직전 재검증**·foreign-owner — 은 전부 미커버였고, 이 영역이 §W-2-a 상 ttyd 셸·CLI 와 **같은 신뢰 도메인**
이라 이론적 방어가 아니다. 추가 후 **순증 2,020**(상한 대비 +120 · 6.3%)이고 `authority.ts` 자체
커버리지는 **S 87.45 → 90.32%** 다.

**판정(사용자 결정 · 2026-07-28)**: **초과를 선언하고 진행한다.** 근거와 대가를 둘 다 적는다.
- 선언된 분할점(「불변식 검증기 + T61 전수표」→ PR2b′)을 적용하면 규칙은 지켜지지만 PR2b 가
  **불변식 검증 없는 `readFresh`** 를 출하한다 — 디스크의 불변식 위반 레코드를 `found` 로 통과시키는
  **더 약한 계약**이 한 PR 동안 존재한다. 2차 레버(읽기/쓰기 경로 분리)도 T8 의 정의상 핵심인 CAS 를
  떼어내므로 같은 성격의 손상이다. **6.3% 초과보다 이쪽 비용이 크다**는 판단.
- 선례: 상한은 **PR1b(2,432 · 28% 초과)·PR1c(1,952 · 2.7% 초과)** 에서 이미 두 번 초과된 채 머지됐다.
  상한의 목적은 **리뷰 가능성**이고 기술적 하드 리밋이 아니다.
- **은폐하지 않는 것 둘**: ⓐ규칙은 **발동했다**(프록시 축 876 > 569 · 직접 축 2,020 > 1,900 — 두 축 모두).
  ⓑ정정 74 대로 **리뷰 라운드가 더 늘린다**. 그래서 이 PR 의 리뷰 반영은 행 증가를 명시 예산으로
  관리하고, 증가분을 PR 본문에 누적 기록한다.
- **차기 PR 에 상속 금지**: 「PR2b 가 초과하고도 머지됐다」를 PR2c~PR7 의 추정 근거로 쓰지 않는다
  (정정 74 가 PR1b 에 대해 세운 규율과 동형).

밴드 자체는 이 관측(2.15)을 포함해 **2.15~3.34** 로 갱신하되 **하한을 예측에 쓰지 않는다**(하한은 사후
설명이지 사전 보증이 아니다). 그리고 프록시 트리거는 **이 슬라이스에서 55% 과대예측**했으므로, 차기 PR 은
「프로덕션 물리행」 단독이 아니라 **「프로덕션 물리행 × 그 PR 의 예상 테스트 비율」**로 예측한다 —
테스트 비율은 계약 형태(판별 유니온 반환은 한 단언이 여러 종별을 덮는다)에 크게 좌우된다.

**최종 실측 — 자가 적대 리뷰 반영 후 2,735(상한 +44%)**

정정 74 가 예고한 「리뷰 라운드가 코드를 늘린다」가 그대로 실현됐다. 자가 적대 리뷰(64 후보 · 32 CONFIRMED ·
**P1 2건 생존**)를 반영하며 **+715행**이 붙었다.

| 파일 | 순증 |
|---|---:|
| `authority.ts` | +854 / −8 |
| `authority-store.test.ts` | +1,422 |
| `authority-structure.test.ts` | +260 / −33 |
| `__testing__/durable-fs-fake.ts` | +225 |
| `scripts/eslint-config-purity.test.ts` | +24 / −9 |
| **총 순증** | **2,735** (상한 1,900 · **+44%**) |

**판정(사용자 결정 2회차 · 2026-07-28)**: **그대로 진행.** 증가분 715행은 **전부 리뷰 발 하드닝**이고,
그중 대부분이 **뮤테이션으로 증명된 무신호 방어를 핀하는 테스트**다 — 되돌리면 확정 결함(브릭 ·
재진입 교착 · `String(unknown)` TypeError · 하위 디렉터리 무신호)이 **다시 열린다**. 분할 경계도 인위적이다:
「테스트」와 「그 테스트가 핀하는 방어」를 갈라 두면 두 PR 사이 기간에 가드 없는 방어가 출하된다.
상한의 목적은 **리뷰 가능성**이고, 여기 1,682 테스트행은 각각 특정 뮤턴트에 대응하므로 그 목적을 해치지 않는다.
선례도 PR1b(2,432 · +28%)가 있다.

⚠ **차기 PR 에 상속 금지**를 재확인한다 — PR2c~PR7 은 이 초과를 추정 근거로 쓰지 않는다.

**최종 실측 — 봇 리뷰 4라운드 후 3,297(상한 +74%)**

| 시점 | 순증 | 팽창률(착지 기준) |
|---|---:|---:|
| 착지 직후(자가리뷰 전) | 2,020 | 1.00 |
| 자가 적대 리뷰 반영 | 2,735 | 1.35 |
| **봇 리뷰 4R 반영(최종)** | **3,297** | **1.63** |

§1-6 에 반영할 교훈: **「착수 전 예측은 리뷰 하드닝을 포함하지 않는다」.** 실측 팽창률 밴드를
**1.54~1.63** 로 갱신한다(PR1b 1,581→2,430 = 1.54 · PR2b 2,020→3,297 = 1.63). 사전 추정에는 이 계수를
곱해 상한을 확인해야 한다 — 즉 **착지 목표는 상한의 60~65%** 여야 머지 시점에 상한 안이다.

**봇 리뷰 궤적(수렴 확인)**

| 라운드 | Codex P1 | 성격 |
|---:|---:|---|
| 1R | 3 | 토큰 위조·커밋 재조준·동시성 파괴 — 자가리뷰가 **놓치거나 잘못 강등** |
| 2R | 5 | 그중 1건은 **1R 수정이 만든 회귀**(WAL 진입 불가) |
| 3R | 2 | 2R 수정의 후속 결함 → **재진입 가드 설계 철회** |
| 4R | 1 | **문서화만**(ApprovalGate 예외) · 코드 결함 0 |

**실증 검증 — 사용자 지적으로 발견한 공백**(머지 직전)

봇 4라운드가 clean 이 된 뒤에도 **543개 테스트가 전부 주입 페이크 위에서만** 돌고 있었다. 세 공백:
ⓐstore 와 **실 어댑터의 조합**이 한 번도 실행된 적 없다(PR2a 는 어댑터 단독만 실 FS 로 봤다)
ⓑ프로덕션 경로인 POSIX `file+dir` 이 win32 에서 전부 `file-only` 로 우회돼 **미실행**(서버는 컨테이너다)
ⓒ정정 71 이 요구한 §3.2 「실 프로세스 크래시 행」 **미구현**.

→ `authority-node.test.ts` 신설(실 FS 13행 · win32 9 pass/4 skip · **ubuntu CI 13 pass**) +
**Docker `node:24-bookworm-slim` 비특권 ALL PASS**(esbuild 번들 + plain node — vitest 는 win32
node_modules 의 rollup 네이티브 때문에 컨테이너에서 못 돈다). 검증 항목: file+dir 완주 · 등급 기록 ·
0700/0600 실 inode · `probeDurability='file+dir'` · 부모 디렉터리 · 연속 CAS 단조 · tmp 잔재 0 ·
크래시 도달성 4항.

⚠ **그리고 그 크래시 행이 처음엔 vacuous 였다**(CodeRabbit 적발): 고정 `crash.json` 을 쓰면서 판정은
다른 benchId 리스로 해 **잔재를 아예 들여다보지 않았다** — §3.2 를 만족시키려고 쓴 바로 그 행이
「무관한 파일은 absent」만 확인했다. 대상·리스 benchId 를 일치시키고, 읽기 경로를 tmp 로 오독하는
뮤턴트에서 3행이 RED 가 됨을 확인했다. **교훈: 실증 테스트도 vacuous 할 수 있다 — 실 프로세스를
띄웠다는 사실이 반증력을 보장하지 않는다.**

**이 슬라이스가 남기는 방법론 교훈 3가지**(PR2c 착수 전에 읽을 것):
1. **자가리뷰 refuter 의 강등을 의심하라** — 형제 모듈이 이미 닫은 패턴(`MINTED_LEASES`)을 「범주 혼동」
   으로 기각한 판정이 실제 취약점(스프레드 복제 토큰 → stale 덮어쓰기)을 통과시켰고, 그 **틀린 근거를
   코드 주석으로도 써 놨다**. 검증되지 않은 안전 주장은 문서화하지 않는다.
2. **수정도 리뷰 대상이다** — 1R 지적을 반영하며 스펙을 재확인하지 않아 회귀를 만들었다(통합 4필드
   무조건 묶음 → `prepared` CAS 영구 실패). 리뷰 반영 시 **원 계약을 다시 연다**.
3. **런타임 heuristic 이 계약을 대신할 수 없으면 철회하라** — 재진입 가드가 3라운드에 걸쳐 거짓 양성
   3종을 냈고 표면이 닫히지 않았다. 판단 기준은 **비용 비대칭**(거짓양성=프로덕션 가용성 / 거짓음성=
   개발시점 hang)이었고, 정답은 **호출자 계약 + 철회 이력 주석**이었다.

**PR2b 확정 범위**(위 정정 반영): `authority.ts` **단일 파일**에 값 구현 —
`createBenchAuthorityStore(fs, opts)`(정정 76 의 필수 3필드) · `withAuthority`(진입 `isMintedLease` ·
identity 별 뮤텍스 · `try/finally` 해제 · 반환 시 tx revoke) · `AuthorityTx.readFresh`(총체적 ·
`statKind` 선검사 · `schemaVersion`→형태→identity→불변식 계층 · 크기 상한) ·
`AuthorityTx.compareAndSwap`(판정 순서 고정 · 내구 순서 + **post-commit 실행 및 `commit-uncertain` 반환** ·
`finally` tmp 정리) · `__testing__/durable-fs-fake.ts`(**캐스트 0** — eslint 프로덕션 스코프) ·
계약/구조 테스트 · 구조 가드 3종 **전수 스캔 승격** + **forge 개수 핀 신설**.
**미착지 명시**: rename 재시도·per-retry L-6·gated-orphan 회수(→PR2c) · `BenchLauncher` 런타임(→PR2c) ·
spawn 배선·bench-spawn 가드(→PR7) · `area.json` 등급 기록(→PR7) · **크래시 잔재 tmp 수확기**(→PR3 · 정정 78) ·
T20 raw 스냅숏분·T18b ref-앵커(→PR3 · 정정 85·70) · 엔진 배선(→PR7 · **소비자 0 유지**).

**C 이식(핵심)**: 타입 골격이 어떤 런타임보다 앞선다.

- **T6b 계약 사슬 골격(척추)** — **C 의 타입 배치표 전량**을 이 태스크에서 확정한다(스펙 §W-4 각주가 계획에
  **명시 위임**한 산출물 — 미이행 시 Codex P1 확정). 브랜드 `unique symbol` 3종 **미export**.
  RED: §3-T16b(`@ts-expect-error` — 구현 전에는 에러가 없어 tsc 가 "Unused directive"로 실패 = RED) ·
  §3-T16c(eslint config **객체 단언**). ⚠ **flat config 는 rule-key 병합이 아니라 교체**다 —
  `eslint.config.mjs:307` 코어 블록이 `src/main/core/**` 를 포함하므로 후행 workbench 블록이
  `no-restricted-syntax` 를 선언하면 `ELECTRON_DYNAMIC_IMPORT_SYNTAX` 가 **그 디렉터리에서 유실**되고
  기존 핀 테스트는 블록별 조회라 **무신호**다(#174 재발). 양쪽 spread + 신규 블록용 핀을 함께.
  **`default: assertNever` 강제는 정규식 스캔이 아니라 eslint selector 로**(우회·오탐 회피) 구현하고
  config 객체 단언으로 핀한다. `assertNever` **이동은 하지 않는다**(소비 2곳뿐 · re-export 2경로는 혼란 —
  ADR-0003 ROI 게이트).
- **T7 `DurableFs` 실 어댑터 + 등급 프로브** — §3-T59(실 FS: tmp 고유성·rename 후 tmp 부재·0600/0700·
  POSIX dir fsync / win32 `'file-only'` **반환값**) · §3-T18 · **T62 의 D-9 분**.
- **T8 권위 CAS 코어(`withAuthority`·`AuthorityTx`)** — §3-T13(**행동 단언 3개** · ⓑ대상 필드 명시 열거
  = 정정 81 · ⓒ타입 핀 + `Object.hasOwn` 행동 단언 2층 = 정정 99b) · §3-T14(**분해** — found 경로
  `readFileUtf8` 1회 / 전 경로 `statKind` 1회 / 종류별 분류 = 정정 79) · §3-T15(**post-commit 포함** ·
  랑데부 금지) · §3-T16(rename 전 단계 한정 + **「실패 직후 재-CAS 성공」** = 정정 78ⓑ) ·
  §3-T17d(**타임라인 비인터리브** · 테스트 내 대조 구현 자기검사 = 정정 82) · §3-T17e **반환 종별 절만**
  (정정 77) · §3-T20(CAS 경유분만 · raw 스냅숏분은 PR3 = 정정 85) · §3-T53(**타입 수준** exact 핀 = 정정 84) ·
  §3-T21c(**`schemaVersion` 최우선 순서**를 픽스처로 조작화 + git·락 0 은 구조 단언 = 정정 86) ·
  **§3-T61**(**read/CAS 2표** = 정정 83) · §3-T18 의 「레코드 기록 · 조용한 스킵 금지」 절(정정 76ⓑ) ·
  **신규 3행**: 위조/복제 토큰 음성 통제(정정 93) · tx 유출 거부(정정 94) · 두 store 인스턴스 원장 공유(정정 95).
  **store 는 `withAuthority` 만 public**, 두 메서드는 `AuthorityTx` 에.
- **T9 rename 재시도 · per-retry L-6** — §3-T17(win32 실측) · §3-T17b(**재시도 끝 성공 =
  정확히 1 commit**) · §3-T17c(재시도 중 탈취 → 이후 rename 미실행) · §3-T17e 의 **회수분**(재시작 복구가
  `execGate:'gated'` 를 gated-orphan 으로 분류해 회수 · `running` 은 비대상). ⚠ `commit-uncertain` **반환**은
  정정 77 로 **PR2b 선이관** — T9 에 남는 것은 재시도와 회수뿐이다.
- **T10 `BenchLauncher` · spawn seam 2곳 · ADR-0013** — §3-T17f(commit 발급·spawn 이 **최종 acknowledged
  durability 이후**) + **B 이식: `CAS1('gated') → commit1 → CAS2('running') → commit2 → spawn(commit2)`
  순서 고정** + **spawn 실패 시 활동 종결 CAS**(세 초안 공통 누락).
  무회귀: `createCommandRunner()` 무주입 = 현행 `defaultRunner` 동일(조건부 `env` 스프레드 보존 ·
  `onStdout` 4번째 인자 전파) · `createDefaultSpawn(baseEnv, launcher?)`.
  **ADR-0013**: ①MCP 자식을 봉쇄 범위 밖으로 **명시 배제** ②nightly 부재로 §3-T55·N2~N4 를 #254 이관
  ③win32 `'file-only'` 수용(**Codex 3항의 충족이 아니라 회피**) ④M1 실패 시 추상 소켓 대안 판단.

#### PR2c 착수 전 실측 정정 (2026-07-29 · 6렌즈 감사 + 3면 rename 실측)

**3면 rename 실측 — 재시도 계약(C4)의 근거는 win32 EPERM «열린 핸들» 단 하나다.**
동일 스크립트를 win32 로컬(Node 24.16.0) · Docker `node:22.22.3-bookworm-slim`(필수 CI 게이트 런타임) ·
`node:24-bookworm-slim`(프로덕션 근사 · 둘 다 `--user 1000:1000`)에 태웠다.

| 조건 | win32 24.16.0 | linux 22.22.3 / 24.18.0 |
|---|---|---|
| 대상이 fd 로 열림(`'r'`) | **EPERM** | OK |
| 대상이 fd 로 열림(`'r+'`) | **EPERM** | OK |
| **소스**(tmp)가 fd 로 열림 | OK | OK |
| 대상 자리가 **디렉터리** | **EPERM** | EISDIR |
| 대상이 **읽기 전용**(0444) | **EPERM** | OK |
| 소스 부재 | ENOENT | ENOENT |
| 부모 디렉터리 0500 | OK(권한 무시) | **EACCES** |
| 대상 열린 채 3회 → close → 4회차 | EPERM×3 → **OK** | (해당 없음 — 애초에 성공) |

여기서 **계약이 바뀌지는 않지만 정직하게 기록해야 하는 사실**이 나온다:

1. **재시도 대상 3코드 중 「일시적」이 실측으로 확인된 것은 win32 EPERM(열린 핸들)뿐이다.**
   같은 win32 EPERM 이 **대상=디렉터리·대상 읽기전용**에서도 나오는데 그 둘은 **영구 실패**다 —
   재시도 4회를 다 소진하며 리스와 뮤텍스를 **150ms 동안 붙잡은 뒤** `io-failure` 로 끝난다.
   errno 만으로는 두 경우를 구분할 수 없다(win32 는 `FlushFileBuffers`/`MoveFileEx` 계열 실패를 전부
   EPERM 으로 번역한다 — PR2a 가 `openSync(dir,'r')` fsync 에서 관측한 것과 같은 계열).
   → **계약은 유지**(fail-closed 방향이고 상한이 150ms 로 유계). 대신 「재시도가 무의미한 EPERM 이
   존재한다」를 코드 주석과 PR 본문에 **정직한 한계**로 남긴다. 영구/일시 판별 시도는 하지 않는다 —
   판별자가 틀리면 **일시적 실패를 영구로 오분류해 정상 커밋을 잃는다**(비용 비대칭: 150ms 지연 vs 커밋 소실).
2. **EACCES 는 POSIX 에서 영구(부모 권한)** 이고, **EBUSY 는 3면 어디서도 재현되지 않았다.**
   스펙 C4 는 `{EPERM,EBUSY,EACCES}` 를 근거 없이 열거했다 — 근거로 적힌 것은 win32 EPERM 뿐이다.
   → 집합은 유지하되(방어적 · 네트워크 드라이브·AV 스캐너 계열에서 보고되는 코드), **「EBUSY 는 이
   레포의 3면 실측에서 재현되지 않았다」**를 상수 주석에 명시한다(미검증 근거를 검증된 것처럼 쓰지 않는다 —
   PR2b 교훈 ②의 직접 적용).
3. **소스(tmp)를 연 채로는 양 OS 모두 rename 이 성공한다.** 현행 구현이 `close-tmp` 를 rename 앞에
   두는 것은 내구성(fsync 후 close) 때문이지 rename 성공 조건 때문이 아니다 — 주석이 후자로 읽히지
   않게 한다.
4. **win32 EPERM×3 → close → 4회차 성공은 결정론적으로 재현된다**(위 표 마지막 행). PR2a 가 예고한
   대로 §3-T17 의 **실 FS 조작화**가 가능하다(`authority-node.test.ts` 층 · `describe.skipIf(win32 아님)`).

**6렌즈 감사**(find 6 → 렌즈별 독립 refuter 6 · **83 후보 · 82 생존 · P1 14**). ⚠ 이번 감사는
**refuter 가 거의 기각하지 않았다**(REFUTED 1). PR2b 교훈 ②(잘못된 강등)의 **반대 방향 실패**이므로
메인 루프가 P1 을 전수 재판정해 **4개 클러스터**로 압축했다 — 아래 정정 100~110 이 그 결과다.

| # | 대상 | 사실(감사 → 메인 루프 재판정) | 조치(착수 전 확정) |
|---|---|---|---|
| 100 | 계획 T9(c)·스펙 §W-4 회수 문면·§3-T17e | **gated-orphan 회수에 PR2c 소유 산출물이 없다 — 4렌즈 독립 수렴**(PLAT-8·GP-3·TO-3·CC-3). 스펙 :452-456 은 「리스 보유 소유자가 CAS 로 **정리할 수 있다**」는 **능력 서술**이고 그 능력은 **오늘 이미 참**이다(`serialize` 가 draft 에서 6필드를 명시 재조립하므로 `activeActivity` 를 뺀 draft 를 CAS 하면 그대로 사라진다 — authority.ts:730-747 · 추가 코드 0). §3-T17e 의 판정 주체는 「**재시작 복구**」인데 그 경로는 PR3/PR7 이다. 반대로 「`running` 비대상」을 CAS 층 불변식으로 넣으면 **정상 활동 종료**(spec:475 「spawn 실패 시 활동 종결 CAS 가 필수」)까지 봉쇄돼 두 계약이 서로를 RED 로 만든다 | PR2c 산출물을 **순수 함수 2개로 확정**한다(store 메서드·결과 유니온 신설 0 · 소비자 0 유지): ⓐ`classifyStaleActivity(record): {kind:'none'} \| {kind:'gated-orphan',activityId} \| {kind:'live-activity',activityId}` ⓑ`reclaimDraft(record): BenchAuthorityDraft`(**`activeActivity` 만 소멸 · 나머지 전 필드 바이트 동일 보존**). CAS 층에는 **어떤 정책도 넣지 않는다**. 조작화 = ⓐ의 `it.each` 전수표 + 「`running` 입력에 `gated-orphan` 을 답하면 RED」 음성 통제 + ⓑ의 「6필드 생존」 RED 1행. 실제 회수 CAS 호출부는 **PR7 명시 귀속** |
| 101 | 정정 100ⓑ 의 보존 계약 | 회수가 만드는 새 revision 의 계약이 **spec·계획 전수 0건**이다(CC-3·CC-4conc). 통합 4필드가 함께 소멸하면 불변식 ③ 이 **vacuously 만족**돼 어떤 게이트도 붉어지지 않는다 | `reclaimDraft` 계약을 명문화: **`sourceGeneration` 무변**(되돌리지 않는다 — §W-8 세대 귀속 보존) · `lifecycle` 무변 · 통합 4필드·`schemaVersion`·`identity` 무변. 구현 규범 = **rest 구조분해**(필드 명시 재조립은 새 필드가 늘 때 누락 표면을 신설한다 — 정정 99b 와 같은 근거). 스펙 §W-4 회수 문단에 이 표를 삽입 |
| 102 | 스펙 §W-4:509-517 · 계획 정정 58 | **`BenchLauncher` 의 반환 타입과 실패 보고가 스펙 안에서 모순 — 4렌즈 독립 수렴**(PLAT-6·GP-1·CC-4·TO-5). :510 은 `=> ChildProcess` 단일 반환인데 :516-517 은 「불일치는 throw 가 아니라 **판별 유니온 반환**(spawn 미수행)」이다. 정정 58 은 브랜드를 팩토리로 올리며 **반환 타입을 그대로 승계**해 모순을 닫지 못했다. 게다가 인용된 `SpawnOpts` 는 **레포에 존재하지 않는 타입**이다(전수 grep 0건 · 실재는 `cli/detect.ts:17` `RunOpts` 와 node `SpawnOptions`) | 반환을 **판별 유니온으로 확정**: `BenchSpawnResult = {kind:'spawned'; child: ChildProcess} \| {kind:'refused'; reason: 'commit-not-minted'\|'commit-spent'\|'gate-not-released'\|'identity-mismatch'\|'activity-mismatch'\|'generation-mismatch'}`. `opts` 타입은 **workbench 자체 정의**(`BenchSpawnOptions` — node `SpawnOptions` 부분집합). 스펙 §W-4 계약 4항 코드펜스를 이 값으로 정정(PR 본문 「스펙 정정」 등재) |
| 103 | 정정 102 의 「3필드 대조」 | 대조 **상대 피연산자가 PR2c 범위에 없다**(TO-5·CC-7·PLAT-6). `mintCommit` 이 identity·sourceGeneration·activityId 를 **커밋 자신에 싣기 때문에**(authority.ts:1251-1261) 팩토리가 commit 만 받으면 3필드 대조는 **항상 참인 vacuous 검사**가 된다 | 팩토리가 **대조 상대를 인자로 받는다**: `createBenchLauncher(deps: { spawn: BenchSpawn; commit: AuthorityCommit; expected: { identity; sourceGeneration; activityId } }): BenchLauncher`. 조작화 = 「expected 3필드를 각각 어긋뜨린 3행 + 일치 음성 통제 1행」. **`spawn` 은 주입**이라 팩토리가 실 spawn 을 호출하지 않는다 → cross-spawn 의존 0 · 전 행 페이크 커버 · 폐포 무영향(BUD-7·TO-6 수렴) |
| 104 | `AuthorityCommit` 크레덴셜 | **민팅 원장이 없다 — 형제 2종과 비대칭**(CC-5·CC-3conc). `mintRead` 는 `MINTED_READS` 에, `mintLease` 는 `MINTED_LEASES` 에 등재하는데(둘 다 **Codex P1 으로 강제된** 규율) `mintCommit`(authority.ts:1244-1262)은 freeze 만 하고 **어떤 원장에도 넣지 않는다**. 따라서 `{...commit}` 스프레드 복제가 **캐스트 0개로** WeakSet 을 우회하고, PR7 배선 층의 `x as AuthorityCommit` 은 eslint 스코프(워크벤치 전용) 밖이라 lint 도 통과한다 | `MINTED_COMMITS`·`SPENT_COMMITS` **모듈 스코프 원장** 신설(`mintCommit` 등재 · authority.ts:381-397 규율 그대로). 판정 순서 = ①원장 조회 ②소진 여부 ③게이트 ④3필드. RED 신설: 「필드를 그대로 베낀 위조/복제 커밋 → `refused` · spawn 0회」(authority-store.test.ts:1531-1620 복제 토큰 행 이식) |
| 105 | 소비 **단위**(CC-11) | 「commit 단일 사용」의 단위가 미정 — 팩토리 1회 소비면 만들어진 launcher 를 **여러 번 호출**해 자식 N개가 되고, §W-16 의 트리 사망 증거·활동 종결 CAS 가 전부 1:1 가정 위에 서 있어 무너진다 | **팩토리는 확인만, 소비는 launcher 호출 시점**. 두 번째 호출 = `refused{commit-spent}`. 「한 커밋 = 한 자식」이 집행되는 유일한 배치다 |
| 106 | `AuthorityCommit` 필드(CC-2conc) | **commit1(gated)과 commit2(running)이 `revision` 말고는 구별 불가**하다. 스펙 :469 「launcher 에 넘기는 것은 commit2」가 **관례로만** 존재해, PR7 배선자가 commit1 을 넘겨도 전 게이트 GREEN 인 채 「디스크 gated + 살아있는 자식」 = 스펙이 스스로 fail-open 이라 부른 상태가 만들어진다. 필드 추가는 `mintCommit`·계약 테스트를 함께 건드리므로 **PR7 에서 열면 훨씬 비싸다** | `AuthorityCommit` 에 **`execGate` 를 싣고**(mintCommit 이 `record.activeActivity.execGate` 를 그대로 복사) 런처가 `execGate !== 'running'` 커밋을 `refused{gate-not-released}` 로 거부한다. 관례를 **팩토리 계약으로 승격**. ⚠ 단일 CAS 로 줄이는 붕괴형은 여전히 미집행 — 그 한계를 주석에 병기 |
| 107 | 백오프 검증(TO-1·GP-4·PLAT-1) | **[10,20,40,80]ms 를 관측하는 §3 행이 0건**이고 주입 가능한 sleep seam 도 없다 → 「백오프 0ms」·「순서 역전」·「고정 5ms」 구현이 T17·T17b·T17c 를 **전부 GREEN** 으로 통과한다. C4 의 존재 이유(상대 핸들이 닫히기를 기다리는 시간 창)가 미검증 출하된다 | `BenchAuthorityStoreOptions` 에 **`sleep: (ms:number)=>Promise<void>` 필수 필드** 추가(형제 `providers/resilient.ts:9,84` 주입 패턴 승계 · 단 **선택적이 아니라 필수** — 기존 3필드가 전부 필수이고, 선택적이면 소비자 0 인 이 PR 에서 기본 구현이 **검증 없이** 착지한다). `realBackoffSleep` 을 함께 export 하고 fake timer 로 「타이머 1개 예약 → advance 후 resolve」를 고정. **§3-T17g 신설**: 기록된 지연 배열 `toEqual([10,20,40,80])` |
| 108 | 재시도 횟수·범위·대상(PLAT-2·PLAT-5·PLAT-13·TO-2·TO-8) | ⓐ「4회」의 지시 대상이 미정이라 `countOf('rename')` exact 를 쓸 수 없었다 ⓑ**재시도 비대상 코드에서 즉시 실패**해야 한다는 계약이 어디에도 없다 ⓒ**「재시도는 rename 단계에만」을 고정하는 falsifier 가 없다**(쓰기 전체를 감싸는 구현이 통과) ⓓ기존 §3-T16 의 실패 주입은 **`code` 없는 `Error`** 라 그 관용구를 복사하면 zero-retry 구현도 GREEN | **확정: 초기 1회 + 재시도 4회 = rename 총 5회 시도 · 대기 [10,20,40,80] · 총 150ms**(백오프 원소 4개를 전부 소비하는 유일한 해석이고 위 실측 절의 150ms 와 정합). 단언 3종 신설: 소진 시 `countOf('rename')===5` · **비대상 코드(ENOENT·EISDIR·code 없음)는 `countOf('rename')===1`** · rename 아닌 단계 실패 시 그 단계 `countOf===1`(재시도 범위 falsifier) |
| 109 | 재시도가 만드는 **첫 `await`**(CC-1 · 2렌즈) | 재시도 이전의 `writeDurably` 는 **동기**였다. async 가 되면 「`fn` 이 await 하지 않은 CAS」가 임계 구역 종료(`live=false`) 뒤에도 파일시스템을 변이하고 커밋 토큰을 민팅할 수 있다 — authority.ts:1164-1172 가 세운 「유출 tx 는 쓰지 못한다」(정정 94)의 우회 | 재시도 루프가 **매 회차 `live` 를 L-6 재검증과 같은 지점에서 재검사**하고 false 면 rename 없이 `lease-invalid{released}`. 기존 플래그 재사용이라 비용 ~3행 |
| 110 | eslint·레이어(GP-7·CC-12) | ⓐerrno 재시도 판정을 `switch (err.code)` 로 쓰면 **워크벤치 전수 assertNever selector**(eslint.config.mjs:430-446)를 만족시킬 수 없고 `ignores` 완화는 purity exact 핀이 RED 로 막는다 ⓑ**폐포 핀은 방향성**이라 workbench → `cli/detect.ts` 타입 import(레이어 역전)를 **못 잡는다** | ⓐerrno 분류는 **상수 `Set` + `has`**(`switch` 는 진짜 판별 유니온에만) ⓑ`BenchSpawnOptions` 를 workbench 가 자체 정의하고 **「workbench 는 `core/cli`·`core/mcp` 를 import 하지 않는다」 구조 핀 1행** 신설(authority-structure.test.ts 의 fs 방향 핀 동형) |

**분량 재도출**(BUD-1·2·3·11 — 셀 「700~1,000」은 정정 77 이후 **재도출되지 않은 stale** 이고 제목도
이미 PR2b 에 착지한 `commit-uncertain` 을 달고 있었다):

- §3 표 PR2c 셀 = 제목 「rename 재시도 · per-retry L-6 · gated-orphan 분류 · launcher 브랜드」 ·
  **착지 480~1,050 / 머지 740~1,710**(두 시점 분리 기재 — 유일 권위 측정은 정정 74 의 머지 직전 HEAD).
- **분할점 사전 확정**(「선언했다」가 아니라 「떼면 얼마가 남는지」까지 — PR1a·PR1c·PR2 3연속 재발 대응):
  **T9 종료 시 프로덕션 물리행 > 230 이면 T10 전량(타입·팩토리·원장·§3-T16b)을 PR2c′ 로 분리**한다.
  잔여 계산 = T9 단독 프로덕션 105~220 → 머지 420~1,075 / T10 단독 프로덕션 80~130 → 머지 320~635.
  두 태스크의 결합점은 §3-T17f 1행뿐이고 그 행은 **PR7 로 이월**되므로(아래) 분리 비용이 0 이다.
- 하네스 정리: T9 계열 테스트는 **`authority-retry.test.ts` 신설**(현행 `authority-store.test.ts` 1,819행 ·
  상한의 목적은 리뷰 가능성). 페이크에 `errno` export + `failSequence(op, errs[])` 추가를 T9 예산에
  **명시 계상**(BUD-10 — 3개 행의 하네스가 각 2~3행으로 줄어 순증이 오히려 감소한다).
- `durable-fs.ts` 는 **0행 변경**(주석 1줄 stale 정정 제외 — :119 가 「win32 rename 재시도」를 이 파일의
  행인 것처럼 열거하나 바로 다음 문장이 「규칙은 전부 주입 seam 위에」라고 명령한다 · BUD-4).
  `authority.ts` 물리행 before/after 를 PR 본문 기록 항목으로 고정(BUD-5 · 상한 신설은 하지 않는다 —
  이 레포가 PR2a 에서 실측으로 기각한 장치다).

**PR7 명시 이월**(조용한 누락 금지 · CC-6cont 가 「PR7 태스크 어디에도 귀속돼 있지 않다」를 적발):
§3-T17f(순서 대조) · `CAS1→commit1→CAS2→commit2→spawn` 시퀀서 · **spawn 실패 시 활동 종결 CAS** ·
실 spawn seam 배선 2곳 · bench-spawn eslint 가드(§3-T16c) · **gated-orphan 회수 CAS 호출부**.
PR2c 본문에 「§3-T16·T17·T17e 의 「CLI 미실행」 절은 런처 소비자 부재로 **이 PR 에서 vacuous**」를
명시 선언한다(계획 :559 `testop-17` 이 이미 확립한 정직 표기 관례).

#### PR2c 착지 기록 (2026-07-29)

**분량**: 순증 **1,381**(코드 1,258 · 문서 123 — 계획/스펙은 tracked 다). 상한 1,900 의 66% ·
셀 재도출값(머지 740~1,710) 안. **분할점 미발동** — T9 종료 시점 프로덕션 물리행 순증 **173 ≤ 230**
이라 사전 선언한 규칙대로 T10 을 같은 PR 에 유지했다(세 PR 연속 물렸던 계열을 처음으로 **계산으로**
통과한 사례다).

**게이트**: verify 7게이트 GREEN · 커버리지 **S93.51 B87.21 F94.51 L94.89**(floor 91/83/90/92 ·
착수 기준선 S93.39 B86.69 F94.30 L94.93 대비 S+0.12 B+0.52 F+0.21 L−0.04).

**뮤테이션 15종 전부 RED**(T9 8 · T10 7). 값 큰 것: 「재시도 제거」·「L-6 을 루프 밖으로」·「백오프 역전」·
「대상 코드 검사 제거」·「`live` 재검사 제거」·「소진을 팩토리-지역 플래그로」·「`execGate` 미탑재」·
「expected 스냅숏 제거」. ⚠ **1종(M7 「소진을 spawn 이후로」)이 처음에 무신호**였다 — spawn 성공 경로만
보면 두 구현이 동일하기 때문. spawn 이 던지는 행을 추가해 닫았다(`commit-spent` 로 재시도 차단).

**실 Linux 22/22 pass**(Docker `node:22.22.3` · `node:24` · `--user 1000:1000` · esbuild 번들 + plain node).
여기서만 증명되는 것: ⓐ**linux 는 대상이 열려 있어도 rename 이 성공**해 백오프가 0회다(win32 와 정확히
반대인 3면 실측의 코드 층 확인) ⓑ`realBackoffSleep` 이 **실제로 시간을 소비**한다(≥60ms) ⓒ회수 draft 가
실 FS 왕복에서 통합 필드·세대를 보존한다 ⓓ런처에 **실 `child_process.spawn` 을 주입해 진짜 자식이 뜨고**
종료 코드가 돌아오며, 두 번째 호출은 `commit-spent`·복제 커밋은 `commit-not-minted` 다.

**win32 실 FS 재시도 2행**(`authority-node.test.ts` · `describe.skipIf(!IS_WIN)`): 실 커널이 EPERM 을
내고 4회차에 커밋된다 / 핸들이 끝까지 열려 있으면 5회 시도 후 `io-failure`·대상 내용 불변.
**벽시계로 핸들을 닫지 않는다** — 백오프 총합이 150ms 라 CI 부하에서 순서가 뒤집혀 **정답 구현이
flake 로 RED** 가 된다. 실 어댑터를 **카운팅 데코레이터로 감싸** 「n회차 rename 직전에 닫는다」를 사건
순서로 고정했다.

**구현 중 실측으로 잡은 것 — 페이크가 실물보다 느슨했다**: 테스트 `sleep` 을 `Promise.resolve()` 로
두면 **마이크로태스크**라 재시도 루프가 `withAuthority` 의 `finally`(=`live=false`)보다 **먼저** 재개된다.
실 구현 `realBackoffSleep` 은 `setTimeout` = **매크로태스크**다. 그래서 정정 109(유출 tx 봉쇄)의
테스트가 「방어가 있는 구현」과 「없는 구현」을 구별하지 못했다(작성 중 RED 로 드러남 → 대기 0ms 를
유지하되 `setTimeout(…, 0)` 으로 **태스크 경계만 실물과 같게**). 형제 `lock-backend-fake` 가 확립한
「페이크가 실물보다 느슨하면 안 된다」 규율이 **시간 축에도 적용된다**는 새 사례다.

**자가 적대 리뷰**(ADR-0014 **봇 공백 4렌즈** — 프레임 전복·성능 정량·커버리지·동적 검증 공백 ·
27 후보). ⚠ 착수 전 감사(83중 1 기각)에 이어 **이번에도 refuter 가 0건 기각**해 메인 루프가 전수
재판정했다 — 「refuter 의 잘못된 강등」(PR2b 교훈 ②)의 **반대 방향 실패**가 2회 연속이다.
반영한 것:

| # | 지적 | 조치 |
|---|---|---|
| **F1**(P1) | **내가 이 PR 에서 추가한 레이어 핀이 무신호였다** — 정규식이 `../` 를 **1단만** 허용해 같은 모듈을 가리키는 정상 철자 `../../core/cli/detect`(루트)·`../../cli/detect`(하위 디렉터리)를 둘 다 통과시켰다. 게다가 앵커가 술어 **사본**을 검사해 붕괴를 영원히 못 잡았다(형제 앵커 3종은 상수 공유 — 이 핀만 비대칭) | 문자열 패턴 → **경로 해소**(`resolve` 후 「코어 아래 ∧ 워크벤치 밖」) + **허용 이웃 exact 목록**(`workspace` — `coord-area`·`active-instance` 의 정당한 의존이 실제로 잡혔다) + 앵커가 **가드와 같은 함수**를 태우고 하위 디렉터리 기준까지 검사 |
| **DYN4-01**(P1) | `renameWithRetry` 의 **attempt 0 재검증만** 지워도 전 게이트 GREEN — 기존 뮤턴트는 「루프 전체를 밖으로」만 다뤘고 「1회차만 건너뜀」 축이 비어 있었다(CAS ② 재검증이 먼저 잡아 준다) | ②를 통과시킨 **뒤**(쓰기 진입 후) 탈취하는 행 신설 — `openExclusive` 훅으로 그 창을 정확히 겨눈다 |
| **DYN4-02**(P2) | 신규 seam 2종(`sleep`·`spawn`)의 「기본값 금지」가 **주석 문면뿐** — 형제 fs seam 은 구조 핀을 갖는데 비대칭 | 옵셔널화·값 import·`setTimeout` 개수 핀 3행 + 자기검사 앵커 |
| **F5**(P2) | 내가 넣은 `neverSleeps` 가 **throw** 라 그 오류가 CAS `catch` 에서 `io-failure{rename}` 로 **재라벨**돼 기대값과 우연히 일치 → 「모든 오류 재시도」 뮤턴트를 **덮었다**(정확히 그 헬퍼가 막으려던 회귀) | 흐름을 바꾸지 않는 **기록형** + `afterEach` 단언 |
| **F2**(P2) | `BenchSpawnOptions` 가 **이 계획 자신의 정정 57** 이 확정한 5필드 중 `stdio?`·`detached?` 를 무기록 누락(`detect.ts` 만 보고 부분집합을 도출) — `mcp/stdio.ts` 는 `stdio` 를 필수로 넘기고 §W-16 은 `detached` 를 P1 으로 요구 | 두 필드 추가(옵셔널 가산이라 테스트 수정 0) |
| **F3**(P2) | 커밋 원장 주석이 **「한 활동 = 한 자식」**을 이 원장의 성질처럼 서술 — 실측상 활동 진행 중 상태 갱신 CAS 가 **두 번째 launchable 커밋**을 민팅한다 | 보장 범위를 「한 커밋 = 한 자식」으로 정정하고 활동 스코프는 **PR7 시퀀서 소관**임을 명시 |
| **PERF-1**(P2) | `for(;;)` 의 종료가 `backoff === undefined` **하나**뿐 — 그 한 줄이 사라지면 리스+뮤텍스를 쥔 무한 루프(hang 은 RED 가 아니다) | 유계 루프 + 소진 없이 종료 시 `io-failure` 반환(암묵 `undefined` = 「커밋됐다」는 거짓 증언 방지) |
| **COV-2·DYN4-06**(P2) | rename 을 `renameWithRetry` 로 옮긴 뒤 `catch` 의 `step === 'rename' ? path` arm 이 **어느 OS 에서도 도달 불가** | 삼항에서 제거 + 이유를 주석에 |
| **DYN4-03·DYN4-04**(P2) | 재시도 스위트가 `file-only` 한 축에서만 돌아 **재시도 × post-commit 조합 0건** / 런처 스냅숏 규율이 **최상위 한 필드**만 검증 | 각각 1행 신설(post-commit 시퀀스 단언 · `expected.identity` 중첩 축) |
| **F4·F7**(P3) | spawn 실패 테스트의 라벨이 실 seam 의 지배적 형태(비동기 `'error'`)와 다름 / 「총 150ms」는 모듈이 아니라 **주입된 sleep** 의 성질 | 정직 표기 주석 2곳 |

**리뷰 반영 후 뮤테이션 5종 추가 실측**(전부 RED · 총 **20 뮤턴트**): attempt 0 재검증 건너뜀 ·
sleep seam 옵셔널화 · `expected.identity` 참조 유지 · 레이어 역전 주입(`../../core/cli`) ·
재시도 범위를 post-commit 까지 확대. 유계 루프 상한 제거만 GREEN 인데 **그것이 정답**이다
(동작을 바꾸지 않는 **구조** 방어이므로 행동 테스트가 잡을 대상이 아니다 — 이 구분을 뮤턴트 기대값에
명시했다).

**최종 분량**: 전체 순증 **1,621**(코드 1,464) · `authority.ts` 1,262 → **1,582**. 리뷰 하드닝 팽창률
**1.17**(1,381 → 1,621). 상한 1,900 의 85% 로 **이내**이나 착지 목표(상한의 60~65%)는 **초과**했다 —
은폐하지 않는다. 초과분의 대부분은 위 표의 방어 신설이고, 그 대신 「선언만 하고 실재하지 않던 핀」이
셋(F1·DYN4-02·F5) 닫혔다.

**봇 리뷰 1R**(PR #267 · CI 7/7 pass):

**Codex P1×1 — 실측 재현 후 수용.** 「재시도의 `await` 가 **같은 임계 구역 안 두 CAS 의 겹침**을 새로
열었다」. PR2c 이전에는 `compareAndSwap` 이 전 구간 동기라 도달 불가였던 상태다. 재현한 파괴 사슬:
ⓐA 가 tmp 를 만들고 rename EPERM 으로 백오프에서 양보 ⓑB 가 진입해 `openExclusive` 에서 **EEXIST**
(A 의 tmp) ⓒB 의 `finally` 가 「자기 tmp 정리」로 **A 의 tmp 를 unlink** ⓓA 가 깨어나 rename 하면
**ENOENT** — 재시도만 했으면 성공했을 CAS 가 남의 정리에 파괴된다(실측: A=`io-failure{rename,ENOENT}` ·
B=`io-failure{open-tmp,EEXIST}` · 디스크 잔여 0).
→ **tx-지역 in-flight 가드**(겹침 시 `invariant-violation`). Codex 가 병기한 대안(CAS 별 고유 tmp)은
**기각** — tmp 가 `ownerToken` 스코프인 것이 정정 78 의 「같은 리스의 다음 CAS 가 자기 tmp 로
자기잠금」 falsifier 의 근거라 이름을 바꾸면 그 계약 테스트가 무의미해진다. 직렬화는 §W-4 문면
(「**전체**를 하나의 임계 구역」)과도 정합한다.
⚠ **PR2b 가 철회한 재진입 가드와 다르다**: 그것은 `withAuthority` **호출 간** 중첩을 `AsyncLocalStorage`
로 감지해 거짓 양성 3종을 냈다. 이것은 **한 tx 객체 안** 단순 플래그 + `finally` 즉시 해제라 순차
호출에 영향이 0 이고, **그 음성 통제를 계약 테스트가 고정한다**(비용 비대칭 판단 기준 승계).

**CodeRabbit 4건 전부 수용**: ⓐ내가 쓴 **스펙 T17b 관측면 서술이 착지물과 어긋났다** — 「`MINTED_COMMITS`
원장 크기」라 적었는데 그것은 `WeakSet` 이라 **크기를 셀 수 없다**(실제 관측면 = 디스크 revision +
`countOf('openExclusive')`). 이 계획이 스스로 경계하는 「선언만 하고 실재하지 않는 핀」을 문서에서
반복한 셈이다 ⓑ`authority-launcher.test.ts` 의 `neverSleeps` 만 throw 로 남아 형제 두 스위트와 비대칭
(F5 와 같은 재라벨 함정이 훗날 재발) ⓒ`reclaimDraft` JSDoc 이 런처 섹션 배너에 밀려 **고아 주석**이
됐다 ⓓ§3-T16b 의 `@ts-expect-error` 가 서는 이유를 **브랜드 부재 하나로** 좁히도록 구조 필드를 채움.

**뮤테이션 21종째**(가드 제거 → RED 확인). 최종 verify: **2544 pass / 57 skip** · S93.48 B87.22
F94.53 L94.88 · 실 Linux 22/22 재확인.

**교훈**: **「전 구간 동기」가 주던 안전을 async 승격이 조용히 거둬간다.** 정정 109(유출 tx 봉쇄)는
「임계 구역 **종료 후**」를 닫았는데, 같은 승격이 「임계 구역 **안** 겹침」이라는 형제 구멍을 함께
열었고 그쪽은 감사·자가리뷰 8렌즈가 전부 놓쳤다(봇이 잡았다). 동기→비동기 전환에서는 **그 함수가
독점하던 자원을 전수 열거**해야 한다 — 여기서는 리스 스코프 tmp 경로였다.

**머지 전 실증 라운드**(사용자가 「실증 테스트해」라고 물어 시작 — 갭 2개 적발. PR2a·PR2b 에 이어
**3회차 동형 재발**):

1. **사슬 전체가 이어 붙은 적이 없었다.** 각 조각(`commit-uncertain` 반환 · 분류 · 회수 draft)은 페이크로
   검증됐지만 §W-4 「`commit-uncertain` 복구」의 **종단** — 「post-commit 실패로 디스크에만 남은
   `execGate:'gated'` 를 **다른 프로세스**가 분류해 회수한다」 — 는 어디서도 연결되지 않았다.
   실 프로세스 급사(SIGKILL)로 잔재를 만들고 새 프로세스가 복구자 역할을 하는 **컨테이너 e2e 3시나리오**
   (19~20 단언 · node 22.22.3 · 24)를 짰다: ⓐ`commit-uncertain` → 급사 → 재시작 분류·회수(세대·통합
   필드 보존 · 회수 후 `none` = 멱등 방향) ⓑ**재시도 백오프 중 급사** → tmp 잔재 → 새 소유자(다른
   `ownerToken`)가 자기잠금 없이 커밋하고 **남의 잔재는 지우지 않는다** ⓒ`running` 잔재 음성 통제.
2. ⚠ **그 실증의 첫 판이 엉뚱한 경로를 탔다** — `openDir` 을 통째로 막았더니 `file+dir` 첫 CAS 가
   **rename 이전에** 부모 디렉터리를 fsync 하는 바람에(Codex PR#266 2R P1) `io-failure{mkdir}` 로 죽어
   「commit-uncertain 잔재」를 애초에 만들지 못했다. post-commit **차례만** 겨냥해 고쳤다.
   **실증도 조작을 틀리면 다른 사실을 증명한다**(PR2b 교훈 ⑤의 직접 재현).
3. ⚠ **실증 안에 vacuous 한 단언이 하나 있었다** — 「죽은 소유자의 리스를 새로 획득할 수 있다」는
   페이크 락 백엔드가 프로세스마다 자기 네임스페이스를 갖기 때문에 **항상 성공**한다. 삭제하고 근거
   (크로스 프로세스 리스 배타는 PR1b 가 실 추상 소켓 + 실 fork 로 검증)를 주석에 남겼다.
4. **실증 자체의 반증력을 뮤테이션으로 확인**했다(4/5 RED): classify 가 running 도 회수 적격 /
   `reclaimDraft` 가 세대 되돌림 / 활동을 남김 / post-commit 실패를 `io-failure` 로 오분류.
   1종(「rename 성공 후에도 tmp 정리 호출」)은 **동치 뮤턴트**였고(자기 tmp 는 이미 없어 no-op),
   그것은 **단위 층이 잡는다**(호출 카운트 단언 → 3 fail 실측) — 층 분업이 정확함을 확인한 셈이다.
5. **일회성으로 두지 않았다.** 스크래치패드 e2e 는 CI 에서 돌지 않으므로 회귀 가드가 아니다 →
   핵심 시나리오(ⓐ·ⓒ)를 `authority-node.test.ts` 에 **실 프로세스 급사 형태 그대로** 이식했고,
   두 행 각각의 반증력도 뮤턴트로 확인했다(각 1 fail).

최종 verify: **2546 pass / 57 skip** · S93.48 B87.22 F94.53 L94.88.

**배포 근사 라운드**(사용자가 「방금 한 테스트는 라이브 테스트냐」고 물어 시작 — 그때까지의 검증이
전부 컨테이너 **tmpfs** 였다는 것이 드러났다). 실제 `fleet-server` 이미지(uid 1000=node) + 실제
`/workspace` **bind mount** 위에 배포 레이아웃(`/workspace/<repo>/.git/fleet/authority`)을 만들어
13 단언 통과: bind mount 위 `probeDurability='file+dir'` · 파일 모드 0600 · rename 원자 교체 ·
재시도 4회 + 실 백오프 ≥60ms · 크래시 잔재 회수 종단 · tmp 잔재 0.

⚠ **그럼에도 라이브가 아니며, 이 근사를 라이브 근거로 인용하면 안 된다** — 위 §2 표에 등재한 대로
Docker Desktop 이 bind mount 권한을 가상화한다(`owner=0:0 mode=777`). 그리고 **애초에 라이브에서 이
코드에 도달할 경로가 없다**(소비자 0 이 계약이고 폐포 핀이 그것을 강제한다) — 첫 라이브 실행 시점은
**PR7 배선 이후**다. 검증 층위를 정직하게 적으면: 단위(페이크) → 실 FS(win32/linux) → 실 프로세스
(컨테이너) → **배포 근사** → ~~라이브~~(PR7).

#### PR3 착수 전 실측 정정 (2026-07-29 · 6렌즈 감사 + **4면 git 실측**)

**4면 git 실측** — win32 **2.54.0** / linux **2.39.5**(배포 런타임 = `deploy/fleet/Dockerfile:36` apt bookworm) /
linux **2.30.2**(pre-2.38 falsifier) / linux **2.54.0**(`alpine/git` · 플랫폼 축 특정용). 전부 실 git 프로세스다.

| # | 대상 | 사실(실측 → 판정) | 조치(착수 전 확정) |
|---|---|---|---|
| 111 | §3 분할표 PR3 셀 | **stale**. 정정 70(§3-T18b ref-앵커)·78ⓒ(크래시 tmp 수확기)·85(§3-T20 raw 분)·86ⓑ 가 전부 PR3 으로 이월됐는데 셀은 그 뒤 **재도출되지 않았다**(PR2c 셀이 겪은 것과 동형). BUD 렌즈 추정은 T11 단독 ~525 프로덕션행이었으나 **실측 착지는 248** 이었다(추정이 2.1배 과대) | **PR3a/PR3b 2분할**. PR3a = T11·T12(실측 768 · 프로덕션 248) · PR3b = T13 + 이월 3건. FS-1(「T12 만 동작을 바꾸므로 별도 PR」)은 정정 115 로 **기각**됐다 |
| 112 | 스펙 §3-T25 · `MergeTreeResult` | **`merge-tree --write-tree` 는 충돌과 인자 오류를 같은 exit 1 로 낸다**(4면 공통). 충돌은 stdout 첫 줄이 트리 OID, **인자 오류(비커밋 인자·없는 rev)는 stdout 이 빈 문자열**, 무관 히스토리는 128. 종료코드로 충돌을 판정하면 `baseRef` 오타가 「머지 충돌」로 보고돼 WAL 이 충돌 경로로 전이한다 | 판별식을 **stdout 첫 줄이 40/64 hex OID 인가**로 확정. §3-T25 에 **음성 통제 2행**(트리 인자·없는 rev → 충돌 아닌 실패) 신설. `--name-only` 사용(충돌 보고를 파일명 1행으로) · **`--merge-base` 금지**(2.39.5 에 없는 옵션 — exit 129) |
| 113 | 스펙 §W-6 `refExists` · §W-7 복구 판정 · §3-T23·T34 | **win32 git 은 packed 상태의 D/F 를 막지 못한다**(linux 2.54 는 막는다 → **플랫폼 축**). 막아 주던 것은 packed-refs 검사가 아니라 **reflog 디렉터리**였고(`there are still logs under …`), 우리 네임스페이스 `refs/fleet/` 에는 reflog 가 없다(`refs/tags/` 도 같다). 그 공존 상태의 실측 산출: ⓐ`for-each-ref` 는 열거하는데 `rev-parse --verify`·`show-ref --verify` 는 **부재**로 답한다 ⓑ소비자 `merge --ff-only` 가 `not something we can merge` 로 실패한다 ⓒ**같은 bench 의 다음 txn 발행이 128 로 봉쇄**된다 ⓓ`gc` 가 bare 까지 packed 로 밀면 둘 다 다시 해소된다(관측 시점 의존). 완화안 `core.logAllRefUpdates=always` 는 **실측으로 기각**(reflog 가 생겨도 bare 생성이 그대로 성공) | `GitRepo` 에 **열거 프리미티브 `listRefs(prefix)` 신설**(§W-6 코드펜스에 없던 것 — 3렌즈 독립 수렴 CD-1·FS-3·LAY-4). `refExists` 를 **열거 기반**으로 확정(스펙은 그 구현을 규정한 적이 없다 — `rev-parse --verify -q` 주석은 `revParse` 행 소유). **발행 왕복 검증** 신설: CAS 성공 후 열거로 재확인해 불일치면 fail-closed. `REF_NAMESPACE_CONFLICT` 는 **git 의 거부에 의존하지 않고** 열거로 자체 판정 |
| 114 | 스펙 §3-T58 조작화 | **원안이 구성 불가능하다**(4면 공통): 메인 `index.lock` 아래에서 `worktree add --detach`/`-b`·`update-ref`·`merge-tree`·`for-each-ref`·`rev-parse` 가 **전부 exit 0** 이다 — 실패가 없어 재시도·삭제 분기가 발화하지 않는다. §W-6 의 「worktree 연산이 공통 gitdir 을 다투므로 오조준」이라는 **근거 문장 자체가 index.lock 축에서 거짓**이다 | 조작화를 **F4c 형태**로 재정의: 대상 ref 의 `.lock` 선점(→ `update-ref` 가 128 + `LOCK_RE` 매칭) + **무관한 `index.lock` 동시 존재** → 신규 경로는 그 파일을 **보존**하고 유계 재시도 후 값으로 실패. `ok()` 위임 뮤턴트는 그 파일을 지워 RED(실측 확인) |
| 115 | 스펙 §3-T58b · 계획 §5-9 · 위험 R8 | 「R-5 전환이 레거시 #80 worktree **생성 성공률**을 바꾼다」가 **거짓**이다. 레거시가 실제로 쓰는 두 인자(`worktree add --detach`·`worktree remove --force`)를 5종 락 선점(index/packed-refs/HEAD/refs-heads/worktree-admin)에 전수로 태웠더니 **전부 exit 0** — `ok()` 의 재시도·삭제 분기가 그 경로에서 **도달 불가**다. 성공률도 부작용도 불변 | R-5 스코프를 **신규 연산 한정**으로 확정하고 레거시는 **무변경**. §3-T58b 를 「성공률 변화 단언」 → **「레거시 무변경 회귀 핀」** 으로, §5-9 를 「명시 변경」 → **「무회귀 + 증명 의무」** 로 재분류. `ok()` 의 삭제가 실제로 도는 곳은 **인덱스 경로**(`ensureRepo`·`collectDiff`·`keep`·`revert`)이며 그 위험은 이 PR 이 건드리지 않는다(잔존 명시) |
| 116 | 스펙 §1(:377-382) 위임 | **`RefCasResult`·`MergeTreeResult` 가 레포 전수 grep 상 스펙 3곳에만 있고 계획·코드에 0건**이다. 스펙은 그 둘을 명시 열거하며 「계획 단계에서 **파일 배치까지 확정**한다 · 정의 없는 타입을 구현이 임의 창작하지 않는다」고 못박았다 — §W-4 분은 이행됐고 **§W-6 분만 미이행**(PR2c `SpawnOpts` 계열이나 이번엔 착수 전 적발) | 두 타입을 `workspace/git.ts` 에 정의 확정. `RefCasResult` 의 `rejected` 는 **재조회한 실제 값**을 싣는다 — 「이미 존재」와 「기대값 불일치」가 **둘 다 exit 128** 이고 문면은 버전마다 다를 수 있어 **문자열 분류를 쓰지 않는다**(그 방식이 곧 `LOCK_RE` 계열 재발이다) |
| 117 | 스펙 §W-6 `isAncestor(): Promise<boolean>` | `merge-base --is-ancestor` 는 **0/1/128 3값**이다(4면 공통 · 128 = 해소 불가 OID). boolean 으로 접으면 「사용자가 base 브랜치를 지웠다」가 **「아직 미완결」로 조용히 오분류**돼 bench 가 무진단 대기로 굳는다(U4 「조용한 강등 금지」의 직접 사례) | 반환을 `{status:'yes'}`\|`{status:'no'}`\|`GitFailure` 3값으로 확정 |
| 118 | 스펙 §W-6 코드펜스 반환형 | 코드펜스는 `Promise<string>`·`Promise<void>`·`Promise<boolean>`(실패 = throw)인데 **같은 절이 「실패를 값으로 반환」을 관용구로 명시**하고, 기 착지분(`GitRepoDirResult`)과 소비자(`coord-area.ts`)는 이미 판별 유니온에 결속돼 있다 — 문서 내부 모순 | 신규 전 메서드를 **판별 유니온**으로 통일(`GitOpResult`·`GitOidResult`·`GitRevParseResult`·`GitRefListResult`·`GitRefExistsResult`) |
| 119 | 계획 :940 「나머지 **8**메서드」 | 스펙 인터페이스 전수 계수는 **11**(착지 2 제외 시 9)이고, 정정 113 의 `listRefs` + 코드펜스에 없던 **능력 프로브(`probeMergeTree`)** 까지 더하면 **11** 이다(⚠ 초판 정정은 프로브를 빼고 「10」이라 적었다 — CodeRabbit PR#268 이 착지물 계수와 대조해 적발했다) | 「나머지 **11**메서드」로 정정. 완료 조건을 계수로 두면 누락이 PR5 착수 시점에야 발각된다 |
| 120 | 스펙 §3-T58b·계획 T12 의 코드 인용 | `git.ts:191`·`:233` 은 **현재 파일에서 다른 것**을 가리킨다(:191 = `sanitize` 주석 · :233 = `commit()` 내부). 실제 위치는 `addWorktree` 의 `ok()` 호출 **:304**, `removeWorktree` **:346** — PR1a 가 `GitRepo` 를 추가하며 ~110행 밀렸다 | 인용을 `:304`·`:346` 으로 갱신(라인 인용은 PR 마다 밀린다는 사실을 문면에 남긴다) |
| 121 | 스펙 §W-6 `update-ref --stdin` 금지 조항 | **`--batch-updates` 는 배포 런타임(2.39.5)·2.30.2 에 존재조차 하지 않는다**(exit 129 unknown option). 2.54 에만 있고 거기서는 **거부에도 exit 0** + stdout `rejected …` 다 | 금지는 유지하되 근거를 「2.54 에서 무성 통과 + 하위 버전엔 부재」로 정확히 기록. 발행은 **단발 `update-ref <ref> <new> <old>`**(`old` 빈 문자열 = create-if-absent — SHA-256 레포에서 길이가 달라지는 40×0 대신) |
| 122 | 스펙 §W-7 「③→④→⑤ 같은 락 구간」 | 외부(ttyd 셸) `gc --prune=now` 가 ④와 ⑤ 사이에 개입하면 `commit-tree` 산출 커밋이 수거된다 — 실측 결과 `update-ref` 가 **exit 128 `trying to write ref … with nonexistent object`** 로 실패하고 **ref 는 생기지 않는다** | **fail-closed 확인**(조용한 손상 아님). 대응 = 값으로 실패시키고 txn 재시도(멱등)에 맡긴다. 자문 락이 ttyd 를 막지 못한다는 비목표는 그대로 유지 |
| 123 | 스펙 §W-7 ref-앵커 판정식(:712-715) ↔ 포기표(:726) ↔ §3-T29 | **귀속 슬롯 카디널리티 모순**(반증 CONFIRMED): 판정식은 「`currentIntegrationTxnId`·`completedIntegrationTxnId` **어디에도 귀속되지 않는** 결과 ref 1건이라도 존재 → reconciliation」인데, 포기는 결과 ref 를 **보존**하고(:726) §3-T29 는 형제 시도 ref 의 **영구 공존을 정상 시나리오로 요구**한다. 슬롯은 2개뿐이라 포기·superseded 잔여분이 **영구 오탐**을 만든다 | **PR3b 착수 전 설계 결정 항목으로 승격**(이 PR 범위 밖). 유력안 = 권위 레코드에 **단조 최대 `highestIntegrationTxnId`**(ULID 는 사전순=시간순이므로 「그보다 새 txn 의 ref 존재」만 롤백 증거) — 누적 배열보다 무한 성장이 없다. 결정 전에는 T34 를 착지시키지 않는다 |
| 124 | FS-2(사슬 미연결 4회차 재발) | PR2a·PR2b·PR2c 가 **3회 연속** 「조각은 검증됐지만 사슬이 이어 붙은 적 없음」을 머지 직전에야 적발했고, PR3b 의 저널 소비자는 **PR5 T18** 이라 같은 구조가 반복된다 | PR3b 태스크에 **종단 실증 1라운드를 사전 계상**(실 프로세스 급사 → 재시작 복구까지). 이을 수 없는 절은 PR2c 가 확립한 정직 표기(「이 PR 에서 vacuous」)로 선언 |
| 125 | `coord-area.ts` 의 `GitRepo` 의존 | 인터페이스가 2 → 12메서드로 커지면서 **테스트 더블 4곳이 계약과 무관하게 커지는** 리플이 발생했다(tsc 실측) | `OpenAreaOptions.repo` 를 **`Pick<GitRepo,'commonGitDir'>`** 로 좁혔다 — 리플 0 이 되고, 영역 개방 경로가 **ref·worktree 변이 권한을 쥐지 않는다**는 안전 성질이 타입으로 생긴다 |
| 126 | 뮤테이션이 잡은 자기 공백 2건 | 착지 직후 9종 뮤턴트 중 **2종이 GREEN 이었다**: ⓐ「단일 ref 재조회를 접두 매칭으로」 ⓑ「발행 왕복 검증 제거」 | ⓐ 「자식이 있어도 부모는 부재 · 그 자리 bare 생성은 `rejected` 가 아니라 `failed`」 1행 ⓑ 「update-ref 는 성공을 자칭하는데 열거가 모르는」 주입 러너 1행 신설 → 재실행 시 **9/9 RED** |

| 127 | `listRefs`·단일 재조회의 성공 판정(**Codex PR#268 P1** · 2면 실측 win32 2.54 / linux 2.39.5) | **`for-each-ref` 는 손상된 loose ref 를 만나면 exit 0 인 채 그 ref 를 목록에서 빼고 `warning: ignoring broken ref …` 만 낸다**(내용이 OID 아님·잘림·빈 파일·dangling 4종 전부 동일). 종료코드만 보는 구현은 「정상 열거 · 그 ref 없음」으로 읽는데, §W-7 복구 판정과 ref-앵커는 **부재를 「발행되지 않았다」의 증거**로 쓴다 → **손상된 published 결과 ref 가 포기 적격으로 오판**된다(fail-open) | 열거·단일 재조회 모두 **stderr 의 손상 경고를 fail-closed 로** 승격. ⚠ 범위는 정직하게 좁힌다 — 경고는 **질의 접두 안에 손상이 있을 때만** 나므로 무관한 단일 ref 조회는 계속 정상이다(과잉 차단하면 손상 하나가 레포 전 연산을 멈춘다). 두 축 모두 테스트로 고정 |
| 128 | 능력 프로브의 **재프로브 규범**(Codex PR#268 P1 잔여) | 프로브는 **부팅 1회**이고 `false` 가 통합을 끄는데, `HEAD` 의존이라 **커밋 없는 레포**에서는 재시작 없이 되살릴 방법이 없다 | 정정 반영으로 결과가 3분류가 됐으므로(`unsupported`/`indeterminate`) **부팅 배선(PR7)의 규범을 여기서 확정**한다: `unsupported` = 영구 비활성(버전 증거) · **`indeterminate` = 비활성하되 `ensureRepo`·첫 커밋 이후 재프로브**(레포 상태 증거이므로 되살아날 수 있다). 이 규범을 스펙 §W-6 에 명문화 |

| 129 | `casUpdateRef` 의 발행(**Codex PR#268 2R P1** · win32 실측) | **`update-ref` 는 기본적으로 symref 를 따라간다.** 대상 자리가 dangling symbolic ref(`refs/fleet/integrated/B/T1 → refs/heads/other`)면 create-if-absent 가 ⓐ**우리 네임스페이스 밖 `refs/heads/other` 를 만들고** ⓑexit 0 을 내며 ⓒtxn ref 는 symbolic 인 채 새 OID 로 해소돼 **왕복 검증까지 통과**한다 → `updated` 오답. create-if-absent 계약 위반이자 「결과 ref 는 불변」의 붕괴(발행물이 **가변 대상의 별칭**이 된다) | 발행에 **`--no-deref`** 를 싣는다(실측: `dangling symref already exists` exit 128 fail-closed · 정상 ref 발행에는 영향 0). 실 git 행 2개 신설(symref 자리 거부 + 정상 발행 회귀 통제) |
| 130 | 정정 127 의 손상 ref 가드(**Codex PR#268 2R P1**) | 가드를 **영어 문면(`ignoring broken ref`) 매칭**으로 구현했는데 그 경고는 git 의 **번역 대상 문자열**이다 — 비영어 `LC_MESSAGES`/`LANG` 아래에서 정규식이 빗나가면 가드가 통째로 무력화돼 **정정 127 이 닫으려던 fail-open 이 그대로 되돌아온다** | 판정을 **로케일 독립 구조 규칙**으로 교체: 「exit 0 인데 **stderr 가 비어 있지 않다**」 = 열거 불완전 → fail-closed. 정규식은 **진단 라벨**로만 남긴다(`for-each-ref` 는 정상 경로에서 stderr 에 아무것도 쓰지 않으므로 과잉 차단이 아니다). 독일어 경고 픽스처로 고정 |
| 131 | `mergeTree` 의 충돌 판정(**Codex PR#268 2R P1**) | 「첫 줄이 OID ∧ code≠0 → 충돌」이었는데, 러너는 **취소·타임아웃·10MB 출력 상한**에서 **부분 stdout 을 보존한 채 `code: null`** 을 돌려준다(`cli/detect.ts:86` 계열) → **중단된 연산이 「충돌로 끝난 통합」으로 기록**된다(큰 충돌·사용자 취소가 정확히 그 경로) | **충돌은 exit 1 뿐**으로 좁힌다(0 = clean · 그 외 전부 failed). `code:null`·`code:137` 픽스처 + 정상 충돌 대조군으로 고정 |

**PR3a 착지 기록 (2026-07-29)**

- **분량**: 순증 **1,143**(src 1,057 · 문서 86 · **프로덕션 물리행 272**). 상한 1,900 의 **60%** =
  착지 목표(60~65%) **이내**. 자가 리뷰 전 768 → 반영 후 1,143 이므로 **하드닝 팽창률 1.49**
  (PR2c 1.17 보다 크다 — 그 대가로 「선언만 되고 검증되지 않던 방어」 3건이 닫혔다).
  ⚠ BUD 렌즈의 T11 추정(프로덕션 525행)은 **실측 272 로 1.9배 과대**였다 — 다음 PR 추정의 보정 계수.
- **게이트**: verify 7게이트 GREEN · vitest **2582 pass / 57 skip**(108 파일) ·
  커버리지 **S93.62 B87.40 F94.64 L94.98**(floor 91/83/90/92 · 착수 기준선 S93.48 B87.22 F94.53 L94.88
  대비 **S+0.14 B+0.18 F+0.11 L+0.10 — 네 메트릭 전부 상승**).
- **뮤테이션 17종 전부 RED**(봇 리뷰 반영분 포함: 「손상 ref 가드 제거」·「`signal` 미전달」).
  값 큰 것: 「merge-tree 판별을 종료코드로」·「refExists 를 rev-parse 로」·
  「is-ancestor 128 을 no 로」·「재시도 제거」·「재시도 범위를 모든 실패로」·「열거 exact 를 접두로」·
  「능력 프로브 항상 true」·「왕복 검증 제거」·**「worktree 3메서드의 재시도 배선 제거」**·
  **「재시도 판별을 다시 넓힘」**·**「왕복 검증 두 문면을 하나로」**.
  ⚠ **처음에 GREEN(무신호)이던 것이 5종**이었다(정정 126 의 2종 + 자가 리뷰가 잡은 3종) — 착지 직후의
  「전부 RED」는 **보강 후**의 상태이며, 그 전에는 방어 3건이 선언만 존재했다는 사실을 남긴다.
- **실 Linux 대조**: 배포 런타임(`node:24-bookworm-slim` + apt git **2.39.5** · uid 1000 · esbuild 번들 +
  plain node) **30/30** · pre-2.38(`node:22-bullseye-slim` + git **2.30.2**) **23/23**(능력 프로브가
  미지원을 정확히 답하고 통합 계약이 구조적으로 건너뛰어짐). win32 packed D/F 구멍이 linux 에서는
  **양방향 거부**로 나타나는 것도 같은 실행에서 확인했다.
- **스폰 비용 정량**(자가 리뷰 SR-P1): `casUpdateRef` 1회 = `update-ref` 1 + 재조회 1 = **2 스폰**
  (락 경합 최악 5) · `listRefs`·`revParse`·`refExists`·`isAncestor` 각 1 · 통합 트랜잭션 1회 최소 **4**.

**실증 라운드(2026-07-29 · 사용자가 「실증·라이브 테스트는 안 해도 되냐」고 물어 시작 — PR2a·PR2b·PR2c 에
이어 4회차 동형 질문이며, 정정 124 로 예고해 두고도 이 PR 에 적용하지 않았다는 사실을 기록한다)**

1. **실 프로세스 급사로 만든 ref 락 잔재**(배포 런타임 git 2.39.5 · uid 1000 · **10/10**). 잔재의 출처를
   합성 파일이 아니라 **죽은 git 프로세스**로 만들었다 — `reference-transaction` 훅(git ≥2.28)은 **락을 쥔
   prepared 상태**에서 호출되므로 거기서 잠든 git 을 SIGKILL 하면 진짜 크래시 잔재가 남는다. 그 위에서
   **다른 프로세스**가 프로덕션 CAS 를 실행: fail-closed · 유계 재시도 [10,20,40] · 남의 `index.lock` 보존 ·
   경합 `.lock` 보존 · 열거는 정상 응답 · **잔재 제거 시 즉시 발행 성공**(고착 원인의 음성 통제).
2. ⚠ **그 실증이 드러낸 운영상 한계(정직 표기)**: 스테일 ref 락은 **아무도 치우지 않는다** — R-5 가 삭제를
   금지했고 git 도 스스로 치우지 않는다. 따라서 그 txn ref 는 **사람이 지울 때까지 영구 고착**된다.
   손상은 없지만(fail-closed) **자동 회복도 없다.** 관측·회수는 **PR3b 소관으로 명시 이월**한다
   (정정 78 의 크래시 tmp 수확기와 같은 계열의 문제다).
3. **배포 근사**: 실 `fleet-server:local` 이미지 + 실 `/workspace` **bind mount** + uid 1000(node) +
   이미지의 `safe.directory=/workspace` 에서 위 시나리오 + 통합 사슬 종단(merge-tree → commit-tree →
   결과 ref 발행·왕복 검증 → 소비자 `merge --ff-only` → 전체 스냅숏 → 마운트 위 named worktree 생성·제거)
   **19/19**. ⚠ **라이브가 아니다**: Docker Desktop 마운트는 `9p` 로 보이고 소유·권한을 가상화하므로
   (실측 `1000:1000 755`) 실 Linux 호스트보다 관대하다 — PR2c 가 남긴 인용 금지 규율을 그대로 승계한다.
4. **라이브는 구조적으로 도달 불가**다 — 이 PR 은 **소비자 0**(폐포 유지)이라 프로덕션 경로에서 이
   코드에 이르는 길이 없다. 첫 라이브 실행 시점은 **PR7 배선 이후**다. 검증 층위를 정직하게 적으면:
   단위(페이크) → 실 FS(win32/linux) → **실 프로세스 급사** → **배포 근사** → ~~라이브~~(PR7).
5. **일회성으로 두지 않았다**(PR2c 교훈 승계): 핵심 시나리오를 `git-repo-ops.test.ts` 에 **실 SIGKILL 형태
   그대로** 이식했다. ⚠ 초판은 「락 파일 존재」를 신호로 써서 **2/4 flake** 였다(락은 정상 트랜잭션 중에도
   잠깐 존재한다 → 이미 끝난 트랜잭션을 죽이는 판이 섞였다). 훅이 **prepared 진입을 스스로 증언**하는
   마커를 신호로 바꿔 **6/6 결정론**을 확보했고, 백오프 축소 뮤턴트로 그 행이 **vacuous 가 아님**을 확인했다.
- **정직 표기**: `probeMergeTree` 의 미지원 분기는 **주입 러너로만** 검증된다(배포·CI git 이 전부 ≥2.38).
  실 pre-2.38 판정은 컨테이너 대조로 별도 확인했다. 통합 트랜잭션·저널 소비자는 **PR3b/PR5** 이므로
  이 PR 의 `mergeTree`·`commitTree`·`casUpdateRef` 는 **프로덕션 호출부가 0** 이다(폐포 유지).

### PR3 — `GitRepo` 완성 · 통합 WAL 저널

> **PR3a 착지분(T11·T12)은 위 「PR3 착수 전 실측 정정」 절이 확정한 형태로 이미 랜딩했다.** 아래 원문은
> 착수 전 문안이며, 정정 112~121·125 가 그것에 우선한다. **T13 이하는 PR3b** 다(정정 111·123·124).

- **T11 `GitRepo` 나머지 11메서드 + 능력 프로브**(정정 119 — 원문 「8」은 계수 오류이고 정정 113 이
  `listRefs` 를 더했다) — §3-T24(정확 old-OID CAS — **조상 이동(ff 가능)에도 거부**) ·
  §3-T25(`merge-tree --write-tree` 충돌 **값 보고** · **ref 변이 0 · working tree 무접촉 · sequencer 무생성**.
  *정직*: 오브젝트 DB 에는 트리·블롭이 실제로 기록된다) · §3-T26(능력 프로브 · **폴백 경로 부재**를 행동
  단언으로) · §3-T27(2-parent → `merge --ff-only` · 전체 스냅숏). `update-ref --stdin` 에 **`--batch-updates`
  금지**. **`ok()` 미사용**(G-1).
- **T12 R-5 = 신규 연산 한정 재시도**(정정 114·115 가 원문을 대체) — §3-T58 은 **ref `.lock` 경합 +
  무관한 `index.lock` 동시 존재**로 조작화한다(원문의 index.lock 축은 실측상 실패가 발생하지 않아
  구성 불가능). §3-T58b 는 「성공률 변화」가 아니라 **레거시 무변경 회귀 핀**이다 — 레거시
  `addWorktree`(`git.ts:304`)·`removeWorktree`(`:346`)는 5종 락 선점 전부에서 exit 0 이라 `ok()` 의
  삭제 분기가 도달 불가다.
- **T13 통합 WAL 저널 + 복구 판정 + D/F 프로브** — §3-T32(6조합 + `REF_NAMESPACE_CONFLICT` **최우선**) ·
  §3-T23(bare ref 선점 → fail-closed · **어떤 ref 도 삭제 안 함** · 2세대 생성 성공) · §3-T33(`published` =
  정상 대기) · §3-T34(ref-앵커 재조정) · **§3-T63 통합 WAL 순서 단언**(`composed` 가 `casUpdateRef` 보다
  먼저 acknowledged — 없으면 ref 먼저·저널 나중 구현도 전부 GREEN 이라 C7 "추론 0" 논증이 무너진다).
  생성 저널은 `prepared` 규칙 **미상속** — 3채널 열거로 {없음·부분·완전} 결정론 판정 → 산출물 0건 =
  **`never-applied` 종결**.

### PR4 — slug · 레지스트리 · 태스크 경로 seam

- **T14 slug** — §3-T2(시드 고정 PRNG 퍼징 200k · **NFC 선행이 계약** — 어기면 macOS NFD 한글 소멸).
  `baseRef` 문법 검증 함수는 **단일 export**(T17 복원 0단계가 재사용 · 중복 구현 금지).
- **T15 복원 신원 검증** — §3-T3(lifecycle-인지 · archived = **부재** 검증 · 자동 정리 0) ·
  §3-T4(**I-2**: 0단계 실패 레코드가 어떤 git 호출·경로 probe 에도 전달되지 않음 — fake `GitRunner` 호출 **0**).
- **T16 생성·보관 WAL · 고아** — §3-T36(**디렉터리 선점(exit 128)은 고아 브랜치를 남기고, 브랜치 중복
  (exit 255)은 안 남긴다** — 종료 코드를 계약으로 전제하지 않고 stderr 병행) · §3-T21(마이그레이션 충돌 ·
  "기존 로컬 레코드 없음" 전제의 근거 = §3-T53 을 문면에 명시). 되감기는 **R1~R4 AND** 에서만 —
  크래시 경로는 R1(동일 프로세스 라이브) 구조적 미충족 → **자동 삭제 원천 차단**. 고아는 **레포 스코프
  「정리 필요」 목록** + **「채택」 액션**(막다른 길 금지).
- **T17 태스크 worktree 경로 seam** — §3-T44(`<benchRoot>/.fleet-wt-<benchId>/.fleet-wt-<sanitize(taskId)>` ·
  bench **내부** 배치 금지 근거(gitlink 오염·`clean -ffd` 파괴) 고정 · 교차 bench 삭제 불가) · §3-T45(격리 —
  benchRoot 전수 스냅숏 diff). **무회귀 핀**: seam 미주입 시 `addWorktree` 인자 문자열 **정확 일치**.
  **`git.ts:194` 재귀에 opts 를 전파하지 않는다** — 전파하면 태스크 worktree 안에서 bench 경로 유도가
  중첩된다. 오늘 중첩 `addWorktree` 호출부가 없어 두 선택의 관측 차이는 0이지만 **미핀 = 구현 재량**이므로
  비전파를 테스트로 고정한다. `sanitize` 금지 스코프는 **bench 디렉터리명(ULID)에 한정** — taskId 는 유지(#80).

### PR5 — 통합 트랜잭션 · 완결 관측 · 승인 2-페이즈

- **T18 통합 트랜잭션 5단계** — ①리스 안 auto-keep ②base OID 캡처 ③`mergeTree` ④`commitTree` 2-parent
  ⑤`casUpdateRef(…, null)`. **③→④→⑤ 는 같은 락 구간 연속**(중간 오브젝트는 도달 불가라 동시
  `gc --prune=now` 에 수거 가능 — 복구 판정은 **결과 ref 존재** 근거). §3-T31(활동-무효화 원자성) ·
  §3-T57 통합 측(R-4). **폐기 필드 재유입 금지**(`targetHeadAfterIntegration`·`applied|already-applied`).
- **T19 완결 관측 · 세대 · stale-attempt** — §3-T28(조상 도달성) · §3-T29(형제 그래프 → `partially-integrated`
  → `stale-attempt` → 재준비 T3 귀속) · §3-T30(조상 그래프 · 저널 순회 순서 무관).
- **T20 포기(abandon)** — §3-T35(git 변이 0 · 결과 ref/keep 커밋 보존 · `reachable-from-base` 거부).
  **롤백은 unsupported** 명문화.
- **T21 승인 2-페이즈(L-5)** — §3-T12(`gate.request` 가 **`key==='r'` 및 트랜잭션 구간 핸들 미보유** 상태에서만
  발생 · 표본에 `abandon-and-discard`·삭제-보관 **두 경로 필수**) · §3-T12b(재검사 실패 시 **승인 미소모**).
  **L-5a 부칙**(`r` 보유 중 리스 대기 금지)을 여기서 종단 단언.

### PR6 — 파생 · 인가 전수 · 크로스 프로세스

- **T22 파생 상태 + `authorizeBenchAction` 단일 초크포인트** — §3-T37(**표 자체의 전수 테이블 테스트**.
  "UI 액션 여집합 일치"는 **#253 완료 조건으로 이관**) · §3-T38(I4 `broken ∧ busy` → 전 액션 거부) ·
  §3-T39(I11 분리 — `published` bench 는 `delete-record` **허용**) · §3-T33 인가면 · §3-T21c 거부 전수(I12).
  인가 = **성립한 모든 상태의 거부 규칙 합집합**(우선순위는 표시 전용). `busy` 는 표시 전용, 인가 근거는
  **리스 획득 시도 결과**. 핸들러 옵션의 **비옵셔널** 필드로 주입(#253 이 소비).
- **T23 삭제 보관 · 고아 채택 · tombstone** — `abandon-and-discard` 3구간(락 밖 승인 → 락 안 재검사 → 단일 CAS).
- **T24 크로스 프로세스 stale-cache** — §3-T19. **`vi.resetModules()` + 동적 `import()` 2회로 모듈 격리** ·
  각자 별도 `DurableFs` 주입 · **negative control 2중**(ⓐstale 투영 확인 ⓑ**모듈 격리 자기검사** — A 의 모듈
  스코프 카운터가 B 에서 초기값. 격리가 깨지면 이 행이 **먼저** RED). **ⓑ를 먼저 RED→GREEN.**
  §3-T21(마이그레이션 충돌 종단).

### PR7 — 엔진 배선 · 상한 · 자식 수명 · 마감

- **T25 `resolveRunRoots` 단일 파생 · 가드 스코프화** — §3-T41(**3값 동일 파생** · bench 런의 verify cwd ===
  `bench.path`. `workspaceRoot` 만 바꾸면 split-brain) · §3-T57 레거시 측.
- **T26 드레인 권위 · `emitPersisted`** — §3-T40 verify 층(bench hang 런을 SIGTERM 드레인이 **기다린다**.
  canary 는 #254) · §3-T49 전반(`pushChannels()` 집합 불변) · **승인 카드 bench 식별**(오케 2경로 + 도구
  경로에 bench 컨텍스트 부착 · `mcp/host.ts:245` 는 명시 비범위).
- **T27 `verify.unavailable`(U2)** — §3-T42 **반증 조건 3항**(ⓐ이벤트 1건 발생 ⓑ최종 status ≠ failed
  ⓒnode_modules 존재 시 bench cwd 로 **실제 실행**). `OrchestratorEventType` 6번째 추가.
  **U2 는 선택이 아니라 필수 부품** — 미가용이면 `verifyFailed`(orchestrator.ts:1049-1055)로 bench 런이
  **항상 failed** 로 끝난다.
- **T28 `SendOptions.cwd`(U3)** — §3-T43. 분기 지점(`cli-session.ts:227`)은 **`workspace` 로만 판정**하고
  `execute()` 에는 **호출자별로 결정된 cwd 를 인자로** 내려보낸다(125·146행은 편집 경로와 **공유**되는
  헬퍼이므로 거기서 `cwd ?? workspace` 치환 금지). `engine.ts:448` 워크스페이스 도구 bench 스코프화(누출 차단).
- **T29 상한 슬롯 리스** — §3-T46(**실 fork 2 프로세스 합산** — 엔진-로컬 카운터면 RED) · §3-T47 후반 ·
  **슬롯 개수를 `area.json` 에 고정 기록**(env 분열 fail-open 차단) · **i 오름차순 고정 스캔 · 비대기**.
- **T30 자식 수명 3분류 · 마감** — §3-T39c(POSIX: 손자 남기고 정상 exit → **③**. 현행 `killTree` 가 win32
  전용인 한 반드시 RED) · §3-T55 verify 대체분(마커 = `sha256(bootId:pid1StartTicks)` · `boot_id` 단독·
  `hostname`·`machine-id` **부적격**). `killTree(child,{processGroup:true})` **opt-in**.
  ②의 배포 전제(단일 인스턴스) 검사 · macOS `'platform-unsupported'` 거부.
  마감: brain 최종 1회 · `npm run verify` · e2e 무회귀 · #253/#254 핸드오프 메모.
- **T30b 활동 시작 시퀀서 · 회수 호출부**(PR2c 이월 · 정정 100·102·106 · **주인 없던 행의 신설** —
  CC-6cont 가 「§3-T16c·§3-T17f·spawn seam 배선이 PR7 태스크 어디에도 귀속돼 있지 않다」를 전수 대조로
  적발) — `CAS1('gated') → commit1 → CAS2('running') → commit2 → launcher(commit2)` 시퀀서 · **spawn 실패
  시 활동 종결 CAS**(없으면 `activeActivity{running}` 이 프로세스 종료까지 남아 다음 부팅이 ③
  reconciliation = 사용자 고착) · §3-T17f(DurableFs 타임라인 ↔ launcher 호출 순서 대조) · 실 spawn seam
  배선 2곳(`cli/detect.ts`·`mcp/stdio.ts` · 폐포 핀 해제와 동반) · **bench-spawn eslint 가드**(§3-T16c) ·
  **gated-orphan 회수 CAS 호출부**(PR2c 가 착지시킨 `classifyStaleActivity`·`reclaimDraft` 소비 ·
  회수 자체는 리스 보유 소유자의 `withAuthority` 안에서).

## 5. 무회귀 체크리스트

1. `git.ts` 기존 export 8개(타입 5 + 값 3) 불변 — 신규는 추가만.
2. `createWorkspace` seam 미주입 = **바이트 동일**. 증거 = `git.test.ts` **22개** `createWorkspace(` 호출
   무수정 GREEN(실측 정정 ⑬ — 원문 13은 오산).
3. `StoreState` 키 집합 불변(§3-T53) · `createJsonFileStore` **무변경**(전체 스냅숏 LWW 클로버라 의도적 미사용).
4. `defaultRunner`/`defaultSpawn` 무주입 = 현행 동일(조건부 `env` 스프레드·`onStdout` 전파 보존).
5. `killTree(child)` 무옵션 = POSIX `child.kill()` 즉시 resolve(#80·MCP 무회귀).
6. 레거시 런 전역 1개 유지 · 드레인 판정 `boot.ts:298,312` **무변경**.
7. `workspace:set` 차단이 레거시만 — `main/index.ts:165`·`handlers.ts:125` **둘 다** 전환(하나만 하면 비대칭).
8. 채널 무증가 · `pushChannels()` 불변 · parity 테스트 GREEN.
9. `ok()` 기존 경로는 **동작이 바뀐다**(§3-T58b) — 무회귀가 아니라 **명시 변경**으로 다룬다.
10. eslint 기존 가드 무유실(#174 재발 방지) · C1 승인 계약 무변 · C3 드레인 무변.
11. `FLEET_WORKBENCH` 미설정에서 전 e2e 무회귀.
12. verify 7게이트 GREEN · brain 최종 1회 별도 커밋.

## 6. 위험

| # | 위험 | 완화 | 롤백 |
|---|---|---|---|
| R1 | ~~컨테이너 UDS `listen` 불가~~ → **소멸**(M1·M1′ 폐기 · §2). 대체 위험 = **추상 소켓은 win32·macOS 에 부재** | 백엔드를 주입 seam 뒤에 두고 계약 테스트는 페이크로 양 OS · `AreaOpenResult{platform-unsupported}` 로 fail-closed 계약화(PR1a 착지) | 런타임 스위치 |
| R2 | POSIX 부재 증명식이 이중 소유를 정말 배제하는가 | T4 결정론 배리어(우연 의존 금지) | fail-closed 폭 확대 감수 |
| R3 | **커버리지 statements 여유 2.25pt + win32 코드가 분모에만** | §3.1 대응 택1 확정 · PR 마다 4수치 기록 | floor 하향 금지 — 그 PR 안에서 해소 |
| R4 | win32 rename 재시도 4회 150ms 충분성(실측 근거 없는 상수) | 리더 규율 D-9 가 1차 방어 · `io-failure` 빈발을 관측 지표로 | 상수 1곳 조정 |
| R5 | `merge-tree` 중간 오브젝트 gc 수거 | ③→④→⑤ 같은 락 구간 · 복구는 ref 존재 근거 | 구조적 |
| R6 | 모듈 격리(`vi.resetModules()`)가 실제로 안 되면 §3-T19 전체가 false-GREEN | ⓑ 자기검사를 **먼저** GREEN | 실 fork 로 승격 |
| R7 | PR2/PR4/PR7 상한 초과 | 사전 분할점 3개 | 즉시 분리 |
| R8 | `ok()` 전환의 레거시 경합 회귀 | §3-T58b + PR 본문 롤백 논증 | R-5 를 신규 연산 한정으로 되돌림 |

## 7. 열린 항목 (Codex 체크포인트 3 리뷰 요청)

1. **§3.1 커버리지 대응 택1** — ⓐ주입 seam + 양 OS 페이크 vs ⓑ플랫폼 전용 파일 `coverage.exclude` +
   별도 windows 커버리지 잡. 이 계획은 ⓐ를 기본으로 두되 실측 후 확정하도록 남겼다.
2. **`BenchLeaseToken.revalidate()` vs `store.opts.leaseChecker`** — 스펙은 전자를 채택했다(per-lease 정밀도).
   "크레덴셜이 자기 생존을 스스로 증언"하는 형태가 허용 가능한지 — 브랜드 심볼 미export + 민팅이 `locks.ts`
   전용이면 위조 불가라는 논증이 충분한가.
3. **PR 8개**로 늘어난 것 — 1,900행 상한이 §7 PR 수 추정보다 상위 규범이라는 해석이 맞는가.
4. **`git.ts:194` 재귀 opts 비전파** — 두 초안이 정반대 결정을 냈고 오늘 관측 차이는 0이다. 비전파 + 중첩
   `addWorktree` 미사용 단언이 옳은 선택인가.
5. **M1 실패 시 Linux 추상 소켓 대안** — 자동 소멸로 회수 경로가 통째로 소멸하지만 net-namespace 전역
   이름공간이라 컨테이너 간 충돌이 가능하다. ADR 후보로 남긴 판단이 맞는가.
