/**
 * Internal matching API (/internal/v1/intelligence/match*): real app,
 * PostgreSQL and Redis. Catalog fixtures are fictional ("Acme") listings
 * imported from a mock source.
 */
import { seedMockSources } from "@dealmind/connectors";
import type { SourceListing } from "@dealmind/catalog";
import { seedReferenceData } from "@dealmind/db";
import { CatalogImporter } from "@dealmind/intelligence";
import { signReviewerContext } from "@dealmind/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeIam } from "./fake-iam.js";
import { type TestContext, createTestApp, signUp, truncateAll } from "./harness.js";

const TOKEN = "i".repeat(40);
const REVIEW_SECRET = "r".repeat(40);
const SOURCE = "mock_alpha";
/** Valid EAN-13 check digit; fictional fixture. */
const GTIN = "4006381333931";
let ctx: TestContext;
let seq = 0;

type Json = Record<string, unknown>;

function listing(overrides: Partial<SourceListing> = {}): SourceListing {
  seq += 1;
  return {
    externalId: `m-${seq}`,
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productUrl: `https://mock-alpha.example.com/p/${seq}`,
    brand: "Acme",
    categorySlug: "smartphones",
    sellingPricePaise: 1_999_900,
    stockStatus: "IN_STOCK",
    ...overrides,
  };
}

beforeAll(async () => {
  const iam = await FakeIam.create();
  ctx = await createTestApp(
    {
      INTERNAL_API_TOKEN: TOKEN,
      AGENT_USER_CONTEXT_SECRET: "c".repeat(40),
      REVIEW_CONTEXT_SECRET: REVIEW_SECRET,
    },
    { fetch: (url: string | URL | Request, init?: RequestInit) => iam.fetch(url, init) },
    iam,
  );
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  ctx.iam.reset();
  const s = await new CatalogImporter(ctx.prisma).importListings(SOURCE, [
    listing({ barcode: GTIN }),
  ]);
  expect(s.productsCreated).toBe(1);
});

