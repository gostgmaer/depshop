# Backup and recovery

## What needs backing up

| Data                                                                                                      | Where                                                | Criticality                                 | Backup                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| PostgreSQL (users, catalog, offers, price history, alerts, notifications, subscription mirror, audit log) | volume `postgres-data`                               | **Critical**                                | `scripts/backup/pg-backup.sh` (logical, custom format), scheduled, plus before every migration |
| Redis                                                                                                     | volume `redis-data` (AOF `everysec` + RDB snapshots) | Medium: queues, rate-limit counters, caches | Persistence on the volume; optional snapshot with `--with-redis`                               |
| TLS certificates                                                                                          | volume `letsencrypt`                                 | Low (re-issued automatically)               | None needed                                                                                    |
| Environment file                                                                                          | `/opt/dealmind/.env.production`                      | **Critical** (secrets)                      | In your secret manager or password vault, **never** next to the database backups               |

### Redis role and recovery

Redis is not the system of record. After a Redis loss:

- **Price tracking:** the hourly scheduler re-enqueues due offers (`nextCheckAt` is in PostgreSQL).
- **Notifications:** the outbox cleanup re-enqueues pending deliveries (delivery rows are in PostgreSQL).
- **Searches:** a search whose job was lost stays `PENDING`/`RUNNING` until its user retries, or until the stale-search handling marks it.
- **Caches** refill on demand.
- **Rate-limit windows** reset.

**Interrupted jobs:**

- BullMQ marks a job whose worker died as _stalled_ and re-queues it. This was verified by a worker test in Phase 5.1.
- Processing is idempotent: job ids are deterministic, and state changes are conditional updates.
- Jobs that exhaust their retries go to the dead-letter queue, visible under Admin → Jobs.

## Backups

`scripts/backup/pg-backup.sh [--label NAME] [--with-redis]` does the following:

1. `pg_dump -Fc --no-owner --no-privileges`, streamed out of the database container.
2. **Integrity check:** `pg_restore --list` must read the whole archive.
3. Records exact row counts of key tables next to the dump (`.counts`).
4. Writes a SHA-256 checksum. If `BACKUP_AGE_RECIPIENT` is set, encrypts the dump with `age`; strongly recommended, and the private key must be kept off the server.
5. Optional off-host copy via `BACKUP_UPLOAD_CMD` (e.g. `rclone copy {file} remote:dealmind-backups`).
6. Retention: deletes local backups older than `BACKUP_RETENTION_DAYS` (default 14). Off-host retention is configured at the storage provider; 30 to 90 days is suggested.
7. Writes `dealmind_backup_last_success_timestamp_seconds` for monitoring (when `BACKUP_METRICS_DIR` is set). An alert fires if no backup succeeds for 26 hours.

`deploy.sh` always takes a `pre-<tag>` backup before running migrations.

### Schedule (systemd timer on the host)

```ini
# /etc/systemd/system/dealmind-backup.service
[Service]
Type=oneshot
User=deploy
WorkingDirectory=/opt/dealmind
ExecStart=/opt/dealmind/scripts/backup/pg-backup.sh --with-redis

# /etc/systemd/system/dealmind-backup.timer
[Timer]
OnCalendar=*-*-* 02:30:00 Asia/Kolkata
Persistent=true
[Install]
WantedBy=timers.target
```

Add a second pair for the restore test (below), weekly, e.g. `OnCalendar=Sun 04:00 Asia/Kolkata`. Then run:

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now dealmind-backup.timer dealmind-restore-test.timer
```

### Point-in-time recovery

Logical dumps give a recovery point of up to 24 hours plus the pre-deploy dumps. For a smaller recovery point:

- **Managed PostgreSQL:** enable the provider's PITR (WAL archiving, typically 7 to 35 days). Point `DATABASE_URL` at it and drop the `postgres` service. The backup scripts still work for logical exports if run against it.
- **Self-hosted:** add WAL archiving with pgBackRest or WAL-G to object storage. This is not configured in this repository.

## Restore test (prove backups work)

`scripts/restore/restore-test.sh [file]` does the following:

- restores the newest (or given) backup into a **scratch** database;
- verifies the checksum;
- compares row counts with the values recorded at backup time;
- runs referential-integrity checks;
- drops the scratch database.

The live database is never touched. On success it writes `dealmind_restore_test_last_success_timestamp_seconds`; an alert fires after 8 days without one.

## Restore procedures

- **Inspect or recover specific data** (the live database is untouched):
  ```sh
  scripts/restore/pg-restore.sh /var/backups/dealmind/<file>.dump[.age] --into dealmind_inspect
  ```
- **Disaster recovery:** replace the live database.

  ```sh
  BACKUP_AGE_IDENTITY=/secure/age.key scripts/restore/pg-restore.sh <file> --replace-live
  ```

  The script then:
  1. asks you to type the database name;
  2. stops the applications;
  3. **renames** the live database to `<db>_pre_restore_<time>` (it is kept and never dropped);
  4. restores;
  5. re-applies the roles, including the agent schema ownership;
  6. starts the applications in dependency order and waits for them to be healthy.

  Afterwards, run the smoke tests (`scripts/smoke-tests/smoke.sh`). Once you have confirmed you don't need the old database, drop it by hand.

- **Full host loss:**
  1. Prepare a new host ([production-deployment.md](production-deployment.md) §2).
  2. Restore the env file from the vault.
  3. Deploy the last release with `SKIP_BACKUP=1 scripts/deploy/deploy.sh <tag>`. This creates an empty, migrated database.
  4. Fetch the latest off-host backup and run `--replace-live`.
  5. Point DNS at the new host if its IP changed.

**Suggested targets:** recovery point 24 hours with logical dumps (≤ 5 minutes with PITR); recovery time 4 hours. Measure your own recovery time in a drill.

## Verified (local rehearsal, 2026-11-17)

These were run against the production images and compose file on a workstation (rehearsal project), using synthetic data (a fictional user and 25 searches). They have **not** been run on a real server yet.

| Check                                                                           | Result                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-migration backup during `deploy.sh` (empty database and populated database) | Passed. The archive is readable (335 entries); row counts recorded.                                                                                                       |
| `restore-test.sh`                                                               | Passed. Restored in 2–3 s; counts matched (1 user, 25 searches, 17 migrations); integrity checks OK; scratch database dropped.                                            |
| Tamper detection                                                                | A one-byte change was rejected by the checksum before restoring.                                                                                                          |
| Disaster-recovery drill                                                         | Deleted all searches (25 → 0), ran `--replace-live`, and searches were back to 25. All services healthy; smoke tests 11/11; the previous database kept.                   |
| Bug found and fixed by the drill                                                | After a `--no-owner` restore, the agent's checkpoint schema was owned by the owner role, so the agent could not start. `roles.sql` now re-asserts ownership on every run. |

Not verified here: `age` encryption (no `age` on the rehearsal machine), off-host upload, and the systemd timers. Verify these on the real host before launch.
