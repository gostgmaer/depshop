/**
 * User-owned shopping searches. Execution is asynchronous: the API creates a
 * PENDING Search and enqueues a BullMQ job; apps/worker runs it and writes
 * per-source runs and ranked results. No marketplace request ever runs inside
 * the HTTP request.
 *
 * Every query is scoped by the authenticated userId; another user's search is
 * reported as "not found".
 */
import type { PricingResult, PricingService } from "@dealmind/intelligence";
import type { PrismaClient } from "@dealmind/db";
import { type JobQueues, QueueName, searchCancelKey } from "@dealmind/queue";
import {
  AppError,
  type CreateSearchInput,
  ErrorCode,
  type PageQuery,
  type SearchResultsQuery,
  paginationOf,
  type SearchStatusValue,
  TERMINAL_SEARCH_STATUSES,
  paiseFromDb,
  paiseFromDbOrNull,
} from "@dealmind/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { CacheService } from "../../lib/cache.js";
import { iso, paginated } from "../../utils/http.js";
import { toOfferView } from "../catalog/catalog-service.js";
import type { PlanService } from "../subscriptions/plan-service.js";

const TERMINAL = new Set<string>(TERMINAL_SEARCH_STATUSES);

export interface SearchServiceOptions {
  redis: Redis;
  redisPrefix: string;
  /** Best-effort cancellation of a running agent execution (Python agent API). */
  cancelExecution?: (executionId: string) => Promise<void>;
  /** Current deterministic pricing for each result's offer. */
  pricing?: PricingService;
}
const RESULTS_CACHE_TTL = 300;
/** An identical search submitted again within this window returns the running one. */
const DUPLICATE_WINDOW_MS = 30_000;
/** Upper bound of stored results re-ordered in memory (the agent stores at most 100). */
const MAX_SORTED_RESULTS = 200;

/** Stable JSON (sorted keys) so equal filters compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

type ResultItem = {
  rank: number;
  pricing: PricingResult | null;
  pricePaiseAtSearch: number;
  product: { launchDate: string | null };
};

/**
 * Re-orders results for display. Prices are current delivered prices (the
 * price at search when it can no longer be priced); discounts count only when
 * the pricing engine verified the MRP. Ties keep the stored rank.
 */
export function sortResults<T extends ResultItem>(
  items: T[],
  sort: SearchResultsQuery["sort"],
): T[] {
  const price = (i: T) => i.pricing?.prices.deliveredPaise ?? i.pricePaiseAtSearch;
  const discount = (i: T) =>
    i.pricing?.directDiscount.status === "OK" ? (i.pricing.directDiscount.percentBp ?? 0) : -1;
  const launch = (i: T) => (i.product.launchDate ? Date.parse(i.product.launchDate) : -Infinity);
  const by: Record<SearchResultsQuery["sort"], (a: T, b: T) => number> = {
    rank: () => 0,
    price_asc: (a, b) => price(a) - price(b),
    discount_desc: (a, b) => discount(b) - discount(a),
    newest: (a, b) => (launch(b) === launch(a) ? 0 : launch(b) > launch(a) ? 1 : -1),
  };
  return [...items].sort((a, b) => by[sort](a, b) || a.rank - b.rank);
}

/** The ranking mode used: the user's explicit choice, else the agent's validated filters. */
function rankingOf(filters: unknown, intent: unknown) {
  const chosen = (filters as { sortMode?: unknown } | null)?.sortMode;
  if (typeof chosen === "string") return { mode: chosen, chosenBy: "user" as const };
  const i = intent as {
    filters?: { sort_mode?: unknown; sortMode?: unknown };
    sort_mode?: unknown;
    sortMode?: unknown;
  } | null;
  const ai = i?.filters?.sort_mode ?? i?.filters?.sortMode ?? i?.sort_mode ?? i?.sortMode;
  return typeof ai === "string" ? { mode: ai, chosenBy: "ai" as const } : null;
}

type SearchRow = {
  id: string;
  query: string;
  filters: unknown;
  status: SearchStatusValue;
  createdAt: Date;
  completedAt: Date | null;
  _count: { results: number };
};

