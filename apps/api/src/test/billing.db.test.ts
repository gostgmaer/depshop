/**
 * Phase 6.1 API: plans, checkout + server-side verification, signed and
 * idempotent webhooks, renewal / failed renewal / grace / cancellation /
 * expiry, plan changes, atomic usage limits (including concurrency), refunds
 * and cross-user isolation. The payment provider is the SANDBOX test double
 * (no money moves); webhooks are signed exactly like the shared service's.
 */
import { randomUUID } from "node:crypto";
import { SandboxBillingProvider, signEasyDevPayload } from "@dealmind/billing";
import { seedReferenceData } from "@dealmind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

const SECRET = "b".repeat(40);
const DAY = 86_400_000;
let ctx: TestContext;
let sandbox: SandboxBillingProvider;
let clock = new Date("2026-11-16T06:30:00.000Z"); // 12:00 IST

beforeAll(async () => {
  sandbox = new SandboxBillingProvider();
  sandbox.now = () => clock;
  ctx = await createTestApp(
    { PAYMENT_WEBHOOK_SECRET: SECRET, BILLING_GRACE_DAYS: "3" },
    { billingProvider: sandbox, billingNow: () => clock },
  );
});
afterAll(() => ctx.close());
beforeEach(async () => {
  clock = new Date("2026-11-16T06:30:00.000Z");
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
  sandbox.subscriptions.clear();
  sandbox.pending.clear();
  sandbox.payments.length = 0;
  sandbox.invoices.length = 0;
  // Plans were provisioned at startup; the seed reset the rows, so provision again.
  const { provisionProviderPlans } = await import("@dealmind/billing");
  await provisionProviderPlans(ctx.prisma, ctx.app.billing.entitlements, sandbox);
});

const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
type Sub = {
  plan: { code: string };
  effectivePlan: string;
  status: string;
  interval: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
};
type Checkout = {
  id: string;
  status: string;
  amountPaise: number;
  provider: string;
  plan: string;
  failureReason: string | null;
};

async function iamIdOf(userId: string) {
  return (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })).iamUserId;
}

/** Sends a webhook signed like the shared payment service. */
async function webhook(
  type: string,
  customerId: string,
  opts: { id?: string; secret?: string; at?: Date } = {},
) {
  const body = JSON.stringify({
    id: opts.id ?? randomUUID(),
    type,
    createdAt: clock.toISOString(),
    tenantId: "easydev",
    applicationId: "dealmind",
    data: { customerId, status: "hint-only" },
  });
  const t = Math.floor((opts.at ?? clock).getTime() / 1000);
  return ctx.app.inject({
    method: "POST",
    url: "/webhooks/easydev-payments",
    headers: {
      "content-type": "application/json",
      "x-easydev-signature": signEasyDevPayload(opts.secret ?? SECRET, t, body),
    },
    payload: body,
  });
}

async function subscribe(
  agent: Awaited<ReturnType<typeof signUp>>["agent"],
  plan = "PRO",
  interval = "MONTHLY",
) {
  const c = data<Checkout>(await agent.post("/api/v1/billing/checkout", { plan, interval }));
  const done = data<Checkout>(
    await agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, { sandboxOutcome: "success" }),
  );
  return { checkout: c, done };
}

const notes = (userId: string) =>
  ctx.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

describe("1. plans", () => {
  it("lists plans with server prices in paise, limits, features and purchasable intervals", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/v1/billing/plans" });
    expect(res.statusCode).toBe(200);
    const plans = data<
      {
        code: string;
        monthlyPricePaise: number;
        annualPricePaise: number | null;
        purchasableIntervals: string[];
        limits: Record<string, number>;
      }[]
    >(res);
    expect(plans.map((p) => p.code)).toEqual(["FREE", "PRO", "BUSINESS"]);
    expect(plans[0]).toMatchObject({ monthlyPricePaise: 0, purchasableIntervals: [] });
    expect(plans[1]).toMatchObject({
      monthlyPricePaise: 19_900,
      annualPricePaise: 199_000,
      purchasableIntervals: ["MONTHLY", "ANNUAL"],
    });
    expect(plans[1]!.limits.searchesPerDay).toBe(200);
  });
});

