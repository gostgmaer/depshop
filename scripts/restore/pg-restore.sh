#!/usr/bin/env bash
# Restores a pg-backup.sh archive.
#
#   scripts/restore/pg-restore.sh <backup.dump|backup.dump.age> [--into DBNAME]
#       Restores into a NEW database (default dealmind_restore_<timestamp>) and
#       leaves the live database untouched. Use this to inspect or recover data.
#
#   scripts/restore/pg-restore.sh <backup> --replace-live
#       Disaster recovery: stops the applications, RENAMES the live database to
#       <db>_pre_restore_<timestamp> (kept, never dropped), restores the backup
#       as the live database, re-applies roles, starts the applications.
#       Asks you to type the database name to confirm (or CONFIRM=<dbname>).
#
# Encrypted backups need BACKUP_AGE_IDENTITY (path to the age secret key file).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/lib.sh
source "$here/../deploy/lib.sh"

file="${1:-}"; shift || true
[[ -f "$file" ]] || die "usage: pg-restore.sh <backup file> [--into DB | --replace-live]"
mode="new"; target="dealmind_restore_$(date -u +%Y%m%d%H%M%S)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --into) target="$2"; shift 2 ;;
    --replace-live) mode="live"; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "invalid database name"
live_db="$(env_get POSTGRES_DB)"; live_db="${live_db:-dealmind}"

# Checksum (when the .sha256 written by the backup is next to the file).
sumfile="$(dirname "$file")/$(basename "${file%.dump*}").sha256"
if [[ -f "$sumfile" ]]; then
  # Lines are "<hash>  <name>" (text mode) or "<hash> *<name>" (binary mode).
  expected="$(awk -v n="$(basename "$file")" '{ f = $2; sub(/^\*/, "", f); if (f == n) print $1 }' "$sumfile")"
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ -n "$expected" ]] || die "no checksum recorded for $(basename "$file") in $(basename "$sumfile")"
  [[ "$expected" == "$actual" ]] || die "checksum mismatch for $file"
  log "checksum OK"
fi

umask 077
plain="$file"
if [[ "$file" == *.age ]]; then
  identity="${BACKUP_AGE_IDENTITY:-}"
  [[ -f "$identity" ]] || die "encrypted backup: set BACKUP_AGE_IDENTITY to the age key file"
  plain="$(mktemp)"; trap 'rm -f "$plain"' EXIT
  age -d -i "$identity" -o "$plain" "$file"
fi

restore_into() { # restore_into DBNAME
  dc exec -T postgres sh -c "createdb -U \"\$POSTGRES_USER\" -T template0 '$1'"
  dc exec -T postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d '$1' --no-owner --no-privileges --exit-on-error" <"$plain"
}

if [[ "$mode" == "new" ]]; then
  [[ "$target" != "$live_db" ]] || die "refusing to restore into the live database name; use --replace-live"
  log "restoring into new database $target (live database untouched)"
  restore_into "$target"
  log "restored into $target. Inspect it, then drop it when done:  compose.sh exec postgres dropdb -U <owner> $target"
  exit 0
fi

# ── Disaster recovery: replace the live database ──
confirm="${CONFIRM:-}"
if [[ -z "$confirm" ]]; then
  read -r -p "Type the live database name ($live_db) to replace it with this backup: " confirm
fi
[[ "$confirm" == "$live_db" ]] || die "confirmation did not match; nothing changed"
kept="${live_db}_pre_restore_$(date -u +%Y%m%d%H%M%S)"
log "stopping applications"
dc stop web worker api agent
log "renaming $live_db → $kept (kept for comparison; never dropped by this script)"
dc exec -T postgres sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d postgres -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$live_db' AND pid <> pg_backend_pid();\" -c 'ALTER DATABASE \"$live_db\" RENAME TO \"$kept\"'"
log "restoring backup as $live_db"
restore_into "$live_db"
"$here/../deploy/apply-db-roles.sh"
IMAGE_TAG="$(current_release)"
export IMAGE_TAG
# The worker depends on a healthy agent: start and wait in dependency order.
dc up -d agent api
wait_healthy agent 240 || die "agent unhealthy after restore (check: compose.sh logs agent)"
wait_healthy api 240 || die "api unhealthy after restore (check: compose.sh logs api)"
dc up -d worker web
for s in worker web; do wait_healthy "$s" 240 || die "$s unhealthy after restore"; done
log "restore complete. Previous database kept as $kept"