const call = (method: "GET" | "POST", url: string, payload?: unknown, headers = {}) =>
  ctx.app.inject({
    method,
    url: `/internal/v1${url}`,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const reviewer = (userId: string, matchId: string, ttl = 300, secret = REVIEW_SECRET) =>
  signReviewerContext(
    { reviewerUserId: userId, matchId, exp: Math.floor(Date.now() / 1000) + ttl },
    secret,
  );

async function reviewableMatch(): Promise<string> {
  const res = await call("POST", "/intelligence/match", {
    sourceId: SOURCE,
    listing: listing({ title: "Acme Nova 7 Pro 5G (Midnight Black, 8GB RAM, 128GB Storage)" }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<Json & { matchId: string }>();
  expect(body).toMatchObject({ decision: "MANUAL_REVIEW" });
  expect(body.reviewId).toEqual(expect.any(String));
  return body.matchId;
}

describe("matching endpoints", () => {
  it("require the service token", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/v1/intelligence/match",
      payload: { listing: listing() },
    });
    expect(res.statusCode).toBe(401);
  });

  it("match a listing by identifier as a dry run, with evidence and an audit record", async () => {
    const products = await ctx.prisma.product.count();
    const res = await call("POST", "/intelligence/match", {
      listing: listing({ title: "Acme Nova7 5G Black 128 GB", barcode: GTIN }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Json & { matchId: string; productB: { id: string } }>();
    expect(body).toMatchObject({
      decision: "AUTO_MERGE",
      method: "IDENTIFIER",
      confidence: "VERY_HIGH",
      scoreBp: 10_000,
      evidence: { identifier: GTIN },
      conflicts: [],
      reviewId: null,
    });
    // Dry run: the catalog is untouched.
    expect(await ctx.prisma.product.count()).toBe(products);
    expect(await ctx.prisma.productOffer.count()).toBe(1);

    const got = await call("GET", `/intelligence/matches/${body.matchId}`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      id: body.matchId,
      origin: "INTERNAL_API",
      decision: "AUTO_MERGE",
      candidateProductId: body.productB.id,
      review: null,
      resolutions: [],
    });
    expect(
      (await call("GET", "/intelligence/matches/00000000-0000-7000-8000-000000000000")).statusCode,
    ).toBe(404);
  });

  it("never auto-merges a different line on title similarity: it queues human review", async () => {
    const matchId = await reviewableMatch();
    const got = (await call("GET", `/intelligence/matches/${matchId}`)).json<Json>();
    expect(got).toMatchObject({ decision: "MANUAL_REVIEW", review: { status: "PENDING" } });
    expect(await ctx.prisma.product.count()).toBe(1);
  });

  it("rejects a different brand and invalid bodies", async () => {
    const other = await call("POST", "/intelligence/match", {
      listing: listing({ brand: "Zenta", title: "Zenta Nova 7 5G (8GB RAM, 128GB Storage)" }),
    });
    expect(other.json()).toMatchObject({ decision: "NEW_PRODUCT" });
    expect(
      (await call("POST", "/intelligence/match", { listing: { title: "x" } })).statusCode,
    ).toBe(422);
  });

  it("batch-matches with identical requests deduplicated", async () => {
    const same = { listing: listing({ barcode: GTIN }) };
    const res = await call("POST", "/intelligence/match/batch", {
      items: [same, same, { listing: listing({ title: "Acme Orbit Watch 2" }) }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const { results } = res.json<{ results: (Json & { matchId: string })[] }>();
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ decision: "AUTO_MERGE" });
    expect(results[1]).toMatchObject({ matchId: results[0]!.matchId, deduplicated: true });
    expect(results[2]).toMatchObject({ decision: "NEW_PRODUCT" });
    expect(await ctx.prisma.productMatchAudit.count({ where: { origin: "INTERNAL_API" } })).toBe(2);
    const tooMany = { items: Array.from({ length: 101 }, () => same) };
    expect((await call("POST", "/intelligence/match/batch", tooMany)).statusCode).toBe(422);
  });
});

describe("match review: humans only", () => {
  const create = { resolution: { action: "create" } };

  it("is never possible with the service token alone (what the agent holds)", async () => {
    const matchId = await reviewableMatch();
    const res = await call("POST", `/intelligence/matches/${matchId}/review`, create);
    expect(res.statusCode).toBe(403);
    expect(await ctx.prisma.product.count()).toBe(1);
  });

  it("rejects forged, mismatched, long-lived and non-admin reviewer contexts", async () => {
    const matchId = await reviewableMatch();
    const admin = await signUp(ctx, "admin@example.com", { role: "ADMIN" });
    const user = await signUp(ctx, "user@example.com");
    const other = "00000000-0000-7000-8000-000000000000";
    const header = (token: string) => ({ "x-dealmind-reviewer-context": token });
    const tries = [
      reviewer(admin.userId, matchId, 300, "x".repeat(40)), // forged
      reviewer(admin.userId, other), // signed for another match
      reviewer(admin.userId, matchId, 24 * 3600), // not short-lived
      reviewer(admin.userId, matchId, -10), // expired
      reviewer(user.userId, matchId), // not an admin
    ];
    for (const token of tries) {
      const res = await call(
        "POST",
        `/intelligence/matches/${matchId}/review`,
        create,
        header(token),
      );
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(await ctx.prisma.product.count()).toBe(1);
    expect(await ctx.prisma.productMatchAudit.count({ where: { reviewOfId: matchId } })).toBe(0);
  });

  it("applies an admin's signed decision once, audited", async () => {
    const matchId = await reviewableMatch();
    const admin = await signUp(ctx, "admin@example.com", { role: "ADMIN" });
    const headers = { "x-dealmind-reviewer-context": reviewer(admin.userId, matchId) };
    const bad = await call(
      "POST",
      `/intelligence/matches/${matchId}/review`,
      { resolution: { action: "merge", keepProductId: matchId } },
      headers,
    );
    expect(bad.statusCode).toBe(422); // merge is for product pairs
    const res = await call(
      "POST",
      `/intelligence/matches/${matchId}/review`,
      { ...create, note: "Pro is a separate model" },
      headers,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await ctx.prisma.product.count()).toBe(2);
    const got = (await call("GET", `/intelligence/matches/${matchId}`)).json<Json>();
    expect(got).toMatchObject({
      review: { status: "APPROVED", reviewedBy: admin.userId },
      resolutions: [
        {
          decision: "REVIEW_RESOLVED",
          origin: "REVIEW",
          reviewer: admin.userId,
          note: "Pro is a separate model",
        },
      ],
    });
    const again = await call("POST", `/intelligence/matches/${matchId}/review`, create, headers);
    expect(again.statusCode).toBe(409);
  });
});