describe("2–4. checkout, verification and subscription creation", () => {
  it("computes the amount on the server, resumes a repeated click, and grants the plan only after verification", async () => {
    const { agent, userId } = await signUp(ctx, "buyer@example.com");
    // The client can't set an amount (strict body) or buy FREE.
    expect(
      (await agent.post("/api/v1/billing/checkout", { plan: "PRO", amountPaise: 1 })).statusCode,
    ).toBe(422);
    expect((await agent.post("/api/v1/billing/checkout", { plan: "FREE" })).statusCode).toBe(422);

    const c = data<Checkout>(
      await agent.post("/api/v1/billing/checkout", { plan: "PRO", interval: "ANNUAL" }),
    );
    expect(c).toMatchObject({
      status: "PENDING",
      amountPaise: 199_000,
      provider: "SANDBOX",
      plan: "PRO",
    });
    const again = data<Checkout>(
      await agent.post("/api/v1/billing/checkout", { plan: "PRO", interval: "ANNUAL" }),
    );
    expect(again.id).toBe(c.id);

    // Not paid yet: still free.
    expect(data<Sub>(await agent.get("/api/v1/billing/subscription"))).toMatchObject({
      effectivePlan: "FREE",
      plan: { code: "FREE" },
    });
    // A Razorpay-shaped proof doesn't belong to a sandbox checkout.
    expect(
      (
        await agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, {
          razorpayPaymentId: "pay_x",
          razorpaySubscriptionId: "sub_x",
          razorpaySignature: "sig",
        })
      ).statusCode,
    ).toBe(400);

    const done = data<Checkout>(
      await agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, { sandboxOutcome: "success" }),
    );
    expect(done.status).toBe("SUCCEEDED");
    const sub = data<Sub>(await agent.get("/api/v1/billing/subscription"));
    expect(sub).toMatchObject({
      plan: { code: "PRO" },
      effectivePlan: "PRO",
      status: "ACTIVE",
      interval: "ANNUAL",
      cancelAtPeriodEnd: false,
    });
    expect(new Date(sub.currentPeriodEnd!).getUTCFullYear()).toBe(2027);
    // Confirming again is harmless.
    expect(
      data<Checkout>(
        await agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, { sandboxOutcome: "success" }),
      ).status,
    ).toBe("SUCCEEDED");
    // A second checkout while subscribed is refused (change plan instead).
    expect((await agent.post("/api/v1/billing/checkout", { plan: "BUSINESS" })).statusCode).toBe(
      409,
    );

    expect((await notes(userId)).map((n) => n.type)).toEqual(["SUBSCRIPTION_ACTIVATED"]);
    const audit = await ctx.prisma.auditLog.findMany({
      where: { action: { startsWith: "billing." } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "billing.checkout_started",
      "billing.subscription_synced",
    ]);
    const pays = data<{ amountPaise: number; status: string; description: string }[]>(
      await agent.get("/api/v1/billing/payments"),
    );
    expect(pays).toEqual([
      expect.objectContaining({
        amountPaise: 199_000,
        status: "SUCCESS",
        description: "DealMind Pro (annual)",
      }),
    ]);
    const inv = data<{ totalPaise: number; taxPaise: number; amountPaise: number }[]>(
      await agent.get("/api/v1/billing/invoices"),
    );
    expect(inv).toHaveLength(1);
    expect(inv[0]!.amountPaise + inv[0]!.taxPaise).toBe(inv[0]!.totalPaise);
  });

  it("a declined payment fails the checkout and grants nothing", async () => {
    const { agent } = await signUp(ctx, "declined@example.com");
    const c = data<Checkout>(await agent.post("/api/v1/billing/checkout", { plan: "PRO" }));
    const r = data<Checkout>(
      await agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, { sandboxOutcome: "failure" }),
    );
    expect(r).toMatchObject({ status: "FAILED", failureReason: "Sandbox payment declined" });
    expect(data<Sub>(await agent.get("/api/v1/billing/subscription")).effectivePlan).toBe("FREE");
    // Recovery: a new checkout can be started.
    expect((await agent.post("/api/v1/billing/checkout", { plan: "PRO" })).statusCode).toBe(201);
  });

  it("expires an abandoned checkout", async () => {
    const { agent } = await signUp(ctx, "abandon@example.com");
    const c = data<Checkout>(await agent.post("/api/v1/billing/checkout", { plan: "PRO" }));
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(data<Checkout>(await agent.get(`/api/v1/billing/checkout/${c.id}`)).status).toBe(
      "EXPIRED",
    );
    expect(
      data<Checkout>(
        await agent.post(`/api/v1/billing/checkout/${c.id}/confirm`, { sandboxOutcome: "success" }),
      ).status,
    ).toBe("EXPIRED");
    expect(data<Sub>(await agent.get("/api/v1/billing/subscription")).effectivePlan).toBe("FREE");
  });
});

