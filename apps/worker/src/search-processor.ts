/**
 * Shopping-search job processor.
 *
 *  1. Re-checks ownership (the job's user must own the search); terminal
 *     searches are left untouched (idempotent).
 *  2. Runs the parallel connector executor over every eligible source.
 *  3. Persists the shared data through the catalog importer (normalize →
 *     match → offer upsert → price history). Indicative (discovery) prices
 *     are never stored as offers and never shown as results.
 *  4. Writes one SearchSourceRun per source (SUCCEEDED / FAILED / TIMED_OUT /
 *     SKIPPED with the reason) and the user's ranked SearchResults.
 *  5. Status: COMPLETED (all searched sources ok, or none eligible),
 *     PARTIAL (some failed), FAILED (all failed). Nothing is fabricated.
 *
 * Ranking here is a simple deterministic baseline (text relevance, then
 * price); the full ranking engine is Phase 4.
 */
import type { CatalogImporter } from "@dealmind/catalog";
import type { ParallelSearchExecutor, SearchExecution } from "@dealmind/connectors";
import { normalizeQuery, toSourceListing } from "@dealmind/connectors";
import type { PrismaClient } from "@dealmind/db";
import { type ShoppingSearchJob, shoppingSearchJob } from "@dealmind/queue";
import { searchFilters } from "@dealmind/shared";

export type SearchOutcome = "missing" | "already-finished" | SearchExecution["status"];

export interface SearchProcessorDeps {
  prisma: PrismaClient;
  executor: ParallelSearchExecutor;
  importer: CatalogImporter;
}

const TERMINAL = new Set(["COMPLETED", "PARTIAL", "FAILED"]);
const MAX_RESULTS = 100;

/** Share of query tokens found in the title, in basis points (0–10000). */
export function relevanceScore(query: string, title: string): number {
  const tokens = [
    ...new Set(
      normalizeQuery(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 1),
    ),
  ];
  if (!tokens.length) return 0;
  const hay = normalizeQuery(title);
  return Math.floor((tokens.filter((t) => hay.includes(t)).length * 10_000) / tokens.length);
}

export async function processShoppingSearch(
  deps: SearchProcessorDeps,
  payload: unknown,
): Promise<SearchOutcome> {
  const { prisma, executor, importer } = deps;
  const job: ShoppingSearchJob = shoppingSearchJob.parse(payload);
  const search = await prisma.search.findFirst({ where: { id: job.searchId, userId: job.userId } });
  if (!search) return "missing";
  if (TERMINAL.has(search.status)) return "already-finished";
  await prisma.search.update({ where: { id: search.id }, data: { status: "RUNNING" } });

  const parsedFilters = searchFilters.safeParse(search.filters ?? {});
  const f = parsedFilters.success ? parsedFilters.data : {};
  const execution = await executor.run(
    {
      query: search.query,
      ...(f.category ? { category: f.category } : {}),
      ...(f.brands ? { brands: f.brands } : {}),
      ...(f.minPricePaise !== undefined ? { minPricePaise: f.minPricePaise } : {}),
      ...(f.maxPricePaise !== undefined ? { maxPricePaise: f.maxPricePaise } : {}),
      limit: 20,
    },
    f.sourceSlugs ? { only: f.sourceSlugs } : {},
  );

  // Persist offers per successful source through the catalog importer.
  const offers: { offerId: string; title: string; price: number; mrp: number | null }[] = [];
  for (const run of execution.sources) {
    if (run.status !== "SUCCEEDED" || run.items.length === 0) continue;
    const storable = run.items.filter((i) => i.priceType !== "INDICATIVE");
    if (!storable.length) continue;
    const summary = await importer.importListings(
      run.sourceId,
      storable.map((i) => toSourceListing(i, execution.request.category)),
    );
    for (const o of summary.outcomes) {
      if (o.status !== "imported") continue;
      const item = storable[o.index]!;
      offers.push({
        offerId: o.offerId,
        title: item.title,
        price: item.sellingPricePaise,
        mrp: item.mrpPaise ?? null,
      });
    }
  }

  const ranked = [...new Map(offers.map((o) => [o.offerId, o])).values()]
    .filter(
      (o) =>
        (f.minPricePaise === undefined || o.price >= f.minPricePaise) &&
        (f.maxPricePaise === undefined || o.price <= f.maxPricePaise),
    )
    .map((o) => ({ ...o, score: relevanceScore(search.query, o.title) }))
    .sort((a, b) => b.score - a.score || a.price - b.price || a.offerId.localeCompare(b.offerId))
    .slice(0, MAX_RESULTS);

  const status = execution.status === "NO_SOURCES" ? "COMPLETED" : execution.status;
  await prisma.$transaction([
    prisma.searchSourceRun.deleteMany({ where: { searchId: search.id } }),
    prisma.searchResult.deleteMany({ where: { searchId: search.id } }),
    prisma.searchSourceRun.createMany({
      data: execution.sources.map((s) => ({
        userId: search.userId,
        searchId: search.id,
        sourceId: s.sourceDbId,
        status: s.status,
        resultCount: s.resultCount,
        durationMs: s.durationMs,
        errorCode: s.errorCode ?? null,
        errorMessage: s.errorMessage ?? null,
      })),
    }),
    prisma.searchResult.createMany({
      data: ranked.map((r, i) => ({
        userId: search.userId,
        searchId: search.id,
        offerId: r.offerId,
        rank: i + 1,
        score: r.score,
        pricePaiseAtSearch: BigInt(r.price),
        mrpPaiseAtSearch: r.mrp === null ? null : BigInt(r.mrp),
        explanation: `Text relevance ${(r.score / 100).toFixed(0)}%, then lowest listed price`,
      })),
    }),
    prisma.search.update({ where: { id: search.id }, data: { status, completedAt: new Date() } }),
  ]);
  return execution.status;
}
