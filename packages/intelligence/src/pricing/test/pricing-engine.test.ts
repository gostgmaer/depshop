import { MoneyError, applyBp, ratioBp } from "@dealmind/shared";
import { describe, expect, it } from "vitest";
import { PriceValidationError, directDiscount } from "../calculations/direct-discount.js";
import { calculatePricing } from "../engine.js";
import { bankKey } from "../offer-conditions/evaluate.js";
import { parseOfferConditions } from "../schemas/offer-conditions.js";
import { NOW, daily, daysAgo, input, promo, rs } from "./fixtures.js";

const price = (conditions: unknown, ctx = {}, over = {}) =>
  calculatePricing(input({ offerConditions: conditions, ...over }), ctx, NOW);

const HDFC_10 = promo({
  type: "BANK_OFFER",
  description: "10% instant discount on HDFC Bank credit cards, up to ₹1,500 on orders of ₹15,000+",
  percentBasisPoints: 1_000,
  maxAmountPaise: rs(1_500),
  minTransactionPaise: rs(15_000),
  eligibleBanks: ["HDFC Bank"],
  cardTypes: ["CREDIT"],
  verified: true,
});
const COUPON_1000 = promo({
  type: "COUPON",
  description: "₹1,000 off",
  amountPaise: rs(1_000),
  code: "SAVE1000",
  verified: true,
});

describe("1. direct discount", () => {
  it("is MRP − selling price, with the % in basis points rounded down", () => {
    const d = directDiscount(rs(24_999), rs(29_999));
    expect(d).toMatchObject({
      status: "OK",
      amountPaise: rs(5_000),
      percentBp: 1_666,
      percentText: "16.66%",
    });
    // 16.667% is never shown as 16.67%.
    expect(ratioBp(500_000n, 2_999_900n)).toBe(1_666);
  });

  it("never includes cashback or conditional benefits", () => {
    const p = price(
      {
        cashback: [
          promo({
            type: "CASHBACK",
            description: "₹500 cashback",
            amountPaise: rs(500),
            verified: true,
          }),
        ],
        bankOffers: [HDFC_10],
      },
      { banks: ["HDFC"], cardTypes: ["CREDIT"] },
    );
    expect(p.directDiscount.amountPaise).toBe(rs(5_000));
    expect(p.directDiscount.percentBp).toBe(1_666);
  });
});

describe("2. missing MRP", () => {
  it("produces no discount amount or percentage (never fabricated)", () => {
    const d = directDiscount(rs(24_999), null);
    expect(d).toMatchObject({
      status: "NO_MRP",
      amountPaise: null,
      percentBp: null,
      percentText: null,
    });
    const p = price({}, {}, { mrpPaise: null });
    expect(p.flags).toContain("NO_MRP");
    expect(p.assessment.claimedDiscountBp).toBe(0);
  });
});

describe("3. invalid prices", () => {
  it("rejects a zero MRP, a negative or fractional price, and a price above MRP without an exception", () => {
    expect(directDiscount(rs(999), 0).status).toBe("INVALID_MRP");
    expect(() => directDiscount(-1, rs(999))).toThrow(PriceValidationError);
    expect(() => directDiscount(2_499.5, rs(2_999))).toThrow(MoneyError);
    expect(directDiscount(rs(1_099), rs(999))).toMatchObject({
      status: "ABOVE_MRP",
      amountPaise: null,
      percentBp: null,
    });
    expect(price({}, {}, { sellingPricePaise: rs(1_099), mrpPaise: rs(999) }).flags).toContain(
      "SELLING_PRICE_ABOVE_MRP",
    );
  });

  it("allows a price above MRP only with an explicit source-stated exception (no discount)", () => {
    const p = price(
      { pricingException: { sellingAboveMrp: true, reason: "MRP revised after GST change" } },
      {},
      {
        sellingPricePaise: rs(1_099),
        mrpPaise: rs(999),
      },
    );
    expect(p.directDiscount).toMatchObject({
      status: "ABOVE_MRP_EXCEPTION",
      amountPaise: 0,
      percentBp: 0,
    });
    expect(p.pricingException).toEqual({ reason: "MRP revised after GST change" });
  });
});

