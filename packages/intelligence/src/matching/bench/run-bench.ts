/* eslint-disable no-console -- CLI script: stdout is its interface */
/**
 * Matching benchmark on SYNTHETIC data (fictional "Bench…" brands; nothing
 * here describes a real product, price or marketplace).
 *
 * Runs in a disposable database (<DATABASE_URL db>_matching_bench_test, wiped
 * and migrated by the test setup, which refuses non-*_test or non-local DBs):
 *   1. imports a generated catalog through CatalogImporter (import throughput);
 *   2. matches probe listings one by one (latency p50/p95/p99) — a mix of
 *      identifier, model-number, re-worded, sibling-line and brand-new items;
 *   3. matches the same probes via MatchService.matchBatch (throughput);
 *   4. a bounded duplicate-product scan;
 *   5. EXPLAIN ANALYZE of the candidate queries (index usage).
 *
 * Usage: pnpm --filter @dealmind/intelligence bench:matching [-- --products 2000 --probes 400]
 */
import { performance } from "node:perf_hooks";
import type { SourceListing } from "@dealmind/catalog";
import { normalizeListing, normalizeText, sourceListingSchema } from "@dealmind/catalog";
import { PrismaClient } from "@dealmind/db";
import { setupTestDatabase } from "@dealmind/db/testing";
import { CatalogImporter } from "../deduplication/importer.js";
import { findDuplicateProducts } from "../deduplication/duplicates.js";
import { MatchingEngine } from "../engine.js";
import { MatchService } from "../service.js";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const PRODUCTS = arg("products", 2_000);
const PROBES = arg("probes", 400);
const SOURCE = "bench_source";

const BRANDS = ["Benchtron", "Benchvia", "Benchora", "Benchlux", "Benchmax", "Benchnova"];
const LINES = ["Aero", "Pulse", "Nimbus", "Vertex", "Orbit", "Zephyr", "Quanta", "Helix"];
const TIERS = ["", "Pro", "Lite", "Max", "Plus"];
const COLOURS = ["Midnight Black", "Ocean Blue", "Silver", "Forest Green"];

/** Valid EAN-13 from a 12-digit body. */
function ean13(body: number): string {
  const d = String(body).padStart(12, "0");
  const sum = [...d].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return d + String((10 - (sum % 10)) % 10);
}

interface Spec {
  brand: string;
  name: string;
  model: string;
  ram: number;
  storage: number;
  colour: string;
  gtin: string;
}

function catalogSpecs(n: number): Spec[] {
  const out: Spec[] = [];
  for (let i = 0; out.length < n; i++) {
    const brand = BRANDS[i % BRANDS.length]!;
    const line = LINES[Math.floor(i / BRANDS.length) % LINES.length]!;
    const gen = 1 + (Math.floor(i / (BRANDS.length * LINES.length)) % 40);
    const tier = TIERS[Math.floor(i / (BRANDS.length * LINES.length * 40)) % TIERS.length]!;
    const name = `${brand} ${line} ${gen}${tier ? ` ${tier}` : ""} 5G`;
    out.push({
      brand,
      name,
      model: `BX-${i.toString(36).toUpperCase().padStart(5, "0")}`,
      ram: [6, 8, 12][i % 3]!,
      storage: [128, 256][i % 2]!,
      colour: COLOURS[i % COLOURS.length]!,
      gtin: ean13(890_000_000_000 + i),
    });
  }
  return out;
}

let ext = 0;
const listingOf = (s: Spec, over: Partial<SourceListing> = {}): SourceListing => {
  ext += 1;
  return {
    externalId: `bench-${ext}`,
    title: `${s.name} (${s.colour}, ${s.ram}GB RAM, ${s.storage}GB Storage)`,
    productUrl: `https://bench.example.com/p/${ext}`,
    brand: s.brand,
    modelNumber: s.model,
    barcode: s.gtin,
    categorySlug: "smartphones",
    sellingPricePaise: 1_000_000 + (ext % 500) * 1_000,
    stockStatus: "IN_STOCK",
    ...over,
  };
};

type Kind = "identifier" | "model" | "reworded" | "sibling" | "new";

interface Probe {
  kind: Kind;
  listing: SourceListing;
  /** GTIN of the catalog variant this probe IS (same item), if any. */
  same?: string;
}

