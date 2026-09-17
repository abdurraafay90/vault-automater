#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/vault-automater
PROJECT=vault-automater
COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml")
STATE_FILE=${STATE_FILE_OVERRIDE:-$ROOT/.deploy/verified-release.env}

IMAGE_PREFIX=''
IMAGE_TAG=''
RELEASE_KIND=''
DATABASE_BACKUP=''
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  case "$key" in
    IMAGE_PREFIX|IMAGE_TAG|RELEASE_KIND|DATABASE_BACKUP|VERIFIED_AT) printf -v "$key" '%s' "$value" ;;
    '') ;;
    *) echo "Unexpected release-state key: $key" >&2; exit 2 ;;
  esac
done < "$STATE_FILE"

[[ "$IMAGE_PREFIX" =~ ^[a-z0-9./_-]+$ && "$IMAGE_TAG" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "Invalid release state" >&2; exit 2; }
[[ "$RELEASE_KIND" == ghcr || "$RELEASE_KIND" == local ]] || { echo "Invalid release kind" >&2; exit 2; }
export IMAGE_PREFIX IMAGE_TAG

if [[ "$RELEASE_KIND" == ghcr ]]; then
  if [[ -z "${GHCR_TOKEN:-}" ]]; then IFS= read -r GHCR_TOKEN || true; fi
  [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]] || { echo "GHCR credentials are required for image rollback" >&2; exit 2; }
  echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
  "${COMPOSE[@]}" pull api web worker
else
  for service in api web worker; do
    docker image inspect "$IMAGE_PREFIX/$service:$IMAGE_TAG" >/dev/null || { echo "Rollback image is missing locally: $IMAGE_PREFIX/$service:$IMAGE_TAG" >&2; exit 1; }
  done
fi

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" stop -t 660 worker
"${COMPOSE[@]}" up -d --no-build --force-recreate --scale worker=1 api web worker

deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  api=$("${COMPOSE[@]}" ps -q api)
  web=$("${COMPOSE[@]}" ps -q web)
  worker=$("${COMPOSE[@]}" ps -q worker)
  if [[ -n "$api" && -n "$web" && -n "$worker" ]] && \
    [[ "$(docker inspect -f '{{.State.Status}}' "$api")" == running ]] && \
    [[ "$(docker inspect -f '{{.State.Status}}' "$web")" == running ]] && \
    [[ "$(docker inspect -f '{{.State.Status}}' "$worker")" == running ]] && \
    curl --fail --silent --max-time 10 http://127.0.0.1:4000/health >/dev/null && \
    curl --fail --silent --max-time 10 http://127.0.0.1:4560/ >/dev/null; then
    heartbeat_age=$("${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite', { readOnly: true }); const row = db.prepare('SELECT beat_at FROM automation_worker_heartbeat WHERE id = 1').get(); db.close(); process.stdout.write(String(row?.beat_at ? Date.now() - Number(row.beat_at) : 999999999));")
    if [[ "$heartbeat_age" =~ ^[0-9]+$ && "$heartbeat_age" -le 15000 ]]; then
      echo "Verified rollback to $IMAGE_PREFIX/$IMAGE_TAG"
      exit 0
    fi
  fi
  sleep 2
done
echo "Rollback health checks failed. An incompatible SQLite schema migration may prevent the old image from starting; restore database backup: $DATABASE_BACKUP" >&2
exit 1
