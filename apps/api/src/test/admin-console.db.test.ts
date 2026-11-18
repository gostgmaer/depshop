/**
 * Phase 6.3 API: the platform admin console. ADMIN-only on every endpoint
 * (refused before validation), audited actions with request ids and
 * before/after, connector readiness without secrets, the agent LLM
 * configuration and its internal read, k-anonymous search analytics,
 * subscription analytics, single-job retry, and catalog corrections.
 */
import { randomUUID } from "node:crypto";
import { FakeIam } from "./fake-iam.js";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { QueueName } from "@dealmind/queue";
import { Worker } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  testRedisUrl,
  truncateAll,
} from "./harness.js";

const TOKEN = "i".repeat(40);
const SECRET_VALUE = "flipkart-token-SECRET-VALUE-123";
let ctx: TestContext;

beforeAll(async () => {
  const iam = await FakeIam.create();
  ctx = await createTestApp(
    {
      INTERNAL_API_TOKEN: TOKEN,
      AGENT_USER_CONTEXT_SECRET: "c".repeat(40),
      AGENT_SERVICE_URL: "http://agent.test",
      AGENT_SERVICE_TOKEN: "a".repeat(40),
      FLIPKART_AFFILIATE_ID: "affid-public",
      FLIPKART_AFFILIATE_TOKEN: SECRET_VALUE,
    },
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const href = url instanceof Request ? url.url : url.toString();
        if (href === "http://agent.test/health")
          return Response.json({
            status: "ok",
            provider: "rules",
            model: "",
            secret: "never-forwarded",
          });
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
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
});

const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
async function admins() {
  const admin = await signUp(ctx, `admin-${randomUUID().slice(0, 6)}@example.com`, {
    role: "ADMIN",
  });
  const user = await signUp(ctx, `user-${randomUUID().slice(0, 6)}@example.com`);
  return { admin, user };
}

describe("1–3. authorization", () => {
  it("refuses anonymous and USER callers on every admin endpoint, before validation", async () => {
    const { user } = await admins();
    const anon = new Agent(ctx.app);
    const id = randomUUID();
    const reads = [
      "/dashboard",
      `/users/${id}`,
      "/users",
      "/sources",
      "/ai-models",
      "/analytics",
      "/subscriptions",
      "/subscriptions/users",
      "/jobs",
      "/system",
      "/products",
      "/categories",
      "/audit-logs",
      "/affiliates",
      "/tracking",
      "/notifications",
    ];
    for (const path of reads) {
      expect((await anon.get(`/api/v1/admin${path}`)).statusCode, path).toBe(401);
      expect((await user.agent.get(`/api/v1/admin${path}`)).statusCode, path).toBe(403);
    }
    // Writes: 403 even with an invalid body (no schema hints to non-admins).
    for (const [method, path] of [
      ["POST", `/users/${id}/suspend`],
      ["POST", `/users/${id}/reactivate`],
      ["POST", `/users/${id}/sessions/revoke`],
      ["PATCH", `/sources/${id}`],
      ["PUT", "/ai-models"],
      ["POST", "/jobs/x/retry"],
      ["PATCH", `/products/${id}`],
    ] as const)
      expect((await user.agent.request(method, `/api/v1/admin${path}`, {})).statusCode, path).toBe(
        403,
      );
  });
});

describe("dashboard", () => {
  it("reports stored data only and records the admin's access once per hour", async () => {
    const { admin, user } = await admins();
    await ctx.prisma.search.createMany({
      data: [
        { userId: user.userId, query: "phone", status: "COMPLETED" },
        { userId: user.userId, query: "tv", status: "PARTIAL" },
        { userId: user.userId, query: "laptop", status: "FAILED" },
      ],
    });
    const d = data<{
      platform: { users: number; searches: Record<string, number> };
      revenue: { subscriptions: { estimatedMrrPaise: number; activePaid: number } };
      infrastructure: { checks: Record<string, string>; queues: unknown[] };
    }>(await admin.agent.get("/api/v1/admin/dashboard"));
    expect(d.platform.users).toBe(2);
    expect(d.platform.searches).toMatchObject({ total: 3, completed: 1, partial: 1, failed: 1 });
    expect(d.revenue.subscriptions).toMatchObject({ activePaid: 0, estimatedMrrPaise: 0 });
    expect(d.infrastructure.checks).toMatchObject({
      redis: "ok",
      agent: "ok",
      notifications: "not_configured",
      payments: "not_configured",
    });
    expect(d.infrastructure.checks.worker).toBe("fail"); // no worker running in tests
    await admin.agent.get("/api/v1/admin/dashboard");
    expect(await ctx.prisma.auditLog.count({ where: { action: "admin.console_accessed" } })).toBe(
      1,
    );
  });
});

describe("4–6, 14. users", () => {
  it("finds by email or id, shows profile/subscription/usage, suspends and reactivates with audit", async () => {
    const { admin, user } = await admins();
    const byId = data<{ items: { id: string }[] }>(
      await admin.agent.get(`/api/v1/admin/users?q=${user.userId}`),
    );
    expect(byId.items.map((u) => u.id)).toEqual([user.userId]);
    const detail = data<Record<string, unknown>>(
      await admin.agent.get(`/api/v1/admin/users/${user.userId}`),
    );
    expect(detail).toMatchObject({
      status: "ACTIVE",
      activeSessions: 1,
      subscription: { plan: "FREE", effectivePlan: "FREE" },
    });
    expect(Object.keys(detail).join(",")).not.toMatch(
      /password|hash|secret|accessToken|refreshToken/i,
    );

    expect(
      (await admin.agent.post(`/api/v1/admin/users/${user.userId}/suspend`, {})).statusCode,
    ).toBe(422); // reason required
    expect(
      (
        await admin.agent.post(`/api/v1/admin/users/${admin.userId}/suspend`, {
          reason: "testing self",
        })
      ).statusCode,
    ).toBe(403);
    const s = await admin.agent.post(`/api/v1/admin/users/${user.userId}/suspend`, {
      reason: "abuse report #12",
    });
    expect(data<{ status: string; activeSessions: number }>(s)).toMatchObject({
      status: "SUSPENDED",
      activeSessions: 0,
    });
    expect((await user.agent.get("/api/v1/auth/me")).statusCode).toBe(401);
    const r = await admin.agent.post(`/api/v1/admin/users/${user.userId}/reactivate`, {
      reason: "appeal accepted",
    });
    expect(data<{ status: string }>(r).status).toBe("ACTIVE");

    const log = data<
      {
        action: string;
        requestId: string | null;
        actorId: string;
        metadata: Record<string, unknown>;
      }[]
    >(await admin.agent.get("/api/v1/admin/audit-logs?action=admin.user_"));
    expect(log.map((e) => e.action)).toEqual(["admin.user_reactivated", "admin.user_suspended"]);
    expect(log[1]).toMatchObject({
      actorId: admin.userId,
      metadata: {
        reason: "abuse report #12",
        before: { status: "ACTIVE" },
        after: { status: "SUSPENDED" },
      },
    });
    expect(log[1]!.requestId).toBeTruthy();
  });
});

describe("7–8. connectors and secret redaction", () => {
  it("shows credential names (never values), guards enabling, and audits setting changes", async () => {
    const { admin } = await admins();
    const res = await admin.agent.get("/api/v1/admin/sources");
    expect(res.body).not.toContain(SECRET_VALUE);
    const sources = data<
      {
        id: string;
        slug: string;
        status: string;
        credentials: { configured: boolean; missing: string[] };
        isSample: boolean;
      }[]
    >(res);
    const amazon = sources.find((s) => s.slug === "amazon_in")!;
    expect(amazon.credentials.configured).toBe(false);
    expect(amazon.credentials.missing).toContain("AMAZON_CREATORS_CREDENTIAL_ID");
    // A source pending credentials/approval can't be switched on.
    expect(
      (
        await admin.agent.patch(`/api/v1/admin/sources/${amazon.id}`, {
          status: "ACTIVE",
          reason: "try",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await admin.agent.patch(`/api/v1/admin/sources/${amazon.id}`, { timeoutMs: 9000 }))
        .statusCode,
    ).toBe(422); // reason
    const upd = await admin.agent.patch(`/api/v1/admin/sources/${amazon.id}`, {
      rateLimitPerMinute: 30,
      reason: "partner limit",
    });
    expect(upd.statusCode).toBe(200);
    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.source_updated" },
    });
    expect(entry.metadata).toMatchObject({
      before: { rateLimitPerMinute: 60 },
      after: { rateLimitPerMinute: 30 },
      reason: "partner limit",
    });
    expect(JSON.stringify(entry.metadata)).not.toContain(SECRET_VALUE);
    // Prompt 22 regression: a partner source with NO authorized integration is never
    // reported as configured, and can't be enabled even after being DISABLED first.
    const croma = sources.find((x) => x.slug === "croma") as unknown as {
      id: string;
      credentials: { state: string; configured: boolean; reason: string | null };
    };
    expect(croma.credentials).toMatchObject({ state: "PENDING_APPROVAL", configured: false });
    const disable = await admin.agent.patch(`/api/v1/admin/sources/${croma.id}`, {
      status: "DISABLED",
      reason: "prep",
    });
    expect(disable.statusCode).toBe(200);
    const sneak = await admin.agent.patch(`/api/v1/admin/sources/${croma.id}`, {
      status: "ACTIVE",
      reason: "try enabling without an integration",
    });
    expect(sneak.statusCode).toBe(409);
    expect(sneak.body).toContain("PENDING_APPROVAL");
    const stored = await ctx.prisma.shoppingSource.findUniqueOrThrow({ where: { id: croma.id } });
    expect(stored.status).toBe("DISABLED");
    const hc = await admin.agent.post("/api/v1/admin/sources/health-check", {
      reason: "after config change",
    });
    expect(data<{ queued: boolean }>(hc).queued).toBe(true);
  });
});

describe("9. AI configuration", () => {
  it("stores the agent's LLM settings (no keys), audits changes and serves them to the agent with the budget state", async () => {
    const { admin } = await admins();
    const initial = data<{ config: { stored: boolean } }>(
      await admin.agent.get("/api/v1/admin/ai-models"),
    );
    expect(initial.config.stored).toBe(false);
    const body = {
      provider: "google",
      model: "gemini-test-model",
      temperature: 0.2,
      maxTokens: 4096,
      enabled: true,
      fallbackProvider: "openai",
      fallbackModel: null,
      monthlyTokenLimit: 1000,
      inputPaisePerMillionTokens: 5000,
      outputPaisePerMillionTokens: 15000,
      reason: "switch to gemini",
    };
    // A fallback provider without a fallback model is invalid.
    expect((await admin.agent.request("PUT", "/api/v1/admin/ai-models", body)).statusCode).toBe(
      422,
    );
    const put = await admin.agent.request("PUT", "/api/v1/admin/ai-models", {
      ...body,
      fallbackModel: "gpt-test",
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toMatch(/api[_-]?key/i);
    const internal = await ctx.app.inject({
      method: "GET",
      url: "/internal/v1/ai-config",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(internal.json<{ data: unknown }>().data ?? internal.json()).toMatchObject({
      config: {
        provider: "google",
        model: "gemini-test-model",
        fallbackProvider: "openai",
        fallbackModel: "gpt-test",
        enabled: true,
      },
      limitReached: false,
    });
    // Budget used up: the agent is told to stop calling the LLM.
    await ctx.prisma.agentRun.create({
      data: {
        userId: admin.userId,
        graph: "shopping_search",
        model: "gemini-test-model",
        provider: "google",
        input: {},
        inputTokens: 800,
        outputTokens: 300,
      },
    });
    const after = await ctx.app.inject({
      method: "GET",
      url: "/internal/v1/ai-config",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.stringify(after.json())).toContain('"limitReached":true');
    const usage = data<{
      usage: { inputTokens: number; estimatedCostPaise: number | null; limitReached: boolean };
    }>(await admin.agent.get("/api/v1/admin/ai-models"));
    expect(usage.usage).toMatchObject({
      inputTokens: 800,
      limitReached: true,
      estimatedCostPaise: 9,
    }); // 800×5000/1e6 + 300×15000/1e6 = 8.5 → 9
    expect(await ctx.prisma.auditLog.count({ where: { action: "admin.ai_model_updated" } })).toBe(
      1,
    );
    const health = data<{ status: string; agent: Record<string, unknown> }>(
      await admin.agent.post("/api/v1/admin/ai-models/health"),
    );
    expect(health).toEqual({ status: "ok", agent: { status: "ok", provider: "rules", model: "" } });
    // The internal route needs the service token.
    expect(
      (await ctx.app.inject({ method: "GET", url: "/internal/v1/ai-config" })).statusCode,
    ).toBe(401);
  });
});

describe("10, 15. search analytics and privacy", () => {
  it("lists only queries searched by several users, with no user identities", async () => {
    const { admin } = await admins();
    const users = await Promise.all(
      [1, 2, 3].map(async (i) => (await signUp(ctx, `s${i}@example.com`)).userId),
    );
    for (const u of users)
      await ctx.prisma.search.create({
        data: { userId: u, query: "Best Phone under 30k ", status: "COMPLETED" },
      });
    await ctx.prisma.search.create({
      data: { userId: users[0]!, query: "my private medical query", status: "COMPLETED" },
    });
    await ctx.prisma.search.create({ data: { userId: users[1]!, query: "x", status: "FAILED" } });
    const res = await admin.agent.get("/api/v1/admin/analytics?days=30");
    const a = data<{
      total: number;
      popularQueries: { query: string; users: number }[];
      emptyResultQueries: { query: string }[];
      successRateBp: number;
    }>(res);
    expect(a.total).toBe(5);
    expect(a.popularQueries).toEqual([{ query: "best phone under 30k", searches: 3, users: 3 }]);
    expect(a.emptyResultQueries.map((q) => q.query)).toEqual(["best phone under 30k"]);
    expect(res.body).not.toContain("private medical");
    for (const u of users) expect(res.body).not.toContain(u);
    expect(a.successRateBp).toBe(8000);
  });
});

describe("11. subscription analytics", () => {
  it("counts plans in effect and estimates MRR from list prices (labelled)", async () => {
    const { admin, user } = await admins();
    await ctx.prisma.subscription.update({
      where: { userId: user.userId },
      data: {
        planCode: "PRO",
        status: "ACTIVE",
        interval: "ANNUAL",
        provider: "sandbox",
        providerSubscriptionId: "sbx-1",
        currentPeriodEnd: new Date(Date.now() + 200 * 86_400_000),
      },
    });
    const s = data<{
      plans: { plan: string; users: number }[];
      activePaid: number;
      estimatedMrrPaise: number;
      note: string;
    }>(await admin.agent.get("/api/v1/admin/subscriptions"));
    expect(s.plans).toEqual(
      expect.arrayContaining([
        { plan: "PRO", users: 1 },
        { plan: "FREE", users: 1 },
      ]),
    );
    expect(s.activePaid).toBe(1);
    expect(s.estimatedMrrPaise).toBe(Math.floor(199_000 / 12));
    expect(s.note).toMatch(/estimate/i);
    const list = data<{ email: string; effectivePlan: string }[]>(
      await admin.agent.get("/api/v1/admin/subscriptions/users"),
    );
    expect(list).toEqual([expect.objectContaining({ effectivePlan: "PRO" })]);
  });
});

describe("13. jobs", () => {
  it("lists failures without payloads and retries exactly one failed job (admin only, audited)", async () => {
    const { admin, user } = await admins();
    const q = ctx.jobs.queue(QueueName.alertEvaluation);
    const checkId = randomUUID();
    await q.add(
      QueueName.alertEvaluation,
      { checkId },
      { jobId: `alerts.${checkId}`, attempts: 1 },
    );
    const worker = new Worker(
      QueueName.alertEvaluation,
      async () => {
        throw new Error("boom: database timeout");
      },
      { connection: { url: testRedisUrl() } as never, prefix: `${ctx.prefix}:bull` },
    );
    try {
      const deadline = Date.now() + 10_000;
      while ((await q.getFailedCount()) === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
    } finally {
      await worker.close();
    }
    const res = await admin.agent.get("/api/v1/admin/jobs");
    const jobs = data<{ failed: { queue: string; id: string; failedReason: string }[] }>(res);
    expect(jobs.failed).toEqual([
      expect.objectContaining({
        queue: "alert-evaluation",
        id: `alerts.${checkId}`,
        failedReason: "boom: database timeout",
      }),
    ]);
    // The job payload (its data) is never returned, only the id and error text.
    expect(res.body).not.toContain('"checkId"');
    expect(
      (
        await user.agent.post(`/api/v1/admin/jobs/alerts.${checkId}/retry`, {
          queue: "alert-evaluation",
          reason: "x",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await admin.agent.post(`/api/v1/admin/jobs/alerts.${checkId}/retry`, {
          queue: "dead-letter",
          reason: "retry",
        })
      ).statusCode,
    ).toBe(422);
    const ok = await admin.agent.post(`/api/v1/admin/jobs/alerts.${checkId}/retry`, {
      queue: "alert-evaluation",
      reason: "transient db issue",
    });
    expect(ok.statusCode).toBe(200);
    expect(await (await q.getJob(`alerts.${checkId}`))!.getState()).toBe("waiting");
    expect(
      (
        await admin.agent.post(`/api/v1/admin/jobs/alerts.${checkId}/retry`, {
          queue: "alert-evaluation",
          reason: "again",
        })
      ).statusCode,
    ).toBe(409);
    expect(await ctx.prisma.auditLog.count({ where: { action: "admin.job_retried" } })).toBe(1);
    await q.obliterate({ force: true });
  });
});

describe("catalog", () => {
  it("corrects and deactivates a product with a reason, keeping offers (provenance)", async () => {
    const { admin } = await admins();
    const cat = await ctx.prisma.category.findFirstOrThrow({ where: { slug: "smartphones" } });
    const p = await ctx.prisma.product.create({
      data: {
        name: "Acme Nova 7",
        brand: "Acme",
        categoryId: cat.id,
        normalizedName: "acme nova 7",
      } as never,
    });
    const list = data<{ id: string }[]>(await admin.agent.get("/api/v1/admin/products?q=nova"));
    expect(list.map((x) => x.id)).toEqual([p.id]);
    expect(
      (await admin.agent.patch(`/api/v1/admin/products/${p.id}`, { isActive: false })).statusCode,
    ).toBe(422);
    const r = await admin.agent.patch(`/api/v1/admin/products/${p.id}`, {
      isActive: false,
      name: "Acme Nova 7 5G",
      reason: "duplicate title fix",
    });
    expect(r.statusCode).toBe(200);
    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.product_corrected" },
    });
    expect(entry.metadata).toMatchObject({
      before: { isActive: true, name: "Acme Nova 7" },
      after: { isActive: false, name: "Acme Nova 7 5G" },
    });
    const c = await admin.agent.patch(`/api/v1/admin/categories/${cat.id}`, {
      isActive: false,
      reason: "merge",
    });
    expect(c.statusCode).toBe(200);
  });
});
