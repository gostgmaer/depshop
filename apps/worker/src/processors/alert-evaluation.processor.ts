/**
 * Evaluates every user's active alert affected by one global price check.
 * One marketplace fetch serves all of them: alerts never cause fetches.
 *
 * Per alert, one transaction:
 *  - the evaluation row is unique per (alert, check), so a retried or
 *    duplicated job never evaluates — or notifies — twice;
 *  - a trigger atomically claims the alert's cooldown window with a
 *    conditional UPDATE, so two checks of different marketplaces can't both
 *    notify inside the cooldown;
 *  - the notification and its per-channel deliveries are created with it,
 *    following the user's own preferences (owner = the alert's user).
 * Email deliveries are enqueued after commit (idempotent job per delivery).
 */
import { Prisma, type PrismaClient } from "@dealmind/db";
import { trace } from "@opentelemetry/api";
import {
  type AlertState,
  type CheckContext,
  type CheckOutcome,
  type Decision,
  evaluateAlert,
  priorLow,
} from "../services/alert-rules.js";
import type { TrackingMetrics } from "../services/tracking-metrics.js";

export interface AlertEvaluationDeps {
  prisma: PrismaClient;
  metrics: TrackingMetrics;
  enqueueDelivery: (deliveryId: string) => Promise<void>;
  now?: () => Date;
}

const EVALUATED: ReadonlySet<string> = new Set([
  "UNCHANGED",
  "PRICE_DECREASED",
  "PRICE_INCREASED",
  "OTHER_CHANGED",
  "REAPPEARED",
]);
const tracer = trace.getTracer("dealmind-worker");

class AlreadyEvaluated extends Error {}

export interface EvaluationSummary {
  evaluated: number;
  triggered: number;
  duplicates: number;
  notifications: number;
}

export async function processAlertEvaluation(
  deps: AlertEvaluationDeps,
  job: { checkId: string },
): Promise<EvaluationSummary> {
  return tracer.startActiveSpan("tracking.alerts", async (span) => {
    try {
      const s = await evaluate(deps, job.checkId);
      span.setAttribute("dealmind.alerts.evaluated", s.evaluated);
      span.setAttribute("dealmind.alerts.triggered", s.triggered);
      return s;
    } finally {
      span.end();
    }
  });
}

