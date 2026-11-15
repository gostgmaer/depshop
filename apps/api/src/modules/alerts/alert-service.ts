/**
 * User-owned price alerts on shared catalog variants. Evaluation against new
 * prices runs in apps/worker (alert-evaluation jobs, Phase 7); this service
 * manages alert lifecycle. All queries are scoped by the authenticated userId.
 */
import { type Prisma, type PrismaClient, isUniqueViolation } from "@dealmind/db";
import {
  AppError,
  ErrorCode,
  type PageQuery,
  paginationOf,
  paiseFromDb,
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
  targetPricePaise: bigint;
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

const DUPLICATE = "You already have an alert for this product and source";

export class AlertService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly plans: PlanService,
  ) {}

  private view(a: AlertRow) {
    return {
      id: a.id,
      status: a.status,
      targetPricePaise: paiseFromDb(a.targetPricePaise),
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

  async create(
    userId: string,
    input: { variantId: string; targetPricePaise: number; sourceId?: string | undefined },
  ) {
    await this.plans.assertWithinLimit(userId, "activeAlerts");
    if (!(await this.prisma.productVariant.count({ where: { id: input.variantId } }))) {
      throw AppError.notFound("Product variant");
    }
    await this.assertSource(input.sourceId);
    try {
      const alert = await this.prisma.priceAlert.create({
        data: {
          userId,
          variantId: input.variantId,
          targetPricePaise: BigInt(input.targetPricePaise),
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

  async update(
    userId: string,
    id: string,
    input: { targetPricePaise?: number | undefined; sourceId?: string | null | undefined },
  ) {
    await this.owned(userId, id);
    await this.assertSource(input.sourceId);
    try {
      await this.prisma.priceAlert.update({
        where: { id },
        data: {
          ...(input.targetPricePaise === undefined
            ? {}
            : { targetPricePaise: BigInt(input.targetPricePaise) }),
          ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
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

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.prisma.priceAlert.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw AppError.notFound("Alert");
  }
}