function toSearchView(s: SearchRow) {
  return {
    id: s.id,
    query: s.query,
    filters: (s.filters ?? {}) as Record<string, unknown>,
    status: s.status,
    resultCount: s._count.results,
    createdAt: s.createdAt.toISOString(),
    completedAt: iso(s.completedAt),
  };
}

export class SearchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: JobQueues,
    private readonly plans: PlanService,
    private readonly cache: CacheService,
    private readonly log: Pick<FastifyBaseLogger, "error">,
    private readonly offerStaleAfterMs = 24 * 3_600_000,
    private readonly options?: SearchServiceOptions,
  ) {}

  /**
   * Cancels a search the user owns. A PENDING search is cancelled at once;
   * a RUNNING one is flagged (the worker and agent stop at the next step)
   * and the agent is asked to cancel. Finished searches are unchanged.
   */
  async cancel(userId: string, id: string) {
    const search = await this.owned(userId, id);
    if (TERMINAL.has(search.status)) return toSearchView(search);
    if (this.options) {
      await this.options.redis.set(searchCancelKey(this.options.redisPrefix, id), "1", "EX", 3_600);
    }
    if (search.status === "PENDING") {
      await this.prisma.search.updateMany({
        where: { id, userId, status: "PENDING" },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
    } else {
      const run = await this.prisma.agentRun.findFirst({
        where: { searchId: id, userId, status: "RUNNING" },
        orderBy: { startedAt: "desc" },
      });
      if (run && this.options?.cancelExecution) {
        await this.options
          .cancelExecution(run.id)
          .catch((err: unknown) =>
            this.log.error({ err, searchId: id }, "agent cancellation request failed"),
          );
      }
    }
    return toSearchView(await this.owned(userId, id));
  }

  /** Ownership check for the progress stream. */
  async assertOwned(userId: string, id: string): Promise<{ status: string }> {
    const s = await this.prisma.search.findFirst({
      where: { id, userId },
      select: { status: true },
    });
    if (!s) throw AppError.notFound("Search");
    return s;
  }

  async create(userId: string, input: CreateSearchInput) {
    // A double click or a retried request must not start (and count) a second search.
    const recent = await this.prisma.search.findMany({
      where: {
        userId,
        query: input.query,
        status: { in: ["PENDING", "RUNNING"] },
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { _count: { select: { results: true } } },
    });
    const wanted = canonical(input.filters ?? {});
    const duplicate = recent.find((r) => canonical(r.filters ?? {}) === wanted);
    if (duplicate) return toSearchView(duplicate);

    await this.plans.assertWithinLimit(userId, "searchesPerDay");
    const search = await this.prisma.search.create({
      data: { userId, query: input.query, filters: input.filters ?? {}, status: "PENDING" },
      include: { _count: { select: { results: true } } },
    });
    await this.prisma.usageRecord.create({ data: { userId, metric: "SEARCH" } });

    try {
      await this.jobs.enqueue(QueueName.shoppingSearch, { searchId: search.id, userId });
    } catch (err) {
      // Never leave a search waiting for a job that does not exist.
      this.log.error({ err, searchId: search.id }, "Failed to enqueue search job");
      await this.prisma.search.update({
        where: { id: search.id },
        data: { status: "FAILED", completedAt: new Date() },
      });
      throw new AppError(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        "Search could not be started. Please retry shortly.",
      );
    }
    return toSearchView(search);
  }

  async list(userId: string, q: PageQuery) {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.search.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { _count: { select: { results: true } } },
      }),
      this.prisma.search.count({ where }),
    ]);
    return paginated(rows.map(toSearchView), paginationOf(q, total));
  }

  private async owned(userId: string, id: string) {
    const search = await this.prisma.search.findFirst({
      where: { id, userId },
      include: {
        _count: { select: { results: true } },
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          include: { source: { select: { id: true, slug: true, name: true, isSample: true } } },
        },
      },
    });
    if (!search) throw AppError.notFound("Search");
    return search;
  }

  private runs(search: Awaited<ReturnType<SearchService["owned"]>>) {
    return search.sourceRuns.map((r) => ({
      source: r.source,
      status: r.status,
      resultCount: r.resultCount,
      durationMs: r.durationMs,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
    }));
  }

  async get(userId: string, id: string) {
    const search = await this.owned(userId, id);
    // Latest agent run of this search, owned by the same user (composite FK).
    const run = await this.prisma.agentRun.findFirst({
      where: { searchId: id, userId },
      orderBy: { startedAt: "desc" },
    });
    const output = (run?.output ?? {}) as {
      response?: string | null;
      clarificationQuestion?: string | null;
      warnings?: string[];
    };
    return {
      ...toSearchView(search),
      sourceRuns: this.runs(search),
      interpretation: (search.intent ?? null) as Record<string, unknown> | null,
      clarificationQuestion: output.clarificationQuestion ?? null,
      summary: output.response ?? null,
      warnings: Array.isArray(output.warnings) ? output.warnings : [],
      ranking: rankingOf(search.filters, search.intent),
      agentRun: run
        ? {
            id: run.id,
            status: run.status,
            provider: run.provider,
            model: run.model,
            durationMs: run.durationMs,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            startedAt: run.startedAt.toISOString(),
            finishedAt: iso(run.finishedAt),
          }
        : null,
    };
  }

  async sourceRuns(userId: string, id: string) {
    return this.runs(await this.owned(userId, id));
  }

  async results(userId: string, id: string, q: SearchResultsQuery) {
    const search = await this.owned(userId, id);
    const sorted = q.sort !== "rank";
    const load = async () => {
      const rows = await this.prisma.searchResult.findMany({
        where: { searchId: id, userId },
        orderBy: { rank: "asc" },
        // Another order needs the whole (bounded) list; the stored rank pages directly.
        skip: sorted ? 0 : (q.page - 1) * q.pageSize,
        take: sorted ? MAX_SORTED_RESULTS : q.pageSize,
        include: {
          offer: {
            include: {
              source: { select: { id: true, slug: true, name: true, isSample: true } },
              product: {
                select: {
                  id: true,
                  name: true,
                  brand: true,
                  imageUrl: true,
                  modelNumber: true,
                  launchDate: true,
                },
              },
              variant: { select: { attributes: true } },
            },
          },
        },
      });
      return {
        items: rows.map((r) => ({
          rank: r.rank,
          score: r.score,
          explanation: r.explanation,
          pricePaiseAtSearch: paiseFromDb(r.pricePaiseAtSearch),
          mrpPaiseAtSearch: paiseFromDbOrNull(r.mrpPaiseAtSearch),
          offer: toOfferView(r.offer, false),
          product: {
            id: r.offer.product.id,
            name: r.offer.product.name,
            brand: r.offer.product.brand,
            imageUrl: r.offer.product.imageUrl,
            modelNumber: r.offer.product.modelNumber,
            launchDate: iso(r.offer.product.launchDate),
          },
          variantAttributes: (r.offer.variant.attributes ?? {}) as Record<string, unknown>,
        })),
        pagination: paginationOf(q, search._count.results),
      };
    };
    // Finished results never change: cache them, keyed by the owner's id.
    const page = TERMINAL.has(search.status)
      ? await this.cache.getOrSet(
          this.cache.userKey(
            userId,
            "search",
            id,
            "results",
            sorted ? "all" : `${q.page}:${q.pageSize}`,
          ),
          RESULTS_CACHE_TTL,
          load,
        )
      : await load();
    // Staleness and current pricing are evaluated now, never frozen into the cache.
    const now = Date.now();
    const priced = this.options?.pricing
      ? new Map(
          (await this.options.pricing.calculate(page.items.map((i) => i.offer.id))).map((p) => [
            p.offerId,
            p,
          ]),
        )
      : new Map<string, PricingResult>();
    const items = page.items.map((item) => ({
      ...item,
      pricing: priced.get(item.offer.id) ?? null,
      offer: {
        ...item.offer,
        isStale: now - new Date(item.offer.observedAt).getTime() > this.offerStaleAfterMs,
      },
    }));
    if (!sorted) return paginated(items, page.pagination);
    const start = (q.page - 1) * q.pageSize;
    return paginated(sortResults(items, q.sort).slice(start, start + q.pageSize), {
      ...page.pagination,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.ceil(page.pagination.total / q.pageSize),
    });
  }
}
