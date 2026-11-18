# Offline experience

## What works offline

| Situation                                                                                                     | What the user sees                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening or navigating to any page with no connection (after the service worker installed on an earlier visit) | **"You're offline"**: DealMind needs a connection for searches and current prices; _nothing shown offline is a live price_; watchlists and alerts are safe on the server and price checks keep running; e-mail and push alerts still arrive. A **Try again** link reloads the dashboard |
| A page already open when the connection drops                                                                 | It stays as it was. Actions that need the API fail with the existing error message ("Network error. Check your connection and try again."); nothing pretends to succeed                                                                                                                 |
| First visit ever while offline                                                                                | The browser's own offline page (no service worker yet)                                                                                                                                                                                                                                  |

## Deliberately not supported

- **Offline browsing of products, prices or searches.** Showing cached prices offline risks presenting stale prices as current. Nothing private or price-bearing is cached ([service-worker-strategy.md](service-worker-strategy.md)).
- **Offline edits** (watchlist or alert changes queued for later). They would need a sync design with conflict handling. With every change already a single fast API call, and no evidence users need it, it isn't built. Actions fail visibly instead of being silently queued.

## Verified

- Playwright, desktop and mobile: offline navigation shows the offline page; axe finds no serious or critical issues on it; "Try again" returns to the dashboard when online again.
- After sign-out, going offline never shows the previous user's page.
