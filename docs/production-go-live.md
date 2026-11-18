# Production go-live

**Status on 2026-11-18: LAUNCH BLOCKED.** Nothing has been deployed to production. No production deployment was attempted, and no authorization was requested, because critical pre-launch gates fail (below).

This document is the procedure the owner follows once those gates pass. Related:

- [release-manifest.md](release-manifest.md): what is released;
- [production-smoke-tests.md](production-smoke-tests.md): how to verify it;
- [rollback-runbook.md](rollback-runbook.md): how to undo it;
- [production-operations-handbook.md](production-operations-handbook.md): how to run it afterwards.

## 1. Pre-launch gate (Prompt 23 §1), checked 2026-11-18

| #   | Gate                                | Result                          | Evidence                                                                                                                                                                                |
| --- | ----------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Latest readiness report reviewed    | ✅                              | [launch-readiness-report.md](launch-readiness-report.md): **READY FOR STAGING ONLY**.                                                                                                   |
| 2   | Repository state                    | ❌ **fails**                    | `main` = `b5e429e`. **CI on GitHub is red** for the last two pushes (4 of 6 jobs). The causes are fixed in the working tree but **not committed**; see §2. No tag and no release exist. |
| 3   | No open P0/P1 defects               | ⚠️                              | No open P0. Prompt 22's P1s are fixed. The CI-found P1 (§2, D23-1) is fixed locally but unreleased.                                                                                     |
| 4   | Staging release passed              | ❌ **fails**                    | **No staging environment exists.** Only a local simulation using production images (Prompt 22).                                                                                         |
| 5   | Production infrastructure available | ❌ **fails**                    | No server, no domain or DNS, no GitHub `staging`/`production` environments, no deploy secrets, no registry packages.                                                                    |
| 6   | Production secrets configured       | ❌ **fails**                    | No `.env.production` on any host. The shared IAM, payment, notification and LLM credentials don't exist yet.                                                                            |
| 7   | Backups and restore tested          | ⚠️ local only                   | Backup, restore test and the full disaster-recovery drill passed locally. Never run on a server, with no off-host copy and no encryption key.                                           |
| 8   | Monitoring and alerting configured  | ❌ **fails**                    | The overlay works in rehearsal, but **no alert receiver exists** and nothing runs on a server.                                                                                          |
| 9   | Rollback documented                 | ✅                              | [rollback-runbook.md](rollback-runbook.md). `rollback.sh` was exercised in the rehearsals.                                                                                              |
| 10  | External approvals understood       | ✅ understood / ⛔ none granted | Every marketplace is `PENDING_APPROVAL` or `PENDING_CREDENTIALS`; Razorpay is not activated; the e-mail sender domain is not verified.                                                  |

**Decision: stop.** Gates 2, 4, 5, 6 and 8 are critical failures. Gates 4–6 can't be closed from this repository: they need infrastructure and accounts that only the owner can provide.

## 2. Defects found by this phase's gate

CI had never passed on GitHub. That's how these were found:

| ID    | Sev.   | Defect                                                                                                                                                                                                                                                                                                                                                                                      | Status                                                                                                                                                                                                                                         |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D23-1 | **P1** | `infrastructure/docker/production/.env.production.example` was **never committed**: `.gitignore` matched it through `.env.*`. A fresh clone, CI, or a new server had no production template. CI's compose-config job failed on it.                                                                                                                                                          | Fixed: `.gitignore` exception. Template verified with the CI step, `actionlint`, `shellcheck` and a gitleaks scan.                                                                                                                             |
| D23-2 | P2     | 13 template lines were `VAR=   # comment`. Docker Compose reads an empty value followed by a comment as **the comment text**. `check-env.sh` strips comments and blocks the deploy, but the rendered config would carry the comment as a value.                                                                                                                                             | Fixed: comments moved above the variables. `compose config` now renders `""` or the real value.                                                                                                                                                |
| D23-3 | P2     | **Pages scroll sideways on Linux, Android and other systems with wide default fonts**: `/admin/jobs` on mobile (+27 px) and the product page on desktop (+51 px). Root cause: `sr-only` labels (`position: absolute`) inside horizontally scrolling tables escape the scroll clip, because the wrapper wasn't a containing block. Windows fonts hid it; CI (Ubuntu, DejaVu Sans) caught it. | Fixed: all 7 horizontal scroll wrappers are now `relative`. Reproduced in Linux with DejaVu Sans, root cause found by DOM bisection. After the fix, the full Playwright suite passes 34/34 in the same Linux + DejaVu setup (2 failed before). |
| D23-4 | P2     | `apps/api` typecheck failed in CI (TS2742) because the test harness's inferred return types depended on pnpm's hoisting layout.                                                                                                                                                                                                                                                             | Fixed: explicit `LightMyRequestResponse` return types. A **fresh Linux install** passes Prettier and all 49 typecheck, lint, test and build tasks.                                                                                             |
| D23-5 | P3     | gitleaks (full history) reported 6 findings. All were reviewed as false positives: variable names, the public Web Push sample vector from RFC 8291, and an empty template line.                                                                                                                                                                                                             | `.gitleaksignore` lists their fingerprints with the reasons. Any new finding still fails CI.                                                                                                                                                   |

