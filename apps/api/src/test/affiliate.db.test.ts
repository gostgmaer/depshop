/**
 * Phase 6.2 API: outbound clicks (validated destinations, affiliate tags only
 * when enabled and configured, privacy-aware click records, dedupe),
 * partner-reported conversions (Flipkart Report API with a scripted fetch,
 * manual partner reports), payouts, admin analytics and ranking independence.
 * Listings are fictional ("Acme"); no partner is called.
 */
import { AffiliateRegistry, applyClickRetention } from "@dealmind/affiliate";
import type { SourceListing } from "@dealmind/catalog";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { CatalogImporter } from "@dealmind/intelligence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Agent} from "./harness.js";
import {
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;
let flipkartResponses: Record<string, unknown[]> = {};
let flipkartFail = false;
const flipkartFetch = (async (url: URL | string) => {
  if (flipkartFail) return new Response("upstream error", { status: 500 });
  const u = new URL(String(url));
  const key = `${u.searchParams.get("status")}:${u.searchParams.get("offset")}`;
  return new Response(JSON.stringify({ orderList: flipkartResponses[key] ?? [] }), { status: 200 });
}) as typeof fetch;

beforeAll(async () => {
  ctx = await createTestApp(
    {},
    {
      affiliateRegistry: new AffiliateRegistry({
        amazonPartnerTag: "dealmindtest-21",
        flipkartAffiliateId: "dealmindfk",
        flipkartAffiliateToken: "token-not-real",
      }),
      affiliateFetch: flipkartFetch,
    },
  );
});
afterAll(() => ctx.close());

let amazonOffer: string;
let flipkartOffer: string;
let sampleOffer: string;
let productId: string;
let flipkartSourceId: string;

const listing = (url: string, id: string, over: Partial<SourceListing> = {}): SourceListing => ({
  externalId: id,
  title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
  productUrl: url,
  brand: "Acme",
  categorySlug: "smartphones",
  sellingPricePaise: 3_100_000,
  mrpPaise: 3_499_900,
  shippingPaise: 0,
  stockStatus: "IN_STOCK",
  ...over,
});

beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
  flipkartResponses = {};
  flipkartFail = false;
  // Test database only: the fictional listings need ACTIVE sources to import.
  await ctx.prisma.shoppingSource.updateMany({
    where: { slug: { in: ["amazon_in", "flipkart"] } },
    data: { status: "ACTIVE" },
  });
  const importer = new CatalogImporter(ctx.prisma);
  const a = (
    await importer.importListings("amazon_in", [
      listing("https://www.amazon.in/dp/B0ACMETEST?th=1", "B0ACMETEST"),
    ])
  ).outcomes[0]!;
  const f = (
    await importer.importListings("flipkart", [
      listing("https://www.flipkart.com/acme-nova-7/p/itmacme1", "itmacme1"),
    ])
  ).outcomes[0]!;
  const s = (
    await importer.importListings("mock_alpha", [
      listing("https://mock-alpha.example.com/p/1", "m1"),
    ])
  ).outcomes[0]!;
  if (a.status !== "imported" || f.status !== "imported" || s.status !== "imported")
    throw new Error("import failed");
  amazonOffer = a.offerId;
  flipkartOffer = f.offerId;
  sampleOffer = s.offerId;
  productId = a.productId;
  await ctx.prisma.shoppingSource.updateMany({
    where: { slug: { in: ["amazon_in", "flipkart"] } },
    data: { affiliateEnabled: true },
  });
  flipkartSourceId = (
    await ctx.prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "flipkart" } })
  ).id;
});

const click = (
  offerId: string,
  opts: { from?: string; agent?: Agent; headers?: Record<string, string> } = {},
) =>
  opts.agent
    ? opts.agent.get(`/api/v1/affiliate/click/${offerId}${opts.from ? `?from=${opts.from}` : ""}`)
    : ctx.app.inject({
        method: "GET",
        url: `/api/v1/affiliate/click/${offerId}${opts.from ? `?from=${opts.from}` : ""}`,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0)", ...opts.headers },
      });