function probes(specs: Spec[], n: number): Probe[] {
  const kinds: Kind[] = ["identifier", "model", "reworded", "sibling", "new"];
  return Array.from({ length: n }, (_, i): Probe => {
    const kind = kinds[i % kinds.length]!;
    const s = specs[(i * 7919) % specs.length]!;
    const same = s.gtin;
    switch (kind) {
      case "identifier":
        return {
          kind,
          same,
          listing: listingOf(s, { title: `${s.name} ${s.storage} GB`, modelNumber: undefined }),
        };
      case "model":
        return { kind, same, listing: listingOf(s, { barcode: undefined }) };
      case "reworded":
        // Same product, different wording, no identifiers: title evidence only.
        return {
          kind,
          same,
          listing: listingOf(s, {
            title: `${s.name} | ${s.ram} GB RAM | ${s.storage} GB | ${s.colour}`,
            barcode: undefined,
            modelNumber: undefined,
          }),
        };
      case "sibling":
        // A neighbouring line ("Ultra"): must never auto-merge into s.
        return {
          kind,
          listing: listingOf(s, {
            title: `${s.name.replace(/ 5G$/, " Ultra 5G")} (${s.colour}, ${s.ram}GB RAM, ${s.storage}GB Storage)`,
            barcode: undefined,
            modelNumber: undefined,
          }),
        };
      default:
        return {
          kind,
          listing: listingOf(
            { ...s, name: `${s.brand} Kestrel ${i} 5G`, gtin: ean13(990_000_000_000 + i) },
            {
              modelNumber: `NEW-${i}`,
            },
          ),
        };
    }
  });
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const ms = (x: number) => Math.round(x * 100) / 100;

async function main(): Promise<void> {
  process.env.TEST_DATABASE_SUFFIX = "_matching_bench_test";
  const url = await setupTestDatabase();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.shoppingSource.create({
      data: {
        slug: SOURCE,
        name: "Benchmark source (synthetic data)",
        domain: "bench.example.com",
        baseUrl: "https://bench.example.com",
        integrationKind: "PARTNER",
        status: "ACTIVE",
        isSample: true,
      },
    });
    const engine = new MatchingEngine();
    const importer = new CatalogImporter(prisma, { engine });
    const specs = catalogSpecs(PRODUCTS);

    // 1. Import
    const t0 = performance.now();
    let created = 0;
    for (let i = 0; i < specs.length; i += 200) {
      const s = await importer.importListings(
        SOURCE,
        specs.slice(i, i + 200).map((x) => listingOf(x)),
      );
      created += s.productsCreated;
    }
    const importMs = performance.now() - t0;
    await prisma.$executeRawUnsafe(`ANALYZE`);

    // 2. Per-listing latency
    const ps = probes(specs, PROBES);
    const lat: number[] = [];
    const byKind: Record<string, Record<string, number>> = {};
    const variants = await prisma.productVariant.findMany({
      where: { gtin: { not: null } },
      select: { id: true, productId: true, gtin: true },
    });
    const byGtin = new Map(variants.map((v) => [v.gtin!, v]));
    let falseMerges = 0;
    let wrongProduct = 0;
    let wrongVariant = 0;
    let missedSame = 0;
    for (const p of ps) {
      const listing = normalizeListing(sourceListingSchema.parse(p.listing));
      const t = performance.now();
      const r = await engine.matchListing(prisma, listing, "smartphones");
      lat.push(performance.now() - t);
      (byKind[p.kind] ??= {})[r.decision] = (byKind[p.kind]![r.decision] ?? 0) + 1;
      if (!p.same && r.decision === "AUTO_MERGE") falseMerges += 1;
      if (p.same) {
        const want = byGtin.get(p.same)!;
        if (r.decision !== "AUTO_MERGE") missedSame += 1;
        else if (r.productId !== want.productId) wrongProduct += 1;
        else if (r.variantId !== want.id) wrongVariant += 1;
      }
    }

    // 3. Batch throughput (dry run with audit records)
    const service = new MatchService(prisma, engine);
    const tb = performance.now();
    for (let i = 0; i < ps.length; i += 100) {
      await service.matchBatch(ps.slice(i, i + 100).map((p) => ({ listing: p.listing })));
    }
    const batchMs = performance.now() - tb;

    // 4. Duplicate scan (bounded; records nothing)
    const td = performance.now();
    const dups = await findDuplicateProducts(prisma, engine, { limit: 500, record: false });
    const dupMs = performance.now() - td;

    // 5. Query plans
    const probe = normalizeListing(sourceListingSchema.parse(ps[2]!.listing));
    const name = normalizeText(probe.name);
    const plans: Record<string, string[]> = {};
    const explain = async (label: string, sql: string, ...params: unknown[]) => {
      const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (ANALYZE, BUFFERS OFF, COSTS OFF) ${sql}`,
        ...params,
      );
      plans[label] = rows.map((r) => r["QUERY PLAN"]);
    };
    await explain(
      "fuzzy (pg_trgm %)",
      `SELECT id, similarity("normalizedName", $1) FROM "Product"
       WHERE "isActive" AND "normalizedName" % $1
         AND lower(regexp_replace(brand, '[^a-zA-Z0-9]', '', 'g')) = $2
       ORDER BY 2 DESC, id LIMIT 10`,
      name,
      probe.brandKey,
    );
    await explain(
      "identifier",
      `SELECT "productId" FROM "ProductVariant" WHERE gtin = ANY($1::text[])`,
      [specs[0]!.gtin],
    );

    const report = {
      engine: "match-v2.0",
      data: "synthetic (fictional brands)",
      catalog: { products: created, listings: specs.length },
      import: {
        ms: Math.round(importMs),
        listingsPerSecond: Math.round(specs.length / (importMs / 1000)),
      },
      matchListing: {
        probes: ps.length,
        p50ms: ms(pct(lat, 50)),
        p95ms: ms(pct(lat, 95)),
        p99ms: ms(pct(lat, 99)),
        meanMs: ms(lat.reduce((a, b) => a + b, 0) / lat.length),
      },
      matchBatch: {
        ms: Math.round(batchMs),
        listingsPerSecond: Math.round(ps.length / (batchMs / 1000)),
      },
      duplicateScan: { ms: Math.round(dupMs), pairsFlagged: dups.length },
      decisionsByProbeKind: byKind,
      accuracy: {
        falseAutoMerges: falseMerges,
        autoMergedIntoWrongProduct: wrongProduct,
        autoMergedIntoWrongVariant: wrongVariant,
        sameItemNotAutoMerged: missedSame,
      },
      plans,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
