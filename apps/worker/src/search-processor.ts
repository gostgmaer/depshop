/**
 * Shopping-search job processor (TypeScript worker → Python agent).
 *
 *  1. Re-checks ownership (the job's user must own the search). Finished or
 *     cancelled searches are left untouched (idempotent).
 *  2. Reuses the RUNNING AgentRun of this search on a retry (stable execution
 *     id = LangGraph thread id, so the agent resumes from its checkpoint),
 *     otherwise creates one.
 *  3. Signs a short-lived user context and asks the agent to run the graph.
 *     The agent persists results through the internal API (which re-checks
 *     ownership); this worker only supervises: polling, timeout, cancellation.
 *  4. Failures: retried by BullMQ while attempts remain; on the final attempt
 *     the search and run are marked FAILED with the reason. Nothing is
 *     fabricated when the agent is unavailable.
 */
import type { PrismaClient } from "@dealmind/db";
import {
  type ShoppingSearchJob,
  searchCancelKey,
  shoppingSearchJob,
  signUserContext,
} from "@dealmind/queue";
import { TERMINAL_SEARCH_STATUSES } from "@dealmind/shared";
import type { Redis } from "ioredis";
import { AGENT_TERMINAL, type AgentClient } from "./agent-client.js";

export type SearchOutcome =
  "missing" | "already-finished" | "cancelled" | (typeof AGENT_TERMINAL)[number];

export interface SearchProcessorDeps {
  prisma: PrismaClient;
  agent: AgentClient;
  redis: Pick<Redis, "get">;
  redisPrefix: string;
  userContextSecret: string;
  /** Whole-execution timeout. */
  timeoutMs: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AttemptInfo {
  attempt: number; // 1-based
  maxAttempts: number;
}

export class RetryableSearchError extends Error {
  override readonly name = "RetryableSearchError";
}

async function fail(
  prisma: PrismaClient,
  searchId: string,
  userId: string,
  runId: string,
  error: string,
  status: "FAILED" | "CANCELLED" = "FAILED",
) {
  const now = new Date();
  await prisma.$transaction([
    prisma.search.updateMany({
      where: { id: searchId, userId, status: { in: ["PENDING", "RUNNING"] } },
      data: { status, completedAt: now },
    }),
    prisma.agentRun.updateMany({
      where: { id: runId, userId, finishedAt: null },
      data: { status, error, finishedAt: now },
    }),
  ]);
}

export async function processShoppingSearch(
  deps: SearchProcessorDeps,
  payload: unknown,
  attempt: AttemptInfo = { attempt: 1, maxAttempts: 1 },
): Promise<SearchOutcome> {
  const { prisma, agent } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const job: ShoppingSearchJob = shoppingSearchJob.parse(payload);
  const search = await prisma.search.findFirst({ where: { id: job.searchId, userId: job.userId } });
  if (!search) return "missing";
  if (TERMINAL_SEARCH_STATUSES.includes(search.status)) return "already-finished";

  const cancelled = async () =>
    (await deps.redis.get(searchCancelKey(deps.redisPrefix, search.id))) !== null;

  const run =
    (await prisma.agentRun.findFirst({
      where: { searchId: search.id, userId: search.userId, status: "RUNNING", finishedAt: null },
      orderBy: { startedAt: "desc" },
    })) ??
    (await prisma.agentRun.create({
      data: {
        userId: search.userId,
        searchId: search.id,
        graph: "shopping_search",
        model: "",
        input: { query: search.query, filters: search.filters ?? {} },
      },
    }));
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { attempts: { increment: 1 }, threadId: run.id },
  });

  if (await cancelled()) {
    await fail(prisma, search.id, search.userId, run.id, "Cancelled by user", "CANCELLED");
    return "cancelled";
  }
  await prisma.search.updateMany({
    where: { id: search.id, status: "PENDING" },
    data: { status: "RUNNING" },
  });

  const finalAttempt = attempt.attempt >= attempt.maxAttempts;
  const deadline = now() + deps.timeoutMs;
  const userContext = signUserContext(
    {
      userId: search.userId,
      searchId: search.id,
      executionId: run.id,
      exp: Math.floor((deadline + 300_000) / 1000),
    },
    deps.userContextSecret,
  );

  try {
    let status = await agent.start({
      executionId: run.id,
      searchId: search.id,
      userContext,
      query: search.query,
      filters: (search.filters ?? {}) as Record<string, unknown>,
    });
    while (!AGENT_TERMINAL.includes(status.status)) {
      if (await cancelled()) {
        await agent.cancel(run.id).catch(() => undefined);
      }
      if (now() >= deadline) {
        await agent.cancel(run.id).catch(() => undefined);
        throw new RetryableSearchError(`Agent execution timed out after ${deps.timeoutMs} ms`);
      }
      await sleep(deps.pollIntervalMs ?? 1_000);
      const next = await agent.status(run.id);
      if (!next) throw new RetryableSearchError("Agent lost the execution (restarted?)");
      status = next;
    }
    const persisted = await prisma.search.findUniqueOrThrow({ where: { id: search.id } });
    if (status.persisted && TERMINAL_SEARCH_STATUSES.includes(persisted.status)) {
      return status.status;
    }
    if (status.status === "CANCELLED") {
      await fail(prisma, search.id, search.userId, run.id, "Cancelled by user", "CANCELLED");
      return "cancelled";
    }
    throw new RetryableSearchError(
      status.error ?? `Agent finished ${status.status} without persisting results`,
    );
  } catch (err) {
    const message = (err as Error).message.slice(0, 1_000);
    if (finalAttempt) {
      await fail(prisma, search.id, search.userId, run.id, message);
      return "FAILED";
    }
    throw err; // BullMQ retries; the agent resumes from the run's checkpoint.
  }
}
