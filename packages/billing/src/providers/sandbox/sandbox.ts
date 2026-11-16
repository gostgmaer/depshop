/**
 * SANDBOX provider: a test double of the shared payment service for tests
 * and local development. No money moves and nothing is sent to Razorpay.
 * The API refuses it in production, and every checkout it creates is
 * labelled SANDBOX in the UI.
 *
 * State is in memory (per process). Test hooks simulate what the real
 * service does on its own: renewals, failed renewals, expiry and refunds.
 */
import { randomUUID } from "node:crypto";
import type { SubscriptionStatusValue } from "@dealmind/shared";
import type {
  BillingProvider,
  CheckoutStart,
  CustomerRef,
  ProviderInvoice,
  ProviderPayment,
  ProviderPlanSpec,
  ProviderSubscription,
} from "../interface.js";
import { ProviderError } from "../interface.js";

interface Pending {
  customerId: string;
  planId: string;
  amountPaise: number;
  transactionId: string;
  attemptId: string;
  orderId: string;
  interval: "MONTHLY" | "ANNUAL";
}

const addInterval = (d: Date, interval: "MONTHLY" | "ANNUAL") => {
  const n = new Date(d);
  if (interval === "MONTHLY") n.setUTCMonth(n.getUTCMonth() + 1);
  else n.setUTCFullYear(n.getUTCFullYear() + 1);
  return n;
};

export class SandboxBillingProvider implements BillingProvider {
  readonly name = "sandbox";
  readonly plans = new Map<
    string,
    { key: string; amountPaise: number; interval: "MONTHLY" | "ANNUAL" }
  >();
  readonly pending = new Map<string, Pending>(); // by transactionId
  readonly subscriptions = new Map<
    string,
    ProviderSubscription & { customerId: string; interval: "MONTHLY" | "ANNUAL" }
  >();
  readonly payments: (ProviderPayment & { customerId: string })[] = [];
  readonly invoices: (ProviderInvoice & { customerId: string })[] = [];
  /** Set to make the next call throw (simulates an outage). */
  failNext: string | null = null;
  now: () => Date = () => new Date();

