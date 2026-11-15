/**
 * Internal service API (/internal/v1) used by the Python agent: real app,
 * PostgreSQL and Redis; mock connectors (fictional data) as marketplace sources.
 */
import { randomUUID } from "node:crypto";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { signUserContext } from "@dealmind/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeIam } from "./fake-iam.js";
import { type TestContext, createTestApp, signUp, truncateAll } from "./harness.js";

const TOKEN = "i".repeat(40);
const SECRET = "c".repeat(40);
let ctx: TestContext;
const cancelled: string[] = [];

beforeAll(async () => {
  const iam = await FakeIam.create();
  ctx = await createTestApp(
    {
      INTERNAL_API_TOKEN: TOKEN,
      AGENT_USER_CONTEXT_SECRET: SECRET,
      AGENT_SERVICE_URL: "http://agent.test",
      AGENT_SERVICE_TOKEN: "a".repeat(40),
    },
    {
      // Captures the API → agent cancel call; the fake IAM handles everything else.
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const href = url instanceof Request ? url.url : url.toString();
        if (href.startsWith("http://agent.test/")) {
          cancelled.push(href);
          return new Response(null, { status: 202 });
        }
        return iam.fetch(url, init);
      },
    },
    iam,
  );
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  ctx.iam.reset();
  cancelled.length = 0;
});

