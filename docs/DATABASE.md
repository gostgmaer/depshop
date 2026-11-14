# Database

PostgreSQL 17 via Prisma 6. Schema: `packages/db/prisma/schema.prisma`.

DealMind is **single-platform, multi-user**. There are no Tenant, Organization
or Membership models and no `tenantId` / `organizationId` / `membershipId`
columns. A DB test (`schema.db.test.ts`) fails if any such table or column
appears.

## Models

| Domain        | Model                                             | Ownership                                                   |
| ------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Identity      | `User`                                            | the account itself                                          |
|               | `UserPreference`                                  | user (1:1)                                                  |
|               | `UserSession`                                     | user (DealMind browser sessions; hold encrypted IAM tokens) |
| Catalog       | `Category`, `Product`, `ProductVariant`           | **global**                                                  |
| Shopping      | `ShoppingSource`, `ProductOffer`, `PriceSnapshot` | **global**                                                  |
| Search        | `Search`, `SearchResult`                          | user                                                        |
|               | `SearchSourceRun` (per-source outcome)            | user                                                        |
| User features | `Watchlist`, `WatchlistItem`, `PriceAlert`        | user                                                        |
|               | `Notification`, `NotificationDelivery`            | user                                                        |
| AI            | `AgentRun`                                        | user                                                        |
|               | `AiModelConfig`                                   | global (admin)                                              |
| Monetization  | `Subscription`, `UsageRecord`, `BillingEvent`     | user                                                        |
|               | `AffiliateClick`                                  | user, nullable (anonymous clicks)                           |
|               | `SubscriptionPlan`, `AffiliateConversion`         | global (admin reporting)                                    |
| Platform      | `PlatformSetting`, `AuditLog`                     | global (admin)                                              |

`SearchSourceRun`, `SubscriptionPlan`, `AffiliateConversion`, `AiModelConfig`,
`PlatformSetting` and `AuditLog` go beyond the minimum model list. They back
master-spec requirements: per-source error reporting, plan catalogue,
commission reporting, AI model configuration, platform configuration and
admin auditability.

## Identity mirror

`User` is a local mirror of an identity owned by the shared EasyDev IAM
(see [SHARED_SERVICES.md](SHARED_SERVICES.md)). `iamUserId` (unique) links it
to the IAM user; DealMind stores no passwords or verification/reset tokens.
Name and email are synced at sign-in; `role` and `status` are DealMind's own.

## Conventions

- **IDs:** native `uuid`, generated as **UUIDv7** (time-ordered, so B-tree
  inserts stay local). Natural keys only for `SubscriptionPlan.code` and
  `PlatformSetting.key`.
- **Money:** integer **paise**. `Int` per item (max about ₹2.1 crore); `BigInt`
  for affiliate aggregates. No floats. All `*Paise` columns are non-negative
  (CHECK).
- **JSON:** `jsonb` only. Structured blobs (`specs`, `attributes`, `limits`)
  must be JSON objects (CHECK).
- **Emails:** stored lower-case (CHECK), so the unique index is
  case-insensitive. Normalise with `emailSchema` from `@dealmind/shared`.

## Ownership enforcement (three layers)

1. **Every user-owned table has `userId uuid NOT NULL` with a FK to
   `User(id)`.** This is verified generically against `pg_constraint` in
   `schema.db.test.ts`.
2. **Composite ownership foreign keys.** A child of a user-owned parent
   references it with `(parentId, userId) → parent(id, userId)`:

   | Child                                         | Parent         |
   | --------------------------------------------- | -------------- |
   | `WatchlistItem`                               | `Watchlist`    |
   | `SearchResult`, `SearchSourceRun`, `AgentRun` | `Search`       |
   | `NotificationDelivery`                        | `Notification` |

   PostgreSQL therefore rejects attaching a row to another user's parent
   (Prisma `P2003`), even if application code is buggy.

3. **Application rules** (`packages/db/src/ownership.ts`):
   - take `userId` only from the authenticated principal;
   - scope every query with `ownedBy(userId)`;
   - `assertOwnedBy()` and the API error handler report foreign records as
     **404 Not Found**, never 403, so existence is not leaked.

