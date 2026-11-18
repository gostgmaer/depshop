/**
 * Guest search: no account needed to search, but a guest only ever sees its own
 * searches and can't use any account feature.
 */
import type { SearchView } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GUEST_EMAIL_DOMAIN } from "../modules/auth/guest-service.js";
import {
  Agent,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;
const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
const QUERY = { query: "Find a smartphone under ₹30,000 with 8GB RAM" };

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
});

async function guestSearch() {
  const agent = new Agent(ctx.app);
  const res = await agent.post("/api/v1/search", QUERY);
  expect(res.statusCode).toBe(202);
  return { agent, search: data<SearchView>(res) };
}

describe("guest search", () => {
  it("searches without an account: a guest identity is created and set as an HttpOnly cookie", async () => {
    const { agent, search } = await guestSearch();
    expect(agent.cookie("dm_guest")).toMatch(/^[0-9a-f-]{36}\.[\w-]+$/);
    const row = await ctx.prisma.search.findUniqueOrThrow({
      where: { id: search.id },
      include: { user: { select: { isGuest: true, email: true } } },
    });
    expect(row.user.isGuest).toBe(true);
    expect(row.user.email.endsWith(`@${GUEST_EMAIL_DOMAIN}`)).toBe(true);

    // The same browser can follow its search and list it.
    expect((await agent.get(`/api/v1/search/${search.id}`)).statusCode).toBe(200);
    expect((await agent.get(`/api/v1/search/${search.id}/results`)).statusCode).toBe(200);
    const list = await agent.get("/api/v1/search");
    expect(list.statusCode).toBe(200);
    expect(data<SearchView[]>(list).map((s) => s.id)).toEqual([search.id]);

    // A second search reuses the same guest (no new identity per request).
    expect((await agent.post("/api/v1/search", QUERY)).statusCode).toBe(202);
    expect(await ctx.prisma.user.count({ where: { isGuest: true } })).toBe(1);
  });

  it("a visitor with no identity yet sees an empty list, and can't read any search", async () => {
    const { search } = await guestSearch();
    const stranger = new Agent(ctx.app);
    const list = await stranger.get("/api/v1/search");
    expect(list.statusCode).toBe(200);
    expect(data<SearchView[]>(list)).toEqual([]);
    expect((await stranger.get(`/api/v1/search/${search.id}`)).statusCode).toBe(401);
  });

  it("isolation: guests can't see each other's searches, nor accounts' searches", async () => {
    const a = await guestSearch();
    const b = await guestSearch();
    expect((await b.agent.get(`/api/v1/search/${a.search.id}`)).statusCode).toBe(404);
    expect((await b.agent.get(`/api/v1/search/${a.search.id}/results`)).statusCode).toBe(404);
    expect((await b.agent.post(`/api/v1/search/${a.search.id}/cancel`)).statusCode).toBe(404);

    const { agent: member } = await signUp(ctx, "member@example.com");
    const own = data<SearchView>(await member.post("/api/v1/search", QUERY));
    expect((await a.agent.get(`/api/v1/search/${own.id}`)).statusCode).toBe(404);
    expect((await member.get(`/api/v1/search/${a.search.id}`)).statusCode).toBe(404);
  });

  it("a forged or tampered guest cookie is ignored", async () => {
    const { agent, search } = await guestSearch();
    const token = agent.cookie("dm_guest")!;
    const forged = new Agent(ctx.app);
    // Same user id, wrong signature.
    forged.jar.set("dm_guest", `${token.split(".")[0]}.AAAA${token.split(".")[1]!.slice(4)}`);
    expect((await forged.get(`/api/v1/search/${search.id}`)).statusCode).toBe(401);
    // Someone else's id with a signature that doesn't match it.
    const other = await guestSearch();
    forged.jar.set(
      "dm_guest",
      `${other.agent.cookie("dm_guest")!.split(".")[0]}.${token.split(".")[1]}`,
    );
    expect((await forged.get(`/api/v1/search/${other.search.id}`)).statusCode).toBe(401);
  });

  it.each([
    ["GET", "/api/v1/auth/me"],
    ["GET", "/api/v1/watchlists"],
    ["POST", "/api/v1/watchlists"],
    ["GET", "/api/v1/alerts"],
    ["GET", "/api/v1/notifications"],
    ["GET", "/api/v1/billing/subscription"],
    ["GET", "/api/v1/users/me/preferences"],
    ["POST", "/api/v1/push/subscribe"],
    ["GET", "/api/v1/admin/dashboard"],
  ] as const)("a guest is refused account features: %s %s", async (method, url) => {
    const { agent } = await guestSearch();
    // A valid body, so the request reaches the auth check (validation runs first).
    const body =
      url === "/api/v1/push/subscribe"
        ? { endpoint: "https://fcm.googleapis.com/fcm/send/guest-test", keys: { p256dh: "BNcR", auth: "tBHI" } }
        : { name: "x" };
    const res = await agent.request(method, url, method === "GET" ? undefined : body);
    expect(res.statusCode).toBe(401);
  });

  it("guests aren't counted or listed as users in admin", async () => {
    await guestSearch();
    await guestSearch();
    const { agent: admin } = await signUp(ctx, "admin@example.com", { role: "ADMIN" });
    const overview = data<{ platform: { users: number; newUsers7d: number } }>(
      await admin.get("/api/v1/admin/dashboard"),
    );
    expect(overview.platform.users).toBe(1);
    expect(overview.platform.newUsers7d).toBe(1);
    const users = data<{ items: { email: string }[] }>(await admin.get("/api/v1/admin/users"));
    expect(users.items.map((u) => u.email)).toEqual(["admin@example.com"]);
  });
});
