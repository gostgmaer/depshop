/** Unique and CHECK constraints, exercised with real writes. */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCatalog,
  createUser,
  expectCheckViolation,
  expectPrismaCode,
  iamTokenFields,
  testPrisma,
  truncateAll,
} from "./helpers.js";

/** Required notification fields (category + verified source + dedupe key). */
const SOURCE = (key: string) =>
  ({
    category: "ACCOUNT",
    sourceType: "ACCOUNT",
    sourceId: key,
    dedupeKey: `test:${key}`,
  }) as const;

const prisma: PrismaClient = testPrisma();
afterAll(() => prisma.$disconnect());

let user: { id: string };
let catalog: Awaited<ReturnType<typeof createCatalog>>;

beforeEach(async () => {
  await truncateAll(prisma);
  user = await createUser(prisma);
  catalog = await createCatalog(prisma);
});

describe("identity", () => {
  it("enforces unique, lower-case, well-formed emails", async () => {
    await createUser(prisma, { email: "asha@example.com" });
    await expectPrismaCode(createUser(prisma, { email: "asha@example.com" }), "P2002");
    await expectCheckViolation(
      createUser(prisma, { email: "Asha@Example.com" }),
      "User_email_lowercase_check",
    );
    await expectCheckViolation(
      createUser(prisma, { email: "not-an-email" }),
      "User_email_format_check",
    );
    await expectCheckViolation(createUser(prisma, { name: "   " }), "User_name_not_blank_check");
  });

  it("links each local user to exactly one IAM identity", async () => {
    const iamUserId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    await createUser(prisma, { iamUserId });
    await expectPrismaCode(createUser(prisma, { iamUserId }), "P2002");
  });

  it("allows at most one preference row and one subscription per user", async () => {
    await prisma.userPreference.create({ data: { userId: user.id } });
    await expectPrismaCode(prisma.userPreference.create({ data: { userId: user.id } }), "P2002");

    await prisma.subscriptionPlan.create({
      data: { code: "FREE", name: "Free", monthlyPricePaise: 0, limits: {} },
    });
    await prisma.subscription.create({ data: { userId: user.id } });
    await expectPrismaCode(prisma.subscription.create({ data: { userId: user.id } }), "P2002");
  });

  it("requires session expiry after creation", async () => {
    await expectCheckViolation(
      prisma.userSession.create({
        data: {
          userId: user.id,
          tokenHash: "h",
          familyId: user.id,
          expiresAt: new Date(0),
          ...iamTokenFields(),
        },
      }),
      "UserSession_expiry_check",
    );
  });
});

