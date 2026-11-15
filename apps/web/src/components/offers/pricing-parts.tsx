/**
 * Pricing display parts. Everything shown comes from the API's pricing engine
 * result; nothing is computed here except formatting.
 *
 * Visual language:
 *  - emerald  = verified facts (direct discount from a valid MRP, verified prices);
 *  - amber    = conditional / unverified benefits (never presented as guaranteed);
 *  - neutral  = missing data, stated plainly ("MRP not stated").
 */
import { BadgeCheck, CircleAlert, Clock, Info, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STOCK_LABEL, percent, relativeTime, rupees } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EvaluatedBenefitView, PricingResultView } from "@/types/api";

/** Plain-language reasons why a benefit is not applied. */
export const BENEFIT_REASON: Record<string, string> = {
  EXPIRED: "expired",
  NOT_YET_VALID: "not active yet",
  BENEFIT_AMOUNT_NOT_STATED: "amount not stated by the marketplace",
  MIN_TRANSACTION_NOT_MET: "minimum order value not met",
  ELIGIBLE_BANKS_NOT_STATED: "eligible banks not stated",
  USER_BANK_UNKNOWN: "depends on your bank",
  USER_BANK_NOT_ELIGIBLE: "not for your bank",
  USER_CARD_TYPE_UNKNOWN: "depends on your card type",
  USER_CARD_TYPE_NOT_ELIGIBLE: "not for your card type",
  USER_PAYMENT_METHOD_UNKNOWN: "depends on payment method",
  USER_PAYMENT_METHOD_NOT_ELIGIBLE: "not for your payment method",
  MEMBERSHIP_NOT_STATED: "membership not stated",
  USER_MEMBERSHIP_UNKNOWN: "requires a membership",
  USER_NOT_A_MEMBER: "requires a membership you don't have",
  CONDITIONS_NOT_EVALUABLE: "extra conditions apply",
  UNKNOWN_BENEFIT_TYPE: "unclassified offer",
  SOURCE_NOT_VERIFIED: "not verified by the marketplace",
};

const BENEFIT_LABEL: Record<EvaluatedBenefitView["type"], string> = {
  COUPON: "Coupon",
  BANK_OFFER: "Bank offer",
  CASHBACK: "Cashback",
  EXCHANGE: "Exchange",
  MEMBERSHIP: "Member price",
  OTHER: "Offer",
};

export function DiscountIndicator({
  pricing,
  compact = false,
}: {
  pricing: PricingResultView;
  compact?: boolean;
}) {
  const d = pricing.directDiscount;
  const verdict = pricing.assessment.verdict;
  if (d.status === "NO_MRP") return <Badge tone="neutral">MRP not stated</Badge>;
  if (d.status === "INVALID_MRP" || d.status === "ABOVE_MRP")
    return (
      <Badge tone="warning">
        <CircleAlert aria-hidden className="size-3" /> MRP data inconsistent
      </Badge>
    );
  if (!d.percentBp) return <Badge tone="neutral">No discount vs MRP</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="success">
        <BadgeCheck aria-hidden className="size-3" />
        {d.percentText} off MRP
      </Badge>
      {compact ? null : verdict === "GENUINE" ? (
        <Badge tone="success">Below its typical price</Badge>
      ) : verdict === "NOT_GENUINE" ? (
        <Badge tone="warning">Usual price — not a real drop</Badge>
      ) : (
        <Badge tone="neutral">Not enough history to verify</Badge>
      )}
    </span>
  );
}

export function StockBadge({ status }: { status: string }) {
  const tone =
    status === "IN_STOCK"
      ? "success"
      : status === "OUT_OF_STOCK"
        ? "danger"
        : status === "LIMITED"
          ? "warning"
          : "neutral";
  return <Badge tone={tone}>{STOCK_LABEL[status] ?? status}</Badge>;
}

export function ObservedAt({ iso, stale }: { iso: string; stale?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        stale ? "text-warning" : "text-muted-foreground",
      )}
    >
      <Clock aria-hidden className="size-3" />
      <time dateTime={iso} title={new Date(iso).toLocaleString("en-IN")}>
        {stale ? "Last seen " : "Price observed "}
        {relativeTime(iso)}
      </time>
    </span>
  );
}

