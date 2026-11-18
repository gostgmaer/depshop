#!/usr/bin/env bash
# Periodic restore test: restores the newest (or given) backup into a scratch
# database, compares row counts with those recorded at backup time, runs basic
# integrity queries, then drops the scratch database. The live database is
# never touched. Exit non-zero on any mismatch (wire to alerting).
#
#   scripts/restore/restore-test.sh [backup file]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/lib.sh
source "$here/../deploy/lib.sh"

dir="$(env_get BACKUP_DIR)"; dir="${dir:-/var/backups/dealmind}"
# Newest backup (our own fixed file names, so ls -t is safe here).
# shellcheck disable=SC2012
file="${1:-$(ls -1t "$dir"/dealmind-*.dump "$dir"/dealmind-*.dump.age 2>/dev/null | head -n 1 || true)}"
[[ -f "$file" ]] || die "no backup found in $dir"
counts="$(dirname "$file")/$(basename "${file%.dump*}").counts"
scratch="dealmind_restore_test_$(date -u +%Y%m%d%H%M%S)"

cleanup() { dc exec -T postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists '$scratch'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "restore test of ${file##*/} into $scratch"
started=$(date +%s)
"$here/pg-restore.sh" "$file" --into "$scratch"
elapsed=$(( $(date +%s) - started ))

actual="$(count_rows "$scratch")"

if [[ -f "$counts" ]]; then
  if ! diff <(sort "$counts") <(printf '%s\n' "$actual" | sort) >&2; then die "row counts differ from backup time"; fi
  log "row counts match the backup ($(wc -l <"$counts") tables)"
else
  log "WARNING: no .counts file next to the backup; showing restored counts only"
  printf '%s\n' "$actual" >&2
fi

# Referential integrity spot checks (should all be 0).
orphans="$(dc exec -T postgres sh -c "psql -At -U \"\$POSTGRES_USER\" -d '$scratch' -c \"
  SELECT (SELECT count(*) FROM \\\"ProductOffer\\\" o LEFT JOIN \\\"Product\\\" p ON p.id = o.\\\"productId\\\" WHERE p.id IS NULL)
       + (SELECT count(*) FROM \\\"Search\\\" s LEFT JOIN \\\"User\\\" u ON u.id = s.\\\"userId\\\" WHERE u.id IS NULL)\"")"
[[ "$orphans" == "0" ]] || die "integrity check failed ($orphans orphan rows)"

log "RESTORE TEST PASSED in ${elapsed}s: ${file##*/}"
write_metric dealmind_restore_test_last_success_timestamp_seconds "$(date +%s)" "Unix time of the last successful restore test."
write_metric dealmind_restore_test_duration_seconds "$elapsed" "Duration of the last successful restore test."
printf '%s restore-test OK %s %ss\n' "$(date -u +%FT%TZ)" "${file##*/}" "$elapsed" >>"$dir/restore-tests.log"
