import { describe, expect, it, vi } from "vitest";
import {
  EasyDevPaymentsProvider,
  ProviderError,
  effectivePlan,
  pickCurrent,
  planFromRow,
  planView,
  signEasyDevPayload,
  verifyEasyDevSignature,
  windowEnd,
  windowStart,
} from "./index.js";

const DAY = 86_400_000;

describe("plan catalogue", () => {
  it("falls back per key to the defaults when a stored value is missing or invalid", () => {
    const p = planFromRow({
      code: "PRO",
      name: "Pro",
      description: "",
      monthlyPricePaise: 19_900n,
      annualPricePaise: 199_000n,
      limits: { searchesPerDay: 300, activeAlerts: -1, watchlists: "x" },
      features: { exports: false },
      sortOrder: 1,
      providerPlanIds: { MONTHLY: "plan-m", ANNUAL: 5 },
      active: true,
    });
    expect(p.limits.searchesPerDay).toBe(300);
    expect(p.limits.activeAlerts).toBe(100); // invalid → default
    expect(p.limits.trackedProducts).toBe(500); // missing → default
    expect(p.features).toEqual({ prioritySearch: true, exports: false });
    expect(p.providerPlanIds).toEqual({ MONTHLY: "plan-m" });
    expect(planView(p, false).purchasableIntervals).toEqual(["MONTHLY"]);
    expect(planView(p, true).purchasableIntervals).toEqual(["MONTHLY", "ANNUAL"]);
  });
});

describe("entitlement policy", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  const sub = (status: string, endOffsetDays: number, pastDueSinceOffset?: number) => ({
    planCode: "PRO" as const,
    status: status as never,
    currentPeriodEnd: new Date(now.getTime() + endOffsetDays * DAY),
    pastDueSince:
      pastDueSinceOffset === undefined ? null : new Date(now.getTime() + pastDueSinceOffset * DAY),
  });

  it("grants the paid plan only in good standing or within the grace period", () => {
    expect(effectivePlan(null, now).plan).toBe("FREE");
    expect(effectivePlan(sub("ACTIVE", 10), now).plan).toBe("PRO");
    expect(effectivePlan(sub("TRIALING", 3), now).plan).toBe("PRO");
    const grace = effectivePlan(sub("PAST_DUE", -1, -1), now);
    expect(grace).toMatchObject({ plan: "PRO", graceUntil: new Date(now.getTime() + 2 * DAY) });
    expect(effectivePlan(sub("PAST_DUE", -4, -4), now).plan).toBe("FREE");
    for (const s of ["CANCELLED", "EXPIRED", "PAUSED"])
      expect(effectivePlan(sub(s, 10), now).plan).toBe("FREE");
  });

  it("falls back to FREE when an ACTIVE period ended long ago without a sync", () => {
    expect(effectivePlan(sub("ACTIVE", -1), now)).toMatchObject({ plan: "PRO" });
    expect(effectivePlan(sub("ACTIVE", -4), now).plan).toBe("FREE");
  });

  it("prefers a live provider subscription over newer ended ones", () => {
    const s = (id: string, status: string) => ({ id, status }) as never;
    expect(pickCurrent([s("new", "CANCELLED"), s("old", "ACTIVE")])).toMatchObject({ id: "old" });
    expect(pickCurrent([s("new", "EXPIRED"), s("old", "CANCELLED")])).toMatchObject({ id: "new" });
    expect(pickCurrent([])).toBeNull();
  });
});

