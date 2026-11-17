# Affiliate links and click tracking (Phase 6.2)

**Status:** the affiliate system is built and tested with mock and scripted providers. **No partnership is active.** There is no Amazon Associates tag and no Flipkart affiliate id or token configured, so every outbound link currently goes out **without** an affiliate tag. All marketplace sources are also still disabled until authorized connector credentials exist (Phase 2.3).

**Rules:**

- Destinations are only offers' stored marketplace URLs, never a client value.
- Affiliate tags are added only for programs that are configured and enabled by an admin.
- Money figures are only what partners report; nothing is inferred from clicks.
- Commissions never influence ranking.
- Affiliate data is separate from subscription billing.
- No tenancy.

## Marketplace integration status (verified 2026-11-17)

| Marketplace      | Program (documentation checked)                                                                                                                                                                                                         | DealMind integration                                                                                                                                        | Status                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Amazon India     | Amazon Associates. The store id is the `tag` link parameter; the Creators API (replacing PA-API, deprecated May 2026) adds the partner tag to the links it returns. Reporting API support was only found in non-India Creators API docs | `AmazonAssociatesProvider`: adds `tag` to amazon.in links. Conversions: **manual import** from Associates Central reports (no verified India reporting API) | **Not active:** no `AMAZON_ASSOCIATES_PARTNER_TAG`    |
| Flipkart         | Flipkart Affiliate: `affid` tracking id; `affExtParam1` sub-id; Orders Report API (`/affiliate/report/orders/detail/json`, `Fk-Affiliate-Id`/`Fk-Affiliate-Token`)                                                                      | `FlipkartAffiliateProvider`: `affid` plus the click reference as `affExtParam1`. **Report API import** matches orders back to clicks                        | **Not active:** no `FLIPKART_AFFILIATE_ID` / `_TOKEN` |
| Croma            | No direct program found; listed on affiliate networks (e.g. Cuelinks) that need their own approval                                                                                                                                      | Direct links only (no tag)                                                                                                                                  | No verified program                                   |
| Tata CLiQ        | No direct program found; listed on networks (Cuelinks, EarnKaro; TUNE-run program)                                                                                                                                                      | Direct links only                                                                                                                                           | No verified program                                   |
| Reliance Digital | No verified program found                                                                                                                                                                                                               | Direct links only                                                                                                                                           | No verified program                                   |
| Other networks   | —                                                                                                                                                                                                                                       | The `AffiliateProvider` interface (link builder + host allowlist + status); register an adapter per network once it is approved                             | —                                                     |

Commission rates aren't stored or shown anywhere: published rates come from third-party sites and conflict with each other. DealMind uses only partner-reported commission amounts.

