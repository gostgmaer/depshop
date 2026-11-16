/**
 * User-owned price alerts on shared catalog variants.
 *
 *  - Lifecycle: ACTIVE ⇄ PAUSED; ACTIVE → TRIGGERED (worker, one-shot alert
 *    met) → ACTIVE (resume = re-arm); ACTIVE/PAUSED/TRIGGERED → CANCELLED
 *    (user) or EXPIRED (worker, expiresAt passed). Every user action is
 *    validated against ALERT_ACTIONS (409 otherwise) and applied with a
 *    conditional update, so a concurrent worker transition can't be overwritten.
 *  - Evaluation runs in apps/worker after each global price check; alerts
 *    never cause marketplace requests.
 *  - Every query is scoped by the authenticated userId; another user's alert
 *    is "not found" (no IDOR, no existence leak).
 */
import type { Prisma } from "@dealmind/db";
import { type PrismaClient, isUniqueViolation } from "@dealmind/db";
import {
  ALERT_TYPE_PARAM,
  type AlertAction,
  type AlertStatusValue,
  AppError,
  type CreateAlertInput,
  ErrorCode,
  type PageQuery,
  type UpdateAlertInput,
  canTransition,
  paginationOf,
  paiseFromDb,
  paiseFromDbOrNull,
  ratioBp,
} from "@dealmind/shared";
import { iso, paginated } from "../../utils/http.js";
import { toVariantView } from "../catalog/catalog-service.js";
import type { PlanService } from "../subscriptions/plan-service.js";

const include = {
  source: { select: { id: true, slug: true, name: true, isSample: true } },
  variant: {
    select: {
      id: true,
      variantKey: true,
      attributes: true,
      sku: true,
      gtin: true,
      product: { select: { id: true, name: true, brand: true, imageUrl: true } },
    },
  },
} as const;

type AlertRow = Prisma.PriceAlertGetPayload<{ include: typeof include }>;

const DUPLICATE = "You already have this type of alert for this product and marketplace";
const FRESH_MS = 24 * 3_600_000;

interface CurrentPrice {
  deliveredPaise: bigint;
  marketplace: { slug: string; name: string };
  observedAt: Date;
}

