/**
 * Phase 7.1 load test runner (NOT part of `test:db`): `pnpm test:load`.
 *
 * Starts the real API over HTTP on the *_api_test database (real PostgreSQL
 * and Redis, fake IAM), seeds a realistic signed-in user (searches,
 * notifications, watchlists), then runs the k6 script load/k6/api-read-mix.js
 * in the official grafana/k6 container against it, and prints k6's summary.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type TestContext, createTestApp, signUp, truncateAll } from "../harness.js";

const PORT = 4610;
const K6_IMAGE = "grafana/k6:0.54.0";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
let ctx: TestContext;
let session = "";

beforeAll(async () => {
  // Production session-touch interval (the test harness uses 0 = a write per request).
  ctx = await createTestApp({}, { globalRateLimit: 10_000_000, sessionTouchIntervalMs: undefined });
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  const { agent, userId } = await signUp(ctx, `load-${randomUUID().slice(0, 6)}@example.com`);
  session = agent.cookie("dm_session")!;
  // A realistic history: 200 searches, 300 notifications, 3 watchlists.
  await ctx.prisma.search.createMany({
    data: Array.from({ length: 200 }, (_, i) => ({
      userId,
      query: `phone under ${20_000 + i * 100}`,
      status: "COMPLETED" as const,
    })),
  });
  await ctx.prisma.notification.createMany({
    data: Array.from({ length: 300 }, (_, i) => ({
      userId,
      type: "PRICE_DROP" as const,
      category: "PRICE_ALERTS" as const,
      sourceType: "ALERT_EVALUATION" as const,
      sourceId: randomUUID(),
      dedupeKey: `load-${i}`,
      title: "Price dropped",
      body: "A tracked product is cheaper.",
    })),
  });
  for (const name of ["Phones", "Laptops", "Kitchen"])
    await ctx.prisma.watchlist.create({ data: { userId, name } });
  await ctx.app.listen({ host: "0.0.0.0", port: PORT });
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

/** Async: the API under test runs in THIS process, so the event loop must stay free. */
function run(
  cmd: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

it("k6 read mix", async () => {
  const out = path.join(repo, "load", "results");
  mkdirSync(out, { recursive: true });
  const r = await run("docker", [
    "run",
    "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${path.join(repo, "load")}:/load`,
    "-e",
    `BASE_URL=http://host.docker.internal:${PORT}`,
    "-e",
    `SESSION=${session}`,
    "-e",
    `VUS=${process.env.VUS ?? "25"}`,
    "-e",
    `DURATION=${process.env.DURATION ?? "40s"}`,
    K6_IMAGE,
    "run",
    "--quiet",
    "--summary-export=/load/results/api-read-mix.json",
    "/load/k6/api-read-mix.js",
  ]);
  console.warn(r.stdout);
  if (r.stderr) console.warn(r.stderr.split("\n").slice(-15).join("\n"));
  const summary = JSON.parse(readFileSync(path.join(out, "api-read-mix.json"), "utf8")) as {
    metrics: Record<string, Record<string, number>>;
  };
  expect(summary.metrics.http_reqs!.count).toBeGreaterThan(100);
  expect(r.status).toBe(0); // k6 exits non-zero when a threshold fails
}, 360_000);
