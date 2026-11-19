/**
 * Flipkart Affiliate API 1.0 connector.
 *
 * Implemented strictly from Flipkart's published affiliate API documentation
 * (https://affiliate.flipkart.com/api-docs/af_prod_ref.html, read 2026-11):
 *   GET https://affiliate-api.flipkart.net/affiliate/1.0/search.json?query=…&resultCount=≤10
 *   GET https://affiliate-api.flipkart.net/affiliate/1.0/product.json?id=…
 *   GET https://affiliate-api.flipkart.net/affiliate/api/<trackingId>.json (product feed listing)
 *   GET <listing>.apiGroups.affiliate.apiListings.<category>.availableVariants.<v>.get
 *       (category product feed, ≤ 500 items per page, `nextUrl` to continue, `inStock=true`)
 *   headers Fk-Affiliate-Id, Fk-Affiliate-Token
 *   response productInfoList[].productBaseInfoV1 / productShippingInfoV1
 * The FAQ states a limit of 20 calls/second per affiliate.
 *
 * STATUS: implemented, NOT verified against the live API — no affiliate
 * credentials are available. It must stay PENDING_CREDENTIALS until a real
 * token passes `pnpm --filter @dealmind/connectors verify:flipkart`.
 * Listing prices are LISTED, never claimed as checkout prices.
 */
import { z } from "zod";
import type {
  ConnectorCallContext,
  DealFeedPage,
  DealFeedRequest,
  ShoppingConnector,
} from "../core/interfaces/connector.js";
import { rupeesToPaise } from "../core/normalizers/offers.js";
import { ConnectorError } from "../core/types/errors.js";
import type {
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorReadiness,
  ConnectorSearchResultInput,
  NormalizedProductInput,
  Promotion,
  ValidSearchRequest,
} from "../core/types/schemas.js";

export const FLIPKART_API_BASE = "https://affiliate-api.flipkart.net/affiliate";
const PROVIDER = "flipkart-affiliate-1.0";
/** Documented maximum for resultCount on keyword search. */
const MAX_RESULTS = 10;

const money = z
  .object({ amount: z.union([z.number(), z.string()]), currency: z.string() })
  .partial()
  .passthrough();

