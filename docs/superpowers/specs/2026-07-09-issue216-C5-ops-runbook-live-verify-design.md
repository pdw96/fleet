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
  프로젝트명 프리픽스가 붙음 — compose 가 top-level `name: fleet-webterminal`(`compose:13`)로 프로젝트명을
  **고정**하므로 결정론적으로 **`fleet-webterminal_fleet-data`**(디렉터리 basename `deploy` 아님). ⚠️ 하드코딩
  금지 — 틀린 볼륨명(`deploy_fleet-data` 등)은 에러가 아니라 **빈 볼륨을 조용히 새로 생성**(위양성 백업·조용한
  미복원). 런북은 반드시 **동적 해소**(`docker compose -f deploy/docker-compose.yml config --volumes` 또는
  `docker volume ls | grep fleet-data`)로 정확명을 뽑게 지시.
- **유일한 at-rest _시크릿_ = `sessions[].encryptedApiKey`**(kind:'api' 만). 평문 키·mcpConfig 는 의도적 미기록.
  근거: `store/types.ts:19,34-35,44`. **단 백업 파일 전체를 기밀로 취급** — store JSON 은 `messages[]`·`events[]`·
  `tasks[].output`·changedFiles 를 **평문**으로 담아 대화·산출물 민감 데이터가 그대로 백업에 들어간다
  (`store/types.ts:50-68`). "키만 별도 에스크로하면 tar 는 아무데나" 오추론 금지.
- **볼륨만 백업은 (API 세션이 있으면) 불충분.** `encryptedApiKey`(ev1: 토큰)는 `FLEET_SECRET_KEY` 로만 복호되며
  키는 **env 전용·볼륨 밖**(`env-key-crypto.ts:19-20`). 복원 시 **동일 키**가 없으면 전 API 세션이 조용히
  드롭(§1.2) → 키를 **별도 에스크로**(볼륨 백업과 다른 저장소). ⚠️ 범위 한정: `encryptedApiKey` 는 kind:'api'
  세션에만 존재 — **구독 CLI(ttyd)만 쓰는 배포는 API 세션이 없어 키 에스크로가 무의미**하고 볼륨 백업만으로 충분.
- 복원은 **소유권·권한 보존 필수**: dir 은 uid 1000(node) 소유, 서버 부팅 시 `chmodSync(dataDir,0700)` 재강제
  (`boot.ts:386-388`). ⚠️ 증상 정정 — root 소유로 복원(또는 fresh root-owned 마운트) 시 첫 실패는 store write
  EACCES 가 아니라 **부팅 시 `chmodSync` EPERM**(uid 1000 이 root 소유 dir mode 변경 불가) → `bootServer` reject
  → **컨테이너 crash-loop(loud·사일런트 아님)**. 이 loud crash 가 사일런트 손상보다 안전. `mkdirSync(recursive)`
  는 기존 root-owned dir 의 소유/모드를 **고치지 못함**. → 복원 후 **트리 전체** `chown 1000:1000`(dataDir 루트 +
  하위 `fleet/` 포함 — `fleet/` 는 0755 로 생성되고 0700 부모로만 보호 · `json-file.ts:27`).
- **pending 승인은 in-memory**(`approval.ts`/`approval-bridge.ts` store 참조 0) → 복원 서버는 pending 0 으로
  시작(데이터 손실 아님·by design). 런북이 이를 명시(부재를 손실로 오인 금지).
- **cross-runtime 비호환**: 서버 `ev1:`(AES-GCM env-key) ↔ 데스크톱 `v1:`(safeStorage) 상호 복호 불가
  (`env-key-crypto.ts:4,38` · `secret-crypto.ts`). 서버 store 를 데스크톱에 복원 금지(그 반대도).
- `cli-auth` 볼륨(`/home/node` = 구독 CLI 로그인 ~/.claude·.codex·.gemini)은 **재로그인 가능**이라 백업
  선택(핵심은 fleet-data). 런북이 둘의 성격 차이를 명시.