describe("catalog & shopping", () => {
  const offerBase = () => ({
    productId: catalog.product.id,
    variantId: catalog.variant.id,
    sourceId: catalog.source.id,
    productUrl: "https://example.test/x",
    title: "x",
  });

  it("rejects negative prices, MRPs and shipping in offers and snapshots", async () => {
    const base = offerBase();
    await expectCheckViolation(
      prisma.productOffer.create({ data: { ...base, externalId: "n1", sellingPricePaise: -1n } }),
      "ProductOffer_price_check",
    );
    await expectCheckViolation(
      prisma.productOffer.create({
        data: { ...base, externalId: "n2", sellingPricePaise: 100n, mrpPaise: -5n },
      }),
      "ProductOffer_mrp_check",
    );
    await expectCheckViolation(
      prisma.productOffer.create({
        data: { ...base, externalId: "n3", sellingPricePaise: 100n, shippingPaise: -1n },
      }),
      "ProductOffer_shipping_check",
    );
    await expectCheckViolation(
      prisma.priceSnapshot.create({
        data: { offerId: catalog.offer.id, sellingPricePaise: -1n, stockStatus: "IN_STOCK" },
      }),
      "PriceSnapshot_price_check",
    );
    // A free item (0 paise) is valid.
    await expect(
      prisma.productOffer.create({ data: { ...base, externalId: "free", sellingPricePaise: 0n } }),
    ).resolves.toBeDefined();
  });

  it("stores prices above the 32-bit range as BIGINT paise", async () => {
    // ₹2.5 crore = 2_500_000_000 paise > 2^31-1.
    const offer = await prisma.productOffer.create({
      data: { ...offerBase(), externalId: "big", sellingPricePaise: 2_500_000_000n },
    });
    expect(offer.sellingPricePaise).toBe(2_500_000_000n);
  });

  it("is INR-only, with confidence in basis points and object-shaped conditions", async () => {
    const base = offerBase();
    await expectCheckViolation(
      prisma.productOffer.create({
        data: { ...base, externalId: "usd", sellingPricePaise: 1n, currency: "USD" },
      }),
      "ProductOffer_currency_check",
    );
    await expectCheckViolation(
      prisma.productOffer.create({
        data: { ...base, externalId: "conf", sellingPricePaise: 1n, matchConfidence: 10_001 },
      }),
      "ProductOffer_match_confidence_check",
    );
    await expectCheckViolation(
      prisma.productOffer.create({
        data: { ...base, externalId: "cond", sellingPricePaise: 1n, offerConditions: [1] },
      }),
      "ProductOffer_conditions_object_check",
    );
  });

  it("rejects non-http offer URLs (no javascript:/data: links)", async () => {
    await expectCheckViolation(
      prisma.productOffer.create({
        data: {
          ...offerBase(),
          externalId: "js",
          productUrl: "javascript:alert(1)",
          sellingPricePaise: 1n,
        },
      }),
      "ProductOffer_url_check",
    );
  });

  it("requires an offer's product to be its variant's product (composite FK)", async () => {
    const other = await prisma.product.create({
      data: { name: "Other", normalizedName: "other", brand: "Acme" },
    });
    await expectPrismaCode(
      prisma.productOffer.create({
        data: {
          ...offerBase(),
          productId: other.id,
          externalId: "mismatch",
          sellingPricePaise: 1n,
        },
      }),
      "P2003",
    );
  });

  it("de-duplicates offers per source and variants per product", async () => {
    await expectPrismaCode(
      prisma.productOffer.create({
        data: {
          ...offerBase(),
          externalId: catalog.offer.externalId,
          productUrl: "https://example.test/dup",
          sellingPricePaise: 1n,
        },
      }),
      "P2002",
    );
    await expectPrismaCode(
      prisma.productVariant.create({
        data: { productId: catalog.product.id, variantKey: catalog.variant.variantKey },
      }),
      "P2002",
    );
  });

  it("keeps price history append-only (UPDATE rejected, INSERT allowed)", async () => {
    const snap = await prisma.priceSnapshot.create({
      data: { offerId: catalog.offer.id, sellingPricePaise: 100n, stockStatus: "IN_STOCK" },
    });
    const error = await prisma.priceSnapshot
      .update({ where: { id: snap.id }, data: { sellingPricePaise: 1n } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(String((error as Error | undefined)?.message)).toContain("append-only");
    const row = await prisma.priceSnapshot.findUniqueOrThrow({ where: { id: snap.id } });
    expect(row.sellingPricePaise).toBe(100n);
  });

  it("validates source slug, domain and tuning", async () => {
    const base = {
      name: "S",
      domain: "s.test",
      baseUrl: "https://s.test",
      integrationKind: "PARTNER" as const,
    };
    await expectCheckViolation(
      prisma.shoppingSource.create({ data: { ...base, slug: "bad slug" } }),
      "ShoppingSource_slug_format_check",
    );
    await expectCheckViolation(
      prisma.shoppingSource.create({ data: { ...base, slug: "s0", domain: "https://s.test/" } }),
      "ShoppingSource_domain_check",
    );
    await expectCheckViolation(
      prisma.shoppingSource.create({ data: { ...base, slug: "s1", timeoutMs: 10 } }),
      "ShoppingSource_timeout_check",
    );
    await expectCheckViolation(
      prisma.shoppingSource.create({ data: { ...base, slug: "s2", maxRetries: 50 } }),
      "ShoppingSource_retries_check",
    );
  });

  it("validates product names, identifiers and JSON shapes", async () => {
    const base = { normalizedName: "t", brand: "b" };
    await expectCheckViolation(
      prisma.product.create({ data: { ...base, name: "t", specifications: [1, 2] } }),
      "Product_specs_object_check",
    );
    await expectCheckViolation(
      prisma.product.create({ data: { ...base, name: "   " } }),
      "Product_name_not_blank_check",
    );
    await expectCheckViolation(
      prisma.product.create({ data: { ...base, name: "t", gtin: "12AB" } }),
      "Product_gtin_format_check",
    );
    await expectCheckViolation(
      prisma.product.create({ data: { ...base, name: "t", ean: "123" } }),
      "Product_ean_format_check",
    );
    await expectCheckViolation(
      prisma.product.create({ data: { ...base, name: "t", upc: "1234567890123" } }),
      "Product_upc_format_check",
    );
    // Identifiers are unique when present; many products may have none.
    await prisma.product.create({ data: { ...base, name: "a", ean: "8901234567890" } });
    await expectPrismaCode(
      prisma.product.create({ data: { ...base, name: "b", ean: "8901234567890" } }),
      "P2002",
    );
    await prisma.product.create({ data: { ...base, name: "c" } });
    await prisma.product.create({ data: { ...base, name: "d" } });
  });

  it("prevents a category from being its own parent", async () => {
    const c = await prisma.category.create({ data: { slug: "c", name: "C" } });
    await expectCheckViolation(
      prisma.category.update({ where: { id: c.id }, data: { parentId: c.id } }),
      "Category_not_own_parent_check",
    );
  });
});

describe("search", () => {
  it("requires 1-based, unique ranks within a search", async () => {
    const search = await prisma.search.create({ data: { userId: user.id, query: "q" } });
    const base = { userId: user.id, searchId: search.id, score: 1, pricePaiseAtSearch: 1 };
    await expectCheckViolation(
      prisma.searchResult.create({ data: { ...base, offerId: catalog.offer.id, rank: 0 } }),
      "SearchResult_rank_check",
    );
    await prisma.searchResult.create({ data: { ...base, offerId: catalog.offer.id, rank: 1 } });
    await expectPrismaCode(
      prisma.searchResult.create({ data: { ...base, offerId: catalog.offer.id, rank: 2 } }),
      "P2002",
    );
  });
});

describe("user features", () => {
  it("watchlist names are unique per user, not globally", async () => {
    const other = await createUser(prisma);
    await prisma.watchlist.create({ data: { userId: user.id, name: "Diwali" } });
    await expect(
      prisma.watchlist.create({ data: { userId: other.id, name: "Diwali" } }),
    ).resolves.toBeDefined();
    await expectPrismaCode(
      prisma.watchlist.create({ data: { userId: user.id, name: "Diwali" } }),
      "P2002",
    );
  });

  it("allows one alert per user/variant/source, treating 'any source' (NULL) as one value", async () => {
    const base = { userId: user.id, variantId: catalog.variant.id, targetPricePaise: 1_500_000 };
    await prisma.priceAlert.create({ data: base });
    await expectPrismaCode(prisma.priceAlert.create({ data: base }), "P2002");
    await prisma.priceAlert.create({ data: { ...base, sourceId: catalog.source.id } });
    await expectPrismaCode(
      prisma.priceAlert.create({ data: { ...base, sourceId: catalog.source.id } }),
      "P2002",
    );
  });

  it("requires a positive alert target", async () => {
    await expectCheckViolation(
      prisma.priceAlert.create({
        data: { userId: user.id, variantId: catalog.variant.id, targetPricePaise: 0 },
      }),
      "PriceAlert_target_check",
    );
  });

  it("requires sentAt for SENT deliveries and one delivery per channel", async () => {
    const n = await prisma.notification.create({
      data: { userId: user.id, type: "SYSTEM", title: "t", body: "b", ...SOURCE("c1") },
    });
    await expectCheckViolation(
      prisma.notificationDelivery.create({
        data: { userId: user.id, notificationId: n.id, channel: "EMAIL", status: "SENT" },
      }),
      "NotificationDelivery_sent_at_check",
    );
    await prisma.notificationDelivery.create({
      data: { userId: user.id, notificationId: n.id, channel: "EMAIL" },
    });
    await expectPrismaCode(
      prisma.notificationDelivery.create({
        data: { userId: user.id, notificationId: n.id, channel: "EMAIL" },
      }),
      "P2002",
    );
  });
});

describe("AI & monetization", () => {
  it("requires finishedAt once an agent run is no longer RUNNING", async () => {
    await expectCheckViolation(
      prisma.agentRun.create({
        data: { userId: user.id, graph: "g", model: "m", input: {}, status: "SUCCEEDED" },
      }),
      "AgentRun_finished_check",
    );
  });

  it("rejects non-positive usage quantities", async () => {
    await expectCheckViolation(
      prisma.usageRecord.create({ data: { userId: user.id, metric: "SEARCH", quantity: 0 } }),
      "UsageRecord_quantity_check",
    );
  });

  it("makes billing webhooks idempotent and amounts non-negative", async () => {
    const evt = {
      userId: user.id,
      type: "PAYMENT_SUCCEEDED" as const,
      provider: "razorpay",
      providerEventId: "evt_123",
      amountPaise: 19_900,
      occurredAt: new Date(),
    };
    await prisma.billingEvent.create({ data: evt });
    await expectPrismaCode(prisma.billingEvent.create({ data: evt }), "P2002");
    await expectCheckViolation(
      prisma.billingEvent.create({ data: { ...evt, providerEventId: "evt_neg", amountPaise: -1 } }),
      "BillingEvent_amount_check",
    );
  });

  it("stores large affiliate aggregates as BigInt paise", async () => {
    const conv = await prisma.affiliateConversion.create({
      data: {
        sourceId: catalog.source.id,
        externalOrderRef: "ord-1",
        orderAmountPaise: 9_000_000_000_00n, // ₹9,000 crore, beyond 32-bit range
        commissionPaise: 45_000_000_00n,
        reportedAt: new Date(),
      },
    });
    expect(conv.orderAmountPaise).toBe(9_000_000_000_00n);
  });
});

describe("notifications (Phase 5.3)", () => {
  it("allows only relative in-app links and one notification per user per event", async () => {
    await expectCheckViolation(
      prisma.notification.create({
        data: {
          userId: user.id,
          type: "SYSTEM",
          title: "t",
          body: "b",
          link: "//evil.example/x",
          ...SOURCE("l1"),
        },
      }),
      "Notification_link_relative",
    );
    await prisma.notification.create({
      data: { userId: user.id, type: "SYSTEM", title: "t", body: "b", ...SOURCE("d1") },
    });
    await expect(
      prisma.notification.create({
        data: { userId: user.id, type: "SYSTEM", title: "t", body: "b", ...SOURCE("d1") },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("requires HTTPS push endpoints and well-formed quiet hours", async () => {
    await expectCheckViolation(
      prisma.pushSubscription.create({
        data: { userId: user.id, endpoint: "http://push.example/x", p256dh: "p", auth: "a" },
      }),
      "PushSubscription_https",
    );
    await expectCheckViolation(
      prisma.userPreference.create({
        data: { userId: user.id, quietHoursStart: "22:00", quietHoursEnd: null },
      }),
      "UserPreference_quiet_hours",
    );
    await expectCheckViolation(
      prisma.userPreference.create({
        data: { userId: user.id, quietHoursStart: "24:00", quietHoursEnd: "07:00" },
      }),
      "UserPreference_quiet_hours",
    );
  });
});