**To clear gate 2:** commit these fixes, push, and confirm that **all six CI jobs pass on GitHub**, including the image build and Trivy scan, which have never run there.

## 3. What the owner must provide before the next attempt

1. **Hosts:** a staging host and a production host (Linux, Docker Engine ≥ 27 with Compose v2, at least 4 vCPU / 8 GB / 80 GB SSD for production at launch scale; see [production-cost-estimate.md](production-cost-estimate.md)). Two domains each (app and API). Follow [production-deployment.md](production-deployment.md) §2.
2. **GitHub:**
   - the `staging` and `production` environments, with required reviewers on `production`;
   - deploy SSH secrets;
   - branch protection on `main`;
   - a read-only registry token on each host;
   - a decision about the **public** repository: images publish to GHCR, so keep the `dealmind-*` packages private.
3. **Shared EasyDev services in production:**
   - IAM, with DealMind registered;
   - the notification service, with the sender domain verified;
   - the payment service, with Razorpay **test mode** on staging first.
4. **An LLM account with a spend cap**, and `LLM_MODEL`.
5. **An alert receiver:** a webhook that a person actually watches.
6. **Privacy details:** operator name and contact, plus a legal review.
7. **Off-host backup storage**, and an `age` key pair whose private half is kept off the server.

## 4. Go-live procedure (after every gate passes)

**Explicit written authorization from the application owner is required** at step 4 below. Without it, stop after staging.

1. **Release candidate.** Tag `vX.Y.Z-rc.N` on a green `main`, then run **Release** with production unticked. CI and publish run, then the staging deploy.
2. **Staging verification:**
   1. Run [production-smoke-tests.md](production-smoke-tests.md) in full, including the signed-in flow and the manual checks.
   2. Run a restore test on the staging host.
   3. Test the alert path: stop the worker for 6 minutes and expect `QueueWithoutWorkers` at the receiver.
   4. Complete a Razorpay **test-mode** checkout, cancellation and failed payment.
   5. Deliver one e-mail.
3. **Prepare the release manifest.** Fill [release-manifest.md](release-manifest.md) with the immutable `sha-…` tags that staging verified. Those exact images go to production; nothing is rebuilt.
4. **Owner authorization.** The owner approves the `production` environment deployment in GitHub. That approval is the authorization.
5. **Deploy.** `deploy.sh` runs, in order:
   1. env validation;
   2. pull;
   3. pre-migration backup;
   4. `prisma migrate deploy`;
   5. database roles;
   6. rollout, with each service healthy before the next: agent → api → worker → web → Traefik;
   7. smoke tests.

   It rolls the application back automatically on failure.

6. **Staged exposure.** This architecture has no traffic-percentage or canary routing: one host, one replica per service. Exposure is controlled by **who knows the URL and who can sign in**, not by traffic shifting:

   | Stage                    | How                                                             | Exit criteria (watch for ≥ the time shown)                |
   | ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
   | 1. Internal ADMIN        | Production up, DNS live, not announced; only the owner signs in | Smoke tests green; admin views correct; no alerts for 2 h |
   | 2. Restricted test users | Invite named testers (accounts in the shared IAM)               | No SEV-1/2; search completion > 80 %; 24 h                |
   | 3. Limited availability  | Open sign-up, announce to a small audience                      | p95 < 1 s, 5xx < 1 %, queue healthy; 72 h                 |
   | 4. Broader availability  | Wider announcement                                              | Capacity headroom > 40 % CPU/memory; 1 week               |
   | 5. Full launch           | —                                                               | —                                                         |

   To pause expansion: stop inviting and announcing. To restrict exposure, disable new sign-ups at the IAM, or take the site down with `compose.sh stop web` (API kept for maintenance). **Do not claim canary capability that doesn't exist.**

7. **Launch watch.** Use [production-operations-handbook.md](production-operations-handbook.md) §Launch window: check the monitored signals hourly for the first 24 h. SEV-1 or SEV-2 pauses expansion and starts [incident-response.md](incident-response.md).

## 5. Integrations: activation gates (independent of the launch)

**Marketplaces.** Activate one at a time, only when all of these hold:

- credentials are issued by the programme;
- the programme's terms have been read: usage limits, attribution and caching rules;
- the connector's readiness is `READY`;
- a staging search returns real offers that match the marketplace's own page.

Enable the source in Admin → Sources; enabling is refused unless the connector is `READY`. Every unauthorized source stays disabled, and search reports it as skipped.

**Payments.** Before setting `BILLING_PROVIDER=payment-service` in production, verify on staging in Razorpay test mode:

- webhook signature rejection;
- duplicate-event idempotency;
- subscribe, renew and cancel;
- a failed payment, including the grace period;
- a refund;
- reconciliation.

The DB suites cover these with a sandbox provider; they have never been run against the real payment service. **No real payment is made in smoke tests.**

**Affiliate.** Production affiliate tags are used only after programme approval. Disclosure (`rel="sponsored"`, visible note) is already on every outbound link. Commissions are recorded only from partner reports. Ranking has no affiliate input (Prompt 22 code audit; `ranking.test.ts`).
