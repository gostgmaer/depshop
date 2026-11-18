# Production deployment

DealMind AI runs as one Docker Compose stack per environment on a single Linux
host (any provider: Hetzner, Contabo, AWS EC2, …). It is a single-platform,
multi-user service: one database, one Redis, no tenants. No Kubernetes.

Related: [ci-cd.md](ci-cd.md) · [backup-and-recovery.md](backup-and-recovery.md) ·
[monitoring-and-alerting.md](monitoring-and-alerting.md) ·
[incident-response.md](incident-response.md) ·
[production-launch-checklist.md](production-launch-checklist.md).

## 1. Topology

```
Internet ──80/443──▶ Traefik (TLS, Let's Encrypt, HSTS, edge rate limit)
                       │  edge network (dealmind-edge)
                       ├── https://APP_DOMAIN        → web  (Next.js)
                       ├── https://APP_DOMAIN/api/*  → api  (same origin: first-party cookies)
                       └── https://API_DOMAIN        → api  (/api/*, /health/live, signed payment webhook)
                     backend network (internal: NO internet)
                       api · worker · agent · postgres · redis
                     egress network: api, worker, agent → IAM, payments, e-mail, marketplaces, LLM, web push
                     socket network: Traefik → docker-socket-proxy (read-only container discovery)
```

- **Published ports:** only 80 and 443 (Traefik).
- **Never routed publicly:** PostgreSQL, Redis, the agent, `/internal/*`, `/metrics`, `/docs` and `/ready`.
- **Health-based routing:** Traefik only routes to healthy containers. Every image has a Docker `HEALTHCHECK`:
  - API: `/health/live`;
  - web: `/healthz`;
  - agent: `/ready`;
  - worker: a heartbeat file written after each Redis PING.
- **Hardening of the app containers:**
  - non-root users;
  - read-only root filesystems with a small `/tmp` tmpfs;
  - all Linux capabilities dropped and `no-new-privileges`;
  - CPU and memory limits;
  - log rotation;
  - stop grace periods for draining (the worker gets 120 s so BullMQ finishes active jobs).
- **Database roles:**
  - the API and worker connect as `dealmind_app` (DML only);
  - the agent connects as `dealmind_agent` (two read models plus its checkpoint schema);
  - the owner role is used only by the migration job.

Browsers always use `APP_DOMAIN`. The API's `/api` is served on the same origin, so session cookies stay first-party and CSRF origin checks stay strict. `API_DOMAIN` is for API clients, external monitoring, and the payment service's signed webhook (`/webhooks/easydev-payments`).

### Files

| Path                                                            | Purpose                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `infrastructure/docker/production/docker-compose.yml`           | Production/staging stack (one per host).                                                             |
| `infrastructure/docker/production/node.Dockerfile`              | api, worker, migrate images (targets). Production dependencies only, generated Prisma client.        |
| `infrastructure/docker/production/web.Dockerfile`               | Next.js standalone image (runtime configuration; one image for staging and production).              |
| `infrastructure/docker/production/agent.Dockerfile`             | Python agent image (locked production dependencies).                                                 |
| `infrastructure/docker/production/.env.production.example`      | Environment template (placeholders only).                                                            |
| `infrastructure/docker/production/docker-compose.rehearsal.yml` | Local rehearsal override (8080/8443, self-signed certificate). Never used on a server.               |
| `infrastructure/traefik/dynamic/middlewares.yml`                | Security headers/HSTS, edge rate limits, webhook body limit, compression (not for SSE), TLS options. |
| `infrastructure/docker/postgres/roles.sql`                      | Least-privilege roles (idempotent; re-asserts agent schema ownership after restores).                |
| `infrastructure/monitoring/*`                                   | Optional Prometheus/Alertmanager/blackbox/node-exporter overlay.                                     |
| `scripts/deploy/*`                                              | `deploy.sh`, `rollback.sh`, `check-env.sh`, `apply-db-roles.sh`, `compose.sh`.                       |
| `scripts/backup/pg-backup.sh`, `scripts/restore/*`              | Backups, restore and the periodic restore test.                                                      |
| `scripts/smoke-tests/*`                                         | Post-deployment smoke tests (in-network and public).                                                 |

