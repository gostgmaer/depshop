# Marketplaces and affiliate programs

Two separate things, often confused:

|                             | What it does                                                     | Credentials                 |
| --------------------------- | ---------------------------------------------------------------- | --------------------------- |
| **Connector** (live search) | Fetches real products and prices from a store's API              | The store's API credentials |
| **Affiliate tag**           | Adds our tracking id to "Buy" links so purchases earn commission | The affiliate tag/id only   |

You can have an affiliate tag without a connector (links tagged, prices from elsewhere), or a
connector without affiliate links. **Affiliate status never changes deal ranking.**

## Status today

| Store            | Connector                                                | Affiliate program                                                      |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Flipkart         | Implemented, **awaiting credentials**; never called live | Flipkart Affiliate (`FLIPKART_AFFILIATE_ID`) not configured            |
| Amazon India     | **Awaiting approval**; no live client yet (Creators API) | Amazon Associates tag not configured                                   |
| Croma, Tata CLiQ | Disabled                                                 | No direct program; only through affiliate networks (separate approval) |
| Reliance Digital | Disabled                                                 | No program found                                                       |
| Mock stores      | Development only, fictional and labelled                 | n/a                                                                    |

All real sources stay **disabled until authorized**. Production forces
`CONNECTORS_ENABLE_MOCKS=false`.

## Deals feed

DealMind loads only **discounted products** (≥ `DEAL_MIN_DISCOUNT_PERCENT`, default 20 %) from each connected store's feed every hour. Flipkart: its category product feeds (the DOTD/offers APIs are banners without prices). Amazon: no client yet. Once a store is ACTIVE with credentials, its deals appear on the home page and `/deals` after the next sync; check the worker log line `deals feed synced` (per store: status and items accepted). See [`../CATALOG.md`](../CATALOG.md) "Deals".

## Settings (api and worker)

| Variable                                       | Where from                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `FLIPKART_AFFILIATE_ID`                        | Flipkart Affiliate programme (approved account)                                   |
| `FLIPKART_AFFILIATE_TOKEN`                     | Same; enables live search and the earnings-report import                          |
| `AMAZON_ASSOCIATES_PARTNER_TAG`                | Amazon Associates India (tag like `name-21`)                                      |
| `AMAZON_CREATORS_CREDENTIAL_ID` / `..._SECRET` | Amazon Creators API (OAuth2 client credentials) on an approved Associates account |

## Where to see it

- **Admin → Affiliates** (`/admin/affiliates`): each program, "Links active/inactive", why
  (e.g. "No Flipkart affiliate id configured"), clicks and partner-reported commission.
- **Admin → Connectors** (`/admin/sources`): each store's status (`PENDING_CREDENTIALS`,
  `ACTIVE`, `DISABLED`), last health check, and **Run health check**.

## Connect Flipkart (example)

1. Get approved by the Flipkart Affiliate programme; copy the affiliate id and token.
2. Add `FLIPKART_AFFILIATE_ID` and `FLIPKART_AFFILIATE_TOKEN` to the environment; recreate
   api + worker.
3. **Affiliate links:** Admin → Affiliates → Flipkart → **Enable**. The badge turns
   "Links active". Check a Flipkart Buy link carries the tag.
4. **Live search (separately):** run the live verification first:
   ```
   pnpm --filter @dealmind/connectors build && pnpm --filter @dealmind/connectors verify:flipkart
   ```
   Only if it passes, set the Flipkart source to **ACTIVE** in Admin → Connectors and run a
   health check.

Amazon follows the same steps for the tag (`AMAZON_ASSOCIATES_PARTNER_TAG`); live Amazon search
needs the connector's network client to be built and verified first.

## Turn it off

- Links: Admin → Affiliates → **Disable** (links go out untagged immediately).
- Search: Admin → Connectors → set the source to **DISABLED**.
- Credential leaked: revoke at the partner, replace the variable, recreate api + worker.

More: [`../AFFILIATE.md`](../AFFILIATE.md), [`../CONNECTORS.md`](../CONNECTORS.md),
[`../marketplace-reliability.md`](../marketplace-reliability.md).