async function evaluate(deps: AlertEvaluationDeps, checkId: string): Promise<EvaluationSummary> {
  const { prisma } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const summary: EvaluationSummary = {
    evaluated: 0,
    triggered: 0,
    duplicates: 0,
    notifications: 0,
  };
  const check = await prisma.priceCheck.findUnique({
    where: { id: checkId },
    include: {
      offer: {
        include: {
          source: { select: { name: true } },
          product: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!check || !EVALUATED.has(check.outcome) || check.newPricePaise === null) return summary;
  const offer = check.offer;
  const changed = check.outcome !== "UNCHANGED";

  const alerts = await prisma.priceAlert.findMany({
    where: {
      variantId: offer.variantId,
      status: "ACTIVE",
      OR: [{ sourceId: null }, { sourceId: offer.sourceId }],
      // Past its end date: cleanup marks it EXPIRED; it is no longer evaluated.
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      // An unchanged price only matters to alerts never evaluated yet.
      ...(changed ? {} : { lastEvaluatedAt: null }),
    },
    include: { user: { select: { id: true, email: true, preference: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!alerts.length) return summary;

  // Historical lows: this offer's own earlier observations, per window.
  const lows = new Map<number, number | null>();
  const priorLowFor = async (days: number) => {
    if (!lows.has(days)) {
      const since = new Date(now.getTime() - days * 86_400_000);
      const rows = await prisma.priceSnapshot.findMany({
        where: {
          offerId: offer.id,
          observedAt: { gte: since },
          ...(check.snapshotId ? { id: { not: check.snapshotId } } : {}),
          stockStatus: { in: ["IN_STOCK", "LIMITED"] },
        },
        select: { sellingPricePaise: true, shippingPaise: true, observedAt: true },
      });
      lows.set(
        days,
        priorLow(
          rows.map((r) => ({
            pricePaise: Number(r.sellingPricePaise + (r.shippingPaise ?? 0n)),
            at: r.observedAt,
          })),
        ),
      );
    }
    return lows.get(days)!;
  };

  for (const alert of alerts) {
    const state: AlertState = {
      type: alert.type,
      targetPricePaise: alert.targetPricePaise === null ? null : Number(alert.targetPricePaise),
      dropPercentBp: alert.dropPercentBp,
      baselinePricePaise:
        alert.baselinePricePaise === null ? null : Number(alert.baselinePricePaise),
      historicalWindowDays: alert.historicalWindowDays,
      lastTriggeredPricePaise:
        alert.lastTriggeredPricePaise === null ? null : Number(alert.lastTriggeredPricePaise),
      minChangePaise: alert.minChangePaise === null ? null : Number(alert.minChangePaise),
    };
    const ctx: CheckContext = {
      outcome: check.outcome as CheckOutcome,
      sellingPricePaise: Number(check.newPricePaise),
      shippingPaise: offer.shippingPaise === null ? null : Number(offer.shippingPaise),
      previousPricePaise:
        check.previousPricePaise === null ? null : Number(check.previousPricePaise),
      stock: check.newStock ?? offer.stockStatus,
      previousStock: check.previousStock ?? null,
      marketplace: offer.source.name,
      productName: offer.product.name,
      priorLowPaise:
        alert.type === "HISTORICAL_LOW"
          ? await priorLowFor(alert.historicalWindowDays ?? 90)
          : null,
    };
    const decision = evaluateAlert(state, ctx);
    const prefs = alert.user.preference;
    // A channel is used only if both the alert and the user's preferences allow it.
    const inApp = alert.channels.includes("IN_APP") && (prefs?.notifyInApp ?? true);
    const email =
      alert.channels.includes("EMAIL") && (prefs?.notifyEmail ?? true) && Boolean(alert.user.email);

    try {
      const result = await prisma.$transaction(async (tx) => {
        let outcome: "TRIGGERED" | "NOT_MET" | "COOLDOWN" | "SUPPRESSED" | "INSUFFICIENT_DATA" =
          decision.outcome;
        let reason = decision.reason;
        let notificationId: string | null = null;
        let emailDelivery: string | null = null;

        if (decision.outcome === "TRIGGERED") {
          if (!inApp && !email) {
            outcome = "SUPPRESSED";
            reason = `${reason} Not notified: none of this alert's channels is enabled in your settings.`;
          } else {
            // Atomic cooldown claim: only one trigger per window, across all checks.
            const claimed = await tx.$executeRaw`
              UPDATE "PriceAlert"
              SET "lastTriggeredAt" = ${now}, "lastTriggeredPricePaise" = ${BigInt(decision.deliveredPaise)},
                  "lastEvaluatedAt" = ${now}, "updatedAt" = ${now},
                  "triggerCount" = "triggerCount" + 1,
                  -- One-shot alerts end here (re-armable by the user); repeating ones keep watching.
                  "status" = CASE WHEN "repeat" THEN 'ACTIVE'::"AlertStatus" ELSE 'TRIGGERED'::"AlertStatus" END
              WHERE "id" = ${alert.id}::uuid AND "userId" = ${alert.userId}::uuid AND "status" = 'ACTIVE'
                AND ("lastTriggeredAt" IS NULL
                     OR "lastTriggeredAt" <= ${now}::timestamp - make_interval(mins => "cooldownMinutes"))`;
            if (claimed === 0) {
              outcome = "COOLDOWN";
              reason = `${reason} Not notified again within the alert's cooldown (or the alert was paused or triggered meanwhile).`;
            } else {
              const n = await notify(
                tx,
                alert.userId,
                decision,
                {
                  alertId: alert.id,
                  alertType: alert.type,
                  checkId,
                  offerId: offer.id,
                  productId: offer.product.id,
                  variantId: offer.variantId,
                  pricePaise: decision.deliveredPaise,
                  previousPricePaise: ctx.previousPricePaise,
                  marketplace: offer.source.name,
                },
                { inApp, email, now },
              );
              notificationId = n.notificationId;
              emailDelivery = n.emailDeliveryId;
            }
          }
        }

        await tx.alertEvaluation
          .create({
            data: {
              userId: alert.userId,
              alertId: alert.id,
              checkId,
              offerId: offer.id,
              outcome,
              observedPricePaise: BigInt(decision.deliveredPaise),
              reason: reason.slice(0, 1000),
              notificationId,
            },
          })
          .catch((err: unknown) => {
            // Unique (alertId, checkId): this check was already evaluated for this alert.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
              throw new AlreadyEvaluated();
            throw err;
          });

        if (outcome !== "TRIGGERED") {
          await tx.priceAlert.update({
            where: { id: alert.id },
            data: {
              lastEvaluatedAt: now,
              ...(decision.rearm ? { lastTriggeredPricePaise: null } : {}),
              ...(decision.setBaselinePaise !== undefined && alert.baselinePricePaise === null
                ? { baselinePricePaise: BigInt(decision.setBaselinePaise) }
                : {}),
            },
          });
        }
        return { outcome, notificationId, emailDelivery };
      });
      summary.evaluated += 1;
      if (result.outcome === "TRIGGERED") summary.triggered += 1;
      if (result.notificationId) summary.notifications += 1;
      if (result.emailDelivery) await deps.enqueueDelivery(result.emailDelivery);
    } catch (err) {
      if (err instanceof AlreadyEvaluated) {
        summary.duplicates += 1;
        continue;
      }
      throw err;
    }
  }
  await deps.metrics.inc({
    alerts_evaluated: summary.evaluated,
    alerts_triggered: summary.triggered,
    notifications_created: summary.notifications,
  });
  return summary;
}

async function notify(
  tx: Prisma.TransactionClient,
  userId: string,
  decision: Decision,
  data: Record<string, unknown>,
  channels: { inApp: boolean; email: boolean; now: Date },
): Promise<{ notificationId: string; emailDeliveryId: string | null }> {
  const n = decision.notification!;
  const notification = await tx.notification.create({
    data: {
      userId,
      type: n.kind,
      title: n.title.slice(0, 200),
      body: n.body.slice(0, 2000),
      data: data as Prisma.InputJsonValue,
    },
  });
  await tx.notificationDelivery.create({
    data: {
      userId,
      notificationId: notification.id,
      channel: "IN_APP",
      // The in-app record is the notification itself.
      status: channels.inApp ? "SENT" : "SKIPPED",
      ...(channels.inApp
        ? { sentAt: channels.now }
        : { lastError: "In-app notifications are off" }),
    },
  });
  const emailDelivery = await tx.notificationDelivery.create({
    data: {
      userId,
      notificationId: notification.id,
      channel: "EMAIL",
      status: channels.email ? "PENDING" : "SKIPPED",
      ...(channels.email ? {} : { lastError: "Email notifications are off" }),
    },
  });
  return {
    notificationId: notification.id,
    emailDeliveryId: channels.email ? emailDelivery.id : null,
  };
}