Sources checked: [Creators API docs](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/common-request-headers-and-parameters), [Flipkart Affiliate API overview](https://affiliate.flipkart.com/api-docs/af_overview.html), [Flipkart Report API reference](https://affiliate.flipkart.com/api-docs/af_report_ref.html), [Flipkart affiliate tools](https://affiliate.flipkart.com/tools/affiliate-tools-info), [Cuelinks: Tata CLiQ](https://www.cuelinks.com/campaigns/tata-cliq-affiliate-program), [Cuelinks: Croma](https://www.cuelinks.com/campaigns/croma-retail-affiliate-program).

## How a click works

`GET /api/v1/affiliate/click/:offerId?from=product|search|compare|watchlist|alert`. The web app's "Buy on …" buttons link here.

1. **Validate:** the offer id must be a UUID of an existing offer. The query string is strict, so a `url=` parameter is rejected.
2. **Sample stores** (fictional mock data) are never redirected: 404 "sample store, no real listing".
3. **Destination check** (open-redirect protection): the stored `productUrl` must be https with no credentials in it. Its host must be the source's own domain (or a subdomain of it) **and** on the provider's host allowlist (e.g. `www.amazon.in`, `amazon.in`; `www.flipkart.com`, `flipkart.com`, `dl.flipkart.com`). A failure is recorded as `BLOCKED` and answered with 409, with no redirect.
4. **Provider:** the source's program is used only if an admin enabled affiliate links for it (`affiliateEnabled`) **and** its tracking id is configured. Otherwise the link is unchanged ("direct").
5. **Record:** an `AffiliateClick` row is written, then a 302 redirect follows (`cache-control: no-store`, `referrer-policy: origin`, `x-robots-tag: noindex`).
6. **Dedupe:** a repeat by the same visitor on the same offer within 30 s still redirects but isn't counted again (Redis `SET NX EX`).
7. **Rate limit:** 60 requests per minute.

**What a click records:** click reference, offer, source, product and variant, provider, the tracking id used (non-secret), destination host, redirect status, and the surface it came from. Privacy limits:

- **User id:** only for signed-in users; anonymous visitors stay anonymous.
- **IP address:** stored only as a salted HMAC (the key is derived from the server secret), never raw.
- **User agent:** only the device class ("mobile" or "desktop").
- **Referrer:** only the host (a DB CHECK rejects paths).
- **Retention** (hourly worker cleanup): IP hash, device class and referrer are cleared after **30 days**; clicks without a conversion are deleted after **13 months**.

Users can't read click records; only admins see aggregates.

## Conversions and payouts (partner-reported only)

- **Flipkart:** `POST /api/v1/admin/affiliates/import/flipkart {startDate, endDate}` reads the Orders Report API for each status (approved, pending, tentative, cancelled), paging by `offset`.
  - Rupee amounts are converted to paise **exactly**; a non-exact amount is rejected and reported, never rounded.
  - Status mapping: approved → `APPROVED`; tentative/pending → `PENDING`; cancelled/disapproved/failed → `REVERSED`.
  - `affExtParam1` matches the order to the click.
  - A provider error fails the import (502) with nothing partially written.
- **Manual import:** `POST /api/v1/admin/affiliates/import/manual` takes rows from a partner's report, e.g. Amazon Associates Central. Only sources with a program are accepted.
- **Idempotent:** conversions are unique per (source, partner order id). Re-imports update status and amounts and count changes (created, updated, unchanged, reversed, matched clicks).
- **Payouts:** `POST /api/v1/admin/affiliates/payouts` records a payout as the partner reported it, unique per (provider, reference). `paidAt` is required exactly when the status is PAID (also a DB CHECK).
- **Audit:** every admin action is recorded (`admin.affiliate_source_updated`, `admin.affiliate_conversions_imported`, `admin.affiliate_payout_recorded`) with before and after values. Credentials never appear in responses or the audit log.

## Admin analytics

`GET /api/v1/admin/affiliates?days=30` (ADMIN only; non-admins get 403 before any validation) returns:

- **Clicks:** total, blocked, signed-in, by marketplace, by category, by provider.
- **Conversions by status:**
  - `PENDING` (partner-reported, not yet confirmed: the partner's estimate);
  - `APPROVED` (confirmed);
  - `REVERSED` and `REJECTED`.
- **Payouts by status.**
- **Program status per marketplace:** whether links are active, reporting mode (`api`, `manual` or `none`), and a plain-language note.

The admin dashboard UI is part of Phase 6.3.

## Ranking independence

- **By construction:** the pricing and ranking engines' input types carry no affiliate or commission fields.
- **Tested:** the product pricing, ranking and recommendation response is identical with affiliate links on and off, and no field in it is affiliate- or commission-related.
- **The explanation text** states that commissions are not an input.

## Disclosure

Next to every set of marketplace links (product and compare pages):

> **Affiliate disclosure:** DealMind AI may earn a commission when you buy through some marketplace links. This doesn't affect our rankings or recommendations, or the price you pay.

Buttons read "Buy on ‹marketplace›" with an external-link icon, open in a new tab, use `rel="noopener nofollow sponsored"`, and point to the disclosure via `aria-describedby`. Sample stores show "Sample store — no real listing" instead of a link.

## Data model (`20261123100000_affiliate`)

- **`AffiliateClick`:** new columns `productId`, `variantId`, `provider`, `trackingId`, `destinationDomain`, `redirectStatus` (REDIRECTED or BLOCKED), `surface`, `referrerDomain` (host-only CHECK); a `createdAt` index.
- **`AffiliateConversion`:** new columns `provider`, `currency` (INR CHECK), `providerStatus`, `orderedAt`, `payoutId`; status gains `REVERSED`; a `(status, reportedAt)` index.
- **New `AffiliatePayout`:** unique (provider, reference); amount ≥ 0; INR; paid ⇔ `paidAt`.

## Configuration

| Variable                        |                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AMAZON_ASSOCIATES_PARTNER_TAG` | Associates store id (e.g. `yourid-21`), from an approved Associates account                     |
| `FLIPKART_AFFILIATE_ID`         | Flipkart affiliate tracking id                                                                  |
| `FLIPKART_AFFILIATE_TOKEN`      | Flipkart Report API token. Server-only; generating a new token in Flipkart disables the old one |

An admin must also enable affiliate links per source (`PATCH /api/v1/admin/affiliates/sources/:id`).

## Tests (actual results)

- **`@dealmind/affiliate` (7):**
  - link building (tag replaced, not duplicated; Flipkart sub-id; unconfigured = plain);
  - the registry's enable/configure gate and program statuses;
  - **open-redirect cases** (http, other host, look-alike host, credentials in the URL, unlisted subdomain, `javascript:`, protocol-relative, garbage, another source's domain);
  - referrer-host and device-class privacy;
  - Flipkart Report API (documented URL and headers, offset paging over all statuses, exact paise, a non-exact amount rejected rather than rounded, HTTP error fails loudly);
  - status and amount mapping.
- **API DB (8):**
  - tagged redirect plus the full click record (hashed IP, coarse device, referrer host);
  - Flipkart sub-id; plain link when disabled;
  - invalid id (422), unknown (404), sample store, three tampered stored URLs blocked with no `Location`, a `url=` parameter rejected;
  - duplicate click counted once; signed-in attribution;
  - retention (anonymize, delete);
  - Flipkart import (click match, idempotent, reversal, provider failure leaves nothing partial);
  - manual import, refused source, non-integer paise rejected, payout and its PAID rule, audit;
  - admin-only analytics (pending vs approved commission, categories, program status, no credential in the response) and audited source toggle;
  - **ranking independence.**
- **Web:** the product test checks the "Buy on …" link (click endpoint, `sponsored` rel, new tab, disclosure as its accessible description) and the disclosure text.
- **Whole repo:** `pnpm check --force` 52/52; API DB 154, worker DB 42, DB 68; web 106; Playwright 18.

## Not done / limitations

- **No live partner calls:** no partner account or credentials exist, so neither the Flipkart Report API nor an Amazon link has been exercised against the real service.
- **Amazon conversions:** manual import only (no verified India reporting API).
- **Croma, Tata CLiQ, Reliance Digital:** no integration. Network programs (Cuelinks, EarnKaro, TUNE) need their own approval and a network adapter.
- **Imports are admin-triggered** (no scheduled Flipkart import).
- **Clicks aren't stored for anonymous duplicates** within 30 s, by design.
