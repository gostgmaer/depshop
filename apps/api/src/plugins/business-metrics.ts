/**
 * Business and pipeline metrics for GET /metrics (Phase 21), computed at scrape
 * time from data the platform already records. Windowed counts cover the last
 * 15 minutes (indexed columns), so they are cheap and need no extra
 * instrumentation in the worker or agent. No user ids or query text appear in
 * any label.
 */
import type { MetricsStore } from "@dealmind/connectors";
import type { PrismaClient } from "@dealmind/db";

const WINDOW_MS = 15 * 60_000;
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function businessMetricsCollector(prisma: PrismaClient, connectorMetrics: MetricsStore) {
  return async (): Promise<string[]> => {
    const since = new Date(Date.now() - WINDOW_MS);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [searches, agentRuns, agentDur, tokens, deliveries, checks, webhooks, sources] =
      await Promise.all([
        prisma.search.groupBy({
          by: ["status"],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.agentRun.groupBy({
          by: ["status"],
          where: { startedAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.agentRun.aggregate({
          where: { finishedAt: { gte: since }, durationMs: { not: null } },
          _avg: { durationMs: true },
          _max: { durationMs: true },
        }),
        prisma.agentRun.aggregate({
          where: { startedAt: { gte: monthStart } },
          _sum: { inputTokens: true, outputTokens: true },
        }),
        prisma.notificationDelivery.groupBy({
          by: ["channel", "status"],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.priceCheck.groupBy({
          by: ["outcome"],
          where: { checkedAt: { gte: since } },
          _count: { _all: true },
          _avg: { durationMs: true },
        }),
        prisma.billingEvent.groupBy({
          by: ["processingStatus"],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.shoppingSource.findMany({
          select: { id: true, slug: true, status: true, health: true },
        }),
      ]);
    const out: string[] = [];
    const gauge = (name: string, help: string, rows: [Record<string, string>, number][]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, v] of rows) {
        const l = Object.entries(labels)
          .map(([k, x]) => `${k}="${esc(x)}"`)
          .join(",");
        out.push(`${name}${l ? `{${l}}` : ""} ${v}`);
      }
    };
    gauge(
      "dealmind_searches_15m",
      "Searches created in the last 15 minutes by current status.",
      searches.map((s) => [{ status: s.status }, s._count._all]),
    );
    gauge(
      "dealmind_agent_runs_15m",
      "Agent runs started in the last 15 minutes by status.",
      agentRuns.map((a) => [{ status: a.status }, a._count._all]),
    );
    gauge("dealmind_agent_run_duration_ms_15m", "Agent run duration over the last 15 minutes.", [
      [{ stat: "avg" }, Math.round(agentDur._avg.durationMs ?? 0)],
      [{ stat: "max" }, agentDur._max.durationMs ?? 0],
    ]);
    gauge("dealmind_llm_tokens_month", "LLM tokens used by the agent this calendar month (UTC).", [
      [{ kind: "input" }, tokens._sum.inputTokens ?? 0],
      [{ kind: "output" }, tokens._sum.outputTokens ?? 0],
    ]);
    gauge(
      "dealmind_notification_deliveries_15m",
      "Notification deliveries created in the last 15 minutes by channel and status.",
      deliveries.map((d) => [{ channel: d.channel, status: d.status }, d._count._all]),
    );
    gauge(
      "dealmind_price_checks_15m",
      "Price-tracking checks in the last 15 minutes by outcome.",
      checks.map((c) => [{ outcome: c.outcome }, c._count._all]),
    );
    gauge(
      "dealmind_payment_webhooks_15m",
      "Payment-service webhook events received in the last 15 minutes by processing status.",
      webhooks.map((w) => [{ processing_status: w.processingStatus }, w._count._all]),
    );
    gauge(
      "dealmind_source_up",
      "Marketplace source: 1 when ACTIVE and HEALTHY (labels carry status and health).",
      sources.map((s) => [
        { source: s.slug, status: s.status, health: s.health },
        s.status === "ACTIVE" && s.health === "HEALTHY" ? 1 : 0,
      ]),
    );
    const conn = await Promise.all(
      sources.map(async (s) => ({
        slug: s.slug,
        m: await connectorMetrics.read(s.id).catch(() => null),
      })),
    );
    gauge(
      "dealmind_connector_requests",
      "Connector requests by outcome (cumulative, from the connector metrics store).",
      conn.flatMap(({ slug, m }) =>
        m
          ? ([
              [{ source: slug, outcome: "success" }, m.successes],
              [{ source: slug, outcome: "failure" }, m.failures],
              [{ source: slug, outcome: "timeout" }, m.timeouts],
              [{ source: slug, outcome: "rate_limited" }, m.rateLimitEvents],
            ] as [Record<string, string>, number][])
          : [],
      ),
    );
    gauge(
      "dealmind_connector_latency_ms_avg",
      "Average connector request latency.",
      conn.flatMap(({ slug, m }) =>
        m?.averageLatencyMs != null
          ? ([[{ source: slug }, m.averageLatencyMs]] as [Record<string, string>, number][])
          : [],
      ),
    );
    return out;
  };
}
