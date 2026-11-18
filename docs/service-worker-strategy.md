# Service worker strategy

File: `apps/web/public/sw.js` (plain JavaScript, served as-is; excluded from middleware and ESLint).

## Caching rules (by resource type)

| Request                                                                                  | Strategy                                                          | Stored?                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/_next/static/*` (JS, CSS, fonts)                                                       | Cache first                                                       | **Only if** the response is same-origin, OK, and `Cache-Control` contains `immutable`. That is true of Next.js hashed production assets, so dev builds (not immutable) are never cached |
| `/icons/*`, `/icon.svg`                                                                  | Cache first (precached at install)                                | Yes                                                                                                                                                                                     |
| Page navigations                                                                         | **Network only.** On network failure → the cached `/offline` page | **Never** (except `/offline` itself)                                                                                                                                                    |
| `/api/*`, RSC payloads (`?_rsc`), `/_next/image`, manifest, anything with a query string | Not handled: straight to the network                              | **Never**                                                                                                                                                                               |
| Non-GET, cross-origin                                                                    | Not handled                                                       | Never                                                                                                                                                                                   |

**Marketplace prices are never cached by the service worker.** They only arrive through `/api` and RSC payloads, which are not handled.

## Lifecycle

- **Caches:** `dm-static-v1` (capped at 300 entries, oldest dropped first) and `dm-offline-v1`.
- **Install:** fetch `/offline` with `cache: "reload"` and no credentials (it contains no user data); precache the icons; `skipWaiting()`.
- **Activate:** delete every `dm-*` cache not in the current set (old versions); `clients.claim()`.
- **Updates:** browsers re-check `sw.js` on navigation. Because it never caches HTML, a new deployment's pages are always fetched fresh, and old hashed assets simply stop being requested. To change caching behaviour, bump `VERSION`.
- **Sign-out:** the app posts `SIGNED_OUT`; the worker deletes any cache that isn't the static or offline cache (defence in depth: nothing private is cached in the first place).

## Registration

`registerServiceWorker()` (`lib/pwa.ts`) runs after `load`, only when `NODE_ENV=production`. It requests no permission. The push code registers the same worker at the same scope, so there's only ever one.

## Verified (Playwright, Chromium)

| Check                                                                                                                                                                                                          | Result                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Registers and controls the page                                                                                                                                                                                | ✅                               |
| After visiting the dashboard, watchlists, alerts, notifications and settings while signed in, the caches contain only `/offline`, `/icon*`, `/icons/*`, `/_next/static/*`, and **no `/api` and no other page** | ✅ (desktop + mobile, 5 repeats) |
| Offline navigation → offline page                                                                                                                                                                              | ✅                               |
| After sign-out, offline → offline page (never the previous user's page); online → sign-in                                                                                                                      | ✅                               |
| Private pages: `Cache-Control: no-store`                                                                                                                                                                       | ✅                               |
