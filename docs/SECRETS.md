# Secrets and environment variables: DevOps reference

Every variable DealMind reads, which service needs it, how to generate or obtain it, and
whether it must be set before launch. **This file holds names only, never values.**

- **Production / staging:** one file, `/opt/dealmind/.env.production` (`chmod 600`, owned by
  the deploy user), created from `infrastructure/docker/production/.env.production.example`.
  The compose file `infrastructure/docker/production/docker-compose.yml` hands each container
  only what it needs (table below). Staging uses its **own** copy with **different** values.
- **Validate before every deploy:** `scripts/deploy/check-env.sh` (run by `deploy.sh`). It
  fails on missing or too-short required values, `BILLING_PROVIDER=sandbox`, and values that
  aren't URL-safe inside connection strings.
- **Local development:** repository-root `.env` (from `.env.example`), read by the dev servers
  and by `infrastructure/docker/local/docker-compose.yml`.
- **Never** commit the real file, bake it into an image, paste it into chat or tickets, or
  print it in logs. Services never log secret values.

## How to generate values

| Kind                                       | Command                    | Why                                                               |
| ------------------------------------------ | -------------------------- | ----------------------------------------------------------------- |
| Passwords and tokens (≥ 32 chars)          | `openssl rand -hex 32`     | Hex is URL-safe, needed inside `postgresql://`/`redis://` URLs    |
| `TOKEN_ENCRYPTION_KEY` (32 bytes)          | `openssl rand -base64 32`  | Must decode to exactly 32 bytes                                   |
| Web push keys (`VAPID_*`)                  | `pnpm notifications:vapid` | Generates the public/private key pair once                        |
| Backup encryption (`BACKUP_AGE_RECIPIENT`) | `age-keygen -o backup.key` | Put the **public** `age1…` key here; keep the private key offline |

Every secret must be **unique**: don't reuse one value for two variables or across
staging and production.

## Legend

