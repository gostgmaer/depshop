# DealMind AI — Architecture

## Shape

A **single-platform, multi-user** modular monolith. One application, one
database, one global product catalog, one shopping-source registry, many
independent user accounts. There are deliberately **no** tenants,
organizations, memberships or workspace switching.

```
apps/
  api/    Fastify 5 HTTP API (modules: auth, users, admin, health, …)
  web/    Next.js App Router frontend
packages/
  shared/ Pure TS: money (paise), errors, Zod schemas, plan catalogue
  db/     Prisma schema, migrations, client factory, seed
```

Dependencies only point downward: `apps/* → packages/db → packages/shared`.

## Data ownership

| Global (shared by everyone)                      | User-owned (every row has `userId` FK)                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| Category, Product, ProductVariant                | UserSession, UserPreference                             |
| ShoppingSource, ProductOffer, PriceSnapshot      | Search → SearchSourceRun, SearchResult, AgentRun        |
| SubscriptionPlan, AiModelConfig, PlatformSetting | Watchlist → WatchlistItem, PriceAlert                   |
| AffiliateConversion, AuditLog (admin reporting)  | Notification → NotificationDelivery                     |
|                                                  | Subscription, UsageRecord, BillingEvent, AffiliateClick |

**Ownership rule:** every query on user-owned data filters by the
authenticated `userId` (taken from the verified access token, never from the
request body). The database enforces it too: children reference their parent
through composite `(parentId, userId)` foreign keys, so cross-user attachment
is impossible. Catalog rows are never copied per user; watchlists and alerts
reference shared `ProductVariant`s. Details: [DATABASE.md](DATABASE.md).

## Money

All amounts are **integer paise** (`Int` per item, `BigInt` for aggregates
like affiliate order totals). Discounts are integer **basis points**, rounded
down so a discount is never overstated. Use `@dealmind/shared` helpers;
floats appear only at display time in `formatPaise`.

## Auth

- Argon2id password hashing.
- Short-lived HS256 access JWT (`sub`, `role`, `iss`, `aud`, `typ`).
- Opaque 256-bit refresh tokens; only SHA-256 hashes are stored. Each refresh
  rotates the token; replaying a rotated token revokes the entire token family.
- `app.authenticate` / `app.requireRole("ADMIN")` pre-handlers; handlers call
  `requireAuth(req)` to obtain the principal.

## Errors

Every error response has the shape
`{ "error": { "code", "message", "details?", "requestId" } }`.
Throw `AppError` (from `@dealmind/shared`) for expected failures; Zod and
Prisma errors are mapped centrally; anything else becomes a logged 500 with no
internal detail leaked.

## Shopping sources (policy)

Connectors may only use **authorized** access: official APIs, affiliate feeds,
partner integrations or permitted discovery. Sources are seeded **disabled**
and are enabled by an admin only once real credentials exist. Mock/fixture
connectors (for tests) must be clearly labelled and can never be enabled in
production. Credentials are never invented.

## AI boundary

LLMs (via LangGraph.js, Phase 5) handle intent extraction, planning, source
selection, orchestration and explanation. **Deterministic code** owns product
validation, variant matching, price/discount calculation, hard filters,
ranking, price history and alert evaluation. LLM output can never introduce a
price, URL, specification or availability value; those come only from
connector data. Affiliate status never affects ranking.
