/**
 * Adapter over the shared EasyDev payment service (`payment-microservice`).
 * Trusted service-to-service calls: `x-api-key` plus the customer context
 * headers (`x-tenant-id`, `x-user-id`, `x-user-email`). The tenant is a
 * config constant of that service; DealMind itself has no tenancy.
 *
 * Responses are parsed defensively (some routes wrap in `{data}`, money may
 * arrive as a string). Nothing here grants access: callers re-read the
 * subscription and decide.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type BillingProvider,
  type CheckoutProof,
  type CheckoutStart,
  type CustomerRef,
  ProviderError,
  type ProviderInvoice,
  type ProviderPayment,
  type ProviderPlanSpec,
  type ProviderSubscription,
} from "../interface.js";

export interface EasyDevPaymentsOptions {
  baseUrl: string; // e.g. http://payment-service:3200/api/v1
  apiKey: string;
  tenantId: string;
  /** IAM application id DealMind's plans are registered under. */
  applicationId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const money = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < 0) {
    ctx.addIssue({ code: "custom", message: "invalid amount" });
    return z.NEVER;
  }
  return n;
});
const date = z.union([z.string(), z.date()]).transform((v) => new Date(v));
const STATUS = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED", "PAUSED"]));

const subscriptionRow = z.object({
  id: z.string(),
  planId: z.string(),
  applicationId: z.string().optional(),
  status: STATUS,
  currentPeriodStart: date,
  currentPeriodEnd: date,
  cancelAtPeriodEnd: z.boolean().optional().default(false),
  trialEnd: date.nullable().optional(),
  cancelledAt: date.nullable().optional(),
  createdAt: date,
});
const transactionRow = z.object({
  id: z.string(),
  amount: money,
  currency: z.string().default("INR"),
  status: z.string(),
  invoiceId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  attempts: z
    .array(
      z
        .object({ provider: z.string().optional(), method: z.string().nullable().optional() })
        .passthrough(),
    )
    .optional(),
  createdAt: date,
});
const invoiceRow = z.object({
  id: z.string(),
  invoiceNumber: z.string().nullable().optional(),
  subtotal: money,
  taxAmount: money,
  totalAmount: money,
  currency: z.string().default("INR"),
  status: z.string(),
  paidAt: date.nullable().optional(),
  createdAt: date,
  metadata: z.record(z.unknown()).nullable().optional(),
});
const planRow = z.object({
  id: z.string(),
  name: z.string(),
  amount: money,
  interval: z.string(),
  isActive: z.boolean().optional(),
  applicationId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

/** Unwraps response envelopes ({success, data, message, …}); a domain object is returned as is. */
const ENVELOPE_KEYS = new Set([
  "data",
  "success",
  "message",
  "meta",
  "total",
  "statusCode",
  "timestamp",
  "requestId",
]);
function unwrap(body: unknown): unknown {
  let b = body;
  while (
    b &&
    typeof b === "object" &&
    !Array.isArray(b) &&
    "data" in b &&
    Object.keys(b).every((k) => ENVELOPE_KEYS.has(k))
  )
    b = b.data;
  return b;
}
const listOf = (body: unknown): unknown[] => {
  const u = unwrap(body);
  if (Array.isArray(u)) return u;
  if (u && typeof u === "object" && Array.isArray((u as { data?: unknown }).data))
    return (u as { data: unknown[] }).data;
  return [];
};

export class EasyDevPaymentsProvider implements BillingProvider {
  readonly name = "easydev-payments";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: EasyDevPaymentsOptions) {
    if (!opts.apiKey) throw new Error("PAYMENT_SERVICE_API_KEY is required");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { customer?: CustomerRef; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "x-api-key": this.opts.apiKey,
      "x-tenant-id": this.opts.tenantId,
      accept: "application/json",
    };
    if (opts.customer) {
      headers["x-user-id"] = opts.customer.customerId;
      headers["x-user-email"] = opts.customer.email;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["x-idempotency-key"] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        // The API key is a custom header: never follow a redirect with it.
        redirect: "error",
      });
    } catch (err) {
      throw new ProviderError(`Payment service unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg =
        (body &&
        typeof body === "object" &&
        typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : null) ?? `HTTP ${res.status}`;
      throw new ProviderError(`Payment service: ${msg}`.slice(0, 300), res.status);
    }
    return body;
  }

  async ensurePlans(specs: ProviderPlanSpec[]): Promise<Record<string, string>> {
    const existing = listOf(
      await this.call(
        "GET",
        `/subscriptions/plans?applicationId=${encodeURIComponent(this.opts.applicationId)}`,
      ),
    ).flatMap((r) => {
      const p = planRow.safeParse(r);
      return p.success ? [p.data] : [];
    });
    const out: Record<string, string> = {};
    for (const s of specs) {
      const interval = s.interval === "MONTHLY" ? "MONTHLY" : "YEARLY";
      const match = existing.find(
        (p) =>
          p.isActive !== false &&
          p.metadata?.dealmindPlanKey === s.key &&
          p.amount === s.amountPaise &&
          p.interval.toUpperCase() === interval,
      );
      if (match) {
        out[s.key] = match.id;
        continue;
      }
      const created = planRow.parse(
        unwrap(
          await this.call("POST", "/subscriptions/plans", {
            body: {
              tenantId: this.opts.tenantId,
              applicationId: this.opts.applicationId,
              name: `DealMind ${s.name}`,
              description: s.description,
              amountRaw: s.amountPaise,
              currency: "INR",
              interval,
              intervalCount: 1,
              trialDays: 0,
              metadata: { dealmindPlanKey: s.key },
            },
          }),
        ),
      );
      out[s.key] = created.id;
    }
    return out;
  }

  async startCheckout(
    input: Parameters<BillingProvider["startCheckout"]>[0],
  ): Promise<CheckoutStart> {
    const body = unwrap(
      await this.call("POST", "/payments/initiate", {
        customer: input.customer,
        idempotencyKey: input.checkoutId,
        body: {
          orderId: `dealmind-${input.checkoutId}`,
          idempotencyKey: createHash("sha256").update(`dealmind:${input.checkoutId}`).digest("hex"),
          amount: input.amountPaise,
          currency: "INR",
          providers: ["RAZORPAY"],
          metadata: {
            billingMode: "subscription",
            recurringMode: true,
            planId: input.providerPlanId,
            productId: this.opts.applicationId,
            dealmindCheckoutId: input.checkoutId,
            dealmindPlan: input.planCode,
            interval: input.interval,
            customerId: input.customer.customerId,
            customerEmail: input.customer.email,
            source: "dealmind",
          },
        },
      }),
    ) as { transactionId?: unknown; options?: unknown };
    const option = (Array.isArray(body.options) ? body.options : []).find(
      (o: { provider?: unknown }) => o && o.provider === "RAZORPAY",
    ) as { orderId?: unknown; attemptId?: unknown; keyId?: unknown } | undefined;
    if (
      typeof body.transactionId !== "string" ||
      !option ||
      typeof option.orderId !== "string" ||
      typeof option.attemptId !== "string"
    )
      throw new ProviderError("Payment service did not return a Razorpay checkout");
    if (typeof option.keyId !== "string" || !option.keyId)
      throw new ProviderError("Payment service did not return the Razorpay key id for Checkout");
    return {
      transactionId: body.transactionId,
      attemptId: option.attemptId,
      orderId: option.orderId,
      keyId: option.keyId,
      kind: "RAZORPAY",
    };
  }

  async confirmCheckout(input: Parameters<BillingProvider["confirmCheckout"]>[0]) {
    const proof: CheckoutProof = input.proof;
    if (proof.kind !== "razorpay") return { verified: false, reason: "Unsupported proof" };
    try {
      const body = unwrap(
        await this.call("POST", `/payments/${encodeURIComponent(input.transactionId)}/verify`, {
          customer: input.customer,
          body: {
            attemptId: input.attemptId,
            providerPaymentId: proof.paymentId,
            providerSignature: proof.signature,
          },
        }),
      ) as { success?: unknown };
      return body.success === true
        ? { verified: true, reason: null }
        : { verified: false, reason: "The payment could not be verified" };
    } catch (err) {
      if (err instanceof ProviderError && err.status !== null && err.status < 500)
        return { verified: false, reason: err.message };
      throw err;
    }
  }

  async listSubscriptions(customer: CustomerRef): Promise<ProviderSubscription[]> {
    return listOf(await this.call("GET", "/subscriptions?page=1&limit=50", { customer }))
      .flatMap((r) => {
        const p = subscriptionRow.safeParse(r);
        return p.success &&
          (!p.data.applicationId || p.data.applicationId === this.opts.applicationId)
          ? [p.data]
          : [];
      })
      .map((s) => ({
        id: s.id,
        planId: s.planId,
        status: s.status,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        trialEnd: s.trialEnd ?? null,
        cancelledAt: s.cancelledAt ?? null,
        createdAt: s.createdAt,
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async cancel(customer: CustomerRef, subscriptionId: string, reason: string): Promise<void> {
    await this.call("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      customer,
      body: { reason: reason.slice(0, 200) || "customer_request", immediate: false },
    });
  }

  async changePlan(
    customer: CustomerRef,
    subscriptionId: string,
    providerPlanId: string,
  ): Promise<void> {
    await this.call("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}/plan`, {
      customer,
      body: { planId: providerPlanId },
    });
  }

  async listPayments(customer: CustomerRef): Promise<ProviderPayment[]> {
    return listOf(await this.call("GET", "/payments?page=1&limit=100", { customer })).flatMap(
      (r) => {
        const p = transactionRow.safeParse(r);
        if (!p.success) return [];
        const meta = p.data.metadata ?? {};
        const attempt = p.data.attempts?.find((a) => a.method) ?? p.data.attempts?.[0];
        return [
          {
            id: p.data.id,
            amountPaise: p.data.amount,
            currency: p.data.currency,
            status: p.data.status,
            method: attempt?.method ?? null,
            planId: typeof meta.planId === "string" ? meta.planId : null,
            invoiceId: p.data.invoiceId ?? null,
            createdAt: p.data.createdAt,
          },
        ];
      },
    );
  }

  async listInvoices(customer: CustomerRef): Promise<ProviderInvoice[]> {
    return listOf(
      await this.call("GET", "/billing/invoices?page=1&limit=100", { customer }),
    ).flatMap((r) => {
      const p = invoiceRow.safeParse(r);
      if (!p.success) return [];
      return [
        {
          id: p.data.id,
          invoiceNumber: p.data.invoiceNumber ?? null,
          amountPaise: p.data.subtotal,
          taxPaise: p.data.taxAmount,
          totalPaise: p.data.totalAmount,
          currency: p.data.currency,
          status: p.data.status,
          issuedAt: p.data.paidAt ?? p.data.createdAt,
          metadata: p.data.metadata ?? {},
        },
      ];
    });
  }
}