describe("5–6. webhooks", () => {
  it("rejects bad signatures and stale timestamps without recording anything", async () => {
    const { userId } = await signUp(ctx, "wh@example.com");
    const iam = await iamIdOf(userId);
    expect(
      (await webhook("subscription.updated", iam, { secret: "x".repeat(40) })).statusCode,
    ).toBe(401);
    expect(
      (await webhook("subscription.updated", iam, { at: new Date(clock.getTime() - 10 * 60_000) }))
        .statusCode,
    ).toBe(401);
    const unsigned = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/easydev-payments",
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.statusCode).toBe(401);
    expect(await ctx.prisma.billingEvent.count()).toBe(0);
  });

  it("processes each event id once", async () => {
    const { agent, userId } = await signUp(ctx, "dup@example.com");
    await subscribe(agent);
    const iam = await iamIdOf(userId);
    const id = randomUUID();
    const first = await webhook("subscription.updated", iam, { id });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ processed: true });
    const second = await webhook("subscription.updated", iam, { id });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true });
    const rows = await ctx.prisma.billingEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ processingStatus: "PROCESSED", attempts: 1, userId });
    // Unknown customers are recorded and ignored.
    expect((await webhook("subscription.updated", "not-a-dealmind-user")).statusCode).toBe(202);
  });
});

