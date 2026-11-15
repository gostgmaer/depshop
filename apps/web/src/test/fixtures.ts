/**
 * TEST FIXTURES ONLY (fictional "Acme" products and "Mock Store" sources).
 * Never imported by application code; shaped exactly like the API contracts
 * and validated against the shared Zod schemas in the tests that use them.
 */
import type {
  CategoryFiltersView,
  PriceHistory,
  ProductDetail,
  RecommendationsView,
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
      modelNumber: "AN7-5G",
      launchDate: null,
    },
    variantAttributes: { ram_gb: 8, storage_gb: 128, color: "midnight black" },
    pricing: pricing(),
  };
}

export function recommendations(cheapestId: string): RecommendationsView {
  return {
    considered: 2,
    excluded: [],
    basis:
      "Computed by the deterministic pricing and ranking engines from observed marketplace data. Affiliate commission is not an input.",
    items: [
      {
        kind: "lowest_delivered",
        offerId: cheapestId,
        productId: "10000000-0000-7000-8000-000000000001",
        variantId: "20000000-0000-7000-8000-000000000001",
        marketplace: { slug: "mock_2", name: "Mock Store 2" },
        deliveredPricePaise: 2_453_900,
        reasons: [
          "₹24,539 delivered (selling price + shipping + mandatory fees) on Mock Store 2.",
          "₹460 less than the next cheapest (Mock Store 1).",
        ],
        unavailableReason: null,
      },
      {
        kind: "highest_direct_discount",
        offerId: cheapestId,
        productId: "10000000-0000-7000-8000-000000000001",
        variantId: "20000000-0000-7000-8000-000000000001",
        marketplace: { slug: "mock_2", name: "Mock Store 2" },
        deliveredPricePaise: 2_453_900,
        reasons: ["16.66% off its stated MRP of ₹29,999 on Mock Store 2."],
        unavailableReason: null,
      },
      {
        kind: "best_value",
        offerId: cheapestId,
        productId: "10000000-0000-7000-8000-000000000001",
        variantId: "20000000-0000-7000-8000-000000000001",
        marketplace: { slug: "mock_2", name: "Mock Store 2" },
        deliveredPricePaise: 2_453_900,
        reasons: ["Highest best-value score (8200/10000) among 2 offers."],
        unavailableReason: null,
      },
      {
        kind: "best_history_position",
        offerId: null,
        productId: null,
        variantId: null,
        marketplace: null,
        deliveredPricePaise: null,
        reasons: [],
        unavailableReason:
          "Not enough price history (at least 3 observations covering half of the last 90 days) to compare positions.",
      },
    ],
  };
}

