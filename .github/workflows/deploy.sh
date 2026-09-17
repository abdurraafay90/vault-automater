#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/root/saad/tokenXvaultautomator/vault-automater
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

atomic_state_write() {
  local destination=$1
  local temporary
  temporary=$(mktemp "$STATE_DIR/.state.XXXXXX")
  chmod 600 "$temporary"
  cat > "$temporary"
  mv -f "$temporary" "$destination"
  chmod 600 "$destination"
}

container_id() {
  local compose_file=$1 service=$2
  docker compose -p "$PROJECT" -f "$compose_file" ps -q "$service"
}

image_id_for() {
  docker inspect -f '{{.Image}}' "$1"
}

heartbeat_row() {
  "${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite', { readOnly: true }); const row = db.prepare('SELECT instance_id, started_at, beat_at FROM automation_worker_heartbeat WHERE id = 1').get(); db.close(); process.stdout.write(row ? [row.instance_id, row.started_at, row.beat_at].join('|') : '');"
}

healthcheck() {
  local api_id web_id worker_id heartbeat instance_id started_at beat_at heartbeat_age restart_count
  api_id=$(container_id "$ROOT/docker-compose.yml" api)
  web_id=$(container_id "$ROOT/docker-compose.yml" web)
  worker_id=$(container_id "$ROOT/docker-compose.yml" worker)
  [[ -n "$api_id" && -n "$web_id" && -n "$worker_id" ]] || return 1
  [[ "$(docker inspect -f '{{.State.Status}}' "$api_id")" == running ]] || return 1
  [[ "$(docker inspect -f '{{.State.Status}}' "$web_id")" == running ]] || return 1
  [[ "$(docker inspect -f '{{.State.Status}}' "$worker_id")" == running ]] || return 1
  restart_count=$(docker inspect -f '{{.RestartCount}}' "$worker_id")
  [[ "$restart_count" == 0 ]] || return 1
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:4000/health >/dev/null
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:4560/ >/dev/null
  IFS='|' read -r instance_id started_at beat_at <<< "$(heartbeat_row)"
  [[ -n "$instance_id" && "$instance_id" != "${PREVIOUS_WORKER_INSTANCE_ID:-}" ]] || return 1
  [[ "$started_at" =~ ^[0-9]+$ && "$started_at" -ge "${MIN_WORKER_STARTED_AT:-0}" ]] || return 1
  [[ "$beat_at" =~ ^[0-9]+$ ]] || return 1
  heartbeat_age=$(( $(date +%s%3N) - beat_at ))
  [[ "$heartbeat_age" -ge 0 && "$heartbeat_age" -le 15000 ]]
}

wait_for_health() {
  local deadline=$((SECONDS + 180))
  until healthcheck; do
    (( SECONDS >= deadline )) && return 1
    sleep 2
  done
}

capture_manual_baseline() {
  local heartbeat instance_id started_at beat_at service container image_id baseline_tag
  COMPOSE=("${BASE_COMPOSE[@]}")
  wait_for_health || { echo "Current manual deployment is not healthy; refusing replacement" >&2; exit 1; }
  baseline_tag="manual-$(date -u +%Y%m%dT%H%M%SZ)"
  declare -A image_ids
  for service in api web worker; do
    container=$(container_id "$ROOT/docker-compose.yml" "$service")
    [[ -n "$container" ]] || { echo "Manual $service container is missing" >&2; exit 1; }
    image_id=$(image_id_for "$container")
    docker image inspect "$image_id" >/dev/null
    docker tag "$image_id" "vault-automater-baseline/$service:$baseline_tag"
    image_ids[$service]=$image_id
  done
  IFS='|' read -r instance_id started_at beat_at <<< "$(heartbeat_row)"
  atomic_state_write "$STATE_FILE" <<EOF
IMAGE_PREFIX=vault-automater-baseline
IMAGE_TAG=$baseline_tag
RELEASE_KIND=local
VERIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_BACKUP=manual-deployment
API_IMAGE_ID=${image_ids[api]}
WEB_IMAGE_ID=${image_ids[web]}
WORKER_IMAGE_ID=${image_ids[worker]}
WORKER_INSTANCE_ID=$instance_id
WORKER_STARTED_AT=$started_at
EOF
  cp -f "$STATE_FILE" "$ROLLBACK_STATE"
  chmod 600 "$ROLLBACK_STATE"
  STATE_FILE_OVERRIDE="$ROLLBACK_STATE" "$ROOT/rollback.sh" --verify-only
  COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml")
}

schema_fingerprint() {
  "${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite', { readOnly: true }); const rows = db.prepare(\"SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name\").all(); db.close(); process.stdout.write(JSON.stringify(rows));" | sha256sum | awk '{print $1}'
}

candidate_schema_fingerprint() {
  docker run --rm --network none --entrypoint node "$IMAGE_PREFIX/api:$IMAGE_TAG" --import tsx --input-type=module -e "await import('./apps/api/src/auth-store.ts'); const { DatabaseSync } = await import('node:sqlite'); const { AutomationStore } = await import('./packages/automation/src/store.ts'); const store = AutomationStore.open('/repo/.data'); store.close(); const db = new DatabaseSync('/repo/.data/auth.sqlite', { readOnly: true }); const rows = db.prepare(\"SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name\").all(); db.close(); process.stdout.write(JSON.stringify(rows));" | sha256sum | awk '{print $1}'
}

