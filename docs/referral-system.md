# Referral system

**Status: RECOMMENDED, not built.** Two prerequisites: real users (a referral programme with none has nothing to measure), and the legal review in [privacy-and-growth.md](privacy-and-growth.md). This page is the design.

## Rewards: non-monetary only

Rewards are **plan entitlements**, never money, credit or cashback. Monetary rewards need a separate payment and compliance design.

Possible rewards:

- temporary Pro access (N days);
- extra active alerts;
- extra watchlists.

A reward is granted through the existing entitlement and usage system, so plan limits and billing stay the single source of truth:

- A temporary Pro grant is an entitlement **override with an end date**. It never creates a paid subscription, never touches the payment service, and never stacks into a free paid period.
- If the user later subscribes, the paid plan applies; the grant doesn't extend it.

## Data model

| Table                 | Purpose                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ReferralCampaign`    | key, reward type and amount, start/end (configurable dates, never hardcoded), max rewards per referrer, active flag. Admin-managed, audit-logged |
| `ReferralCode`        | one per user (random, non-guessable, not derived from the user id or e-mail); revocable                                                          |
| `ReferralAttribution` | referred user → code, at registration, **unique per referred user** (attributed once, first valid code wins)                                     |
| `ReferralLedger`      | append-only: `QUALIFIED`, `REWARD_GRANTED`, `REWARD_REVOKED`, with reasons. Never updated in place (same rule as price history)                  |

## Attribution and abuse controls

- The code travels in a short-lived first-party cookie from the landing link to registration. It's checked server-side at sign-up.
- **Qualification is not registration:** the referred user must verify their e-mail **and** complete a first successful search within N days. This defeats empty sign-ups.
- **Self-referral blocked:**
  - same user;
  - same verified e-mail (normalised: case, `+tags`, dots for Gmail);
  - same payment instrument if one is ever involved.
- Per-referrer cap per campaign. Per-IP and per-device registration rate limits (the existing rate limiter). Disposable-e-mail domains refused for qualification.
- One reward per qualified referral (unique ledger key); revocation if the referred account is deleted for abuse within the window.
- **Privacy:** the referrer sees only counts and statuses ("2 joined, 1 qualified"), never the referred users' names or e-mails.

## Tests (when built)

Attribution once only; self-referral variants; cap; qualification window; duplicate reward claim (concurrent); revocation; no billing side effects; deletion of either account.
