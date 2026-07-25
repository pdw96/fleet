# ADE 1축 설계 — Workbench 병렬 작업 공간 (체크포인트 1 · 설계)

Fleet의 장기 방향을 **"오케스트레이션 위에 ADE 표면"** 으로 확정하고, 그 1축인
**Workbench(병렬 작업 공간)** 의 설계를 정의한다. 이 문서는 **방향·구조·결정·근거**를
다루고, 구현 계약(타입 시그니처·불변식·테스트 표)은 체크포인트 2(스펙)에 위임한다.

> **Codex 1R 반영(P1×1)**: 영속화된 bench 경로를 복원 시 신뢰 cwd로 쓰는 문제 —
> §3.1의 persist 스키마에서 `path` 제거(부팅마다 루트+ID로 재유도) + §3.1.1 복원
> 신원 검증(fail-closed) 계약 신설. 근거 실측: `engine.ts:258-264`(workspace 경로가
> git/verify에 직접 사용)·`detect.ts:281-303`(excludeDir는 호출자 공급값만 제외)·
> `git.ts:81`(기존 태스크 worktree의 루트+ID 유도 선례).
>
> **Codex 2R 반영(P1×1)**: 영속화된 `id`도 신뢰 불가 경로-구성 입력 — 근거 실측:
> `git.ts:79` `sanitize`는 손실 치환이라 별개 id가 같은 디렉터리명으로 붕괴(`a/b`·
> `a?b`→`a_b`)·`store/json-file.ts:35`는 타입 단언뿐 런타임 검증 없음. 반영 =
> §3.1 id를 엔진 생성 ULID 엄격 문법으로 규정 + §3.1.1에 0단계(레코드 런타임 검증·
> 전용 루트 격리·단사 매핑) 신설. **sanitize가 아니라 거부**가 원칙.
>
> **Codex 3R 반영(P1×1)**: 복원 검증이 lifecycle 무관 일괄 적용이라 정상 보관
> (archived=worktree 의도적 제거) 레코드가 매 부팅 broken 판정되는 모순 —
> §3.1.1을 lifecycle-인지 검증으로 재편(open/integrated=worktree 신원 검증·
> archived=**부재** 검증) + persist에 `archivedBranch` 필드 추가 + 복원 중 자동
> 정리/삭제 금지 명문화. integrate는 worktree를 제거하지 않는다(§3.2 명시 —
> 현행 integrate/removeWorktree 분리 보존).
>
> **Codex 4R 반영(P1×1)**: 동시 원클릭 통합의 공유 레포 레이스 — 근거 실측:
> `git.ts:197-231` integrate는 dirty 체크→평 `run` cherry-pick(205행 주석:
> `ok()` 락-재시도 의도적 우회)→`--skip`/`--abort` 정리의 비원자 다단계이며
> 순차 전제(87-88행)로 설계됨. 반영 = §3.2.1 통합 조정 계약 신설(common gitdir
> 단위 직렬화·대상 ref 검증·TOCTOU-안전 사전조건·lifecycle 전이 원자성·
> sequencer 잔존 fail-closed 복구) + 0단계 `baseRef` 정준 브랜치명 검증 강화.
>
> **Codex 5R 반영(P1×1)**: 4R의 "reconciliation 상태"가 표현·복구 수단 미정의 —
> 근거 실측: `json-file.ts:50-57` persist는 오류 삼킴+void(호출자 관측 불가)·
> `git.ts:225-227` 빈/중복 cherry-pick 성공 처리(복구 은폐)·lifecycle 3-상태에
> reconciliation 부재. 반영 = §3.2.2 **통합 저널(WAL)** 신설: 확인-응답 쓰기
> 계약·의도 선기록→git 변이→완료 기록 순서·불변 source commit 기준 검증·
> 미결 저널=reconciliation-required(실행·통합 차단)·복구는 커밋 신원 증명
> (빈 cherry-pick 추론 금지)·자동 정리 전면 금지·수리는 동일 락+ApprovalGate.
>
> **Codex 6R 반영(P1×1)**: WAL이 의도만 증명하고 git 결과를 증명 못함 —
> cherry-pick=새 커밋 id(sourceCommit 도달성 판정 불가)·no-op 성공=커밋 무생성·
> rename만으론 머신 크래시 내구성 없음. 반영 = §3.2.2 재편: 결과 종별
> `applied|already-applied` + `targetHeadAfterIntegration` 내구 기록·WAL 3단계
> `prepared→git-applied→finalized`·단계별 복구 프로토콜·no-op=유효 성공으로
> 의도적 채택(stderr 매칭은 복구 신원으로 사용 금지)·fsync 내구 경계(파일+부모
> 디렉터리) 명시.
>
> **선제 적대 스윕 반영(로컬 fleet-refuter 3렌즈 · 2026-07-22)**: 7R 전 확정
> P1급 6건 반영 — ①busy bench 통합 상호배제(§3.2.1-6) ②통합 대상=자동 keep
> 스냅숏·미커밋 소실 차단(§3.2) ③저널 레코드 런타임 검증(§3.2.2) ④보관도 저널
> 보호 — 연산 저널로 일반화(§3.2.2) ⑤레거시 런↔통합 main worktree 상호배제 +
> `ok()` 순차 전제 폐기(§3.2.1-7) ⑥bench 레코드·저널의 확인-응답 저장 경로
> 이관 — finalized 관측 가능화(§3.2.2). REFUTED 5·P2 6건은 §6 등재.
>
> **Codex 7R 반영(P1×1)**: 6R+스윕 6건 전부 수용됐고, 스윕에서 P2로 내렸던
> 다중 엔진 락이 P1 승격 — 데스크톱·서버가 독립 부팅 표면으로 같은 레포를 열
> 수 있어 in-process 뮤텍스는 "레포 단위 직렬화" 보장을 이행하지 못함(4R
> 레이스의 프로세스 경계 재현). 반영 = §3.2.1-1 재정의: **OS-가시 크로스
> 프로세스 자문 락**(정준 common gitdir 키)이 안전 경계·in-process 큐는 공정성
> 층으로 강등·연령 기반 락 삭제 금지(락 획득 가능=소유자 부재 증명)·복구도
> 동일 락 경유 + §3.2.2: 저널을 **레포-스코프 코디네이션 영역**(`<common
> gitdir>/fleet/`)으로 이동(부팅 표면 간 발견 가능)·타 엔진 저널=레포 통합
> 차단 fail-closed·Fleet 락과 git 자체 락(index.lock/sequencer) 분리 유지.
> §6의 다중 엔진 열린 질문은 해소돼 제거.
>
> **Codex 8R 반영(P1×1)**: 변이 락은 크로스 프로세스가 됐는데 busy 배제가
> 엔진-로컬 파생으로 남음 — 타 프로세스의 살아있는 런/채팅 중 worktree
> `--force` 제거(보관)·비정지 스냅숏 통합 가능. 반영 = §3.2.1-6 재정의:
> **bench 활동 리스**(OS-가시, 키=레포 신원+benchId)를 런/채팅 전체 수명
> (취소 정리·revert·세션 종료·최종 persist까지) 동안 배타 보유·"bench당 1런"의
> 크로스 프로세스 집행 권위로 승격·변이는 레포 락 획득 후 이 리스를 획득해야
> 진행(신규 활동도 차단)·취소≠정지(자식 트리 종료+정리 완료 후 해제)·keep
> 스냅숏은 리스 배타 확보 후에만·크래시 해제돼도 worktree·저널 검사 선행·
> **락 서열 고정**(레포 변이 락 → bench 리스; 활동은 리스만) — 데드락 불가.
>
> **Codex 9R 반영(P1×1)**: 부모(엔진) 소유 리스는 크래시 시 자동 해제되는데
> 스폰된 CLI 자식/손자는 살아남아 계속 편집 가능 — "해제됨+clean+저널 없음"은
> 정지 증명이 아님(kill-tree-and-wait는 부모 생존 시에만 작동). 반영 =
> §3.2.1-6에 **자식 수명 봉쇄 + 3분류 해제 판정** 추가: 플랫폼 봉쇄(win32
> Job Object kill-on-close·linux PDEATHSIG/프로세스 그룹·컨테이너=cgroup
> ADR-0010 정합·macOS 전략은 스펙 확정)를 spawn 단일 관문(defaultRunner)에
> 부착해 모든 런치 모드 커버·리스 해제 전 **정상 종료 레코드**(acknowledged)
> 기록·해제 판정 3분류(①정상 해제 ②크래시+봉쇄 보장=트리 소멸 확정 ③봉쇄
> 미보장/불확실) — **①②만 변이 적격, ③=reconciliation-required**·PID 재사용
> 대응(신원=OS 락+엔진 ULID, pid는 진단용)·승인은 의도 인가일 뿐 정지 증거
> 아님(archive fail-closed 유지).
>
> **Codex 10R 반영(P1×1)**: 봉쇄의 스펙 위임·PDEATHSIG 불충분(손자·데몬화
> 미커버)·spawn-후-부착 레이스·"부착 확인"의 첫 자식 한정 오분류 위험 —
> 설계에서 확정: **가디언 런처 아키텍처**(가디언이 리스 획득+봉쇄 설치+신원
> 기록 완료 전 CLI 사용자 코드 실행 불가 = exec-게이트·가디언이 리스 수명
> 권위로 트리 전체 소멸 관측 후 해제)·플랫폼 확정(win32 Job kill-on-close
> 사전 배정·linux cgroup v2 스코프 필수+`cgroup.procs` 공백=사후 증거·
> **macOS 미지원 확정=시작 거부**)·봉쇄=시작 전제(실패 시 활동 거부)·"부착됨"
> =멤버십 상속의 전 자손 커버·② 적격=프로토콜이 자손 잔존 불가를 증명하는
> 경우만. §6 해당 열린 질문 해소.
>
> **Codex 11R 반영(P1×1)**: "cgroup v2 필수"가 출하 표면에서 실행 불가 —
> AppImage는 비특권(cgroup 직접 생성 권한 없음)·컨테이너는 위임 없이 제한
> 계층·CAP_SYS_ADMIN 부여는 ADR-0010 훼손. 반영 = 표면별 권한 경로 확정:
> **데스크톱 linux = systemd 사용자 transient scope**(D-Bus·비특권 표준·
> 부재 시 시작 거부) / **컨테이너 = cgroup 불요** — 컨테이너 PID 네임스페이스
> (PID1 소멸=전멸)가 크래시 봉쇄 + guardian-subreaper가 라이브 관측(호스트
> cgroup·privileged 불요=ADR-0010 무변·② 증거=컨테이너 인스턴스 신원 불일치)
> ·봉쇄 신원 내구 기록으로 재사용 오판 방지(존재+점유/존재+공백/신원 불일치
> 3구분)·이탈 저항 위협 모델 명시(목적=사고성 고아 방지·악성 이탈 방어는
> 컨테이너/OS 경계 소관)·두 표면 모두 구현 가능 확정으로 §5 완료 정의(서버
> 라이브) 유지.
>
> **Codex 12R 반영(P1×1)**: benchRoot 부모-유도식이 컨테이너에서 `/.fleet-wb`
> =쓰기 불가(EACCES)·비영속(교체 시 worktree 증발→전 레코드 broken) — 반영:
> benchRoot=부팅 구성·검증되는 엔진 소유 경로(데스크톱 기본=형제 관례·서버=
> `FLEET_BENCH_ROOT` 전용 영속 볼륨 핀)·부팅 검증 실패 시 기능 fail-closed·
> 마운트 레이아웃≠worktree 메타데이터면 fail-closed(조용한 재생성·prune 금지)
> ·크로스 표면 신원=common gitdir+정준 benchRoot 쌍·§5에 배포 수명주기 완료
> 기준 추가(bench 생성→볼륨 보존 컨테이너 교체→동일 worktree/브랜치 복원→런/
> 보관)·봉쇄 권위 문구 정정(서버=PID1 아님 — 컨테이너 init·PID ns 수명).
>
> **Codex 13R 반영(P1×1)**: ttyd(출하 스택의 두 번째 문)가 같은 `/workspace`
> 를 무제한 셸로 공유 — Fleet 자문 락이 배제 못 하는 외부 git 작성자. 반영 =
> §3.2.1-2 재정의: 통합 계산은 **프라이빗 통합 worktree**(ttyd 비마운트)에서,
> 발행은 **old-OID 조건부 원자 ref 갱신(CAS)** — 외부 전진 시 fail-closed
> 재계산(4R "체크아웃 확인"·공유 worktree dirty 전제 대체) + §3.2.1-9 외부
> 작성자 계약: 신뢰 모델(목표=선의 동시 사용 무손상·무제한 셸 절대 배제는
> 불가능 명시)·비소유 sequencer/락/ref 절대 무정리·체크아웃 충돌 락-내 거부
> +잔여 창은 stale 표시로 한정(감지·통지·외부 worktree 무수정)·`/workbenches`
> ttyd 비마운트 문서화(향후 마운트=별도 소유권 모델) + §5 외부 작성자 경합
> 테스트 추가.
>
> **Codex 14R 반영(P1×1)**: 13R "체크아웃 중 발행 거부"가 정상 배포 상태
> (base가 `/workspace` 체크아웃)에서 원클릭 통합을 불능화·예외 시 stale
> 레이스 복귀 — 아키텍처 확정: 정준 권위=레포 ref·**발행=체크아웃된 외부
> worktree에서의 `merge --ff-only` 단일 git-네이티브 연산**(ff-only=CAS
> 의미론 내장·index.lock으로 터미널과 직렬화·미커밋 충돌 시 git이 거부=클로버
> 없음·성공 시 ref+working tree 동시 전진=stale 소거·원클릭 유지)·비체크아웃
> 시 update-ref CAS·실패 시 결과를 `refs/fleet/results/<benchId>` 보관+
> **publish-pending** 파생 상태 fail-closed·외부 worktree 접촉의 유일한 예외
> =비파괴 ff 동기화(파괴·정리 연산 여전히 금지)·§5 기본 배포 상태 통합
> 테스트 추가.
>
> **Codex 15R 반영(P1×1)**: 14R ff 발행 반박 — ff-only=조상 검사(정확 old-OID
> 아님·다른 조상 이동 통과)·index.lock은 git 명령만 직렬화(일반 파일 쓰기
> 레이스). 확정 = 발행은 **정확 old-OID CAS ref 트랜잭션 단 하나**·외부
> worktree는 **소비자 체크아웃 모델·완전 무접촉**(ff 예외 폐기=13R 원칙
> 복원)·발행 후 체크아웃 충돌은 **"통합 완료·터미널 체크아웃 갱신 필요
> (checkout-behind)" 명시 모델 상태**로 노출(자동 동기화·reset·checkout·clean
> 전면 금지·안내만)·`integrated`=정준 CAS 성공 시점(동기화 비의존)·§5 테스트
> 강화(발행 중 일반 파일 쓰기·조상 이동 CAS 거부·무접촉 검증).
>
> **Codex 16R 반영(P1×1)**: 체크아웃된 브랜치의 CAS 전진 자체가 불일치를
> 생성(symbolic HEAD 즉시 전진→옛 index=staged 역변경→터미널 평범한 커밋이
> 통합을 무효화 — 리뷰어 재현 확인). 확정 = **2단 발행**: ①결과를 체크아웃
> 불가 정준 통합 ref `refs/fleet/integrated/<benchId>`에 정확 CAS 확정(bench=
> integration-ready·원클릭 산출 항상 성립) ②base 전진은 worktree 전수 열거로
> **비체크아웃 확인 시에만** CAS·점유 시 base 무이동+사용자 주도 동기화 안내
> (`merge --ff-only <통합 ref>`)·특정 reset 처방 금지·`integrated`=**base==
> 결과 OID 관측 시점**(결과 ref 생성만으로 기록 금지)·§5 테스트를 staged
> 터미널 변경·HEAD/index/조상 관계 검증으로 강화.
>
> **Codex 17R 반영(P1×1)**: 열거~CAS 사이 체크아웃 **생성** 레이스 — 생성은
> ref를 안 움직여 CAS 통과·새 체크아웃이 즉시 불일치·탐지/안내는 발행을
> 안전화하지 못함. 확정 = **공유 레포 토폴로지에서 자동 base 전진 완전 제거**
> (비체크아웃 관측 시에도·자동 재시도 없음 — 열거 스냅숏은 인가 근거 아님).
> 원클릭의 안전 경계 = 정준 통합 ref 확정(integration-ready)·base 반영 =
> **소비자 주도 완결 단일 경로**(`merge --ff-only <통합 ref>` — git이 자기
> worktree 일관 갱신)·Fleet은 base==결과 OID 관측으로 `integrated` 완결·자동
> 전진 재도입은 토폴로지 분리/진짜 배제 도입 시만(§6)·D3 제품 의미 갱신.
>
> **Codex 18R 반영(P1×1 — 제품 결정)**: 17R 안전 결론은 수용됐고, D3(사용자
> 확정 "원클릭 통합")의 암묵 재정의가 지적됨 → **사용자에게 명시 회부, 옵션 C
> 재확정(2026-07-22)**: 이번 슬라이스 = 2단(카드 액션명 "통합 준비"·
> integration-ready가 완료 범위·base 반영=소비자 완결) + **토폴로지 분리
> (bare 정준 레포)로 진짜 원클릭을 복원하는 후속 이슈 등재**. §2 D3 표·
> §3.5 액션명·§3.2 integration-ready 보관 의미론(미적용 표시·결과 ref 보존)·
> §5 완료 정의(2단 약속 단언·폰 여정=통합 준비까지) 갱신.
>
> **Codex 19R 반영(P1×1)**: 정확 tip-일치 관측이 정상 완결을 영구 누락(소비자
> ff 완결 직후 새 커밋이 얹히면 base==R 순간을 폴링이 놓침). 반영 = 완결 판정
> ⓐ정확 일치 또는 ⓑ**불변 resultOid의 조상 도달성**(+저널 targetHeadBefore
> 구성 관계 검증 — source 조상성·동등 내용·빈 머지 추론은 계속 금지)·도달
> 불가(강제 이동/재작성)=완결 금지 fail-closed·결과 ref는 **시도별 불변
> 버전**(`refs/fleet/integrated/<benchId>/<txnId>` — 재시도가 애매하게 덮지
> 않음·저널이 시도별 resultOid 식별)·§5 관측 레이스 테스트 추가.
>
> **Codex 20R 반영(P1×1)**: "어떤 시도든 완결=integrated"가 다중 시도에서
> 위험 — 낡은 T1 머지가 최신 R2 미적용인 채 bench 전체를 종결(경고 소멸→보관
> =잠재 손실)·R1⊂R2 시 순회 순서가 귀속 오염. 반영 = **권위 세대 모델**:
> `currentIntegrationTxnId` 단조 세대 내구 기록(새 시도=내구 supersede 후
> 제시·과거 ref는 감사용·단독 완결 불가)·완결=**현재 시도 resultOid 도달성만**
> ·superseded만 도달=**partially-integrated** 모델 상태(integrated 금지)·
> `completedIntegrationTxnId` 귀속 기록(순회 순서 무관)·소스 변경=시도 무효화/
> 새 세대·보관 보호(superseded 도달로 "완전 통합" 서술·브랜치 삭제 금지)·
> §5 다중 시도 테스트 추가.
>
> **Codex 21R 반영(P1×1)**: R2⊃R1 불변식 부재 — 형제 그래프에서 R1 적용 후
> 안내된 T2 명령의 ff가 실패(완결 불가 정상 그래프). 정책 확정 = **독립 결과
> + 부분 통합 시 재계산 필수**: 각 시도=당시 base 위 독립 구성·**증분 아닌
> bench 전체 스냅숏**(건너뛰기 무손실)·완결 명령 노출 전/관측 시마다 **현재
> base에서 ff 가능성 검사** → 불가 시 명령 노출 중단+**stale-attempt("최신
> 결과 재준비 필요")** 전환·재준비=명시 액션·새 WAL 세대(기존 시도 신원/ref
> 불변 superseded)·완결 판정=재준비 최신 세대만·§5 테스트를 형제/조상 두
> 그래프로 확장.
>
> **Codex 22R 반영(P1×1)**: 시도 무효화와 새 편집 활동 시작 사이 원자성
> 미정의 — CLI 편집 시작 후 무효화 내구화 전 창에서 낡은 R1 완결이
> `integrated`를 확정하는 회귀. 반영 = **활동 시작 권위 순서**(리스→현 시도
> 확인→stale 내구 기록→활동 신원·소스 세대 기록→exec-게이트 — 쓰기 실패 시
> CLI 0줄 실행)·**완료 관측도 동일 리스 + 조건부 CAS**(txn 동일·valid·현
> 소스 세대 대표·활성 편집 세대 없음·전이 가능 재검증)·integrated 이후 활동
> =3R 유지(리스 후 재검증 거부·재개는 비범위)·완결 조건에 **소스 세대 대표성**
> 결합·§5 활동-무효화 원자성 테스트(게이트 직전 정지·둘 중 하나만·크로스
> 프로세스) 추가.
>
> **Codex 23R 반영(P1×1)**: CAS 대상 권위 상태가 엔진-로컬(7R·12R)이라 같은
> 리스를 순서대로 잡아도 서로 다른 저장소를 CAS — server의 T1 무효화·G2를
> Electron의 낡은 로컬 레코드가 못 보고 integrated 확정 가능. 반영 =
> **Workbench 권위 레코드를 코디네이션 영역의 단일 공유 레코드로 이관**
> (7R·12R "엔진-로컬" 개정·저널/리스와 동일 검증·fsync 계약)·엔진-로컬은
> 순수 projection/캐시 강등(인가·CAS 근거 금지·stale=재하이드레이션)·모든
> 전이=리스 안 **fresh read→기대값 검사→기대-revision 확인-응답 CAS**(불일치
> =fail-closed·last-writer-wins 금지)·리스 해제 전 내구화+다음 소유자 fresh
> read 계약·리스 키==레코드 identity·상충 레코드=reconciliation-required·
> §5 공유 권위 크로스 프로세스 테스트 추가.

