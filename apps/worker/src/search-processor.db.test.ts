/**
 * Worker → Python agent supervision against a real PostgreSQL, with the agent's
 * internal HTTP API replaced by a scripted fake (fetch-level).
 */
import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { verifyUserContext } from "@dealmind/queue";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AgentClient } from "./agent-client.js";
import { processShoppingSearch, type SearchProcessorDeps } from "./search-processor.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
afterAll(() => prisma.$disconnect());

const SECRET = "c".repeat(40);
const TOKEN = "a".repeat(40);

type Reply = { status: number; body?: unknown };
type Script = (req: {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}) => Reply | Promise<Reply>;

class FakeAgent {
  calls: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
    auth: string | null;
  }[] = [];
  constructor(public script: Script) {}
  fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const raw = typeof init?.body === "string" ? init.body : null;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const headers = new Headers(init?.headers);
    const req = { method: init?.method ?? "GET", path: u.pathname, body };
    this.calls.push({ ...req, auth: headers.get("authorization") });
    const res = await this.script(req);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let userId: string;
let cancelFlags: Map<string, string>;

function deps(agent: FakeAgent, over: Partial<SearchProcessorDeps> = {}): SearchProcessorDeps {
  return {
    prisma,
    agent: new AgentClient("http://agent.test", TOKEN, agent.fetch),
    redis: { get: async (key: string) => cancelFlags.get(String(key)) ?? null },
    redisPrefix: "dmtest",
    userContextSecret: SECRET,
    timeoutMs: 5_000,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    ...over,
  };
}

beforeEach(async () => {
  await truncateAll(prisma);
  cancelFlags = new Map();
  userId = (
    await prisma.user.create({
      data: { email: "w@example.com", name: "W", iamUserId: randomUUID() },
    })
  ).id;
});

const status = (executionId: string, s: string, persisted: boolean, error?: string) => ({
  execution_id: executionId,
  status: s,
  persisted,
  ...(error ? { error } : {}),
});

