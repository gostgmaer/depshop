# First-time onboarding

**Status: IMPLEMENTED AND VERIFIED** (2026-11-18, Prompt 25 round 2). Its effect on activation is **not measured**: there are no users yet (see "Measure" below).

## What a new user sees

A five-step introduction in a panel on the dashboard, **below the search box**, so it never blocks the first search. It's an inline section, not a modal: the rest of the page stays usable.

1. **Search in plain language:** two example queries from the existing `EXAMPLE_QUERIES`.
2. **The same variant, compared:** variant matching, and that every price shows its marketplace and when it was seen.
3. **Genuine discounts:** history-backed verdicts, inflated-MRP flags, bank offers and cashback shown separately.
4. **Track prices and get alerts.**
5. **Optional preferences:** a link to Settings → Profile (preferred brands). The panel itself asks nothing.

"Skip introduction" is on every step; Back and Next move between steps; Done finishes. Focus moves to the heading of each new step for keyboard and screen-reader users. On mobile the panel stacks in the page flow.

## How it works

| Part     | Implementation                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State    | `User.onboardingCompletedAt` (null until closed) and `User.onboardingSkipped`; migration `20261126100000_onboarding` (additive)                                                                                                                                       |
| API      | `POST /api/v1/users/me/onboarding` with `{ "outcome": "completed" }` or `"skipped"`. Session and CSRF required, strict body. **The first outcome wins:** one conditional `UPDATE … WHERE onboardingCompletedAt IS NULL`, so repeat or concurrent calls change nothing |
| Exposure | `onboardingCompleted` on the current user (`PublicUser`, from `/auth/me`)                                                                                                                                                                                             |
| UI       | `components/onboarding/onboarding-panel.tsx` on the dashboard; hidden once completed                                                                                                                                                                                  |
| Reopen   | Settings → Profile → "Show the introduction again" opens `/dashboard?tour=1`; closing it then records nothing and clears the parameter                                                                                                                                |
| Privacy  | No personal data collected. The two columns live on the user row and are removed with the account                                                                                                                                                                     |

## Verification

| Suite                                                   | Result                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API DB tests (`onboarding.db.test.ts`)                  | 5/5: a new user isn't completed; completion is persisted; a skip is recorded and the first outcome wins; concurrent closes; a smuggled `userId` is rejected (422) and other users are unaffected; bad outcome 422, no session 401, no CSRF 403 |
| Migration drift check (throwaway Postgres)              | No difference between the migrations and the schema                                                                                                                                                                                            |
| Web unit (`onboarding.test.tsx`)                        | 6/6: every step with focus management; Done records "completed" once; Skip records "skipped"; Back; hidden when completed; reopening records nothing; no form inputs                                                                           |
| Playwright (`e2e/onboarding.spec.ts`, desktop + mobile) | 8/8: shown to a new user while the search box stays usable; axe (no serious or critical issues); skip survives a reload; finish, then reopen from Settings; existing users never see it                                                        |
| Regression                                              | API DB 187, db 68, worker 43, API unit 23, web unit 141, Playwright 48: all pass                                                                                                                                                               |

## Measure (after launch)

Aggregate only:

- the share of new users who finish vs. skip (`onboardingSkipped`);
- the share with a first search on their first day, compared with users who registered before this shipped.

Report it as an observation, not as causation, unless it's run as an experiment ([experimentation.md](experimentation.md)).
