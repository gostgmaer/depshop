# Rollback runbook

Run every command on the host from the deploy directory (`/opt/dealmind`). **Choose the smallest action that stops the harm.**

**Rollback never:**

- deletes volumes (`down -v` is never part of a rollback);
- reverses a migration;
- restores a backup without the owner's explicit authorization.

Background: [production-deployment.md](production-deployment.md) §6 and [backup-and-recovery.md](backup-and-recovery.md).

## Choosing an action

| Symptom                                                                | Action                                              | Section |
| ---------------------------------------------------------------------- | --------------------------------------------------- | ------- |
| A release just went out and errors or latency rose                     | Redeploy the previous application images            | A       |
| One marketplace returns bad data or errors                             | Disable that source                                 | B       |
| Background jobs are doing damage (wrong notifications, runaway checks) | Pause job processing                                | C       |
| Price tracking for one source misbehaves                               | Turn tracking off for that source                   | B       |
| A configuration change broke start-up                                  | Revert the variable, recreate the affected service  | D       |
| Data is corrupted or lost                                              | Disaster recovery, **owner authorization required** | E       |

There are no global runtime feature flags. The runtime switches are the per-source controls in Admin → Sources (status, tracking, rate limit, timeout), which are recorded in the audit log, plus stopping or starting services.

## A. Redeploy the previous release (application rollback)

```sh
cat releases/current releases/previous            # what is live, what we return to
scripts/deploy/rollback.sh                        # previous release
scripts/deploy/rollback.sh sha-0123456789ab       # or a specific known-good tag
```

**Expected effect:**

1. It compares the database's applied migrations with the target release. It reads the target's migration list from that release's `dealmind-migrate` image, so that image must be on the host or pullable. If it isn't, the script stops with "pull it first": `scripts/deploy/compose.sh pull` with `IMAGE_TAG=<target>`.
2. If they're compatible, it pulls the target images (the host still has them, and the registry keeps every `sha-…` tag).
3. It recreates agent, api, worker and web on those images, then waits for each health check.
4. It runs the smoke tests and records the result in `releases/history.log`. `releases/current` now names the target.

The database and Redis are untouched. Downtime is a few seconds per service while each container is recreated. Traefik routes only to healthy containers.

**If it stops with "database has newer migrations":** the release added migrations that the old code doesn't know.

- Read those migrations. If they only **add** tables, nullable or defaulted columns, or indexes (the expand/contract policy), the old code is compatible: `ALLOW_NEWER_SCHEMA=1 scripts/deploy/rollback.sh`.
- If any migration drops, renames or rewrites data, **don't force it.** Fix forward with a new release, or go to E.

**If the target release's smoke tests also fail:** the problem isn't the release (it's a dependency or data). Go to [incident-response.md](incident-response.md) §Dependency down.

**First release:** there is no previous release. "Rollback" means taking the site offline: `scripts/deploy/compose.sh stop web` shows Traefik's error page while the API stays up for investigation. `compose.sh start web` brings it back.

## B. Disable a problematic connector

Admin console → **Sources** → the source → set status **Disabled** (a reason is required), or turn **Tracking** off.

**Expected effect:**

- New searches skip the source and report it as skipped with its reason.
- Price tracking stops scheduling checks for it.
- Stored offers and price history are kept.
- The change is audit-logged.

Re-enabling is refused unless the connector's readiness is `READY`.

## C. Pause background job processing

```sh
scripts/deploy/compose.sh stop worker             # graceful: finishes active jobs (grace period 120 s)
scripts/deploy/compose.sh start worker            # resume
```

**Expected effect:**

- On SIGTERM, the worker closes its BullMQ workers, which waits for active jobs, within `WORKER_STOP_GRACE` (default 120 s).
- Waiting jobs stay in Redis (AOF-persisted) and run after the restart.
- Searches stay queued and users see them pending.
- Alerts and notifications are delayed, not lost.
- `QueueWithoutWorkers` fires after 5 minutes. That's expected; note it in the incident.

## D. Revert a configuration change

```sh
cp .env.production .env.production.broken         # keep the evidence (contains secrets: chmod 600)
$EDITOR .env.production                           # restore the previous value
ENV_FILE=.env.production scripts/deploy/check-env.sh   # must pass
scripts/deploy/compose.sh up -d --no-deps api     # recreate only the service(s) that read it
```

**Expected effect:** only the named service is recreated, and its health check gates traffic.

Secret rotations have side effects:

- `SESSION_SECRET` invalidates CSRF tokens;
- `TOKEN_ENCRYPTION_KEY` signs everyone out.

See [incident-response.md](incident-response.md) §Secret rotation.

## E. Restore from backup (disaster recovery)

**Only with explicit authorization from the owner,** and only when A–D can't repair the damage. A restore discards every write made after the backup. Follow [disaster-recovery.md](disaster-recovery.md).

## After any rollback

1. Record it: what, when, why, and who decided. `releases/history.log` has the timestamps.
2. Keep the bad release's images and logs for diagnosis: `compose.sh logs --since 2h > /tmp/incident-<svc>.log`.
3. Don't redeploy the bad release until the cause is fixed and verified on staging.
