/**
 * Deals feed runner: pulls each eligible store's discounted products (connectors with the
 * `dealFeed` capability) page by page, validates every item and keeps only real deals
 * (in stock, listed price, at least `minDiscountBp` below MRP). Eligibility is exactly the
 * live-search rule set (ACTIVE source, registered and enabled connector, credentials ready,
 * mocks only where allowed), so a store is never fetched before it is authorized.
 *
 * Bounded: a page limit and an item limit per source, a timeout per page, and the store's
 * own per-minute budget (shared with search). One failing store never stops the others.
 */
import type { ShoppingConnector } from "../interfaces/connector.js";
import type { RateLimiter } from "../rate-limiter/rate-limiter.js";
import type { ConnectorRegistry } from "../registry/registry.js";
import type { SourceConfig, SourceConfigProvider } from "../registry/source-config.js";
import { sleep } from "../retry/retry.js";
import {
  type NormalizedProduct,
  normalizedProductSchema,
  shoppingSearchRequestSchema,
} from "../types/schemas.js";

export interface DealFeedSourceResult {
  slug: string;
  status: "OK" | "PARTIAL" | "FAILED" | "SKIPPED";
  /** Why it was skipped or stopped early. */
  reason?: string;
  pages: number;
  received: number;
  /** Valid items at or above the discount threshold, handed to `onItems`. */
  accepted: number;
  /** Invalid, out-of-stock, indicative-price or under-threshold items. */
  dropped: number;
  durationMs: number;
}

export interface DealFeedRunnerOptions {
  allowMocks: boolean;
  rateLimiter?: RateLimiter;
  maxPagesPerSource?: number;
  maxItemsPerSource?: number;
  /** Longest wait for the store's rate-limit budget before stopping that store. */
  maxRateLimitWaitMs?: number;
}

/** Discount in basis points (2000 = 20%), or null without a usable MRP. */
export function discountBp(item: { sellingPricePaise: number; mrpPaise?: number | undefined }) {
  if (item.mrpPaise === undefined || item.mrpPaise <= 0 || item.sellingPricePaise <= 0) return null;
  return Math.floor(((item.mrpPaise - item.sellingPricePaise) * 10_000) / item.mrpPaise);
}

export function isDeal(item: NormalizedProduct, minDiscountBp: number): boolean {
  const d = discountBp(item);
  return (
    d !== null &&
    d >= minDiscountBp &&
    item.priceType !== "INDICATIVE" &&
    (item.stockStatus === "IN_STOCK" || item.stockStatus === "LIMITED")
  );
}

export class DealFeedRunner {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly sources: SourceConfigProvider,
    private readonly options: DealFeedRunnerOptions,
  ) {}

  /** Sources that will be fetched, and the others with the reason. */
  async plan(): Promise<{
    eligible: { connector: ShoppingConnector; source: SourceConfig }[];
    skipped: { slug: string; reason: string }[];
  }> {
    const { eligible, skipped } = this.registry.eligible(
      await this.sources.list(),
      shoppingSearchRequestSchema.parse({ query: "deals" }),
      { allowMocks: this.options.allowMocks },
    );
    const feed = eligible.filter(
      (e) => e.connector.getCapabilities().dealFeed === true && "fetchDeals" in e.connector,
    );
    return {
      eligible: feed,
      skipped: [
        ...skipped.map((s) => ({ slug: s.source.slug, reason: s.reason })),
        ...eligible
          .filter((e) => !feed.includes(e))
          .map((e) => ({ slug: e.source.slug, reason: "NO_DEAL_FEED" })),
      ],
    };
  }

  async run(
    minDiscountBp: number,
    onItems: (source: SourceConfig, items: NormalizedProduct[]) => Promise<void>,
  ): Promise<DealFeedSourceResult[]> {
    const { eligible, skipped } = await this.plan();
    const results: DealFeedSourceResult[] = skipped.map((s) => ({
      slug: s.slug,
      status: "SKIPPED",
      reason: s.reason,
      pages: 0,
      received: 0,
      accepted: 0,
      dropped: 0,
      durationMs: 0,
    }));
    for (const { connector, source } of eligible) {
      results.push(await this.runSource(connector, source, minDiscountBp, onItems));
    }
    return results;
  }

  private async runSource(
    connector: ShoppingConnector,
    source: SourceConfig,
    minDiscountBp: number,
    onItems: (source: SourceConfig, items: NormalizedProduct[]) => Promise<void>,
  ): Promise<DealFeedSourceResult> {
    const started = Date.now();
    const maxPages = this.options.maxPagesPerSource ?? 50;
    const maxItems = this.options.maxItemsPerSource ?? 5_000;
    const r: DealFeedSourceResult = {
      slug: source.slug,
      status: "OK",
      pages: 0,
      received: 0,
      accepted: 0,
      dropped: 0,
      durationMs: 0,
    };
    let cursor: string | undefined;
    try {
      do {
        if (r.pages >= maxPages || r.accepted >= maxItems) {
          r.status = "PARTIAL";
          r.reason = r.pages >= maxPages ? "PAGE_LIMIT" : "ITEM_LIMIT";
          break;
        }
        if (!(await this.budget(source))) {
          r.status = r.pages ? "PARTIAL" : "FAILED";
          r.reason = "RATE_LIMITED";
          break;
        }
        const page = await connector.fetchDeals!(
          { minDiscountBp, ...(cursor ? { cursor } : {}) },
          { signal: AbortSignal.timeout(source.timeoutMs) },
        );
        r.pages += 1;
        r.received += page.items.length;
        const deals: NormalizedProduct[] = [];
        for (const raw of page.items) {
          const parsed = normalizedProductSchema.safeParse(raw);
          if (
            parsed.success &&
            parsed.data.sourceId === source.slug &&
            isDeal(parsed.data, minDiscountBp)
          )
            deals.push(parsed.data);
          else r.dropped += 1;
        }
        const room = deals.slice(0, maxItems - r.accepted);
        r.dropped += deals.length - room.length;
        if (room.length) await onItems(source, room);
        r.accepted += room.length;
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      r.status = r.pages ? "PARTIAL" : "FAILED";
      r.reason = err instanceof Error ? err.message.slice(0, 200) : "error";
    }
    r.durationMs = Date.now() - started;
    return r;
  }

  /** Takes one call from the store's per-minute budget, waiting briefly if needed. */
  private async budget(source: SourceConfig): Promise<boolean> {
    const limiter = this.options.rateLimiter;
    if (!limiter) return true;
    const maxWait = this.options.maxRateLimitWaitMs ?? 60_000;
    let waited = 0;
    for (;;) {
      const d = await limiter.acquire(source.slug, source.rateLimitPerMinute);
      if (d.allowed) return true;
      if (waited + d.retryAfterMs > maxWait) return false;
      await sleep(d.retryAfterMs);
      waited += d.retryAfterMs;
    }
  }
}
