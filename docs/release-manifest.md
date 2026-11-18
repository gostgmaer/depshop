# Release manifest

One manifest per production release. Fill it from the **Release** workflow run that deployed to staging, and deploy those exact image tags to production. Never deploy a locally built image or a mutable tag.

## Current candidate: **NOT RELEASED**

No release has been tagged, published or deployed. The table records what the first release candidate will contain once the Prompt 23 fixes are committed and CI is green.

| Field                     | Value                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application version       | `v0.1.0` (proposed; no tag exists)                                                                                                                                 |
| Git commit                | _pending: the commit containing the Prompt 23 fixes on top of `b5e429e`_                                                                                           |
| Environment               | production (blocked; see [production-go-live.md](production-go-live.md))                                                                                           |
| Release timestamp         | — (not deployed)                                                                                                                                                   |
| Image registry            | `ghcr.io/<owner>/` (no package published yet)                                                                                                                      |
| Images (immutable)        | `dealmind-api:sha-<12>`, `dealmind-worker:sha-<12>`, `dealmind-migrate:sha-<12>`, `dealmind-web:sha-<12>`, `dealmind-agent:sha-<12>`, all from the **same commit** |
| Digests                   | _record `docker buildx imagetools inspect` output after publish_                                                                                                   |
| Database migration head   | `20261125100000_security_hardening` (17 migrations)                                                                                                                |
| Rollback image references | **None.** This is the first release; rollback means taking the service down, not reverting.                                                                        |
| Previous release          | none                                                                                                                                                               |

### Included components

| Component                  | Source                                                   | Runtime                                     |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Web (Next.js 15)           | `apps/web`                                               | Node 22, `node.Dockerfile`/`web.Dockerfile` |
| API (Fastify 5)            | `apps/api`                                               | Node 22                                     |
| Worker (BullMQ)            | `apps/worker`                                            | Node 22                                     |
| Migrate job                | `packages/db` (`prisma migrate deploy` + reference seed) | Node 22, run once per release               |
| Agent (FastAPI, LangGraph) | `apps/agent`                                             | Python 3.12, `uv` lockfile                  |
| Data stores                | PostgreSQL 17 + pgvector, Redis 7.4                      | Official images, pinned by digest           |
| Edge                       | Traefik v3.6.25                                          | Pinned                                      |

**Compatibility:**

- Web, API, worker and migrate are built from one commit and share `@dealmind/shared` contracts at that commit.
- The agent talks to the API's `/internal/v1` contract from the same commit.
- Deploying mixed commits is not supported; `deploy.sh` uses one `IMAGE_TAG` for every service.

### Configuration changes in this release (vs. the template in the repository)

- **New:** `.env.production.example` is now in the repository. It existed only locally before (D23-1).
- **Changed:** comments moved off empty values (D23-2). Behaviour is unchanged for filled values.
- **Redis:** the ACL include replaces `rename-command` (Prompt 22, P22-1). No data migration is needed.

### Known limitations at release

- No marketplace is live; every real source is `PENDING_APPROVAL` or `PENDING_CREDENTIALS`. Search reports that honestly.
- Payments are in sandbox or disabled until Razorpay is activated in the payment service.
- E-mail and push delivery are unverified until the notification service and VAPID keys are configured.
- No error tracking (Sentry) and no tracing exporter.
- Genuine-discount answers need accumulated price history; early queries will often say so.

## Template for each release

```
Version:            vX.Y.Z
Commit:             <40-char sha>
Release run:        <Actions run URL>
Deployed at (UTC):  <timestamp from releases/history.log>
Images:             api/worker/migrate/web/agent @ sha-<12>  (digests: …)
Migration head:     <name>   New migrations: <list, each marked additive | destructive>
Config changes:     <variables added/changed/removed>
Known limitations:  <list>
Rollback target:    sha-<12> of the previous release (images still in the registry: yes/no)
Rollback safe?:     yes / only with ALLOW_NEWER_SCHEMA=1 (reason) / no (restore required)
Smoke tests:        public N/N, internal N/N, signed-in N/N
Approved by:        <owner>, <GitHub environment approval link>
```

## How to find the deployed values on the host

```sh
cat releases/current releases/previous          # tags
tail -5 releases/history.log                    # timestamps and results
scripts/deploy/compose.sh images                # image refs actually running
scripts/deploy/compose.sh run --rm migrate npx prisma migrate status   # migration state
```