**절차 골자:** 실행 중 안전(atomic write·진짜 일관 필요 시 `docker stop`/드레인 후 tar) → 볼륨을 helper 컨테이너
tar 로 백업(**동적 해소한 정확 볼륨명**·`.tmp` 제외·`.corrupt` 발견 시 조사·백업 전체 기밀 취급) →
`FLEET_SECRET_KEY` 별도 백업(API 세션 있는 배포) → 복원은 tar 풀기 + **트리 전체 `chown 1000:1000`** + 동일 키로
재기동 → 복원 검증(**라이브 세션 목록 비었지 않음** = 권위·로그 grep `복호화 실패`/`영속되지 않는다` 부재 = 보조).

#### 1.2 FLEET_SECRET_KEY 키 로테이션

**실측 계약(hard truth — 정확히 반영해야 위험):**
- 포맷: 64자 hex **또는** 32바이트 base64(`env-key-crypto.ts:12-14`·미trim). ⚠️ 공백 영향은 **포맷별로 다름**:
  hex 는 anchored regex(`/^[0-9a-fA-F]{64}$/`)라 개행/공백이 붙으면 파싱 실패 → 미가용 강등(조용히 미영속);
  base64 는 Node 디코더가 주변 공백/개행을 **관용**(무시)해 32바이트가 나오면 그대로 유효(강등 안 함). → 런북:
  "개행/공백=항상 실패"로 쓰지 말 것(오문). 혼동·복붙 사고 방지를 위해 **두 포맷 모두 공백 없이 설정 권장**으로 서술.
- `ev1:` 은 **포맷 버전이지 키 버전이 아님**(키 id 미기록·`env-key-crypto.ts:35` concat=iv|tag|ct 뿐). →
  **듀얼키 오버랩 창 불가**. 무중단 로테이션 약속 불가.
- **로테이션 = 전 API 세션 복호 불가 → 조용히 드롭.** 키 교체 후 부팅 시 GCM 인증 태그 검증 throw → engine
  이 catch+continue+`console.warn('복호화 실패(키회전/손상)')`(`engine.ts:502-513`). **크래시 안 함·UI/헬스
  미노출·평문 폴백 없음.**
- **재암호화/마이그레이션 경로 0.** 구 암호문은 그 session id 가 재등록(upsert)될 때만 새 키로 덮임
  (`engine.ts:569-595`). → 로테이션 후 **모든 API 키 수동 재등록**이 유일 복구.
- "잘못된 키" 와 "손상된 blob" 은 **구별 불가**(둘 다 동일 throw·동일 warn prefix). → grep 은 **trailing
  message 가 아니라 prefix 서브스트링**(`복호화 실패`/`API 세션 복원 skip`)을 대상으로(§1.2 절차 준수).
- **두 skip 메시지로 triage 가능**: `암호화 미가용`(`engine.ts:489`·isAvailable=false=키 미설정/파싱실패 예:
  공백깨진 hex) vs `복호화 실패(키회전/손상)`(`engine.ts:508`·키는 있으나 틀림=진짜 로테이션). 둘 다 `API 세션
  복원 skip` 포함 → "키 안 넣음" 과 "키 바꿈" 구별.
- **positive "key loaded OK" 로그 없음**(`isAvailable` 성공은 무음·`env-key-crypto.ts:30`) → 로그 부재만으론
  키 정상 파싱 증명 불가. **복원/로테이션 후 권위 검증 = 라이브 세션 목록이 비지 않음**(로그 grep 은 보조).
- CLI 세션은 비밀값 없어 **무영향**(`store/types.ts:17-18`). → 로테이션 영향 범위 = API 키 provider 한정.