describe("7–9, 14–15. lifecycle from the provider's state", () => {
  it("renews, fails a renewal with a grace period, then lapses to FREE", async () => {
    const { agent, userId } = await signUp(ctx, "cycle@example.com");
    await subscribe(agent);
    const iam = await iamIdOf(userId);
    const providerSub = [...sandbox.subscriptions.values()][0]!;
    const firstEnd = providerSub.currentPeriodEnd;

    clock = new Date(firstEnd.getTime() + 60_000);
    sandbox.renew(providerSub.id, "success");
    expect((await webhook("subscription.updated", iam)).statusCode).toBe(200);
    let sub = data<Sub>(await agent.get("/api/v1/billing/subscription"));
    expect(new Date(sub.currentPeriodEnd!).getTime()).toBeGreaterThan(firstEnd.getTime());
    expect(sub.effectivePlan).toBe("PRO");

    clock = new Date(new Date(sub.currentPeriodEnd!).getTime() + 60_000);
    sandbox.renew(providerSub.id, "failure");
    await webhook("subscription.updated", iam);
    sub = data<Sub>(await agent.get("/api/v1/billing/subscription"));
    expect(sub).toMatchObject({ status: "PAST_DUE", effectivePlan: "PRO" });
    expect(new Date(sub.graceUntil!).getTime()).toBe(clock.getTime() + 3 * DAY);

    // Grace period over: limits fall back to FREE (even before any further event).
    clock = new Date(clock.getTime() + 3 * DAY + 60_000);
    sub = data<Sub>(await agent.get("/api/v1/billing/subscription"));
    expect(sub).toMatchObject({ status: "PAST_DUE", effectivePlan: "FREE", graceUntil: null });

    sandbox.setStatus(providerSub.id, "EXPIRED");
    await webhook("subscription.updated", iam);
    expect(data<Sub>(await agent.get("/api/v1/billing/subscription"))).toMatchObject({
      status: "EXPIRED",
      effectivePlan: "FREE",
    });
    expect((await notes(userId)).map((n) => n.type)).toEqual([
      "SUBSCRIPTION_ACTIVATED",
      "SUBSCRIPTION_RENEWED",
      "PAYMENT_FAILED",
      "SUBSCRIPTION_ENDED",
    ]);
  });

  it("cancels at period end: access continues, then ends", async () => {
    const { agent, userId } = await signUp(ctx, "cancel@example.com");
    await subscribe(agent);
    const sub = data<Sub>(await agent.post("/api/v1/billing/cancel", {}));
    expect(sub).toMatchObject({ cancelAtPeriodEnd: true, status: "ACTIVE", effectivePlan: "PRO" });
    expect(data<Sub>(await agent.post("/api/v1/billing/cancel", {})).cancelAtPeriodEnd).toBe(true); // idempotent
    const providerSub = [...sandbox.subscriptions.values()][0]!;
    clock = new Date(providerSub.currentPeriodEnd.getTime() + 60_000);
    sandbox.renew(providerSub.id, "success"); // a scheduled cancel ends instead of renewing
    await webhook("subscription.updated", await iamIdOf(userId));
    expect(data<Sub>(await agent.get("/api/v1/billing/subscription"))).toMatchObject({
      status: "CANCELLED",
      effectivePlan: "FREE",
    });
    expect((await notes(userId)).map((n) => n.type)).toEqual([
      "SUBSCRIPTION_ACTIVATED",
      "SUBSCRIPTION_CANCELLED",
      "SUBSCRIPTION_ENDED",
    ]);
    // Without a paid subscription there's nothing to cancel.
    expect((await agent.post("/api/v1/billing/cancel", {})).statusCode).toBe(409);
  });

  it("a missed webhook is caught up by the next read of the provider (reconcile)", async () => {
    const { agent, userId } = await signUp(ctx, "missed@example.com");
    await subscribe(agent);
    const providerSub = [...sandbox.subscriptions.values()][0]!;
    clock = new Date(providerSub.currentPeriodEnd.getTime() + 60_000);
    sandbox.renew(providerSub.id, "failure"); // no webhook arrives
    const r = await ctx.app.billing.service["sync"]!.syncUser(userId, { kind: "reconcile" });
    expect(r).toMatchObject({
      status: "synced",
      providerStatus: "PAST_DUE",
      changes: ["payment_failed"],
    });
  });
});

describe("10–11. plan changes", () => {
  it("upgrades, downgrades, and downgrades to FREE at period end", async () => {
    const { agent } = await signUp(ctx, "change@example.com");
    expect((await agent.post("/api/v1/billing/change-plan", { plan: "BUSINESS" })).statusCode).toBe(
      409,
    ); // checkout first
    await subscribe(agent);
    let sub = data<Sub>(
      await agent.post("/api/v1/billing/change-plan", { plan: "BUSINESS", interval: "MONTHLY" }),
    );
    expect(sub).toMatchObject({ plan: { code: "BUSINESS" }, effectivePlan: "BUSINESS" });
    sub = data<Sub>(
      await agent.post("/api/v1/billing/change-plan", { plan: "PRO", interval: "ANNUAL" }),
    );
    expect(sub).toMatchObject({ plan: { code: "PRO" }, interval: "ANNUAL" });
    sub = data<Sub>(await agent.post("/api/v1/billing/change-plan", { plan: "FREE" }));
    expect(sub).toMatchObject({ cancelAtPeriodEnd: true, effectivePlan: "PRO" });
  });
});

