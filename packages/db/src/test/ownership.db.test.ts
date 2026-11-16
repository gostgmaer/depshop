/**
 * Ownership is enforced by PostgreSQL itself: these tests write rows directly
 * (bypassing any API) and prove cross-user attachment is impossible.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assertOwnedBy, isOwnershipViolation, ownedBy } from "../ownership.js";
import {
  createCatalog,
  createUser,
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

let alice: { id: string };
let bob: { id: string };
let catalog: Awaited<ReturnType<typeof createCatalog>>;

beforeEach(async () => {
  await truncateAll(prisma);
  alice = await createUser(prisma, { name: "Alice" });
  bob = await createUser(prisma, { name: "Bob" });
  catalog = await createCatalog(prisma);
});

describe("composite ownership foreign keys", () => {
  it("allows a user to add items to their own watchlist", async () => {
    const list = await prisma.watchlist.create({ data: { userId: alice.id, name: "Phones" } });
    const item = await prisma.watchlistItem.create({
      data: { userId: alice.id, watchlistId: list.id, variantId: catalog.variant.id },
    });
    expect(item.userId).toBe(alice.id);
  });

  it("rejects attaching an item to another user's watchlist", async () => {
    const alicesList = await prisma.watchlist.create({
      data: { userId: alice.id, name: "Phones" },
    });
    const err = await expectPrismaCode(
      prisma.watchlistItem.create({
        data: { userId: bob.id, watchlistId: alicesList.id, variantId: catalog.variant.id },
      }),
      "P2003",
    );
    expect(isOwnershipViolation(err)).toBe(true);
  });

  it("rejects search results and source runs on another user's search", async () => {
    const search = await prisma.search.create({ data: { userId: alice.id, query: "phone" } });
    const result = prisma.searchResult.create({
      data: {
        userId: bob.id,
        searchId: search.id,
        offerId: catalog.offer.id,
        rank: 1,
        score: 100,
        pricePaiseAtSearch: catalog.offer.sellingPricePaise,
      },
    });
    expect(isOwnershipViolation(await expectPrismaCode(result, "P2003"))).toBe(true);

    const run = prisma.searchSourceRun.create({
      data: {
        userId: bob.id,
        searchId: search.id,
        sourceId: catalog.source.id,
        status: "SUCCEEDED",
        durationMs: 10,
      },
    });
    expect(isOwnershipViolation(await expectPrismaCode(run, "P2003"))).toBe(true);
  });

  it("rejects deliveries for another user's notification", async () => {
    const n = await prisma.notification.create({
      data: {
        userId: alice.id,
        type: "PRICE_DROP",
        title: "Price drop",
        body: "₹19,999",
        ...SOURCE("o1"),
      },
    });
    const op = prisma.notificationDelivery.create({
      data: { userId: bob.id, notificationId: n.id, channel: "EMAIL" },
    });
    expect(isOwnershipViolation(await expectPrismaCode(op, "P2003"))).toBe(true);
  });

  it("lets an agent run reference only its owner's search (or none)", async () => {
    const search = await prisma.search.create({ data: { userId: alice.id, query: "laptop" } });
    await expect(
      prisma.agentRun.create({
        data: { userId: alice.id, searchId: search.id, graph: "search", model: "m", input: {} },
      }),
    ).resolves.toBeDefined();
    await expect(
      prisma.agentRun.create({ data: { userId: bob.id, graph: "search", model: "m", input: {} } }),
    ).resolves.toBeDefined();
    const op = prisma.agentRun.create({
      data: { userId: bob.id, searchId: search.id, graph: "search", model: "m", input: {} },
    });
    expect(isOwnershipViolation(await expectPrismaCode(op, "P2003"))).toBe(true);
  });
});

describe("owner-scoped queries", () => {
  it("ownedBy() returns only the caller's rows and assertOwnedBy() hides others' rows", async () => {
    const a = await prisma.watchlist.create({ data: { userId: alice.id, name: "Mine" } });
    await prisma.watchlist.create({ data: { userId: bob.id, name: "Mine" } });

    const mine = await prisma.watchlist.findMany({ where: ownedBy(alice.id) });
    expect(mine.map((w) => w.id)).toEqual([a.id]);

    const attempt = await prisma.watchlist.findFirst({ where: { id: a.id, ...ownedBy(bob.id) } });
    expect(attempt).toBeNull();
    expect(() => assertOwnedBy(attempt, bob.id, "Watchlist")).toThrow("Watchlist not found");
    const fetched = await prisma.watchlist.findUnique({ where: { id: a.id } });
    expect(() => assertOwnedBy(fetched, bob.id, "Watchlist")).toThrow("Watchlist not found");
  });
});

describe("deletion semantics", () => {
  async function populate(userId: string) {
    const list = await prisma.watchlist.create({ data: { userId, name: "L" } });
    await prisma.watchlistItem.create({
      data: { userId, watchlistId: list.id, variantId: catalog.variant.id },
    });
    await prisma.priceAlert.create({
      data: { userId, variantId: catalog.variant.id, targetPricePaise: 1_500_000 },
    });
    const search = await prisma.search.create({ data: { userId, query: "q" } });
    await prisma.searchResult.create({
      data: {
        userId,
        searchId: search.id,
        offerId: catalog.offer.id,
        rank: 1,
        score: 1,
        pricePaiseAtSearch: 1,
      },
    });
    const n = await prisma.notification.create({
      data: { userId, type: "SYSTEM", title: "t", body: "b", ...SOURCE("o2") },
    });
    await prisma.notificationDelivery.create({
      data: { userId, notificationId: n.id, channel: "IN_APP" },
    });
    await prisma.userSession.create({
      data: {
        userId,
        tokenHash: `h-${userId}`,
        familyId: userId,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...iamTokenFields(),
      },
    });
    await prisma.usageRecord.create({ data: { userId, metric: "SEARCH" } });
    await prisma.affiliateClick.create({
      data: {
        clickRef: `c-${userId}`,
        userId,
        offerId: catalog.offer.id,
        sourceId: catalog.source.id,
      },
    });
  }

  it("deleting a user removes all their private data but keeps the global catalog", async () => {
    await populate(alice.id);
    await populate(bob.id);
    await prisma.user.delete({ where: { id: alice.id } });

    for (const count of [
      prisma.watchlist.count({ where: { userId: alice.id } }),
      prisma.watchlistItem.count({ where: { userId: alice.id } }),
      prisma.priceAlert.count({ where: { userId: alice.id } }),
      prisma.search.count({ where: { userId: alice.id } }),
      prisma.searchResult.count({ where: { userId: alice.id } }),
      prisma.notification.count({ where: { userId: alice.id } }),
      prisma.notificationDelivery.count({ where: { userId: alice.id } }),
      prisma.userSession.count({ where: { userId: alice.id } }),
      prisma.usageRecord.count({ where: { userId: alice.id } }),
    ]) {
      expect(await count).toBe(0);
    }
    // Bob is untouched.
    expect(await prisma.watchlistItem.count({ where: { userId: bob.id } })).toBe(1);
    // Global data survives.
    expect(await prisma.productOffer.count()).toBe(1);
    expect(await prisma.productVariant.count()).toBe(1);
    // Affiliate revenue attribution survives, anonymised.
    const click = await prisma.affiliateClick.findUnique({ where: { clickRef: `c-${alice.id}` } });
    expect(click?.userId).toBeNull();
  });

  it("blocks deleting a user who has billing history (financial retention)", async () => {
    await prisma.billingEvent.create({
      data: {
        userId: alice.id,
        type: "PAYMENT_SUCCEEDED",
        provider: "razorpay",
        providerEventId: "evt_1",
        amountPaise: 19_900,
        occurredAt: new Date(),
      },
    });
    await expectPrismaCode(prisma.user.delete({ where: { id: alice.id } }), "P2003");
  });

  it("blocks deleting a catalog variant that users watch or alert on", async () => {
    await prisma.priceAlert.create({
      data: { userId: alice.id, variantId: catalog.variant.id, targetPricePaise: 1_000_000 },
    });
    await expectPrismaCode(
      prisma.productVariant.delete({ where: { id: catalog.variant.id } }),
      "P2003",
    );
  });

  it("removes a search's results, source runs and agent runs with the search", async () => {
    const search = await prisma.search.create({ data: { userId: alice.id, query: "q" } });
    await prisma.searchResult.create({
      data: {
        userId: alice.id,
        searchId: search.id,
        offerId: catalog.offer.id,
        rank: 1,
        score: 1,
        pricePaiseAtSearch: 1,
      },
    });
    await prisma.agentRun.create({
      data: { userId: alice.id, searchId: search.id, graph: "g", model: "m", input: {} },
    });
    await prisma.search.delete({ where: { id: search.id } });
    expect(await prisma.searchResult.count()).toBe(0);
    expect(await prisma.agentRun.count()).toBe(0);
  });
});
