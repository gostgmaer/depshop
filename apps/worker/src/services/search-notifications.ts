/**
 * "Your search is ready / failed" notifications. The verified source is the
 * search's committed terminal status (COMPLETED, PARTIAL or FAILED). Only
 * searches that ran at least `minSeconds` notify — for quick searches the
 * user is still looking at the page. Cancelled searches and clarification
 * questions never notify. The dedupe key makes a re-run a no-op.
 */
import type { PrismaClient } from "@dealmind/db";
import { buildNotification, publishSignal, recordNotification } from "@dealmind/notifications";

export interface SearchNotifyDeps {
  prisma: PrismaClient;
  enqueueDelivery: (deliveryId: string, notBefore?: Date) => Promise<void>;
  realtime?: { redis: { publish(c: string, m: string): Promise<unknown> }; prefix: string };
  minSeconds: number;
  now?: () => Date;
}

export async function notifySearchFinished(
  deps: SearchNotifyDeps,
  searchId: string,
): Promise<"created" | "duplicate" | "suppressed" | "not-applicable"> {
  const now = (deps.now ?? (() => new Date()))();
  const s = await deps.prisma.search.findUnique({
    where: { id: searchId },
    select: {
      id: true,
      userId: true,
      query: true,
      status: true,
      createdAt: true,
      completedAt: true,
      _count: { select: { results: true } },
    },
  });
  if (!s || !s.completedAt) return "not-applicable";
  if (s.status !== "COMPLETED" && s.status !== "PARTIAL" && s.status !== "FAILED")
    return "not-applicable";
  if (s.completedAt.getTime() - s.createdAt.getTime() < deps.minSeconds * 1000)
    return "not-applicable";
  const draft = buildNotification({
    kind: "search.finished",
    userId: s.userId,
    searchId: s.id,
    status: s.status,
    query: s.query.slice(0, 500) || "your search",
    resultCount: s._count.results,
  });
  const r = await deps.prisma.$transaction((tx) => recordNotification(tx, draft, { now }));
  if (r.status !== "created") return r.status;
  for (const d of r.pending) await deps.enqueueDelivery(d.id, d.notBefore);
  if (deps.realtime)
    await publishSignal(deps.realtime.redis, deps.realtime.prefix, s.userId, {
      type: "created",
      id: r.notificationId,
    });
  return "created";
}
