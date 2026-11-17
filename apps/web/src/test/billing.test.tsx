/** Phase 6.1 UI: plans, checkout (sandbox and Razorpay), cancellation, grace period, usage. */
import { checkoutView, planView, subscriptionView, usageView } from "@dealmind/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingView } from "@/app/(dashboard)/billing/billing-view";
import { annualSavingPercent } from "@/lib/billing";
import * as services from "@/services";
import type { Checkout, Plan, Subscription, Usage } from "@/types/api";
import { renderWithQuery } from "./render";

const limits = (n: number) => ({
  searchesPerDay: 20 * n,
  activeAlerts: 5 * n,
  watchlists: 2 * n,
  trackedProducts: 25 * n,
  historyDays: n === 1 ? 90 : 365,
  compareItems: n === 1 ? 2 : 4,
  exportsPerMonth: n === 1 ? 0 : 10,
});
const PLANS: Plan[] = [
  {
    code: "FREE",
    name: "Free",
    description: "Basics",
    monthlyPricePaise: 0,
    annualPricePaise: null,
    limits: limits(1),
    features: { prioritySearch: false, exports: false },
    purchasableIntervals: [],
  },
  {
    code: "PRO",
    name: "Pro",
    description: "More",
    monthlyPricePaise: 19_900,
    annualPricePaise: 199_000,
    limits: limits(10),
    features: { prioritySearch: true, exports: true },
    purchasableIntervals: ["MONTHLY", "ANNUAL"],
  },
  {
    code: "BUSINESS",
    name: "Business",
    description: "Most",
    monthlyPricePaise: 99_900,
    annualPricePaise: 999_000,
    limits: limits(100),
    features: { prioritySearch: true, exports: true },
    purchasableIntervals: ["MONTHLY", "ANNUAL"],
  },
];
const freeSub = (): Subscription => ({
  plan: PLANS[0]!,
  effectivePlan: "FREE",
  status: "ACTIVE",
  interval: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  trialEnd: null,
  graceUntil: null,
  provider: null,
  lastSyncedAt: null,
});
const proSub = (over: Partial<Subscription> = {}): Subscription => ({
  ...freeSub(),
  plan: PLANS[1]!,
  effectivePlan: "PRO",
  interval: "MONTHLY",
  currentPeriodStart: "2026-11-16T00:00:00.000Z",
  currentPeriodEnd: "2026-12-16T00:00:00.000Z",
  provider: "sandbox",
  lastSyncedAt: "2026-11-16T00:00:00.000Z",
  ...over,
});
const USAGE: Usage = {
  plan: "FREE",
  items: [
    {
      key: "searches",
      label: "AI searches today",
      used: 3,
      limit: 20,
      resetsAt: "2026-11-17T18:30:00.000Z",
    },
    { key: "activeAlerts", label: "Active price alerts", used: 1, limit: 5, resetsAt: null },
    {
      key: "exports",
      label: "Exports this month",
      used: 0,
      limit: 0,
      resetsAt: "2026-11-30T18:30:00.000Z",
    },
  ],
  historyDays: 90,
  compareItems: 2,
};
const checkout = (over: Partial<Checkout> = {}): Checkout => ({
  id: "c0000000-0000-7000-8000-000000000001",
  status: "PENDING",
  plan: "PRO",
  interval: "MONTHLY",
  amountPaise: 19_900,
  currency: "INR",
  provider: "SANDBOX",
  razorpay: null,
  failureReason: null,
  expiresAt: "2026-11-16T01:00:00.000Z",
  createdAt: "2026-11-16T00:30:00.000Z",
  ...over,
});

vi.mock("@/services", () => ({
  billing: {
    plans: vi.fn(),
    subscription: vi.fn(),
    usage: vi.fn(),
    startCheckout: vi.fn(),
    checkout: vi.fn(),
    confirmCheckout: vi.fn(),
    cancel: vi.fn(),
    changePlan: vi.fn(),
    payments: vi.fn(async () => []),
    invoices: vi.fn(async () => []),
    exportUrl: (k: string) => `/api/v1/exports/${k}.csv`,
  },
}));
type Mocked = Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const svc = (services as unknown as Mocked).billing!;

beforeEach(() => {
  svc.plans!.mockResolvedValue(PLANS);
  svc.subscription!.mockResolvedValue(freeSub());
  svc.usage!.mockResolvedValue(USAGE);
});
afterEach(() => {
  delete (window as unknown as { Razorpay?: unknown }).Razorpay;
});

describe("fixtures", () => {
  it("match the API contracts", () => {
    for (const p of PLANS) expect(planView.safeParse(p).success).toBe(true);
    expect(subscriptionView.safeParse(proSub()).success).toBe(true);
    expect(usageView.safeParse(USAGE).success).toBe(true);
    expect(checkoutView.safeParse(checkout()).success).toBe(true);
  });
});