describe("12–13. usage limits (atomic)", () => {
  it("enforces the daily search limit from the configurable plan and resets at IST midnight", async () => {
    const { agent } = await signUp(ctx, "limits@example.com");
    await ctx.prisma.subscriptionPlan.update({
      where: { code: "FREE" },
      data: { limits: { searchesPerDay: 2 } },
    });
    const search = (q: string) => agent.post("/api/v1/search", { query: q });
    expect((await search("phone one")).statusCode).toBe(202);
    expect((await search("phone two")).statusCode).toBe(202);
    const third = await search("phone three");
    expect(third.statusCode).toBe(429);
    expect(third.json<{ error: { code: string } }>().error.code).toBe("USAGE_LIMIT_EXCEEDED");
    const usage = data<{
      items: { key: string; used: number; limit: number; resetsAt: string | null }[];
    }>(await agent.get("/api/v1/usage"));
    expect(usage.items.find((i) => i.key === "searches")).toMatchObject({
      used: 2,
      limit: 2,
      resetsAt: "2026-11-16T18:30:00.000Z",
    });
    clock = new Date("2026-11-16T18:31:00.000Z"); // 00:01 IST next day
    expect((await search("phone four")).statusCode).toBe(202);
  });

  it("never exceeds a limit under concurrent requests", async () => {
    const { agent, userId } = await signUp(ctx, "race@example.com");
    await ctx.prisma.subscriptionPlan.update({
      where: { code: "FREE" },
      data: { limits: { searchesPerDay: 3, watchlists: 2 } },
    });
    const searches = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        agent.post("/api/v1/search", { query: `race query ${i}` }),
      ),
    );
    expect(searches.filter((r) => r.statusCode === 202)).toHaveLength(3);
    expect(searches.filter((r) => r.statusCode === 429)).toHaveLength(7);
    expect(await ctx.prisma.search.count({ where: { userId } })).toBe(3);
    const counter = await ctx.prisma.usageCounter.findFirstOrThrow({
      where: { userId, metric: "SEARCH" },
    });
    expect(counter.quantity).toBe(3);

    const lists = await Promise.all(
      Array.from({ length: 8 }, (_, i) => agent.post("/api/v1/watchlists", { name: `List ${i}` })),
    );
    expect(lists.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(await ctx.prisma.watchlist.count({ where: { userId } })).toBe(2);
  });

  it("paid plans raise limits immediately after verification", async () => {
    const { agent } = await signUp(ctx, "raise@example.com");
    await ctx.prisma.subscriptionPlan.update({
      where: { code: "FREE" },
      data: { limits: { searchesPerDay: 1 } },
    });
    expect((await agent.post("/api/v1/search", { query: "first search" })).statusCode).toBe(202);
    expect((await agent.post("/api/v1/search", { query: "second search" })).statusCode).toBe(429);
    await subscribe(agent);
    expect((await agent.post("/api/v1/search", { query: "second search" })).statusCode).toBe(202);
    const job = await ctx.app.billing.entitlements.checkEntitlement(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { email: "raise@example.com" } })).id,
      "prioritySearch",
    );
    expect(job).toBe(true);
  });
});

describe("16. cross-user isolation", () => {
  it("another user's checkout is not found and their payments never appear", async () => {
    const a = await signUp(ctx, "owner@example.com");
    const b = await signUp(ctx, "other@example.com");
    const { checkout } = await subscribe(a.agent);
    expect((await b.agent.get(`/api/v1/billing/checkout/${checkout.id}`)).statusCode).toBe(404);
    expect(
      (
        await b.agent.post(`/api/v1/billing/checkout/${checkout.id}/confirm`, {
          sandboxOutcome: "success",
        })
      ).statusCode,
    ).toBe(404);
    expect(data<unknown[]>(await b.agent.get("/api/v1/billing/payments"))).toEqual([]);
    expect(data<unknown[]>(await b.agent.get("/api/v1/billing/invoices"))).toEqual([]);
    expect(data<Sub>(await b.agent.get("/api/v1/billing/subscription")).effectivePlan).toBe("FREE");
    expect((await b.agent.post("/api/v1/billing/cancel", {})).statusCode).toBe(409);
    expect(data<Sub>(await a.agent.get("/api/v1/billing/subscription")).cancelAtPeriodEnd).toBe(
      false,
    );
    // Unauthenticated access.
    expect(
      (await ctx.app.inject({ method: "GET", url: "/api/v1/billing/subscription" })).statusCode,
    ).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/usage" })).statusCode).toBe(401);
  });
});

