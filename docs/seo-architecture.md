# SEO architecture

**Status 2026-11-18:** technical SEO is **implemented and verified on the built app**. Indexing is **off** everywhere: DealMind is not launched, and only the owner switches it on, at launch, on the production host.

## The indexing switch

| Setting        | Where                                          | Effect                                                                                                                                   |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SEO_INDEXING` | `.env.production` (default `disabled`)         | `enabled` only on production at launch. `check-env.sh` **refuses** `enabled` unless `DEPLOY_ENV=production`, and refuses any other value |
| `SITE_URL`     | set by compose from `APP_DOMAIN` (`https://…`) | Canonical and sitemap origin. Must be https (http only for localhost) with no path                                                       |

|                 | Indexing **off** (default: dev, CI, rehearsal, staging, pre-launch) | Indexing **on**                                                                     |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `robots.txt`    | `User-Agent: *` / `Disallow: /`                                     | `Allow: /`, every private prefix disallowed, `Sitemap:`                             |
| `sitemap.xml`   | empty                                                               | `/`, `/pricing`, `/privacy` (absolute; no `lastmod`, because no honest date exists) |
| Every page      | `<meta name="robots" content="noindex, nofollow">`                  | Public pages indexable; private ones still noindex                                  |
| Structured data | none (no origin)                                                    | WebSite + Organization on the homepage                                              |

## Private pages are never indexable

Three independent layers protect them, whatever the switch says:

1. **`X-Robots-Tag: noindex, nofollow`** response header from the middleware for every private path (`PRIVATE_PATH_PREFIXES` in `apps/web/src/lib/seo.ts`):
   - the signed-in app: dashboard, search, products, categories, compare, watchlists, alerts, notifications, history, billing, settings;
   - admin;
   - login and register;
   - password reset, e-mail verification, unsubscribe.
2. **Page metadata:** the dashboard and admin layouts, the auth (`(guest)`) layout and the one-time-link (`(recovery)`) layout set `robots: noindex`.
3. **`robots.txt`** disallows the same prefixes (and `/api/`).

Signed-in pages also redirect anonymous visitors (crawlers) to `/login`, so their content is never served to a crawler.

## Metadata

- **Root** (`app/layout.tsx`): title template, honest description, `metadataBase` = `SITE_URL`, Open Graph (`en_IN`, site name), Twitter summary card.
- **Canonical URLs:** `/`, `/pricing`, `/privacy`. They're absolute when `SITE_URL` is set.
- **Homepage** h1: "Find genuine deals. Compare prices. Track products. Buy smarter."
- **Semantic structure:** one h1, h2 section heading, list of feature cards (h3), labelled `<nav>`.

## Structured data

The homepage has WebSite and Organization only (`siteJsonLd`). It deliberately omits:

- `SearchAction` (searching needs an account);
- `logo` (no approved asset);
- every rating, review and offer.

The JSON is built from constants, with `<` escaped (`jsonLdString`) so content can't break out of the script element.

**Product and Offer markup are not used yet.** There are no public product pages. When there are ([programmatic-seo.md](programmatic-seo.md)), an `Offer` must name the marketplace as the seller, never DealMind; its price must equal the visible price; availability must be included only when verified; there must be no `AggregateRating` without real reviews.

## Verification (2026-11-18)

| Check                                                                                                                                        | Result                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests (`src/test/seo.test.ts`): switch, origin validation, robots, sitemap, private-path coverage, metadata, JSON-LD shape and escaping | 13/13                                                                                                                                                                                               |
| Built app over HTTP, **indexing off**                                                                                                        | robots `Disallow: /`; empty sitemap; homepage `noindex, nofollow`; no JSON-LD; `/dashboard` `X-Robots-Tag`                                                                                          |
| Built app over HTTP, **indexing on** (`SITE_URL=https://dealmind.example`)                                                                   | robots allows `/` and disallows 19 private prefixes, plus the sitemap URL; sitemap has 3 absolute URLs; homepage indexable with absolute canonical; 2 JSON-LD blocks; private pages still `noindex` |
| Playwright (`e2e/seo.spec.ts`, desktop + mobile)                                                                                             | default-off behaviour, private-path header on 5 paths, no coverage or guarantee claims                                                                                                              |
| `check-env.sh`                                                                                                                               | `enabled` refused on staging; allowed on production; invalid value refused                                                                                                                          |

**Not verified:** Google Search Console, Rich Results Test and real crawling all need the public domain (BLOCKED until launch). Core Web Vitals on real devices are BLOCKED too ([growth-analytics.md](growth-analytics.md)).

## At launch

Set `SEO_INDEXING=enabled` in the production `.env.production`, redeploy web, then:

- check `https://<domain>/robots.txt`;
- submit the sitemap in Search Console;
- run the homepage through the Rich Results Test.
