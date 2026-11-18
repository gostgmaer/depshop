# Production cost estimate

**Status 2026-11-18: no production costs have been incurred or measured.** No host, LLM account or paid provider exists yet. Everything below is either:

- **MEASURED:** from local tests on one laptop, which is not production hardware; or
- **ESTIMATE:** a reference list price found on 2026-11-18, **not verified on the vendor's own pricing page**.

Vendor prices changed substantially during 2026, so check each one before budgeting, and replace this page with actual bills after the first month.

## Inputs we have measured

| Input                                     | Value                                                                 | Source                       |
| ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------- |
| Throughput, signed-in read mix            | ~1,296 req/s at p95 ≤ 33 ms                                           | k6, local, Phase 21          |
| Throughput, catalog and search mix        | ~1,022 req/s at p95 ≤ 58 ms                                           | k6, local, Phase 21          |
| Price-tracking throughput                 | ~65 jobs/s at 80 ms simulated upstream latency                        | BullMQ load test, local      |
| Search pipeline (mock sources, rules LLM) | ~1.1 s end to end                                                     | Prompt 22 journey            |
| Database size after the rehearsal         | backup archive 156 KB (synthetic data)                                | Prompt 22 staging simulation |
| **LLM tokens per search**                 | **not measured.** Every test uses the rules extractor or a mocked LLM | —                            |

The configured container limits (not measured usage) add up to about 7.5 vCPU and 7 GB memory. That covers Postgres (2 GB), api, worker and agent (1 GB each), web, Redis and Traefik.

## Monthly estimate at launch scale (one host, ≤ a few hundred daily users)

| Item                                                | Basis                                                                                                                                                                                                                                                                                                                    | Estimate                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Hosting** (one VM, 4 vCPU / 8 GB / 80–160 GB SSD) | Hetzner raised cloud prices sharply in 2026: CPX/CCX up roughly 113–175 %, plus €0.50/month per IPv4. Exact current plan prices could not be confirmed.                                                                                                                                                                  | **ESTIMATE:** quote the chosen provider; small-VM class only                                                                              |
| PostgreSQL                                          | Runs on the same host (no managed database at launch)                                                                                                                                                                                                                                                                    | included in hosting                                                                                                                       |
| Redis                                               | Same host                                                                                                                                                                                                                                                                                                                | included in hosting                                                                                                                       |
| Storage and backups                                 | Local volume plus off-host object storage for dumps (14 local, 30 off-host)                                                                                                                                                                                                                                              | **ESTIMATE:** a few GB/month at launch; object storage for that size is typically ≤ a few USD/month                                       |
| **Staging host**                                    | A smaller VM; can be stopped between releases                                                                                                                                                                                                                                                                            | **ESTIMATE:** ~half the production host                                                                                                   |
| **LLM**                                             | Two short calls per search (intent extraction + narration); assume about 2k input and 300 output tokens (**unmeasured**). Reference Flash-tier prices vary by model: e.g. $0.30/$2.50 per M tokens (2.5 Flash, deprecated); about $0.75/$3.75 (3.8 Flash introductory, through 2026-12-31); $0.10/$0.40 (2.5 Flash-Lite) | **ESTIMATE:** at $0.75/$3.75: ≈ $0.0026 per search ≈ **$2.6 per 1,000 searches**. Measure tokens in Admin → AI models and set a spend cap |
| Search or discovery provider                        | Not integrated                                                                                                                                                                                                                                                                                                           | $0 (none)                                                                                                                                 |
| E-mail                                              | The EasyDev notification service (shared)                                                                                                                                                                                                                                                                                | per the shared service's provider; DealMind volume ≈ alerts + account e-mails                                                             |
| Monitoring                                          | Self-hosted Prometheus overlay on the same host                                                                                                                                                                                                                                                                          | included; a hosted alternative is a separate decision                                                                                     |
| **Payment fees**                                    | Razorpay standard: reportedly 2 % + 18 % GST on the fee; the subscription add-on is reported at about 0.9–0.99 %; new merchants may get a fee waiver for an introductory period. Unconfirmed                                                                                                                             | **ESTIMATE:** ≈ 2.4–3.5 % of subscription revenue                                                                                         |
| Marketplace integrations                            | Affiliate APIs (Amazon, Flipkart) are free and pay commission; partner integrations (Croma, Reliance Digital, Tata CLiQ) are per agreement                                                                                                                                                                               | $0 until agreements say otherwise                                                                                                         |
| Domains and TLS                                     | Let's Encrypt                                                                                                                                                                                                                                                                                                            | domain registration only                                                                                                                  |

## What will dominate cost

1. **The host,** fixed. One VM covers the measured throughput with wide margin.
2. **LLM tokens,** variable. They are the only per-search cost. Measure them in the first week; the Admin → AI models view shows tokens and estimated spend.
3. **Payment fees,** proportional to revenue.

## Scaling triggers (from monitoring, not forecasts)

| Signal sustained for a week                                     | Then                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| CPU > 60 % or memory > 75 % at peak                             | Larger VM (vertical)                                    |
| Database > 50 % of disk, or an RPO < 24 h becomes a requirement | Managed PostgreSQL with point-in-time recovery          |
| Queue wait p95 > 30 s                                           | More worker concurrency, then a second worker container |
| API p95 > 1 s with free CPU                                     | Profile first; scale only after                         |

No Kubernetes and no extra services: the measured load is far below what a single host serves.

## Sources (list prices, retrieved 2026-11-18, not verified on vendor pages)

- Hetzner 2026 price changes: [wz-it.com](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/), [findstack.com](https://findstack.com/resources/hetzner-price-increase-2026), [betterstack.com review](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/)
- Gemini API pricing: [morphllm.com](https://www.morphllm.com/gemini-api-pricing), [benchlm.ai](https://benchlm.ai/google/api-pricing), [anotherwrapper.com (2.5 Flash)](https://anotherwrapper.com/llm-pricing/gemini-2.5-flash)
- Razorpay fees: [Razorpay blog: pricing explained](https://razorpay.com/blog/razorpay-payment-gateway-pricing-explained/), [softwaresuggest.com](https://www.softwaresuggest.com/blog/razorpay-payment-gateway-charges/)
