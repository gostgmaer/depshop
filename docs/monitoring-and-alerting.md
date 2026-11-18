# Monitoring and alerting

## What exists

| Layer                               | Implementation                                                                                                                                                                                                                                                                                                                                                                     | Status                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured logs                     | JSON from every service: `time`, `level`, `service` (`dealmind-api`/`-worker`/`-agent`), `env` (`DEPLOY_ENV`), request id (`reqId`), and execution/search ids where relevant. Secrets, cookies and auth headers are redacted. URLs are logged without query strings. Traefik access logs are JSON without headers or paths. Docker `json-file` rotation (5 × 20 MB per container). | Implemented and verified in the rehearsal                                                                                                                                             |
| Correlation                         | The web proxy sets `x-request-id`, the API adopts it (validated) and returns it. The API → worker → agent → internal API chain correlates on the search and execution ids (`x-correlation-id`), which every log line carries.                                                                                                                                                      | Implemented. Correlation-based, not OpenTelemetry spans.                                                                                                                              |
| Metrics                             | API `GET /metrics` (Prometheus, bearer `METRICS_TOKEN`, private network only); details below. Traefik's Prometheus metrics on `:8082` (private).                                                                                                                                                                                                                                   | Implemented and verified (scraped in the rehearsal)                                                                                                                                   |
| Health                              | `/health/live`, `/ready` (database, Redis, IAM), web `/healthz`, agent `/ready`, worker heartbeat; Docker health checks; Traefik routes only to healthy containers.                                                                                                                                                                                                                | Implemented and verified                                                                                                                                                              |
| Probes / alerts                     | Optional overlay `infrastructure/monitoring/`: Prometheus, Alertmanager (one webhook receiver), blackbox probes (public HTTPS and certificate expiry, internal readiness), node-exporter (disk, memory, backup-freshness textfiles). 23 alert rules.                                                                                                                               | Implemented and run in the rehearsal (all targets up; rules load). **Not deployed anywhere real; no alert receiver configured.**                                                      |
| Distributed tracing (OpenTelemetry) | —                                                                                                                                                                                                                                                                                                                                                                                  | **Not implemented.** Needs a collector or backend choice. The worker records tracking metrics through `@opentelemetry/api`, which is a no-op until an SDK and exporter are installed. |
| Error tracking (Sentry)             | —                                                                                                                                                                                                                                                                                                                                                                                  | **Not implemented.** Needs a DSN and the SDK dependency decision.                                                                                                                     |

### API metrics (`/metrics`)

Labels use route templates and enum values only. They never contain user ids, query text or e-mail addresses (checked by `observability.db.test.ts`).

- `dealmind_http_requests_total{method,route,status}`, `dealmind_http_request_duration_seconds` (histogram).
- `dealmind_queue_jobs{queue,state}`, `dealmind_queue_workers{queue}`: backlog, failures, dead letters, and whether any worker is connected.
- `dealmind_searches_15m{status}`: search completion, partial and failed rates.
- `dealmind_agent_runs_15m{status}`, `dealmind_agent_run_duration_ms_15m{stat}`: agent failures and duration.
- `dealmind_llm_tokens_month{kind}`: LLM token usage. The cost estimate is in Admin → AI models.
- `dealmind_notification_deliveries_15m{channel,status}`: notification failures.
- `dealmind_price_checks_15m{outcome}`: price-tracking job outcomes.
- `dealmind_payment_webhooks_15m{processing_status}`: payment webhook failures.
- `dealmind_source_up{source,status,health}`, `dealmind_connector_requests{source,outcome}`, `dealmind_connector_latency_ms_avg{source}`: connector degradation and latency.
- Process memory and uptime.

**Database and Redis health:** the `/ready` probe through blackbox. PostgreSQL slow queries (≥ 500 ms) go to its log (`log_min_duration_statement`).

## Running the overlay

```sh
# .env.production: METRICS_TOKEN, ALERTMANAGER_WEBHOOK_URL, BACKUP_METRICS_DIR=/var/lib/node_exporter/textfile
COMPOSE_OVERRIDE=infrastructure/monitoring/docker-compose.monitoring.yml scripts/deploy/compose.sh up -d \
  prometheus alertmanager blackbox node-exporter
ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 deploy@host     # UIs over an SSH tunnel only
```

`ALERTMANAGER_WEBHOOK_URL` must point at a receiver you actually watch (a chat webhook bridge, a pager, an incident tool). **Until it does, no alert reaches anyone.** Test it by stopping the worker for 6 minutes on staging; `QueueWithoutWorkers` should arrive.

For hosted monitoring instead (Grafana Cloud, Datadog, …), point its agent at the same endpoints and port the rules in `alerts.yml`.

## Alert catalogue (`infrastructure/monitoring/alerts.yml`)

| Alert                                                 | Condition (summary)                                   | Severity           |
| ----------------------------------------------------- | ----------------------------------------------------- | ------------------ |
| SiteDown                                              | public HTTPS probe failing 3 min                      | critical           |
| ApiNotReady                                           | `/ready` failing 3 min (database, Redis or IAM down)  | critical           |
| AgentNotReady                                         | agent `/ready` failing 5 min                          | critical           |
| MetricsScrapeFailing                                  | API not scrapeable 5 min                              | warning            |
| CertificateExpiringSoon                               | certificate < 14 days to expiry (renewal failing)     | warning            |
| ApiHighErrorRate                                      | > 2 % 5xx for 10 min                                  | critical           |
| ApiHighLatency                                        | p95 > 1 s for 10 min (SSE excluded)                   | warning            |
| QueueBacklog                                          | > 500 waiting for 15 min                              | warning            |
| QueueWithoutWorkers                                   | 0 workers on an active queue for 5 min                | critical           |
| JobsFailing / DeadLetters                             | failed jobs rising / dead letters present             | warning            |
| SearchFailureRate / AgentRunsFailing / AgentSlow      | > 20 % failing / average > 60 s                       | warning            |
| PriceChecksFailing                                    | > 30 % of checks FAILED/INVALID                       | warning            |
| NotificationDeliveryFailures                          | > 10 failed in 15 min                                 | warning            |
| PaymentWebhookFailures                                | any failed webhook processing                         | critical           |
| ConnectorDown                                         | an ACTIVE source not HEALTHY for 30 min               | warning            |
| DiskSpaceLow / MemoryPressure                         | < 15 % disk / < 10 % memory                           | critical / warning |
| BackupMissing / BackupMetricAbsent / RestoreTestStale | no backup in 26 h / never / no restore test in 8 days | critical / warning |

Thresholds are starting points: tune them after a week of real traffic. Each alert links to [incident-response.md](incident-response.md).

## Verified (local rehearsal, 2026-11-17)

- **Config validity:** `promtool check config` and `check rules` (23 rules), and `amtool check-config`, all pass.
- **Targets:** all 7 scrape targets were up (API with token, Traefik, node, internal readiness ×2, public ×2).
- **Business metrics:** scraped (sources reported honestly as `PENDING_APPROVAL`/`PENDING_CREDENTIALS`, queue workers, LLM tokens). Backup freshness metric present.
- **Alerts:** they behaved as expected. `ApiNotReady` was pending because IAM was absent in the rehearsal. `SiteDown` was pending because blackbox resolves `*.localhost` to its own loopback (a rehearsal artifact). `QueueWithoutWorkers` fired for `billing-control`, which has no worker without billing; that rule was corrected to exclude it.
- **Not verified:** alert delivery to a real receiver; public probes against a real domain and certificate.
