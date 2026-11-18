#!/usr/bin/env bash
# Shared helpers for the deploy / backup / restore scripts (sourced, not run).
# Never prints secret values.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/dealmind}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/infrastructure/docker/production/docker-compose.yml}"
RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_DIR/releases}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-dealmind}"
# Optional extra compose files, space-separated (monitoring overlay, local rehearsal).
COMPOSE_OVERRIDE="${COMPOSE_OVERRIDE:-}"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${0##*/}" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# docker compose for the production stack, always with the same project/env.
dc() {
  local files=(-f "$COMPOSE_FILE")
  local o
  for o in $COMPOSE_OVERRIDE; do files+=(-f "$o"); done   # space-separated list
  docker compose -p "$COMPOSE_PROJECT" "${files[@]}" --env-file "$ENV_FILE" --project-directory "$DEPLOY_DIR" "$@"
}

# One deployment at a time (flock where available; Linux hosts always have it).
take_lock() {
  mkdir -p "$RELEASES_DIR"
  if command -v flock >/dev/null; then
    exec 9>"$RELEASES_DIR/.lock"
    flock -n 9 || die "another deployment is running"
  else
    log "WARNING: flock not available; not locking (never run two deployments at once)"
  fi
}

# Reads one variable from the env file without sourcing it (no command execution,
# no export of every secret into this shell). Prints the value (callers must not log it).
env_get() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%%[[:space:]]#*}"            # strip trailing comments
  line="${line%"${line##*[![:space:]]}"}"   # trim trailing spaces
  line="${line%\"}"; line="${line#\"}"
  printf '%s' "$line"
}

# Waits until a compose service's container reports Docker health "healthy".
wait_healthy() {
  local service="$1" timeout="${2:-180}" waited=0 id status
  while (( waited < timeout )); do
    id="$(dc ps -q "$service" 2>/dev/null | head -n 1)"
    if [[ -n "$id" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)"
      [[ "$status" == "healthy" ]] && { log "$service is healthy"; return 0; }
      [[ "$status" == "unhealthy" || "$status" == "exited" ]] && { log "$service is $status"; return 1; }
    fi
    sleep 5; waited=$((waited + 5))
  done
  log "$service not healthy after ${timeout}s"
  return 1
}

# Exact row counts of key tables (tab-separated "table<TAB>count", sorted).
# Tables that don't exist yet (first deployment) are skipped. Used by the
# backup (recorded next to the dump) and by restore-test.sh (compared).
#   count_rows [database]   (default: the live database)
count_rows() {
  local db="${1:-}"
  printf '%s\n' "SELECT t, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I %s', t,
            CASE WHEN t = '_prisma_migrations' THEN 'WHERE finished_at IS NOT NULL' ELSE '' END),
          false, true, '')))[1]::text::bigint
     FROM unnest(ARRAY['_prisma_migrations','User','Product','ProductOffer','PriceSnapshot',
                       'Search','PriceAlert','Subscription']) AS t
    WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    ORDER BY 1;" |
    dc exec -T -e DB="$db" postgres sh -c \
      'psql -At -v ON_ERROR_STOP=1 -F "	" -U "$POSTGRES_USER" -d "${DB:-$POSTGRES_DB}"'
}

# Writes a Prometheus textfile metric for node-exporter (atomic rename), when
# BACKUP_METRICS_DIR is set in the env file. Used for backup/restore freshness alerts.
#   write_metric NAME VALUE HELP
write_metric() {
  local dir; dir="$(env_get BACKUP_METRICS_DIR)"
  [[ -n "$dir" ]] || return 0
  mkdir -p "$dir" && printf '# HELP %s %s\n# TYPE %s gauge\n%s %s\n' "$1" "$3" "$1" "$1" "$2" >"$dir/$1.prom.tmp" \
    && mv "$dir/$1.prom.tmp" "$dir/$1.prom"
}

current_release() { if [[ -f "$RELEASES_DIR/current" ]]; then cat "$RELEASES_DIR/current"; fi; }
previous_release() { if [[ -f "$RELEASES_DIR/previous" ]]; then cat "$RELEASES_DIR/previous"; fi; }