/** Selling → delivered price composition, with verified/conditional prices kept apart. */
export function PriceBreakdown({ pricing }: { pricing: PricingResultView }) {
  const p = pricing.prices;
  const d = pricing.directDiscount;
  const rows: { label: string; value: string; note?: string; tone?: "muted" | "warning" }[] = [
    { label: "Selling price", value: rupees(p.basePaise) },
    {
      label: "Shipping",
      value: p.shippingKnown
        ? p.shippingPaise === 0
          ? "Free"
          : rupees(p.shippingPaise)
        : "Not stated",
      ...(p.shippingKnown ? {} : { tone: "warning" as const }),
    },
  ];
  if (p.mandatoryFeesPaise)
    rows.push({ label: "Mandatory fees", value: rupees(p.mandatoryFeesPaise) });
  return (
    <dl className="grid gap-1.5 text-sm">
      {d.mrpPaise !== null && d.status === "OK" ? (
        <Row label="MRP" value={rupees(d.mrpPaise)} tone="muted" />
      ) : null}
      {rows.map((r) => (
        <Row key={r.label} {...r} />
      ))}
      <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
        <dt className="font-medium">Delivered price</dt>
        <dd className="text-base font-semibold tabular">{rupees(p.deliveredPaise)}</dd>
      </div>
      {p.bestVerifiedPayablePaise < p.deliveredPaise ? (
        <Row
          label="With a verified offer"
          value={rupees(p.bestVerifiedPayablePaise)}
          note={`using ${p.bestVerifiedPayableBasis.toLowerCase().replace("_", " ")}`}
        />
      ) : null}
      {p.cashbackPaise ? (
        <Row
          label="Cashback (credited later)"
          value={rupees(p.cashbackPaise)}
          note={`not deducted · ${rupees(p.cashbackAdjustedReferencePaise)} after cashback, for reference`}
          tone="muted"
        />
      ) : null}
      {p.exchangeMaxBenefitPaise ? (
        <Row
          label="Exchange (depends on your device)"
          value={`up to ${rupees(p.exchangeMaxBenefitPaise)}`}
          note="not included in any price above"
          tone="muted"
        />
      ) : null}
    </dl>
  );
}

function Row({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "muted" | "warning";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn("text-muted-foreground", tone === "warning" && "text-warning")}>
        {label}
        {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
      </dt>
      <dd
        className={cn(
          "tabular",
          tone === "muted" && "text-muted-foreground",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** Conditional benefits: amber, never presented as guaranteed. Verified ones say so. */
export function BenefitList({
  benefits,
  limit,
}: {
  benefits: EvaluatedBenefitView[];
  limit?: number;
}) {
  if (!benefits.length) return null;
  const shown = limit ? benefits.slice(0, limit) : benefits;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Offers and benefits">
      {shown.map((b, i) => {
        const value =
          b.benefitPaise !== null
            ? rupees(b.benefitPaise)
            : b.percentBp !== null
              ? percent(b.percentBp)
              : null;
        const verified = b.status === "VERIFIED";
        const why = b.reasons.map((r) => BENEFIT_REASON[r] ?? r.toLowerCase().replace(/_/g, " "));
        return (
          <li
            key={`${b.type}-${i}`}
            className={cn(
              "rounded-lg border px-2.5 py-1.5 text-xs",
              verified ? "border-primary/25 bg-primary-soft" : "border-warning/30 bg-warning-soft",
            )}
          >
            <span className="font-medium">
              {BENEFIT_LABEL[b.type]}
              {value ? ` · ${value}` : ""}
            </span>
            <span className={cn("ml-1.5", verified ? "text-primary" : "text-warning")}>
              {verified
                ? b.appliesToPayable
                  ? "verified"
                  : "verified · not deducted"
                : b.status === "EXPIRED"
                  ? "expired"
                  : b.status === "INELIGIBLE"
                    ? "not applicable"
                    : "conditional · not guaranteed"}
            </span>
            <span className="block text-muted-foreground">
              {b.description}
              {why.length && !verified ? ` — ${why.join(", ")}` : ""}
            </span>
          </li>
        );
      })}
      {limit && benefits.length > limit ? (
        <li className="text-xs text-muted-foreground">+{benefits.length - limit} more offers</li>
      ) : null}
    </ul>
  );
}

/** "Lowest observed in the last 90 days" / all-time (only with complete history), trend, drop. */
export function HistoryContext({ pricing }: { pricing: PricingResultView }) {
  const h = pricing.history;
  const items: { icon: typeof Info; text: string; tone: "success" | "neutral" | "warning" }[] = [];
  if (h.lowestClaim.text)
    items.push({ icon: BadgeCheck, text: h.lowestClaim.text, tone: "success" });
  if (h.recentDrop)
    items.push({
      icon: TrendingDown,
      text: `Down ${rupees(h.recentDrop.dropPaise)} (${percent(h.recentDrop.dropBp)}) from its recent typical ${rupees(h.recentDrop.referencePaise)}`,
      tone: "success",
    });
  else if (h.trend === "RISING")
    items.push({
      icon: TrendingUp,
      text: "Price has been rising over the last 30 days",
      tone: "warning",
    });
  if (!items.length)
    items.push({
      icon: Info,
      text:
        h.observations < 3
          ? "Not enough price history yet to compare"
          : "Not the lowest observed price in the tracked period",
      tone: "neutral",
    });
  return (
    <ul className="flex flex-col gap-1 text-xs" aria-label="Price history">
      {items.map(({ icon: Icon, text, tone }) => (
        <li
          key={text}
          className={cn(
            "flex items-start gap-1.5",
            tone === "success"
              ? "text-primary"
              : tone === "warning"
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
          {text}
        </li>
      ))}
    </ul>
  );
}
