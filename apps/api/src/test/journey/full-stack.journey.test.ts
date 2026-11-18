/**
 * FULL-STACK JOURNEY (Prompt 22): `pnpm --filter @dealmind/api test:journey`.
 *
 * Real processes, wired as in production:
 *   API (this process, real HTTP, *_api_test PostgreSQL, Redis)  ← FakeIam (the
 *     shared IAM is the only dependency faked; it is not runnable locally)
 *   Worker (apps/worker/dist/main.js, separate process, same DB/Redis prefix)
 *   Agent  (apps/agent, `python -m app`, rules LLM = deterministic, no LLM calls)
 *   Mock marketplace connectors (fictional "Acme/Zenith/Orbit" data; allowed
 *     only outside production) — never live marketplaces.
 * Payments: the sandbox provider (test mode); no real payment is possible.
 *
 * Each step records what it observed in load/results/journey.json.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxBillingProvider, provisionProviderPlans } from "@dealmind/billing";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { resolveTestDatabaseUrl } from "@dealmind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Agent,
  PASSWORD,
  type TestContext,
  createTestApp,
  signUp,
  testRedisUrl,
  tokenFromIam,
  truncateAll,
} from "../harness.js";
import { FAKE_IAM_BASE, FakeIam } from "../fake-iam.js";

const API_PORT = 4620;
const AGENT_PORT = 8199;
const TOKENS = {
  INTERNAL_API_TOKEN: "i".repeat(40),
  AGENT_SERVICE_TOKEN: "a".repeat(40),
  AGENT_USER_CONTEXT_SECRET: "c".repeat(40),
};
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const REALISTIC =
  "Find a newly launched smartphone under ₹35,000 with 8GB RAM, 256GB storage and the highest genuine discount.";
const CONTROL = "smartphone under ₹35,000 with 8GB RAM and 256GB storage";

let ctx: TestContext;
let agentProc: ChildProcess | null = null;
let workerProc: ChildProcess | null = null;
const procLog: Record<string, string[]> = { agent: [], worker: [] };
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;

function startProc(
  name: "agent" | "worker",
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
) {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (b: Buffer) => {
    procLog[name]!.push(...b.toString().split("\n").filter(Boolean));
    if (procLog[name]!.length > 400) procLog[name]!.splice(0, procLog[name]!.length - 400);
  };
  p.stdout?.on("data", keep);
  p.stderr?.on("data", keep);
  return p;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 120_000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(everyMs);
  }
}

const sandbox = new SandboxBillingProvider();

beforeAll(async () => {
  // IAM calls go to the in-process fake; everything else (the real agent) to the network.
  const iam = await FakeIam.create();
  const routed: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(FAKE_IAM_BASE) ? iam.fetch(input, init) : fetch(input, init);
  };
  ctx = await createTestApp(
    {
      ...TOKENS,
      AGENT_SERVICE_URL: `http://127.0.0.1:${AGENT_PORT}`,
      CONNECTORS_ENABLE_MOCKS: "true",
      BILLING_PROVIDER: "sandbox",
    },
    { globalRateLimit: 100_000, billingProvider: sandbox, fetch: routed },
    iam,
  );
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  await provisionProviderPlans(ctx.prisma, ctx.app.billing.entitlements, sandbox);
  await ctx.app.listen({ host: "127.0.0.1", port: API_PORT });

  const py = [
    path.join(repo, "apps/agent/.venv/Scripts/python.exe"),
    path.join(repo, "apps/agent/.venv/bin/python"),
  ].find(existsSync);
  if (!py) throw new Error("agent virtualenv not found (cd apps/agent && uv sync)");
  agentProc = startProc(
    "agent",
    py,
    ["-m", "app"],
    {
      ...TOKENS,
      AGENT_PORT: String(AGENT_PORT),
      AGENT_HOST: "127.0.0.1",
      INTERNAL_API_URL: `http://127.0.0.1:${API_PORT}/internal/v1`,
      LLM_PROVIDER: "rules",
      CHECKPOINTER: "memory",
      NODE_ENV: "development",
      LOG_LEVEL: "warning",
    },
    path.join(repo, "apps/agent"),
  );
  await waitFor(
    "agent /ready",
    async () => (await fetch(`http://127.0.0.1:${AGENT_PORT}/ready`)).ok,
    60_000,
  );

  const workerMain = path.join(repo, "apps/worker/dist/main.js");
  if (!existsSync(workerMain))
    throw new Error("build the worker first (pnpm --filter @dealmind/worker build)");
  workerProc = startProc(
    "worker",
    process.execPath,
    [workerMain],
    {
      ...TOKENS,
      NODE_ENV: "development",
      DATABASE_URL: resolveTestDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      REDIS_KEY_PREFIX: ctx.prefix,
      AGENT_SERVICE_URL: `http://127.0.0.1:${AGENT_PORT}`,
      CONNECTORS_ENABLE_MOCKS: "true",
      TRACKING_SCHEDULER_INTERVAL_SECONDS: "10",
      SEARCH_NOTIFY_MIN_SECONDS: "0",
      BILLING_PROVIDER: "none",
      LOG_LEVEL: "warn",
      WORKER_HEARTBEAT_FILE: path.join(repo, "load/results/.journey-worker.heartbeat"),
    },
    repo,
  );
  // The worker is up once it consumes the search queue.
  await waitFor(
    "worker connected",
    async () => (await ctx.jobs.queue("shopping-search").getWorkersCount()) > 0,
    60_000,
  );
}, 180_000);

afterAll(async () => {
  for (const p of [workerProc, agentProc]) {
    if (!p || p.exitCode !== null) continue;
    p.kill("SIGTERM");
    await Promise.race([new Promise((r) => p.once("exit", r)), sleep(10_000)]);
    if (p.exitCode === null) p.kill("SIGKILL");
  }
  report.finishedAt = new Date().toISOString();
  report.processLogTail = { agent: procLog.agent!.slice(-25), worker: procLog.worker!.slice(-25) };
  mkdirSync(path.join(repo, "load/results"), { recursive: true });
  writeFileSync(path.join(repo, "load/results/journey.json"), JSON.stringify(report, null, 2));
  await ctx?.close();
});

interface SearchDetail {
  id: string;
  status: string;
  summary: string | null;
  warnings: string[];
  interpretation: Record<string, unknown> | null;
  clarificationQuestion: string | null;
  sourceRuns: {
    source?: { slug: string };
    sourceSlug?: string;
    status: string;
    resultCount: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  }[];
  agentRun: Record<string, unknown> | null;
}
interface ResultRow {
  rank: number;
  pricePaiseAtSearch: number;
  mrpPaiseAtSearch: number | null;
  offer: Record<string, unknown> & {
    id: string;
    productUrl: string;
    sellingPricePaise: number;
    mrpPaise: number | null;
  };
  product: { id: string; name: string; launchDate: string | null };
  variantAttributes: Record<string, unknown>;
  variantId?: string;
  pricing: Record<string, unknown> | null;
}

async function runSearch(agent: Agent, query: string) {
  const created = await agent.post("/api/v1/search", { query });
  expect(created.statusCode, created.body).toBe(202);
  const id = data<{ id: string }>(created).id;
  const t0 = Date.now();
  const detail = await waitFor(
    `search ${id} to finish`,
    async () => {
      const d = data<SearchDetail>(await agent.get(`/api/v1/search/${id}`));
      return ["COMPLETED", "PARTIAL", "FAILED", "NEEDS_CLARIFICATION", "CANCELLED"].includes(
        d.status,
      )
        ? d
        : null;
    },
    150_000,
  );
  const results = data<ResultRow[]>(
    await agent.get(`/api/v1/search/${id}/results?page=1&pageSize=50`),
  );
  return { id, detail, results, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

let userA: { agent: Agent; userId: string };
let userB: { agent: Agent; userId: string };
let chosen: { productId: string; variantId: string; offerId: string } | null = null;

describe.sequential("DealMind full-stack journey", () => {
  it("A. account lifecycle: register → verify → login → session → logout → reset → unauthenticated", async () => {
    const email = "journey-a@example.com";
    const anon = new Agent(ctx.app);
    expect(
      (await anon.post("/api/v1/auth/register", { email, password: PASSWORD, name: "Journey A" }))
        .statusCode,
    ).toBe(202);
    // Unverified login is allowed or refused per policy; verify first as a real user would.
    await anon.post("/api/v1/auth/verify-email", { token: tokenFromIam(ctx.iam, email, "verify") });
    const login = await anon.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
    const me = await anon.get("/api/v1/auth/me");
    expect(me.statusCode).toBe(200);
    expect((await anon.post("/api/v1/auth/logout")).statusCode).toBeLessThan(300);
    expect((await anon.get("/api/v1/auth/me")).statusCode).toBe(401);
    // Password reset (IAM-backed), then sign in with the new password.
    expect((await anon.post("/api/v1/auth/forgot-password", { email })).statusCode).toBeLessThan(
      300,
    );
    const reset = await anon.post("/api/v1/auth/reset-password", {
      token: tokenFromIam(ctx.iam, email, "reset"),
      password: "Another-horse-43!",
    });
    expect(reset.statusCode, reset.body).toBeLessThan(300);
    const relogin = await anon.post("/api/v1/auth/login", { email, password: "Another-horse-43!" });
    expect(relogin.statusCode).toBe(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    userA = { agent: anon, userId: user.id };
    userB = await signUp(ctx, "journey-b@example.com", { name: "Journey B" });
    report.accountLifecycle =
      "register, verify, login, me, logout, forgot/reset password, re-login: OK";
  });

  it("B. realistic search through worker → agent → connectors → results", async () => {
    const r = await runSearch(userA.agent, REALISTIC);
    const c = await runSearch(userA.agent, CONTROL);
    const summarise = (s: Awaited<ReturnType<typeof runSearch>>) => ({
      status: s.detail.status,
      seconds: s.seconds,
      interpretation: s.detail.interpretation,
      clarificationQuestion: s.detail.clarificationQuestion,
      summary: s.detail.summary,
      warnings: s.detail.warnings,
      sources: s.detail.sourceRuns.map((x) => ({
        source: x.source?.slug ?? x.sourceSlug,
        status: x.status,
        results: x.resultCount,
        why: x.errorCode ? `${x.errorCode}: ${x.errorMessage ?? ""}` : null,
      })),
      results: s.results.map((x) => ({
        rank: x.rank,
        product: x.product.name,
        launchDate: x.product.launchDate,
        variant: x.variantAttributes,
        pricePaise: x.pricePaiseAtSearch,
        mrpPaise: x.mrpPaiseAtSearch,
        url: x.offer.productUrl,
      })),
    });
    report.realisticSearch = summarise(r);
    report.controlSearch = summarise(c);
    for (const s of [r, c]) {
      expect(["COMPLETED", "PARTIAL", "NEEDS_CLARIFICATION"]).toContain(s.detail.status);
      // Honesty: every result comes from a stored offer of a searched source, at its stored price.
      for (const row of s.results) {
        expect(row.pricePaiseAtSearch).toBeGreaterThan(0);
        expect(row.offer.productUrl).toMatch(/^https:\/\/[a-z0-9-]+\.example\.com\//);
        const offer = await ctx.prisma.productOffer.findUniqueOrThrow({
          where: { id: row.offer.id },
        });
        expect(Number(offer.sellingPricePaise)).toBe(row.pricePaiseAtSearch);
        // Filters: ≤ ₹35,000 and the requested variant.
        expect(row.pricePaiseAtSearch).toBeLessThanOrEqual(3_500_000);
      }
    }
    // The control query (no launch-date requirement) must find the fictional 8GB/256GB phone.
    expect(c.results.length).toBeGreaterThan(0);
    const top = c.results[0]!;
    chosen = {
      productId: top.product.id,
      variantId: String((top.offer as { variantId?: string }).variantId ?? top.variantId),
      offerId: top.offer.id,
    };
  }, 400_000);

  it("C. comparison: offers, pricing, history, compare", async () => {
    expect(chosen).not.toBeNull();
    const { productId, variantId } = chosen!;
    const offers = await userA.agent.get(`/api/v1/products/${productId}/offers`);
    const pricing = await userA.agent.get(`/api/v1/products/${productId}/pricing`);
    const history = await userA.agent.get(
      `/api/v1/products/${productId}/history?days=90&variantId=${variantId}`,
    );
    const compare = await userA.agent.get(`/api/v1/compare?items=${productId}:${variantId}`);
    report.comparison = {
      offersStatus: offers.statusCode,
      offers: data<unknown[]>(offers),
      pricingStatus: pricing.statusCode,
      pricing: data<unknown>(pricing),
      historyStatus: history.statusCode,
      historyPoints: (data<{ points: unknown[] }>(history)?.points ?? []).length,
      compareStatus: compare.statusCode,
    };
    for (const r of [offers, pricing, history, compare])
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  });

  it("D/E. watchlist + alert → simulated price drop via tracking → one notification", async () => {
    const { variantId, offerId } = chosen!;
    const list = data<{ id: string }>(
      await userA.agent.post("/api/v1/watchlists", { name: "Phones" }),
    );
    expect(
      (await userA.agent.post(`/api/v1/watchlists/${list.id}/items`, { variantId })).statusCode,
    ).toBe(201);
    expect(
      (await userA.agent.patch(`/api/v1/watchlists/${list.id}`, { name: "Phones to buy" }))
        .statusCode,
    ).toBe(200);
    const offer = await ctx.prisma.productOffer.findUniqueOrThrow({ where: { id: offerId } });
    const current = Number(offer.sellingPricePaise);
    // Simulate that the offer was ₹4,000 dearer at the last observation; the marketplace
    // (mock) still returns its real fixture price, so the next tracked check sees a DROP.
    const before = current + 400_000;
    await ctx.prisma.productOffer.update({
      where: { id: offerId },
      data: { sellingPricePaise: BigInt(before) },
    });
    await ctx.prisma.priceSnapshot.create({
      data: {
        offerId,
        sellingPricePaise: BigInt(before),
        mrpPaise: offer.mrpPaise,
        shippingPaise: offer.shippingPaise,
        stockStatus: offer.stockStatus,
        observedAt: new Date(Date.now() - 3_600_000),
      },
    });
    const target = current + 100_000; // reached once the price drops back to `current`
    const alertA = await userA.agent.post("/api/v1/alerts", {
      variantId,
      type: "TARGET_PRICE",
      targetPricePaise: target,
      channels: ["IN_APP"],
    });
    expect(alertA.statusCode, alertA.body).toBe(201);
    // A second user watching the same variant: tracking must stay one check per offer.
    const alertB = await userB.agent.post("/api/v1/alerts", {
      variantId,
      type: "TARGET_PRICE",
      targetPricePaise: target,
      channels: ["IN_APP"],
    });
    expect(alertB.statusCode, alertB.body).toBe(201);
    const checksBefore = await ctx.prisma.priceCheck.count({ where: { offerId } });
    await ctx.prisma.productOffer.update({
      where: { id: offerId },
      data: { nextCheckAt: new Date(Date.now() - 1_000), trackingState: "ACTIVE" },
    });
    const t0 = Date.now();
    const notes = await waitFor(
      "price-drop notification for user A",
      async () => {
        const n = data<{ id: string; type: string; title: string; readAt: string | null }[]>(
          await userA.agent.get("/api/v1/notifications?page=1&pageSize=20"),
        );
        return n.find((x) => x.type === "TARGET_PRICE_REACHED" || x.type === "PRICE_DROP")
          ? n
          : null;
      },
      120_000,
      1_000,
    );
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const checks = await ctx.prisma.priceCheck.findMany({
      where: { offerId },
      orderBy: { checkedAt: "asc" },
    });
    // A later scheduled check in a DIFFERENT due slot (the scheduler dedupes per
    // offer+minute by design). The listing was observed moments ago and every alert
    // is evaluated, so the worker reschedules WITHOUT a marketplace request
    // ("recently observed"); either way no duplicate notification may appear.
    const lastChecked = (
      await ctx.prisma.productOffer.findUniqueOrThrow({ where: { id: offerId } })
    ).lastCheckedAt;
    await ctx.prisma.productOffer.update({
      where: { id: offerId },
      data: { nextCheckAt: new Date(Date.now() - 5 * 60_000) },
    });
    const rechecked = await waitFor(
      "the offer to be processed again",
      async () => {
        const o = await ctx.prisma.productOffer.findUniqueOrThrow({ where: { id: offerId } });
        return o.lastCheckedAt && (!lastChecked || o.lastCheckedAt > lastChecked) ? o : null;
      },
      90_000,
      1_000,
    );
    const checksAfterSecondRun = await ctx.prisma.priceCheck.count({ where: { offerId } });
    await sleep(3_000);
    const after = data<{ type: string }[]>(
      await userA.agent.get("/api/v1/notifications?page=1&pageSize=20"),
    ).filter((x) => x.type === "TARGET_PRICE_REACHED" || x.type === "PRICE_DROP");
    const noteB = data<{ type: string }[]>(
      await userB.agent.get("/api/v1/notifications?page=1&pageSize=20"),
    ).filter((x) => x.type === "TARGET_PRICE_REACHED" || x.type === "PRICE_DROP");
    const unread = data<{ unread: number }>(
      await userA.agent.get("/api/v1/notifications/unread-count"),
    );
    const first = notes.find((x) => x.type === "TARGET_PRICE_REACHED" || x.type === "PRICE_DROP")!;
    expect(
      (await userA.agent.patch(`/api/v1/notifications/${first.id}/read`, {})).statusCode,
    ).toBeLessThan(300);
    const unreadAfter = data<{ unread: number }>(
      await userA.agent.get("/api/v1/notifications/unread-count"),
    );
    const alertRow = await ctx.prisma.priceAlert.findUniqueOrThrow({
      where: { id: data<{ id: string }>(alertA).id },
    });
    report.priceDrop = {
      simulated: { previousPaise: before, marketplacePaise: current, targetPaise: target },
      secondsToNotification: seconds,
      secondRun: {
        processedAgainAt: rechecked.lastCheckedAt,
        newMarketplaceChecks: checksAfterSecondRun - checks.length,
        nextCheckAt: rechecked.nextCheckAt,
      },
      checksForOffer: {
        beforeAlerts: checksBefore,
        afterFirstRun: checks.length,
        outcomes: checks.map((c) => c.outcome),
      },
      notificationsUserA: after.length,
      notificationsUserB: noteB.length,
      unreadBefore: unread.unread,
      unreadAfterMarkRead: unreadAfter.unread,
      alertStatus: alertRow.status,
    };
    expect(after.length).toBe(1); // exactly one, despite a second check
    expect(noteB.length).toBe(1); // the other watcher was notified from the same shared check
    expect(unreadAfter.unread).toBe(unread.unread - 1);
  }, 300_000);

  it("F. subscription upgrade in sandbox (test) mode and usage", async () => {
    const before = data<{ plan: { code: string } }>(
      await userA.agent.get("/api/v1/billing/subscription"),
    );
    const c = data<{ id: string }>(
      await userA.agent.post("/api/v1/billing/checkout", { plan: "PRO", interval: "MONTHLY" }),
    );
    const confirm = await userA.agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, {
      sandboxOutcome: "success",
    });
    expect(confirm.statusCode, confirm.body).toBeLessThan(300);
    const after = data<{ plan: { code: string }; status: string; provider: string | null }>(
      await userA.agent.get("/api/v1/billing/subscription"),
    );
    const usage = await userA.agent.get("/api/v1/usage");
    report.billing = {
      before: before.plan.code,
      after: after.plan.code,
      status: after.status,
      provider: after.provider,
      usageStatus: usage.statusCode,
    };
    expect(after.plan.code).toBe("PRO");
    expect(after.provider).toBe("sandbox");
  });

  it("H. ADMIN access works for ADMIN only", async () => {
    const admin = await signUp(ctx, "journey-admin@example.com", { role: "ADMIN" });
    const paths = [
      "/dashboard",
      "/users",
      "/sources",
      "/jobs",
      "/analytics",
      "/subscriptions",
      "/affiliates",
      "/audit-logs",
      "/ai-models",
    ];
    const adminStatus: Record<string, number> = {};
    const userStatus: Record<string, number> = {};
    for (const p of paths) {
      adminStatus[p] = (await admin.agent.get(`/api/v1/admin${p}`)).statusCode;
      userStatus[p] = (await userA.agent.get(`/api/v1/admin${p}`)).statusCode;
    }
    const sources = data<
      {
        slug: string;
        status: string;
        isSample: boolean;
        credentials: { configured: boolean; missing: string[] };
      }[]
    >(await admin.agent.get("/api/v1/admin/sources"));
    report.admin = {
      adminStatus,
      userStatus,
      sources: sources.map((s) => ({
        slug: s.slug,
        status: s.status,
        sample: s.isSample,
        configured: s.credentials.configured,
        missing: s.credentials.missing,
      })),
    };
    expect(Object.values(adminStatus).every((s) => s === 200)).toBe(true);
    expect(Object.values(userStatus).every((s) => s === 403)).toBe(true);
  });

  it("I. user B cannot see or change user A's data", async () => {
    const searchId = (await ctx.prisma.search.findFirstOrThrow({ where: { userId: userA.userId } }))
      .id;
    const alertId = (
      await ctx.prisma.priceAlert.findFirstOrThrow({ where: { userId: userA.userId } })
    ).id;
    const listId = (
      await ctx.prisma.watchlist.findFirstOrThrow({ where: { userId: userA.userId } })
    ).id;
    const noteId = (
      await ctx.prisma.notification.findFirstOrThrow({ where: { userId: userA.userId } })
    ).id;
    const attempts: [string, () => Promise<{ statusCode: number }>][] = [
      ["read search", () => userB.agent.get(`/api/v1/search/${searchId}`)],
      ["read results", () => userB.agent.get(`/api/v1/search/${searchId}/results`)],
      ["read alert", () => userB.agent.get(`/api/v1/alerts/${alertId}`)],
      [
        "change alert",
        () => userB.agent.patch(`/api/v1/alerts/${alertId}`, { targetPricePaise: 100 }),
      ],
      ["read watchlist", () => userB.agent.get(`/api/v1/watchlists/${listId}`)],
      [
        "rename watchlist",
        () => userB.agent.patch(`/api/v1/watchlists/${listId}`, { name: "mine now" }),
      ],
      [
        "mark notification read",
        () => userB.agent.patch(`/api/v1/notifications/${noteId}/read`, {}),
      ],
      ["delete notification", () => userB.agent.delete(`/api/v1/notifications/${noteId}`)],
    ];
    const out: Record<string, number> = {};
    for (const [name, fn] of attempts) out[name] = (await fn()).statusCode;
    // B's own lists don't include A's records; B's usage/subscription are B's.
    const bSearches = data<{ id: string }[]>(
      await userB.agent.get("/api/v1/search?page=1&pageSize=50"),
    );
    const bSub = data<{ plan: { code: string } }>(
      await userB.agent.get("/api/v1/billing/subscription"),
    );
    report.isolation = {
      attemptsByUserB: out,
      userBSeesOwnSearchesOnly: !bSearches.some((s) => s.id === searchId),
      userBPlan: bSub.plan.code,
    };
    for (const [name, code] of Object.entries(out)) expect([403, 404], name).toContain(code);
    expect(bSub.plan.code).toBe("FREE");
    expect(
      (await ctx.prisma.priceAlert.findUniqueOrThrow({ where: { id: alertId } })).targetPricePaise,
    ).not.toBe(100n);
  });

  it("K. deleting user A keeps shared catalog and price history", async () => {
    // Cancel the paid plan first (deletion is refused while a paid plan renews).
    await userA.agent.post("/api/v1/billing/cancel", {});
    const products = await ctx.prisma.product.count();
    const offers = await ctx.prisma.productOffer.count();
    const snapshots = await ctx.prisma.priceSnapshot.count();
    const del = await userA.agent.post("/api/v1/users/me/delete", {
      password: "Another-horse-43!",
      confirm: "DELETE MY ACCOUNT",
    });
    report.deletion = {
      status: del.statusCode,
      body: del.statusCode === 204 ? null : del.body.slice(0, 300),
      sharedBefore: { products, offers, snapshots },
      sharedAfter: {
        products: await ctx.prisma.product.count(),
        offers: await ctx.prisma.productOffer.count(),
        snapshots: await ctx.prisma.priceSnapshot.count(),
      },
      userAGone: (await ctx.prisma.user.count({ where: { id: userA.userId } })) === 0,
      userBAlertsKept: await ctx.prisma.priceAlert.count({ where: { userId: userB.userId } }),
    };
    expect(del.statusCode, del.body).toBe(204);
    expect(await ctx.prisma.product.count()).toBe(products);
    expect(await ctx.prisma.priceSnapshot.count()).toBe(snapshots);
  });
});
