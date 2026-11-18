# Incident response

Short runbooks for the alerts in [monitoring-and-alerting.md](monitoring-and-alerting.md). All commands run on the host from `/opt/dealmind`.

## Severity and roles

| Severity | Examples                                                | Response                                                                                        |
| -------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SEV1     | site down, data loss, security breach, payments failing | Start now. One incident lead. Status update to users if impact is visible for more than 15 min. |
| SEV2     | searches failing, alerts not sent, a connector down     | Same working day                                                                                |
| SEV3     | slowness, single job failures                           | Next working day                                                                                |

**Steps:**

1. Acknowledge.
2. Stabilise: roll back if a deploy is the likely cause.
3. Find the cause.
4. Fix.
5. Write a short post-incident note (timeline, cause, follow-ups).

Preserve logs before restarting anything (`compose.sh logs --since 2h <svc> > /tmp/incident-<svc>.log`).

## First five minutes (any alert)

```sh
scripts/deploy/compose.sh ps                                   # health of every service
tail -5 releases/history.log                                   # did a release just happen?
scripts/deploy/compose.sh logs --since 15m api | grep '"level":5' | tail   # errors (pino level 50)
scripts/deploy/compose.sh exec -T api node -e "fetch('http://127.0.0.1:4000/ready').then(r=>r.text()).then(console.log)"
```

If a release went out in the last hour and the timing matches, **roll back first and investigate after**: `scripts/deploy/rollback.sh` (see [production-deployment.md](production-deployment.md) §6).

## Site down

- **Traefik unhealthy, or not running:**
  ```sh
  compose.sh logs traefik    # certificate or socket-proxy errors?
  compose.sh up -d socket-proxy traefik
  ```
- **web or api unhealthy:** check their logs.
  - A crash at start-up usually means bad configuration; the service names the variable.
  - Fix `.env.production`, then run `deploy.sh <current tag>`.
- **Host:** check disk (`df -h`; Docker logs and backups are the usual culprits) and memory (`free -m`).

## Dependency down

`/ready` names the failing check.

- **database:**
  ```sh
  compose.sh ps postgres; compose.sh logs --tail=50 postgres
  ```
  Is the disk full? Is `PG_MAX_CONNECTIONS` exhausted (compare `DB_POOL_SIZE` × containers)? The API answers 503 (retryable) during an outage and recovers by itself. **Never delete the volume.**
- **redis:**
  ```sh
  compose.sh logs --tail=50 redis
  ```
  Look for memory (`maxmemory` with `noeviction` means writes fail when full: raise the limit, find the backlog). The API keeps serving reads, and queues resume when Redis returns.
- **iam / iamJwks:** the shared EasyDev IAM is unreachable. Sign-in fails with 503; existing sessions keep working. Escalate to the IAM owners.

## Agent failures

```sh
compose.sh logs --since 30m agent
```

Look for:

- provider errors (quota, key, model name);
- the internal API being unreachable;
- the checkpoint schema.

**Mitigation:** Admin → AI models → switch to the fallback, or disable LLM calls (rule-based extraction keeps search working). The agent applies the change within about a minute.

If the agent can't start after a database restore, run `scripts/deploy/apply-db-roles.sh`. It re-asserts ownership of `agent_checkpoints`.

## Worker failures / queue backlog

- **`QueueWithoutWorkers`:** run `compose.sh ps worker`, then `compose.sh logs --tail=100 worker`, then `compose.sh up -d worker`.
- **Backlog:**
  1. Check Admin → Jobs (counts, failures, dead letters).
  2. Is it upstream (connectors rate-limited or failing), the agent, or capacity? Raise `WORKER_CONCURRENCY` or `PRICE_TRACKING_CONCURRENCY` cautiously; the marketplace rate limits still apply.
  3. Failed jobs can be retried one at a time from Admin → Jobs. There is no bulk retry by design.

## API errors / latency

```sh
compose.sh logs --since 15m api | grep -E '"statusCode":5'
```

Group the errors by `route` and look for one dependency or one endpoint. Slow queries appear in the PostgreSQL log (≥ 500 ms).

## Connector degraded

Admin → Connectors shows health, the last error category and the metrics.

- **Credentials:** check that they are still valid.
- **Upstream outages:** searches return partial results and name the unavailable source. Nothing needs doing beyond monitoring.
- **Disabling a source:** if it keeps timing out, disable it (Admin → Connectors, with a reason).

**Never work around a marketplace's access restrictions.**

## Payments

`PaymentWebhookFailures` means subscription changes may not be reflected yet.

- **Signature failures:** check `PAYMENT_WEBHOOK_SECRET` (it must match the payment service's).
- **Processing failures:** check the API logs for `billing`.

The hourly reconcile job re-reads subscriptions from the payment service. Never mark a payment as successful by hand.

## Certificate renewal

```sh
compose.sh logs traefik | grep -i acme
```

Common causes:

- DNS no longer pointing at the host;
- port 80 blocked (HTTP-01 needs it);
- Let's Encrypt rate limits.

Certificates live in the `letsencrypt` volume (`acme.json`); never delete it casually.

## Data loss or corruption

1. **Stop writes:** `compose.sh stop web worker api`.
2. Take a backup of the _current_ state: `pg-backup.sh --label incident`.
3. Restore into a scratch database (`pg-restore.sh <backup> --into dealmind_inspect`), compare, and decide.
4. If a full restore is needed, use `pg-restore.sh <backup> --replace-live` (it keeps the old database). See [backup-and-recovery.md](backup-and-recovery.md).

## Security incident

1. **Contain:** rotate the affected secrets (below). To end all sessions, rotate `TOKEN_ENCRYPTION_KEY`, which signs everyone out. Disable an affected connector or affiliate program in the admin console.
2. **Preserve:** keep the logs and the `AuditLog` table (Admin → Audit log).
3. **Assess personal-data impact.** A personal-data breach must be reported to the Data Protection Board of India and to affected users under the DPDP Act and its Rules. Involve the operator's legal contact immediately.

### Secret rotation

| Secret                                                                   | How                                                   | Side effect                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------ |
| `SESSION_SECRET`                                                         | new value, `deploy.sh <current tag>`                  | Open forms need a refresh (new CSRF token) |
| `TOKEN_ENCRYPTION_KEY`                                                   | new value, deploy                                     | Everyone is signed out                     |
| `INTERNAL_API_TOKEN`, `AGENT_SERVICE_TOKEN`, `AGENT_USER_CONTEXT_SECRET` | new values, deploy (both sides read the same file)    | In-flight searches may fail once           |
| `METRICS_TOKEN`                                                          | new value, deploy, restart Prometheus                 | —                                          |
| `DEALMIND_APP_DB_PASSWORD` / `DEALMIND_AGENT_DB_PASSWORD`                | new value, `apply-db-roles.sh`, deploy                | Brief reconnects                           |
| `POSTGRES_PASSWORD` (owner)                                              | `ALTER ROLE … PASSWORD` in psql, then update the file | Migration job only                         |
| `REDIS_PASSWORD`                                                         | new value, `compose.sh up -d redis api worker`        | Brief reconnect                            |
| `PAYMENT_WEBHOOK_SECRET`, marketplace / LLM / notification keys          | rotate at the provider, update the file, deploy       | —                                          |