## 0. 배경 — 왜 지금 이것인가

- 사용자 방향 제시: Fleet의 지향점 = [Orca ADE](https://www.onorca.dev/) 류의
  **Agent Development Environment** — 여러 CLI 에이전트를 격리 worktree에서 나란히
  돌리고, 사람이 그 옆에서 보고 개입하는 경험.
- 정체성 결정(사용자 확정): Orca 클론이 아니라 **Fleet 고유 자산(역할 DAG 오케스트레이션·
  승인 게이트·터널 원격/폰 승인) 위에 ADE 표면을 단계적으로 얹는다.**
- 축 분해와 순서(사용자 확정): ① 병렬 작업 공간(이번) → ② 내장 터미널 → ③ diff
  리뷰 루프 → ④ 비주얼 리디자인. ①이 구조적 척추 — ②③④는 전부 "bench의 패널"로 붙는다.

## 1. 현행 코드 실측 (설계의 땅)

| 사실 | 근거 |
|---|---|
| 워크스페이스는 엔진 보유 **단일 가변 경로** — 엔티티 아님 | `src/main/core/engine.ts:255` `workspaceDir` |
| **단일 활성 런 가드** — 두 번째 `runProjectFlow` 거부 | `engine.ts:653` `activeRuns.size > 0` |
| per-run worktree 격리는 **"Phase C"로 예고**된 상태 | `src/main/core/workspace/set-workspace.ts:9` 주석 |
| worktree 수명주기 이미 구현: `addWorktree`(detached)·`integrate`(cherry-pick)·`removeWorktree` | `src/main/core/workspace/git.ts:189,197,232` |
| worktree 위치 관례: 메인 레포 **밖** 형제 디렉터리 `../.fleet-wt-<id>` | `git.ts:81` |
| #80 병렬 실행: 태스크별 worktree + 태스크별 독립 CLI 세션(`makeEditSession`) + 생성순 순차 통합 | `orchestrator.ts:574-734` · `engine.ts:718-722` |
| 세션 cwd는 고정이 아니라 **send마다 주입** — `SendOptions.workspace` | `src/main/core/session/types.ts:16` |
| spawn cwd 최종 관문 + cwd-셰도 가드(#158) | `src/main/core/cli/detect.ts:120,277` |
| 승인 게이트: apply-diff 등 destructive 경로가 `gate.request` 경유(C1 hold·폰 승인) | `orchestrator.ts:352` · `safety/approval.ts` |
| 렌더러: 3탭 SPA(sessions/project/chat) + 상시 ApprovalModal | `src/renderer/App.tsx:10-16,114` |
| 웹 모드: 채널 매니페스트 + 스냅샷 재하이드레이션 계약(B2/B4) | `src/server/channels.ts` · `hydration.tsx` |

**요지**: worktree 격리·병렬 편집·통합은 태스크 단위로 이미 존재한다. 신규는
(a) 단일 `workspaceDir`·단일 런 가드를 **다중 동시 작업 공간**으로 확장,
(b) 그 작업 공간의 **일급 도메인화 + UI**, (c) 가드류(경로 권위·cwd-셰도·ignored)의
bench 일관 반영이다.

## 2. 핵심 결정 (사용자 확정 5)

| # | 결정 | 기각안 |
|---|---|---|
| D1 | 작업 단위 = **Workbench(worktree + 그 안의 실행들)** — 오케 런도 단일 세션 대화도 그 안에서 | 런-단위 카드(대화형 경험 누락) / 세션-단위 카드(오케 자산 분리) |
| D2 | **일급 도메인 신설**(접근 A) — 도메인·엔진·persist·UI 관통 | 런 중심 최소 확장(후일 개조 재작업) |
| D3 | **브랜치 기반 + 통합 준비 원클릭**(2026-07-22 사용자 재확정 — 18R) — bench = 명명 브랜치(`fleet/<slug>`)의 worktree. 원클릭 = 정준 통합 ref 확정(integration-ready)까지, base 반영 = 안내된 명령 1개의 소비자 완결(§3.2.1-2). **토폴로지 분리(bare 정준 레포)로 진짜 원클릭을 복원하는 후속 이슈를 로드맵에 등재** | 즉시 자동 통합(17R: 공유 토폴로지에서 안전 불가 입증) / 브랜치만(Fleet integrate 자산 사장) / 토폴로지 분리 선행(이번 슬라이스 비대) |
| D4 | UI = **새 '작업' 홈 탭**(기본 탭) + 기존 project/chat 탭 당분간 유지 | project 탭 즉시 개편(첫 슬라이스 비대) |
| D5 | 이름 = **Workbench** — 기존 오케 `Task` 타입과 충돌 회피. UI 표기 "작업 공간" | Task/Job(충돌·혼동) |

## 3. 설계

아키텍처 다이어그램: `fleet-arch/fleet-workbench-architecture.drawio` (레포 밖 보관 관례).

### 3.1 도메인

```text
Workbench(런타임) { id, title, branch: 'fleet/<slug>', baseRef, path, lifecycle, createdAt }
Persisted        { id, title, branch, baseRef, lifecycle, createdAt,
                   archivedBranch? }   // path 없음 — 유도값
lifecycle: 'open' | 'integrated' | 'archived'
archivedBranch: 'preserved' | 'deleted'   // lifecycle==='archived'일 때 필수(그 외 금지)
```

**lifecycle 의미론(worktree 소유 관계)**:
- `open` — worktree 존재·실행 가능.
- `integrated` — 통합 완료. **worktree는 남아 있다**(integrate는 제거하지 않음 —
  §3.2). 실행 계열 액션 비활성, 보관/삭제만 가능.
- `archived` — **worktree 의도적 제거 완료**. 브랜치는 `archivedBranch` 선택에 따라
  보존 또는 삭제됨. worktree 부재가 이 상태의 **정상**이다.
- `busy`·`broken`·`reconciliation-required`는 lifecycle enum이 아니라 **파생
  상태**다 — 각각 활성 실행 레지스트리·복원 검증 실패(§3.1.1)·미결 연산 저널
  (§3.2.2)에서 파생. 저장 상태와 파생 상태의 이원화 금지 원칙.
- lifecycle·파생 상태 규칙의 **집행 권위는 엔진**이다(스윕 B) — UI 비활성은
  표면일 뿐이며, 웹 채널로 직접 호출돼도 lifecycle이 `open`이 아니거나 broken·
  reconciliation-required인 bench의 런/대화/통합 요청은 엔진이 거부한다
  (C1 서버 권위 원칙과 동형).

- `busy`(실행 중 여부)는 **저장하지 않고 파생** — 활성 런/대화 레지스트리에서 계산.
  상태 이원화 금지(C1 서버권위 교훈).
- **`path`는 영속화하지 않는다** — 매 부팅 `benchDir(benchRoot, id)`로 재유도.
  직렬화된 경로라는 신뢰 불가 입력 클래스를 제거한다(Codex 1R P1).
- **`id`는 엔진 생성 ULID** — 엄격·정준·비손실 문법(`^[0-9A-HJKMNP-TV-Z]{26}$`).
  경로 유도에 들어가는 유일한 가변 성분이므로 sanitize 없이 문법 그대로 디렉터리명이
  된다(단사 매핑). `git.ts:79` `sanitize`의 손실 치환(`a/b`·`a?b`→`a_b` 붕괴)은
  bench 경로에 사용하지 않는다(Codex 2R P1).
- `branch`는 생성 시 title에서 유도한 slug로 `fleet/<slug>` 고정 문법
  (`^fleet/[a-z0-9][a-z0-9-]{0,40}$`). slug는 표시·브랜치용이고 경로 유도에는
  쓰지 않는다(경로 성분 = id만).
- **전용 bench 루트 — 부팅 구성·검증(Codex 12R)**: bench worktree는 정준
  `benchRoot` 한 곳 아래에만 둔다(`benchDir = join(benchRoot, id)`). benchRoot는
  workspaceRoot의 부모를 맹목 유도하지 않고 **부팅 시 해석되는 엔진 소유 구성**
  이다: 데스크톱 기본값 = `<workspaceRoot>/../.fleet-wb/`(형제 관례), 서버/
  컨테이너 = `FLEET_BENCH_ROOT` 명시 구성(**전용 영속 볼륨** — 아래). 부팅 시
  검증(런타임 UID 쓰기 가능·링크 검사·containment 규칙) 통과 후에만 Workbench
  기능을 활성화하고, 실패 시 fail-closed(기능 비활성 + 안내 — 조용한 폴백 금지).
- **컨테이너 배포 계약(Codex 12R)**: compose에 bench 전용 named volume/bind
  마운트(예: `/workbenches`)를 추가하고 UID 1000 소유로 초기화, `FLEET_BENCH_
  ROOT`를 그 마운트로 핀한다 — 컨테이너 교체에도 worktree 영속. 메인 레포·
  bench 경로는 재생성 간 **동일 마운트 경로로 안정**해야 하며, 부팅 시 구성
  레이아웃이 git worktree 메타데이터와 다르면 fail-closed(조용한 재생성·prune
  금지). 현행 compose 는 `/workspace`·`/app/fleet-data`만 마운트하므로 이
  계약 없이는 첫 bench 생성이 `EACCES`거나 에페메랄 레이어에 저장된다.

#### 3.1.1 복원 신원 검증 (fail-closed · Codex 1R P1)

재시작 복원은 "존재 확인"이 아니라 **신원 검증**이며, **lifecycle-인지**로 수행한다
(Codex 3R — worktree 부재가 모든 상태의 손상 신호일 수는 없다). 0단계는 전 레코드
공통, 1~6단계는 `open`/`integrated`에만 적용하고, `archived`는 **부재 검증**으로
대체한다. 검증 실패는 **broken 표시**(카드에 노출·실행 불가·삭제만 허용):

0. **레코드 런타임 검증(경로 유도 이전 · Codex 2R)**: 스토어는 `JSON.parse` 타입
   단언뿐이므로(`json-file.ts:35`) 모든 필드를 신뢰 불가 입력으로 취급한다.
   - `id`: ULID 문법 정규식 완전 일치. 구분자·`.`/`..`·제어문자·절대경로·비정규형은
     **거부(sanitize 금지)**.
   - `branch`: `^fleet/[a-z0-9][a-z0-9-]{0,40}$` 완전 일치 독립 검증.
   - `lifecycle` enum 검증. `archivedBranch`는 **`archived`일 때만 필수, 그 외
     존재하면 거부**(조건부 스키마).
   - `baseRef`는 **정준 브랜치명 문법**으로 검증(임의 git rev 인자 금지 — `-` 선행·
     옵션형·`..`/`@{}` 리비전 표현 거부). 통합 대상 신원의 기준값이다(§3.2.1).
   - 유효 id→경로 매핑은 **단사** — 검증 통과한 서로 다른 두 id가 같은 경로로
     정규화될 수 없음(ULID 문법이 보장, 테스트로 고정).
   - 검증 실패 레코드는 broken — **임의 경로 probe·git 호출에 절대 사용하지 않는다.**
1. 기대 경로 = `benchDir(benchRoot, id)` 유도값. 저장된 경로 입력은 없다.
   유도값은 정준화된 `benchRoot`에 대해 `resolveWithin` containment 검증
   (path-guard 이디엄 — 루트·후보 정준화 후 포함 확인, 플랫폼 인지 비교).
   `benchRoot` 자체도 생성/최초 사용 전 링크 검사(`isLinkSync` — #128 B1
   link-guard 이디엄)로 실디렉터리임을 확인, 아니면 fail-closed.
2. 기대 경로를 realpath 정규화(symlink/junction 해소, #128 path-guard 이디엄)한
   결과가 유도값과 동일해야 한다 — 치환된 링크 거부.
3. git 메타데이터로 확인: 해당 경로가 **이 레포의 등록된 linked worktree**이고
   기대 common gitdir을 공유한다(`git worktree list --porcelain` / `rev-parse
   --git-common-dir` 대조). **크로스 프로세스/표면 신원 = common gitdir +
   정준 benchRoot 쌍**(Codex 12R) — 레포 신원만으로는 두 부팅 표면이 같은
   bench 파일시스템을 본다는 증명이 안 되므로, 타 표면의 레코드·저널 수용
   전에 두 값 모두 대조한다.
4. 그 worktree에 **정확히 `fleet/<slug>` 브랜치가 체크아웃**되어 있다(브랜치가
   "어딘가 존재"하는 것으로는 불충분).
5. 중복 거부: 경로 중복·브랜치 중복·다른 bench가 이미 점유한 경로는 전부 거부.
6. **broken 레코드의 경로는 CLI send·git 연산·verify·통합·보관 어디에도 전달하지
   않는다.** 사용자 액션은 "레코드 삭제"만 허용(worktree 자동 재생성·자동 치유 금지).

**lifecycle별 적용(Codex 3R)**:
- `open`: 1~6 전부. 실패 → broken.
- `integrated`: 1~6 전부(worktree가 남아 있는 게 정상이므로 동일 신원 검증).
  통과해도 실행 계열 액션은 lifecycle 규칙대로 비활성.
- `archived`: 1~6 대신 **부재 검증** — ⓐ `benchDir(benchRoot, id)` 경로와 linked
  worktree 등록이 **없어야** 한다(보관이 의도적으로 제거했으므로). worktree가
  잔존하면 **불일치=broken**(조용한 admit·조용한 삭제 둘 다 금지). ⓑ 브랜치는
  `archivedBranch`에 따라 확인 — `preserved`면 존재, `deleted`면 부재. 불일치는
  broken(정합성 경고 노출·삭제만 허용).
- **복원은 어떤 상태에서도 자동 정리·자동 삭제를 수행하지 않는다.** 불일치 해소는
  명시적 사용자 액션이며 파괴적 동작은 승인 게이트를 경유한다.

### 3.2 Git 계층

- `git.ts`에 **named-branch worktree 변형** 추가: `git worktree add -b fleet/<slug> <dir> <base>`
  (기존 detached `addWorktree`는 #80 경로용으로 유지).
- 통합(원클릭): bench 브랜치 → base 반영. 충돌 시 실패 보고·bench는 `open` 유지(파괴 금지).
  **통합은 worktree를 제거하지 않는다** — 성공 시 lifecycle만 `integrated`로 전이.
  현행 `integrate`(cherry-pick)/`removeWorktree`(파괴)의 연산 분리를 보존한다(Codex 3R).
- **무엇을 통합하는가(스윕 C4)**: 통합 트랜잭션은 락 안에서 bench worktree의 현재
  상태를 **자동 keep(스냅숏 커밋, Fleet identity)** 으로 고정하고, 그 결과 bench
  브랜치 HEAD를 불변 `sourceCommit`으로 캡처한다(#80 keep 의미론 승계). 채팅
  bench처럼 커밋을 만들지 않는 실행 경로의 미커밋 작업이 no-op 통합
  (`already-applied`)으로 소실되는 것을 차단한다.
- **보관 가드(스윕 C4)**: 미커밋 변경이 있는 bench는 보관 전 자동 keep으로
  브랜치에 고정한 뒤에만 worktree를 제거한다. **미통합 변경이 남은 브랜치의
  삭제 보관은 파괴적 동작 — `ApprovalGate` 경유**(변경 요약 노출).
- **integration-ready 보관(Codex 18R)**: 미적용 결과(base 미반영)를 가진
  bench의 보관은 "통합 완료"를 함의하는 표시로 제시하지 않는다. 보관해도
  `refs/fleet/integrated/<benchId>` 결과 ref는 보존하고, 카드/기록에 "결과
  미적용" 상태를 명시한다.
- 폐기/보관: worktree 제거 + 브랜치 보존 여부 선택 — 선택 결과를 `archivedBranch`로
  영속화(복원 부재 검증의 기준값, §3.1.1).

#### 3.2.1 통합 조정 계약 (Codex 4R)

현행 `integrate`(`git.ts:197-231`)는 dirty 체크→cherry-pick→`--skip`/`--abort`의
**비원자 다단계**이고 `ok()` 락-재시도를 의도적으로 우회한다(순차 오케 전제,
87-88행 주석). bench 병렬 UI에서는 통합 동시 호출이 정상 경로이므로 계약을 신설한다:

1. **레포 단위 직렬화 — 크로스 프로세스가 안전 경계(Codex 7R)** — 통합
   트랜잭션 전체를 **OS-가시 자문 락**(파일 락, 키 = 정준화된 common gitdir /
   불변 레포 신원)으로 직렬화한다. 데스크톱(Electron main)과 독립 서버가 같은
   레포를 열 수 있으므로 **엔진 in-process 큐는 공정성/UX 층일 뿐 안전 경계가
   아니다**. 임계 구역 = 복구/sequencer 사전 검사 → 대상 체크아웃/ref 검증 →
   source 스냅숏(keep) → WAL prepared → git 변이 → git-applied 기록 →
   lifecycle persist → 저널 finalize까지 전부. 같은 레포에 붙은 bench들은 이
   락을 공유한다 — **bench-로컬 busy 가드로는 불충분**.
   - **소유권·스테일 처리**: 락에 소유자 토큰(엔진 인스턴스 ULID·pid·획득
     시각)을 기록하되 진단용이다 — **연령으로 락을 삭제하지 않는다**. OS 자문
     락은 프로세스 종료 시 자동 해제되므로 "획득 가능 = 소유자 부재 증명"이
     성립한다. 획득 실패·소유 불확실 = fail-closed.
   - **복구도 동일 락**: 부팅 점검은 무변이 관찰만 허용하고, 저널 finalize·
     재시도·롤백·수리 등 모든 결정은 이 크로스 프로세스 락을 먼저 획득한다 —
     다른 Fleet 프로세스가 소유 중인 트랜잭션을 제3자가 reconcile할 수 없다.
   - **Fleet 락 ≠ git 락**: 이 코디네이션 락은 git 자체의 index.lock·sequencer
     파일과 별개다. git 락의 존재만으로 Fleet 트랜잭션 소유권을 추론하지
     않는다(§3.2.1-8의 공유 락 삭제 금지 유지).
2. **프라이빗 통합 worktree + ref-CAS 발행(Codex 13R — 4R "체크아웃 확인"
   대체)** — 통합 계산은 공유 대화형 worktree(컨테이너의 `/workspace` — ttyd
   에도 마운트됨)가 아니라 **엔진 소유·검증된 프라이빗 통합 worktree**
   (benchRoot 하위·detached·ttyd 비마운트)에서 수행한다. 공유 worktree의
   index·sequencer·working tree를 트랜잭션의 일부로 만지지 않는다. 절차:
   락 안에서 대상 ref(`baseRef` — §3.1.1 0단계 검증 완료)의 **OID를 캡처** →
   캡처된 불변 OID 위에서 프라이빗 worktree로 결과 커밋을 구성한다. **발행
   (Codex 16R 확정 — 2단)**: 정확 old-OID CAS·외부 worktree 무접촉은 유지하되,
   **체크아웃된 브랜치의 ref를 뒤에서 전진시키는 것 자체가 금지**다(symbolic
   HEAD가 즉시 새 커밋을 가리켜 옛 index가 staged 변경으로 표시되고, 평범한
   터미널 커밋이 통합을 뒤집을 수 있다 — Codex 재현 확인):
   - **1단(항상 수행)**: 결과 커밋을 **체크아웃 불가 전용 정준 통합 ref**
     `refs/fleet/integrated/<benchId>`에 정확 CAS로 생성한다. 이 시점의 bench
     = **integration-ready**(파생 표시 상태) — 결과는 내구·정준으로 확정됐고
     원클릭의 산출은 항상 성립한다.
   - **2단(base 반영 — 소비자 주도 완결만, Codex 17R)**: 공유 레포
     토폴로지(ttyd·사용자 셸이 언제든 체크아웃을 **생성**할 수 있음)에서는
     worktree 열거가 스냅숏일 뿐이라 이후의 ref 갱신을 인가할 수 없다 —
     체크아웃 생성은 ref를 움직이지 않으므로 old-OID CAS를 통과하면서 그
     체크아웃을 즉시 HEAD/index 불일치로 만든다. 따라서 **Fleet은 baseRef를
     자동으로 전진시키지 않는다**(비체크아웃 관측 시에도 — 어떤 재시도에서도
     같은 레이스가 재현되므로 자동 재시도 없음). base 반영의 유일한 경로 =
     **소비자 주도 git-네이티브 완결**: 사용자가 자기 체크아웃에서
     `git merge --ff-only refs/fleet/integrated/<benchId>` 실행(git이 자기
     worktree를 일관 갱신). UI는 복사 가능한 정확한 명령과 현재 분기 상태
     (ref·index·worktree)를 안내한다 — 특정 reset 명령을 일반 수리로
     처방하지 않는다.
   - **lifecycle 결합(Codex 19R — 관측 레이스 안전)**: `integrated` = Fleet이
     다음 중 하나를 관측한 시점 — ⓐ`baseRef == resultOid`(정확 일치), 또는
     ⓑ**`resultOid`가 현재 baseRef의 조상**이고 저널의
     `targetHeadBeforeIntegration`과 resultOid의 구성 관계가 검증됨(소비자
     완결 직후 사용자가 새 커밋을 얹어 tip이 지나가도 완결을 놓치지 않는다).
     판정 기준은 **이 트랜잭션의 불변 결과 커밋(resultOid)**뿐이다 — 동등
     내용·빈 머지·stderr 텍스트·source 커밋 조상성으로는 완결을 추론하지
     않는다. resultOid가 baseRef에서 도달 불가(강제 이동·이력 재작성)면
     integration-ready 유지 또는 명시 reconciliation — 완결로 기록하지 않는다.
     결과 ref 생성만으로 `integrated`를 기록하지 않는다.
   - **결과 ref 버전·권위 세대 의미론(Codex 19R·20R)**: 소스 변경 후 "통합
     준비" 재시도는 기존 결과 ref를 애매하게 덮지 않는다 — 결과 ref는
     **시도(트랜잭션 ID)별 불변**(`refs/fleet/integrated/<benchId>/<txnId>`).
     - **권위 시도 단일화**: `currentIntegrationTxnId`(단조 세대)를 확인-응답
       경로에 내구 기록한다. 새 시도 T2는 T1을 **내구적으로 supersede한 후에만**
       현재 결과로 제시된다. 과거 결과 ref는 감사·복구용으로 보존되지만
       **단독으로 bench를 완결시킬 수 없다.**
     - **완결은 권위 시도만**: `integrated` 전이는 **현재 시도의 resultOid**가
       기대 baseRef에서 도달 가능할 때만. superseded 결과만 도달 가능하고 최신
       결과가 미적용이면 **partially-integrated**("이전 결과 적용됨 · 최신
       결과 미적용") 모델 상태로 노출 — integrated로 기록하지 않는다.
     - **완결 귀속 기록**: `completedIntegrationTxnId`+resultOid를 내구 기록.
       여러 역사적 결과가 동시에 도달 가능해도(R1⊂R2) 완결은 저널 순회
       순서가 아니라 **권위 시도에 귀속**된다.
     - **소스 변경 무효화**: 결과 준비 후 bench의 추가 변경(런·대화·커밋)은
       그 시도를 무효화하거나 새 세대를 요구한다. UI 안내 명령·보관 정책·
       lifecycle 검사는 전부 **같은 현재 세대**를 참조한다.
     - **보관 보호**: superseded 결과가 도달 가능하다는 이유만으로 "완전
       통합" 서술·bench 브랜치 삭제를 허용하지 않는다. partially-integrated
       bench의 보관을 허용하는 경우 현재 미적용 결과 ref를 보존하고 "최신
       변경 미적용" 경고를 명시한다(§3.2 integration-ready 보관 규칙과 동형).
     - **세대 ancestry 정책 = 독립 결과 + 재계산 필수(Codex 21R)**: 각 시도는
       당시 캡처된 `targetHeadBeforeIntegration` 위에서 **독립적으로** 구성
       되며, 세대 간 후손 관계를 보장하지 않는다(형제 그래프 정상). 대신 각
       시도는 증분이 아니라 **bench 최신 전체 상태(자동 keep 스냅숏)의 결과**
       다 — 이전 시도를 건너뛰고 최신 결과만 적용해도 무손실. 저널은 시도별
       `sourceSnapshot(keep 커밋)`·`targetHeadBeforeIntegration`·`resultOid`를
       기록한다.
     - **partially-integrated / stale-attempt 행동 계약(Codex 21R)**: Fleet은
       현재 세대의 완결 명령을 노출하기 전에(및 관측 시마다) **현재 base에서
       그 결과가 실제로 fast-forward 가능한지** 검사한다. 불가능하면
       (superseded 결과 적용·외부 전진 등) 기존 명령 노출을 **중단**하고
       **"최신 결과 재준비 필요(stale-attempt)"** 상태로 전환한다 — 완결
       불가한 시도가 `currentIntegrationTxnId`로 계속 제시되지 않는다.
       재준비는 명시 카드 액션으로 **새 트랜잭션/WAL 세대**(현재 base 캡처 +
       bench 최신 전체 keep)를 수행하며, 기존 시도의 신원·결과 ref는 변경·
       덮어쓰기 없이 superseded 감사 기록으로 남는다. 이후 `integrated` 판정은
       재준비된 최신 세대의 resultOid 도달성으로만 수행한다.
   - **제품 의미 갱신(D3)**: 원클릭 = 정준 통합 ref 확정(integration-ready)
     까지이며, base 반영은 안내된 명령 1개의 소비자 완결이다. 자동 base 전진
     재도입은 토폴로지 분리(bare 정준 레포·소비자 클론) 또는 진짜 배제
     프로토콜이 도입될 때만 검토한다(§6).
   - **발행 실패(CAS 불일치)**: fail-closed·재계산부터. 새 대상에 암묵
     리베이스/적용하지 않는다. (조상 검사(ff-only)는 정확 CAS가 아니므로
     Fleet 발행 메커니즘으로 쓰지 않는다 — 15R.)
3. **TOCTOU-안전 사전조건** — 대상 ref OID·활동 리스·체크아웃 충돌(항목 9)
   검사는 **락 획득 후** 재수행. 락 대기 전 검사 결과로 이후 변이를 인가할 수
   없다. (공유 worktree dirty 검사는 프라이빗 worktree 방식에서 통합 전제가
   아니다 — 4R 사전조건의 재정의.)
4. **lifecycle 전이 원자성** — `open → integrated`는 git 통합 성공 후에만.
   크래시 일관성(git 성공 + 기록 실패 포함)은 §3.2.2 통합 저널이 담보한다.
   실패/충돌 통합은 bench worktree에 비파괴이고 다른 통합 트랜잭션을 간섭하지
   않는다.
5. **승인·복구** — 명시적 수리·파괴적 정합 해소는 `ApprovalGate` 경유(불변).
   부팅 복구는 cherry-pick sequencer 잔존 상태를 감지하면 **fail-closed** —
   소유권 확인 없이 자동 `--abort`/`--skip`/재시도를 수행하지 않는다.
6. **bench 활동 리스 — 크로스 프로세스 상호배제(스윕 C3 + Codex 8R)** —
   bench에 결부된 모든 오케 런·단일 세션 대화는 시작 시 **OS-가시 활동 리스**
   (키 = 불변 레포 신원 + benchId, §3.2.2 코디네이션 영역과 동일 체계)를
   **배타** 획득하고, 활동 전체 수명 — 취소 정리·revert·세션 종료·최종 persist
   완료까지 — 보유한다. 편집 가능 활동은 전부 배타(읽기-전용 공유는 편집
   불가가 증명된 경우만). 이 리스가 **"bench당 1런" 가드의 크로스 프로세스
   집행 권위**다 — 엔진-로컬 busy 파생은 UI 표시용일 뿐 인가 근거가 아니다.
   - 통합·보관은 레포 변이 락 획득 **후** 이 리스를 획득해야 진행한다 — 타
     프로세스가 리스를 보유 중이면 fail-closed. 변이가 리스를 쥐는 동안 신규
     활동 리스 획득도 차단된다(검사-후-획득 레이스 없음).
   - **취소 ≠ 정지**: 리스 해제는 자식 프로세스 트리 종료와 정리(revert/persist)
     완료 후에만 — 타 엔진 레지스트리의 "idle" 보고로 worktree를 force-remove
     하지 않는다.
   - **keep 스냅숏은 리스 배타 확보 후에만** 뜬다 — CLI가 add/commit 사이에
     파일을 바꿔 `integrated` 아래 미통합 변경이 남는 창을 소거.
   - 크래시로 리스가 자동 해제됐어도 변이 전 worktree·연산 저널 검사를
     선행한다(리스 부재 = 정지 증명이지 정합 증명이 아니다).
   - **`integrated ∧ busy` 도달 불가** 불변식은 유지 — 이제 프로세스 경계를
     넘어 성립한다.
   - **락 서열 고정**: 변이 = ①레포 변이 락 → ②bench 활동 리스. 활동 = 리스만
     (레포 락을 잡지 않음). reconciliation도 동일 서열 — 역방향 획득이 없어
     데드락이 구조적으로 불가능하다.
   - **활동 시작의 원자적 시도-무효화(Codex 22R)** — 새 런/대화의 권위 시작
     순서: ①bench 활동 리스 획득 → ②`currentIntegrationTxnId` 확인 → ③현재
     결과가 존재하면 그 시도의 stale-attempt/"source changed" 전이를 확인-응답
     경로에 **내구 기록** → ④활동 신원·새 **소스 세대(sourceGeneration)**
     내구 기록 → ⑤가디언 exec-게이트 해제. ③/④ 쓰기 실패 = 활동 시작 거부 —
     **CLI가 한 줄도 실행되기 전**이어야 하며 "CLI는 실행됐지만 결과 세대는
     아직 유효" 상태는 존재할 수 없다. 무효화는 시작 시점에 확정된다 —
     활동이 무변경으로 끝나도 이전 시도를 자동 복권하지 않는다(재준비가 정직).
   - **완료 관측의 동일 직렬화 경계(Codex 22R)** — `resultOid` 도달성을
     검사해 `integrated`를 기록하는 관측 경로도 **같은 bench 활동 리스**를
     획득한다(크로스 프로세스 관측 포함 — 리스는 OS-가시). 전이는 읽기-후-
     쓰기가 아니라 권위 저장소의 **조건부 CAS**: `currentIntegrationTxnId`가
     관측한 txn과 동일 ∧ 그 txn이 여전히 valid/current ∧ 그 txn이 **현재
     소스 세대를 대표** ∧ 활성/시작-중 편집 활동 세대 없음 ∧ lifecycle 전이
     가능 — 전부 리스 안에서 재검증 후 기록.
   - **integrated 이후 활동 정책(Codex 22R)** — 3R 규칙 유지: `integrated`
     bench는 실행 계열 비활성이며, 엔진이 **리스 획득 후 재검증**해 새 런/
     대화를 거부한다(§3.1 집행 권위와 정합). 통합 후 추가 작업은 새 bench로
     — lifecycle 회귀(재개) 기능은 이 슬라이스 비범위.
   - **완결 조건의 소스 세대 결합(Codex 22R)** — `integrated` 조건은 "현재
     txn 결과가 base에서 도달 가능"만이 아니라 "**그 txn이 현재 Workbench
     소스 세대를 대표**"까지 포함한다. 활동 시작 = 새 소스 세대 개시(현 시도
     무효화), keep 완료 = 세대 스냅숏 확정, 취소/revert 완료 = 세대 종결.
   - **자식 수명 봉쇄 — 가디언 런처 아키텍처(Codex 9R·10R)** — 엔진 소유
     리스의 크래시 자동 해제는 자식 정지를 증명하지 못하므로(고아 CLI 잔존),
     봉쇄를 설계에서 확정한다:
     - **가디언 런처**: 활동마다 엔진이 소형 전용 가디언 프로세스를 기동한다.
       가디언이 ⓐ활동 리스 획득 ⓑ플랫폼 봉쇄 설치 ⓒ활동 신원 내구 기록을
       완료하기 전에는 **CLI가 사용자 코드를 실행할 수 없다**(exec-게이트:
       win32 `CREATE_SUSPENDED`→Job 배정→resume / posix fork→게이트 파이프
       →exec). spawn-후-부착의 부모-사망 레이스 창이 없다.
     - **가디언 = 수명 권위**: 활동 리스는 엔진이 아니라 **가디언이 보유**한다.
       해제는 관리 트리 **전체 소멸을 관측**하고 Fleet 정리/persist가 끝나고
       정상 종료 레코드를 확인-응답 기록한 후에만. 엔진이 죽으면 가디언이
       트리를 종료·정리 후 해제하거나, 살아있는 가디언이 리스를 계속 쥐어 타
       프로세스가 idle로 오판할 수 없다.
     - **플랫폼 시맨틱(설계 확정 — 스펙 위임 없음)**:
       - **win32**: Job Object를 자식 실행 전 생성·배정(kill-on-job-close·
         breakaway 금지·중첩 잡 동작 명시). Job 멤버십은 전 자손에 상속되고,
         가디언 소멸 = Job 핸들 닫힘 = **트리 종료가 리스 해제와 같은 사건**.
       - **linux 데스크톱(AppImage)**: 가디언이 **systemd 사용자 매니저의
         transient scope**(D-Bus `StartTransientUnit` — `systemd-run --user
         --scope` 동등)를 활동별로 생성한다 — 비특권 사용자의 표준 위임 경로.
         AppImage가 `/sys/fs/cgroup`에 직접 cgroup을 만들지 않는다. 요구
         조건 = systemd 사용자 세션(주류 배포판 기본); 부재 시 활동 시작
         거부(안내 오류 — 지원 조건 문서화). `cgroup.kill` tree-wide 종료·
         `cgroup.procs` 공백 = 사후 증거.
       - **linux 컨테이너 서버**: **cgroup 위임을 요구하지 않는다** — 봉쇄는
         ⓐ**컨테이너 init·PID 네임스페이스 수명**(compose `init: true` — PID 1
         은 init(tini)이고, init 종료 = 네임스페이스 종료 = 커널이 전 프로세스
         종료. 서버 프로세스 종료가 init 종료로 이어지는 컨테이너 수명 계약이
         권위다 — "서버=PID 1"이 아님) + ⓑ**가디언 subreaper**(모든 고아
         자손이 가디언에게 재부모화 — 데몬화도 회피 불가 — 라이브 tree-wide
         관측·정리)로 달성한다. 호스트 cgroup 마운트·
         `CAP_SYS_ADMIN`·privileged **불요 — ADR-0010 컨테이너 경계 무변**.
         rootless/rootful·비systemd 호스트 무관. ② 증거 = 활동 기록의
         **컨테이너 인스턴스 신원**(부팅 마커)과 현 인스턴스 불일치 = 이전
         네임스페이스 소멸 = 트리 사망 확정.
       - PDEATHSIG+프로세스 그룹만으로는 불충분(직접 자식 한정·setsid 이탈)
         — 어느 표면에서도 단독 봉쇄로 쓰지 않는다.
       - **macOS**: 동등한 관측 보장(kill-and-wait) 메커니즘이 확정될 때까지
         **이 슬라이스에서 미지원 — 활동 시작 거부(fail-closed)**. 지원은
         별도 이슈(가디언 설계 포함).
     - **봉쇄 = 시작 전제**: 리스·봉쇄·신원 기록 중 하나라도 확립 실패·불확실
       하면 활동 시작을 거부한다 — 복구 분류의 문제가 아니라 시작의 전제다.
     - **"부착됨"의 의미 = 전 자손 커버**: 첫 자식에 플래그가 설정됐다는 뜻이
       아니라, 선택 메커니즘(Job/cgroup)의 멤버십 상속이 stateless edit·
       상태ful 세션·중첩 태스크 워커·손자를 전부 덮는다는 뜻이다. 종료
       레코드는 tree-wide 소멸 관측 후에만 쓴다.
     - **봉쇄 신원 기록·재사용 구분(Codex 11R)**: exec-게이트 해제 전, 정준
       봉쇄 신원(win32 Job / linux scope unit명+cgroup 경로 / 컨테이너 인스턴스
       마커)을 활동 기록에 내구 기록한다. 복구는 **기록된 신원 기준**으로
       ⓐ존재+점유(→③) ⓑ존재+공백(→② 적격) ⓒ부재·신원 불일치=제거 후 재생성
       의심(→③)을 구분한다 — 경로 문자열 재사용으로 ②를 오판하지 않는다.
     - **이탈 저항의 위협 모델(Codex 11R)**: 봉쇄의 목적은 **사고성 고아
       방지**(비악성 CLI의 부모-사망 후 잔존)다. win32 Job은 breakaway 금지로
       비협조 이탈까지 차단하지만, linux 데스크톱에서 같은 uid 프로세스의
       의도적 cgroup 이탈은 커널상 가능하다 — **악성 코드의 의도적 이탈 방어는
       봉쇄의 비목표**이며 컨테이너/OS 경계 소관(ADR-0010: 에이전트는 이미
       임의 코드 실행 권한을 가진다). "cgroup 공백=트리 사망" 증명은 이 위협
       모델 안에서 성립함을 명시한다.
     - **해제 판정 3분류(보수적)**: ①정상 해제(종료 레코드 있음) ②크래시 +
       기록된 봉쇄 프로토콜이 자손 잔존 불가를 **증명**(win32: kill-on-close
       Job — 가디언 소멸=트리 소멸 / linux 데스크톱: 기록된 scope 의 cgroup
       공백 실측 / 컨테이너: 인스턴스 신원 불일치=네임스페이스 소멸) ③그 외
       전부. **①②만 변이 적격 — ③은 reconciliation-required.** pid 부재·
       리스 획득 가능·clean 스냅숏·사용자 승인은 어느 것도 정지 증거가
       아니다(승인=의도 인가일 뿐 — archive fail-closed 유지).
     - PID 재사용 대응: 활동 신원 = OS 락 소유 + 엔진 인스턴스 ULID·활동 토큰
       — pid는 진단 메타데이터.
7. **레거시 런 상호배제(스윕 A3a)** — 메인 워크스페이스 레거시 런(§3.3)은 같은
   main worktree에서 checkpoint→편집→revert를 수행한다. 레거시 `revert`
   (`reset --hard`, `git.ts:184-188`)가 완료된 통합 커밋을 되감는 것은 **의미
   충돌**이라 순서 직렬화로 막을 수 없다 — 따라서 레거시 런 활성 중 bench 통합
   거부, 통합 트랜잭션 중 레거시 런 시작 거부(락 대상에 main worktree 사용권
   포함). 레거시 런이 후속 슬라이스에서 bench로 흡수되면 이 규정도 소멸(D4).
8. **`ok()` 순차 전제 폐기(스윕 A3b)** — `git.ts:86-88`("오케스트레이터는 순차
   실행이라 동시 git 프로세스 없음 — 락 제거 안전")은 bench 병렬로 무효가 된다.
   스테일 index.lock 강제 제거는 **해당 worktree의 index.lock에 한정**하고
   (현행 `lockPath`가 per-worktree 조회, `git.ts:91-95`), common gitdir 공유
   락 경합은 강제 제거 없이 재시도-only로 재설계한다 — 레거시 런의 `ok()`가
   진행 중 통합의 살아있는 락을 삭제하는 관통을 차단.
9. **외부 작성자(ttyd) 좌표 계약(Codex 13R)** — 프로덕션 compose는 같은
   `/workspace`를 ttyd(무제한 터미널)에도 마운트한다. Fleet 락은 Fleet 간
   자문 프로토콜이므로 셸의 git 프로세스를 배제하지 못한다:
   - **신뢰 모델**: ttyd = 같은 신뢰 도메인의 두 번째 문(운영·CLI 인증 콘솔).
     목표는 적대 셸의 절대 배제(불가능 — `.git` 삭제까지 가능한 무제한 셸을
     자문 프로토콜로 막을 수 없다)가 아니라 **선의의 동시 사용에서 무손상**:
     ⓐ레포 비손상 ⓑ외부 상태 변화 시 fail-closed ⓒ외부 작업 절대 파괴 금지.
   - **비소유 상태 fail-closed**: 공유 worktree의 index lock·merge/cherry-pick
     sequencer·ref 이동은 Fleet 소유 증명이 없으면 절대 정리(abort/skip/
     reset)하지 않는다 — 충돌로 보고만 한다.
   - **외부 worktree 무접촉(Codex 15R·16R)**: Fleet은 외부 worktree의 파일·
     index·HEAD를 어떤 목적으로도 갱신하지 않으며, **체크아웃된 브랜치의 ref를
     뒤에서 전진시키지도 않는다**(전진 자체가 그 worktree의 옛 index를 staged
     역변경으로 만든다 — 16R 재현). 발행 모델 = §3.2.1-2의 2단(결과 ref 확정
     → base 전진은 비체크아웃 시에만·점유 시 integration-ready+사용자 주도
     동기화 안내). 자동 동기화·reset·checkout·clean·특정 reset 처방 전면 금지.
   - **bench 가시성**: `/workbenches`는 이 슬라이스에서 ttyd에 마운트하지
     않는다(터미널은 bench worktree 열람·조작 불가 — 문서화). 향후 ADE
     경험을 위해 마운트하려면 가디언 리스로 표현할 수 없는 외부 활동이
     생기므로 별도 소유권 모델 이슈로 다룬다.

#### 3.2.2 연산 저널(통합·보관) — 크래시 일관성 (Codex 5R·6R + 선제 스윕)

현행 store persist는 오류를 삼키고 void를 반환하므로(`json-file.ts:50-57`)
"git 성공 + persist 실패"를 호출자가 관측할 수 없고, lifecycle 3-상태에는
reconciliation의 자리가 없다. **선기록 저널(WAL)**로 계약을 닫는다:

- **저널 엔트리(내구 기록)**: `{ benchId, sourceBranch, sourceCommit(불변 커밋
  해시), 레포 신원(common gitdir), targetBranch, targetHeadBeforeIntegration(락
  안에서 관측), startedAt }`. 재시작 후 판정은 **가변 브랜치명이 아니라 불변
  커밋 신원**으로 한다.
- **확인-응답(acknowledged) 쓰기 계약**: 저널 기록·완료 기록은 성공/실패를
  호출자에게 반환하는 별도 쓰기 경로(원자적 rename + 오류 전파)를 쓴다 —
  오류를 삼키는 현행 persist 콜백으로는 이 상태 기계를 지탱할 수 없다.
- **통합 결과의 정의(Codex 6R)**: cherry-pick은 **새 커밋 id**를 만들므로
  sourceCommit 도달 가능성으로 성공을 판정할 수 없고, 빈/중복 성공은 커밋을
  만들지 않는다. git 변이 직후 `targetHeadAfterIntegration`을 캡처하고 결과
  종별을 구분해 기록한다: `applied`(새 대상 커밋 생성) | `already-applied`
  (no-op — 대상 HEAD 무변). 무차별 `{ok:true}` 표현 금지.
- **no-op 정책(의도적 결정)**: "이미 반영됨"은 원클릭 통합의 **유효한 성공**으로
  채택한다(통합의 목적 = 변경이 base에 존재; #80 의미론 유지). 단 그 결과
  종별과 무변 target HEAD를 내구 기록하며, **복구 시 stderr 텍스트 매칭을
  트랜잭션 신원으로 쓰지 않는다**(기록된 결과만 권위 — `git.ts:225-227`
  휴리스틱은 실행 시점 분류용일 뿐).
- **WAL 단계**: `prepared → git-applied → finalized`. 모든 단계 전이는
  확인-응답 쓰기.
  1. `prepared` — 사전조건·대상 신원 검사(§3.2.1) 후 sourceCommit·
     targetHeadBefore 캡처와 함께 의도 선기록. 쓰기 확인 실패 시 통합 거부
     (fail-closed, git 무변이).
  2. git 변이는 **캡처된 불변 source commit** 대상으로 수행(브랜치명 아님).
  3. `git-applied` — git 성공 직후, lifecycle 기록 **전에** 결과 종별 +
     `targetHeadAfterIntegration`을 저널에 내구 기록.
  4. `finalized` — `integrated` lifecycle 내구화 후에만 저널 완료/제거.
- **복구는 내구 단계별(부팅·fail-closed)**:
  - `prepared`: git 결과 모호 — bench는 **reconciliation-required**(실행·통합
    불가·카드 노출). 패치 동등성·빈 cherry-pick으로 성공을 추론하지 않는다.
  - `git-applied`: 기록된 결과로 판정 — `applied`면 기록된 대상 커밋이 기대
    target 브랜치에서 도달 가능하고 `targetHeadBefore`와의 관계가 맞는지 검증,
    `already-applied`면 무변 HEAD 관계 검증. 통과 시 lifecycle 완결(저널 완료),
    불일치(target이 기록과 다르게 진행) 시 명시적 reconciliation.
  - `finalized`(또는 `integrated` 내구 + 저널 잔존): **저널 청소 복구**로
    취급 — 새로운 모호 통합이 아니다.
  - 복구 중 자동 재시도·cherry-pick·reset·abort·skip·삭제 일절 금지.
- **내구성 경계(Codex 6R)**: 확인-응답 쓰기는 원자적 rename만이 아니라
  **fsync 기반 내구 경계**(파일 + 부모 디렉터리 동기화)를 요건으로 한다 —
  프로세스 오류만이 아니라 머신/파일시스템 크래시까지 계약 범위. 현행 store의
  tmp+rename은 실패 비노출·fsync 부재로 이 경계를 제공하지 않는다.
- **복구도 동일 규율**: 명시적 재시도·롤백·파괴적 수리는 같은 common gitdir
  락을 재획득하고, 파괴적 동작은 `ApprovalGate`를 경유한다.
- **저널 레코드도 신뢰 불가 입력(스윕 B1)**: 복구는 저널 값을 런타임 검증
  후에만 권위로 승격한다 — 커밋 해시 `^[0-9a-f]{40}$`(SHA-256 레포면 64)
  완전 일치·`benchId` ULID 문법 + **검증 통과한 bench 레코드와 대조**(고아
  저널 = reconciliation-required)·브랜치 필드는 §3.1.1 0단계 문법 재사용·
  common gitdir는 저장값을 권위로 쓰지 않고 엔진 유도값과 **대조만**. 검증
  실패 저널 = 해당 bench reconciliation-required(git 호출 금지·자동 삭제 금지).
- **보관도 저널 보호(스윕 A1)**: 보관 = worktree 제거 + 브랜치 삭제(선택) +
  lifecycle/`archivedBranch` 기록의 **다단계 파괴 연산** — 통합과 동일한 WAL
  단계를 적용한다: `prepared`(의도 기록 — `archivedBranch` 선택 포함) → 파괴
  실행(자동 keep→worktree 제거→브랜치 삭제 선택 시) → `finalized`(`archived`
  내구화 후 저널 완료). 미결 보관 저널 = 부분 보관 — fail-closed, 잔여 단계
  완결은 명시 액션(동일 락·파괴 단계는 ApprovalGate). 저널이 "크래시된 정상
  보관"과 "손상/변조"를 구분하는 증거가 된다.
- **확인-응답 저장 경로 이관(스윕 N1)**: "`integrated`/`archived` 내구화 후에만
  저널 완료" 게이트가 성립하려면 lifecycle 기록 자체가 관측 가능해야 한다.
  **bench 레코드(§3.1 Persisted)와 저널은 기존 store(오류 삼킴 persist,
  `json-file.ts:50-57`)와 분리된 확인-응답·fsync 저장 경로를 사용**한다.
  기존 store는 비-안전-크리티컬 데이터(프로젝트·채팅 등)에 유지 — 이관 없이는
  finalized 전이가 관측 불능이거나, "저널 제거+lifecycle 무성 실패+크래시"
  창에서 통합 완료 bench가 무신호로 `open` 회귀한다.
- **저널 위치 = 레포-스코프 코디네이션 영역(Codex 7R)**: 연산 저널은 앱
  데이터가 아니라 **정준화된 common gitdir 하위 `fleet/` 영역**에 둔다 —
  어떤 부팅 표면(데스크톱/서버)이든 같은 레포를 열면 같은 미결 트랜잭션을
  발견한다. 앱-로컬 저널로는 공유 레포 변이를 중재할 수 없다. 저널 엔트리는
  소유자 토큰(엔진 인스턴스 ULID)을 포함하고, **자기 소유가 아닌 미결 저널이
  있으면 그 레포의 통합·보관을 fail-closed로 차단**한다(해소는 §3.2.1-1 크로스
  프로세스 락 획득 후에만). 저널 레코드 검증(스윕 B1)·fsync 내구 경계는 이
  위치에서도 동일 적용.
- **Workbench 권위 레코드도 코디네이션 영역(Codex 23R — 7R·12R "엔진-로컬"
  개정)**: `currentIntegrationTxnId`·`sourceGeneration`·txn 유효성·lifecycle·
  활동 세대·`completedIntegrationTxnId` 등 **인가·전이의 근거가 되는 모든
  권위 상태**는 엔진별 로컬 레코드가 아니라 코디네이션 영역의 **단일 공유
  권위 레코드**에 둔다(저널·리스와 동일 계약: 비신뢰 JSON 0단계 검증·fsync·
  symlink/소유 규칙). 엔진-로컬 레코드는 **순수 projection/캐시(UI 카드 뷰)**
  로 강등 — lifecycle 인가·CAS 근거로 사용 금지, stale이면 재하이드레이션
  또는 명시 stale 표시(캐시 기반 액션 불허).
  - **revision 기반 조건부 전이**: 권위 레코드는 단조 revision을 갖고, 모든
    전이(활동 시작·통합 준비·완료 관측·보관·복구)는 리스 안에서 **fresh
    read → 기대값 검사(lifecycle·currentTxnId·유효성·sourceGeneration·활성
    활동 부재) → 기대-revision 확인-응답 CAS 쓰기**로 수행한다. 불일치 =
    자동 병합·last-writer-wins가 아니라 재조회 후 fail-closed.
  - **가시성·내구 계약**: 리스 해제 전 전이를 내구화하고, 다음 리스 소유자는
    반드시 내구 상태를 **fresh read**한다 — 장기 보유 인메모리 스냅숏을 CAS
    입력으로 쓰지 않는다.
  - **identity 결합**: 리스 키(레포 신원+benchRoot+benchId) == 권위 레코드
    identity — 서로 다른 부팅 표면·앱 데이터 디렉터리가 같은 bench를 별개
    권위 레코드로 만들 수 없다.
  - **상충 레코드**: 마이그레이션·이중 표면에서 같은 bench에 상충하는 권위
    필드가 발견되면 임의 선택·last-writer-wins 없이 reconciliation-required.
    공유 권위가 확립되기 전에는 어떤 표면도 exec-게이트 해제·lifecycle 확정을
    하지 않는다.
- **중첩 worktree**: bench worktree 안에서 #80 태스크별 worktree가 동작(모든 worktree가
  common gitdir 공유). git이 지원하는 구성이나 **계약 테스트로 고정**한다.

### 3.3 엔진

- 단일 활성 런 가드(`engine.ts:653`) → **"bench당 1런, bench 간 병렬"**. bench 없는
  레거시 런(메인 워크스페이스)은 종전대로 전역 1개 — 기존 테스트·e2e 무파손.
- `runProjectFlow(goal, { benchId? })`: 오케 런의 `workspaceRoot = bench.path`.
- 채팅/단일 세션: 방에 `benchId` 연결 → `send({ workspace: bench.path })`. (D1의 "둘 다")
- 승인: bench 런도 기존 `ApprovalGate` 동일 경유 — hold·TTL·폰 승인 전부 그대로.

### 3.4 안전·경계

- **bench 경로 권위 = 레지스트리**: 사용자 입력 경로가 아니라 엔진이 생성·등록한 경로만
  cwd로 허용. 웹 `workspace:set`의 `resolveWithin` 가드와 별개 경로(그 가드는 불변).
  레지스트리 admit의 전제 = §3.1.1 신원 검증 — cwd-셰도·ignored 가드는 호출자가 준
  디렉터리를 전제로 동작하므로(`detect.ts:281-303`), 잘못된 경로를 admit하면 가드가
  무력화된다. 검증이 가드보다 앞선다.
- cwd-셰도 가드(#158) excludeDir에 bench 경로 일관 반영.
- ignored-baseline·diff-risk·env allowlist(B6)·샌드박스 경계(ADR-0010) 변경 없음 —
  bench 경로에 동일 적용.

### 3.5 UI

- 새 **'작업' 탭 = 기본 홈**. bench 카드 그리드: 제목·브랜치·상태 배지(busy/
  리뷰 대기/**통합 준비됨(integration-ready)**/통합됨)·변경 파일 수·마지막 활동.
  액션: 런 시작 / 대화 열기 / **통합 준비**(18R — "통합"으로 표기하지 않는다:
  integration-ready까지가 이 액션의 정직한 범위) / 보관. integration-ready
  카드에는 소비자 완결 명령(복사 버튼)과 분기 상태를 표시한다.
- 카드 진입 → bench 상세: 첫 슬라이스는 런 이벤트 로그 + 변경 파일 목록 수준.
- 모바일: #221의 640px CSS-only 패턴 준수(폰에서 카드 그리드→승인까지).

### 3.6 웹 모드

- 채널 매니페스트에 bench CRUD·이벤트 채널 추가(B2 3중 게이트: channels·fixtures·
  serialization 준수).
- 스냅샷 재하이드레이션에 bench 상태 포함(재접속 시 카드 복원 — B4 계약 유지).

## 4. 슬라이스 개요 (계획 단계 입력)

PR 3~4개 분할 예상: ① 코어 도메인+git(named-branch·lifecycle·persist, UI 없음) →
② 엔진 배선(가드 재편·benchId 런/채팅) → ③ UI 홈 탭(카드 그리드+상세) →
④ 통합/보관 UX+웹 채널·재하이드레이션. 확정 분할은 체크포인트 3(판사 패널 계획)에서.

## 5. 완료 정의 (1축)

- 서로 다른 bench 2개에서 오케 런과 단일 세션 대화가 **동시에** 진행되고, 각자의
  worktree 밖을 건드리지 않는다(격리 계약 테스트).
- 카드에서 생성→런→변경 확인→**통합 준비(integration-ready)**→소비자 완결
  (`merge --ff-only <통합 ref>`)→`integrated` 관측→보관 완주(e2e, web 포함).
  Fleet 액션 단독으로는 integration-ready까지만 도달함을 **단언**한다(18R —
  2단 약속에 맞는 테스트).
- 라이브: 실 터널+폰에서 카드 그리드 확인·bench 런 승인·**통합 준비까지 폰
  완결** 실증. base 소비자 완결은 폰에서도 ttyd 웹터미널(두 번째 문)로 가능
  하나 별도 표면임을 여정에 명시.
- **배포 수명주기(Codex 12R)**: 컨테이너에서 bench 생성 → 선언된 볼륨을 보존한
  채 컨테이너 교체(재생성) → 동일 linked worktree·정확한 브랜치 신원 복원 →
  런 또는 보관 성공. (단일 컨테이너 내부 프로세스 재시작만으로는 이 실패
  모드를 못 잡는다.)
- **외부 작성자 경합(Codex 13R)**: fleet 컨테이너에서 통합 진행 중 ttyd에서
  대상 브랜치를 전진/전환 — Fleet이 캡처된 대상 OID에 정확히 발행하거나,
  lifecycle 무변·비소유 git 상태 무정리·대화형 worktree 무손상으로 fail-closed
  실패함을 검증.
- **기본 배포 상태 통합(Codex 14R~17R)**: compose 스택을 base가
  `/workspace`에 체크아웃된 그대로 기동, ttyd에서 무관한 변경을 **stage**해
  둔다 → 체크아웃 전환 없이 bench 생성·통합 → 결과가 `refs/fleet/integrated/
  <benchId>`에 정확 CAS로 확정되고 bench가 integration-ready로 노출되며,
  **Fleet이 baseRef에 `update-ref`를 일절 실행하지 않고 base·symbolic HEAD·
  index·worktree 어느 것도 변하지 않음**을 검증 → 터미널의 평범한 커밋이
  통합 결과를 조용히 무효화할 수 없음(조상 관계 포함) 확인 → 터미널에서
  `merge --ff-only refs/fleet/integrated/<benchId>` 실행 시 Fleet이 base==
  결과 OID 일치를 관측해 `integrated`로 완결함을 확인 → **base가 비체크아웃인
  상태에서도 Fleet이 자동 전진하지 않고**(17R — 열거 스냅숏은 인가 근거가
  아님) integration-ready로 유지됨을 확인. 발행 중 ttyd **일반 파일 쓰기**
  경합 — 무접촉·캡처 OID 변경 시 결과 ref CAS 성공 미보고 검증.
- **관측 레이스(Codex 19R)**: 결과 `R` 준비 → 소비자 ff 머지로 base=R → Fleet
  관측 전에 평범한 커밋 `N`을 R 위에 생성 → Fleet이 **R 조상 도달성**으로
  `integrated` 완결함을 검증. 또한 강제 이동/분기 재작성으로 R이 base에서
  도달 불가인 경우 완결하지 **않음**(integration-ready/reconciliation 유지)을
  검증.
- **다중 시도(Codex 20R·21R — 두 그래프 형태)**:
  - **형제 그래프**(T1·T2 모두 base A 위 독립 구성): R1만 머지 → `integrated`
    미전이·partially-integrated 노출 + **T2의 ff 불가 감지 → 기존 명령 노출
    중단·stale-attempt("최신 결과 재준비 필요") 전환** 검증 → 재준비 T3(현재
    base=R1 캡처) 후에만 완결 가능·완결은 T3 귀속 검증.
  - **조상 그래프**(R1 적용 후 T2 준비 — base=R1 캡처): R2 정상 ff → 완결이
    정확히 T2에 귀속됨을 검증.
  - R1을 건너뛰고 R2만 적용해도 bench 최신 변경 **전체**가 포함됨(시도=전체
    스냅숏·증분 아님) 검증.
  - 저널 순회 순서가 완결 시도 선택에 영향 없음 지속 검증.
- **활동-무효화 원자성(Codex 22R)**: T1/R1 준비 후 새 런 시작을 exec-게이트
  직전에 정지 → R1 소비자 머지와 Fleet 완료 관측을 동시 실행 → 재개 시 다음
  중 **하나만** 가능함을 검증: ⓐR1이 먼저 완결(`integrated`)되면 새 활동이
  lifecycle 규칙으로 거부됨 / ⓑ새 활동이 먼저 T1을 내구 무효화하면 R1이
  도달 가능해도 `integrated`로 전이하지 않음. 무효화 저장 실패 시 **CLI가 한
  줄도 실행되지 않음** 검증. 활동 완료 후 T2 준비 전까지 이전 R1 명령이 현재
  결과로 노출되지 않음 검증. 관측기와 활동 시작이 **서로 다른 프로세스**
  (Electron/server)인 경우 포함.
- **공유 권위 상태(Codex 23R)**: Electron·server가 **서로 다른 로컬 캐시
  스냅숏**으로 같은 bench를 연 상태에서 — server가 리스 획득·T1 무효화·G2
  활동을 공유 권위 레코드에 내구 기록 후 리스 해제 → Electron 관측기가 낡은
  T1/G1 캐시를 가진 채 리스 획득 → **공유 권위의 G2를 fresh read하여 R1
  도달 여부와 무관하게 `integrated` 전이를 거부**함을 검증. stale 전체
  스냅숏의 순차 기록이 최신 세대를 되돌리지 못함(revision-CAS) 검증.
  acknowledged 쓰기 실패·revision 불일치 시 CLI 미실행·lifecycle 무변 검증.
- verify 7게이트 GREEN.

## 6. 열린 질문 (스펙 체크포인트에서 확정)

- 통합 구현: merge --squash vs 기존 cherry-pick `integrate` 재사용 — 충돌 보고
  형태 포함. **주의: squash 채택 시 §3.2.2 WAL(단일 sourceCommit·cherry-pick
  전제) 재작성 필요.**
- bench 수 상한·동시 런 상한(리소스/레이트리밋 보호)과 초과 시 UX.
- 레거시 런과 bench 런의 이벤트 스트림 구분(RunActivity 스키마 additive 확장 형태).
- slug 충돌·재사용(같은 제목 bench 재생성) 규칙 + **title→slug 유도 함수 계약**:
  비ASCII/빈 slug 처리(거부 vs id 폴백 — 한글 title이 주류 경로)·유도 출력이
  branch 문법을 항상 만족한다는 불변식·생성 시점 재검증.
- bench 생성 순서와 고아 산출물: worktree/브랜치 생성 후 레코드 미영속 크래시의
  고아 감지·표시(자동 삭제 금지 원칙 유지).
- bench 런 내부 #80 태스크 worktree의 배치(benchRoot 안 vs 현행 형제 관례) 명시.
- ~~다중 엔진 동시 기동 시 락 전제~~ — **7R에서 설계로 해소**(§3.2.1-1 크로스
  프로세스 자문 락 + §3.2.2 레포-스코프 저널). 스펙 잔여 = 락 파일 위치·자문
  락 API 선택(win32/posix 정합)·소유자 토큰 스키마.
- ~~자식 수명 봉쇄 플랫폼 전략·부착 실패 정책~~ — **10R에서 설계로 해소**
  (§3.2.1-6 가디언 런처: win32 Job/linux cgroup 필수/macOS 미지원 확정·봉쇄=
  시작 전제). 스펙 잔여 = 가디언 프로토콜 와이어 포맷·exec-게이트 구현·Job/
  cgroup API 세부.
- broken ∧ 미결 저널 동시 성립 시 우선순위·카드 표현 + broken 레코드 삭제와
  고아 저널의 수명 규칙(삭제 전 저널 해소 강제 여부).
- `prepared` 복구를 포기/롤백할 때의 결과 lifecycle(전이표 완결).
- 토폴로지 분리 옵션(bare 정준 레포 + `/workspace`=소비자 클론) — 도입 시에만
  자동 base 전진 재검토(17R). 이 슬라이스에서 base 반영은 소비자 주도 완결이
  유일 경로.
