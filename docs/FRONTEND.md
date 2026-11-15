# Web app (Phases 4.1–4.2)

`apps/web` is a Next.js 15 App Router app (React 19, TypeScript strict).
It is styled with Tailwind CSS 4 and uses shadcn/ui-style components built on
Radix, plus Lucide icons, React Hook Form + Zod, TanStack Query and Framer
Motion (used sparingly). Zustand was **not** added: no state needed to be
global on the client. Server state lives in TanStack Query, and shareable view
state (filters, variant, history period) lives in the URL.

## Integration with the backend

- **Same-origin proxy.** The browser only talks to the web origin.
  `src/app/api/[...path]/route.ts` forwards `/api/*` to Fastify with an allow-list of headers.
  Server-Sent Events (`text/event-stream`) are **streamed through**; they used to be buffered, which broke live progress.
- **Sessions.**
  - The session is an HttpOnly cookie set by the API.
  - JavaScript never handles a token; nothing goes to `localStorage`.
  - Only the CSRF token cookie is read, and it is copied into `x-csrf-token`.
- **Protected pages.** The `(dashboard)` layout verifies the session server-side (`getServerUser` asks `/auth/me`) on every request. Signed-out visitors go to `/login?next=<path>` (open-redirect safe).
- **Session expiry.**
  - Any authenticated call returning 401 notifies `onSessionExpired`.
  - Logout in another tab is broadcast via `BroadcastChannel`.
  - In both cases the shell sends the user to `/login?next=…`.
- **Typed clients.** `src/services/index.ts` maps 1:1 onto the Fastify endpoints. Response types come from the shared Zod contracts (`src/types/api.ts`), the same schemas the API validates its responses with.
- **TanStack Query** (`src/hooks/queries.ts`) has hierarchical keys and targeted invalidation. It retries only transient failures (network, 5xx, 429), never 4xx.
  - Prices: `staleTime` 30 s, refetched every 60 s.
  - Running searches: polled every 3 s as a fallback to SSE.
- **Live search progress** (`src/hooks/use-search-events.ts`) uses an `EventSource` on `/api/v1/search/:id/events`. Events are validated with the shared `searchEvent` schema and reduced by a pure, tested reducer. If the stream fails, polling keeps the page working.

### Backend additions made for the UI (all deterministic, no fabricated data)