describe("4. shipping and fees", () => {
  it("delivered price = selling + shipping + mandatory fees (optional fees listed only)", () => {
    const p = price(
      {
        fees: [
          { type: "PLATFORM", description: "Platform fee", amountPaise: rs(3), mandatory: true },
          {
            type: "INSTALLATION",
            description: "Installation",
            amountPaise: rs(499),
            mandatory: false,
          },
        ],
      },
      {},
      { sellingPricePaise: rs(499), mrpPaise: rs(999), shippingPaise: rs(40) },
    );
    expect(p.prices).toMatchObject({
      basePaise: rs(499),
      shippingPaise: rs(40),
      mandatoryFeesPaise: rs(3),
      deliveredPaise: rs(542),
    });
    expect(p.fees).toHaveLength(2);
  });

  it("flags unstated shipping instead of assuming free delivery", () => {
    const p = price({}, {}, { shippingPaise: null });
    expect(p.prices.shippingKnown).toBe(false);
    expect(p.flags).toContain("SHIPPING_NOT_STATED");
  });
});

describe("5. coupon eligibility", () => {
  it("applies only a verified, eligible, unexpired coupon", () => {
    expect(price({ coupons: [COUPON_1000] }).prices).toMatchObject({
      couponPricePaise: rs(23_999),
      bestVerifiedPayablePaise: rs(23_999),
      bestVerifiedPayableBasis: "COUPON",
    });
    const unverified = price({ coupons: [{ ...COUPON_1000, verified: false }] });
    expect(unverified.prices.couponPricePaise).toBeNull();
    expect(unverified.benefits[0]).toMatchObject({
      status: "UNVERIFIED",
      reasons: ["SOURCE_NOT_VERIFIED"],
      appliesToPayable: false,
    });
    const expired = price({ coupons: [{ ...COUPON_1000, expiresAt: daysAgo(1).toISOString() }] });
    expect(expired.benefits[0]!.status).toBe("EXPIRED");
    const minimum = price({ coupons: [{ ...COUPON_1000, minTransactionPaise: rs(30_000) }] });
    expect(minimum.benefits[0]).toMatchObject({
      status: "INELIGIBLE",
      reasons: ["MIN_TRANSACTION_NOT_MET"],
    });
    const conditional = price({ coupons: [{ ...COUPON_1000, conditions: ["New users only"] }] });
    expect(conditional.benefits[0]!.status).toBe("UNVERIFIED");
    expect(conditional.prices.bestVerifiedPayablePaise).toBe(rs(24_999));
  });
});

