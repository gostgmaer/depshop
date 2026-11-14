/* eslint-disable no-console -- CLI script: stdout is its interface */
/**
 * `pnpm --filter @dealmind/connectors verify:flipkart` — live check with real
 * affiliate credentials from .env. Prints only counts/status (no tokens, no
 * product data). Run before setting the flipkart source to ACTIVE.
 */
import { FlipkartConnector } from "./flipkart/flipkart-connector.js";
import { validateResult } from "./core/executor/executor.js";

const connector = new FlipkartConnector({
  affiliateId: process.env.FLIPKART_AFFILIATE_ID,
  token: process.env.FLIPKART_AFFILIATE_TOKEN,
});
const readiness = connector.getReadiness();
if (readiness.state !== "READY") {
  console.error(`Not configured: ${JSON.stringify(readiness)}`);
  process.exit(2);
}
const signal = AbortSignal.timeout(10_000);
const raw = await connector.search({ query: "smartphone", limit: 5, locale: "en-IN" }, { signal });
const result = validateResult(raw, "flipkart", 5);
console.log(
  `Flipkart search OK: ${result.items.length} valid items, ${result.rejectedItems} rejected.`,
);
process.exit(result.items.length > 0 ? 0 : 1);
