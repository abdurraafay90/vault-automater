#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/vault-automater
PROJECT=vault-automater
BACKUP_DIR=${BACKUP_DIR:-/var/backups/vault-automater}
BASE_COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml")
COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml")
STATE_DIR="$ROOT/.deploy"
STATE_FILE="$STATE_DIR/verified-release.env"
ROLLBACK_STATE="$STATE_DIR/rollback-release.env"
RELEASE_BACKUP="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sqlite"

if [[ -z "${GHCR_TOKEN:-}" ]]; then IFS= read -r GHCR_TOKEN || true; fi
required=(IMAGE_PREFIX IMAGE_TAG GHCR_USERNAME GHCR_TOKEN)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "Missing $name" >&2; exit 2; }
done
[[ -f "$ROOT/.env" && -f "$ROOT/docker-compose.yml" && -f "$ROOT/docker-compose.prod.yml" ]] || { echo "Production .env or Compose files are missing" >&2; exit 2; }
mkdir -p "$STATE_DIR" "$BACKUP_DIR"
chmod 700 "$STATE_DIR" "$BACKUP_DIR"

healthcheck() {
  local api_id web_id worker_id heartbeat_age
  api_id=$("${COMPOSE[@]}" ps -q api)
  web_id=$("${COMPOSE[@]}" ps -q web)
  worker_id=$("${COMPOSE[@]}" ps -q worker)
  [[ -n "$api_id" && -n "$web_id" && -n "$worker_id" ]] || return 1
  [[ "$(docker inspect -f '{{.State.Status}}' "$api_id")" == running ]] || return 1
  [[ "$(docker inspect -f '{{.State.Status}}' "$web_id")" == running ]] || return 1
  [[ "$(docker inspect -f '{{.State.Status}}' "$worker_id")" == running ]] || return 1
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:4000/health >/dev/null
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:4560/ >/dev/null
  heartbeat_age=$("${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite', { readOnly: true }); const row = db.prepare('SELECT beat_at FROM automation_worker_heartbeat WHERE id = 1').get(); db.close(); process.stdout.write(String(row?.beat_at ? Date.now() - Number(row.beat_at) : 999999999));")
  [[ "$heartbeat_age" =~ ^[0-9]+$ && "$heartbeat_age" -le 15000 ]]
}

wait_for_health() {
  local deadline=$((SECONDS + 180))
  until healthcheck; do
    (( SECONDS >= deadline )) && return 1
    sleep 2
  done
}

establish_manual_baseline() {
  [[ -s "$STATE_FILE" ]] && return 0
  COMPOSE=("${BASE_COMPOSE[@]}")
  wait_for_health || { echo "Current manual deployment is not healthy; refusing initial replacement without a rollback baseline" >&2; exit 1; }
  local baseline_tag="manual-$(date -u +%Y%m%dT%H%M%SZ)"
  local service container image_id
  for service in api web worker; do
    container=$("${BASE_COMPOSE[@]}" ps -q "$service")
    image_id=$(docker inspect -f '{{.Image}}' "$container")
    docker tag "$image_id" "vault-automater-baseline/$service:$baseline_tag"
  done
  cat > "$STATE_FILE" <<EOF
IMAGE_PREFIX=vault-automater-baseline
IMAGE_TAG=$baseline_tag
RELEASE_KIND=local
VERIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_BACKUP=manual-deployment
EOF
  COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml")
}

backup_database() {
  local container backup_name
  backup_name=$(basename "$RELEASE_BACKUP")
  container=$("${COMPOSE[@]}" ps -q api)
  [[ -n "$container" ]] || { echo "API is not running; cannot make a consistent SQLite backup" >&2; return 1; }
  "${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite'); db.exec(\"VACUUM INTO '/repo/.data/$backup_name'\"); db.close();"
  docker cp "$container:/repo/.data/$backup_name" "$RELEASE_BACKUP"
  "${COMPOSE[@]}" exec -T api rm -f "/repo/.data/$backup_name"
}

establish_manual_baseline
cp "$STATE_FILE" "$ROLLBACK_STATE"
export IMAGE_PREFIX IMAGE_TAG
echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
"${COMPOSE[@]}" config --quiet

trap 'status=$?; echo "Deployment failed (exit $status)." >&2; STATE_FILE_OVERRIDE="$ROLLBACK_STATE" IMAGE_PREFIX="$IMAGE_PREFIX" GHCR_USERNAME="$GHCR_USERNAME" GHCR_TOKEN="$GHCR_TOKEN" "$ROOT/rollback.sh" || echo "Automatic rollback could not be verified. Review SQLite migration compatibility." >&2; exit "$status"' ERR

backup_database
"${COMPOSE[@]}" stop -t 660 worker
"${COMPOSE[@]}" pull api web worker
"${COMPOSE[@]}" up -d --no-build --force-recreate --scale worker=1 api web worker
wait_for_health

umask 077
cat > "$STATE_FILE" <<EOF
IMAGE_PREFIX=$IMAGE_PREFIX
IMAGE_TAG=$IMAGE_TAG
RELEASE_KIND=ghcr
VERIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_BACKUP=$RELEASE_BACKUP
EOF
trap - ERR
echo "Verified release $IMAGE_TAG; SQLite backup: $RELEASE_BACKUP"
