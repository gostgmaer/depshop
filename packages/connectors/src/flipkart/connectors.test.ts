/**
 * Marketplace connector tests. The Flipkart fixture mirrors the field names
 * of Flipkart's PUBLISHED response sample; its values are invented test data
 * (not a real product, price or token). No network is used.
 */
import { describe, expect, it } from "vitest";
import { AmazonCreatorsConnector } from "../amazon/amazon-connector.js";
import { validateResult } from "../core/executor/executor.js";
import { rupeesToPaise, toOfferConditions, toSourceListing } from "../core/normalizers/offers.js";
import { ConnectorError } from "../core/types/errors.js";
import { normalizedProductSchema } from "../core/types/schemas.js";
import { cromaConnector } from "../croma/partner-pending-connector.js";
import { createDefaultRegistry } from "../default-registry.js";
import { relianceDigitalConnector } from "../reliance/index.js";
import { tataCliqConnector } from "../tatacliq/index.js";
import { WebDiscoveryConnector } from "../web-discovery/web-discovery-connector.js";
import { FLIPKART_API_BASE, FlipkartConnector } from "./flipkart-connector.js";

const FIXTURE = {
  productInfoList: [
    {
      productBaseInfoV1: {
        productId: "TESTFIXTURE0001",
        title: "Acme Nova 7 5G (Glacier Blue, 128 GB)",
        productDescription: "Test fixture",
        imageUrls: { "400x400": "https://img.example.test/400.jpg" },
        maximumRetailPrice: { amount: 24999.0, currency: "INR" },
        flipkartSellingPrice: { amount: 19999.0, currency: "INR" },
        flipkartSpecialPrice: { amount: 18999.5, currency: "INR" },
        productUrl: "https://dl.flipkart.com/dl/test-fixture/p/itm0001?affid=test",
        productBrand: "Acme",
        inStock: true,
        codAvailable: true,
        discountPercentage: 24.0,
        offers: ["10% off on Test Bank Credit Cards", "Extra ₹1000 off on exchange", "No cost EMI"],
        categoryPath: "Mobiles>Smartphones",
        attributes: {
          size: "",
          color: "Glacier Blue",
          storage: "128 GB",
          sizeUnit: "",
          displaySize: "6.5 inch",
        },
      },
      productShippingInfoV1: {
        shippingCharges: { amount: 0.0, currency: "INR" },
        sellerName: "TestRetail",
      },
    },
    {
      productBaseInfoV1: {
        productId: "NOPRICE",
        title: "No price item",
        productUrl: "https://dl.flipkart.com/x",
        productBrand: "Acme",
      },
    },
    {
      productBaseInfoV1: {
        productId: "USD",
        title: "Dollar item",
        productUrl: "https://dl.flipkart.com/y",
        productBrand: "Acme",
        flipkartSellingPrice: { amount: 10, currency: "USD" },
      },
    },
  ],
};

function fakeFetch(
  status: number,
  body: unknown,
  seen: { url?: string; headers?: Record<string, string> } = {},
) {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = init?.headers as Record<string, string>;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const ctx = () => ({ signal: new AbortController().signal });
const request = { query: "acme nova", limit: 20, locale: "en-IN" as const };

describe("Flipkart Affiliate API 1.0 connector (documented contract; not live-verified)", () => {
  it("is PENDING_CREDENTIALS without credentials and never calls the network", async () => {
    let called = false;
    const c = new FlipkartConnector({
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    expect(c.getReadiness()).toEqual({
      state: "PENDING_CREDENTIALS",
      missing: ["FLIPKART_AFFILIATE_ID", "FLIPKART_AFFILIATE_TOKEN"],
    });
    await expect(c.search(request, ctx())).rejects.toMatchObject({ category: "NOT_CONFIGURED" });
    expect(called).toBe(false);
  });

  it("calls the documented endpoint/headers and maps the documented fields to paise", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const c = new FlipkartConnector({
      affiliateId: "aff",
      token: "tok",
      fetch: fakeFetch(200, FIXTURE, seen),
    });
    const raw = await c.search(request, ctx());
    expect(seen.url).toBe(`${FLIPKART_API_BASE}/1.0/search.json?query=acme+nova&resultCount=10`);
    expect(seen.headers).toMatchObject({ "Fk-Affiliate-Id": "aff", "Fk-Affiliate-Token": "tok" });
    const result = validateResult(raw, "flipkart", 20);
    expect(result.rejectedItems).toBe(2); // no price, non-INR
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      externalId: "TESTFIXTURE0001",
      brand: "Acme",
      sellingPricePaise: 1_899_950, // special price ₹18,999.50
      mrpPaise: 2_499_900,
      shippingPaise: 0,
      priceType: "LISTED",
      stockStatus: "IN_STOCK",
      sellerName: "TestRetail",
      categoryPath: ["Mobiles", "Smartphones"],
      variant: {
        attributes: { color: "Glacier Blue", storage: "128 GB", displaySize: "6.5 inch" },
      },
      provenance: {
        method: "AFFILIATE_FEED",
        provider: "flipkart-affiliate-1.0",
        operation: "GET /1.0/search.json",
      },
    });
    expect(result.items[0]!.promotions.map((p) => p.type)).toEqual([
      "BANK_OFFER",
      "EXCHANGE",
      "OTHER",
    ]);
  });

  it("maps HTTP errors to categories without leaking the token", async () => {
    const make = (status: number) =>
      new FlipkartConnector({
        affiliateId: "aff",
        token: "secret-token",
        fetch: fakeFetch(status, {}),
      });
    for (const [status, category, retryable] of [
      [401, "AUTH", false],
      [429, "RATE_LIMITED", true],
      [503, "UPSTREAM", true],
      [400, "UPSTREAM", false],
    ] as const) {
      const err = (await make(status)
        .search(request, ctx())
        .catch((e: unknown) => e)) as ConnectorError;
      expect([err.category, err.retryable], String(status)).toEqual([category, retryable]);
      expect(err.message).not.toContain("secret-token");
    }
  });
});