const call = (
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  ctx.app.inject({
    method,
    url: `/internal/v1${url}`,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function searchFor(email: string) {
  const { userId } = await signUp(ctx, email);
  const search = await ctx.prisma.search.create({
    data: { userId, query: "acme nova", status: "RUNNING" },
  });
  const run = await ctx.prisma.agentRun.create({
    data: { userId, searchId: search.id, graph: "shopping_search", model: "", input: {} },
  });
  const context = signUserContext(
    { userId, searchId: search.id, executionId: run.id, exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );
  return { userId, search, run, context };
}

const request = { query: "acme nova", limit: 10 };

describe("service authentication", () => {
  it("rejects missing or wrong tokens and is not part of the public API", async () => {
    expect(
      (await ctx.app.inject({ method: "GET", url: "/internal/v1/categories" })).statusCode,
    ).toBe(401);
    const wrong = await ctx.app.inject({
      method: "GET",
      url: "/internal/v1/categories",
      headers: { authorization: `Bearer ${"x".repeat(40)}` },
    });
    expect(wrong.statusCode).toBe(401);
    // Browser session cookies are irrelevant here: no CSRF, no cookie auth.
    expect((await call("GET", "/categories")).statusCode).toBe(200);
  });

  it("is disabled entirely when not configured", async () => {
    const plain = await createTestApp();
    try {
      const res = await plain.app.inject({
        method: "GET",
        url: "/internal/v1/categories",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("marketplace + intelligence (deterministic services reused)", () => {
  it("discovers eligible sources from the registry and searches them", async () => {
    const eligible = (await call("POST", "/sources/eligible", { request })).json<{
      eligible: { sourceId: string; isMock: boolean }[];
      skipped: { sourceId: string; reason: string }[];
    }>();
    expect(eligible.eligible.map((s) => s.sourceId).sort()).toEqual(["mock_alpha", "mock_beta"]);
    expect(eligible.eligible.every((s) => s.isMock)).toBe(true);
    expect(eligible.skipped.find((s) => s.sourceId === "flipkart")?.reason).toBe(
      "SOURCE_NOT_ACTIVE",
    );

    const search = (
      await call("POST", "/marketplace/search", { request, only: ["mock_alpha"] })
    ).json<{
      status: string;
      sources: { sourceId: string; status: string }[];
      items: { sourceId: string; sellingPricePaise: number }[];
    }>();
    expect(search.status).toBe("COMPLETED");
    expect(search.items.length).toBe(2);
    expect(search.items.every((i) => i.sourceId === "mock_alpha")).toBe(true);
  });

  it("canonicalizes user specs with the catalog normalizer", async () => {
    const res = await call("POST", "/intelligence/canonical-specs", {
      specs: [
        { name: "ram", value: "8GB" },
        { name: "storage", value: "256GB" },
        { name: "capacity", value: "1.5 ton" },
      ],
    });
    expect(res.json()).toEqual({ attributes: { ram_gb: 8, storage_gb: 256, capacity_ton: 1.5 } });
  });

  it("normalizes, deduplicates into product/variant groups, prices and ranks by offer id only", async () => {
    const items = (
      await call("POST", "/marketplace/search", { request }).then((r) =>
        r.json<{ items: Record<string, unknown>[] }>(),
      )
    ).items;
    const normalized = (await call("POST", "/intelligence/normalize", { items })).json<{
      results: { ok: boolean; variantKey: string; attributes: Record<string, unknown> }[];
    }>();
    expect(normalized.results.every((r) => r.ok)).toBe(true);
    expect(normalized.results[0]?.attributes).toMatchObject({ ram_gb: 8 });

    const dedup = (
      await call("POST", "/intelligence/deduplicate", { items, categorySlug: "smartphones" })
    ).json<{
      outcomes: { status: string; offerId?: string }[];
      groups: { productId: string; variants: { variantId: string; offerIds: string[] }[] }[];
    }>();
    expect(dedup.outcomes.every((o) => o.status === "imported")).toBe(true);
    expect(dedup.groups).toHaveLength(1); // one product (Acme Nova 7 5G)
    expect(dedup.groups[0]?.variants).toHaveLength(2); // 128GB and 256GB never merged
    expect(dedup.groups[0]?.variants.every((v) => v.offerIds.length === 2)).toBe(true); // both stores

    const offerIds = dedup.outcomes.map((o) => o.offerId!);
    const priced = (await call("POST", "/intelligence/pricing", { offerIds })).json<{
      offers: { pricing: { verdict: string; sellingPricePaise: number }; isSample: boolean }[];
    }>();
    expect(priced.offers).toHaveLength(4);
    expect(
      priced.offers.every((o) => o.isSample && o.pricing.verdict === "INSUFFICIENT_HISTORY"),
    ).toBe(true);

    const ranked = (
      await call("POST", "/intelligence/rank", { query: "acme nova", mode: "cheapest", offerIds })
    ).json<{
      ranked: { rank: number; offer: { pricing: { effectivePricePaise: number } } }[];
    }>();
    const prices = ranked.ranked.map((r) => r.offer.pricing.effectivePricePaise);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    // Callers cannot smuggle prices into ranking.
    const smuggled = await call("POST", "/intelligence/rank", {
      query: "x",
      mode: "cheapest",
      offerIds,
      prices: [1],
    });
    expect(smuggled.statusCode).toBe(422);
  });

  it("rejects connector items that don't match the strict schema", async () => {
    const res = await call("POST", "/intelligence/normalize", {
      items: [{ sourceId: "x", title: "no price" }],
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("private records: signed user context + ownership", () => {
  it("requires a valid signed context for the same search and owner", async () => {
    const a = await searchFor("alice@example.com");
    const b = await searchFor("bob@example.com");
    const ok = await call("GET", `/searches/${a.search.id}`, undefined, {
      "x-dealmind-user-context": a.context,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: a.search.id, userId: a.userId });
    expect((await call("GET", `/searches/${a.search.id}`)).statusCode).toBe(403);
    // Bob's valid context can't read Alice's search.
    expect(
      (
        await call("GET", `/searches/${a.search.id}`, undefined, {
          "x-dealmind-user-context": b.context,
        })
      ).statusCode,
    ).toBe(403);
    // A context forged with another secret, or claiming Alice's id with Bob's search, fails.
    const forged = signUserContext(
      { userId: a.userId, searchId: a.search.id, executionId: a.run.id, exp: 4_102_444_800 },
      "z".repeat(40),
    );
    expect(
      (
        await call("GET", `/searches/${a.search.id}`, undefined, {
          "x-dealmind-user-context": forged,
        })
      ).statusCode,
    ).toBe(403);
    const crossed = signUserContext(
      { userId: b.userId, searchId: a.search.id, executionId: a.run.id, exp: 4_102_444_800 },
      SECRET,
    );
    expect(
      (
        await call("GET", `/searches/${a.search.id}`, undefined, {
          "x-dealmind-user-context": crossed,
        })
      ).statusCode,
    ).toBe(404);
    const expired = signUserContext(
      { userId: a.userId, searchId: a.search.id, executionId: a.run.id, exp: 1 },
      SECRET,
    );
    expect(
      (
        await call("GET", `/searches/${a.search.id}`, undefined, {
          "x-dealmind-user-context": expired,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("persists agent results idempotently, with prices taken from the database", async () => {
    const a = await searchFor("carol@example.com");
    const items = (
      await call("POST", "/marketplace/search", { request }).then((r) =>
        r.json<{ items: unknown[] }>(),
      )
    ).items;
    const offerIds = (
      await call("POST", "/intelligence/deduplicate", { items }).then((r) =>
        r.json<{ outcomes: { offerId: string }[] }>(),
      )
    ).outcomes.map((o) => o.offerId);
    const payload = {
      status: "PARTIAL",
      interpretation: { intent: { category: "smartphones" } },
      clarificationQuestion: null,
      response: "Found 2 matching offers.",
      warnings: ["One source failed."],
      rankedDeals: offerIds
        .slice(0, 2)
        .map((offerId, i) => ({ offerId, rank: i + 1, score: 9000 - i, explanation: "x" })),
      sourceRuns: [
        {
          sourceId: "mock_alpha",
          status: "SUCCEEDED",
          resultCount: 2,
          durationMs: 10,
          errorCode: null,
          errorMessage: null,
        },
        {
          sourceId: "flipkart",
          status: "SKIPPED",
          resultCount: 0,
          durationMs: 0,
          errorCode: "SOURCE_NOT_ACTIVE",
          errorMessage: null,
        },
      ],
      agentRun: {
        provider: "google",
        model: "configured-model",
        inputTokens: 300,
        outputTokens: 50,
        durationMs: 1234,
        metadata: { iterations: 1 },
        error: null,
      },
    };
    const headers = { "x-dealmind-user-context": a.context };
    for (let i = 0; i < 2; i += 1) {
      const res = await call("PUT", `/searches/${a.search.id}/agent-result`, payload, headers);
      expect(res.statusCode, res.body).toBe(200);
    }
    const results = await ctx.prisma.searchResult.findMany({
      where: { searchId: a.search.id },
      orderBy: { rank: "asc" },
    });
    expect(results).toHaveLength(2); // replaced, not duplicated
    const offer = await ctx.prisma.productOffer.findUniqueOrThrow({ where: { id: offerIds[0]! } });
    expect(results[0]?.pricePaiseAtSearch).toBe(offer.sellingPricePaise);
    const search = await ctx.prisma.search.findUniqueOrThrow({ where: { id: a.search.id } });
    expect(search.status).toBe("PARTIAL");
    const run = await ctx.prisma.agentRun.findUniqueOrThrow({ where: { id: a.run.id } });
    expect(run).toMatchObject({
      status: "SUCCEEDED",
      provider: "google",
      inputTokens: 300,
      durationMs: 1234,
    });
    expect(await ctx.prisma.searchSourceRun.count({ where: { searchId: a.search.id } })).toBe(2);

    // Public API: the owner sees the interpretation, summary and run summary.
    const owner = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/search/${a.search.id}`,
      headers: { cookie: "" },
    });
    expect(owner.statusCode).toBe(401); // no session → no access
  });

  it("rejects unknown offers, bad ranks and a different execution overwriting a finished search", async () => {
    const a = await searchFor("dave@example.com");
    const headers = { "x-dealmind-user-context": a.context };
    const base = {
      status: "COMPLETED",
      interpretation: null,
      clarificationQuestion: null,
      response: "x",
      warnings: [],
      sourceRuns: [],
      agentRun: {
        provider: "rules",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        metadata: {},
        error: null,
      },
    };
    const unknown = await call(
      "PUT",
      `/searches/${a.search.id}/agent-result`,
      {
        ...base,
        rankedDeals: [{ offerId: randomUUID(), rank: 1, score: 1, explanation: null }],
      },
      headers,
    );
    expect(unknown.statusCode).toBe(422);
    const badRanks = await call(
      "PUT",
      `/searches/${a.search.id}/agent-result`,
      {
        ...base,
        rankedDeals: [{ offerId: randomUUID(), rank: 2, score: 1, explanation: null }],
      },
      headers,
    );
    expect(badRanks.statusCode).toBe(422);
    expect(
      (
        await call(
          "PUT",
          `/searches/${a.search.id}/agent-result`,
          { ...base, rankedDeals: [] },
          headers,
        )
      ).statusCode,
    ).toBe(200);
    // A second execution of the same search can't overwrite the finished result.
    const run2 = await ctx.prisma.agentRun.create({
      data: {
        userId: a.userId,
        searchId: a.search.id,
        graph: "shopping_search",
        model: "",
        input: {},
      },
    });
    const ctx2 = signUserContext(
      { userId: a.userId, searchId: a.search.id, executionId: run2.id, exp: 4_102_444_800 },
      SECRET,
    );
    const conflict = await call(
      "PUT",
      `/searches/${a.search.id}/agent-result`,
      { ...base, rankedDeals: [] },
      { "x-dealmind-user-context": ctx2 },
    );
    expect(conflict.statusCode).toBe(409);
  });

  it("publishes progress events for the owner's SSE stream", async () => {
    const a = await searchFor("erin@example.com");
    const res = await call(
      "POST",
      `/searches/${a.search.id}/events`,
      { type: "node_finished", node: "parallel_search", at: new Date().toISOString() },
      { "x-dealmind-user-context": a.context },
    );
    expect(res.statusCode).toBe(204);
    const log = await ctx.redis.lrange(`${ctx.prefix}:search-events-log:${a.search.id}`, 0, -1);
    expect(log.map((e) => JSON.parse(e) as { node: string })[0]?.node).toBe("parallel_search");
  });
});

describe("public search API: agent output, cancellation and progress", () => {
  it("shows the agent's interpretation and summary to the owner only", async () => {
    const { agent, userId } = await signUp(ctx, "frank@example.com");
    const search = await ctx.prisma.search.create({
      data: {
        userId,
        query: "acme nova",
        status: "COMPLETED",
        intent: { filters: { max_price_paise: 3_500_000 } },
      },
    });
    await ctx.prisma.agentRun.create({
      data: {
        userId,
        searchId: search.id,
        graph: "shopping_search",
        model: "configured-model",
        provider: "google",
        input: {},
        status: "SUCCEEDED",
        output: { response: "Found 3 offers.", clarificationQuestion: null, warnings: ["w"] },
        finishedAt: new Date(),
      },
    });
    const res = await agent.get(`/api/v1/search/${search.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      status: "COMPLETED",
      summary: "Found 3 offers.",
      warnings: ["w"],
      interpretation: { filters: { max_price_paise: 3_500_000 } },
      agentRun: { status: "SUCCEEDED", provider: "google", model: "configured-model" },
    });
    const other = await signUp(ctx, "grace@example.com");
    expect((await other.agent.get(`/api/v1/search/${search.id}`)).statusCode).toBe(404);
    expect((await other.agent.get(`/api/v1/search/${search.id}/events`)).statusCode).toBe(404);
  });

  it("cancels pending searches immediately and asks the agent to stop running ones", async () => {
    const { agent, userId } = await signUp(ctx, "heidi@example.com");
    const pending = await ctx.prisma.search.create({ data: { userId, query: "acme nova" } });
    const r1 = await agent.post(`/api/v1/search/${pending.id}/cancel`);
    expect(r1.statusCode).toBe(202);
    expect(r1.json<{ data: { status: string } }>().data.status).toBe("CANCELLED");

    const running = await ctx.prisma.search.create({
      data: { userId, query: "acme nova", status: "RUNNING" },
    });
    const run = await ctx.prisma.agentRun.create({
      data: { userId, searchId: running.id, graph: "shopping_search", model: "", input: {} },
    });
    await agent.post(`/api/v1/search/${running.id}/cancel`);
    expect(await ctx.redis.get(`${ctx.prefix}:search-cancel:${running.id}`)).toBe("1");
    expect(cancelled).toEqual([`http://agent.test/internal/agent/search/${run.id}/cancel`]);
  });

  it("streams recent progress and the final status as server-sent events", async () => {
    const { agent, userId } = await signUp(ctx, "ivan@example.com");
    const search = await ctx.prisma.search.create({
      data: { userId, query: "acme nova", status: "COMPLETED" },
    });
    await ctx.redis.rpush(
      `${ctx.prefix}:search-events-log:${search.id}`,
      JSON.stringify({ type: "node_finished", node: "rank_deals", at: "2026-11-15T00:00:00Z" }),
    );
    const res = await agent.get(`/api/v1/search/${search.id}/events`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.body
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; status?: string; node?: string });
    expect(events.map((e) => e.node ?? e.status)).toEqual(["rank_deals", "COMPLETED"]);
  });
});
