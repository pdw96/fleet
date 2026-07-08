#!/usr/bin/env bash
# Fleet GHCR pull 배포 — 서버측 멱등 갱신 (#222 CD · Part of #98).
#   cron 예: */5 * * * * /path/to/deploy/pull-deploy.sh >> ~/fleet-deploy.log 2>&1
#
# 절차: flock(겹침 방지) → Compose 2.24+ 가드(!reset) → pull → up -d --wait → dangling prune.
# fail-safe: pull/up 실패 시 set -e loud abort + logs, 이전 컨테이너는 계속 가동(무중단). 자동 승격 없음.
# ⚠️ up --wait GREEN 은 서버 .env 의 FLEET_ACCESS_*·FLEET_SECRET_KEY 완비를 전제(resolveBindHost 이중게이트).
#    access env 누락 타임아웃은 "배포 실패" 가 아니라 config 갭 — README 「런타임 시크릿 전제」 참조.
#    롤백 = GHCR_TAG=sha-<이전12> 후 재실행(:latest 를 되돌리는 게 아니라 sha 핀으로 명시 복귀).
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# cron */5 재실행이 이전 pull/up 과 겹치지 않게 단일화(진행 중이면 이번 회차 skip — 멱등·경합 회피).
exec 9>"/tmp/fleet-pull-deploy.lock"
flock -n 9 || {
  echo "[pull-deploy] 이전 실행이 진행 중 — 이번 회차 skip"
  exit 0
}

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
"${COMPOSE[@]}" up -d --wait || fail "up/healthcheck(--wait GREEN 실패 — access env 완비? 롤백: GHCR_TAG=sha-<이전> 후 재실행)"
docker image prune -f || true # dangling 만 회수(-a 금지: 이전 :sha 롤백 보존). 실패는 비치명.
echo "[pull-deploy] OK: 갱신 완료."
