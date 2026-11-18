# Experimentation

**Status: RECOMMENDED, not built.** An A/B test needs enough traffic to detect a difference. With no users, any result would be noise. The design below is deliberately small.

## Design (lightweight, no third-party platform)

| Concern    | Rule                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition | `Experiment` (key, variants with weights, target page or flow, start/end, status `DRAFT`/`RUNNING`/`STOPPED`), admin-managed, every change audit-logged                                                                               |
| Assignment | Deterministic: `hash(experiment key + stable subject id) mod 100`. Subject = user id when signed in, else a random first-party cookie id (no fingerprinting). The same subject always gets the same variant while the experiment runs |
| Exposure   | Recorded once per subject per experiment as an **aggregate** counter (`experiment_exposure`, [growth-analytics.md](growth-analytics.md))                                                                                              |
| Conversion | Existing aggregate events (registration, first search, alert created, paid activation) by variant                                                                                                                                     |
| Shutdown   | `STOPPED` instantly reverts everyone to control; no deploy needed                                                                                                                                                                     |
| Analysis   | Pre-registered primary metric and minimum sample size **before** starting; no peeking-driven early wins. A result is reported with its confidence interval, or as inconclusive                                                        |

## Off-limits for experiments

The brief's rule holds: never compromise price accuracy, privacy or ranking neutrality. In particular:

- prices, discounts, verdicts and freshness labels;
- the order of objective rankings (ranking changes go through the evaluation in [deal-ranking-evaluation.md](deal-ranking-evaluation.md), not A/B);
- what data is collected or consent defaults;
- anything showing urgency, scarcity or countdowns.

## Allowed

Homepage and pricing-page copy and layout, search placeholder examples, CTA placement, onboarding order, referral wording.
