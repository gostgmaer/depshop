/**
 * Subscriptions, checkout and billing history for the signed-in user.
 *
 * Money and access rules:
 *  - The amount is computed here from the plan; the client only names a plan.
 *  - A paid plan is granted only from the payment provider's verified state
 *    (SubscriptionSync reads it server-to-server). The browser's Razorpay
 *    callback is forwarded to the provider for signature verification; it is
 *    never proof by itself.
 *  - Webhooks are signature-verified, recorded once per event id, and only
 *    trigger a re-read of the provider's state.
 *  - Every record belongs to the authenticated user; another user's checkout
 *    is "not found".
 */
import type { EntitlementService, SubscriptionSync } from "@dealmind/billing";
import {
  type BillingProvider,
  type CustomerRef,
  type EasyDevWebhookEvent,
  type Plan,
  ProviderError,
  customerOf,
  easyDevWebhookEvent,
  planView,
  priceOf,
  verifyEasyDevSignature,
} from "@dealmind/billing";
import type { Prisma, PrismaClient } from "@dealmind/db";
import { buildNotification, recordNotification } from "@dealmind/notifications";
import {
  AppError,
  type BillingIntervalValue,
  type CheckoutView,
  ErrorCode,
  type InvoiceView,
  type PaymentView,
  type PlanCode,
  type PlanView,
  type SubscriptionView,
} from "@dealmind/shared";
import { recordAudit } from "../users/audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"] as const;
const isLive = (s: string) => (LIVE as readonly string[]).includes(s);

export interface BillingServiceOptions {
  /** How long a started checkout can be completed. */
  checkoutTtlMs?: number;
  /** IAM application id the shared payment service files DealMind under. */
  applicationId: string;
  webhookSecret: string | null;
  graceDays?: number;
  now?: () => Date;
  log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
}

type CheckoutRow = Prisma.CheckoutSessionGetPayload<object>;