describe("plans and usage", () => {
  it("shows server prices, annual savings and usage meters", async () => {
    const user = userEvent.setup();
    renderWithQuery(<BillingView />);
    const pro = await screen.findByRole("listitem", { name: "Pro plan" });
    expect(within(pro).getByText("₹199")).toBeInTheDocument();
    expect(within(pro).getByText("200 AI searches a day")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Annual/ }));
    expect(within(pro).getByText("₹1,990")).toBeInTheDocument();
    expect(within(pro).getByText("Save 16%")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "AI searches today" })).toHaveAttribute(
      "aria-valuenow",
      "3",
    );
    expect(screen.getByText("Not included")).toBeInTheDocument(); // exports on FREE
    expect(annualSavingPercent(19_900, 199_000)).toBe(16);
    expect(annualSavingPercent(19_900, 300_000)).toBeNull();
  });
});

describe("checkout", () => {
  it("sandbox: labelled test mode; the plan shows active only when the server confirms", async () => {
    svc.startCheckout!.mockResolvedValue(checkout());
    svc.confirmCheckout!.mockResolvedValue(checkout({ status: "SUCCEEDED" }));
    const user = userEvent.setup();
    renderWithQuery(<BillingView />);
    await user.click(await screen.findByRole("button", { name: "Upgrade to Pro" }));
    const dialog = await screen.findByRole("dialog", { name: "Upgrade to Pro" });
    expect(
      await within(dialog).findByText(/Sandbox checkout: test mode, no real money moves/),
    ).toBeInTheDocument();
    expect(svc.startCheckout).toHaveBeenCalledWith({ plan: "PRO", interval: "MONTHLY" });
    expect(within(dialog).queryByText(/is active/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Simulate a successful payment" }));
    expect(svc.confirmCheckout).toHaveBeenCalledWith(checkout().id, { sandboxOutcome: "success" });
    expect(
      await within(dialog).findByText(/Payment confirmed. Your Pro plan is active./),
    ).toBeInTheDocument();
  });

  it("Razorpay: forwards the payment proof for verification and recovers from a failure", async () => {
    svc.startCheckout!.mockResolvedValue(
      checkout({
        provider: "RAZORPAY",
        razorpay: { keyId: "rzp_test_key", subscriptionId: "sub_123" },
      }),
    );
    svc.confirmCheckout!.mockResolvedValue(
      checkout({ status: "FAILED", failureReason: "Signature verification failed" }),
    );
    let opts: Record<string, unknown> = {};
    const open = vi.fn();
    (window as unknown as { Razorpay: unknown }).Razorpay = class {
      constructor(o: Record<string, unknown>) {
        opts = o;
      }
      open = open;
      on() {}
    };
    const user = userEvent.setup();
    renderWithQuery(<BillingView />);
    await user.click(await screen.findByRole("button", { name: "Upgrade to Pro" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Pay with Razorpay" }));
    expect(open).toHaveBeenCalled();
    expect(opts).toMatchObject({ key: "rzp_test_key", subscription_id: "sub_123" });
    (opts.handler as (r: unknown) => void)({
      razorpay_payment_id: "pay_1",
      razorpay_subscription_id: "sub_123",
      razorpay_signature: "sig",
    });
    await waitFor(() =>
      expect(svc.confirmCheckout).toHaveBeenCalledWith(checkout().id, {
        razorpayPaymentId: "pay_1",
        razorpaySubscriptionId: "sub_123",
        razorpaySignature: "sig",
      }),
    );
    expect(await within(dialog).findByText("Signature verification failed")).toBeInTheDocument();
    expect(within(dialog).queryByText(/is active/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("paid subscription", () => {
  it("cancels only after confirming, and shows the renewal date", async () => {
    svc.subscription!.mockResolvedValue(proSub());
    svc.cancel!.mockResolvedValue(proSub({ cancelAtPeriodEnd: true }));
    const user = userEvent.setup();
    renderWithQuery(<BillingView />);
    expect(await screen.findByText(/Renews on/)).toBeInTheDocument();
    expect(screen.getByText(/Sandbox \(test mode\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));
    expect(svc.cancel).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));
    await waitFor(() => expect(svc.cancel).toHaveBeenCalled());
  });

  it("explains a failed payment's grace period and blocks plan switches until settled", async () => {
    svc.subscription!.mockResolvedValue(
      proSub({ status: "PAST_DUE", graceUntil: "2026-11-19T00:00:00.000Z" }),
    );
    renderWithQuery(<BillingView />);
    expect(await screen.findByText(/Your last payment failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Business" })).toBeDisabled();
  });

  it("warns when paid features are paused (lapsed)", async () => {
    svc.subscription!.mockResolvedValue(
      proSub({ status: "PAST_DUE", effectivePlan: "FREE", graceUntil: null }),
    );
    renderWithQuery(<BillingView />);
    expect(await screen.findByText(/Your Pro features are paused/)).toBeInTheDocument();
  });
});
