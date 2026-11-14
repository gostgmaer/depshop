/**
 * Shopping-search job processor.
 *
 * Phase 2 state, stated plainly: no marketplace connector exists yet (the
 * connector registry is Phase 3), so no source can actually be queried. The
 * processor therefore records an explicit SKIPPED run (`NO_CONNECTOR`) for
 * every ACTIVE source and completes the search with zero results. It never
 * fabricates results. Idempotent: terminal searches are left untouched.
 */
import type { PrismaClient } from "@dealmind/db";
import { type ShoppingSearchJob, shoppingSearchJob } from "@dealmind/queue";

export type SearchOutcome = "missing" | "already-finished" | "completed";

const TERMINAL = new Set(["COMPLETED", "PARTIAL", "FAILED"]);

export async function processShoppingSearch(
  prisma: PrismaClient,
  payload: unknown,
): Promise<SearchOutcome> {
  const job: ShoppingSearchJob = shoppingSearchJob.parse(payload);
  // Ownership is re-checked: the search must belong to the job's user.
  const search = await prisma.search.findFirst({ where: { id: job.searchId, userId: job.userId } });
  if (!search) return "missing";
  if (TERMINAL.has(search.status)) return "already-finished";

  await prisma.search.update({ where: { id: search.id }, data: { status: "RUNNING" } });
  const sources = await prisma.shoppingSource.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  await prisma.$transaction([
    ...sources.map((s) =>
      prisma.searchSourceRun.upsert({
        where: { searchId_sourceId: { searchId: search.id, sourceId: s.id } },
        create: {
          userId: search.userId,
          searchId: search.id,
          sourceId: s.id,
          status: "SKIPPED",
          durationMs: 0,
          errorCode: "NO_CONNECTOR",
          errorMessage: "No authorized connector is implemented for this source yet",
        },
        update: {},
      }),
    ),
    prisma.search.update({
      where: { id: search.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    }),
  ]);
  return "completed";
}
