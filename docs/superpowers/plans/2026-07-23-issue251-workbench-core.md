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
| **PR2** | 계약 사슬 · 내구 쓰기 · 권위 CAS | T6b~T10 | 1,500~1,850 | T9 종료 >1,500 → T10 을 PR2b |
| **PR3** | `GitRepo` · 통합 WAL 저널 · 복구 판정 | T11~T13 | 1,200~1,500 | 없음 |
| **PR4** | slug · 레지스트리 · 태스크 경로 seam | T14~T17 | 1,400~1,750 | T16 종료 >1,400 → T17 을 PR4b |
| **PR5** | 통합 트랜잭션 · 완결 관측 · 승인 2-페이즈 | T18~T21 | 1,150~1,450 | 없음 |
| **PR6** | 파생 · 인가 전수 · 크로스 프로세스 | T22~T24 | 1,200~1,500 | 없음 |
| **PR7** | 엔진 배선 · 상한 · 자식 수명 · 마감 | T25~T30 | 1,600~1,900 | T28 종료 >1,450 → T29~T30 을 PR7b |

**총 8 PR**(스펙 §7 "5~6" 대비 +2~3). **은폐하지 않는다** — 스펙 §5 의 1,900행 상한이 §7 의 PR 수 추정보다
**상위 규범**이고, §3 계약 테스트 74행 중 **66행이 #251 코어 귀속**(UI 3 · nightly 6)이라 UI·deploy 를 떼도
테스트 질량이 거의 줄지 않는다는 실측 때문이다.

> **서버 단일 표면 축소 반영(2026-07-23)**: 토폴로지 게이트·handoff·`locks/<key>.json`·epoch 판정이
> 계약에서 사라져 **PR1·PR2 가 축소**됐다(스펙 1,430→1,251행). PR7 의 win32 분기(npipe 백엔드·
> `file-only` 강등 소비)도 **#251 범위 밖**이 되어 §3.1 의 커버리지 플랫폼 비대칭 압박이 완화된다
> (win32 전용 코드가 분모에만 들어가는 문제의 주 원인이 npipe 백엔드였다).
> **재산정 결과 7 PR** — PR2 를 PR1 로 흡수 가능한지는 착수 시 실측으로 판정한다.

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
- **T8 권위 CAS 코어(`withAuthority`·`AuthorityTx`)** — §3-T13(**행동 단언 3개**) · §3-T14(읽기 카운터) ·
  §3-T15 · §3-T16 · §3-T17d(배리어 인터리브) · §3-T20 · §3-T53 · §3-T21c 분류 · **§3-T61**(조건부 스키마 9행).
  **store 는 `withAuthority` 만 public**, 두 메서드는 `AuthorityTx` 에.
- **T9 rename 재시도 · per-retry L-6 · `commit-uncertain`** — §3-T17(win32 실측) · §3-T17b(**재시도 끝 성공 =
  정확히 1 commit**) · §3-T17c(재시도 중 탈취 → 이후 rename 미실행) · §3-T17e(rename 후 `fsync-dir` 실패 =
  `commit-uncertain` · 토큰 미발급 · CLI 미실행 · `gated` 만 회수, `running` 은 비대상).
- **T10 `BenchLauncher` · spawn seam 2곳 · ADR-0013** — §3-T17f(commit 발급·spawn 이 **최종 acknowledged
  durability 이후**) + **B 이식: `CAS1('gated') → commit1 → CAS2('running') → commit2 → spawn(commit2)`
  순서 고정** + **spawn 실패 시 활동 종결 CAS**(세 초안 공통 누락).
  무회귀: `createCommandRunner()` 무주입 = 현행 `defaultRunner` 동일(조건부 `env` 스프레드 보존 ·
  `onStdout` 4번째 인자 전파) · `createDefaultSpawn(baseEnv, launcher?)`.
  **ADR-0013**: ①MCP 자식을 봉쇄 범위 밖으로 **명시 배제** ②nightly 부재로 §3-T55·N2~N4 를 #254 이관
  ③win32 `'file-only'` 수용(**Codex 3항의 충족이 아니라 회피**) ④M1 실패 시 추상 소켓 대안 판단.

### PR3 — `GitRepo` 완성 · 통합 WAL 저널

- **T11 `GitRepo` 나머지 8메서드 + 능력 프로브** — §3-T24(정확 old-OID CAS — **조상 이동(ff 가능)에도 거부**) ·
  §3-T25(`merge-tree --write-tree` 충돌 **값 보고** · **ref 변이 0 · working tree 무접촉 · sequencer 무생성**.
  *정직*: 오브젝트 DB 에는 트리·블롭이 실제로 기록된다) · §3-T26(능력 프로브 · **폴백 경로 부재**를 행동
  단언으로) · §3-T27(2-parent → `merge --ff-only` · 전체 스냅숏). `update-ref --stdin` 에 **`--batch-updates`
  금지**. **`ok()` 미사용**(G-1).
- **T12 R-5 스테일 락 분리** — §3-T58(**행동 단언 재정의**: 실 `index.lock` 잔존 + 주입 `GitRunner` 호출
  카운트로 백오프 관측) · **§3-T58b 레거시 경합 회귀**(판사 2기 공통 지적 — `git.ts:191`·`:233` 이 현재
  `ok()` 를 쓰므로 이 전환은 **레거시 #80 의 실동작 변경**이다. "무회귀"로 분류하지 않는다).
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
