/**
 * Free launch offer (LAUNCH_FREE_PLAN=PRO): every account gets Pro at no cost,
 * enforced server-side, and nothing can be bought. Normal billing (setting unset)
 * is covered by billing.db.test.ts.
 */
import { SandboxBillingProvider } from "@dealmind/billing";
import { seedReferenceData } from "@dealmind/db";
import type { LaunchOfferView, SubscriptionView, UsageView } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;
let sandbox: SandboxBillingProvider;
const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;

beforeAll(async () => {
  sandbox = new SandboxBillingProvider();
  ctx = await createTestApp({ LAUNCH_FREE_PLAN: "PRO" }, { billingProvider: sandbox });
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
  const { provisionProviderPlans } = await import("@dealmind/billing");
  await provisionProviderPlans(ctx.prisma, ctx.app.billing.entitlements, sandbox);
});

describe("free launch offer", () => {
  it("is announced publicly, without signing in", async () => {
    const res = await new Agent(ctx.app).get("/api/v1/billing/offer");
    expect(res.statusCode).toBe(200);
    expect(data<LaunchOfferView>(res)).toEqual({
      freeLaunch: { planCode: "PRO", planName: "Pro" },
    });
  });

  it("gives a new account Pro limits and features at no cost", async () => {
    const { agent, userId } = await signUp(ctx, "launch@example.com");
    const sub = data<SubscriptionView>(await agent.get("/api/v1/billing/subscription"));
    expect(sub.plan.code).toBe("FREE"); // nothing was bought
    expect(sub.effectivePlan).toBe("PRO"); // but Pro applies
    expect(sub.provider).toBeNull();

    const usage = data<UsageView>(await agent.get("/api/v1/usage"));
    expect(usage.plan).toBe("PRO");
    const limit = (k: string) => usage.items.find((i) => i.key === k)?.limit;
    expect(limit("searches")).toBe(200);
    expect(limit("activeAlerts")).toBe(100);
    expect(usage.historyDays).toBe(365);

    // Nothing was charged or recorded as a subscription.
    expect(
      await ctx.prisma.subscription.count({ where: { userId, planCode: { not: "FREE" } } }),
    ).toBe(0);
    expect(sandbox.payments).toHaveLength(0);
  });

  it("refuses checkout: nothing is sold while it is free", async () => {
    const { agent } = await signUp(ctx, "buyer@example.com");
    const res = await agent.post("/api/v1/billing/checkout", {
      plan: "BUSINESS",
      interval: "MONTHLY",
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(/free for everyone during the launch/);
    expect(sandbox.pending.size).toBe(0);
  });

  it("limit messages don't tell users to upgrade (nothing can be bought)", async () => {
    // Plans are admin-editable rows: tune the launch plan's limit (here 2 watchlists).
    const pro = await ctx.prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: "PRO" } });
    await ctx.prisma.subscriptionPlan.update({
      where: { code: "PRO" },
      data: { limits: { ...(pro.limits as Record<string, number>), watchlists: 2 } },
    });
    const { agent } = await signUp(ctx, "lists@example.com");
    for (let i = 0; i < 2; i++) {
      expect((await agent.post("/api/v1/watchlists", { name: `List ${i}` })).statusCode).toBe(201);
    }
    const over = await agent.post("/api/v1/watchlists", { name: "One too many" });
    expect(over.statusCode).toBe(429); // USAGE_LIMIT_EXCEEDED (plan limit), as everywhere else
    expect(over.body).toContain("USAGE_LIMIT_EXCEEDED");
    expect(over.body).toMatch(/Your plan allows 2 watchlists./);
    expect(over.body.toLowerCase()).not.toContain("upgrade");
  });
});
