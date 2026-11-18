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

## Rules

- **Bottom tab bar (phones and tablets under `lg`):** at most five destinations (Home, Search, Watchlists, Alerts, Account). Everything else stays in the menu sheet. Tabs are plain links, so back/forward and deep links behave like the web. The current tab has `aria-current="page"` and a heavier icon, not colour alone. The bar's landmark is labelled "Quick navigation" (the sidebar is "Main").
- **Touch targets** at least 44×44 CSS px (tested for the tab bar).
- **Content is never hidden behind fixed UI:** `main` reserves the bar's height plus the safe-area inset (tested).
- **Prices:** never shown without their source and observed time; stale offers are labelled "Not current". The same rule holds offline: no cached prices are shown.
- **No interrupting prompts:** install and push are offered in Settings, from a user action, never as pop-ups on load.
- **Motion:** no new animations. Existing transitions respect `prefers-reduced-motion`.
