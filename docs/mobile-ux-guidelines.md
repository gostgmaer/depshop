# Mobile UX guidelines

## Audit (2026-11-18, Prompt 26 Stage 1)

| Area                               | Before                                                                                                                                                     | Finding                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Navigation                         | Desktop sidebar; on phones, a hamburger button opening a sheet                                                                                             | Every destination took two taps; no persistent navigation. **Fixed:** bottom tab bar                               |
| Horizontal overflow                | Playwright checks on mobile for the product, search and admin pages                                                                                        | Fixed in Prompt 23 (screen-reader labels escaping scroll wrappers); still guarded by tests                         |
| Tables (offers, compare, admin)    | Card layouts below `lg` for offers and compare; admin tables scroll inside their card                                                                      | Already mobile-adapted; not changed                                                                                |
| Install, offline                   | No manifest, no offline behaviour                                                                                                                          | **Fixed:** PWA ([pwa-architecture.md](pwa-architecture.md))                                                        |
| Safe areas (notch, home indicator) | Not handled                                                                                                                                                | **Fixed:** `viewport-fit=cover`; the tab bar and page bottom padding use `env(safe-area-inset-bottom)`             |
| Search, product cards, comparison  | Natural-language search with examples and suggestions, filter controls, live progress; product cards with verified vs. conditional discounts and freshness | Not redesigned in this phase: existing Playwright coverage passes on mobile, and nothing showed a measured problem |

## Small-phone audit (360×740, Prompt 26 round 2)

Every main user page (14) and the main admin pages (6), measured automatically (`e2e/small-phone.spec.ts`, now a regression test), then checked by eye on screenshots.

| Finding                                                                                              | Before                            | Fix                                                                                                                  | After                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Horizontal overflow                                                                                  | none on any page                  | —                                                                                                                    | none                           |
| **Search input squeezed** to ~110 px (mic, filter and a wide Search button on one row)               | seen on screenshot                | Search button is icon-only below 640 px (its label stays for screen readers)                                         | input ≥ 180 px (tested)        |
| **Filters open by default** on phones, pushing the example searches below the fold                   | seen on screenshot                | Closed by default below 640 px (CSS, no flash); the filter button shows a count of active filters; desktop unchanged | tested: closed, opens on tap   |
| **"Buy on …" links 20 px tall**, the product page's main action                                      | 150×20                            | `min-h-11` (44 px)                                                                                                   | ≥ 24 px effective (tested)     |
| Checkboxes 16×16 (search filters, "include stale offers")                                            | 16×16                             | Invisible 28×28 hit area on the shared `Checkbox` (no visual change)                                                 | ≥ 24 px effective (tested)     |
| Notification title links 20 px tall                                                                  | 180×20                            | Taller tap area, same layout                                                                                         | ≥ 24 px (tested)               |
| **"Include offers not seen recently" wrapped one word per line** beside the card title               | seen on screenshot                | `CardHeader` lets its action wrap below the title when there's no room (all cards)                                   | one line below the description |
| Text under 12 px: price-history hints and gap note, chart axis and reference labels, the new tab bar | 11 px (and 10 px in chart labels) | 12 px                                                                                                                | none under 12 px (tested)      |

Method note: touch targets count the **effective hit area** (points 11.5 px from the centre must hit the control), per WCAG 2.2 SC 2.5.8. Links inside running text are exempt.

## Rules

- **Bottom tab bar (phones and tablets under `lg`):** at most five destinations (Home, Search, Watchlists, Alerts, Account). Everything else stays in the menu sheet. Tabs are plain links, so back/forward and deep links behave like the web. The current tab has `aria-current="page"` and a heavier icon, not colour alone. The bar's landmark is labelled "Quick navigation" (the sidebar is "Main").
- **Touch targets** at least 44×44 CSS px (tested for the tab bar).
- **Content is never hidden behind fixed UI:** `main` reserves the bar's height plus the safe-area inset (tested).
- **Prices:** never shown without their source and observed time; stale offers are labelled "Not current". The same rule holds offline: no cached prices are shown.
- **No interrupting prompts:** install and push are offered in Settings, from a user action, never as pop-ups on load.
- **Motion:** no new animations. Existing transitions respect `prefers-reduced-motion`.
