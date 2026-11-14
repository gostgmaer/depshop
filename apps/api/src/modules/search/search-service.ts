/**
 * User-owned shopping searches. Execution is asynchronous: the API creates a
 * PENDING Search and enqueues a BullMQ job; apps/worker runs it and writes
 * per-source runs and ranked results. No marketplace request ever runs inside
 * the HTTP request.
 *
 * Every query is scoped by the authenticated userId; another user's search is
 * reported as "not found".
 */
import type { PrismaClient } from "@dealmind/db";
import { type JobQueues, QueueName } from "@dealmind/queue";
import { AppError, type CreateSearchInput, ErrorCode, type PageQuery, paginationOf } from "@dealmind/shared";
import type { FastifyBaseLogger } from "fastify";
import type { CacheService } from "../../lib/cache.js";
import { iso, paginated } from "../../utils/http.js";
import { toOfferView } from "../catalog/catalog-service.js";
import type { PlanService } from "../subscriptions/plan-service.js";

const TERMINAL = new Set(["COMPLETED", "PARTIAL", "FAILED"]);
const RESULTS_CACHE_TTL = 300;

type SearchRow = {
  id: string;
  query: string;
  filters: unknown;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
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
  ) {}

  async create(userId: string, input: CreateSearchInput) {
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
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Search could not be started. Please retry shortly.");
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
          include: { source: { select: { id: true, code: true, name: true } } },
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
    return { ...toSearchView(search), sourceRuns: this.runs(search) };
  }

  async sourceRuns(userId: string, id: string) {
    return this.runs(await this.owned(userId, id));
  }

  async results(userId: string, id: string, q: PageQuery) {
    const search = await this.owned(userId, id);
    const load = async () => {
      const rows = await this.prisma.searchResult.findMany({
        where: { searchId: id, userId },
        orderBy: { rank: "asc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          offer: {
            include: {
              source: { select: { id: true, code: true, name: true } },
              variant: {
                select: { product: { select: { id: true, title: true, brand: true, imageUrl: true } } },
              },
            },
          },
        },
      });
      return {
        items: rows.map((r) => ({
          rank: r.rank,
          score: r.score,
          explanation: r.explanation,
          pricePaiseAtSearch: r.pricePaiseAtSearch,
          mrpPaiseAtSearch: r.mrpPaiseAtSearch,
          offer: toOfferView(r.offer),
          product: r.offer.variant.product,
        })),
        pagination: paginationOf(q, search._count.results),
      };
    };
    // Finished results never change: cache them, keyed by the owner's id.
    const page = TERMINAL.has(search.status)
      ? await this.cache.getOrSet(
          this.cache.userKey(userId, "search", id, "results", q.page, q.pageSize),
          RESULTS_CACHE_TTL,
          load,
        )
      : await load();
    return paginated(page.items, page.pagination);
  }
}
