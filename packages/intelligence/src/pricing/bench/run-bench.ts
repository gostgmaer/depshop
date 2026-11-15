/* eslint-disable no-console -- CLI script: stdout is its interface */
/**
 * Pricing & ranking benchmark on SYNTHETIC data (fictional offers; nothing
 * describes a real product, price or marketplace offer).
 *
 *  1. Pure engine: calculatePricing for N offers × S snapshots each, and
 *     rankOffers for 400 candidates in every mode.
 *  2. Database path (disposable <db>_pricing_bench_test, wiped + migrated by
 *     the test setup, which refuses non-*_test or non-local databases):
 *     PricingService.candidates for 400 offers with S snapshots each, i.e.
 *     what /internal/v1/intelligence/pricing/batch and ranking/rank do.
 *
 * Usage: pnpm --filter @dealmind/intelligence bench:pricing [-- --offers 400 --snapshots 180]
 */
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@dealmind/db";
import { setupTestDatabase } from "@dealmind/db/testing";
import { rankOffers } from "../../ranking/engine.js";
import { RANKING_MODES, type RankCandidate } from "../../ranking/types.js";
import { calculatePricing } from "../engine.js";
import { PricingService } from "../service.js";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const OFFERS = arg("offers", 400);
const SNAPSHOTS = arg("snapshots", 180);
const DAY = 86_400_000;
const now = new Date();

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const ms = (x: number) => Math.round(x * 1000) / 1000;

const conditions = (i: number) => ({
  priceType: "LISTED",
  coupons: [
    { type: "COUPON", description: "₹500 off", amountPaise: 50_000, verified: i % 2 === 0 },
  ],
  bankOffers: [
    {
      type: "BANK_OFFER",
      description: "10% off up to ₹1,500",
      percentBasisPoints: 1_000,
      maxAmountPaise: 150_000,
      minTransactionPaise: 1_000_000,
      eligibleBanks: ["Bench Bank"],
      cardTypes: ["CREDIT"],
      verified: true,
    },
  ],
  cashback: [
    { type: "CASHBACK", description: "₹250 cashback", amountPaise: 25_000, verified: true },
  ],
  emi: [{ tenureMonths: 6, noCostClaimed: true, processingFeePaise: 19_900 }],
  fees: [{ type: "PLATFORM", description: "Platform fee", amountPaise: 300, mandatory: true }],
});

function snapshots(i: number) {
  return Array.from({ length: SNAPSHOTS }, (_, d) => ({
    sellingPricePaise: 2_000_000 + ((i * 37 + d * 11) % 50) * 1_000,
    observedAt: new Date(now.getTime() - (SNAPSHOTS - d) * DAY),
  }));
}

async function main(): Promise<void> {
  // 1. Pure engine.
  const eligibility = { banks: ["Bench Bank"], cardTypes: ["CREDIT" as const] };
  const inputs = Array.from({ length: OFFERS }, (_, i) => ({
    offerId: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    sellingPricePaise: 1_900_000 + (i % 100) * 1_000,
    mrpPaise: 2_999_900,
    shippingPaise: i % 3 === 0 ? 4_000 : 0,
    offerConditions: conditions(i),
    observedAt: now,
    stockStatus: "IN_STOCK" as const,
    launchDate: new Date(now.getTime() - (i % 400) * DAY),
    snapshots: snapshots(i),
  }));
  const perOffer: number[] = [];
  const t0 = performance.now();
  const priced = inputs.map((inp) => {
    const t = performance.now();
    const r = calculatePricing(inp, eligibility, now);
    perOffer.push(performance.now() - t);
    return r;
  });
  const pricingMs = performance.now() - t0;
  const candidates: RankCandidate[] = priced.map((p, i) => ({
    offerId: p.offerId,
    productId: `10000000-0000-7000-8000-${String(i % 50).padStart(12, "0")}`,
    variantId: `20000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    sourceSlug: `bench_${i % 5}`,
    sourceName: `Bench store ${i % 5}`,
    title: `Benchtron Aero ${i % 50} 5G (8GB RAM, 128GB Storage)`,
    productName: `Benchtron Aero ${i % 50} 5G`,
    brand: "Benchtron",
    categoryPath: ["smartphones"],
    stockStatus: "IN_STOCK",
    launchDate: inputs[i]!.launchDate,
    variantAttributes: { ram_gb: 8, storage_gb: 128 },
    specifications: {},
    pricing: p,
  }));
  const ranking: Record<string, number> = {};
  for (const mode of RANKING_MODES) {
    const t = performance.now();
    for (let k = 0; k < 10; k++) {
      rankOffers(candidates, {
        mode,
        query: "benchtron aero 5g",
        preferredSpecs: { ram_gb: 8 },
        now,
      });
    }
    ranking[mode] = ms((performance.now() - t) / 10);
  }

  // 2. Database path.
  process.env.TEST_DATABASE_SUFFIX = "_pricing_bench_test";
  const url = await setupTestDatabase();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  let db: Record<string, number> = {};
  try {
    const source = await prisma.shoppingSource.create({
      data: {
        slug: "bench_source",
        name: "Benchmark source (synthetic data)",
        domain: "bench.example.com",
        baseUrl: "https://bench.example.com",
        integrationKind: "PARTNER",
        status: "ACTIVE",
        isSample: true,
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < OFFERS; i++) {
      const product = await prisma.product.create({
        data: {
          name: `Benchtron Aero ${i}`,
          normalizedName: `benchtron aero ${i}`,
          brand: "Benchtron",
        },
      });
      const variant = await prisma.productVariant.create({
        data: { productId: product.id, variantKey: `v${i}`, attributes: { ram_gb: 8 } },
      });
      const offer = await prisma.productOffer.create({
        data: {
          productId: product.id,
          variantId: variant.id,
          sourceId: source.id,
          externalId: `bench-${i}`,
          productUrl: `https://bench.example.com/p/${i}`,
          title: `Benchtron Aero ${i}`,
          sellingPricePaise: BigInt(inputs[i]!.sellingPricePaise),
          mrpPaise: 2_999_900n,
          shippingPaise: 0n,
          stockStatus: "IN_STOCK",
          offerConditions: conditions(i),
        },
      });
      ids.push(offer.id);
      await prisma.priceSnapshot.createMany({
        data: snapshots(i).map((s) => ({
          offerId: offer.id,
          sellingPricePaise: BigInt(s.sellingPricePaise),
          stockStatus: "IN_STOCK" as const,
          observedAt: s.observedAt,
        })),
      });
    }
    await prisma.$executeRawUnsafe("ANALYZE");
    const service = new PricingService(prisma);
    const runs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      await service.candidates(ids, eligibility);
      runs.push(performance.now() - t);
    }
    const tr = performance.now();
    await service.rank(ids.slice(0, 100), { mode: "best_value" });
    db = {
      batch400p50ms: ms(pct(runs, 50)),
      batch400maxMs: ms(Math.max(...runs)),
      rank100ms: ms(performance.now() - tr),
    };
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    JSON.stringify(
      {
        data: "synthetic (fictional offers)",
        offers: OFFERS,
        snapshotsPerOffer: SNAPSHOTS,
        pureEngine: {
          calculatePricingTotalMs: ms(pricingMs),
          perOfferP50Ms: ms(pct(perOffer, 50)),
          perOfferP95Ms: ms(pct(perOffer, 95)),
          offersPerSecond: Math.round(OFFERS / (pricingMs / 1000)),
          rankOffersMsPerCall: ranking,
        },
        database: db,
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