describe("1–4, 13. links, destinations and redirects", () => {
  it("adds the configured tag only for enabled programs and records the click", async () => {
    const res = await click(amazonOffer, {
      from: "product",
      headers: { referer: "https://www.google.com/search?q=secret" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      "https://www.amazon.in/dp/B0ACMETEST?th=1&tag=dealmindtest-21",
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    const row = await ctx.prisma.affiliateClick.findFirstOrThrow();
    expect(row).toMatchObject({
      offerId: amazonOffer,
      productId,
      provider: "amazon-associates",
      trackingId: "dealmindtest-21",
      destinationDomain: "www.amazon.in",
      redirectStatus: "REDIRECTED",
      surface: "product",
      referrerDomain: "www.google.com",
      userId: null,
      userAgent: "desktop",
    });
    expect(row.ipHash).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(row.ipHash).not.toContain("127.0.0.1");

    // Flipkart: affid plus the click reference as affExtParam1.
    const fk = await click(flipkartOffer);
    const fkClick = await ctx.prisma.affiliateClick.findFirstOrThrow({
      where: { offerId: flipkartOffer },
    });
    expect(fk.headers.location).toBe(
      `https://www.flipkart.com/acme-nova-7/p/itmacme1?affid=dealmindfk&affExtParam1=${fkClick.clickRef}`,
    );

    // Disabled by an admin: plain link, no tag.
    await ctx.prisma.shoppingSource.update({
      where: { slug: "amazon_in" },
      data: { affiliateEnabled: false },
    });
    await deleteRedisPrefix(ctx.redis, ctx.prefix);
    const plain = await click(amazonOffer, { headers: { "x-forwarded-for": "10.0.0.9" } });
    expect(plain.headers.location).toBe("https://www.amazon.in/dp/B0ACMETEST?th=1");
  });

  it("rejects invalid ids, sample stores and stored URLs that fail validation (never redirects there)", async () => {
    expect((await click("not-a-uuid")).statusCode).toBe(422);
    expect((await click("0190a000-0000-7000-8000-000000000000")).statusCode).toBe(404);
    const sample = await click(sampleOffer);
    expect(sample.statusCode).toBe(404);
    expect(sample.headers.location).toBeUndefined();
    // A tampered stored URL (other host / http) is blocked and logged as BLOCKED.
    for (const bad of [
      "https://evil.example/dp/X",
      "http://www.amazon.in/dp/X",
      "https://www.amazon.in.evil.example/x",
    ]) {
      await ctx.prisma.productOffer.update({
        where: { id: amazonOffer },
        data: { productUrl: bad },
      });
      const r = await click(amazonOffer);
      expect(r.statusCode, bad).toBe(409);
      expect(r.headers.location).toBeUndefined();
    }
    expect(await ctx.prisma.affiliateClick.count({ where: { redirectStatus: "BLOCKED" } })).toBe(3);
    // Client-supplied destinations aren't accepted at all.
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/affiliate/click/${flipkartOffer}?url=https://evil.example`,
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe("5–7. click tracking", () => {
  it("counts a repeated click once, and attributes signed-in users", async () => {
    await click(amazonOffer);
    await click(amazonOffer);
    expect(await ctx.prisma.affiliateClick.count()).toBe(1);
    const { agent, userId } = await signUp(ctx, "clicker@example.com");
    const r = await click(amazonOffer, { agent, from: "search" });
    expect(r.statusCode).toBe(302);
    expect(await ctx.prisma.affiliateClick.findFirst({ where: { userId } })).toMatchObject({
      surface: "search",
    });
  });

  it("anonymizes identifiers after the retention window and deletes old unconverted clicks", async () => {
    await click(amazonOffer);
    const now = new Date();
    expect(
      await applyClickRetention(ctx.prisma, new Date(now.getTime() + 31 * 86_400_000)),
    ).toEqual({ anonymized: 1, deleted: 0 });
    const row = await ctx.prisma.affiliateClick.findFirstOrThrow();
    expect([row.ipHash, row.userAgent, row.referrerDomain]).toEqual([null, null, null]);
    expect(
      (await applyClickRetention(ctx.prisma, new Date(now.getTime() + 400 * 86_400_000))).deleted,
    ).toBe(1);
  });
});

describe("8–11. provider-reported conversions and payouts", () => {
  it("imports Flipkart orders, matches clicks by sub-id, is idempotent, and records reversals", async () => {
    const { agent: admin } = await signUp(ctx, "admin@example.com", { role: "ADMIN" });
    await click(flipkartOffer);
    const ref = (await ctx.prisma.affiliateClick.findFirstOrThrow()).clickRef;
    const order = (status: string) => ({
      affiliateOrderItemId: "FK-ORDER-1",
      status,
      sales: { amount: 31000, currency: "INR" },
      tentativeCommission: { amount: 372, currency: "INR" },
      orderDate: "11-14-2026",
      affExtParam1: ref,
    });
    flipkartResponses = { "tentative:0": [order("tentative")] };
    const first = await admin.post("/api/v1/admin/affiliates/import/flipkart", {
      startDate: "2026-11-01",
      endDate: "2026-11-15",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      created: 1,
      matchedClicks: 1,
      rejected: [],
    });
    const again = await admin.post("/api/v1/admin/affiliates/import/flipkart", {
      startDate: "2026-11-01",
      endDate: "2026-11-15",
    });
    expect(again.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      created: 0,
      unchanged: 1,
    });
    flipkartResponses = { "cancelled:0": [order("cancelled")] };
    const rev = await admin.post("/api/v1/admin/affiliates/import/flipkart", {
      startDate: "2026-11-01",
      endDate: "2026-11-15",
    });
    expect(rev.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      updated: 1,
      reversed: 1,
    });
    const conv = await ctx.prisma.affiliateConversion.findFirstOrThrow();
    expect(conv).toMatchObject({
      status: "REVERSED",
      commissionPaise: 37_200n,
      orderAmountPaise: 3_100_000n,
      provider: "flipkart-affiliate",
      providerStatus: "cancelled",
    });
    expect(conv.clickId).not.toBeNull();
    expect(await ctx.prisma.affiliateConversion.count()).toBe(1);

    // Provider failure: nothing imported, a clear error.
    flipkartFail = true;
    const fail = await admin.post("/api/v1/admin/affiliates/import/flipkart", {
      startDate: "2026-11-01",
      endDate: "2026-11-15",
    });
    expect(fail.statusCode).toBe(502);
    expect(await ctx.prisma.affiliateConversion.count()).toBe(1);
  });

  it("imports a manual partner report and payouts; refuses sources without a program", async () => {
    const { agent: admin } = await signUp(ctx, "admin2@example.com", { role: "ADMIN" });
    const row = {
      orderRef: "AMZ-1",
      orderAmountPaise: 3_100_000,
      commissionPaise: 31_000,
      status: "APPROVED",
      providerStatus: "Shipped",
      orderedAt: null,
      subId: null,
    };
    const r = await admin.post("/api/v1/admin/affiliates/import/manual", {
      sourceSlug: "amazon_in",
      rows: [row],
    });
    expect(r.json<{ data: Record<string, unknown> }>().data).toMatchObject({ created: 1 });
    expect(
      (
        await admin.post("/api/v1/admin/affiliates/import/manual", {
          sourceSlug: "croma",
          rows: [row],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await admin.post("/api/v1/admin/affiliates/import/manual", {
          sourceSlug: "amazon_in",
          rows: [{ ...row, commissionPaise: 12.5 }],
        })
      ).statusCode,
    ).toBe(422);
    const p = await admin.post("/api/v1/admin/affiliates/payouts", {
      sourceSlug: "amazon_in",
      amountPaise: 31_000,
      status: "PAID",
      payoutReference: "AMZ-PAY-11",
      paidAt: "2026-11-15T00:00:00.000Z",
    });
    expect(p.statusCode).toBe(200);
    expect(
      (
        await admin.post("/api/v1/admin/affiliates/payouts", {
          sourceSlug: "amazon_in",
          amountPaise: 1,
          status: "PAID",
          payoutReference: "X",
        })
      ).statusCode,
    ).toBe(422);
    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: { startsWith: "admin.affiliate" } },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      "admin.affiliate_conversions_imported",
      "admin.affiliate_payout_recorded",
    ]);
  });
});

describe("admin analytics and access", () => {
  it("is admin-only and separates clicks, partner-reported commission states and payouts", async () => {
    const { agent: user } = await signUp(ctx, "user@example.com");
    const { agent: admin } = await signUp(ctx, "boss@example.com", { role: "ADMIN" });
    expect((await user.get("/api/v1/admin/affiliates")).statusCode).toBe(403);
    expect((await user.post("/api/v1/admin/affiliates/payouts", {})).statusCode).toBe(403);
    await click(amazonOffer, { from: "product" });
    await admin.post("/api/v1/admin/affiliates/import/manual", {
      sourceSlug: "amazon_in",
      rows: [
        {
          orderRef: "A",
          orderAmountPaise: 100_00,
          commissionPaise: 5_00,
          status: "PENDING",
          providerStatus: null,
          orderedAt: null,
          subId: null,
        },
        {
          orderRef: "B",
          orderAmountPaise: 200_00,
          commissionPaise: 8_00,
          status: "APPROVED",
          providerStatus: null,
          orderedAt: null,
          subId: null,
        },
      ],
    });
    const res = await admin.get("/api/v1/admin/affiliates?days=30");
    const d = res.json<{
      data: {
        summary: {
          clicks: {
            total: number;
            bySource: { slug: string }[];
            byCategory: { category: string; clicks: number }[];
          };
          conversions: Record<string, { commissionPaise: number }>;
        };
        programs: { slug: string; linksActive: boolean; reporting: string; enabled: boolean }[];
      };
    }>().data;
    expect(d.summary.clicks.total).toBe(1);
    expect(d.summary.clicks.bySource[0]!.slug).toBe("amazon_in");
    expect(d.summary.clicks.byCategory).toEqual([{ category: "Smartphones", clicks: 1 }]);
    expect(d.summary.conversions.PENDING!.commissionPaise).toBe(500);
    expect(d.summary.conversions.APPROVED!.commissionPaise).toBe(800);
    expect(d.programs.find((p) => p.slug === "croma")).toMatchObject({
      linksActive: false,
      reporting: "none",
    });
    expect(d.programs.find((p) => p.slug === "flipkart")).toMatchObject({
      linksActive: true,
      reporting: "api",
      enabled: true,
    });
    expect(res.body).not.toContain("token-not-real");

    const toggled = await admin.request(
      "PATCH",
      `/api/v1/admin/affiliates/sources/${flipkartSourceId}`,
      { affiliateEnabled: false },
    );
    expect(toggled.statusCode).toBe(200);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: "admin.affiliate_source_updated" } }),
    ).toBe(1);
  });
});

describe("14. ranking independence", () => {
  it("prices, rankings and recommendations are identical whether affiliate links are on or off", async () => {
    const pricing = async () =>
      (await ctx.app.inject({ method: "GET", url: `/api/v1/products/${productId}/pricing` })).body;
    const on = await pricing();
    await ctx.prisma.shoppingSource.updateMany({ data: { affiliateEnabled: false } });
    await deleteRedisPrefix(ctx.redis, ctx.prefix);
    const off = await pricing();
    const data = (b: string) => (JSON.parse(b) as { data: unknown }).data;
    expect(data(off)).toEqual(data(on));
    // No field carries affiliate or commission data (the explanation text may say it isn't used).
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
    };
    walk(JSON.parse(on));
    expect(keys.filter((k) => /affiliate|commission/i.test(k))).toEqual([]);
  });
});
