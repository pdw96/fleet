# C5 — 운영 런북 + 라이브 실측 (설계) · Part of #216

> Phase C 마지막 조각. **완료 정의(#216) = 외출 중 폰 승인 → PC 런 완주.** 이 문서는 그 완료 정의를
> (1) 운영자가 실제로 운용할 수 있게 만드는 **런북**과 (2) 그 시나리오를 **반복 검증**하는 하니스 + 라이브
> 절차로 성립시킨다. 코드 지반은 백그라운드 워크플로 4렌즈 실측(`wf_1ddff494-ad0`)에 근거한다.

## 결정 (착수 전 확정)

- **C4(Web Push) = 보류 → 별도 sub-issue.** 이슈가 "실사용 후 필요 체감 시 판단"·ADR-0003(솔로 pre-1.0
  과설계 ROI 경계)로 명시한 지점. C5 라이브로 "폰 언제 볼지 모름" 통증을 실측한 뒤에만 착수. Phase C 는 C5 로
  마무리하고 C4 는 트리거 시 신규 이슈.
- **라이브 실측 = 2트랙 분리.** 이번 PR = 런북 + **로컬 자율 하니스**(Part of #216). 실 폰·실 터널·`docker stop`
  최종 실측은 배포 환경에서 사용자가 문서화된 체크리스트로 수행 → **그 통과가 #216 CLOSE**. (실 Cloudflare
  Access 로그인·실 폰은 코드로 대체 불가.)

## 범위

### Part 1 — 운영 런북 (`deploy/README.md` 「운영」 섹션 확장)

기존 README 는 버전 갱신·GHCR pull/롤백·라이브 체크리스트를 이미 담는다. C5 가 채우는 **진짜 갭 3종**:

#### 1.1 fleet-data 백업·복원

**실측 계약(반드시 반영):**
- 서버 영속물은 **단일 파일** `<FLEET_DATA_DIR>/fleet/fleet-store.json`(컨테이너 `/app/fleet-data/fleet/fleet-store.json`).
  전체 `StoreState`(projects·tasks·rooms·messages·events·sessions·eventSeq…) 를 하나의 JSON 으로 직렬화
  (atomic tmp+rename · `.corrupt` 형제 = 과거 파싱 실패 흔적). 근거: `boot.ts:381,388` · `json-file.ts:28,52`.
- Docker named volume `fleet-data` 는 **fleet 서비스에만** 마운트(`compose:100-102`). 실제 볼륨명은 compose
  프로젝트 프리픽스가 붙음(예: `deploy_fleet-data`) → `docker volume ls` 또는 `docker compose` 경유로 해소.
- **유일한 at-rest 시크릿 = `sessions[].encryptedApiKey`**(kind:'api' 만). 평문 키·mcpConfig 는 의도적 미기록.
  근거: `store/types.ts:19,34-35,44`.
- **볼륨만 백업은 불충분.** `encryptedApiKey`(ev1: 토큰)는 `FLEET_SECRET_KEY` 로만 복호되며 키는 **env 전용·
  볼륨 밖**(`env-key-crypto.ts:19-20`). 복원 시 **동일 키**가 없으면 전 API 세션이 조용히 드롭(§1.2). → 키를
  **별도 에스크로**(볼륨 백업과 다른 저장소).
- 복원은 **소유권·권한 보존 필수**: dir 은 uid 1000(node) 소유·서버가 부팅 시 0700 재강제(`boot.ts:386-388`).
  root 로 naive tar 복원·fresh root-owned 마운트 = EACCES. → 복원 후 `chown 1000:1000` + 0700.
- **pending 승인은 in-memory**(`approval.ts`/`approval-bridge.ts` store 참조 0) → 복원 서버는 pending 0 으로
  시작(데이터 손실 아님·by design). 런북이 이를 명시(부재를 손실로 오인 금지).
- **cross-runtime 비호환**: 서버 `ev1:`(AES-GCM env-key) ↔ 데스크톱 `v1:`(safeStorage) 상호 복호 불가
  (`env-key-crypto.ts:4,38` · `secret-crypto.ts`). 서버 store 를 데스크톱에 복원 금지(그 반대도).
- `cli-auth` 볼륨(`/home/node` = 구독 CLI 로그인 ~/.claude·.codex·.gemini)은 **재로그인 가능**이라 백업
  선택(핵심은 fleet-data). 런북이 둘의 성격 차이를 명시.

**절차 골자:** 실행 중 안전(atomic write) → 볼륨을 helper 컨테이너 tar 로 백업(`.tmp` 제외·`.corrupt` 발견 시
조사) → `FLEET_SECRET_KEY` 별도 백업 → 복원은 tar 풀기 + `chown 1000:1000` + 동일 키로 재기동 → 복원 검증
(로그 grep `복호화 실패` 부재·라이브 세션 목록).

#### 1.2 FLEET_SECRET_KEY 키 로테이션

**실측 계약(hard truth — 정확히 반영해야 위험):**
- 포맷: 64자 hex **또는** 32바이트 base64(`env-key-crypto.ts:12-14`). **미trim** — `.env` 값에 개행/공백이
  있으면 파싱 실패 → 미가용 강등(조용히 미영속). → 런북: 주변 공백/개행 없이 설정.
- `ev1:` 은 **포맷 버전이지 키 버전이 아님**(키 id 미기록·`env-key-crypto.ts:35` concat=iv|tag|ct 뿐). →
  **듀얼키 오버랩 창 불가**. 무중단 로테이션 약속 불가.
- **로테이션 = 전 API 세션 복호 불가 → 조용히 드롭.** 키 교체 후 부팅 시 GCM 인증 태그 검증 throw → engine
  이 catch+continue+`console.warn('복호화 실패(키회전/손상)')`(`engine.ts:502-513`). **크래시 안 함·UI/헬스
  미노출·평문 폴백 없음.**
- **재암호화/마이그레이션 경로 0.** 구 암호문은 그 session id 가 재등록(upsert)될 때만 새 키로 덮임
  (`engine.ts:569-595`). → 로테이션 후 **모든 API 키 수동 재등록**이 유일 복구.
- "잘못된 키" 와 "손상된 blob" 은 **구별 불가**(둘 다 동일 throw·동일 로그).
- CLI 세션은 비밀값 없어 **무영향**(`store/types.ts:17-18`). → 로테이션 영향 범위 = API 키 provider 한정.

**절차 골자:** 백업(§1.1) → 새 키 생성(`openssl rand -hex 32` 또는 base64 32B) → `.env` 교체(공백 금지) →
재배포(§1.3 드레인) → **로그 grep** `복호화 실패`/`API 세션 복원 skip` 로 드롭된 세션 확인 → **각 API 키 수동
재등록** → 선택: `fleet-store.json` 의 고아 `sessions[]` 항목 수동 프룬. + TUNNEL_TOKEN·GHCR PAT 로테이션은
외부 콘솔 절차라 포인터만(범위 밖).

#### 1.3 드레인-인지 업그레이드 · 롤백

**실측 계약:**
- 종료 시퀀스(C3): `shutdown()` = draining=true(신규 런 거부) → broadcast → `waitForRunDrain`(런만·~25s cap)
  → `close()`(rejectAll 승인 → WS terminate → dispose). 근거 `boot.ts:669-683,650-665`.
- **조율 불변식 `FLEET_STOP_GRACE ≥ FLEET_DRAIN_TIMEOUT_MS/1000 + 3` 은 코드 미강제**(smoke canary 는 존재만
  체크·산술 아님·`smoke.sh:191-193`). → 런북: 운영자가 drain 상한을 올리면 **STOP_GRACE 도 반드시** 올려야
  SIGKILL 절단 방지(안 그러면 보호 착각).
- `up -d --wait` recreate = 구 컨테이너 `stop_grace_period` honor(구 컨테이너 SIGTERM+grace 드레인 후 신규
  헬스 게이트). **NOT blue-green**: 헬스 실패 = 구 컨테이너 **이미 소멸**(`pull-deploy.sh:54` · Codex P1). →
  롤백 = `GHCR_TAG=sha-<이전>` 재핀 + **compose ff-only 되돌림**(git 동기 시).
- **pending 승인 중 재배포 위험**: drain 은 런만 대기·pending 승인은 `close()` 의 rejectAll 로 정리 → 승인
  수명이 TTL 10분 → drain cap ~25s 로 붕괴(`boot.ts:653` · ADR-0011). → 런북: **승인 pending 중 재배포 지양**
  또는 사용자에게 축소 고지. 승인 게이트 근처 진행 작업은 revert 될 수 있음(완주 보장 없음).
- **시크릿 누락 구별**: `--wait` 는 신규 컨테이너 healthy 를 요구 → `FLEET_ACCESS_*`/`FLEET_SECRET_KEY` 누락
  크래시루프는 **300s 타임아웃처럼** 보임(드레인 문제 아님). → 재배포 전 시크릿 선검증 + `docker logs` 구별.

### Part 2 — 라이브 실측

#### 2a. 로컬 자율 하니스 (이번 PR·커밋)

지반 워크플로가 밝힌 **커밋 갭 2**를 봉인:

- **e2e `approval-handoff.web.e2e.ts`(신규)** — 완료 정의의 코어(교차 클라 핸드오프)를 결정론 증명:
  실 서버 번들 loopback 1회 기동(hold policy 상시) → **컨텍스트 A(PC)** `fleet.setMcpServers([{name,
  command:'nonexistent-approval-probe'}])` 로 held 승인 결정론 트리거(`mcp/host.ts:244` gate.request destructive)
  → 카드 관측 → **컨텍스트 A 종료**(presence→0 시뮬) → **컨텍스트 B(폰뷰 390×844)** goto(동일 URL) → App
  mount 가 `listPendingApprovals`(`handlers.ts:151`) 로 카드 **재제시** → 승인 → `fleet:approval:withdrawn` →
  카드 소멸. 기존 `approval-hold.web.e2e.ts` 는 **같은 컨텍스트 reload** 만 증명 → 신규는 **두 컨텍스트**로
  진짜 핸드오프 증명(갭 (d)). loopback 은 Access 불요.
- **가능하면 "프로젝트 런이 승인서 멈췄다 재개"**(갭 (a))도 커버 — 단, 기존 완주 러너(`FLEET_E2E_RUNNER=
  complete`)는 destructive 게이트를 안 침. 픽스처 런이 mid-flow 승인을 요청하게 배선하는 비용이 크면 **MCP
  게이트 핸드오프로 완료 정의 코어를 대표**하고(런 재개는 §2b 실측에 위임) 그 한계를 런북에 명시(사일런트 캡
  아님). *결정: 저비용이면 픽스처 런 포함, 아니면 MCP 대표 + 명시 위임.*
- **`deploy/drain-smoke.sh`(신규)** — C3 애드혹 수동 절차(실-SIGTERM 드레인)를 반복가능 도커 하니스로(갭 (b)):
  실 Linux 컨테이너 빌드번들 기동 → hang 런 유발 → `docker stop`(SIGTERM) → 관측: `fleet:server:draining`
  broadcast·신규 런 거부·cap 까지 대기·`clean exit 0`·유예 내 종료. Windows/베어호스트 불가(kill=force) 명시
  → Linux/도커 전용(smoke.sh 형제). *운영자 회귀 게이트로 재사용.*

#### 2b. 사용자 협업 실측 (배포 환경·#216 CLOSE 조건)

`deploy/README.md` 라이브 체크리스트(이미 존재·미체크)를 **실행 가능 형태로 다듬고** 사용자가 수행:
- 실 터널 + 실 폰 Access 로그인 → `fleet.<도메인>` 오케스트레이션 UI
- 세션 등록 → 목표 입력 → 런 착수 → **위험 작업 승인 요청** → PC 탭 닫기(인증 클라 0) → 승인 보류(TTL) →
  **폰 재접속 → 스냅숏 카드 재제시 → 폰 승인 → PC 런 이어서 완주**(= 완료 정의)
- 배포 컨테이너 `docker stop` 실 드레인(broadcast·cap 대기·clean exit) 관측
- 결과를 #216 코멘트로 기록 → **마지막 PR(또는 이 PR)이 `Closes #216`** (2b 통과 확인 후).

## 아키텍처 / 경계

- **코드 변경 최소**: 런북=문서, 2a=테스트/스크립트(프로덕션 src 무변경 목표). 프로덕션 동작은 C1~C3 로 이미
  출하 — C5 는 **문서화·검증층**. src 변경이 필요해지면(예: 재하이드레이션 버그 발견) 별도 최소 패치로 격리.
- **런북 위치**: 기존 `deploy/README.md` 「운영」 확장(운영자 단일 소스 유지). 과도 성장 시 `deploy/RUNBOOK.md`
  분리 여지(현 단계는 인라인).
- **하니스 격리**: 신규 e2e 는 `e2e/*.web.e2e.ts` 패턴·`e2e/web-server.ts` 재사용. drain-smoke 는 `smoke.sh`
  와 형제(Linux 전용·CI 별개).

## 명시적 out-of-scope / 위임

- C4 Web Push 전체(별도 이슈).
- GHCR-CD 「서버 마련 후」 6항목(README:394-401)은 실 서버 프로비저닝 대기 → C5 는 **범위 밖**임을 명시(사일런트
  캡 아님·Phase C 완료 정의는 폰 승인 실측이지 CD 서버 실측이 아님).
- 재암호화 툴링·키 버전 도입·헬스체크 노출·고아 암호문 자동 프룬 = 프로덕션 기능 → 필요 체감 시 별도 이슈.

## 완료 조건

1. 런북 3섹션 = 위 실측 계약을 정확히 반영(특히 §1.2 hard truth 오문 0).
2. 신규 e2e GREEN(교차컨텍스트 핸드오프 결정론) + 기존 e2e/verify 7게이트 무회귀.
3. `deploy/drain-smoke.sh` 실 Linux 도커에서 드레인 시퀀스 ALL PASS(로컬 실측).
4. 자체 적대리뷰(fleet-finder 다렌즈) — **런북 안전 주장 정확성 렌즈 포함** — correctness P1/P2 0.
5. 봇 리뷰(Codex/CodeRabbit) 반영·CI green.
6. PR `Part of #216`. 사용자용 2b 라이브 체크리스트 정착 → 통과 확인 후 #216 CLOSE.

## 리스크

- **런북 오문 = 위험**(§1.2 키 로테이션을 무중단 가능처럼 쓰면 운영자가 키만 바꾸고 API 세션 전멸을 모름). →
  self-review + Codex 검증 포인트로 "재암호화 없음·수동 재등록·조용한 드롭" 3점을 강조.
- **2a 픽스처 런 배선 비용** 불확실 → 저비용 아니면 MCP 게이트 대표 + 명시 위임(과설계 회피).
- **drain-smoke Linux 의존** → CI 통합은 smoke.sh 선례 따름(win32 Git Bash 미지원 명시).
