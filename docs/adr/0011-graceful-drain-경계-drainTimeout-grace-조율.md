---
adr: 0011
title: graceful drain 경계 — drainTimeout↔stop_grace_period 조율은 코드가 아니라 문서·env·canary 로 강제한다
status: Accepted
date: 2026-07-09
related: "#216 (Phase C C3), #193 (v3 메타), #197 (Phase B 컨테이너 배포), ADR-0010 (샌드박스 경계 선례)"
---

## 맥락

Phase C(#216) C3 는 SIGTERM(재배포·`docker stop`) 시 **신규 런 거부 → 통지 → 진행 런 완료 대기(상한) →
pending 승인 rejectAll → 종료** 의 정연한 드레인을 도입한다. 드레인 대기 상한은 `FLEET_DRAIN_TIMEOUT_MS`
(기본 25s)로 설정한다. 그런데 컨테이너 배포에서 실제 종료 유예는 Docker 의 `stop_grace_period` 가 정한다:
`docker stop` 은 SIGTERM 을 **1회** 보내고 grace 만료 시 **SIGKILL** 로 잘라낸다(SIGTERM 재전송 아님).
즉 드레인 상한이 grace 를 넘으면 **SIGKILL 이 드레인을 절단**해, 운영자가 상한을 올려도 보호받지 못한다
(오히려 "보호받는다"는 오인이 더 위험하다). 그런데 **서버 프로세스는 자신을 감싼 컨테이너의
`stop_grace_period` 값을 알 수 없어**, 이 조율을 코드로 강제할 방법이 없다.

부수로, 통지 채널(`fleet:server:draining`)은 개념상 **서버만 방출·웹만 구독**인데, 채널 scope 모델
(`both | desktop`)에 'server-only-emit' 범주가 없다. `both` 를 고르면 ipc-parity(`subscribe==send`)가
데스크톱 main 방출까지 강제한다.

## 결정

**drainTimeout↔stop_grace_period 조율은 코드가 아니라 문서·페어링 env·smoke canary 로 강제한다.**

1. **조율 계약**: `FLEET_DRAIN_TIMEOUT_MS/1000 + 3 ≤ FLEET_STOP_GRACE`(초). 운영자가 상한을 올리면
   `FLEET_STOP_GRACE`(= compose `stop_grace_period`)도 함께 올려야 한다. `.env.example`·compose 주석에 명시.
2. **상한 MAX = 120s**(2분). "무한정 대기" 오설정을 막는다 — 실 런은 분 단위라 상한 내 완주는 드물고, 상한은
   «거의 끝난 런(verify/commit 꼬리)의 착지» 유예다. (초안 스펙의 MAX 5분은 30s 기본 grace 의 10배라 자기모순 →
   120s 로 조임.) 범위 밖은 부팅 거부(fail-fast).
3. **compose 필수화**: fleet 서비스에 `stop_grace_period: ${FLEET_STOP_GRACE:-30s}` 를 둔다(미설정 시 Docker
   기본 10s 가 25s 드레인을 절단). `deploy/smoke.sh` §12 canary(`grep stop_grace_period`)가 이 load-bearing
   속성의 삭제 회귀를 차단한다. `docker-compose.ghcr.yml` override 는 build/image 만 덮으므로 상속(canary 로 단언).
4. **백스톱 계층**: (a) 로컬/베어호스트 = index.ts `drainTimeoutMs + 3000`(boot resolve 후 무장) + 2차 시그널
   즉시 종료(Ctrl-C 연타). (b) boot-pending 중 SIGTERM = index 동기 백스톱 없음(drainTimeoutMs 미상) → 2차
   시그널/컨테이너 SIGKILL 에 위임. (c) 컨테이너 궁극 backstop = SIGKILL@stop_grace_period.
5. **통지 scope = `both`, main inert 방출**: 'server-only-emit' 범주를 신설하지 않고 `both` 로 선언한다. 웹
   서버(boot shutdown)가 실 통지하고, 데스크톱 main 은 will-quit 에서 `webContents.send` 하되 실효 inert
   (ConnectionBanner web 전용·HydrationProvider bridge=null 미구독). ipc-parity(`subscribe==send`) 불변식 보존이
   inert 방출 1줄의 비용보다 크다.

## 고려한 대안 / 기각 사유

- **서버가 `stop_grace_period` 를 읽어 drainTimeout 을 자동 clamp**: 기각 — 컨테이너 런타임이 자신의 grace 를
  프로세스에 노출하지 않는다(env 로 주입하면 그건 이미 우리가 페어링하는 `FLEET_STOP_GRACE` 와 동일). 감지 불가.
- **drainTimeout 을 grace 안쪽으로 강제하는 boot WARN/거부**: 기각 — 기준값(grace)을 서버가 모르므로 임의
  상수 대비 경고가 되어 오탐/미탐이 불가피. 조율은 배포 설정 층의 책임이라 canary + 문서가 정직하다.
- **채널 scope 에 'server-only-emit' 범주 신설**: 기각(ADR-0003 과설계 경계) — channels 타입·parity 2종·
  BothPushChannel 파생을 건드리는 표면 확대. main inert 방출 1줄이 불변식을 깨지 않고 더 싸다.
- **드레인 대기를 채팅/probe 까지 확대**: 비범위 — #216 "진행 런" = 프로젝트 런(activeRuns·워크스페이스 권위
  편집자). 채팅 destructive 도구는 teardown rejectAll 이 차단하고, 확대는 종료 지연만 키운다.

## 결과 (Consequences)

- **좋은 점**: 재배포/컨테이너 종료가 진행 런의 꼬리를 착지시킬 유예를 얻고, 소리 없는 죽음이 사라진다.
  드레인 코어(파싱·대기·게이트·shutdown)는 순수/주입 clock 으로 결정론 검증되고, 엔진은 무변경(ADR-0003 코어
  표면 최소화). shutdown 은 close 위의 순수 추가층이라 index.ts 에서 `shutdown()`→`close()` 로 되돌리면 현행
  종료로 즉시 원복(하한선 = 드레인 미도입 = 현행 동작).
- **감수하는 비용**: (a) 조율(`drain+3 ≤ grace`)은 코드가 아니라 운영자 규율이다 — 어기면 최악은 **현행과 동일한
  절단**(신규 손상 아님)이나, "보호받는다"는 오인 여지가 있어 문서에 강하게 경고한다. (b) 상한 초과 시 force
  abort(오케스트레이터 revert)라 진행 런의 완주는 보장되지 않는다(상한은 best-effort 유예). (c) 데스크톱 main
  의 inert draining 방출은 실효 없는 1줄이나 parity 계약상 유지한다. (d) teardown(close/dispose) 자체엔
  타임아웃이 없다(ADR-0003) — hang 시 index 백스톱/SIGKILL 이 종착.
- **재검토 트리거**: 배포가 Swarm/k8s 등 healthcheck-기반 kill/livenessProbe 로 이동(드레인 중 unhealthy→kill
  상호작용 재검토), 컨테이너 런타임이 grace 를 env 로 노출, Web Push(C4)로 draining 을 인증 이전 채널에 실을 때
  (위협모델 변화), 채팅/다중 사용자 격리 요구 대두.