Images are base-pinned by version **and** digest. They contain no package managers at run time, and no secrets: all configuration is injected at run time.

## 2. Server preparation (once per host)

Each environment (staging, production) gets its **own host**: separate database, Redis, credentials, domains and monitoring. Ports 80/443 and the fixed network names allow only one stack per host.

**Size:**

- start with 4 vCPU, 8 GB RAM and 80 GB SSD;
- the limits in the compose file total about 6.5 GB;
- resize from the metrics.

**1. OS and Docker.** Use a current Ubuntu LTS or Debian, and Docker Engine 29 or newer with the Compose plugin:

```sh
curl -fsSL https://get.docker.com | sh          # or your distribution's packages
sudo usermod -aG docker deploy                  # a dedicated deploy user
```

**2. Firewall.** Allow only SSH (ideally restricted to your IPs) plus 80 and 443:

```sh
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

Docker publishes ports through iptables, bypassing ufw. That's why the stack publishes nothing except Traefik's 80/443. Cloud firewalls (security groups) should mirror this.

**3. DNS** (at your DNS provider, before the first deploy):

| Record                               | Type     | Value                       |
| ------------------------------------ | -------- | --------------------------- |
| `APP_DOMAIN` (e.g. `app.example.in`) | A / AAAA | the host's public IP        |
| `API_DOMAIN` (e.g. `api.example.in`) | A / AAAA | the host's public IP        |
| CAA (recommended)                    | CAA      | `0 issue "letsencrypt.org"` |

Let's Encrypt validates over HTTP-01 on port 80, so DNS must resolve before Traefik starts.

**4. Deployment directory:**

```sh
sudo mkdir -p /opt/dealmind /var/backups/dealmind && sudo chown deploy: /opt/dealmind /var/backups/dealmind
```

**5. Registry access.** Log in once with a **read-only** token (GHCR: a fine-grained PAT with `read:packages`):

```sh
echo "$TOKEN" | docker login ghcr.io -u <user> --password-stdin
```

CI never sends registry or application secrets to the server.

**6. Environment file:**

```sh
cp infrastructure/docker/production/.env.production.example /opt/dealmind/.env.production
chmod 600 /opt/dealmind/.env.production       # then fill every value (openssl rand -hex 32)
```

- Staging uses its own file: different secrets, `DEPLOY_ENV=staging`, staging domains, and the payment provider in **test mode**.
- Never copy production secrets to staging or development.

**7. Optional tools:**

- `age` encrypts backups (`apt install age`).
- `rclone` (or similar) gives off-host backup copies.

## 3. Secrets and configuration

- **Where secrets live:** only in `/opt/dealmind/.env.production` (mode 600) or your platform's secret manager rendering that file.
  - They are passed to each container as environment variables, each service getting only what it needs.
  - None are in images, the repository, or CI logs.
- **Validation:**
  - `scripts/deploy/check-env.sh` runs before every deployment. It checks required variables, minimum lengths, that no placeholders remain, that secrets are distinct and URL-safe, and the LLM provider. Production additionally requires the privacy contact.
  - Each service then validates its own environment at start-up (Zod / pydantic) and refuses to start on bad values.
  - Empty optional variables are treated as unset.
- **Logs** redact cookies, authorization headers, tokens and passwords. Request URLs are logged without query strings, and Traefik access logs drop headers and the request path.
- **Rotation:** see [incident-response.md](incident-response.md#secret-rotation).

## 4. First deployment

1. Push a release (see [ci-cd.md](ci-cd.md)); CI publishes the images and deploys to staging.
2. To deploy by hand on the server (the same script CI runs):

   ```sh
   cd /opt/dealmind
   SKIP_BACKUP=1 scripts/deploy/deploy.sh sha-<12-char-commit>   # first deployment only: empty database
   ```

   `deploy.sh` runs these steps:
   1. validates the environment;
   2. pulls the images and starts PostgreSQL and Redis;
   3. backs up the database (skipped only with `SKIP_BACKUP=1`);
   4. runs `prisma migrate deploy` and the reference-data seed as a one-off job (owner role);
   5. applies `roles.sql`;
   6. starts Traefik, the agent, the API, the worker and the web app;
   7. waits for every container to report healthy;
   8. runs the smoke tests;
   9. records the release in `releases/`.

   If the rollout or the smoke tests fail, it restores the previous release's application images automatically.

3. Verify TLS:
   ```sh
   curl -sI https://APP_DOMAIN/login | grep -iE 'strict-transport|content-security'
   ```
   For a new domain, consider a short HSTS max-age first (edit `stsSeconds` in `middlewares.yml`), and raise it once HTTPS is confirmed. Start with `ACME_CA_SERVER` set to the Let's Encrypt **staging** CA on a brand-new host, to avoid rate limits; remove it after the first certificate.
4. Verify backups: run `scripts/backup/pg-backup.sh`, then `scripts/restore/restore-test.sh`. Install the schedule in [backup-and-recovery.md](backup-and-recovery.md).
5. Optionally start monitoring; see [monitoring-and-alerting.md](monitoring-and-alerting.md).

## 5. Routine operations

```sh
scripts/deploy/compose.sh ps                      # status (health per service)
scripts/deploy/compose.sh logs -f --tail=100 api  # logs (JSON)
scripts/deploy/deploy.sh <tag>                    # deploy a release
scripts/deploy/rollback.sh [tag]                  # previous (or given) release; see §6
cat releases/history.log                          # who/what/when (tag, result, commit)
```

Never run `docker compose down -v` or `docker volume rm` on a server: volumes hold the database, Redis and the TLS certificates.

## 6. Rollback

- **Images are kept:** every release's images stay in the registry under their immutable `sha-…` tag (plus the `v…` tag). The host keeps the previously pulled images.
- **What `rollback.sh` does:** it redeploys the previous (or given) release's **application** images, waits for health and runs the smoke tests.
- **The database is never rolled back automatically.** Before switching, `rollback.sh` compares the migrations applied to the database with the migrations the target release contains. If the database is newer, it stops unless `ALLOW_NEWER_SCHEMA=1` confirms that the newer migrations are backward compatible.
- **Migration policy (expand and contract)** makes that normally true:
  - migrations only add tables, columns (nullable or defaulted) and indexes;
  - renames and drops happen in a later release, after no deployed code uses the old shape.
- **When database rollback is unsafe:**
  - a migration that dropped, renamed or rewrote data cannot be undone by redeploying old code;
  - restoring the pre-deploy backup (`releases` + `/var/backups/dealmind/*-pre-<tag>.dump`) loses every write since that backup.

  Treat that as disaster recovery (see [backup-and-recovery.md](backup-and-recovery.md)), not a rollback.

## 7. Local rehearsal (before touching a server)

The production images, compose file and scripts can be exercised on a workstation:

```sh
# build the five images (CI does this in .github/workflows/ci.yml)
docker build -f infrastructure/docker/production/node.Dockerfile --target api     -t local/dealmind-api:r1 .
docker build -f infrastructure/docker/production/node.Dockerfile --target worker  -t local/dealmind-worker:r1 .
docker build -f infrastructure/docker/production/node.Dockerfile --target migrate -t local/dealmind-migrate:r1 .
docker build -f infrastructure/docker/production/web.Dockerfile   -t local/dealmind-web:r1 .
docker build -f infrastructure/docker/production/agent.Dockerfile -t local/dealmind-agent:r1 .

# rehearsal env (IMAGE_REGISTRY=local, *.localhost domains, generated secrets, LLM_PROVIDER=rules)
# and a REHEARSAL_TRAEFIK_DIR containing middlewares.yml + a self-signed cert + a tls file.
COMPOSE_PROJECT=dealmind-rehearsal \
COMPOSE_OVERRIDE=infrastructure/docker/production/docker-compose.rehearsal.yml \
DEPLOY_DIR=$PWD ENV_FILE=/path/rehearsal.env RELEASES_DIR=/path/releases \
REHEARSAL_TRAEFIK_DIR=/path/traefik SKIP_PULL=1 ALLOW_RULES_LLM=1 \
SMOKE_INSECURE=1 SMOKE_RUNNER=edge SMOKE_IGNORE_CHECKS=iam,iamJwks \
scripts/deploy/deploy.sh r1
```

**Never use the project name `dealmind` locally.** The development stack uses it, and a production-stack run under that name would take over its containers and volumes.