describe("usage windows (IST)", () => {
  it("starts days and months at IST midnight", () => {
    // 2026-11-16 23:00 IST = 17:30Z
    const t = new Date("2026-11-16T17:30:00Z");
    expect(windowStart("day", t).toISOString()).toBe("2026-11-15T18:30:00.000Z");
    expect(windowEnd("day", t).toISOString()).toBe("2026-11-16T18:30:00.000Z");
    // 2026-11-17 00:30 IST = 19:00Z on the 16th: next day.
    expect(windowStart("day", new Date("2026-11-16T19:00:00Z")).toISOString()).toBe(
      "2026-11-16T18:30:00.000Z",
    );
    expect(windowStart("month", t).toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(windowEnd("month", t).toISOString()).toBe("2026-11-30T18:30:00.000Z");
  });
});

describe("webhook signature", () => {
  const secret = "w".repeat(40);
  const body = '{"id":"evt-1"}';
  const now = new Date("2026-11-16T10:00:00Z");
  const t = Math.floor(now.getTime() / 1000);

  it("accepts a valid signature and rejects tampering, other secrets, old timestamps and garbage", () => {
    const sig = signEasyDevPayload(secret, t, body);
    expect(verifyEasyDevSignature(secret, sig, body, now)).toEqual({ ok: true });
    expect(verifyEasyDevSignature(secret, sig, body.replace("1", "2"), now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyEasyDevSignature("x".repeat(40), sig, body, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(
      verifyEasyDevSignature(secret, signEasyDevPayload(secret, t - 301, body), body, now),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyEasyDevSignature(secret, undefined, body, now)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(verifyEasyDevSignature(secret, "t=1,v1=zz", body, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("EasyDev payment service adapter", () => {
  const customer = { customerId: "iam-1", email: "a@example.com" };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const make = (handler: (url: string, init: RequestInit) => Response) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      handler(url, init!),
    );
    const p = new EasyDevPaymentsProvider({
      baseUrl: "http://pay.local/api/v1/",
      apiKey: "svc-key",
      tenantId: "easydev",
      applicationId: "dealmind",
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { p, fetchMock };
  };

  it("initiates a recurring Razorpay checkout with the service key and customer headers", async () => {
    const { p, fetchMock } = make(() =>
      json(201, {
        success: true,
        data: {
          transactionId: "txn-1",
          status: "PENDING",
          options: [
            {
              provider: "RAZORPAY",
              method: "subscription",
              orderId: "sub_rzp1",
              attemptId: "att-1",
              keyId: "rzp_test_abc",
            },
          ],
        },
      }),
    );
    const r = await p.startCheckout({
      customer,
      providerPlanId: "plan-pro-m",
      amountPaise: 19_900,
      checkoutId: "c0000000-0000-7000-8000-000000000001",
      planCode: "PRO",
      interval: "MONTHLY",
    });
    expect(r).toEqual({
      transactionId: "txn-1",
      attemptId: "att-1",
      orderId: "sub_rzp1",
      keyId: "rzp_test_abc",
      kind: "RAZORPAY",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://pay.local/api/v1/payments/initiate");
    const h = init!.headers as Record<string, string>;
    expect(h).toMatchObject({
      "x-api-key": "svc-key",
      "x-tenant-id": "easydev",
      "x-user-id": "iam-1",
    });
    const body = JSON.parse(init!.body as string) as unknown;
    expect(body).toMatchObject({
      amount: 19_900,
      currency: "INR",
      providers: ["RAZORPAY"],
      metadata: {
        billingMode: "subscription",
        recurringMode: true,
        planId: "plan-pro-m",
        productId: "dealmind",
      },
    });
  });

  it("refuses a checkout without a Razorpay order or key id", async () => {
    const { p } = make(() => json(201, { transactionId: "t", options: [] }));
    await expect(
      p.startCheckout({
        customer,
        providerPlanId: "x",
        amountPaise: 1,
        checkoutId: "c",
        planCode: "PRO",
        interval: "MONTHLY",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("verifies through the service: 4xx = not verified, 5xx = error", async () => {
    let status = 200;
    const { p, fetchMock } = make(() =>
      status === 200
        ? json(200, { success: true, transactionId: "t" })
        : json(status, { message: "Signature verification failed" }),
    );
    const proof = {
      kind: "razorpay" as const,
      paymentId: "pay_1",
      subscriptionId: "sub_1",
      signature: "sig",
    };
    expect(
      await p.confirmCheckout({ customer, transactionId: "t", attemptId: "a", proof }),
    ).toEqual({ verified: true, reason: null });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      attemptId: "a",
      providerPaymentId: "pay_1",
      providerSignature: "sig",
    });
    status = 400;
    expect(
      (await p.confirmCheckout({ customer, transactionId: "t", attemptId: "a", proof })).verified,
    ).toBe(false);
    status = 502;
    await expect(
      p.confirmCheckout({ customer, transactionId: "t", attemptId: "a", proof }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("lists only DealMind subscriptions, parses money given as strings", async () => {
    const { p } = make((url) =>
      url.includes("/subscriptions")
        ? json(200, {
            data: [
              {
                id: "s-other",
                planId: "x",
                applicationId: "other-app",
                status: "ACTIVE",
                currentPeriodStart: "2026-11-01T00:00:00Z",
                currentPeriodEnd: "2026-12-01T00:00:00Z",
                createdAt: "2026-11-01T00:00:00Z",
              },
              {
                id: "s-dm",
                planId: "plan-pro-m",
                applicationId: "dealmind",
                status: "PAST_DUE",
                currentPeriodStart: "2026-10-01T00:00:00Z",
                currentPeriodEnd: "2026-11-01T00:00:00Z",
                cancelAtPeriodEnd: false,
                createdAt: "2026-10-01T00:00:00Z",
              },
            ],
            total: 2,
          })
        : json(200, {
            data: [
              {
                id: "txn",
                amount: "19900",
                currency: "INR",
                status: "SUCCESS",
                metadata: { planId: "plan-pro-m" },
                attempts: [{ method: "upi" }],
                createdAt: "2026-11-01T00:00:00Z",
              },
            ],
            total: 1,
          }),
    );
    const subs = await p.listSubscriptions(customer);
    expect(subs.map((s) => [s.id, s.status])).toEqual([["s-dm", "PAST_DUE"]]);
    const pays = await p.listPayments(customer);
    expect(pays[0]).toMatchObject({ amountPaise: 19_900, method: "upi", planId: "plan-pro-m" });
  });
});