/** Two current offers; with `stale`, a cheaper offer last seen 3 days ago (never "lowest"). */
export function productPricing(opts: { stale?: boolean } = {}): ProductPricingView {
  const a = offer(1, 2_499_900);
  const b = offer(2, 2_449_900);
  const old = {
    ...offer(3, 1_999_900),
    observedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    isStale: true,
  };
  return {
    productId: a.productId,
    variantId: a.variantId,
    recommendations: recommendations(b.id),
    offers: [
      ...(opts.stale
        ? [
            {
              offer: old,
              pricing: pricing({
                offerId: old.id,
                observedAt: old.observedAt,
                prices: {
                  ...pricing().prices,
                  basePaise: 1_999_900,
                  deliveredPaise: 1_999_900,
                  bestVerifiedPayablePaise: 1_999_900,
                },
              }),
            },
          ]
        : []),
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
    ranking: null,
    ...over,
  };
}

/** A result for another variant of the same fictional product (different RAM/storage). */
export function searchResultVariant(
  rank: number,
  n: number,
  attrs: Record<string, unknown>,
  price: number,
): SearchResultView {
  const base = searchResult(rank);
  const id = `00000000-0000-7000-8000-00000000010${n}`;
  return {
    ...base,
    offer: {
      ...base.offer,
      id,
      variantId: `20000000-0000-7000-8000-00000000000${n}`,
      title: `Acme Nova 7 5G (${Number(attrs.ram_gb)}GB RAM, ${Number(attrs.storage_gb)}GB Storage)`,
      sellingPricePaise: price,
      mrpPaise: price + 500_000,
    },
    variantAttributes: attrs,
    pricePaiseAtSearch: price,
    mrpPaiseAtSearch: price + 500_000,
    pricing: pricing({
      offerId: id,
      // A ₹5,000 discount off this variant's own MRP (basis points floored).
      directDiscount: {
        status: "OK",
        mrpPaise: price + 500_000,
        sellingPricePaise: price,
        amountPaise: 500_000,
        percentBp: Math.floor((500_000 * 10_000) / (price + 500_000)),
        percentText: `${(Math.floor((500_000 * 10_000) / (price + 500_000)) / 100).toFixed(2)}%`,
      },
      prices: {
        ...pricing().prices,
        basePaise: price,
        deliveredPaise: price,
        bestVerifiedPayablePaise: price,
      },
    }),
  };
}

/** Category filters as GET /categories/:slug/filters returns them (fictional data). */
export function categoryFilters(slug = "smartphones"): CategoryFiltersView {
  const category = {
    id: "30000000-0000-7000-8000-000000000001",
    slug,
    name: slug === "washing-machines" ? "Washing Machines" : "Smartphones",
    description: null,
    imageUrl: null,
    parentId: null,
  };
  return slug === "washing-machines"
    ? {
        category,
        subcategories: [],
        brands: [{ name: "Acme", count: 2 }],
        priceRange: null,
        specs: [
          {
            key: "capacity_kg",
            label: "Capacity",
            productCount: 2,
            values: [
              { value: "7", label: "7 kg", count: 1 },
              { value: "8", label: "8 kg", count: 1 },
            ],
          },
        ],
        hasLaunchDates: false,
        ratingsAvailable: false,
        productCount: 2,
      }
    : {
        category,
        subcategories: [
          {
            ...category,
            id: "30000000-0000-7000-8000-000000000002",
            slug: "5g-phones",
            name: "5G phones",
            parentId: category.id,
            productCount: 2,
          },
        ],
        brands: [
          { name: "Acme", count: 3 },
          { name: "Zenith", count: 1 },
        ],
        priceRange: { minPaise: 2_000_000, maxPaise: 3_000_000 },
        specs: [
          {
            key: "ram_gb",
            label: "RAM",
            productCount: 4,
            values: [
              { value: "8 GB", label: "8 GB", count: 3 },
              { value: "12 GB", label: "12 GB", count: 1 },
            ],
          },
          {
            key: "storage_gb",
            label: "Storage",
            productCount: 4,
            values: [
              { value: "128 GB", label: "128 GB", count: 2 },
              { value: "256 GB", label: "256 GB", count: 2 },
            ],
          },
        ],
        hasLaunchDates: true,
        ratingsAvailable: false,
        productCount: 4,
      };
}

/**
 * Deterministic observations (fictional): Mock Store 1 daily for 10 days with
 * a 5-day gap, Mock Store 2 every 3 days. MRP stated by store 1 only.
 */
export function priceHistory(to = Date.now()): PriceHistory {
  const day = 86_400_000;
  const at = (d: number) => new Date(to - d * day).toISOString();
  const s1 = [20, 19, 18, 17, 11, 10, 9, 8, 1, 0].map((d, i) => ({
    offerId: "00000000-0000-7000-8000-000000000001",
    variantId: "20000000-0000-7000-8000-000000000001",
    sourceSlug: "mock_1",
    mrpPaise: 2_999_900,
    sellingPricePaise: [
      2_699_900, 2_699_900, 2_649_900, 2_649_900, 2_599_900, 2_599_900, 2_549_900, 2_549_900,
      2_499_900, 2_499_900,
    ][i]!,
    shippingPaise: 0,
    stockStatus: "IN_STOCK" as const,
    observedAt: at(d),
  }));
  const s2 = [21, 18, 15, 12, 9, 6, 3, 0].map((d, i) => ({
    offerId: "00000000-0000-7000-8000-000000000002",
    variantId: "20000000-0000-7000-8000-000000000001",
    sourceSlug: "mock_2",
    mrpPaise: null,
    sellingPricePaise: 2_449_900 + (i % 2) * 10_000,
    shippingPaise: 4_000,
    stockStatus: "IN_STOCK" as const,
    observedAt: at(d),
  }));
  const points = [...s1, ...s2].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const prices = points.map((p) => p.sellingPricePaise);
  return {
    productId: "10000000-0000-7000-8000-000000000001",
    from: at(30),
    to: at(0),
    points,
    lowestPricePaise: Math.min(...prices),
    highestPricePaise: Math.max(...prices),
    trackingSince: at(21),
    truncated: false,
  };
}

/** Fictional product detail (two variants; specifications as a marketplace states them). */
export function productDetail(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: "10000000-0000-7000-8000-000000000001",
    name: "Acme Nova 7 5G",
    brand: "Acme",
    modelNumber: "AN7-5G",
    imageUrl: null,
    category: {
      id: "70000000-0000-7000-8000-000000000001",
      slug: "smartphones",
      name: "Smartphones",
      description: null,
      imageUrl: null,
      parentId: null,
    },
    launchDate: null,
    lowestPricePaise: 2_453_900,
    offerCount: 2,
    inStock: true,
    sampleData: true,
    description: "Fictional test product.",
    manufacturer: null,
    gtin: null,
    ean: null,
    upc: null,
    specifications: { Processor: "Acme X1", Display: "6.6 inch AMOLED", Battery: "5000 mAh" },
    variants: [
      {
        id: "20000000-0000-7000-8000-000000000001",
        variantKey: "ram=8|storage=128",
        attributes: { ram_gb: 8, storage_gb: 128, color: "midnight black" },
        sku: null,
        gtin: null,
      },
      {
        id: "20000000-0000-7000-8000-000000000002",
        variantKey: "ram=12|storage=256",
        attributes: { ram_gb: 12, storage_gb: 256, color: "midnight black" },
        sku: null,
        gtin: null,
      },
    ],
    ...over,
  };
}