describe("17. refunds", () => {
  it("reflects a refund from the provider and tells the user", async () => {
    const { agent, userId } = await signUp(ctx, "refund@example.com");
    await subscribe(agent);
    const iam = await iamIdOf(userId);
    expect(sandbox.refundLatest(iam)).not.toBeNull();
    expect((await webhook("refund.updated", iam)).statusCode).toBe(200);
    const pays = data<{ status: string }[]>(await agent.get("/api/v1/billing/payments"));
    expect(pays[0]!.status).toBe("REFUNDED");
    expect((await notes(userId)).map((n) => n.type)).toContain("REFUND_UPDATED");
  });
});

describe("payment status synchronization (reconcile)", () => {
  it("re-reads due subscriptions and expires abandoned checkouts", async () => {
    const { reconcileSubscriptions } = await import("@dealmind/billing");
    const paid = await signUp(ctx, "rec-paid@example.com");
    await subscribe(paid.agent);
    const idle = await signUp(ctx, "rec-idle@example.com");
    await idle.agent.post("/api/v1/billing/checkout", { plan: "PRO" });
    const providerSub = [...sandbox.subscriptions.values()][0]!;
    clock = new Date(providerSub.currentPeriodEnd.getTime() + 60_000);
    sandbox.renew(providerSub.id, "failure"); // no webhook
    const sync = (
      ctx.app.billing.service as unknown as { sync: Parameters<typeof reconcileSubscriptions>[1] }
    ).sync;
    const r = await reconcileSubscriptions(ctx.prisma, sync, { now: clock });
    expect(r).toEqual({ checked: 1, changed: 1, failed: 0, expiredCheckouts: 1 });
    expect(data<Sub>(await paid.agent.get("/api/v1/billing/subscription")).status).toBe("PAST_DUE");
    // A provider outage is counted, not thrown; the next run retries.
    clock = new Date(clock.getTime() + 7 * 3_600_000);
    sandbox.failNext = "down";
    expect((await reconcileSubscriptions(ctx.prisma, sync, { now: clock })).failed).toBe(1);
  });
});

describe("exports (plan feature)", () => {
  it("is refused on FREE, works on PRO with a monthly limit, and is formula-safe", async () => {
    const { agent, userId } = await signUp(ctx, "export@example.com");
    expect((await agent.get("/api/v1/exports/watchlists.csv")).statusCode).toBe(403);
    await subscribe(agent);
    await ctx.prisma.subscriptionPlan.update({
      where: { code: "PRO" },
      data: { limits: { exportsPerMonth: 1 } },
    });
    await agent.post("/api/v1/watchlists", { name: '=HYPERLINK("x")' });
    await ctx.prisma.search.create({ data: { userId, query: 'phone, "5G"', status: "COMPLETED" } });
    const res = await agent.get("/api/v1/exports/searches.csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain('"phone, ""5G"""');
    expect((await agent.get("/api/v1/exports/watchlists.csv")).statusCode).toBe(429);
    const { csvCell } = await import("../modules/billing/export-routes.js");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
});

describe("double-payment guard", () => {
  it("refuses a new checkout while a verified payment is still being recorded", async () => {
    const { agent, userId } = await signUp(ctx, "guard@example.com");
    const c = data<Checkout>(await agent.post("/api/v1/billing/checkout", { plan: "PRO" }));
    await ctx.prisma.checkoutSession.update({ where: { id: c.id }, data: { status: "VERIFYING" } });
    const again = await agent.post("/api/v1/billing/checkout", { plan: "PRO" });
    expect(again.statusCode).toBe(409);
    expect(await ctx.prisma.checkoutSession.count({ where: { userId } })).toBe(1);
  });
});
