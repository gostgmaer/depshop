/**
 * Imports partner-reported conversions (the authoritative commission source).
 * Idempotent per (source, provider order id): a re-import updates status and
 * amounts and never duplicates. Nothing is inferred from clicks: a click only
 * becomes a conversion when the partner reports the order. Amounts must be
 * exact rupee/paise values; anything else is rejected, never rounded.
 */
import type { Prisma, PrismaClient } from "@dealmind/db";
import { MoneyError, parseRupeesToPaise } from "@dealmind/shared";
import { z } from "zod";

export const CONVERSION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "REVERSED"] as const;
export type ConversionStatusValue = (typeof CONVERSION_STATUSES)[number];

/** One reported order item, normalized. */
export const reportedConversion = z.object({
  orderRef: z.string().trim().min(1).max(200),
  orderAmountPaise: z.number().int().nonnegative(),
  commissionPaise: z.number().int().nonnegative(),
  status: z.enum(CONVERSION_STATUSES),
  providerStatus: z.string().max(100).nullable(),
  orderedAt: z.date().nullable(),
  /** Sub-id the partner echoed back (DealMind's click reference), if any. */
  subId: z.string().max(200).nullable(),
});
export type ReportedConversion = z.infer<typeof reportedConversion>;

/** "248", "24.8", 24.8 → paise; throws on anything that isn't an exact amount. */
export function rupeesToPaise(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new MoneyError(`Invalid amount ${v}`);
    return parseRupeesToPaise(String(v));
  }
  if (typeof v === "string") return parseRupeesToPaise(v);
  throw new MoneyError("Missing amount");
}

export interface ImportSummary {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  reversed: number;
  matchedClicks: number;
}

export async function importConversions(
  prisma: PrismaClient,
  input: { sourceId: string; provider: string; rows: ReportedConversion[]; now: Date },
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    received: input.rows.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    reversed: 0,
    matchedClicks: 0,
  };
  for (const raw of input.rows) {
    const row = reportedConversion.parse(raw);
    await prisma.$transaction(async (tx) => {
      const click = row.subId
        ? await tx.affiliateClick.findFirst({
            where: { clickRef: row.subId, sourceId: input.sourceId },
            select: { id: true },
          })
        : null;
      const existing = await tx.affiliateConversion.findUnique({
        where: {
          sourceId_externalOrderRef: { sourceId: input.sourceId, externalOrderRef: row.orderRef },
        },
      });
      const data = {
        provider: input.provider,
        orderAmountPaise: BigInt(row.orderAmountPaise),
        commissionPaise: BigInt(row.commissionPaise),
        status: row.status,
        providerStatus: row.providerStatus,
        orderedAt: row.orderedAt,
        reportedAt: input.now,
        ...(click ? { clickId: click.id } : {}),
      } satisfies Prisma.AffiliateConversionUncheckedUpdateInput;
      if (click) summary.matchedClicks += 1;
      if (!existing) {
        await tx.affiliateConversion.create({
          data: {
            ...data,
            sourceId: input.sourceId,
            externalOrderRef: row.orderRef,
            currency: "INR",
          },
        });
        summary.created += 1;
        if (row.status === "REVERSED") summary.reversed += 1;
        return;
      }
      const same =
        existing.status === row.status &&
        existing.commissionPaise === BigInt(row.commissionPaise) &&
        existing.orderAmountPaise === BigInt(row.orderAmountPaise) &&
        (existing.providerStatus ?? null) === row.providerStatus;
      if (same && (!click || existing.clickId === click.id)) {
        summary.unchanged += 1;
        return;
      }
      await tx.affiliateConversion.update({ where: { id: existing.id }, data });
      summary.updated += 1;
      if (row.status === "REVERSED" && existing.status !== "REVERSED") summary.reversed += 1;
    });
  }
  return summary;
}

/** Records a payout the partner reported (idempotent per provider + reference). */
export async function recordPayout(
  prisma: PrismaClient,
  input: {
    provider: string;
    sourceId: string | null;
    amountPaise: number;
    status: "PENDING" | "PAID" | "FAILED";
    payoutReference: string;
    paidAt: Date | null;
    periodStart: Date | null;
    periodEnd: Date | null;
  },
) {
  const data = {
    sourceId: input.sourceId,
    amountPaise: BigInt(input.amountPaise),
    status: input.status,
    paidAt: input.status === "PAID" ? input.paidAt : null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  };
  return prisma.affiliatePayout.upsert({
    where: {
      provider_payoutReference: {
        provider: input.provider,
        payoutReference: input.payoutReference,
      },
    },
    create: {
      provider: input.provider,
      payoutReference: input.payoutReference,
      currency: "INR",
      ...data,
    },
    update: data,
  });
}
