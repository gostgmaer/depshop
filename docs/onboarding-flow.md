# First-time onboarding

**Status: RECOMMENDED, not built.** The design is ready to implement after launch, once activation can be measured (first search within the first session). Building it now would add UI whose value can't be shown.

## Design

Shown once, after the first sign-in, as a dismissible panel on the dashboard. **It never blocks the search box.**

1. **Search in plain language:** two example queries the user can click (from the existing `EXAMPLE_QUERIES`).
2. **Same variant, real prices:** one sentence and a static illustration. No live prices, so nothing can be stale.
3. **Genuine discounts:** what "genuine", "not verified" and "inflated MRP" mean (the pricing engine's verdicts).
4. **Track and get alerts:** how a watchlist and a target-price alert work.
5. **Optional preferences:** preferred marketplaces and brands. These fields already exist (`UserPreference.preferredSourceIds`, `preferredBrands`). Skippable; nothing else is asked.

## Rules

- **Skip at every step.** "Skip" and "Done" both record completion.
- **Completion state:** `onboardingCompletedAt` on the user (one nullable column). It's never shown again after completion; it can be reopened from Settings.
- **No personal data** beyond the optional preferences above. Removed with the account like any user row.
- **Mobile:** a bottom sheet; **desktop:** a side panel. Keyboard and screen-reader operable (tested with axe like the rest of the app).

## Measure

The share of new users with a first search in their first session, and whether a preference was set. Compare cohorts before and after the change, with the same caveats as [experimentation.md](experimentation.md).