export class AlertService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly plans: PlanService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Current lowest delivered price per (variant, source|any) of fresh,
   * available, ACTIVE-source offers. Never a made-up price: null when none.
   */
  private async currentPrices(
    keys: { variantId: string; sourceId: string | null }[],
  ): Promise<Map<string, CurrentPrice>> {
    const out = new Map<string, CurrentPrice>();
    if (!keys.length) return out;
    const offers = await this.prisma.productOffer.findMany({
      where: {
        variantId: { in: [...new Set(keys.map((k) => k.variantId))] },
        source: { status: "ACTIVE" },
        observedAt: { gte: new Date(this.now().getTime() - FRESH_MS) },
        stockStatus: { in: ["IN_STOCK", "LIMITED"] },
        trackingState: "ACTIVE",
      },
      select: {
        variantId: true,
        sourceId: true,
        sellingPricePaise: true,
        shippingPaise: true,
        observedAt: true,
        source: { select: { slug: true, name: true } },
      },
    });
    for (const k of keys) {
      let best: CurrentPrice | null = null;
      for (const o of offers) {
        if (o.variantId !== k.variantId || (k.sourceId && o.sourceId !== k.sourceId)) continue;
        const delivered = o.sellingPricePaise + (o.shippingPaise ?? 0n);
        if (!best || delivered < best.deliveredPaise)
          best = { deliveredPaise: delivered, marketplace: o.source, observedAt: o.observedAt };
      }
      if (best) out.set(`${k.variantId}:${k.sourceId ?? "*"}`, best);
    }
    return out;
  }

  private view(a: AlertRow, current: CurrentPrice | null) {
    const target = a.targetPricePaise;
    const start = a.baselinePricePaise;
    let progressBp: number | null = null;
    // Progress from the start price toward the target (target alerts only).
    if (target !== null && start !== null && current) {
      if (current.deliveredPaise <= target) progressBp = 10_000;
      else if (start <= target || current.deliveredPaise >= start) progressBp = 0;
      else progressBp = Math.min(10_000, ratioBp(start - current.deliveredPaise, start - target));
    }
    return {
      id: a.id,
      status: a.status,
      type: a.type,
      targetPricePaise: paiseFromDbOrNull(a.targetPricePaise),
      dropPercentBp: a.dropPercentBp,
      baselinePricePaise: paiseFromDbOrNull(a.baselinePricePaise),
      historicalWindowDays: a.historicalWindowDays,
      cooldownMinutes: a.cooldownMinutes,
      lastEvaluatedAt: iso(a.lastEvaluatedAt),
      minChangePaise: paiseFromDbOrNull(a.minChangePaise),
      repeat: a.repeat,
      expiresAt: iso(a.expiresAt),
      channels: a.channels.filter((c): c is "IN_APP" | "EMAIL" => c !== "PUSH"),
      triggerCount: a.triggerCount,
      cancelledAt: iso(a.cancelledAt),
      current: current
        ? {
            deliveredPaise: paiseFromDb(current.deliveredPaise),
            marketplace: current.marketplace,
            observedAt: current.observedAt.toISOString(),
          }
        : null,
      progressBp,
      source: a.source,
      variant: toVariantView(a.variant),
      product: a.variant.product,
      lastTriggeredAt: iso(a.lastTriggeredAt),
      lastTriggeredPricePaise: paiseFromDbOrNull(a.lastTriggeredPricePaise),
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  private async views(rows: AlertRow[]) {
    const prices = await this.currentPrices(
      rows.map((a) => ({ variantId: a.variantId, sourceId: a.sourceId })),
    );
    return rows.map((a) => this.view(a, prices.get(`${a.variantId}:${a.sourceId ?? "*"}`) ?? null));
  }

  private async owned(userId: string, id: string) {
    const a = await this.prisma.priceAlert.findFirst({ where: { id, userId }, include });
    if (!a) throw AppError.notFound("Alert");
    return a;
  }

  private assertAction(action: AlertAction, status: AlertStatusValue) {
    if (!canTransition(action, status))
      throw new AppError(
        ErrorCode.CONFLICT,
        `Can't ${action} an alert that is ${status.toLowerCase()}`,
        { status, action },
      );
  }

  private async assertSource(sourceId: string | null | undefined): Promise<void> {
    if (!sourceId) return;
    const src = await this.prisma.shoppingSource.findUnique({
      where: { id: sourceId },
      select: { status: true },
    });
    if (!src) throw AppError.notFound("Source");
    if (src.status !== "ACTIVE")
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Alerts can only target active sources");
  }

  async create(userId: string, input: CreateAlertInput) {
    await this.plans.assertWithinLimit(userId, "activeAlerts");
    if (!(await this.prisma.productVariant.count({ where: { id: input.variantId } }))) {
      throw AppError.notFound("Product variant");
    }
    await this.assertSource(input.sourceId);
    const param = ALERT_TYPE_PARAM[input.type];
    const sourceId = input.sourceId ?? null;
    // Start price: today's lowest delivered price (progress, % drop baseline). Null when none.
    const start =
      param === "target" || param === "drop"
        ? ((await this.currentPrices([{ variantId: input.variantId, sourceId }])).get(
            `${input.variantId}:${sourceId ?? "*"}`,
          )?.deliveredPaise ?? null)
        : null;
    try {
      const alert = await this.prisma.priceAlert.create({
        data: {
          userId,
          variantId: input.variantId,
          type: input.type,
          targetPricePaise:
            param === "target" && input.targetPricePaise !== undefined
              ? BigInt(input.targetPricePaise)
              : null,
          dropPercentBp: param === "drop" && input.dropPercent ? input.dropPercent * 100 : null,
          baselinePricePaise: start,
          historicalWindowDays: param === "window" ? (input.historicalWindowDays ?? 90) : null,
          minChangePaise:
            param === "minChange" && input.minChangePaise ? BigInt(input.minChangePaise) : null,
          ...(input.cooldownMinutes !== undefined
            ? { cooldownMinutes: input.cooldownMinutes }
            : {}),
          ...(input.channels ? { channels: [...new Set(input.channels)] } : {}),
          ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
          sourceId,
        },
        include,
      });
      await this.prisma.usageRecord.create({ data: { userId, metric: "ALERT_CREATED" } });
      return (await this.views([alert]))[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict(DUPLICATE);
      throw err;
    }
  }

  async list(
    userId: string,
    q: PageQuery & { status?: AlertStatusValue | undefined; variantId?: string | undefined },
  ) {
    const where = {
      userId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.variantId ? { variantId: q.variantId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.priceAlert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include,
      }),
      this.prisma.priceAlert.count({ where }),
    ]);
    return paginated(await this.views(rows), paginationOf(q, total));
  }

  async get(userId: string, id: string) {
    return (await this.views([await this.owned(userId, id)]))[0]!;
  }

  /** Conditional status change: only applies if the alert is still in the status we validated. */
  private async move(
    userId: string,
    alert: AlertRow,
    data: Prisma.PriceAlertUpdateManyMutationInput,
  ) {
    const res = await this.prisma.priceAlert.updateMany({
      where: { id: alert.id, userId, status: alert.status },
      data,
    });
    if (res.count === 0)
      throw new AppError(ErrorCode.CONFLICT, "The alert changed meanwhile; reload and try again");
    return this.get(userId, alert.id);
  }

  async update(userId: string, id: string, input: UpdateAlertInput) {
    const alert = await this.owned(userId, id);
    this.assertAction("update", alert.status);
    await this.assertSource(input.sourceId);
    const param = ALERT_TYPE_PARAM[alert.type];
    const misfit = (
      [
        ["targetPricePaise", "target"],
        ["dropPercent", "drop"],
        ["historicalWindowDays", "window"],
        ["minChangePaise", "minChange"],
      ] as const
    ).find(([field, p]) => input[field] !== undefined && p !== param);
    if (misfit)
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `${misfit[0]} doesn't apply to a ${alert.type} alert`,
      );
    const conditionChanged =
      input.targetPricePaise !== undefined ||
      input.dropPercent !== undefined ||
      input.historicalWindowDays !== undefined ||
      input.minChangePaise !== undefined ||
      input.sourceId !== undefined;
    try {
      return await this.move(userId, alert, {
        ...(input.targetPricePaise === undefined
          ? {}
          : { targetPricePaise: BigInt(input.targetPricePaise) }),
        ...(input.dropPercent === undefined ? {} : { dropPercentBp: input.dropPercent * 100 }),
        ...(input.historicalWindowDays === undefined
          ? {}
          : { historicalWindowDays: input.historicalWindowDays }),
        ...(input.minChangePaise === undefined
          ? {}
          : {
              minChangePaise: input.minChangePaise === null ? null : BigInt(input.minChangePaise),
            }),
        ...(input.cooldownMinutes === undefined ? {} : { cooldownMinutes: input.cooldownMinutes }),
        ...(input.channels === undefined ? {} : { channels: [...new Set(input.channels)] }),
        ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }),
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        // A changed condition starts fresh: evaluate it again and allow a new notification.
        ...(conditionChanged ? { lastEvaluatedAt: null, lastTriggeredPricePaise: null } : {}),
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict(DUPLICATE);
      throw err;
    }
  }

  async pause(userId: string, id: string) {
    const alert = await this.owned(userId, id);
    if (alert.status === "PAUSED") return this.get(userId, id); // idempotent
    this.assertAction("pause", alert.status);
    return this.move(userId, alert, { status: "PAUSED" });
  }

  /** Resume a paused alert or re-arm a triggered one (counts against the active-alert limit). */
  async resume(userId: string, id: string) {
    const alert = await this.owned(userId, id);
    if (alert.status === "ACTIVE") return this.get(userId, id); // idempotent
    this.assertAction("resume", alert.status);
    if (alert.expiresAt && alert.expiresAt <= this.now())
      throw new AppError(ErrorCode.CONFLICT, "This alert's end date has passed; extend it first", {
        status: alert.status,
        action: "resume",
      });
    await this.plans.assertWithinLimit(userId, "activeAlerts");
    return this.move(userId, alert, {
      status: "ACTIVE",
      // Re-armed: the next time the condition holds notifies again.
      ...(alert.status === "TRIGGERED"
        ? { lastTriggeredPricePaise: null, lastEvaluatedAt: null }
        : {}),
    });
  }

  /** Cancel keeps the alert and its history (delete removes both). */
  async cancel(userId: string, id: string) {
    const alert = await this.owned(userId, id);
    if (alert.status === "CANCELLED") return this.get(userId, id); // idempotent
    this.assertAction("cancel", alert.status);
    return this.move(userId, alert, { status: "CANCELLED", cancelledAt: this.now() });
  }

  /** The owner's evaluation history (newest first); outcome=TRIGGERED lists previous triggers. */
  async history(userId: string, id: string, q: PageQuery & { outcome?: string | undefined }) {
    await this.owned(userId, id);
    const where: Prisma.AlertEvaluationWhereInput = {
      alertId: id,
      userId,
      ...(q.outcome
        ? { outcome: q.outcome as Prisma.EnumAlertEvaluationOutcomeFilter["equals"] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.alertEvaluation.findMany({
        where,
        orderBy: { evaluatedAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { offer: { select: { source: { select: { slug: true, name: true } } } } },
      }),
      this.prisma.alertEvaluation.count({ where }),
    ]);
    return paginated(
      rows.map((e) => ({
        id: e.id,
        outcome: e.outcome,
        observedPricePaise: paiseFromDbOrNull(e.observedPricePaise),
        marketplace: e.offer.source,
        reason: e.reason,
        notificationId: e.notificationId,
        evaluatedAt: e.evaluatedAt.toISOString(),
      })),
      paginationOf(q, total),
    );
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.prisma.priceAlert.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw AppError.notFound("Alert");
  }
}
