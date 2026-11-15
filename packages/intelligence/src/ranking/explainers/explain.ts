/**
 * Explanations built only from the data that produced the rank: prices,
 * discounts, benefit statuses, history claims and score components.
 * Formatting happens here (₹ with Indian grouping); no number is invented.
 */
import { formatBasisPoints, formatPaise } from "@dealmind/shared";
import type { EvaluatedBenefit } from "../../pricing/offer-conditions/evaluate.js";
import type { Scored } from "../strategies/strategies.js";
import type { PriceBasis, RankingMode, ScoreComponents } from "../types.js";

const LABEL: Record<EvaluatedBenefit["type"], string> = {
  COUPON: "Coupon",
  BANK_OFFER: "Bank offer",
  CASHBACK: "Cashback",
  EXCHANGE: "Exchange offer",
  MEMBERSHIP: "Membership price",
  OTHER: "Offer",
};

const STATUS_NOTE: Record<EvaluatedBenefit["status"], string> = {
  VERIFIED: "verified",
  UNVERIFIED: "not applied: not verified",
  EXPIRED: "expired",
  INELIGIBLE: "not applicable to you",
};

function benefitLine(b: EvaluatedBenefit): string {
  const value =
    b.benefitPaise !== null
      ? formatPaise(b.benefitPaise)
      : b.percentBp !== null
        ? formatBasisPoints(b.percentBp)
        : "amount not stated";
  if (b.type === "CASHBACK")
    return `${LABEL[b.type]} ${value} (${STATUS_NOTE[b.status]}; credited later, not deducted from the price)`;
  if (b.type === "EXCHANGE")
    return `${LABEL[b.type]} up to ${value} (depends on your device; not included in the ranking)`;
  const applied = b.appliesToPayable
    ? "applied to the verified payable price"
    : STATUS_NOTE[b.status];
  return `${LABEL[b.type]} ${value}${b.eligibleBanks.length ? ` (${b.eligibleBanks.join(", ")})` : ""}: ${applied}`;
}

export function dealFactors(s: Scored, basis: PriceBasis): string[] {
  const p = s.c.pricing;
  const f: string[] = [];
  const ship = p.prices.shippingKnown
    ? p.prices.shippingPaise === 0
      ? "free shipping"
      : `${formatPaise(p.prices.shippingPaise)} shipping`
    : "shipping not stated";
  const fees = p.prices.mandatoryFeesPaise
    ? ` + ${formatPaise(p.prices.mandatoryFeesPaise)} fees`
    : "";
  f.push(
    `Delivered price ${formatPaise(p.prices.deliveredPaise)} (selling ${formatPaise(p.prices.basePaise)}, ${ship}${fees})`,
  );
  if (basis === "best_verified" && p.prices.bestVerifiedPayableBasis !== "DELIVERED") {
    f.push(
      `Verified payable price ${formatPaise(p.prices.bestVerifiedPayablePaise)} with an eligible ${p.prices.bestVerifiedPayableBasis.toLowerCase().replace("_", " ")}`,
    );
  }
  const d = p.directDiscount;
  if (d.status === "OK" && d.amountPaise && d.percentText && d.mrpPaise !== null) {
    f.push(`${d.percentText} off MRP ${formatPaise(d.mrpPaise)} (${formatPaise(d.amountPaise)})`);
  } else if (d.status === "NO_MRP") {
    f.push("No MRP stated, so no discount is claimed");
  } else if (d.status === "ABOVE_MRP") {
    f.push("Selling price is above the stated MRP: discount not computed");
  }
  if (p.assessment.verdict === "NOT_GENUINE" && d.status === "OK" && (d.percentBp ?? 0) > 0) {
    f.push("Price history does not show this discount as a real price cut");
  }
  if (p.history.lowestClaim.text) f.push(p.history.lowestClaim.text);
  if (p.history.recentDrop) {
    f.push(
      `Down ${formatPaise(p.history.recentDrop.dropPaise)} (${formatBasisPoints(p.history.recentDrop.dropBp)}) from its recent typical price ${formatPaise(p.history.recentDrop.referencePaise)}`,
    );
  }
  for (const b of p.benefits) f.push(benefitLine(b));
  if (!s.c.launchDate && s.components.recency === null && s.used.recency !== undefined) {
    f.push("Launch date unknown");
  }
  if (s.c.stockStatus === "PREORDER") f.push("Pre-order: not available to buy immediately");
  if (s.c.stockStatus === "UNKNOWN") f.push("Availability not confirmed by the marketplace");
  f.push(`Price observed ${p.observedAt}`);
  return f;
}

const COMPONENT_LABEL: Record<keyof ScoreComponents, string> = {
  price: "price",
  discount: "verified discount",
  history: "position in its price history",
  specMatch: "match with your preferred specifications",
  relevance: "match with your search",
  quality: "quality signals",
  recency: "launch recency",
  priceDrop: "recent price drop",
};

/** Why `a` ranked above `b`, from the deciding difference. */
export function versusNext(
  a: Scored,
  b: Scored | undefined,
  bRank: number,
  mode: RankingMode,
  basis: PriceBasis,
): string | null {
  if (!b) return null;
  const name = `#${bRank} (${b.c.sourceName})`;
  const priceWord = basis === "best_verified" ? "verified payable price" : "delivered price";
  if (mode === "lowest_price") {
    return a.price === b.price
      ? `Same ${priceWord} as ${name}; ordered by discount, then deterministically`
      : `${formatPaise(b.price - a.price)} lower ${priceWord} than ${name}`;
  }
  if (a.avail !== b.avail) {
    return `Availability confirmed, unlike ${name}`;
  }
  // The weighted component with the largest lead.
  let best: { k: keyof ScoreComponents; lead: number } | null = null;
  for (const [k, w] of Object.entries(a.used) as [keyof ScoreComponents, number][]) {
    const va = a.components[k];
    const vb = b.components[k];
    if (va === null || vb === null) continue;
    const lead = (va - vb) * w;
    if (!best || lead > best.lead) best = { k, lead };
  }
  if (!best || best.lead <= 0) {
    return a.score === b.score
      ? `Equal score; the lower ${priceWord} comes first`
      : `Higher overall score (${a.score} vs ${b.score})`;
  }
  if (best.k === "price" && a.price !== b.price) {
    return `Better ${COMPONENT_LABEL.price}: ${formatPaise(b.price - a.price)} lower ${priceWord} than ${name}`;
  }
  return `Better ${COMPONENT_LABEL[best.k]} than ${name} (score ${a.score} vs ${b.score})`;
}

export function summary(s: Scored, mode: RankingMode, basis: PriceBasis): string {
  const p = s.c.pricing;
  const price = formatPaise(s.price);
  const what = basis === "best_verified" ? "verified payable" : "delivered";
  switch (mode) {
    case "lowest_price":
      return `${price} ${what} on ${s.c.sourceName}`;
    case "highest_discount":
      return p.directDiscount.percentText && p.directDiscount.status === "OK"
        ? `${p.directDiscount.percentText} off MRP on ${s.c.sourceName} (${price} ${what})`
        : `No verifiable MRP discount on ${s.c.sourceName} (${price} ${what})`;
    case "price_drop":
      return p.history.recentDrop
        ? `Dropped ${formatBasisPoints(p.history.recentDrop.dropBp)} on ${s.c.sourceName} (${price} ${what})`
        : `No verified recent price drop on ${s.c.sourceName} (${price} ${what})`;
    default:
      return `Score ${s.score}/10000 on ${s.c.sourceName} (${price} ${what})`;
  }
}