describe("6. bank discount eligibility", () => {
  it("never assumes the user's bank or card", () => {
    const p = price({ bankOffers: [HDFC_10] });
    expect(p.benefits[0]).toMatchObject({
      status: "UNVERIFIED",
      reasons: ["USER_BANK_UNKNOWN", "USER_CARD_TYPE_UNKNOWN"],
    });
    expect(p.prices.bankOfferPricePaise).toBeNull();
  });

  it("applies it for an eligible user, capped at the maximum", () => {
    const p = price({ bankOffers: [HDFC_10] }, { banks: ["HDFC"], cardTypes: ["CREDIT"] });
    // 10% of ₹24,999 = ₹2,499.90, capped at ₹1,500.
    expect(p.benefits[0]).toMatchObject({
      status: "VERIFIED",
      benefitPaise: rs(1_500),
      appliesToPayable: true,
    });
    expect(p.prices.bankOfferPricePaise).toBe(rs(23_499));
  });

  it("rejects another bank or card type, and never stacks with a coupon", () => {
    expect(
      price({ bankOffers: [HDFC_10] }, { banks: ["ICICI Bank"], cardTypes: ["CREDIT"] })
        .benefits[0]!.reasons,
    ).toEqual(["USER_BANK_NOT_ELIGIBLE"]);
    expect(
      price({ bankOffers: [HDFC_10] }, { banks: ["HDFC"], cardTypes: ["DEBIT"] }).benefits[0]!
        .status,
    ).toBe("INELIGIBLE");
    const both = price(
      { bankOffers: [HDFC_10], coupons: [COUPON_1000] },
      { banks: ["HDFC"], cardTypes: ["CREDIT"] },
    );
    expect(both.prices).toMatchObject({
      couponPricePaise: rs(23_999),
      bankOfferPricePaise: rs(23_499),
      bestVerifiedPayablePaise: rs(23_499),
      bestVerifiedPayableBasis: "BANK_OFFER",
    });
    expect(bankKey("HDFC BANK LTD.")).toBe(bankKey("hdfc"));
  });

  it("a bank offer that doesn't name its banks stays unverified", () => {
    const p = price(
      { bankOffers: [{ ...HDFC_10, eligibleBanks: undefined }] },
      { banks: ["HDFC"], cardTypes: ["CREDIT"] },
    );
    expect(p.benefits[0]!.reasons).toContain("ELIGIBLE_BANKS_NOT_STATED");
  });
});

describe("7. cashback separation", () => {
  it("is shown separately and never lowers the payable price", () => {
    const p = price({
      cashback: [
        promo({
          type: "CASHBACK",
          description: "₹500 cashback to wallet",
          amountPaise: rs(500),
          verified: true,
        }),
      ],
    });
    expect(p.prices).toMatchObject({
      deliveredPaise: rs(24_999),
      bestVerifiedPayablePaise: rs(24_999),
      cashbackPaise: rs(500),
      cashbackAdjustedReferencePaise: rs(24_499),
    });
    expect(p.benefits[0]!.appliesToPayable).toBe(false);
    // Unverified cashback isn't counted at all.
    expect(
      price({ cashback: [promo({ type: "CASHBACK", description: "x", amountPaise: rs(500) })] })
        .prices.cashbackPaise,
    ).toBeNull();
  });
});

describe("8. exchange exclusion", () => {
  it("lists the exchange benefit but never deducts it", () => {
    const p = price({
      exchange: [
        promo({
          type: "EXCHANGE",
          description: "Up to ₹8,000 off on exchange",
          amountPaise: rs(8_000),
          verified: true,
        }),
      ],
    });
    expect(p.prices.exchangeMaxBenefitPaise).toBe(rs(8_000));
    expect(p.prices.bestVerifiedPayablePaise).toBe(rs(24_999));
    expect(p.benefits[0]!.appliesToPayable).toBe(false);
  });
});

describe("9. membership eligibility", () => {
  const plus = promo({
    type: "MEMBERSHIP",
    description: "Extra ₹500 off for members",
    amountPaise: rs(500),
    membership: "Flipkart Plus",
    verified: true,
  });
  it("applies only to a stated member", () => {
    expect(price({ membership: [plus] }).benefits[0]!.reasons).toEqual(["USER_MEMBERSHIP_UNKNOWN"]);
    expect(
      price({ membership: [plus] }, { memberships: ["Amazon Prime"] }).benefits[0]!.status,
    ).toBe("INELIGIBLE");
    const member = price({ membership: [plus] }, { memberships: ["flipkart plus"] });
    expect(member.prices.membershipPricePaise).toBe(rs(24_499));
    expect(member.prices.bestVerifiedPayableBasis).toBe("MEMBERSHIP");
  });
});