describe("processShoppingSearch (worker → agent)", () => {
  it("starts the agent with a signed user context and waits until it has persisted results", async () => {
    const search = await prisma.search.create({
      data: { userId, query: "acme nova", filters: { maxPricePaise: 100 } },
    });
    let polls = 0;
    const agent = new FakeAgent(async ({ method, body }) => {
      if (method === "POST")
        return { status: 202, body: status(String(body?.execution_id), "RUNNING", false) };
      polls += 1;
      if (polls < 3) return { status: 200, body: status("x", "RUNNING", false) };
      // The agent persisted through the internal API (simulated).
      await prisma.search.update({
        where: { id: search.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      return { status: 200, body: status("x", "COMPLETED", true) };
    });
    const outcome = await processShoppingSearch(deps(agent), { searchId: search.id, userId });
    expect(outcome).toBe("COMPLETED");
    const start = agent.calls[0]!;
    expect(start.path).toBe("/internal/agent/search");
    expect(start.auth).toBe(`Bearer ${TOKEN}`);
    expect(start.body).toMatchObject({
      search_id: search.id,
      query: "acme nova",
      filters: { maxPricePaise: 100 },
    });
    const ctx = verifyUserContext(String(start.body?.user_context), SECRET);
    expect(ctx).toMatchObject({
      userId,
      searchId: search.id,
      executionId: start.body?.execution_id,
    });
    const run = await prisma.agentRun.findFirstOrThrow({ where: { searchId: search.id } });
    expect(run).toMatchObject({
      id: start.body?.execution_id,
      threadId: run.id,
      attempts: 1,
      userId,
    });
  });

  it("reuses the same execution id on a retry so the agent resumes from its checkpoint", async () => {
    const search = await prisma.search.create({ data: { userId, query: "acme nova" } });
    const ids: unknown[] = [];
    const failing = new FakeAgent(({ method, body }) => {
      if (method === "POST") {
        ids.push(body?.execution_id);
        return { status: 202, body: status(String(body?.execution_id), "RUNNING", false) };
      }
      return { status: 200, body: status("x", "FAILED", false, "AI provider unavailable: 503") };
    });
    await expect(
      processShoppingSearch(
        deps(failing),
        { searchId: search.id, userId },
        { attempt: 1, maxAttempts: 3 },
      ),
    ).rejects.toThrow(/AI provider unavailable/);
    expect((await prisma.search.findUniqueOrThrow({ where: { id: search.id } })).status).toBe(
      "RUNNING",
    );
    await expect(
      processShoppingSearch(
        deps(failing),
        { searchId: search.id, userId },
        { attempt: 2, maxAttempts: 3 },
      ),
    ).rejects.toThrow();
    expect(ids[0]).toBe(ids[1]);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { searchId: search.id } });
    expect(run.attempts).toBe(2);
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("marks the search FAILED with the reason on the final attempt (nothing fabricated)", async () => {
    const search = await prisma.search.create({ data: { userId, query: "acme nova" } });
    const down = new FakeAgent(() => ({ status: 503, body: { detail: "down" } }));
    const outcome = await processShoppingSearch(
      deps(down),
      { searchId: search.id, userId },
      { attempt: 3, maxAttempts: 3 },
    );
    expect(outcome).toBe("FAILED");
    const done = await prisma.search.findUniqueOrThrow({
      where: { id: search.id },
      include: { results: true },
    });
    expect(done.status).toBe("FAILED");
    expect(done.results).toHaveLength(0);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { searchId: search.id } });
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/Agent service error: HTTP 503/);
  });

  it("times out, asks the agent to cancel, and retries", async () => {
    const search = await prisma.search.create({ data: { userId, query: "acme nova" } });
    let clock = 0;
    const agent = new FakeAgent(({ method }) => ({
      status: method === "POST" ? 202 : 200,
      body: status("x", "RUNNING", false),
    }));
    await expect(
      processShoppingSearch(
        deps(agent, { timeoutMs: 10, now: () => (clock += 6), sleep: async () => undefined }),
        { searchId: search.id, userId },
        { attempt: 1, maxAttempts: 2 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(agent.calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
  });

  it("honours user cancellation before and during execution", async () => {
    const before = await prisma.search.create({ data: { userId, query: "acme nova" } });
    cancelFlags.set(`dmtest:search-cancel:${before.id}`, "1");
    const never = new FakeAgent(() => ({ status: 500 }));
    expect(await processShoppingSearch(deps(never), { searchId: before.id, userId })).toBe(
      "cancelled",
    );
    expect(never.calls).toHaveLength(0);
    expect((await prisma.search.findUniqueOrThrow({ where: { id: before.id } })).status).toBe(
      "CANCELLED",
    );

    const during = await prisma.search.create({ data: { userId, query: "acme nova" } });
    let polls = 0;
    const agent = new FakeAgent(({ method, path }) => {
      if (path.endsWith("/cancel")) return { status: 202 };
      if (method === "POST") return { status: 202, body: status("x", "RUNNING", false) };
      polls += 1;
      if (polls === 1) cancelFlags.set(`dmtest:search-cancel:${during.id}`, "1");
      return { status: 200, body: status("x", polls > 2 ? "CANCELLED" : "RUNNING", false) };
    });
    expect(await processShoppingSearch(deps(agent), { searchId: during.id, userId })).toBe(
      "cancelled",
    );
    expect(agent.calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
    expect((await prisma.search.findUniqueOrThrow({ where: { id: during.id } })).status).toBe(
      "CANCELLED",
    );
  });

  it("is idempotent and enforces ownership", async () => {
    const done = await prisma.search.create({
      data: { userId, query: "acme", status: "COMPLETED" },
    });
    const agent = new FakeAgent(() => ({ status: 500 }));
    expect(await processShoppingSearch(deps(agent), { searchId: done.id, userId })).toBe(
      "already-finished",
    );
    const other = await prisma.search.create({ data: { userId, query: "tv" } });
    expect(
      await processShoppingSearch(deps(agent), { searchId: other.id, userId: randomUUID() }),
    ).toBe("missing");
    expect(agent.calls).toHaveLength(0);
    await expect(
      processShoppingSearch(deps(agent), { searchId: "nope", userId }),
    ).rejects.toThrow();
  });
});
