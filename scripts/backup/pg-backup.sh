#!/usr/bin/env bash
# PostgreSQL backup for the production/staging stack (run by cron/systemd and
# before every migration by deploy.sh).
#
#   scripts/backup/pg-backup.sh [--label NAME] [--with-redis]
#
# 1. pg_dump (custom format, compressed) streamed out of the postgres container.
# 2. Integrity check: `pg_restore --list` must read the whole archive.
# 3. Row counts of key tables recorded next to the dump (restore-test.sh compares them).
# 4. sha256 checksum; optional encryption at rest with age (BACKUP_AGE_RECIPIENT).
# 5. Optional off-host copy (BACKUP_UPLOAD_CMD); retention (BACKUP_RETENTION_DAYS).
# Exit non-zero on any failure (wire this to alerting: docs/monitoring-and-alerting.md).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/lib.sh
source "$here/../deploy/lib.sh"

label="scheduled"; with_redis=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="$2"; shift 2 ;;
    --with-redis) with_redis=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$label" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "invalid label"

dir="$(env_get BACKUP_DIR)"; dir="${dir:-/var/backups/dealmind}"
keep="$(env_get BACKUP_RETENTION_DAYS)"; keep="${keep:-14}"
recipient="$(env_get BACKUP_AGE_RECIPIENT)"
upload="$(env_get BACKUP_UPLOAD_CMD)"
deploy_env="$(env_get DEPLOY_ENV)"
umask 077
mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$dir/dealmind-${deploy_env:-env}-${stamp}-${label}"
dump="$base.dump"

log "dumping database to $dump"
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges' >"$dump"
[[ -s "$dump" ]] || die "empty dump"

log "verifying archive"
toc_entries="$(dc exec -T postgres pg_restore --list <"$dump" | grep -cv '^;' || true)"
(( toc_entries > 0 )) || die "pg_restore could not read the archive"

log "recording row counts"
count_rows "" >"$base.counts"   # "" = the live database

if (( with_redis )); then
  log "redis snapshot"
  dc exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE >/dev/null && cat /data/dump.rdb' >"$base.redis.rdb" \
    || log "WARNING: redis snapshot failed (queues are rebuilt by the scheduler; see docs)"
fi

files=("$dump" "$base.counts")
[[ -f "$base.redis.rdb" ]] && files+=("$base.redis.rdb")
if [[ -n "$recipient" ]]; then
  command -v age >/dev/null || die "BACKUP_AGE_RECIPIENT is set but 'age' is not installed"
  for f in "${files[@]}"; do
    [[ "$f" == *.counts ]] && continue
    age -r "$recipient" -o "$f.age" "$f" && rm -f "$f"
  done
  files=("$dump.age" "$base.counts"); [[ -f "$base.redis.rdb.age" ]] && files+=("$base.redis.rdb.age")
else
  log "WARNING: backup is NOT encrypted (set BACKUP_AGE_RECIPIENT)"
fi
(cd "$dir" && sha256sum "${files[@]##*/}" >"${base##*/}.sha256")

if [[ -n "$upload" ]]; then
  for f in "${files[@]}" "$base.sha256"; do
    cmd="${upload//\{file\}/$f}"
    bash -c "$cmd" || die "upload failed for ${f##*/}"
  done
  log "uploaded off-host"
fi

log "retention: deleting local backups older than $keep days"
find "$dir" -maxdepth 1 -type f -name 'dealmind-*' -mtime +"$keep" -print -delete | sed 's/^/  removed /' >&2 || true

size="$(du -h "${files[0]}" | cut -f1)"
write_metric dealmind_backup_last_success_timestamp_seconds "$(date +%s)" "Unix time of the last successful database backup."
write_metric dealmind_backup_last_size_bytes "$(stat -c %s "${files[0]}")" "Size of the last database backup file."
log "backup OK: ${files[0]##*/} ($size, $toc_entries archive entries)"
printf '%s\n' "${files[0]}"