**절차 골자:** 백업(§1.1) → 새 키 생성(`openssl rand -hex 32` 또는 base64 32B) → `.env` 교체(공백 금지) →
재배포(§1.3 드레인) → **로그 grep** `복호화 실패`/`API 세션 복원 skip` 로 드롭된 세션 확인 → **각 API 키 수동
재등록**(⚠️ **동일 provider/session id 로 재등록**해야 upsert 가 고아 암호문을 자동 덮음 — 다른 id 로 등록하면
고아가 남아 프룬이 필수가 됨) → **라이브 세션 목록 비었지 않음 확인**(권위 검증) → 선택: `fleet-store.json` 의
고아 `sessions[]` 수동 프룬. + TUNNEL_TOKEN·GHCR PAT 로테이션은 외부 콘솔 절차라 포인터만(범위 밖).

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
  수명이 TTL 10분 → drain cap 으로 붕괴(`boot.ts:653` · ADR-0011). ⚠️ 두 경우 구분: **런에 묶인 승인**(런이
  승인서 멈춰 activeProjectIds 비지 않음)은 drain cap(~25s)까지 대기 후 rejectAll; **독립 pending 승인**
  (활성 런 없이 채팅/probe destructive 게이트로 held — 2a 하니스의 MCP 게이트가 정확히 이 경우)은 `waitForRunDrain`
  이 즉시 drained 반환 → rejectAll 이 **거의 즉시**(수명 ~0s) 발화. → 런북: **승인 pending 중 재배포 지양**·
  승인 게이트 근처 진행 작업은 revert 될 수 있음(완주 보장 없음).
- **시크릿 누락 = 2갈래(혼동 금지)** — `--wait` 는 신규 컨테이너 healthy 를 요구하나 healthcheck 는 정적 200
  뿐(`compose:117`·FLEET_SECRET_KEY 무관):
  - (1) **`FLEET_ACCESS_*` 부분/전무 + `FLEET_HOST=0.0.0.0`(compose 기본)** → `resolveBindHost`/security-config
    **throw → 부팅 거부 → restart crash-loop → up --wait 300s 타임아웃(loud)**(`boot.ts:193-201`·`security-config.ts:36-42`).
  - (2) **`FLEET_SECRET_KEY` 미설정/형식오류** → **크래시 아님**. `isAvailable=false` 강등·`console.warn` 후 계속·
    정적 200 healthy·**up --wait GREEN(배포 "성공")**. 하지만 API 키 영속 무효(**조용한 강등** — 크래시보다 위험,
    운영자가 GREEN 을 정상으로 오인·재기동 시 전 API 세션 조용히 드롭 §1.2). `docker logs` grep `영속되지 않는다`
    (`boot.ts:419`)로만 잡힘.
  → 런북: 재배포 전 시크릿 선검증 + **GREEN 이어도 부팅 로그 확인**(GREEN 은 `FLEET_ACCESS_*` 만 검증·
  `FLEET_SECRET_KEY` 는 검증 안 함). `pull-deploy.sh:9` 주석의 뭉뚱그림도 이 한정으로 읽을 것.
- **grace/drain 상향의 시점 나이앙스**: 재배포에서 `FLEET_STOP_GRACE`/`FLEET_DRAIN_TIMEOUT_MS` 를 올려도 이번에
  정지되는 **구 컨테이너**는 생성 시점 grace 로 stop 됨 → 상향은 **다음 종료부터** 유효(진행 중이던 런에 새 유예
  못 줌).

### Part 2 — 라이브 실측

#### 2a. 로컬 자율 하니스 (이번 PR·커밋)

지반 워크플로가 밝힌 **커밋 갭 2**를 봉인:

- **e2e `approval-handoff.web.e2e.ts`(신규)** — fresh 마운트 스냅숏 재하이드레이션 + **진짜 presence 핸드오프**를
  결정론 증명: 실 서버 번들 loopback 1회 기동(hold policy 상시) → **컨텍스트 A(PC)** `fleet.setMcpServers([{name,
  command:'nonexistent-approval-probe'}])` 로 held 승인 결정론 트리거(`mcp/host.ts:245` gate.request destructive
  가 spawn 전에 발화 — 리퓨터 upheld) → 카드 관측 → **`browser.newContext()` A 를 완전 teardown**(단순 reload
  아님·`clientCount→0` 단언 = **진짜 presence 전이**) → **컨텍스트 B(폰뷰 390×844)** goto(동일 URL) → App mount
  가 `listPendingApprovals`(`handlers.ts:151`)→HYDRATE 로 카드 **재제시** → 승인 → `fleet:approval:withdrawn` →
  카드 소멸. ⚠️ 주장 right-size: loopback 은 컨텍스트별 auth/nonce 가 없어(`boot.ts:596-601`) 재하이드레이션
  전송/렌더 경로는 기존 reload 테스트와 동경로 — **신규의 증분 가치 = A 완전 teardown+`clientCount→0` 로 진짜
  presence 핸드오프를 증명**하는 것(교차-Access-인증 핸드오프는 여전히 2b 전용). loopback 은 Access 불요.
  선택: 컨텍스트 전환 후 서버권위 `expiresAt` 유지 단언.
- **"프로젝트 런이 승인서 멈췄다 재개"(갭 (a)) = §2b 위임(정당)** — 리퓨터 확인: 완주 러너(`e2eCompletingRunner`
  `e2e.ts:64-83`)는 텍스트만 반환·파일 쓰기 없어 diff-risk 가 destructive 로 안 뜨고 MCP 도 없음 → 픽스처 런이
  mid-flow 승인 요청하게 배선하는 비용이 큼(실 위험 파일 조작 배선 필요). → **2a 는 MCP 게이트 핸드오프로 완료
  정의 코어를 대표**하고 "런이 승인 후 이어서 완주"는 2b 실측이 증명. 사일런트 캡 아님(런북 명시).
- **`deploy/drain-smoke.sh`(신규) + WS 드라이버 헬퍼** — C3 애드혹 수동 절차(실-SIGTERM 드레인)를 반복가능
  도커 하니스로(갭 (b)). ⚠️ "순수 bash smoke.sh 형제" 프레이밍 철회 — **4관측 중 2개는 bash/curl 로 불가**
  (draining broadcast·신규 런 거부 = 서버 로그 없음·연결 WS 클라만 관측 · `boot.ts:676`/`handlers.ts:110-112`).
  결정적으로 **`waitForRunDrain` 은 런만 대기**하므로 유휴 서버에 SIGTERM 하면 즉시 종료(**false-green**). →
  설계: 컨테이너 실 Linux 빌드번들 기동 → **작은 WS 프로토콜 헬퍼(node `ws` 또는 playwright 재사용)로 hang 런을
  몰아** activeProjectIds 를 채움 → `docker stop`(SIGTERM) → WS 클라가 `fleet:server:draining` 수신·드레인 중 런
  시도해 거부(err 프레임) 관측 → **경과 드레인 시간 ≥ 임계 canary**(유휴 즉시종료 false-green 차단·smoke canary
  규율) + `clean exit 0`·유예 내 종료. **선택 1-line src**: `boot.ts:676` broadcast 옆 `console.warn('draining')`
  1줄 추가 시 docker logs 로 broadcast 관측 가능(신규 런 거부는 여전히 클라 전용) — 프로덕션 관측성 향상이라
  구현 시 채택 판단. Windows/베어호스트 불가(kill=force) 명시 → Linux/도커 전용. *운영자 회귀 게이트로 재사용.*
  hang 런 유발 방법(FLEET_E2E 러너 중 blocking 존재 여부)은 구현 시 `e2e.ts` 러너 실측으로 확정.

#### 2b. 사용자 협업 실측 (배포 환경·#216 CLOSE 조건)