check_schema_compatibility() {
  local current candidate
  current=$(schema_fingerprint)
  candidate=$(candidate_schema_fingerprint)
  [[ "$current" == "$candidate" ]] && return 0
  if [[ "${SQLITE_MIGRATION_APPROVAL:-}" != "$IMAGE_TAG" || -z "${SQLITE_RECOVERY_PLAN:-}" ]]; then
    echo "SQLite schema changed ($current -> $candidate); reviewed SQLITE_MIGRATION_APPROVAL and SQLITE_RECOVERY_PLAN are required" >&2
    return 1
  fi
  echo "SQLite migration approval and recovery plan provided; details withheld"
}

backup_database() {
  local container backup_name
  container=$(container_id "$ROOT/docker-compose.yml" api)
  [[ -n "$container" ]] || { echo "API is not running; cannot make a consistent SQLite backup" >&2; return 1; }
  backup_name=$(basename "$RELEASE_BACKUP")
  "${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite'); db.exec(\"VACUUM INTO '/repo/.data/$backup_name'\"); db.close();"
  docker cp "$container:/repo/.data/$backup_name" "$RELEASE_BACKUP"
  "${COMPOSE[@]}" exec -T api rm -f "/repo/.data/$backup_name"
  chmod 600 "$RELEASE_BACKUP"
  [[ "$(docker run --rm --network none -v "$RELEASE_BACKUP:/backup.sqlite:ro" --entrypoint node "$IMAGE_PREFIX/api:$IMAGE_TAG" --input-type=module -e "const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('/backup.sqlite', { readOnly: true }); process.stdout.write(String(db.prepare('PRAGMA integrity_check').get().integrity_check)); db.close();")" == ok ]] || { echo "SQLite backup integrity check failed" >&2; return 1; }
}

if [[ ! -s "$STATE_FILE" ]]; then capture_manual_baseline; fi
cp -f "$STATE_FILE" "$ROLLBACK_STATE"
chmod 600 "$ROLLBACK_STATE"
export IMAGE_PREFIX IMAGE_TAG
echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" pull api web worker
for service in api web worker; do docker image inspect "$IMAGE_PREFIX/$service:$IMAGE_TAG" >/dev/null || { echo "Pulled image missing: $service" >&2; exit 1; }; done
check_schema_compatibility

PREVIOUS_WORKER_INSTANCE_ID=$(IFS='='; awk '$1 == "WORKER_INSTANCE_ID" { print $2 }' "$ROLLBACK_STATE")
MIN_WORKER_STARTED_AT=$(date +%s%3N)
export PREVIOUS_WORKER_INSTANCE_ID MIN_WORKER_STARTED_AT
trap 'status=$?; if (( status != 0 )); then echo "Deployment failed (exit $status); attempting image-only rollback." >&2; if ! STATE_FILE_OVERRIDE="$ROLLBACK_STATE" IMAGE_PREFIX="$IMAGE_PREFIX" GHCR_USERNAME="$GHCR_USERNAME" GHCR_TOKEN="$GHCR_TOKEN" "$ROOT/rollback.sh"; then echo "ROLLBACK FAILED: previous verified images were not restored and health was not verified; database was not overwritten." >&2; fi; fi; exit "$status"' EXIT

# Stop the Worker before the final snapshot so in-flight jobs finish before the
# backup. API writes remain SQLite-consistent through VACUUM INTO.
"${COMPOSE[@]}" stop -t 660 worker
deadline=$((SECONDS + 30))
until [[ -z "$(heartbeat_row)" ]]; do
  if (( SECONDS >= deadline )); then
    echo "Worker heartbeat did not clear; aborting deployment" >&2
    exit 1
  fi
  sleep 1
done
backup_database

"${COMPOSE[@]}" up -d --no-build --force-recreate --scale worker=1 api web worker
wait_for_health

api_id=$(container_id "$ROOT/docker-compose.yml" api)
web_id=$(container_id "$ROOT/docker-compose.yml" web)
worker_id=$(container_id "$ROOT/docker-compose.yml" worker)
atomic_state_write "$STATE_FILE" <<EOF
IMAGE_PREFIX=$IMAGE_PREFIX
IMAGE_TAG=$IMAGE_TAG
RELEASE_KIND=ghcr
VERIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_BACKUP=$RELEASE_BACKUP
API_IMAGE_ID=$(image_id_for "$api_id")
WEB_IMAGE_ID=$(image_id_for "$web_id")
WORKER_IMAGE_ID=$(image_id_for "$worker_id")
WORKER_INSTANCE_ID=$(IFS='|' read -r instance_id started_at beat_at <<< "$(heartbeat_row)"; printf '%s' "$instance_id")
WORKER_STARTED_AT=$(IFS='|' read -r instance_id started_at beat_at <<< "$(heartbeat_row)"; printf '%s' "$started_at")
EOF
trap - EXIT
echo "Verified release $IMAGE_TAG; SQLite backup: $RELEASE_BACKUP"