/** Lenient on unknown fields, strict on what we use (validated again by the executor). */
const productInfo = z
  .object({
    productBaseInfoV1: z
      .object({
        productId: z.string(),
        title: z.string(),
        productDescription: z.string().nullish(),
        imageUrls: z.record(z.string()).nullish(),
        maximumRetailPrice: money.nullish(),
        flipkartSellingPrice: money.nullish(),
        flipkartSpecialPrice: money.nullish(),
        productUrl: z.string(),
        productBrand: z.string().nullish(),
        inStock: z.boolean().nullish(),
        categoryPath: z.string().nullish(),
        offers: z.array(z.string()).nullish(),
        attributes: z.record(z.unknown()).nullish(),
      })
      .passthrough(),
    productShippingInfoV1: z
      .object({ shippingCharges: money.nullish(), sellerName: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type FlipkartProductInfo = z.infer<typeof productInfo>;

/** Product feed listing: one feed URL per category and API version. */
const feedListing = z
  .object({
    apiGroups: z.object({
      affiliate: z.object({
        apiListings: z.record(
          z
            .object({
              availableVariants: z.record(z.object({ get: z.string() }).passthrough()),
            })
            .passthrough(),
        ),
      }),
    }),
  })
  .passthrough();

const feedPage = z
  .object({
    productInfoList: z.array(z.unknown()).default([]),
    nextUrl: z.string().nullish(),
  })
  .passthrough();

/** Deals-feed position: the category feed URLs and where we are in them. */
const dealCursor = z.object({
  urls: z.array(z.string()).max(500),
  i: z.number().int().min(0),
  next: z.string().optional(),
});

const searchResponse = z
  .object({ productInfoList: z.array(z.unknown()).default([]) })
  .passthrough();

export interface FlipkartConfig {
  affiliateId?: string | undefined;
  token?: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

function classify(text: string): Promotion["type"] {
  if (/bank|card|upi/i.test(text)) return "BANK_OFFER";
  if (/cashback/i.test(text)) return "CASHBACK";
  if (/exchange/i.test(text)) return "EXCHANGE";
  if (/coupon|code/i.test(text)) return "COUPON";
  if (/plus member|membership|supercoin/i.test(text)) return "MEMBERSHIP";
  return "OTHER";
}

export class FlipkartConnector implements ShoppingConnector {
  readonly id = "flipkart";
  readonly name = "Flipkart";
  readonly isMock = false;
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(private readonly config: FlipkartConfig) {
    this.base = config.baseUrl ?? FLIPKART_API_BASE;
    this.http = config.fetch ?? fetch;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      search: true,
      productLookup: true,
      categories: "all",
      price: true,
      mrp: true,
      stock: true,
      shipping: true,
      promotions: true,
      maxResultsPerRequest: MAX_RESULTS,
      dealFeed: true,
    };
  }

  getReadiness(): ConnectorReadiness {
    const missing = [
      ...(this.config.affiliateId ? [] : ["FLIPKART_AFFILIATE_ID"]),
      ...(this.config.token ? [] : ["FLIPKART_AFFILIATE_TOKEN"]),
    ];
    return missing.length ? { state: "PENDING_CREDENTIALS", missing } : { state: "READY" };
  }

  private get(path: string, params: Record<string, string>, signal: AbortSignal) {
    return this.getUrl(`${this.base}${path}?${new URLSearchParams(params).toString()}`, signal);
  }

  /**
   * Credentials ride in headers, so only URLs on the configured API host are ever requested
   * (feed URLs come from Flipkart's own listing response).
   */
  private async getUrl(url: string, signal: AbortSignal): Promise<unknown> {
    if (new URL(url).origin !== new URL(this.base).origin) {
      throw new ConnectorError("INVALID_RESPONSE", "Flipkart feed URL is not on the API host", {
        retryable: false,
      });
    }
    if (this.getReadiness().state !== "READY") {
      throw new ConnectorError(
        "NOT_CONFIGURED",
        "Flipkart affiliate credentials are not configured",
        { retryable: false },
      );
    }
    const res = await this.http(url, {
      headers: {
        "Fk-Affiliate-Id": this.config.affiliateId!,
        "Fk-Affiliate-Token": this.config.token!,
        Accept: "application/json",
      },
      signal,
      // Credentials ride in custom headers: never follow a redirect with them.
      redirect: "error",
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      // Never include headers/body echo (could contain the token) in errors.
      throw ConnectorError.fromHttpStatus(
        res.status,
        `Flipkart API responded ${res.status}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new ConnectorError("INVALID_RESPONSE", "Flipkart API returned non-JSON", {
        cause: err,
        retryable: false,
      });
    }
  }

  /** Maps one documented productInfo entry; returns null when it can't be mapped honestly. */
  toItem(raw: unknown, operation: string): NormalizedProductInput | null {
    const parsed = productInfo.safeParse(raw);
    if (!parsed.success) return null;
    const b = parsed.data.productBaseInfoV1;
    const ship = parsed.data.productShippingInfoV1;
    const price = b.flipkartSpecialPrice?.amount ?? b.flipkartSellingPrice?.amount;
    const currency = b.flipkartSpecialPrice?.currency ?? b.flipkartSellingPrice?.currency;
    if (price === undefined || (currency && currency !== "INR") || !b.productBrand) return null;
    let sellingPricePaise: number;
    let mrpPaise: number | undefined;
    let shippingPaise: number | undefined;
    try {
      sellingPricePaise = rupeesToPaise(price);
      mrpPaise =
        b.maximumRetailPrice?.amount !== undefined
          ? rupeesToPaise(b.maximumRetailPrice.amount)
          : undefined;
      shippingPaise =
        ship?.shippingCharges?.amount !== undefined
          ? rupeesToPaise(ship.shippingCharges.amount)
          : undefined;
    } catch {
      return null;
    }
    const variant: Record<string, string> = {};
    for (const key of ["color", "size", "storage", "displaySize", "sizeUnit"]) {
      const v = b.attributes?.[key];
      if (typeof v === "string" && v.trim()) variant[key] = v.trim();
    }
    const image = b.imageUrls?.["400x400"] ?? b.imageUrls?.["800x800"] ?? b.imageUrls?.["200x200"];
    const now = this.config.now?.() ?? new Date();
    return {
      sourceId: this.id,
      externalId: b.productId,
      title: b.title,
      brand: b.productBrand,
      productUrl: b.productUrl,
      ...(image && /^https?:\/\//.test(image) ? { imageUrl: image } : {}),
      ...(b.categoryPath
        ? {
            categoryPath: b.categoryPath
              .split(/\s*>\s*/)
              .filter(Boolean)
              .slice(0, 10),
          }
        : {}),
      sellingPricePaise,
      ...(mrpPaise !== undefined ? { mrpPaise } : {}),
      ...(shippingPaise !== undefined ? { shippingPaise } : {}),
      priceType: "LISTED",
      currency: "INR",
      ...(ship?.sellerName ? { sellerName: ship.sellerName } : {}),
      stockStatus:
        b.inStock === true ? "IN_STOCK" : b.inStock === false ? "OUT_OF_STOCK" : "UNKNOWN",
      variant: { attributes: variant },
      promotions: (b.offers ?? [])
        .filter((o) => o.trim())
        .slice(0, 50)
        .map((o) => ({ type: classify(o), description: o.trim().slice(0, 500) })),
      observedAt: now,
      provenance: { method: "AFFILIATE_FEED", provider: PROVIDER, operation, retrievedAt: now },
    };
  }

  async search(
    request: ValidSearchRequest,
    ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput> {
    const operation = "GET /1.0/search.json";
    const body = searchResponse.safeParse(
      await this.get(
        "/1.0/search.json",
        { query: request.query, resultCount: String(Math.min(request.limit, MAX_RESULTS)) },
        ctx.signal,
      ),
    );
    if (!body.success)
      throw new ConnectorError("INVALID_RESPONSE", "Unexpected Flipkart search response", {
        retryable: false,
      });
    // Unmappable entries are passed through as-is so the executor counts them as rejected.
    const items = body.data.productInfoList.map((raw) => this.toItem(raw, operation) ?? raw);
    return { sourceId: this.id, items, fetchedAt: new Date() };
  }

  /**
   * Discounted, in-stock products from the category product feeds: the first call reads the
   * feed listing, then each call fetches one feed page (≤ 500 items) and keeps only those at
   * least `minDiscountBp` below MRP. The cursor walks every category's feed via `nextUrl`.
   */
  async fetchDeals(request: DealFeedRequest, ctx: ConnectorCallContext): Promise<DealFeedPage> {
    let cursor: z.infer<typeof dealCursor>;
    if (request.cursor) {
      const parsed = dealCursor.safeParse(JSON.parse(request.cursor));
      if (!parsed.success)
        throw new ConnectorError("INVALID_RESPONSE", "Invalid Flipkart deals cursor", {
          retryable: false,
        });
      cursor = parsed.data;
    } else {
      const listing = feedListing.safeParse(
        await this.get(
          `/api/${encodeURIComponent(this.config.affiliateId ?? "")}.json`,
          {},
          ctx.signal,
        ),
      );
      if (!listing.success)
        throw new ConnectorError("INVALID_RESPONSE", "Unexpected Flipkart feed listing", {
          retryable: false,
        });
      const urls = Object.values(listing.data.apiGroups.affiliate.apiListings)
        .map((c) => {
          const variants = c.availableVariants;
          // Prefer the newest documented version.
          const key = Object.keys(variants).sort().reverse()[0];
          return key ? variants[key]!.get : undefined;
        })
        .filter((u): u is string => typeof u === "string")
        .slice(0, 500);
      cursor = { urls, i: 0 };
    }
    const fetchedAt = new Date();
    const url = cursor.next ?? cursor.urls[cursor.i];
    if (!url) return { sourceId: this.id, items: [], fetchedAt };
    const withStock = new URL(url);
    if (!cursor.next) withStock.searchParams.set("inStock", "true");
    const page = feedPage.safeParse(await this.getUrl(withStock.toString(), ctx.signal));
    if (!page.success)
      throw new ConnectorError("INVALID_RESPONSE", "Unexpected Flipkart feed page", {
        retryable: false,
      });
    const operation = "GET /1.0/feeds/{trackingId}/category/{category}.json";
    const items = page.data.productInfoList
      .map((raw) => this.toItem(raw, operation))
      .filter(
        (i): i is NormalizedProductInput =>
          i !== null &&
          i.stockStatus === "IN_STOCK" &&
          i.mrpPaise !== undefined &&
          i.mrpPaise > i.sellingPricePaise &&
          ((i.mrpPaise - i.sellingPricePaise) * 10_000) / i.mrpPaise >= request.minDiscountBp,
      );
    const next: z.infer<typeof dealCursor> | null = page.data.nextUrl
      ? { urls: cursor.urls, i: cursor.i, next: page.data.nextUrl }
      : cursor.i + 1 < cursor.urls.length
        ? { urls: cursor.urls, i: cursor.i + 1 }
        : null;
    return {
      sourceId: this.id,
      items,
      ...(next ? { nextCursor: JSON.stringify(next) } : {}),
      fetchedAt,
    };
  }

  async getProduct(
    externalId: string,
    ctx: ConnectorCallContext,
  ): Promise<NormalizedProductInput | null> {
    const raw = await this.get("/1.0/product.json", { id: externalId }, ctx.signal);
    return this.toItem(raw, "GET /1.0/product.json");
  }

  /** No documented health endpoint: a minimal 1-result search proves auth + availability. */
  async getHealth(ctx: ConnectorCallContext): Promise<ConnectorHealth> {
    const started = Date.now();
    await this.get("/1.0/search.json", { query: "mobile", resultCount: "1" }, ctx.signal);
    return { status: "HEALTHY", checkedAt: new Date(), latencyMs: Date.now() - started };
  }
}
