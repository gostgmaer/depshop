/** First-run admin setup: one-time token → claimed e-mail → ADMIN on first sign-in. */
import { createHash } from "node:crypto";
import type { MeResponse } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  PASSWORD,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  tokenFromIam,
  truncateAll,
} from "./harness.js";
import { SetupService } from "../modules/setup/setup-service.js";

const TOKEN = "first-run-setup-token-for-tests";
let ctx: TestContext;
const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;

beforeAll(async () => {
  ctx = await createTestApp({ ADMIN_SETUP_TOKEN: TOKEN });
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
  // What start-up does while no admin exists (the table is truncated between tests).
  const hash = createHash("sha256").update(TOKEN).digest("hex");
  await ctx.prisma.platformSetup.create({ data: { id: 1, setupTokenHash: hash } });
});

const claim = (agent: Agent, over: Record<string, string> = {}) =>
  agent.post("/api/v1/setup/admin", {
    token: TOKEN,
    name: "Site Owner",
    email: "Owner@Example.com",
    password: PASSWORD,
    ...over,
  });

async function verifyAndSignIn(email: string) {
  const agent = new Agent(ctx.app);
  await agent.post("/api/v1/auth/verify-email", { token: tokenFromIam(ctx.iam, email, "verify") });
  const res = await agent.post("/api/v1/auth/login", { email, password: PASSWORD });
  expect(res.statusCode).toBe(200);
  return { agent, user: data<MeResponse>(res).user };
}

describe("first-run admin setup", () => {
  it("is required until an administrator exists", async () => {
    const res = await new Agent(ctx.app).get("/api/v1/setup");
    expect(data<{ required: boolean }>(res)).toEqual({ required: true });
  });

  it("a wrong token is refused and claims nothing", async () => {
    const res = await claim(new Agent(ctx.app), { token: "not-the-right-token" });
    expect(res.statusCode).toBe(403);
    const row = await ctx.prisma.platformSetup.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.adminEmail).toBeNull();
    expect(ctx.iam.users.size).toBe(0);
  });

  it("the token registers the account in the IAM; its first sign-in makes it ADMIN, then setup closes", async () => {
    const res = await claim(new Agent(ctx.app));
    expect(res.statusCode).toBe(202);
    expect(data<{ email: string }>(res).email).toBe("owner@example.com");
    expect(ctx.iam.users.has("owner@example.com")).toBe(true);

    const { agent, user } = await verifyAndSignIn("owner@example.com");
    expect(user.role).toBe("ADMIN");
    expect((await agent.get("/api/v1/admin/dashboard")).statusCode).toBe(200);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: "setup.first_admin", entityId: user.id },
      }),
    ).toBe(1);

    expect(data<{ required: boolean }>(await new Agent(ctx.app).get("/api/v1/setup"))).toEqual({
      required: false,
    });
    // Setup is closed: the token can't be used again.
    expect((await claim(new Agent(ctx.app), { email: "second@example.com" })).statusCode).toBe(409);
  });

  it("the token is single-use: a second claim before sign-in is refused", async () => {
    expect((await claim(new Agent(ctx.app))).statusCode).toBe(202);
    const again = await claim(new Agent(ctx.app), { email: "intruder@example.com" });
    expect(again.statusCode).toBe(403);
    expect(ctx.iam.users.has("intruder@example.com")).toBe(false);
  });

  it("only the claimed e-mail is promoted; others signing in stay USER", async () => {
    expect((await claim(new Agent(ctx.app))).statusCode).toBe(202);
    const { userId } = await signUp(ctx, "someone@example.com");
    const someone = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(someone.role).toBe("USER");
  });

  it("a failed registration releases the claim so the token can be used again", async () => {
    const weak = await claim(new Agent(ctx.app), { password: "short" });
    expect(weak.statusCode).toBe(422);
    expect((await claim(new Agent(ctx.app))).statusCode).toBe(202);
  });

  it("is not available at all once an administrator exists", async () => {
    await signUp(ctx, "admin@example.com", { role: "ADMIN" });
    expect(data<{ required: boolean }>(await new Agent(ctx.app).get("/api/v1/setup"))).toEqual({
      required: false,
    });
    expect((await claim(new Agent(ctx.app))).statusCode).toBe(409);
  });

  it("first start without ADMIN_SETUP_TOKEN: a token is generated, logged once, and works", async () => {
    await ctx.prisma.platformSetup.deleteMany();
    const logged: Record<string, unknown>[] = [];
    const svc = new SetupService(ctx.prisma, { register: async () => ({ existing: false }) });
    await svc.prepare({ warn: (obj) => void logged.push(obj as Record<string, unknown>) });
    const token = logged[0]?.setupToken;
    expect(typeof token).toBe("string");
    expect(token as string).toMatch(/^[\w-]{20,}$/);
    // Only its hash is stored.
    const row = await ctx.prisma.platformSetup.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.setupTokenHash).not.toContain(token as string);
    expect((await claim(new Agent(ctx.app), { token: token as string })).statusCode).toBe(202);
  });

  it("tells the operator when the e-mail already has an IAM account (its own password applies)", async () => {
    await signUp(ctx, "existing@example.com"); // already in the IAM
    const res = await claim(new Agent(ctx.app), { email: "existing@example.com" });
    expect(res.statusCode).toBe(202);
    expect(data<{ existingAccount: boolean }>(res).existingAccount).toBe(true);
    const fresh = await claim(new Agent(ctx.app), { email: "fresh@example.com" }); // token used
    expect(fresh.statusCode).toBe(403);
  });

  it("after a restart, a new token can replace a pending claim that never completed", async () => {
    expect((await claim(new Agent(ctx.app), { email: "typo@example.com" })).statusCode).toBe(202);
    // Restart while setup is unfinished: a fresh token is issued.
    const logged: Record<string, unknown>[] = [];
    const svc = new SetupService(ctx.prisma, { register: async () => ({ existing: false }) });
    await svc.prepare({ warn: (obj) => void logged.push(obj as Record<string, unknown>) });
    expect(logged[0]?.pendingAdminEmail).toBe("typo@example.com");
    const token = logged[0]?.setupToken as string;
    const res = await claim(new Agent(ctx.app), { token, email: "owner@example.com" });
    expect(res.statusCode).toBe(202);
    const row = await ctx.prisma.platformSetup.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.adminEmail).toBe("owner@example.com");
    // Only the new e-mail is promoted.
    const { user } = await verifyAndSignIn("owner@example.com");
    expect(user.role).toBe("ADMIN");
  });
});
