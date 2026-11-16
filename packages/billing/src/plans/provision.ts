/**
 * Registers DealMind's paid plans with the payment provider and stores the
 * provider plan ids per interval on SubscriptionPlan.providerPlanIds.
 * Idempotent: an existing provider plan with the same key and amount is
 * reused. A changed price yields a new provider plan; existing subscribers
 * keep billing on the old one (the provider's versioning).
 */
import type { Prisma, PrismaClient } from "@dealmind/db";
import type { BillingIntervalValue } from "@dealmind/shared";
import type { EntitlementService } from "../entitlements/service.js";
import type { BillingProvider, ProviderPlanSpec } from "../providers/interface.js";
import { priceOf } from "./catalog.js";

export async function provisionProviderPlans(
  prisma: PrismaClient,
  entitlements: EntitlementService,
  provider: BillingProvider,
): Promise<Record<string, string>> {
  const plans = await entitlements.plans();
  const specs: ProviderPlanSpec[] = [];
  for (const plan of plans.values()) {
    if (plan.code === "FREE" || !plan.active) continue;
    for (const interval of ["MONTHLY", "ANNUAL"] as BillingIntervalValue[]) {
      const amount = priceOf(plan, interval);
      if (amount && amount > 0)
        specs.push({
          key: `${plan.code}:${interval}`,
          name: `${plan.name} (${interval === "MONTHLY" ? "monthly" : "annual"})`,
          description: plan.description,
          amountPaise: amount,
          interval,
        });
    }
  }
  const ids = await provider.ensurePlans(specs);
  for (const plan of plans.values()) {
    if (plan.code === "FREE") continue;
    const providerPlanIds: Record<string, string> = {};
    for (const interval of ["MONTHLY", "ANNUAL"] as const) {
      const id = ids[`${plan.code}:${interval}`];
      if (id) providerPlanIds[interval] = id;
    }
    await prisma.subscriptionPlan.updateMany({
      where: { code: plan.code },
      data: { providerPlanIds: providerPlanIds as Prisma.InputJsonObject },
    });
  }
  return ids;
}
