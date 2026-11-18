# PWA architecture

DealMind's web app is installable as a Progressive Web App. Same Next.js app, same API, same session cookie, same data: no separate native app, backend or identity.

**Status 2026-11-18 (Prompt 26):** implemented and verified in Chromium (Playwright, desktop and Android emulation). **Installation itself has not been verified on a real device or browser** (BLOCKED until a deployed HTTPS origin exists; see [browser-compatibility.md](browser-compatibility.md)).

## Pieces

| Piece             | File                                                                                                                               | Notes                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest          | `apps/web/src/app/manifest.ts` → `/manifest.webmanifest`                                                                           | name, short name, description, `start_url: /dashboard`, `scope: /`, `display: standalone`, theme `#0f766e`, background `#f8f9fb`, 3 shortcuts (Search, Watchlists, Alerts)                           |
| Icons             | `public/icons/` (rendered from `public/icon.svg` by `scripts/render-icons.mjs` with Playwright's Chromium, so no image dependency) | 192 and 512 PNG (`any`), 512 `maskable` (glyph in the 80 % safe zone), 180 Apple touch icon, plus the SVG                                                                                            |
| Head tags         | `app/layout.tsx`                                                                                                                   | `theme-color`, `viewport-fit=cover` (safe areas), `apple-mobile-web-app-*`, `apple-touch-icon`                                                                                                       |
| Service worker    | `public/sw.js`, registered by `lib/pwa.ts` from `app/providers.tsx` after page load, **production builds only**                    | Static-asset cache, offline page, web push. No permission is requested by registration ([service-worker-strategy.md](service-worker-strategy.md))                                                    |
| Offline page      | `app/offline/page.tsx`                                                                                                             | Cached once at install; works without JavaScript ([offline-experience.md](offline-experience.md))                                                                                                    |
| Install UI        | `components/pwa/install-app-card.tsx` in Settings → Profile                                                                        | Chromium: the browser's own prompt via `beforeinstallprompt`. iOS Safari: manual Share → Add to Home Screen steps. Installed: "installed". It's never a pop-up, so there's no re-prompting to manage |
| Mobile navigation | `components/navigation/mobile-tab-bar.tsx`                                                                                         | Bottom bar under `lg`: Home, Search, Watchlists, Alerts, Account ([mobile-ux-guidelines.md](mobile-ux-guidelines.md))                                                                                |
| Push              | existing Web Push + `lib/push.ts`                                                                                                  | Now turned off on sign-out ([web-push-notifications.md](web-push-notifications.md))                                                                                                                  |

**CSP:** already allows `worker-src 'self'` and `manifest-src 'self'`; no change needed. **HTTPS:** service workers and installation require it. Production is HTTPS-only behind Traefik; `localhost` is exempt for development and tests.

## Security properties (verified)

- The service worker stores **no page except `/offline` and no API response**. Private data (searches, watchlists, prices, notifications, billing, admin) can't be served from it, before or after sign-out.
- Private pages are sent with `Cache-Control: no-store`, so the browser's HTTP cache doesn't keep them either.
- Sign-out turns off push on that browser (a shared phone stops showing the previous user's alerts) and tells the service worker to drop any non-static cache.
- The session stays an HttpOnly cookie. Nothing new is written to `localStorage` or IndexedDB.
