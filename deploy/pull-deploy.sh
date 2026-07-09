#!/usr/bin/env bash
# Fleet GHCR pull 배포 — 서버측 멱등 갱신 (#222 CD · Part of #98).
#   cron 예: */5 * * * * /path/to/deploy/pull-deploy.sh >> ~/fleet-deploy.log 2>&1
#
# 절차: flock(겹침 방지) → Compose 2.24+ 가드(!reset) → pull → up -d --wait → dangling prune.
# 실패 처리: pull 실패 = 이전 컨테이너 계속 가동(무중단 — recreate 전). up/healthcheck 실패 = compose 가 이미
#   새(깨진) 이미지로 recreate 한 뒤라 이전 컨테이너가 없다(Codex PR P1) → fail() 이 loud abort + logs, 운영자가
#   롤백(GHCR_TAG=sha-<이전> 재실행). 자동 롤백은 비목표(계획 §2 · blue-green 미도입).
# ⚠️ up --wait GREEN 은 FLEET_ACCESS_* 완비만 방증한다(FLEET_HOST=0.0.0.0 → resolveBindHost 이중게이트가 access
#    env 없으면 throw → crash-loop → 타임아웃). 이 타임아웃은 "배포 실패" 가 아니라 config 갭 — README 참조.
#    ⚠️ FLEET_SECRET_KEY 는 GREEN 으로 검증되지 않는다 — 미설정/오류여도 강등되어 계속 부팅·정적 200·GREEN 이지만
#    API 키가 영속되지 않는다(조용한 강등). GREEN 이어도 `docker logs | grep 영속되지 않는다` 로 별도 확인.
#    롤백 = GHCR_TAG=sha-<이전12> 후 재실행(:latest 를 되돌리는 게 아니라 sha 핀으로 명시 복귀).
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# cron */5 재실행이 이전 pull/up 과 겹치지 않게 단일화(진행 중이면 이번 회차 skip — 멱등·경합 회피).
exec 9>"/tmp/fleet-pull-deploy.lock"
flock -n 9 || {
  echo "[pull-deploy] 이전 실행이 진행 중 — 이번 회차 skip"
  exit 0
}

# compose/override(env·volume·healthcheck·profile) 변경도 master→서버 반영 — 이미지 pull 전 배포 체크아웃을
# ff-only 로 갱신(서버가 레포 clone 인 전제). 비-git·divergence 면 skip(경고) → compose 수동 동기화.
# ⚠️ GHCR_TAG=sha-<N> 롤백 핀 사용 시엔 compose 도 그 커밋으로 수동 checkout 하라(이 ff-only 는 latest 추종
#    전제 · 롤백 중 master compose 가 old 이미지와 불일치하는 것 방지 — Codex PR P2).
git pull --ff-only >/dev/null 2>&1 || echo "[pull-deploy] git ff-only 갱신 skip(비-git 또는 divergence — compose 수동 확인)"

# !reset 은 Docker Compose 2.24+ 필요. 미달이면 override 병합이 조용히 깨질 수 있어 명시 중단(fail-closed).
ver="$(docker compose version --short 2>/dev/null || echo 0)"
major="${ver%%.*}"
rest="${ver#*.}"
minor="${rest%%.*}"
if [ "${major:-0}" -lt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -lt 24 ]; }; then
  echo "[pull-deploy] FAIL: Docker Compose '$ver' — !reset 미지원(2.24+ 필요). override 병합 불가." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel)

fail() {
  echo "[pull-deploy] FAIL: $*" >&2
  "${COMPOSE[@]}" logs --tail=50 2>&1 || true
  exit 1
}

# 롤백 참조용 — pull 전 현재 이미지 digest 로그(다운 시 복귀 대상 캡처).
echo "[pull-deploy] 현재 이미지:"
"${COMPOSE[@]}" images 2>/dev/null || true

"${COMPOSE[@]}" pull || fail "GHCR pull(네트워크/인증 — docker login ghcr.io 만료? GHCR_TAG 부재?)"
# --wait-timeout: never-healthy(access env 누락 crash-loop) 시 --wait 무한 hang → flock 영구 점유 → 후속
# cron */5 전부 skip(배포 스타베이션) 방지. 초과 시 fail() 로 exit → 락 해제 → 다음 cron 재시도.
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 || fail "up/healthcheck(--wait 300s 초과 — access env 완비? 롤백: GHCR_TAG=sha-<이전> 후 재실행)"
docker image prune -f || true # dangling 만 회수(-a 금지: 이전 :sha 롤백 보존). 실패는 비치명.
echo "[pull-deploy] OK: 갱신 완료."
