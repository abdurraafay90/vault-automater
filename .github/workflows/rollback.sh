#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/root/saad/tokenXvaultautomator/vault-automater
PROJECT=vault-automater
COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml")
STATE_FILE=${STATE_FILE_OVERRIDE:-$ROOT/.deploy/verified-release.env}
VERIFY_ONLY=false
[[ "${1:-}" == --verify-only ]] && VERIFY_ONLY=true

declare -A state=()
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "Invalid release-state line" >&2; exit 2; }
  [[ -z "${state[$key]+x}" ]] || { echo "Duplicate release-state key: $key" >&2; exit 2; }
  state[$key]=$value
done < "$STATE_FILE"
for key in IMAGE_PREFIX IMAGE_TAG RELEASE_KIND API_IMAGE_ID WEB_IMAGE_ID WORKER_IMAGE_ID; do
  [[ -n "${state[$key]:-}" ]] || { echo "Missing release-state key: $key" >&2; exit 2; }
done
[[ "${state[IMAGE_PREFIX]}" =~ ^[a-z0-9./_-]+$ && "${state[IMAGE_TAG]}" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo "Invalid release image reference" >&2; exit 2; }
[[ "${state[RELEASE_KIND]}" == ghcr || "${state[RELEASE_KIND]}" == local ]] || { echo "Invalid release kind" >&2; exit 2; }
export IMAGE_PREFIX="${state[IMAGE_PREFIX]}" IMAGE_TAG="${state[IMAGE_TAG]}"

if [[ "${state[RELEASE_KIND]}" == ghcr ]]; then
  if [[ -z "${GHCR_TOKEN:-}" ]]; then IFS= read -r GHCR_TOKEN || true; fi
  [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]] || { echo "GHCR credentials are required for image rollback" >&2; exit 2; }
  echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
  "${COMPOSE[@]}" pull api web worker
fi

for service in api web worker; do
  ref="${state[IMAGE_PREFIX]}/$service:${state[IMAGE_TAG]}"
  docker image inspect "$ref" >/dev/null || { echo "Rollback image is missing locally: $ref" >&2; exit 1; }
  actual=$(docker image inspect -f '{{.Id}}' "$ref")
  [[ "$actual" == "${state[${service^^}_IMAGE_ID]}" ]] || { echo "Rollback image ID mismatch for $service" >&2; exit 1; }
done
"${COMPOSE[@]}" config --quiet
$VERIFY_ONLY && { echo "Rollback plan verified for ${state[IMAGE_PREFIX]}:${state[IMAGE_TAG]}"; exit 0; }

"${COMPOSE[@]}" stop -t 660 worker
previous_instance_id=${state[WORKER_INSTANCE_ID]:-}
minimum_started_at=$(date +%s%3N)
"${COMPOSE[@]}" up -d --no-build --force-recreate --scale worker=1 api web worker
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  api=$("${COMPOSE[@]}" ps -q api); web=$("${COMPOSE[@]}" ps -q web); worker=$("${COMPOSE[@]}" ps -q worker)
  if [[ -n "$api" && -n "$web" && -n "$worker" ]] && \
    [[ "$(docker inspect -f '{{.State.Status}}' "$api")" == running ]] && \
    [[ "$(docker inspect -f '{{.State.Status}}' "$web")" == running ]] && \
    [[ "$(docker inspect -f '{{.State.Status}}' "$worker")" == running ]] && \
    [[ "$(docker inspect -f '{{.RestartCount}}' "$worker")" == 0 ]] && \
    curl --fail --silent --max-time 10 http://127.0.0.1:4000/health >/dev/null && \
    curl --fail --silent --max-time 10 http://127.0.0.1:4560/ >/dev/null; then
    IFS='|' read -r instance_id started_at beat_at <<< "$("${COMPOSE[@]}" exec -T api node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/repo/.data/auth.sqlite', { readOnly: true }); const row = db.prepare('SELECT instance_id, started_at, beat_at FROM automation_worker_heartbeat WHERE id = 1').get(); db.close(); process.stdout.write(row ? [row.instance_id, row.started_at, row.beat_at].join('|') : '');")"
    heartbeat_age=$(( $(date +%s%3N) - beat_at ))
    if [[ -n "$instance_id" && "$instance_id" != "$previous_instance_id" && "$started_at" =~ ^[0-9]+$ && "$started_at" -ge "$minimum_started_at" && "$beat_at" =~ ^[0-9]+$ && "$heartbeat_age" -ge 0 && "$heartbeat_age" -le 15000 ]]; then
      echo "Verified rollback to ${state[IMAGE_PREFIX]}/${state[IMAGE_TAG]}; database was not overwritten"
      exit 0
    fi
  fi
  sleep 2
done
echo "ROLLBACK FAILED: image restore health checks failed; database was not overwritten. Manual recovery may need ${state[DATABASE_BACKUP]:-the recorded backup}." >&2
exit 1