- **Req.** ✅ required (deploy fails or the service won't start) · ⚠️ required for launch
  (deploys, but the feature is off/blocked) · ○ optional.
- **Services:** `api`, `worker`, `agent` (Python), `web` (Next.js), `migrate`, `postgres`,
  `redis`, `traefik`.
- **Rotate:** what happens when the value changes.

## 1. Deployment and domains (not secret)

| Variable         | Req. | Services                  | Value / where from                                                                        |
| ---------------- | ---- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `DEPLOY_ENV`     | ✅   | api, worker, agent        | `staging` or `production` (labels logs and metrics)                                       |
| `APP_DOMAIN`     | ✅   | traefik, api, worker, web | Public web host; becomes `APP_URL`/`SITE_URL` = `https://APP_DOMAIN`                      |
| `API_DOMAIN`     | ✅   | traefik                   | Public API host (`/api`, `/health/live`, payment webhook)                                 |
| `ACME_EMAIL`     | ✅   | traefik                   | Let's Encrypt account e-mail                                                              |
| `ACME_CA_SERVER` | ○    | traefik                   | LE **staging** CA for first staging runs, then remove                                     |
| `IMAGE_REGISTRY` | ✅   | compose                   | e.g. `ghcr.io/<owner>`; CI pushes the images here                                         |
| `IMAGE_TAG`      | ✅   | compose                   | Set by `scripts/deploy/deploy.sh` (commit SHA / release tag)                              |
| `EDGE_SUBNET`    | ○    | api                       | Traefik network; the API trusts `X-Forwarded-For` only from it (default `172.30.10.0/24`) |
| `SEO_INDEXING`   | ○    | web                       | `enabled` **only** on the production host at launch; staging: never                       |
| `LOG_LEVEL`      | ○    | api, worker, agent        | `info` (default)                                                                          |

## 2. Database (PostgreSQL)

| Variable                                                      | Req. | Services                                              | Value / where from                                                    | Rotate                                                |
| ------------------------------------------------------------- | ---- | ----------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `POSTGRES_DB`                                                 | ○    | postgres, all DB users                                | `dealmind`                                                            | n/a                                                   |
| `POSTGRES_USER`                                               | ○    | postgres, migrate                                     | `dealmind_owner`: **migrations only**, never used by running services | n/a                                                   |
| `POSTGRES_PASSWORD`                                           | ✅   | postgres, migrate                                     | `openssl rand -hex 32` (≥ 32, URL-safe)                               | `ALTER ROLE` first, then update the file              |
| `DEALMIND_APP_DB_PASSWORD`                                    | ✅   | api, worker (`dealmind_app`, DML only)                | `openssl rand -hex 32`                                                | `ALTER ROLE dealmind_app`, then recreate api + worker |
| `DEALMIND_AGENT_DB_PASSWORD`                                  | ✅   | agent (`dealmind_agent`, 2 read models + checkpoints) | `openssl rand -hex 32`                                                | `ALTER ROLE dealmind_agent`, then recreate agent      |
| `DB_POOL_SIZE`                                                | ○    | api, worker                                           | Connections per container (default 10)                                | n/a                                                   |
| `PG_SHARED_BUFFERS`, `PG_MAX_CONNECTIONS`, `PG_SLOW_QUERY_MS` | ○    | postgres                                              | Tuning                                                                | n/a                                                   |

`DATABASE_URL` is **built by the compose file** from these; don't set it in `.env.production`.
The roles are created by `infrastructure/docker/postgres/roles.sql` (see
`docs/DATABASE.md`).

## 3. Redis

| Variable           | Req. | Services           | Value / where from                      | Rotate                                                                                       |
| ------------------ | ---- | ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `REDIS_PASSWORD`   | ✅   | redis, api, worker | `openssl rand -hex 32` (≥ 32, URL-safe) | Recreate redis + api + worker together (brief queue pause; no data loss with the AOF volume) |
| `REDIS_KEY_PREFIX` | ○    | api, worker        | `dm` (default)                          | n/a                                                                                          |

`REDIS_URL` is built by the compose file.

## 4. Sessions, encryption and first-run setup (api)

| Variable               | Req. | Services | Value / where from                                                                                                                                                               | Rotate                                                        |
| ---------------------- | ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `SESSION_SECRET`       | ✅   | api      | `openssl rand -hex 32` (≥ 32)                                                                                                                                                    | Invalidates CSRF tokens (users re-submit forms)               |
| `TOKEN_ENCRYPTION_KEY` | ✅   | api      | `openssl rand -base64 32` (exactly 32 bytes)                                                                                                                                     | **Signs everyone out** (stored IAM tokens can't be decrypted) |
| `ADMIN_SETUP_TOKEN`    | ○    | api      | Leave **empty**: a one-time token is generated and printed once in the api log (`First-run setup`). Or set your own (≥ 16). Used only while no admin exists; see `docs/ADMIN.md` | Remove after the first admin is created                       |

## 5. Internal service authentication

| Variable                    | Req. | Services           | Purpose                                                                                                                                                                      |
| --------------------------- | ---- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTERNAL_API_TOKEN`        | ✅   | api, agent         | agent → api `/internal/v1`                                                                                                                                                   |
| `AGENT_SERVICE_TOKEN`       | ✅   | api, worker, agent | api/worker → agent                                                                                                                                                           |
| `AGENT_USER_CONTEXT_SECRET` | ✅   | api, worker, agent | HMAC for the signed per-search user context                                                                                                                                  |
| `REVIEW_CONTEXT_SECRET`     | ○    | api                | HMAC for admin reviewer contexts (never given to the agent). **Not yet passed by the production compose file**: add it to the `api` service if the admin review flow is used |
| `METRICS_TOKEN`             | ○    | api, Prometheus    | Prometheus → api `/metrics` (private network)                                                                                                                                |

All: `openssl rand -hex 32` (≥ 32). The **same value** must reach every service listed;
the compose file does that from the single `.env.production`. Rotating one: update the
file, then recreate **all** services listed on that row at once.

## 6. Shared EasyDev identity (IAM)

| Variable           | Req. | Services | Value / where from                                                      |
| ------------------ | ---- | -------- | ----------------------------------------------------------------------- |
| `IAM_BASE_URL`     | ✅   | api      | `https://<iam-host>/api/v1/iam` from the IAM team                       |
| `IAM_TENANT`       | ○    | api      | `easydev` (the IAM's own tenant header; DealMind itself has no tenants) |
| `IAM_JWT_ISSUER`   | ○    | api      | `iam-service`                                                           |
| `IAM_JWT_AUDIENCE` | ○    | api      | `easydev`                                                               |
| `IAM_JWKS_URL`     | ○    | api      | Only if the IAM's JWKS isn't at the default path                        |
| `IAM_TIMEOUT_MS`   | ○    | api      | Default 8000                                                            |

## 7. AI model provider (agent)

| Variable                                      | Req.                    | Services | Value / where from                                         |
| --------------------------------------------- | ----------------------- | -------- | ---------------------------------------------------------- |
| `LLM_PROVIDER`                                | ✅                      | agent    | `google` \| `openai` \| `rules` (`rules` = no model calls) |
| `LLM_MODEL`                                   | ✅                      | agent    | The provider's model name                                  |
| `GOOGLE_API_KEY`                              | ✅ if provider `google` | agent    | Google AI Studio / Cloud console                           |
| `OPENAI_API_KEY`                              | ✅ if provider `openai` | agent    | OpenAI dashboard                                           |
| `LLM_FALLBACK_PROVIDER`, `LLM_FALLBACK_MODEL` | ○                       | agent    | Used when the primary fails; needs that provider's key too |
| `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`           | ○                       | agent    | Defaults 0.2 / 8192                                        |

Set a spending limit at the provider; see `docs/ai-cost-optimization.md`.

## 8. Marketplace connectors and affiliate programs

Leave **empty** until the program is approved. An unconfigured connector reports
`PENDING_CREDENTIALS` and is never shown as searched; links go out without an affiliate tag.

| Variable                            | Services    | Where from                                        | Effect when set                                                            |
| ----------------------------------- | ----------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `AMAZON_ASSOCIATES_PARTNER_TAG`     | api, worker | Amazon Associates India (tag like `name-21`)      | Amazon links tagged once an admin enables Amazon in **Admin → Affiliates** |
| `AMAZON_CREATORS_CREDENTIAL_ID`     | api, worker | Amazon Creators API (approved Associates account) | Live Amazon search (verify before activating the source)                   |
| `AMAZON_CREATORS_CREDENTIAL_SECRET` | api, worker | Same                                              | Same                                                                       |
| `FLIPKART_AFFILIATE_ID`             | api, worker | Flipkart Affiliate programme                      | Flipkart links tagged once enabled in Admin                                |
| `FLIPKART_AFFILIATE_TOKEN`          | api, worker | Same                                              | Live Flipkart search + earnings report import                              |

After setting: recreate api + worker, run the connector verification in `docs/CONNECTORS.md`,
then enable the program in **Admin → Affiliates** (see `docs/AFFILIATE.md`).
`CONNECTORS_ENABLE_MOCKS` is forced to `false` in production; never enable mocks there.

## 9. Payments (shared EasyDev payment service)

Razorpay keys live in the payment service, **never** in DealMind.

| Variable                  | Req.                     | Services    | Where from                                                                       |
| ------------------------- | ------------------------ | ----------- | -------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`        | ○                        | api, worker | `none` (default) or `easydev-payments`. `sandbox` is refused outside development |
| `PAYMENT_SERVICE_URL`     | ✅ if `easydev-payments` | api, worker | Payment service team                                                             |
| `PAYMENT_SERVICE_API_KEY` | ✅ if `easydev-payments` | api, worker | Payment service team                                                             |
| `PAYMENT_WEBHOOK_SECRET`  | ✅ if `easydev-payments` | api         | Issued when the webhook is registered (≥ 32)                                     |
| `PAYMENT_TENANT_ID`       | ○                        | api, worker | `easydev` (the payment service's header)                                         |
| `PAYMENT_APPLICATION_ID`  | ○                        | api, worker | `dealmind`                                                                       |
| `BILLING_GRACE_DAYS`      | ○                        | api, worker | Default 3                                                                        |
| `LAUNCH_FREE_PLAN`        | ○                        | api, worker | `PRO` during the free launch (checkout refused); empty = normal paid plans       |

Staging: payment service in **TEST** mode. See `docs/BILLING.md`.

## 10. E-mail and push notifications

| Variable                    | Req. | Services    | Where from                                                                                                |
| --------------------------- | ---- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `NOTIFICATION_SERVICE_URL`  | ⚠️   | api, worker | EasyDev notification service (SMTP is configured there)                                                   |
| `NOTIFICATION_API_KEY`      | ⚠️   | api, worker | Notification service team                                                                                 |
| `NOTIFICATION_TENANT_ID`    | ○    | api, worker | `dealmind`                                                                                                |
| `NOTIFICATION_TOKEN_SECRET` | ⚠️   | api, worker | `openssl rand -hex 32`; signs one-click unsubscribe links (rotating breaks links in already-sent e-mails) |
| `VAPID_PUBLIC_KEY`          | ○    | api, worker | `pnpm notifications:vapid`                                                                                |
| `VAPID_PRIVATE_KEY`         | ○    | worker      | Same command; **private**                                                                                 |
| `VAPID_SUBJECT`             | ○    | worker      | `mailto:ops@<your-domain>`                                                                                |

Without the notification service there are no e-mails (in-app notifications still work).
Rotating the VAPID pair drops every existing push subscription.

## 11. File uploads (optional)

| Variable                   | Services | Where from           |
| -------------------------- | -------- | -------------------- |
| `FILE_SERVICE_URL`         | api      | EasyDev file service |
| `FILE_SERVICE_HMAC_SECRET` | api      | File service team    |
| `FILE_SERVICE_TENANT_ID`   | api      | `dealmind`           |

## 12. Legal, backups, monitoring, smoke tests

| Variable                              | Req.                     | Used by                          | Value                                                           |
| ------------------------------------- | ------------------------ | -------------------------------- | --------------------------------------------------------------- |
| `PRIVACY_OPERATOR_NAME`               | ⚠️                       | web (privacy notice)             | Legal operator name (`check-env.sh` requires it for production) |
| `PRIVACY_CONTACT_EMAIL`               | ⚠️                       | web                              | Privacy contact address                                         |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` | ○                        | `scripts/backup/pg-backup.sh`    | `/var/backups/dealmind`, 14                                     |
| `BACKUP_AGE_RECIPIENT`                | ○ (strongly recommended) | backup script                    | `age1…` public key                                              |
| `BACKUP_UPLOAD_CMD`                   | ○                        | backup script                    | e.g. `rclone copy {file} remote:dealmind-backups`               |
| `BACKUP_METRICS_DIR`                  | ○                        | node-exporter                    | `/var/lib/node_exporter/textfile`                               |
| `ALERTMANAGER_WEBHOOK_URL`            | ○                        | monitoring overlay               | Chat/pager webhook (secret-like: treat as a secret)             |
| `SMOKE_EMAIL`, `SMOKE_PASSWORD`       | ○                        | `docs/production-smoke-tests.md` | A dedicated **test** account, never a real user                 |

## 13. Tuning (all have working defaults)

`WORKER_CONCURRENCY`, `NOTIFICATION_CONCURRENCY`, `PRICE_TRACKING_CONCURRENCY`,
`TRACKING_ENABLED`, `TRACKING_SOURCE_SHARE`, `TRACKING_MAX_QUEUED`, `AGENT_TIMEOUT_SECONDS`,
`AGENT_MAX_CONNECTIONS`, `CORS_ORIGINS` (normally empty), `TRAEFIK_LOG_LEVEL`,
`WORKER_STOP_GRACE`, and the resource limits `API_CPUS`/`API_MEMORY`, `WORKER_*`, `AGENT_*`,
`WEB_*`, `PG_*`. Defaults are in the production compose file.

## Set by the compose file (don't put these in `.env.production`)

`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `SITE_URL`, `AGENT_SERVICE_URL`,
`INTERNAL_API_URL`, `API_INTERNAL_URL`, `HOST`, `PORT`, `TRUST_PROXY`, `TRUSTED_PROXY_COUNT`,
`COOKIE_SECURE=true`, `API_DOCS_ENABLED=false`, `CONNECTORS_ENABLE_MOCKS=false`,
`CHECKPOINTER=postgres`.

## Minimum to get production running

1. Generate: `POSTGRES_PASSWORD`, `DEALMIND_APP_DB_PASSWORD`, `DEALMIND_AGENT_DB_PASSWORD`,
   `REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_API_TOKEN`, `AGENT_SERVICE_TOKEN`,
   `AGENT_USER_CONTEXT_SECRET` (each `openssl rand -hex 32`), and `TOKEN_ENCRYPTION_KEY`
   (`openssl rand -base64 32`).
2. Fill in: `DEPLOY_ENV`, `APP_DOMAIN`, `API_DOMAIN`, `ACME_EMAIL`, `IMAGE_REGISTRY`,
   `IAM_BASE_URL`, `LLM_PROVIDER` + `LLM_MODEL` + its API key (or `LLM_PROVIDER=rules`).
3. For launch: `PRIVACY_OPERATOR_NAME`, `PRIVACY_CONTACT_EMAIL`, the notification service
   (`NOTIFICATION_SERVICE_URL`, `NOTIFICATION_API_KEY`, `NOTIFICATION_TOKEN_SECRET`).
4. Run `scripts/deploy/check-env.sh`, deploy, then create the first admin at
   `https://APP_DOMAIN/setup` with the token from the api log (`docs/ADMIN.md`).
5. Later, as accounts are approved: payments (section 9), affiliates and marketplaces (section 8).

## Per-integration setup guides

How to obtain, configure and verify each external service (AI model, IAM, e-mail, web push,
payments, marketplaces/affiliates, file uploads): [`integrations/README.md`](integrations/README.md).