  private guard() {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new ProviderError(m, 503);
    }
  }

  async ensurePlans(specs: ProviderPlanSpec[]) {
    const out: Record<string, string> = {};
    for (const s of specs) {
      const existing = [...this.plans.entries()].find(
        ([, p]) => p.key === s.key && p.amountPaise === s.amountPaise,
      );
      const id =
        existing?.[0] ?? `sbx_plan_${s.key.toLowerCase().replace(":", "_")}_${s.amountPaise}`;
      this.plans.set(id, { key: s.key, amountPaise: s.amountPaise, interval: s.interval });
      out[s.key] = id;
    }
    return out;
  }

  async startCheckout(
    input: Parameters<BillingProvider["startCheckout"]>[0],
  ): Promise<CheckoutStart> {
    this.guard();
    const plan = this.plans.get(input.providerPlanId);
    if (!plan) throw new ProviderError("Unknown plan", 400);
    if (plan.amountPaise !== input.amountPaise)
      throw new ProviderError("Amount does not match the plan", 400);
    const p: Pending = {
      customerId: input.customer.customerId,
      planId: input.providerPlanId,
      amountPaise: input.amountPaise,
      transactionId: `sbx_txn_${randomUUID()}`,
      attemptId: `sbx_att_${randomUUID()}`,
      orderId: `sbx_sub_${randomUUID()}`,
      interval: plan.interval,
    };
    this.pending.set(p.transactionId, p);
    return {
      transactionId: p.transactionId,
      attemptId: p.attemptId,
      orderId: p.orderId,
      keyId: null,
      kind: "SANDBOX",
    };
  }

  async confirmCheckout(input: Parameters<BillingProvider["confirmCheckout"]>[0]) {
    this.guard();
    const p = this.pending.get(input.transactionId);
    if (!p || p.attemptId !== input.attemptId || p.customerId !== input.customer.customerId)
      return { verified: false, reason: "Unknown payment" };
    if (input.proof.kind !== "sandbox") return { verified: false, reason: "Not a sandbox payment" };
    if (input.proof.outcome === "failure") {
      this.payments.push(this.payment(p, "FAILED"));
      return { verified: false, reason: "Sandbox payment declined" };
    }
    // Like the real service: the subscription exists only after a verified payment.
    if (![...this.subscriptions.values()].some((s) => s.id === p.orderId)) {
      const start = this.now();
      this.subscriptions.set(p.orderId, {
        id: p.orderId,
        customerId: p.customerId,
        planId: p.planId,
        status: "ACTIVE",
        currentPeriodStart: start,
        currentPeriodEnd: addInterval(start, p.interval),
        cancelAtPeriodEnd: false,
        trialEnd: null,
        cancelledAt: null,
        createdAt: start,
        interval: p.interval,
      });
      this.charge(p.orderId, "SUCCESS");
    }
    this.pending.delete(p.transactionId);
    return { verified: true, reason: null };
  }

  private payment(
    p: { customerId: string; planId: string; amountPaise: number },
    status: string,
    invoiceId: string | null = null,
  ) {
    return {
      id: `sbx_pay_${randomUUID()}`,
      customerId: p.customerId,
      amountPaise: p.amountPaise,
      currency: "INR",
      status,
      method: "sandbox",
      planId: p.planId,
      invoiceId,
      createdAt: this.now(),
    };
  }

  private charge(subscriptionId: string, status: "SUCCESS" | "FAILED") {
    const s = this.subscriptions.get(subscriptionId)!;
    const plan = this.plans.get(s.planId)!;
    let invoiceId: string | null = null;
    if (status === "SUCCESS") {
      invoiceId = `sbx_inv_${randomUUID()}`;
      const tax = Math.round((plan.amountPaise * 18) / 118);
      this.invoices.push({
        id: invoiceId,
        customerId: s.customerId,
        invoiceNumber: `SBX-${this.invoices.length + 1}`,
        amountPaise: plan.amountPaise - tax,
        taxPaise: tax,
        totalPaise: plan.amountPaise,
        currency: "INR",
        status: "PAID",
        issuedAt: this.now(),
        metadata: {},
      });
    }
    this.payments.push(
      this.payment(
        { customerId: s.customerId, planId: s.planId, amountPaise: plan.amountPaise },
        status,
        invoiceId,
      ),
    );
  }

  async listSubscriptions(customer: CustomerRef): Promise<ProviderSubscription[]> {
    this.guard();
    return [...this.subscriptions.values()]
      .filter((s) => s.customerId === customer.customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => ({ ...s }));
  }

  async cancel(customer: CustomerRef, subscriptionId: string): Promise<void> {
    this.guard();
    const s = this.subscriptions.get(subscriptionId);
    if (!s || s.customerId !== customer.customerId)
      throw new ProviderError("Subscription not found", 404);
    if (s.status === "CANCELLED" || s.status === "EXPIRED")
      throw new ProviderError("Already ended", 400);
    s.cancelAtPeriodEnd = true;
  }

  async changePlan(
    customer: CustomerRef,
    subscriptionId: string,
    providerPlanId: string,
  ): Promise<void> {
    this.guard();
    const s = this.subscriptions.get(subscriptionId);
    if (!s || s.customerId !== customer.customerId)
      throw new ProviderError("Subscription not found", 404);
    const plan = this.plans.get(providerPlanId);
    if (!plan) throw new ProviderError("Unknown plan", 400);
    s.planId = providerPlanId;
    s.interval = plan.interval;
    s.cancelAtPeriodEnd = false;
  }

  async listPayments(customer: CustomerRef) {
    this.guard();
    return this.payments.filter((p) => p.customerId === customer.customerId).reverse();
  }

  async listInvoices(customer: CustomerRef) {
    this.guard();
    return this.invoices.filter((i) => i.customerId === customer.customerId).reverse();
  }

  // ── Test hooks: what the real payment service does on its own ──

  /** Period end reached: renew (charge) or fail (PAST_DUE), or finalize a scheduled cancel. */
  renew(subscriptionId: string, outcome: "success" | "failure") {
    const s = this.subscriptions.get(subscriptionId)!;
    if (s.cancelAtPeriodEnd) {
      s.status = "CANCELLED";
      s.cancelledAt = this.now();
      return;
    }
    if (outcome === "success") {
      s.currentPeriodStart = s.currentPeriodEnd;
      s.currentPeriodEnd = addInterval(s.currentPeriodEnd, s.interval);
      s.status = "ACTIVE";
      this.charge(subscriptionId, "SUCCESS");
    } else {
      s.status = "PAST_DUE";
      this.charge(subscriptionId, "FAILED");
    }
  }

  setStatus(subscriptionId: string, status: SubscriptionStatusValue) {
    this.subscriptions.get(subscriptionId)!.status = status;
  }

  refundLatest(customerId: string) {
    const p = this.payments
      .filter((x) => x.customerId === customerId && x.status === "SUCCESS")
      .at(-1);
    if (p) p.status = "REFUNDED";
    return p?.id ?? null;
  }
}
