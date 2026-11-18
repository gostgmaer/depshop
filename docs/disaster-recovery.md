# Disaster recovery

The plan for losing data or the whole host. The mechanics (backup format, scripts, timers) are in [backup-and-recovery.md](backup-and-recovery.md); this page is the decision procedure and its targets.

**Any restore that replaces live data needs explicit authorization from the application owner.** It discards every write made after the backup. For anything smaller, use [rollback-runbook.md](rollback-runbook.md).

## Targets

|                      | Target                                                         | Basis                                                                                                                                    |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery point (RPO) | 24 h with nightly logical dumps; also every pre-release backup | `pg-backup.sh` timer + `deploy.sh` pre-migration backup                                                                                  |
| Recovery time (RTO)  | 4 h for a full host loss                                       | **Not measured on a server.** The local drill restored a small database in 3 s; real time depends on database size and host provisioning |

Measure both in the first monthly drill on the real host and update this table.

## What is lost in each scenario

| Asset                                                                                                               | Where it lives                                                 | If lost                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL: users' searches, watchlists, alerts, notifications, subscriptions; the shared catalog and price history | `postgres-data` volume, nightly dumps                          | Restore from the latest dump. Writes after it are lost.                                                                                               |
| Redis: queues, rate-limit counters, caches                                                                          | `redis-data` volume (AOF)                                      | **Rebuildable.** Queued jobs are lost. The tracking scheduler re-enqueues due checks from the database; searches in progress fail and users resubmit. |
| Configuration and secrets                                                                                           | `.env.production` on the host, plus the owner's password vault | Restore from the vault. Without it, rotate everything (see [incident-response.md](incident-response.md) §Secret rotation).                            |
| Images                                                                                                              | GHCR (immutable `sha-…` tags)                                  | Pull again.                                                                                                                                           |
| TLS certificates                                                                                                    | `traefik-acme` volume                                          | Re-issued automatically by Let's Encrypt (watch the rate limits).                                                                                     |
| Payments state                                                                                                      | Payment service (source of truth)                              | Billing reconciliation re-syncs DealMind's subscription state from the payment service.                                                               |
| User accounts                                                                                                       | Shared EasyDev IAM (its own backups)                           | Outside DealMind; DealMind keeps only its own user rows.                                                                                              |

## Scenarios

### 1. Bad data written by a release or a bug (database is up)

1. Stop the source of damage: [rollback-runbook.md](rollback-runbook.md) A or C.
2. Restore the most recent good backup **beside** the live database. This doesn't touch production:
   ```sh
   scripts/restore/pg-restore.sh /var/backups/dealmind/<file>.dump[.age] --into dealmind_inspect
   ```
3. Repair the affected rows from `dealmind_inspect` with reviewed SQL, run inside a transaction. **Prefer this to a full restore:** nothing else is lost.
4. Only if repair is impossible: scenario 2.

### 2. Database corrupted or destroyed (host is fine)

With the owner's authorization:

```sh
BACKUP_AGE_IDENTITY=/secure/age.key scripts/restore/pg-restore.sh <file>.dump.age --replace-live
scripts/smoke-tests/smoke.sh
```

The script:

1. stops the applications;
2. renames the current database to `<db>_pre_restore_<time>` (never dropped automatically);
3. restores, then re-applies the roles;
4. starts everything in dependency order.

Tell users that changes after `<backup time>` are lost.

### 3. Host lost

1. Provision a new host ([production-deployment.md](production-deployment.md) §2) and restore `.env.production` from the vault.
2. `SKIP_BACKUP=1 scripts/deploy/deploy.sh <last release tag>`. This gives an empty, migrated database.
3. Fetch the latest **off-host** backup, then run scenario 2's `--replace-live`.
4. Point DNS at the new IP (keep the TTL low, ≤ 300 s, so this is fast).
5. Re-enable the backup and restore-test timers.

### 4. Redis lost

```sh
scripts/deploy/compose.sh up -d redis && scripts/deploy/compose.sh restart api worker
```

The tracking scheduler re-enqueues due checks from the database on its next tick. **Never** `FLUSHALL`/`FLUSHDB` as a "fix": the ACL denies both.

### 5. A shared service is lost (IAM, payments, notifications)

DealMind degrades rather than fails:

- **IAM down:** sign-in fails, and `/ready` reports it.
- **Payments down:** checkout fails; existing plans are kept.
- **Notifications down:** e-mail deliveries are retried, then marked failed; in-app notifications still work.

Recovery is the owning service's DR plan. See [incident-response.md](incident-response.md) §Dependency down.

## Drills

| When               | Drill                                                                    | Pass criteria                                   |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Weekly (automatic) | `restore-test.sh` timer restores the latest dump into a scratch database | Row counts match; `RestoreTestStale` silent     |
| Monthly            | Scenario 2 on **staging**, timed                                         | Smoke tests pass; RTO recorded                  |
| Quarterly          | Scenario 3 on a throwaway host                                           | Full service from vault + off-host backup alone |

## Status (2026-11-18)

| Item                                                           | Status                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Backup, restore test, tamper detection, `--replace-live` drill | **Verified locally only** (2026-11-17 rehearsal; Prompt 22 restore test) |
| `age` encryption, off-host copy, systemd timers                | **Not verified:** no host                                                |
| Measured RTO on real hardware                                  | **Not measured**                                                         |