export class BillingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly entitlements: EntitlementService,
    /** Null when no payment provider is configured: plans are shown but can't be bought. */
    private readonly provider: BillingProvider | null,
    private readonly sync: SubscriptionSync | null,
    private readonly opts: BillingServiceOptions,
  ) {}

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private requireProvider(): { provider: BillingProvider; sync: SubscriptionSync } {
    if (!this.provider || !this.sync)
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Payments aren't available yet.");
    return { provider: this.provider, sync: this.sync };
  }

  private async customer(userId: string): Promise<CustomerRef> {
    const c = await customerOf(this.prisma, userId);
    if (!c)
      throw new AppError(ErrorCode.CONFLICT, "Your account isn't linked to EasyDev billing yet.");
    return c;
  }

  // ── Plans and subscription ──────────────────────────────────────────────

  async plans(): Promise<PlanView[]> {
    const plans = [...(await this.entitlements.plans()).values()]
      .filter((p) => p.active)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return plans
      .map((p) => planView(p, false))
      .map((v) => (this.provider ? v : { ...v, purchasableIntervals: [] }));
  }

  async subscription(userId: string): Promise<SubscriptionView> {
    const [ctx, sub] = await Promise.all([
      this.entitlements.context(userId),
      this.prisma.subscription.findUnique({ where: { userId } }),
    ]);
    const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
    const paid = sub && sub.planCode !== "FREE";
    return {
      plan: planView(ctx.subscribed, false),
      effectivePlan: ctx.plan.code,
      status: sub?.status ?? "ACTIVE",
      interval: paid ? (sub.interval ?? null) : null,
      currentPeriodStart: paid ? iso(sub.currentPeriodStart) : null,
      currentPeriodEnd: paid ? iso(sub.currentPeriodEnd) : null,
      cancelAtPeriodEnd: paid ? sub.cancelAtPeriodEnd : false,
      trialEnd: paid ? iso(sub.trialEnd) : null,
      graceUntil: iso(ctx.effective.graceUntil),
      provider: paid ? sub.provider : null,
      lastSyncedAt: paid ? iso(sub.lastSyncedAt) : null,
    };
  }

  usage(userId: string) {
    return this.entitlements.getUsage(userId);
  }

  // ── Checkout ────────────────────────────────────────────────────────────

  private checkoutView(c: CheckoutRow): CheckoutView {
    return {
      id: c.id,
      status: c.status,
      plan: c.planCode as "PRO" | "BUSINESS",
      interval: c.interval,
      amountPaise: Number(c.amountPaise),
      currency: "INR",
      provider: c.provider === "sandbox" ? "SANDBOX" : "RAZORPAY",
      razorpay:
        c.provider !== "sandbox" && c.providerOrderId && c.status === "PENDING"
          ? { keyId: c.providerKeyId ?? "", subscriptionId: c.providerOrderId }
          : null,
      failureReason: c.failureReason,
      expiresAt: c.expiresAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
    };
  }

  async startCheckout(
    userId: string,
    input: { plan: "PRO" | "BUSINESS"; interval: BillingIntervalValue },
  ): Promise<CheckoutView> {
    const { provider } = this.requireProvider();
    const plans = await this.entitlements.plans();
    const plan = plans.get(input.plan);
    const amount = plan ? priceOf(plan, input.interval) : null;
    const providerPlanId = plan?.providerPlanIds[input.interval];
    if (!plan?.active || !amount || amount <= 0 || !providerPlanId)
      throw new AppError(ErrorCode.CONFLICT, "This plan can't be bought right now.");
    const customer = await this.customer(userId);
    const now = this.now();

    const { row, reused } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:checkout`}, 0))`;
      const sub = await tx.subscription.findUnique({ where: { userId } });
      if (sub && sub.planCode !== "FREE" && isLive(sub.status))
        throw new AppError(
          ErrorCode.CONFLICT,
          "You already have a subscription. Change your plan instead.",
        );
      // A payment verified in the last hour but not yet recorded: never start a second one.
      const verifying = await tx.checkoutSession.count({
        where: {
          userId,
          status: "VERIFYING",
          updatedAt: { gt: new Date(now.getTime() - 3_600_000) },
        },
      });
      if (verifying)
        throw new AppError(
          ErrorCode.CONFLICT,
          "Your last payment is still being confirmed. You'll be notified when your plan is active.",
        );
      const open = await tx.checkoutSession.findFirst({
        where: { userId, status: "PENDING", expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      });
      // A repeated click for the same plan resumes the same checkout.
      if (
        open &&
        open.planCode === input.plan &&
        open.interval === input.interval &&
        Number(open.amountPaise) === amount &&
        open.provider === provider.name &&
        open.providerOrderId !== null
      )
        return { row: open, reused: true };
      await tx.checkoutSession.updateMany({
        where: { userId, status: "PENDING" },
        data: { status: "CANCELLED", failureReason: "Replaced by a newer checkout" },
      });
      const created = await tx.checkoutSession.create({
        data: {
          userId,
          planCode: input.plan,
          interval: input.interval,
          amountPaise: BigInt(amount),
          provider: provider.name,
          expiresAt: new Date(now.getTime() + (this.opts.checkoutTtlMs ?? 30 * 60_000)),
        },
      });
      return { row: created, reused: false };
    });
    if (reused) return this.checkoutView(row);

    try {
      const start = await provider.startCheckout({
        customer,
        providerPlanId,
        amountPaise: amount,
        checkoutId: row.id,
        planCode: input.plan,
        interval: input.interval,
      });
      const updated = await this.prisma.checkoutSession.update({
        where: { id: row.id },
        data: {
          providerTransactionId: start.transactionId,
          providerAttemptId: start.attemptId,
          providerOrderId: start.orderId,
          providerKeyId: start.keyId,
        },
      });
      await recordAudit(this.prisma, {
        actorId: userId,
        action: "billing.checkout_started",
        entity: "CheckoutSession",
        entityId: row.id,
        metadata: {
          plan: input.plan,
          interval: input.interval,
          amountPaise: amount,
          provider: provider.name,
        },
      });
      return this.checkoutView(updated);
    } catch (err) {
      const reason = err instanceof ProviderError ? err.message : "Payment service error";
      await this.prisma.checkoutSession.update({
        where: { id: row.id },
        data: { status: "FAILED", failureReason: reason.slice(0, 300) },
      });
      this.opts.log?.error({ checkoutId: row.id, err: reason }, "checkout start failed");
      throw new AppError(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        "The payment couldn't be started. Please try again.",
      );
    }
  }

  private async ownedCheckout(userId: string, id: string): Promise<CheckoutRow> {
    const c = await this.prisma.checkoutSession.findFirst({ where: { id, userId } });
    if (!c) throw AppError.notFound("Checkout");
    return c;
  }

  async getCheckout(userId: string, id: string): Promise<CheckoutView> {
    let c = await this.ownedCheckout(userId, id);
    if (c.status === "PENDING" && c.expiresAt <= this.now())
      c = await this.prisma.checkoutSession.update({
        where: { id },
        data: { status: "EXPIRED", failureReason: "The checkout expired before payment" },
      });
    // Payment verified but the provider's subscription wasn't visible yet: look again.
    if (c.status === "VERIFYING" && this.sync) {
      await this.sync.syncUser(userId, { kind: "checkout", checkoutId: id }).catch(() => undefined);
      c = await this.ownedCheckout(userId, id);
    }
    return this.checkoutView(c);
  }

  /**
   * Forwards the payment proof for server-side verification, then reads the
   * provider's subscription. Only that state grants the plan.
   */
  async confirmCheckout(
    userId: string,
    id: string,
    body:
      | { razorpayPaymentId: string; razorpaySubscriptionId: string; razorpaySignature: string }
      | { sandboxOutcome: "success" | "failure" },
  ): Promise<CheckoutView> {
    const { provider, sync } = this.requireProvider();
    const c = await this.ownedCheckout(userId, id);
    if (c.status !== "PENDING") return this.getCheckout(userId, id);
    if (c.expiresAt <= this.now()) return this.getCheckout(userId, id);
    if (!c.providerTransactionId || !c.providerAttemptId || !c.providerOrderId)
      throw new AppError(ErrorCode.CONFLICT, "This checkout wasn't started; start a new one.");

    const proof =
      "sandboxOutcome" in body
        ? provider.name === "sandbox"
          ? ({ kind: "sandbox", outcome: body.sandboxOutcome } as const)
          : null
        : provider.name !== "sandbox" && body.razorpaySubscriptionId === c.providerOrderId
          ? ({
              kind: "razorpay",
              paymentId: body.razorpayPaymentId,
              subscriptionId: body.razorpaySubscriptionId,
              signature: body.razorpaySignature,
            } as const)
          : null;
    if (!proof)
      throw new AppError(ErrorCode.BAD_REQUEST, "This payment doesn't belong to this checkout.");

    // Only one confirmation runs per checkout.
    const claimed = await this.prisma.checkoutSession.updateMany({
      where: { id, userId, status: "PENDING" },
      data: { status: "VERIFYING" },
    });
    if (claimed.count === 0) return this.getCheckout(userId, id);

    const customer = await this.customer(userId);
    let verified: { verified: boolean; reason: string | null };
    try {
      verified = await provider.confirmCheckout({
        customer,
        transactionId: c.providerTransactionId,
        attemptId: c.providerAttemptId,
        proof,
      });
    } catch (err) {
      // Provider unreachable: let the user retry the confirmation.
      await this.prisma.checkoutSession.updateMany({
        where: { id, status: "VERIFYING" },
        data: { status: "PENDING" },
      });
      this.opts.log?.error(
        { checkoutId: id, err: (err as Error).message },
        "checkout verify failed",
      );
      throw new AppError(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        "We couldn't confirm the payment yet. Please try again in a moment.",
      );
    }
    if (!verified.verified) {
      await this.prisma.checkoutSession.updateMany({
        where: { id, status: "VERIFYING" },
        data: {
          status: "FAILED",
          failureReason: (verified.reason ?? "Payment not verified").slice(0, 300),
        },
      });
      await recordAudit(this.prisma, {
        actorId: userId,
        action: "billing.checkout_failed",
        entity: "CheckoutSession",
        entityId: id,
        metadata: { reason: verified.reason ?? "not verified" },
      });
      return this.getCheckout(userId, id);
    }
    // Verified by the provider: read its subscription (completes the checkout when it's there).
    await sync
      .syncUser(userId, { kind: "checkout", checkoutId: id })
      .catch((err: unknown) =>
        this.opts.log?.warn(
          { checkoutId: id, err: (err as Error).message },
          "post-payment sync failed",
        ),
      );
    return this.getCheckout(userId, id);
  }

  // ── Changes ─────────────────────────────────────────────────────────────

  private async livePaid(userId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub || sub.planCode === "FREE" || !isLive(sub.status) || !sub.providerSubscriptionId)
      return null;
    return sub as typeof sub & { providerSubscriptionId: string };
  }

  /** Cancels at the end of the paid period (access continues until then). */
  async cancel(userId: string, reason?: string): Promise<SubscriptionView> {
    const { provider, sync } = this.requireProvider();
    const sub = await this.livePaid(userId);
    if (!sub)
      throw new AppError(ErrorCode.CONFLICT, "You don't have a paid subscription to cancel.");
    if (sub.cancelAtPeriodEnd) return this.subscription(userId); // idempotent
    if (sub.provider !== provider.name)
      throw new AppError(ErrorCode.CONFLICT, "This subscription is managed elsewhere.");
    try {
      await provider.cancel(
        await this.customer(userId),
        sub.providerSubscriptionId,
        reason ?? "customer_request",
      );
    } catch (err) {
      throw this.providerFailure(err, "The subscription couldn't be cancelled. Please try again.");
    }
    await sync.syncUser(userId, { kind: "user", action: "cancel" });
    return this.subscription(userId);
  }

  async changePlan(
    userId: string,
    input: { plan: PlanCode; interval: BillingIntervalValue },
  ): Promise<SubscriptionView> {
    if (input.plan === "FREE") return this.cancel(userId, "downgrade_to_free");
    const { provider, sync } = this.requireProvider();
    const sub = await this.livePaid(userId);
    if (!sub)
      throw new AppError(
        ErrorCode.CONFLICT,
        "You don't have a paid subscription yet. Start a checkout instead.",
      );
    if (sub.status === "PAST_DUE")
      throw new AppError(ErrorCode.CONFLICT, "Settle the failed payment before changing plans.");
    if (sub.planCode === input.plan && sub.interval === input.interval)
      return this.subscription(userId);
    const plan: Plan | undefined = (await this.entitlements.plans()).get(input.plan);
    const providerPlanId = plan?.providerPlanIds[input.interval];
    if (!plan?.active || !providerPlanId)
      throw new AppError(ErrorCode.CONFLICT, "This plan can't be bought right now.");
    try {
      await provider.changePlan(
        await this.customer(userId),
        sub.providerSubscriptionId,
        providerPlanId,
      );
    } catch (err) {
      throw this.providerFailure(err, "The plan couldn't be changed. Please try again.");
    }
    await recordAudit(this.prisma, {
      actorId: userId,
      action: "billing.plan_change_requested",
      entity: "Subscription",
      entityId: sub.id,
      metadata: { from: `${sub.planCode}:${sub.interval}`, to: `${input.plan}:${input.interval}` },
    });
    await sync.syncUser(userId, { kind: "user", action: "change-plan" });
    return this.subscription(userId);
  }

  private providerFailure(err: unknown, message: string): AppError {
    if (
      err instanceof ProviderError &&
      err.status !== null &&
      err.status >= 400 &&
      err.status < 500
    )
      return new AppError(ErrorCode.CONFLICT, err.message.replace(/^Payment service: /, ""));
    return new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, message);
  }

  // ── History (read from the payment service, DealMind's only) ────────────

  private async dealmindPlanIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const p of (await this.entitlements.plans()).values())
      for (const id of Object.values(p.providerPlanIds)) if (id) ids.add(id);
    return ids;
  }

  async payments(userId: string): Promise<PaymentView[]> {
    const { provider } = this.requireProvider();
    const [ids, list] = await Promise.all([
      this.dealmindPlanIds(),
      provider.listPayments(await this.customer(userId)).catch((err: unknown) => {
        throw this.providerFailure(err, "Payment history is unavailable right now.");
      }),
    ]);
    const plans = await this.entitlements.plans();
    const nameOf = (planId: string | null) => {
      for (const p of plans.values())
        for (const [interval, id] of Object.entries(p.providerPlanIds))
          if (id === planId)
            return `DealMind ${p.name} (${interval === "MONTHLY" ? "monthly" : "annual"})`;
      return null;
    };
    return list
      .filter((p) => p.planId !== null && ids.has(p.planId))
      .map((p) => ({
        id: p.id,
        amountPaise: p.amountPaise,
        currency: p.currency,
        status: p.status,
        method: p.method,
        description: nameOf(p.planId),
        createdAt: p.createdAt.toISOString(),
      }));
  }

  async invoices(userId: string): Promise<InvoiceView[]> {
    const { provider } = this.requireProvider();
    const customer = await this.customer(userId);
    const [ids, payments, list] = await Promise.all([
      this.dealmindPlanIds(),
      provider.listPayments(customer),
      provider.listInvoices(customer),
    ]).catch((err: unknown) => {
      throw this.providerFailure(err, "Invoices are unavailable right now.");
    });
    const mine = new Set(
      payments.filter((p) => p.planId && ids.has(p.planId) && p.invoiceId).map((p) => p.invoiceId!),
    );
    return list
      .filter((i) => mine.has(i.id) || i.metadata.productId === this.opts.applicationId)
      .map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        amountPaise: i.amountPaise,
        taxPaise: i.taxPaise,
        totalPaise: i.totalPaise,
        currency: i.currency,
        status: i.status,
        issuedAt: i.issuedAt?.toISOString() ?? null,
      }));
  }

  // ── Webhook ─────────────────────────────────────────────────────────────

  /**
   * Verified, idempotent processing of the payment service's webhook.
   * Returns the HTTP status to answer (non-2xx makes the sender retry).
   */
  async handleWebhook(
    rawBody: string,
    signature: string | undefined,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.opts.webhookSecret || !this.sync)
      return { status: 503, body: { error: "Billing webhooks are not configured" } };
    const check = verifyEasyDevSignature(this.opts.webhookSecret, signature, rawBody, this.now());
    if (!check.ok) return { status: 401, body: { error: `Invalid signature (${check.reason})` } };
    let event: EasyDevWebhookEvent;
    try {
      event = easyDevWebhookEvent.parse(JSON.parse(rawBody));
    } catch {
      return { status: 400, body: { error: "Malformed event" } };
    }
    if (event.applicationId !== this.opts.applicationId)
      return { status: 202, body: { ignored: "other application" } };

    // IAM ids are UUIDs; anything else can't be a DealMind user (and must not reach the UUID column).
    const user = UUID_RE.test(event.data.customerId)
      ? await this.prisma.user.findUnique({
          where: { iamUserId: event.data.customerId },
          select: { id: true },
        })
      : null;
    const inserted = await this.prisma.billingEvent.createManyAndReturn({
      data: [
        {
          userId: user?.id ?? null,
          type: "WEBHOOK_RECEIVED",
          provider: "easydev-payments",
          providerEventId: event.id,
          eventType: event.type,
          payload: event as unknown as Prisma.InputJsonObject,
          occurredAt: new Date(
            Number.isNaN(Date.parse(event.createdAt)) ? this.now() : event.createdAt,
          ),
          processingStatus: user ? "RECEIVED" : "IGNORED",
          ...(user ? {} : { processedAt: this.now(), error: "Unknown customer" }),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    let eventRowId = inserted[0]?.id;
    if (!eventRowId) {
      const existing = await this.prisma.billingEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: { provider: "easydev-payments", providerEventId: event.id },
        },
      });
      // Already handled: acknowledge without re-processing.
      if (existing.processingStatus === "PROCESSED" || existing.processingStatus === "IGNORED")
        return { status: 200, body: { duplicate: true } };
      eventRowId = existing.id; // a previous attempt failed: process again
    }
    if (!user) return { status: 202, body: { ignored: "unknown customer" } };

    const claimed = await this.prisma.billingEvent.updateMany({
      where: { id: eventRowId, processingStatus: { in: ["RECEIVED", "FAILED"] } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { status: 200, body: { duplicate: true } };
    try {
      const r = await this.sync.syncUser(user.id, { kind: "webhook", billingEventId: eventRowId });
      if (event.type === "refund.updated") await this.refundNotice(user.id, eventRowId, r);
      await this.prisma.billingEvent.update({
        where: { id: eventRowId },
        data: {
          processingStatus: "PROCESSED",
          processedAt: this.now(),
          error: null,
          ...(r.status === "synced" ? { subscriptionId: r.subscriptionId } : {}),
        },
      });
      return { status: 200, body: { processed: true } };
    } catch (err) {
      await this.prisma.billingEvent.update({
        where: { id: eventRowId },
        data: { processingStatus: "FAILED", error: (err as Error).message.slice(0, 500) },
      });
      this.opts.log?.error(
        { eventId: event.id, err: (err as Error).message },
        "billing webhook failed",
      );
      return { status: 500, body: { error: "Processing failed; retry later" } };
    }
  }

  private async refundNotice(
    userId: string,
    billingEventId: string,
    r: Awaited<ReturnType<SubscriptionSync["syncUser"]>>,
  ) {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { id: true, planCode: true, currentPeriodEnd: true },
    });
    if (!sub) return;
    const plans = await this.entitlements.plans();
    await this.prisma.$transaction((tx) =>
      recordNotification(
        tx,
        buildNotification({
          kind: "billing.subscription",
          userId,
          change: "refund",
          subscriptionId: sub.id,
          sourceKey: billingEventId,
          planName: plans.get(sub.planCode)?.name ?? sub.planCode,
          periodEnd: r.status === "synced" ? (sub.currentPeriodEnd?.toISOString() ?? null) : null,
        }),
        { now: this.now() },
      ),
    );
  }

  /** Expires abandoned checkouts (worker/cron and tests). */
  async expireCheckouts(): Promise<number> {
    const r = await this.prisma.checkoutSession.updateMany({
      where: { status: "PENDING", expiresAt: { lte: this.now() } },
      data: { status: "EXPIRED", failureReason: "The checkout expired before payment" },
    });
    return r.count;
  }
}
