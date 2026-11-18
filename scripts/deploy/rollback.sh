#!/usr/bin/env bash
# Redeploys a previous known-good release's APPLICATION images.
#
#   scripts/deploy/rollback.sh [image-tag]     (default: the recorded previous release)
#
# The database is NOT rolled back. Before switching, this compares the
# migrations applied to the database with the migrations the target release
# knows. If the database has newer migrations, the old code must be compatible
# with them (expand/contract policy); the script stops unless
# ALLOW_NEWER_SCHEMA=1 confirms that. Volumes are never removed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

TARGET="${1:-$(previous_release)}"
[[ -n "$TARGET" ]] || die "no target: pass an image tag or deploy at least twice"
[[ "$TARGET" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "invalid tag"
take_lock
CURRENT="$(current_release)"
registry="$(env_get IMAGE_REGISTRY)"

log "checking schema compatibility for $TARGET"
known="$(docker run --rm --entrypoint sh "$registry/dealmind-migrate:$TARGET" -c 'ls prisma/migrations' | grep -E '^[0-9]{14}_' | sort || true)"
[[ -n "$known" ]] || die "could not read migrations from $registry/dealmind-migrate:$TARGET (pull it first)"
applied="$(dc exec -T postgres sh -c 'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1"' | sort)"
newer="$(comm -13 <(printf '%s\n' "$known") <(printf '%s\n' "$applied") || true)"
if [[ -n "$newer" ]]; then
  log "the database has migrations that $TARGET does not know:"
  printf '%s\n' "$newer" | sed 's/^/  /' >&2
  [[ "${ALLOW_NEWER_SCHEMA:-0}" == "1" ]] || die "set ALLOW_NEWER_SCHEMA=1 only after confirming these migrations are backward compatible (additive)"
  log "ALLOW_NEWER_SCHEMA=1: continuing"
fi

export IMAGE_TAG="$TARGET"
[[ "${SKIP_PULL:-0}" == "1" ]] || dc pull --quiet agent api worker web
dc up -d --no-deps agent api worker web
for s in agent api worker web; do wait_healthy "$s" 240 || die "$s not healthy after rollback (check logs: compose.sh logs $s)"; done
"$here/../smoke-tests/smoke.sh" || die "smoke tests failed after rollback"

[[ -n "$CURRENT" ]] && printf '%s\n' "$CURRENT" >"$RELEASES_DIR/previous"
printf '%s\n' "$TARGET" >"$RELEASES_DIR/current"
printf '%s %s ROLLBACK-OK from %s\n' "$(date -u +%FT%TZ)" "$TARGET" "${CURRENT:-?}" >>"$RELEASES_DIR/history.log"
log "rolled back to $TARGET"