`deploy/README.md` 라이브 체크리스트(이미 존재·미체크)를 **실행 가능 형태로 다듬고** 사용자가 수행:
- 실 터널 + 실 폰 Access 로그인 → `fleet.<도메인>` 오케스트레이션 UI
- 세션 등록 → 목표 입력 → 런 착수 → **위험 작업 승인 요청** → PC 탭 닫기(인증 클라 0) → 승인 보류(TTL) →
  **폰 재접속 → 스냅숏 카드 재제시 → 폰 승인 → PC 런 이어서 완주**(= 완료 정의)
- 배포 컨테이너 `docker stop` 실 드레인(broadcast·cap 대기·clean exit) 관측
- 결과를 #216 코멘트로 기록 → **마지막 PR(또는 이 PR)이 `Closes #216`** (2b 통과 확인 후).

## 아키텍처 / 경계

- **코드 변경 최소**: 런북=문서, 2a=테스트/스크립트. 프로덕션 동작은 C1~C3 로 이미 출하 — C5 는 **문서화·
  검증층**. 유일 허용 프로덕션 src 변경 = drain broadcast 관측성용 **`boot.ts` 1-line `console.warn`**(선택·
  drain-smoke docker-logs 관측 향상). 그 외 src 변경이 필요해지면(예: 재하이드레이션 버그 발견) 별도 최소 패치로 격리.
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

## 로컬 적대 사전검증 §반영 (fleet-refuter 4렌즈 · `wf_3c1dc115-12b`)

스펙 초안을 Codex 올리기 전 로컬 refuter 로 코드 대조. **확정 결함 5건 전부 반영**:

- **[rotation P2]** "개행/공백=파싱 실패"가 base64 엔 거짓(Node 디코더 관용) → §1.2 포맷별 한정으로 정정.
- **[backup P2]** 볼륨명 예시 `deploy_fleet-data` 틀림(compose `name: fleet-webterminal`→`fleet-webterminal_fleet-data`)·
  오예시=조용한 빈 백업/미복원 → §1.1 정정 + 동적 해소 강제.
- **[backup P3]** 복원 실패 증상 오라벨(EACCES→**chmod EPERM crash-loop**)·chown 트리 전체 → §1.1 정정.
- **[drain P2]** §1.3 이 `FLEET_SECRET_KEY` 를 ACCESS_* 와 같은 크래시루프로 묶어 §1.2/§1.1 과 **자기모순** →
  2갈래(ACCESS_* loud crash-loop / SECRET_KEY 조용한 GREEN 강등)로 분리.
- **[harness P2]** drain-smoke "순수 bash 형제"론 broadcast/거부 무로그·유휴 즉시종료 false-green → WS 헬퍼 +
  경과 canary + 선택 서버로그 1줄로 재설계.

**upheld(refuted concerns)**: silent-drop·재암호화 0·수동재등록·ev1 키버전없음·CLI 무영향·종료 시퀀스·불변식
코드미강제·NOT blue-green·pending 붕괴·gate-before-spawn·loopback Access불요·완주러너 destructive 미발화 —
전부 코드 증거로 유지. **하드닝 반영**: 백업 전체 기밀(평문 messages/events)·키 에스크로 범위한정(API 세션 有)·
고아 동일-id 재등록·2 skip 메시지 triage·positive 키로그 부재→라이브목록 권위·독립승인 ~0s 붕괴·grace 상향 시점.
**잔여**: Part 1 런북 라인 인용은 랜딩 전 재확인(§완료조건 1·구현 시 실측).

## 리스크

- **런북 오문 = 위험**(§1.2 키 로테이션을 무중단 가능처럼 쓰면 운영자가 키만 바꾸고 API 세션 전멸을 모름). →
  self-review + Codex 검증 포인트로 "재암호화 없음·수동 재등록·조용한 드롭" 3점을 강조.
- **2a 픽스처 런 배선 비용** 불확실 → 저비용 아니면 MCP 게이트 대표 + 명시 위임(과설계 회피).
- **drain-smoke Linux 의존** → CI 통합은 smoke.sh 선례 따름(win32 Git Bash 미지원 명시).