describe("pending marketplaces (no invented endpoints)", () => {
  it("Amazon: PENDING_CREDENTIALS without credentials; with them still pending (client unverified), and never searches", async () => {
    const none = new AmazonCreatorsConnector({});
    expect(none.getReadiness()).toMatchObject({ state: "PENDING_CREDENTIALS" });
    const withCreds = new AmazonCreatorsConnector({
      credentialId: "a",
      credentialSecret: "b",
      partnerTag: "c",
    });
    expect(withCreds.getReadiness()).toMatchObject({ state: "PENDING_APPROVAL" });
    expect(withCreds.getCapabilities().search).toBe(false);
    await expect(withCreds.search(request, ctx())).rejects.toMatchObject({
      category: "NOT_SUPPORTED",
    });
  });

  it("Croma, Reliance Digital and Tata CLiQ await partner approval and never search", async () => {
    for (const c of [cromaConnector(), relianceDigitalConnector(), tataCliqConnector()]) {
      expect(c.getReadiness().state).toBe("PENDING_APPROVAL");
      await expect(c.search(request, ctx())).rejects.toMatchObject({ category: "NOT_SUPPORTED" });
      expect((await c.getHealth()).status).toBe("UNKNOWN");
    }
  });

  it("web discovery needs an authorized provider and only yields INDICATIVE prices", async () => {
    expect(new WebDiscoveryConnector().getReadiness()).toMatchObject({
      state: "PENDING_CREDENTIALS",
    });
    const c = new WebDiscoveryConnector({
      id: "test-provider",
      search: async () => [
        {
          title: "Acme Nova 7 5G",
          url: "https://shop.example.test/p/1",
          brand: "Acme",
          pricePaise: 1_899_900,
        },
        { title: "Snippet without price", url: "https://shop.example.test/p/2" },
      ],
    });
    const result = validateResult(await c.search(request, ctx()), "web_discovery", 20);
    expect(result.items).toHaveLength(1);
    expect(result.rejectedItems).toBe(1);
    expect(result.items[0]).toMatchObject({
      priceType: "INDICATIVE",
      provenance: { method: "DISCOVERY" },
    });
    expect(() => toSourceListing(result.items[0]!)).toThrow(/Indicative/);
  });

  it("default registry contains every target marketplace; mocks only outside production", () => {
    const dev = createDefaultRegistry({ NODE_ENV: "development" });
    expect(
      dev
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(
      [
        "amazon_in",
        "croma",
        "flipkart",
        "mock_alpha",
        "mock_beta",
        "reliance_digital",
        "tata_cliq",
        "web_discovery",
      ].sort(),
    );
    const prod = createDefaultRegistry({ NODE_ENV: "production" });
    expect(prod.list().some((c) => c.isMock)).toBe(false);
    expect(() => createDefaultRegistry({ NODE_ENV: "production" }, { includeMocks: true })).toThrow(
      /production/,
    );
    expect(dev.get("flipkart")?.getReadiness().state).toBe("PENDING_CREDENTIALS");
  });
});

describe("offer normalization", () => {
  it("converts rupees to paise exactly", () => {
    expect(rupeesToPaise(18999.5)).toBe(1_899_950);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise("₹1,24,999.00")).toBe(12_499_900);
    expect(() => rupeesToPaise(-1)).toThrow(ConnectorError);
    expect(() => rupeesToPaise("free")).toThrow(ConnectorError);
  });

  it("keeps conditional benefits apart from the price and maps to the catalog listing", () => {
    const now = new Date();
    const p = normalizedProductSchema.parse({
      sourceId: "flipkart",
      externalId: "X1",
      title: "Acme Nova 7 5G (Glacier Blue, 128 GB)",
      brand: "Acme",
      productUrl: "https://www.flipkart.com/p/x1",
      sellingPricePaise: 1_899_900,
      mrpPaise: 2_499_900,
      priceType: "LISTED",
      currency: "INR",
      stockStatus: "IN_STOCK",
      variant: { attributes: { color: "Glacier Blue", storage: "128 GB" } },
      promotions: [
        {
          type: "BANK_OFFER",
          description: "10% off with Test Bank",
          percentBasisPoints: 1_000,
          maxAmountPaise: 150_000,
        },
        { type: "COUPON", description: "Coupon ₹500", amountPaise: 50_000, code: "SAVE500" },
        { type: "EXCHANGE", description: "Up to ₹10,000 on exchange", maxAmountPaise: 1_000_000 },
      ],
      observedAt: now,
      provenance: {
        method: "AFFILIATE_FEED",
        provider: "flipkart-affiliate-1.0",
        retrievedAt: now,
      },
    });
    const conditions = toOfferConditions(p);
    expect(conditions.bankOffers).toHaveLength(1);
    expect(conditions.coupons[0]).toMatchObject({ code: "SAVE500", amountPaise: 50_000 });
    expect(conditions.exchange).toHaveLength(1);
    expect(conditions.priceType).toBe("LISTED");
    const listing = toSourceListing(p, "smartphones");
    // The selling price is NOT reduced by any conditional benefit.
    expect(listing).toMatchObject({
      sellingPricePaise: 1_899_900,
      mrpPaise: 2_499_900,
      categorySlug: "smartphones",
    });
    expect(listing.attributes).toEqual({ color: "Glacier Blue", storage: "128 GB" });
  });
});