| Change                                                                          | Why                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/products/:id/pricing?variantId=`                                   | Public product pricing from the Phase 3.3 engine: delivered price, verified direct discount, conditional benefits with status, EMI, history claims, and a comparison summary. Anonymous, so no eligibility is assumed: bank and coupon offers stay UNVERIFIED |
| `searchResultView.pricing`                                                      | Each search result carries its **current** pricing result (null if no longer priceable), next to the price captured at search time                                                                                                                            |
| `searchFilters.sortMode`, `searchFilters.specs`                                 | Ranking mode and specification filters chosen in the UI. The agent treats them as explicit overrides (they win over the AI's interpretation; specs are canonicalized by the catalog normalizer)                                                               |
| SSE events `sources_planned` and `source_finished`                              | The agent reports eligible/skipped marketplaces, then each marketplace's outcome, so the UI shows per-marketplace progress. Fastify validates both event shapes                                                                                               |
| Pricing result Zod schemas moved to `@dealmind/shared` (`pricing-contracts.ts`) | The web app gets the exact contract without importing the Prisma-backed intelligence package; `@dealmind/intelligence` re-exports them                                                                                                                        |

## Routes

| Route                                                                         | Content                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email` | Existing auth pages (`(guest)` and `(recovery)` groups); signed-in users go to `/dashboard`                                                                                                                |
| `/dashboard`                                                                  | See [Dashboard widgets](#dashboard-widgets) below                                                                                                                                                          |
| `/search`                                                                     | Natural-language search with suggestions (recent queries + examples) and filters: budget, category, brands, RAM/storage, marketplaces, ranking mode                                                        |
| `/search/[id]`                                                                | Live per-marketplace progress (SSE), cancel, clarification question, AI summary (from verified results only), warnings, ranked results with partial results while running. Usable when a marketplace fails |
| `/products`, `/categories`, `/categories/[slug]`                              | Catalog listing with URL filters (q, brand, budget, in stock, sort) and pagination; category tree; breadcrumbs                                                                                             |
| `/products/[id]`                                                              | See [Product page](#product-page) below                                                                                                                                                                    |
| `/compare`                                                                    | One variant across marketplaces (like-for-like); product picker                                                                                                                                            |
| `/watchlists`, `/watchlists/[id]`                                             | Create, delete, view; items with the current lowest price; remove; alert from an item                                                                                                                      |
| `/alerts`                                                                     | Filter by status; pause, resume, delete; plan usage. **States plainly that automatic alert evaluation isn't running yet** (no price-tracking worker exists)                                                |
| `/history`, `/notifications`                                                  | Paginated search history (owner only); notifications with unread filter, mark read, mark all read                                                                                                          |
| `/settings/profile`, `/settings/security`                                     | Existing profile, preferences, password and sessions pages, moved inside the app shell                                                                                                                     |
| `/billing`                                                                    | Current plan, usage meters, plan list. Upgrades are disabled because online payments don't exist yet                                                                                                       |

### Dashboard widgets

- Welcome and the AI search bar.
- **Best current deals:** the top ranked results of the user's latest finished search.
- **Recently launched:** products launched in the last 6 months with a current offer.
- Watched products with their current lowest price, and active alerts.
- **Savings overview:** usage counters only. No savings figure is shown, because DealMind has no purchase data.
- Recent searches and marketplace status (with reasons and a mock-data label).
- **Trending deals:** shows "Not available yet", because DealMind collects no popularity data.

### Product page

- Overview: badges, description and a variant picker.
- **Current best offer** (lowest delivered) with its price breakdown.
- **Marketplace comparison table:** a table on desktop, cards on mobile.
- **Price history chart:** 30/90/180/365 days.
- **Price intelligence:**
  - lowest-observed claims per window, with the percentage of each period actually observed;
  - a verified drop;
  - an explanation that "all-time low" needs complete history;
  - conditional benefits.
- Watch, price alert, compare, specifications and related products.

## Presenting prices honestly

- **Visual language:**
  - **emerald** = verified (a direct discount from a valid MRP, prices);
  - **amber** = conditional or unverified ("conditional · not guaranteed" plus the reason, e.g. "depends on your bank");
  - **neutral** = missing data said plainly ("MRP not stated", "shipping not stated");
  - **indigo** = the AI.
- **Prices:**
  - The delivered price is the headline: selling + shipping + mandatory fees.
  - A verified-offer price appears only when the engine applied a verified, eligible benefit.
  - Cashback is "credited later, not deducted"; exchange "depends on your device".
- **Timestamps.** Every price shows when it was observed ("Price observed 5 minutes ago"). Stale offers say "Last seen".
- **History wording** comes from the engine: "Lowest observed price in the last N days", or an all-time claim only with complete history. Window cards show each window's coverage.
- **Labels.** Sample and mock data are labelled ("Sample data", "Mock data"). Sample stores have no outbound link.
- **No invented data.** No trending, rating, popularity or savings figure is ever made up; those widgets say why they're empty.

## Price history chart

`components/charts/price-history-chart.tsx`, built per the data-viz method:

- **Marks:** one step line per offer, 2px, on one y-axis with a recessive grid.
- **Colours:** five categorical series colours in a fixed, validated order (blue, orange, aqua, yellow, magenta), with separate light and dark steps in `globals.css`.
  - The validator passes in both modes.
  - In light mode, three hues are below 3:1 contrast against white. The required relief is a legend, direct end labels (collision-nudged) and a table view.
  - One adjacent pair is in the CVD floor band, so every series also gets a distinct dash pattern.
- **Interaction:** a crosshair tooltip on pointer, or on focus plus ← → / Home / End; Escape clears it.
- **Accessibility:** an `aria-label` summary and a "Show as table" view.
- **Colour assignment:** colour follows the marketplace (sorted by slug), never its rank.

## Accessibility and performance

- **Structure:**
  - semantic landmarks, a skip link, `aria-current` navigation;
  - labelled form controls (Field wires labels, hints and errors);
  - `role="status"` loading states, `role="alert"` errors;
  - keyboard-operable Radix menus and dialogs; destructive actions confirm in an `alertdialog` (`ConfirmDialog`), never `window.confirm`.
- **Reduced motion:** honoured.
- **Contrast:** light-mode emerald, amber, red and indigo text tokens were darkened to meet WCAG AA (≥ 4.5:1) on white and on their soft fills. axe found the original values failing.
- **Rendering:**
  - Server components for layouts and route metadata (`generateMetadata` reads the public catalog server-side).
  - Client components only where interaction needs them.
  - Route-level `loading.tsx` / `error.tsx`, Suspense around `useSearchParams` users, lazy-loaded images.
- **Bundle:** 103 kB first-load JS shared. The dashboard and search pages are about 260 kB (search bar, forms, Radix menus and Framer Motion; not broken down further).

## Tests

| Kind                           | Count | What                                                                                                   |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------ |
| Vitest + React Testing Library | 34    | See [Vitest coverage](#vitest-coverage) below                                                          |
| Playwright                     | 14    | 7 tests × desktop (Chrome) and mobile (Pixel 7). See [Playwright coverage](#playwright-coverage) below |

`pnpm --filter @dealmind/web build && pnpm --filter @dealmind/web test:e2e`
runs the production build (`next start`) against `e2e/mock-api.ts`. That is a
**test-only** stand-in for Fastify: Next's server components call the API
server-side, so browser-level request interception can't replace it. It serves
the same contract-checked fixtures (fictional "Acme" / "Mock Store" data).

### Vitest coverage

The fixtures are checked against the shared Zod contracts (`src/test/contracts.test.ts`), then the tests cover:

- dashboard rendering (mock data labelled, trending never invented);
- navigation;
- auth redirect of the protected layout;
- search submission, query validation and explicit filters (paise, ranking, specs);
- the SSE progress reducer, and the failed-marketplace state;
- the result card: verified vs "conditional · not guaranteed";
- the comparison table: delivered order, lowest marked;
- watchlist add, watchlist deletion through a confirmation dialog (cancel does nothing), and price alert creation (rupee text → paise; "not running yet" message);
- the API error retry policy, and chart helpers.

### Playwright coverage

- auth redirect and back;
- dashboard data and honest empty states;
- sidebar and mobile sheet navigation with no horizontal overflow;
- search → live per-marketplace progress with one failure → results, summary, conditional label;
- product comparison and keyboard chart inspection;
- axe on 9 pages in light **and** dark mode: no serious or critical violations.

## Limitations

- **Marketplace data is mock or sample only** until a real connector is authorized (Phase 2.3 status). The UI labels it.
- **Price alerts are not evaluated yet.** No price-tracking worker runs (Phase 7). The UI says so instead of implying notifications will arrive.
- **No payments.** Plan upgrades are disabled.
- **Conditional benefits are never applied in the UI.** Users can't yet state their bank, card or memberships in the web app, so displayed pricing (product pages and search results) is computed without eligibility and benefits show as "conditional · not guaranteed". If a user names their bank in the query, the agent's ranking may use the verified payable price, but the result card still shows the delivered price; a saved eligibility profile would make the two consistent.
- **Savings and trending have no data source** and say so.
- **Not tested here:** a real-browser E2E against the real Fastify API. The cross-language E2E covers API + worker + agent, including the new progress events (29/29 accepted), while Playwright covers web ↔ mock API.
- **Bundle size:** dashboard and search load about 217 kB of JS, and a search result page about 229 kB. The search bar no longer uses Framer Motion. Not profiled further.

## AI shopping search (Phase 4.2)

### Search box (`components/search/ai-search-bar.tsx`)

- **Natural language first.** The text alone is enough; filters are optional and hidden behind a toggle that shows how many are set.
- **Autocomplete.** An ARIA combobox and listbox:
  - suggestions: recent searches, then catalog products, then examples;
  - catalog products come from `GET /products?q=`, debounced by 250 ms; superseded requests are aborted through TanStack's `signal`;
  - keyboard: ↑ ↓ Enter Esc.
- **Voice input (optional).** Uses the browser's Web Speech API (`en-IN`), feature-detected; browsers without it show no microphone. Only the transcript is used.
- **No duplicate searches.**
  - The submit is locked while a request is in flight.
  - The API also returns the running search, instead of creating and counting a second one, when the same user resubmits the same query and filters within 30 s.
- **Editing.** "Edit search" on a results page opens the box prefilled from the saved query and filters (`fromSearch`). Submitting starts a **new** search, so the old one stays in history. "Run again" re-submits the saved search as it was.

### Filters (`components/search/search-filters.tsx`)

- **General filters:**
  - category, then subcategory;
  - min/max price (rupee text parsed to integer paise);
  - minimum verified discount;
  - launch window;
  - confirmed availability;
  - ranking mode;
  - brands;
  - marketplaces: only searchable ones are offered, and the others are named as "not searchable yet".
- **Category-specific filters** come from `GET /categories/:slug/filters`. Nothing per category is hard-coded: a phone category shows RAM/storage, a washing-machine category shows capacity, from whatever its products actually state. Changing category clears the previous specification choices.
- **Rating filter:** there isn't one. The panel says why: no verified rating data exists.
- **Hard requirements.** Every filter is sent as an explicit filter that wins over the AI, and offers that don't state a required detail are left out.

### Ranking

- **Modes offered:** best value, highest verified discount, lowest price, recently launched and biggest price drop, plus "let the AI choose".
- **Explanations.** Each mode's explanation mirrors the engine's actual weights and ordering.
- **Results header.** It says which mode was used and whether **the user or the AI** chose it (`searchDetail.ranking`), and that affiliate commission never affects ranking.

### Live progress (`search-timeline.tsx`, `search-progress.tsx`)

- **Steps:**
  - search accepted;
  - AI understanding the query;
  - search plan created;
  - marketplace searches ("n of m marketplaces reported");
  - products matched;
  - prices calculated;
  - results ranked;
  - final results available.
- **Driven by real events.** A step is _done_ only when the agent sent `node_finished` for its last node, and _active_ while one of its nodes is running (a second search round re-activates it).
- **Unfinished steps.**
  - If a search ended early, they show as _not reached_.
  - If it succeeded but an event wasn't received (e.g. the replay log expired), they show as _not reported_.
- **No percentages or time estimates.**
- **Every known marketplace is listed:**
  - _Searching / Completed (n listings) / Failed / Timed out_ from live SSE events, then from persisted source runs;
  - _Pending approval / Credentials unavailable / Disabled / Not selected / Not searched_ from the persisted skip reason or the connector status, with the reason text.
- **The stream also opens for finished searches**, so the steps are shown when the API still has the replay log.
- **If the stream drops,** the panel says so and the page keeps polling.

### Results (`search/[id]/search-view.tsx`, `result-card.tsx`)

- **Card contents:**
  - image (lazy-loaded), name, brand, model number and variant (RAM · storage · colour);
  - delivered price and the selling price when it differs;
  - MRP: struck through only when verified, otherwise "listed MRP · not verified";
  - verified direct discount, marketplace, shipping, availability;
  - conditional offers, kept separate;
  - price-history summary and the observation time.
- **Actions:** compare, other marketplaces, watch and price alert.
- **List and grid views, sorting and pagination** live in the URL (`?view=grid&sort=price_asc&page=2`).
- **Sorting re-orders, never re-ranks.** `GET /search/:id/results?sort=rank|price_asc|discount_desc|newest` sorts the stored results by current delivered price, verified discount only, or launch date. The original rank numbers stay visible.

### States

- **Partial:** a heading and an alert say results come only from the marketplaces that responded, and the failed ones are named.
- **Expired:** prices not observed in 24 h get a banner and "Get fresh prices".
- **Failed:** separate messages for no marketplace searchable, every marketplace failed, and an agent error.
- **No listings vs. no matches:** "no listings returned" is told apart from "n listings, none met every requirement".
- **Cancelled, needs clarification** (prefilled box), **not found** (another user's search), and invalid queries.
- **API timeouts:** requests time out after 20 s with a retryable `TIMEOUT` error, instead of hanging.

### Comparison (`components/compare/multi-compare.tsx`)

- **Selection.** Pick two to four results ("Compare" checkbox). A tray links to `/compare?items=productId:variantId,…`.
- **Rows:** variant, lowest delivered price, verified direct discount, marketplace offers, conditional offers, price history, availability, launch date, and the union of specifications. Values never stated show "Not stated"; rows that differ are marked.
- **Nothing is presented as identical unless it is the same variant.** Each column says _Same variant_, _Different variant_ or _Different product_, and notes above the table explain why the prices aren't like-for-like.

### Phase 4.2 tests

| Kind                                      | Count                   | What                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vitest + RTL (`src/test/search.test.tsx`) | 29                      | All 14 required categories (see list below)                                                                                                                                                                                                                  |
| Playwright                                | 16 (8 × desktop/mobile) | New flow: category filters → live steps → partial results → sort → grid → compare selection → compare page with the different-variant warning, no horizontal overflow. axe now also scans a results page and a multi-compare page (11 pages, light and dark) |
| API DB (`search-results.db.test.ts`)      | 6                       | Duplicate guard (key order, per-user), result sorting and pagination, owner isolation of sorted results, ranking-mode reporting, category filters from stored data. Also a canonical-specs round-trip test                                                   |
| pytest                                    | 2                       | Explicit availability/launch/discount filters are hard; an explicit discount overrides the AI's                                                                                                                                                              |

The 14 Vitest categories:

1. natural language and autocomplete (keyboard, debounce, double-submit);
2. validation, and no client-side user id;
3. advanced filters;
4. category-specific filters, for two different categories;
5. ranking modes and their explanations;
6. progress steps only from reported events;
7. marketplace states and reasons;
8. partial results;
9. failed searches and sources, no-listing vs. no-match, expired results;
10. cancellation;
11. comparison selection, and the relation of different variants/products;
12. persistence: edit, re-run, and the filter round-trip;
13. isolation (404);
14. responsive list/grid and sort through the URL.

### Phase 4.2 limitations

- **Marketplace data is still mock or sample only.** Amazon India, Flipkart, Croma, Reliance Digital and Tata CLiQ appear as pending approval, credentials unavailable or disabled until authorized integrations exist.
- **Live skip reasons.** While a search runs, a marketplace skipped at planning shows its _current_ connector status. The precise skip reason appears once the run is saved, because the `sources_planned` event carries slugs only.
- **The comparison selection lives on the results page** and is lost on reload. The compare URL itself is shareable.
- **Category filters reflect stored data only.** A category with no imported products has no specification filters, and the panel says so.
- **Voice input** depends on browser support (Chromium/Safari). Its recognition runs in the browser vendor's service.
- **Sorting is in memory.** It handles at most 200 stored results per search; the agent stores up to 100.
- **The E2E mock's pricing endpoint ignores `variantId`,** so in the browser test both compare columns show the same mock prices. The real API prices each variant separately (covered by API tests).
