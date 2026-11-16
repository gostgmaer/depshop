/**
 * User-owned price alerts on shared catalog variants. Evaluation against new
 * prices runs in apps/worker after each global price check (Phase 5.1); this
 * service manages alert lifecycle and the owner's evaluation history. All
 * queries are scoped by the authenticated userId.
 */
import { type Prisma, type PrismaClient, isUniqueViolation } from "@dealmind/db";
import {
  ALERT_TYPE_PARAM,
  AppError,
  type CreateAlertInput,
  ErrorCode,
  type PageQuery,
  type UpdateAlertInput,
  paginationOf,
  paiseFromDbOrNull,
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

type AlertRow = {
  id: string;
  status: "ACTIVE" | "TRIGGERED" | "PAUSED";
  type: CreateAlertInput["type"];
  targetPricePaise: bigint | null;
  dropPercentBp: number | null;
  baselinePricePaise: bigint | null;
  historicalWindowDays: number | null;
  cooldownMinutes: number;
  lastEvaluatedAt: Date | null;
  lastTriggeredAt: Date | null;
  lastTriggeredPricePaise: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  source: { id: string; slug: string; name: string; isSample: boolean } | null;
  variant: {
    id: string;
    variantKey: string;
    attributes: Prisma.JsonValue;
    sku: string | null;
    gtin: string | null;
    product: { id: string; name: string; brand: string; imageUrl: string | null };
  };
};

const DUPLICATE = "You already have this type of alert for this product and source";
const FRESH_MS = 24 * 3_600_000;

export class AlertService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly plans: PlanService,
  ) {}

  private view(a: AlertRow) {
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
      source: a.source,
      variant: toVariantView(a.variant),
      product: a.variant.product,
      lastTriggeredAt: iso(a.lastTriggeredAt),
      lastTriggeredPricePaise: paiseFromDbOrNull(a.lastTriggeredPricePaise),
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  private async owned(userId: string, id: string) {
    const a = await this.prisma.priceAlert.findFirst({ where: { id, userId }, include });
    if (!a) throw AppError.notFound("Alert");
    return a;
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

  /**
   * Current lowest delivered price of an available, fresh offer (the
   * PERCENT_DROP baseline). Null when nothing current exists: the worker then
   * records the first observed price instead — never a made-up baseline.
   */
  private async currentLowest(variantId: string, sourceId: string | null): Promise<bigint | null> {
    const offers = await this.prisma.productOffer.findMany({
      where: {
        variantId,
        ...(sourceId ? { sourceId } : {}),
        source: { status: "ACTIVE" },
        observedAt: { gte: new Date(Date.now() - FRESH_MS) },
        stockStatus: { in: ["IN_STOCK", "LIMITED"] },
        trackingState: "ACTIVE",
      },
      select: { sellingPricePaise: true, shippingPaise: true },
    });
    const prices = offers.map((o) => o.sellingPricePaise + (o.shippingPaise ?? 0n));
    return prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : null;
  }

  async create(userId: string, input: CreateAlertInput) {
    await this.plans.assertWithinLimit(userId, "activeAlerts");
    if (!(await this.prisma.productVariant.count({ where: { id: input.variantId } }))) {
      throw AppError.notFound("Product variant");
    }
    await this.assertSource(input.sourceId);
    const param = ALERT_TYPE_PARAM[input.type];
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
          baselinePricePaise:
            param === "drop"
              ? await this.currentLowest(input.variantId, input.sourceId ?? null)
              : null,
          historicalWindowDays: param === "window" ? (input.historicalWindowDays ?? 90) : null,
          ...(input.cooldownMinutes !== undefined
            ? { cooldownMinutes: input.cooldownMinutes }
            : {}),
          sourceId: input.sourceId ?? null,
        },
        include,
      });
      await this.prisma.usageRecord.create({ data: { userId, metric: "ALERT_CREATED" } });
      return this.view(alert);
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict(DUPLICATE);
      throw err;
    }
  }

  async list(
    userId: string,
    q: PageQuery & {
      status?: "ACTIVE" | "TRIGGERED" | "PAUSED" | undefined;
      variantId?: string | undefined;
    },
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
    return paginated(
      rows.map((a) => this.view(a)),
      paginationOf(q, total),
    );
  }

  async get(userId: string, id: string) {
    return this.view(await this.owned(userId, id));
  }

  async update(userId: string, id: string, input: UpdateAlertInput) {
    const alert = await this.owned(userId, id);
    await this.assertSource(input.sourceId);
    const param = ALERT_TYPE_PARAM[alert.type];
    const misfit = (
      [
        ["targetPricePaise", "target"],
        ["dropPercent", "drop"],
        ["historicalWindowDays", "window"],
      ] as const
    ).find(([field, p]) => input[field] !== undefined && p !== param);
    if (misfit)
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `${misfit[0]} doesn't apply to a ${alert.type} alert`,
      );
    try {
      await this.prisma.priceAlert.update({
        where: { id },
        data: {
          ...(input.targetPricePaise === undefined
            ? {}
            : { targetPricePaise: BigInt(input.targetPricePaise) }),
          ...(input.dropPercent === undefined ? {} : { dropPercentBp: input.dropPercent * 100 }),
          ...(input.historicalWindowDays === undefined
            ? {}
            : { historicalWindowDays: input.historicalWindowDays }),
          ...(input.cooldownMinutes === undefined
            ? {}
            : { cooldownMinutes: input.cooldownMinutes }),
          ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
          // A changed condition starts fresh: evaluate it again and allow a new notification.
          lastEvaluatedAt: null,
          lastTriggeredPricePaise: null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict(DUPLICATE);
      throw err;
    }
    return this.get(userId, id);
  }

  async pause(userId: string, id: string) {
    const alert = await this.owned(userId, id);
    if (alert.status === "PAUSED") return this.view(alert);
    await this.prisma.priceAlert.update({ where: { id }, data: { status: "PAUSED" } });
    return this.get(userId, id);
  }

  async resume(userId: string, id: string) {
    const alert = await this.owned(userId, id);
    if (alert.status === "ACTIVE") return this.view(alert);
    // Re-activating counts against the active-alert limit.
    await this.plans.assertWithinLimit(userId, "activeAlerts");
    await this.prisma.priceAlert.update({ where: { id }, data: { status: "ACTIVE" } });
    return this.get(userId, id);
  }

  /** The owner's evaluation history for one alert (newest first). */
  async evaluations(userId: string, id: string, q: PageQuery) {
    await this.owned(userId, id);
    const where = { alertId: id, userId };
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