describe("10. EMI cost transparency", () => {
  it("shows interest and fees separately and never calls EMI a discount", () => {
    const p = price({
      emi: [
        { tenureMonths: 6, noCostClaimed: true, processingFeePaise: rs(199) },
        {
          tenureMonths: 12,
          interestRateBp: 1_500,
          monthlyInstallmentPaise: rs(2_256),
          processingFeePaise: 0,
        },
        { tenureMonths: 9, interestRateBp: 1_400 },
        { tenureMonths: 3, noCostClaimed: true, processingFeePaise: 0 },
        { tenureMonths: 6, monthlyInstallmentPaise: rs(4_000), processingFeePaise: 0 },
      ],
    });
    const [noCost, interest, rateOnly, free, odd] = p.emi;
    expect(noCost).toMatchObject({
      totalPayablePaise: rs(25_198),
      extraCostPaise: rs(199),
      label: "COSTS_MORE",
    });
    expect(noCost!.flags).toEqual(
      expect.arrayContaining(["NO_COST_CLAIM_UNVERIFIED", "NO_COST_CLAIM_HAS_CHARGES"]),
    );
    expect(interest).toMatchObject({
      totalPayablePaise: rs(27_072),
      interestPaise: rs(2_073),
      extraCostPaise: rs(2_073),
      label: "COSTS_MORE",
    });
    expect(rateOnly).toMatchObject({
      label: "COST_NOT_STATED",
      totalPayablePaise: null,
      extraCostPaise: null,
    });
    expect(rateOnly!.flags).toContain("PROCESSING_FEE_NOT_STATED");
    expect(free).toMatchObject({ label: "NO_EXTRA_COST", extraCostPaise: 0 });
    expect(odd!.label).toBe("INCONSISTENT");
    expect(p.prices.bestVerifiedPayablePaise).toBe(rs(24_999));
  });
});

describe("11. historical lowest price", () => {
  it("claims the lowest observed price only for a window it actually observed", () => {
    const p = price({}, {}, { snapshots: daily(rs(26_999), 100) });
    const w = Object.fromEntries(p.history.windows.map((x) => [x.days, x]));
    expect(w[90]).toMatchObject({
      coverageBp: 10_000,
      lowestPaise: rs(24_999),
      currentIsLowest: true,
    });
    expect(w[180]!.coverageBp).toBeLessThan(6_000);
    expect(p.history.lowestClaim).toEqual({
      kind: "LOWEST_IN_WINDOW",
      days: 90,
      text: "Lowest observed price in the last 90 days",
    });
  });

  it("claims an all-time low only with complete coverage since launch", () => {
    const full = price({}, {}, { snapshots: daily(rs(26_999), 100), launchDate: daysAgo(100) });
    expect(full.history.lowestClaim.kind).toBe("ALL_TIME_LOW");
    // Tracking started 30 days after launch: no all-time claim.
    const late = price({}, {}, { snapshots: daily(rs(26_999), 70), launchDate: daysAgo(100) });
    expect(late.history.lowestClaim.kind).toBe("LOWEST_IN_WINDOW");
    // A 20-day gap breaks the all-time claim and the 30/90-day claims.
    const gap = price(
      {},
      {},
      {
        snapshots: [...daily(rs(26_999), 60, 41), ...daily(rs(26_999), 20, 1)],
        launchDate: daysAgo(100),
      },
    );
    expect(gap.history.lowestClaim).toMatchObject({ kind: "LOWEST_IN_WINDOW", days: 7 });
    expect(gap.history.windows.find((x) => x.days === 90)!.coverageBp).toBeLessThan(9_000);
  });

  it("doesn't call a price the lowest when a lower one was observed", () => {
    const p = price(
      {},
      {},
      {
        snapshots: [
          ...daily(rs(26_999), 100),
          { sellingPricePaise: rs(23_999), observedAt: daysAgo(10) },
        ],
      },
    );
    expect(p.history.windows.find((x) => x.days === 30)!.currentIsLowest).toBe(false);
    expect(p.history.lowestClaim).toMatchObject({ days: 7 });
  });

  it("reports previous price, change, trend, average and a verified recent drop", () => {
    const p = price({}, {}, { snapshots: daily(rs(26_999), 20, 3) });
    expect(p.history).toMatchObject({
      previousPricePaise: rs(26_999),
      changeFromPreviousBp: -740,
      trend: "FALLING",
      recentDrop: { referencePaise: rs(26_999), dropPaise: rs(2_000), dropBp: 740 },
    });
    expect(p.history.windows.find((x) => x.days === 30)!.averagePaise).toBe(2_690_376);
  });

  it("does not let a one-off price spike manufacture a drop", () => {
    const spike = [
      ...daily(rs(24_999), 29, 2),
      { sellingPricePaise: rs(29_999), observedAt: new Date(NOW.getTime() - 36 * 3_600_000) },
    ];
    const p = price({}, {}, { snapshots: spike });
    expect(p.history.recentDrop).toBeNull();
  });
});