## Deletion semantics

| Action                                                 | Effect                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Delete a user                                          | Cascades to all their private data; global catalog untouched; `AffiliateClick.userId` set to NULL (revenue reporting survives) |
| …who has `BillingEvent`s                               | **Blocked** (Restrict). Financial records are retained, so such users are suspended/anonymised instead                         |
| Delete a `Search`                                      | Cascades to its results, source runs and agent runs                                                                            |
| Delete a `ProductVariant` that users watch or alert on | **Blocked**. Catalog merges must re-point user rows, never drop them silently                                                  |
| Delete a `ShoppingSource` that has offers              | **Blocked**                                                                                                                    |

## Constraints beyond Prisma

`prisma/migrations/*_constraints/migration.sql` adds CHECK constraints
(non-negative money, positive alert targets and usage, rank ≥ 1, `http(s)`-only
offer URLs, `sentAt` required for SENT deliveries, `finishedAt` required for
finished agent runs, source tuning bounds, and more). It also recreates the
`PriceAlert (userId, variantId, sourceId)` unique index with
`NULLS NOT DISTINCT`, so one "any source" alert per user and variant is
enforced too. Each constraint has a test in `constraints.db.test.ts`.

## Migrations

| Migration                        | Purpose                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20261114100000_extensions`      | `pg_trgm`; `vector` when available                                                                                                                                                                                                                                 |
| `20261114100100_init`            | All tables, indexes, FKs (generated by Prisma)                                                                                                                                                                                                                     |
| `20261114100200_constraints`     | CHECK constraints, `NULLS NOT DISTINCT` alert uniqueness                                                                                                                                                                                                           |
| `20261114200000_auth_tokens`     | (Phase 1.4) `AuthToken`, `UserSession.lastUsedAt`                                                                                                                                                                                                                  |
| `20261114300000_iam_integration` | Identity moves to the shared IAM: drops `User.passwordHash` and `AuthToken`; adds `User.iamUserId` and encrypted IAM token columns on `UserSession`. **Refuses to run if pre-IAM users exist** (they can't be linked automatically); deletes pre-existing sessions |

**Drift check.** The migrations must replay to exactly the Prisma schema:

```bash
cd packages/db
pnpm exec dotenv -e ../../.env -- prisma migrate diff \
  --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://…@127.0.0.1:<port>/dealmind_shadow" --script
# expected output: "-- This is an empty migration."
```

The baseline was rebuilt in this phase (CUID → UUID, renamed `Session`). It had
never been deployed; only the local dev DB had applied the old migrations.

## Seed data

`pnpm db:seed` (idempotent, `src/seed-data.ts`): 3 subscription plans, 5
shopping sources (**all disabled** until real credentials exist), and a
2-level category tree (15 categories). Re-seeding never overwrites admin edits.
**Products, offers, prices and users are never seeded**: catalog and price data
may only come from authorized sources.

## Tests

```bash
pnpm test                       # unit tests (no DB) — part of `pnpm check`
pnpm test:db                    # DB integration tests (requires `pnpm infra:up`)
```

DB tests run against `<DATABASE_URL db>_test` (or `TEST_DATABASE_URL`). The
global setup creates it if missing, wipes its `public` schema and applies all
migrations with `prisma migrate deploy`. It **refuses to run** unless the
database name ends in `_test` and the host is local.

| File                     | Covers                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.db.test.ts`      | no tenant artefacts; exact table set; userId FK on every user-owned table; composite FKs; uuid PKs; UUIDv7; integer money; jsonb; extensions + trigram index |
| `ownership.db.test.ts`   | cross-user writes rejected for every composite FK; owner-scoped queries; cascades, SetNull, Restrict                                                         |
| `constraints.db.test.ts` | every CHECK; unique constraints incl. NULL-source alerts, idempotent billing events, BigInt aggregates                                                       |
| `seed.db.test.ts`        | seed contents, idempotency, admin edits preserved, nothing fabricated                                                                                        |
