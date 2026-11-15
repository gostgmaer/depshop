/**
 * TEST FIXTURES ONLY (fictional "Acme" products and "Mock Store" sources).
 * Never imported by application code; shaped exactly like the API contracts
 * and validated against the shared Zod schemas in the tests that use them.
 */
import type {
  PricingResultView,
  ProductPricingView,
  SearchDetail,
  SearchResultView,
} from "@/types/api";

export const NOW_ISO = new Date().toISOString();

export function pricing(over: Partial<PricingResultView> = {}): PricingResultView {
  return {
    offerId: "00000000-0000-7000-8000-000000000001",
    currency: "INR",
    observedAt: NOW_ISO,
    priceType: "LISTED",
    stockStatus: "IN_STOCK",
    directDiscount: {
      status: "OK",
      mrpPaise: 2_999_900,
      sellingPricePaise: 2_499_900,
      amountPaise: 500_000,
      percentBp: 1_666,
      percentText: "16.66%",
    },
    pricingException: null,
    prices: {
      basePaise: 2_499_900,
      shippingPaise: 0,
      shippingKnown: true,
      mandatoryFeesPaise: 0,
      deliveredPaise: 2_499_900,
      couponPricePaise: null,
      bankOfferPricePaise: null,
      membershipPricePaise: null,
      bestVerifiedPayablePaise: 2_499_900,
      bestVerifiedPayableBasis: "DELIVERED",
      cashbackPaise: null,
      cashbackAdjustedReferencePaise: null,
      exchangeMaxBenefitPaise: null,
    },
    benefits: [
      {
        type: "BANK_OFFER",
        description: "₹1,500 off with HDFC Bank credit cards",
        amountPaise: 150_000,
        percentBp: null,
        maxDiscountPaise: null,
        minTransactionPaise: null,
        eligibleBanks: ["HDFC Bank"],
        paymentMethods: [],
        cardTypes: ["CREDIT"],
        membership: null,
        couponCode: null,
        expiresAt: null,
        conditions: [],
        sourceVerified: false,
        status: "UNVERIFIED",
        reasons: ["USER_BANK_UNKNOWN", "SOURCE_NOT_VERIFIED"],
        benefitPaise: 150_000,
        appliesToPayable: false,
      },
    ],
    fees: [],
    emi: [],
    flags: [],
    history: {
      currentPaise: 2_499_900,
      firstObservedAt: NOW_ISO,
      observations: 40,
      windows: [
        {
          days: 7,
          observations: 7,
          lowestPaise: 2_499_900,
          lowestObservedAt: NOW_ISO,
          highestPaise: 2_699_900,
          averagePaise: 2_650_000,
          coverageBp: 10_000,
          currentIsLowest: true,
        },
        {
          days: 30,
          observations: 30,
          lowestPaise: 2_499_900,
          lowestObservedAt: NOW_ISO,
          highestPaise: 2_699_900,
          averagePaise: 2_690_000,
          coverageBp: 10_000,
          currentIsLowest: true,
        },
        {
          days: 90,
          observations: 40,
          lowestPaise: 2_499_900,
          lowestObservedAt: NOW_ISO,
          highestPaise: 2_699_900,
          averagePaise: 2_690_000,
          coverageBp: 4_400,
          currentIsLowest: true,
        },
        {
          days: 180,
          observations: 40,
          lowestPaise: 2_499_900,
          lowestObservedAt: NOW_ISO,
          highestPaise: 2_699_900,
          averagePaise: 2_690_000,
          coverageBp: 2_200,
          currentIsLowest: true,
        },
      ],
      historicalAveragePaise: 2_690_000,
      previousPricePaise: 2_699_900,
      previousObservedAt: NOW_ISO,
      changeFromPreviousBp: -740,
      changeVs30DayAverageBp: -707,
      trend: "FALLING",
      lowestClaim: {
        kind: "LOWEST_IN_WINDOW",
        days: 30,
        text: "Lowest observed price in the last 30 days",
      },
      recentDrop: null,
    },
    assessment: {
      sellingPricePaise: 2_499_900,
      effectivePricePaise: 2_499_900,
      mrpPaise: 2_999_900,
      claimedDiscountBp: 1_666,
      claimedSavingsPaise: 500_000,
      genuineDiscountBp: 0,
      verdict: "INSUFFICIENT_HISTORY",
      history: { points: 3, spanDays: 2, minPaise: null, medianPaise: null, maxPaise: null },
      reasons: [],
    },
    ...over,
  };
}

const source = (n: number, isSample = false) => ({
  id: `30000000-0000-7000-8000-00000000000${n}`,
  slug: `mock_${n}`,
  name: `Mock Store ${n}`,
  isSample,
});

export function offer(n: number, sellingPricePaise: number) {
  return {
    id: `00000000-0000-7000-8000-00000000000${n}`,
    productId: "10000000-0000-7000-8000-000000000001",
    variantId: "20000000-0000-7000-8000-000000000001",
    source: source(n),
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productUrl: `https://mock-${n}.example.com/p/1`,
    sellerName: null,
    mrpPaise: 2_999_900,
    sellingPricePaise,
    shippingPaise: 0,
    currency: "INR" as const,
    discountBasisPoints: 1_666,
    stockStatus: "IN_STOCK" as const,
    offerConditions: {},
    observedAt: NOW_ISO,
    sourceUpdatedAt: null,
    isStale: false,
    matchMethod: "IDENTIFIER" as const,
    matchConfidence: 10_000,
  };
}

export function searchResult(rank = 1): SearchResultView {
  return {
    rank,
    score: 8_200,
    explanation: "Score 8200/10000 on Mock Store 1 (₹24,999 delivered).",
    pricePaiseAtSearch: 2_499_900,
    mrpPaiseAtSearch: 2_999_900,
    offer: offer(1, 2_499_900),
    product: {
      id: "10000000-0000-7000-8000-000000000001",
      name: "Acme Nova 7 5G",
      brand: "Acme",
      imageUrl: null,
    },
    pricing: pricing(),
  };
}

export function productPricing(): ProductPricingView {
  const a = offer(1, 2_499_900);
  const b = offer(2, 2_449_900);
  return {
    productId: a.productId,
    variantId: a.variantId,
    offers: [
      {
        offer: b,
        pricing: pricing({
          offerId: b.id,
          prices: {
            ...pricing().prices,
            basePaise: 2_449_900,
            deliveredPaise: 2_453_900,
            shippingPaise: 4_000,
            bestVerifiedPayablePaise: 2_453_900,
          },
        }),
      },
      { offer: a, pricing: pricing({ offerId: a.id }) },
    ],
    comparison: {
      cheapestDelivered: b.id,
      cheapestVerifiedPayable: b.id,
      highestDirectDiscount: b.id,
      sameVariant: true,
      notes: [],
    },
  };
}

export function searchDetail(over: Partial<SearchDetail> = {}): SearchDetail {
  return {
    id: "40000000-0000-7000-8000-000000000001",
    query: "Find a smartphone under ₹35,000 with 8GB RAM",
    filters: {},
    status: "RUNNING",
    resultCount: 0,
    createdAt: NOW_ISO,
    completedAt: null,
    sourceRuns: [],
    interpretation: null,
    clarificationQuestion: null,
    summary: null,
    warnings: [],
    agentRun: null,
    ...over,
  };
}
