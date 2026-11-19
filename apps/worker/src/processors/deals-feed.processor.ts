/**
 * Deals feed sync (scheduled): every eligible store's discounted products go through the
 * normal catalog import (validate → normalize → match/deduplicate → upsert offer → price
 * snapshot), so deals get the same product pages, price history and buy links as anything
 * else in the catalog. Only items at least `minDiscountBp` below MRP arrive here.
 *
 * Deals end on their own: an offer that is no longer discounted stops being refreshed by
 * the feed, is re-priced by price tracking (or goes stale), and the deals list hides it.
 */
import {
  type DealFeedRunner,
  type DealFeedSourceResult,
  toSourceListing,
} from "@dealmind/connectors";
import type { CatalogImporter } from "@dealmind/intelligence";
import type { Logger } from "pino";

export interface DealsFeedDeps {
  runner: Pick<DealFeedRunner, "run">;
  importer: Pick<CatalogImporter, "importListings">;
  minDiscountBp: number;
  log: Pick<Logger, "info" | "warn">;
}

export interface DealsFeedSummary {
  sources: DealFeedSourceResult[];
  imported: number;
  review: number;
  rejected: number;
}

export async function syncDeals(deps: DealsFeedDeps): Promise<DealsFeedSummary> {
  const totals = { imported: 0, review: 0, rejected: 0 };
  const sources = await deps.runner.run(deps.minDiscountBp, async (source, items) => {
    const listings = [];
    for (const item of items) {
      try {
        listings.push(toSourceListing(item));
      } catch {
        totals.rejected += 1; // not storable as an offer (e.g. indicative price)
      }
    }
    if (!listings.length) return;
    const summary = await deps.importer.importListings(source.slug, listings);
    for (const o of summary.outcomes) {
      if (o.status === "imported") totals.imported += 1;
      else if (o.status === "review") totals.review += 1;
      else totals.rejected += 1;
    }
  });
  for (const s of sources.filter((x) => x.status === "FAILED" || x.status === "PARTIAL"))
    deps.log.warn({ source: s.slug, status: s.status, reason: s.reason }, "deals feed incomplete");
  return { sources, ...totals };
}
