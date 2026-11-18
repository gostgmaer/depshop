#!/usr/bin/env bash
# Deploys one release (immutable image tag) to this host.
#
#   scripts/deploy/deploy.sh <image-tag>        e.g. sha-3f2c1ab or v1.4.0
#
# Steps: validate env → pull images → start data services → backup → migrate
# (controlled release job) → DB roles → roll out apps → wait for health →
# smoke tests → record the release. If the rollout or smoke tests fail, the
# previous release's APPLICATION images are restored automatically; the
# database is never rolled back automatically (migrations are additive by
# policy: docs/backup-and-recovery.md). Persistent volumes are never removed.
#
# Env: DEPLOY_DIR (default /opt/dealmind), ENV_FILE, SKIP_BACKUP=1 (first deploy
# only), RELEASE_SHA (git commit, recorded), SMOKE_INSECURE=1 (self-signed test only).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

TAG="${1:-}"
[[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "usage: deploy.sh <image-tag> (letters, digits, . _ -)"
take_lock

"$here/check-env.sh"
export IMAGE_TAG="$TAG"
PREV="$(current_release)"
APPS=(agent api worker web)
log "deploying $TAG (current: ${PREV:-none})"

if [[ "${SKIP_PULL:-0}" == "1" ]]; then
  log "SKIP_PULL=1: using images already present on this host"
else
  log "pulling images"
  dc --profile release pull --quiet migrate "${APPS[@]}"
fi

log "starting data services"
dc up -d postgres redis
wait_healthy postgres 180
wait_healthy redis 120

if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  log "pre-migration backup"
  "$here/../backup/pg-backup.sh" --label "pre-$TAG"
else
  log "WARNING: SKIP_BACKUP=1 (only acceptable for the very first deployment)"
fi

log "running migrations (prisma migrate deploy) and reference-data seed"
dc --profile release run --rm --no-deps migrate
"$here/apply-db-roles.sh"

rollback_apps() {
  if [[ -n "$PREV" && "$PREV" != "$TAG" ]]; then
    log "ROLLING BACK applications to $PREV (database left as migrated)"
    IMAGE_TAG="$PREV" dc up -d --no-deps "${APPS[@]}" || true
    for s in "${APPS[@]}"; do IMAGE_TAG="$PREV" wait_healthy "$s" 180 || true; done
  else
    log "no previous release to roll back to"
  fi
  printf '%s %s FAILED %s\n' "$(date -u +%FT%TZ)" "$TAG" "${RELEASE_SHA:-}" >>"$RELEASES_DIR/history.log"
}

log "rolling out applications"
dc up -d --remove-orphans socket-proxy traefik
if ! dc up -d "${APPS[@]}"; then rollback_apps; die "rollout failed"; fi
for s in agent api worker web traefik; do
  wait_healthy "$s" 240 || { dc logs --tail=80 "$s" >&2 || true; rollback_apps; die "$s did not become healthy"; }
done

log "smoke tests"
if ! "$here/../smoke-tests/smoke.sh"; then rollback_apps; die "smoke tests failed"; fi

[[ -n "$PREV" && "$PREV" != "$TAG" ]] && printf '%s\n' "$PREV" >"$RELEASES_DIR/previous"
printf '%s\n' "$TAG" >"$RELEASES_DIR/current"
printf '%s %s OK %s\n' "$(date -u +%FT%TZ)" "$TAG" "${RELEASE_SHA:-}" >>"$RELEASES_DIR/history.log"
log "release $TAG is live (previous: ${PREV:-none})"
