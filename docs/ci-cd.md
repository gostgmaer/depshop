# CI/CD

GitHub Actions in `.github/workflows/`. Third-party actions are pinned to full commit SHAs (the tag is in a comment). Tools run from version-pinned images: Trivy, gitleaks, actionlint and ShellCheck.

## Continuous integration: `ci.yml`

Runs on every pull request and every push to `main`. It never deploys.

| Job             | What it runs                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **node**        | `pnpm install --frozen-lockfile`, `uv sync --frozen`, `pnpm format:check` (Prettier), `prisma validate`, `pnpm check`. The last one is typecheck, ESLint, unit tests and production builds for every package, and also covers the Python agent: `ruff check`, `ruff format --check`, `mypy`, `pytest`.                                                                                                  |
| **integration** | Real PostgreSQL 17 (pgvector) and Redis 7.4 service containers: `prisma migrate deploy` on an empty database, the **migration drift check** (`prisma migrate diff … --exit-code`), `roles.sql` applies, then the DB package, API and worker integration suites. Those suites cover auth/authz, cross-user isolation, security, billing webhooks, queues, tracking, alerts, notifications and retention. |
| **e2e**         | Production web build, then Playwright (desktop and mobile) with axe accessibility checks, against the e2e mock API.                                                                                                                                                                                                                                                                                     |
| **security**    | `pnpm audit --prod` (fails on **critical**; known highs are tracked in `docs/SECURITY_AUDIT.md`), `pip-audit` on the locked production Python set, gitleaks over the full git history.                                                                                                                                                                                                                  |
| **images**      | Builds all five production images (api, worker, migrate, web, agent) with a GitHub Actions layer cache. Asserts each runs as non-root. Trivy fails on fixable **critical** vulnerabilities.                                                                                                                                                                                                             |
| **lint-ops**    | actionlint (workflows), ShellCheck (`scripts/`, configured by `.shellcheckrc`), and a `docker compose config` render of the production stack with the template environment.                                                                                                                                                                                                                             |

The agent workflow tests use a mocked LLM (`tests/fakes.py`), and the connector tests use mocked marketplace responses. CI never calls live marketplaces or LLM providers.

**To run the same checks locally:**

```sh
pnpm install --frozen-lockfile && (cd apps/agent && uv sync --frozen)
pnpm format:check && pnpm check                      # everything in the "node" job
pnpm infra:up                                        # local Postgres + Redis
pnpm --filter @dealmind/db test:db && pnpm --filter @dealmind/api test:db && pnpm --filter @dealmind/worker test:db
pnpm --filter @dealmind/web exec playwright test     # after: pnpm turbo run build --filter=@dealmind/web...
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:v0.10.0 -x scripts/*/*.sh
```

**Load tests:** these need Docker for k6, and are not part of CI because they take minutes and need a quiet machine.

```sh
pnpm --filter @dealmind/api test:load      # k6: signed-in read mix + catalog/search mix
pnpm --filter @dealmind/worker test:load   # BullMQ: price refresh + alert evaluation throughput
pnpm --filter @dealmind/worker build && pnpm --filter @dealmind/api test:journey   # full-stack journey (real API + worker + agent processes)
```

## Continuous deployment: `release.yml` and `deploy-env.yml`

```
tag v1.2.3 pushed (or manual dispatch of a ref on main)
  └─ resolve   commit must be on main; production requires a v* tag
  └─ ci        the full CI above, on the release commit
  └─ publish   build + push ghcr.io/<owner>/dealmind-{api,worker,migrate,web,agent}
               tags: sha-<12 chars> (immutable) and v1.2.3; SBOM + provenance attestations
  └─ staging   deploy-env.yml → SSH → scripts/deploy/deploy.sh sha-…    (environment "staging")
  └─ production  same, after staging succeeded, in environment "production"
                 (protected: configure Required reviewers so a person approves)
```

- **Pull requests never deploy.** Only commits already on `main` can be released, and production only from a `v*` tag.
- **Deployment runs `scripts/deploy/deploy.sh` on the host,** the same script a person runs:
  1. environment validation;
  2. pre-migration backup;
  3. the controlled migration job;
  4. database roles;
  5. rollout;
  6. health gates;
  7. smoke tests;
  8. automatic application rollback on failure.

  The job succeeds only if all of that passes.

- **Concurrency:** one release at a time, and one deployment per environment.
- **Secrets:** no application secret passes through CI. Each environment holds only SSH material:

  | Setting                                                                               | Type      |
  | ------------------------------------------------------------------------------------- | --------- |
  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY` (private key)                  | secrets   |
  | `DEPLOY_SSH_KNOWN_HOSTS` (the host's pinned key; host-key checking is never disabled) | secret    |
  | `DEPLOY_DIR`, `APP_URL`                                                               | variables |

  The server pulls images with its own read-only registry login.

### One-time GitHub setup

1. **Settings → Environments:** create `staging` and `production`. In `production`, add **Required reviewers** and restrict deployments to tags `v*`.
2. Add the secrets and variables above to each environment. The SSH key should belong to a deploy-only user on that host.
3. **Settings → Actions → General:** Workflow permissions "Read repository contents".
4. **Branch protection on `main`:** require the CI checks to pass, and require a review.
5. **Packages:** after the first publish, keep the `dealmind-*` packages private, and allow the server's read-only token to pull them.

### Releasing

```sh
git tag -a v1.2.3 -m "v1.2.3" && git push origin v1.2.3     # → staging, then production after approval
```

To rehearse a commit on staging without a tag, use **Actions → Release → Run workflow** with `ref=<sha>` and leave "production" unticked.
