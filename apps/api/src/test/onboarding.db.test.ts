/** Prompt 25 Stage 4: first-time onboarding state (docs/onboarding-flow.md). */
import type { MeResponse } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agent, type TestContext, createTestApp, signUp, truncateAll } from "./harness.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  ctx.iam.reset();
});

const me = async (agent: Agent) =>
  (await agent.get("/api/v1/auth/me")).json<{ data: MeResponse }>().data.user;

describe("onboarding", () => {
  it("is not completed for a new user, and finishing it is remembered", async () => {
    const { agent, userId } = await signUp(ctx, "new@example.com");
    expect((await me(agent)).onboardingCompleted).toBe(false);

    const res = await agent.post("/api/v1/users/me/onboarding", { outcome: "completed" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: MeResponse }>().data.user.onboardingCompleted).toBe(true);
    expect((await me(agent)).onboardingCompleted).toBe(true);

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.onboardingCompletedAt).toBeInstanceOf(Date);
    expect(row.onboardingSkipped).toBe(false);
  });

  it("records a skip, and the first outcome wins (idempotent, no overwrite)", async () => {
    const { agent, userId } = await signUp(ctx, "skipper@example.com");
    expect(
      (await agent.post("/api/v1/users/me/onboarding", { outcome: "skipped" })).statusCode,
    ).toBe(200);
    const first = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // A second tab finishing it later changes nothing.
    expect(
      (await agent.post("/api/v1/users/me/onboarding", { outcome: "completed" })).statusCode,
    ).toBe(200);
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.onboardingSkipped).toBe(true);
    expect(after.onboardingCompletedAt?.getTime()).toBe(first.onboardingCompletedAt?.getTime());
  });

  it("concurrent closes record exactly one outcome", async () => {
    const { agent, userId } = await signUp(ctx, "race@example.com");
    const results = await Promise.all([
      agent.post("/api/v1/users/me/onboarding", { outcome: "completed" }),
      agent.post("/api/v1/users/me/onboarding", { outcome: "skipped" }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.onboardingCompletedAt).not.toBeNull();
  });

  it("only changes the caller's own account", async () => {
    const { agent: alice } = await signUp(ctx, "alice@example.com");
    const { agent: bob, userId: bobId } = await signUp(ctx, "bob@example.com");
    // A smuggled userId is rejected (strict body), never applied to Bob.
    const smuggled = await alice.post("/api/v1/users/me/onboarding", {
      outcome: "completed",
      userId: bobId,
    });
    expect(smuggled.statusCode).toBe(422);
    await alice.post("/api/v1/users/me/onboarding", { outcome: "completed" });
    expect((await me(bob)).onboardingCompleted).toBe(false);
  });

  it("rejects an unknown outcome, needs a session and the CSRF token", async () => {
    const { agent } = await signUp(ctx, "v@example.com");
    expect((await agent.post("/api/v1/users/me/onboarding", { outcome: "maybe" })).statusCode).toBe(
      422,
    );
    expect((await agent.post("/api/v1/users/me/onboarding", {})).statusCode).toBe(422);

    const anon = await new Agent(ctx.app).post("/api/v1/users/me/onboarding", {
      outcome: "completed",
    });
    expect(anon.statusCode).toBe(401);

    const noCsrf = await agent.request(
      "POST",
      "/api/v1/users/me/onboarding",
      { outcome: "completed" },
      { csrf: false },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect((await me(agent)).onboardingCompleted).toBe(false);
  });
});
