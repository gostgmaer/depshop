# Production operations handbook

How to run DealMind AI once it is live. Commands run on the host from `/opt/dealmind`. The monitoring UIs are reached over an SSH tunnel only ([monitoring-and-alerting.md](monitoring-and-alerting.md)).

**Status 2026-11-18:** not yet in production ([production-go-live.md](production-go-live.md)). Everything below is the procedure to follow once it is.

## Responsibilities

| Role                  | Who                   | Owns                                                                                                   |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| Application owner     | _to be named_         | Production authorization, restores, external accounts (marketplaces, Razorpay, LLM), privacy and legal |
| On-call operator      | _to be named_         | Alerts, daily checks, rollbacks, incident lead for SEV-1/2                                             |
| Shared-services owner | EasyDev platform team | IAM, payment and notification services                                                                 |

Escalation:

1. The alert goes to the on-call operator.
2. If not acknowledged in 15 min (SEV-1) or 2 h (SEV-2), it goes to the application owner.
3. If a shared service is the cause, the shared-services owner is brought in.

**Until named people exist, there is no on-call.** Record that as a launch blocker; don't launch with an unwatched alert receiver.

## Launch window (first 72 hours)

Check hourly for 24 h, then every 4 h:

| Signal                            | Where                                                                    | Pause expansion if                    |
| --------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| API latency p95, 4xx/5xx rate     | `dealmind_http_request_duration_seconds`, `dealmind_http_requests_total` | p95 > 1 s or 5xx > 1 % for 10 min     |
| Frontend errors                   | `compose.sh logs web` (no error tracker yet)                             | any repeated server error             |
| DB connections, Redis health      | `/ready`, blackbox probes                                                | any failure                           |
| Queue depth and failed jobs       | `dealmind_queue_jobs`                                                    | backlog > 500 or dead letters         |
| Agent failures, search completion | `dealmind_agent_runs_15m`, `dealmind_searches_15m`                       | > 20 % failed                         |
| LLM errors and token use          | `dealmind_llm_tokens_month`, Admin → AI models                           | spend trending above budget           |
| Connector failures                | `dealmind_source_up`, `dealmind_connector_requests`                      | an ACTIVE source unhealthy for 30 min |
| Notification failures             | `dealmind_notification_deliveries_15m`                                   | > 10 failed per 15 min                |
| CPU, memory, disk                 | node-exporter                                                            | memory > 85 %, disk > 70 %            |
| TLS                               | `CertificateExpiringSoon`                                                | firing                                |

## Severity

| Severity  | Definition                                                               | Response                                                                            |
| --------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **SEV-1** | Data breach, major outage, data corruption                               | Immediately. Pause expansion. Incident lead. User status update if visible > 15 min |
| **SEV-2** | Core shopping or account workflows unavailable (search, sign-in, alerts) | Within 1 h. Pause expansion                                                         |
| **SEV-3** | Partial degradation (one connector, slow pages, delayed notifications)   | Same working day                                                                    |
| **SEV-4** | Minor visual or non-critical defects                                     | Backlog                                                                             |

Runbooks: [incident-response.md](incident-response.md). Undo: [rollback-runbook.md](rollback-runbook.md).

## Daily checks (≈ 10 min)

```sh
scripts/deploy/compose.sh ps                                       # all healthy
tail -3 releases/history.log                                       # unexpected releases?
ls -lt /var/backups/dealmind | head -3                             # last night's backup exists
systemctl list-timers 'dealmind-*'                                 # backup + restore-test timers scheduled
df -h / /var/lib/docker; free -m                                   # disk < 70 %, memory headroom
```

Then in Prometheus or Alertmanager (tunnel), confirm:

- no firing alerts;
- 5xx rate and p95 latency normal;
- no dead-letter jobs (Admin → Jobs: retry or inspect failed jobs; payloads aren't shown);
- source health (Admin → Sources: ACTIVE sources HEALTHY);
- payment webhooks (`dealmind_payment_webhooks_15m`: no FAILED).

## Weekly checks (≈ 45 min)

- **Dependencies and security:** GitHub security alerts and Dependabot, `pnpm audit --prod`, and pip-audit on the agent's locked set (the command is in `.github/workflows/ci.yml`, security job). Track accepted items in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).
- **Failed jobs:** review the week's dead letters by queue and error. Fix causes, not symptoms.
- **Database growth:** table sizes (`SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY 2 DESC LIMIT 10;`) and price-history growth rate against disk.
- **Slow queries:** `compose.sh logs postgres | grep "duration:"` (≥ 500 ms are logged).
- **Connector performance:** Admin → Sources latency, failure and rate-limit events per source, against each programme's limits.
- **Backup restore sampling:** confirm the weekly `restore-test.sh` passed (`RestoreTestStale` silent). Spot-check one restored row count against production.

## Monthly checks (≈ 2–3 h)

- **Disaster-recovery exercise** on staging ([disaster-recovery.md](disaster-recovery.md) Drills). Record the measured RTO.
- **Access review:**
  - who has SSH, GitHub environment approval, registry tokens and ADMIN role (Admin → Users, filtered by role);
  - remove anyone who no longer needs it.
- **Secret rotation review:** age of each secret; rotate on schedule or after any access change ([incident-response.md](incident-response.md) §Secret rotation).
- **Database maintenance:** `VACUUM (ANALYZE)` happens through autovacuum. Check bloat and index usage, and confirm the retention jobs ran (ended sessions, old notifications, deliveries and searches purged; DM-09 in [SECURITY_AUDIT.md](SECURITY_AUDIT.md)).
- **Cost review:** actual bills against [production-cost-estimate.md](production-cost-estimate.md); LLM tokens per search.
- **Capacity planning:** monthly peaks of CPU, memory, disk, queue latency and p95. Scale only on measured need (next section).
- **Dependency and vulnerability review:**
  - base-image updates (rebuild and run Trivy);
  - Node, Python and Postgres minor versions;
  - plan any major upgrades (zod 4, Prisma 7: [SECURITY_AUDIT.md](SECURITY_AUDIT.md)).

## Scaling, in order, only when monitoring shows the need

1. Raise a service's resource limits (`API_MEMORY`, `WORKER_CPUS`, …) or the worker concurrency variables.
2. Move to a larger host. Vertical scaling covers the expected early load: the local k6 run sustained about 1,000 req/s on one laptop.
3. Run managed PostgreSQL with PITR when database size or recovery-point needs exceed nightly dumps.
4. Run more worker replicas. They're stateless; BullMQ coordinates through Redis.
5. Only then consider multiple API hosts behind a load balancer.

No Kubernetes and no further service split until those are exhausted.

## Routine changes

| Task                                | How                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Release                             | Tag `vX.Y.Z` → staging → owner approves production ([ci-cd.md](ci-cd.md))                                                      |
| Enable a newly approved marketplace | Credentials into `.env.production`, recreate api/worker/agent. Admin → Sources → enable (refused unless `READY`). Smoke search |
| Change a connector's limits         | Admin → Sources (audit-logged)                                                                                                 |
| Rotate a secret                     | [incident-response.md](incident-response.md) §Secret rotation                                                                  |
| Restore data                        | Owner authorization → [disaster-recovery.md](disaster-recovery.md)                                                             |