describe("12. missing historical data", () => {
  it("makes no claims and says so", () => {
    const p = price({});
    expect(p.history).toMatchObject({
      observations: 1,
      trend: "INSUFFICIENT_DATA",
      previousPricePaise: null,
      recentDrop: null,
      lowestClaim: { kind: "NONE", text: null },
    });
    expect(p.history.windows.every((w) => w.coverageBp === 0)).toBe(true);
    expect(p.assessment.verdict).toBe("INSUFFICIENT_HISTORY");
  });
});

describe("19. integer paise arithmetic", () => {
  it("is exact beyond floating-point precision and returns only safe integers", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(directDiscount(1, max)).toMatchObject({ amountPaise: max - 1, percentBp: 9_999 });
    // Float math would round (max − 1) × 10000 / max up to 10000.
    expect(ratioBp(BigInt(max - 1), BigInt(max))).toBe(9_999);
    const p = price(
      {
        bankOffers: [HDFC_10],
        coupons: [COUPON_1000],
        emi: [{ tenureMonths: 6, monthlyInstallmentPaise: rs(4_200) }],
      },
      { banks: ["HDFC"], cardTypes: ["CREDIT"] },
      { shippingPaise: rs(49) },
    );
    const walk = (v: unknown, key = ""): void => {
      if (typeof v === "number" && /Paise$/.test(key)) expect(Number.isSafeInteger(v)).toBe(true);
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(p);
  });
});

describe("20. rounding and boundaries", () => {
  it("rounds percentages and percentage benefits down", () => {
    expect(directDiscount(2, 3).percentBp).toBe(3_333);
    expect(directDiscount(1, 3).percentBp).toBe(6_666);
    expect(directDiscount(0, rs(29_999))).toMatchObject({ percentBp: 10_000, percentText: "100%" });
    expect(directDiscount(rs(29_999), rs(29_999))).toMatchObject({
      status: "OK",
      amountPaise: 0,
      percentBp: 0,
      percentText: "0%",
    });
    expect(applyBp(2_499_999n, 1_000)).toBe(249_999n);
  });

  it("caps a benefit at the transaction value and at its stated maximum", () => {
    const p = price(
      { coupons: [{ ...COUPON_1000, amountPaise: rs(500) }] },
      {},
      { sellingPricePaise: rs(300), mrpPaise: rs(599) },
    );
    expect(p.benefits[0]!.benefitPaise).toBe(rs(300));
    expect(p.prices.couponPricePaise).toBe(0);
  });

  it("drops malformed stored conditions instead of guessing", () => {
    const parsed = parseOfferConditions({
      coupons: [
        { type: "COUPON", description: "ok", amountPaise: 100 },
        { type: "COUPON", amountPaise: -5 },
        { type: "BANK_OFFER", description: "wrong group" },
      ],
    });
    expect(parsed.promotions).toHaveLength(1);
    expect(parsed.dropped).toEqual([
      { field: "coupons", index: 1 },
      { field: "coupons", index: 2 },
    ]);
  });
});
