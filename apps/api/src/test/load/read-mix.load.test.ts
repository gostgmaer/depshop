/**
 * Phase 7.1 load test runner (NOT part of `test:db`): `pnpm test:load`.
 *
 * Starts the real API over HTTP on the *_api_test database (real PostgreSQL
 * and Redis, fake IAM), seeds a realistic signed-in user (searches,
 * notifications, watchlists) and the LABELLED sample catalog ("DealMind Sample
 * Store", fictional prices; refuses NODE_ENV=production), then runs the k6
 * scripts in load/k6 in the official grafana/k6 container against it.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { seedSampleCatalog } from "@dealmind/intelligence";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type TestContext, createTestApp, signUp, truncateAll } from "../harness.js";

const PORT = 4610;
const K6_IMAGE = "grafana/k6:0.54.0";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
let ctx: TestContext;
let session = "";
let csrf = "";
let pairs = "";

beforeAll(async () => {
  // Production session-touch interval (the test harness uses 0 = a write per request).
  ctx = await createTestApp({}, { globalRateLimit: 10_000_000, sessionTouchIntervalMs: undefined });
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  const { agent, userId } = await signUp(ctx, `load-${randomUUID().slice(0, 6)}@example.com`);
  session = agent.cookie("dm_session")!;
  await agent.get("/api/v1/auth/csrf");
  csrf = agent.cookie("dm_csrf")!;
  // Sample catalog through the real importer (products, variants, offers, history).
  await seedSampleCatalog(ctx.prisma, { env: "test" });
  const variants = await ctx.prisma.productVariant.findMany({
    where: { offers: { some: {} } },
    select: { id: true, productId: true },
    take: 60,
  });
  pairs = variants.map((v) => `${v.productId}:${v.id}`).join(",");
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

async function k6(script: string, extraEnv: Record<string, string> = {}) {
  const out = path.join(repo, "load", "results");
  mkdirSync(out, { recursive: true });
  const name = script.replace(/\.js$/, "");
  const env = {
    BASE_URL: `http://host.docker.internal:${PORT}`,
    SESSION: session,
    VUS: process.env.VUS ?? "25",
    DURATION: process.env.DURATION ?? "40s",
    ...extraEnv,
  };
  const r = await run("docker", [
    "run",
    "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${path.join(repo, "load")}:/load`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    K6_IMAGE,
    "run",
    "--quiet",
    `--summary-export=/load/results/${name}.json`,
    `/load/k6/${script}`,
  ]);
  console.warn(r.stdout);
  if (r.stderr) console.warn(r.stderr.split("\n").slice(-15).join("\n"));
  const summary = JSON.parse(readFileSync(path.join(out, `${name}.json`), "utf8")) as {
    metrics: Record<string, Record<string, number>>;
  };
  return { status: r.status, summary };
}

it("k6 read mix (signed-in shopper reads)", async () => {
  const { status, summary } = await k6("api-read-mix.js");
  expect(summary.metrics.http_reqs!.count).toBeGreaterThan(100);
  expect(status).toBe(0); // k6 exits non-zero when a threshold fails
}, 360_000);

it("k6 catalog mix (search, product, offers, pricing, history, compare, submit)", async () => {
  expect(pairs.split(",").length).toBeGreaterThan(5);
  const { status, summary } = await k6("api-catalog-mix.js", { CSRF: csrf, PRODUCTS: pairs });
  expect(summary.metrics.http_reqs!.count).toBeGreaterThan(100);
  expect(status).toBe(0);
}, 360_000);
