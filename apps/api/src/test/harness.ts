import { randomBytes } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { CSRF_HEADER } from "@dealmind/shared";
import { JobQueues, redisConnectionFromUrl } from "@dealmind/queue";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import { type AppDeps, buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { FAKE_IAM_BASE, FakeIam } from "./fake-iam.js";

export const APP_ORIGIN = "http://localhost:3000";
/** Satisfies both DealMind's and the IAM's password policy. */
export const PASSWORD = "Correct-horse-42!";
export const TOKEN_KEY = randomBytes(32).toString("base64");

/** Real local Redis (from .env); every test app uses its own key prefix. */
export function testRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("API DB tests need REDIS_URL (see .env.example); run `pnpm infra:up`");
  return url;
}

/** Deletes every key under a prefix (SCAN, never KEYS/FLUSH). */
export async function deleteRedisPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  iam: FakeIam;
  redis: Redis;
  jobs: JobQueues;
  /** Unique Redis key prefix of this test app. */
  prefix: string;
  close: () => Promise<void>;
}

/** Builds the real app against the *_api_test database and a fake IAM. */
export async function createTestApp(
  envOverrides: Record<string, string> = {},
  depOverrides: Partial<AppDeps> = {},
  iam?: FakeIam,
): Promise<TestContext> {
  const url = resolveTestDatabaseUrl();
  const prefix = `dmtest:${randomBytes(6).toString("hex")}`;
  const fakeIam = iam ?? (await FakeIam.create());
  // DealMind is a registered application in the IAM (admin setup), so its
  // APP_URL is accepted as the base for emailed links.
  fakeIam.registerApp(APP_ORIGIN);
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: url,
    SESSION_SECRET: "test-session-secret-that-is-long-enough-123",
    TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    APP_URL: APP_ORIGIN,
    API_DOCS_ENABLED: "false",
    IAM_BASE_URL: FAKE_IAM_BASE,
    REDIS_URL: testRedisUrl(),
    REDIS_KEY_PREFIX: prefix,
    // Most suites exercise live search; deals-only mode is tested explicitly.
    LIVE_SEARCH_ENABLED: "true",
    ...envOverrides,
  });
  const prisma = createPrismaClient({ url });
  const redisUrl = testRedisUrl();
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  await new Promise<void>((resolve, reject) => {
    redis.once("ready", () => resolve());
    redis.once("error", reject);
  });
  const jobs = new JobQueues({
    connection: redisConnectionFromUrl(redisUrl),
    prefix: `${prefix}:bull`,
  });
  const app = await buildApp({
    env,
    prisma,
    healthChecks: {},
    logger: false,
    fetch: fakeIam.fetch,
    // Generous limits so functional tests are not throttled; the rate-limit
    // test builds an app with the real defaults.
    rateLimits: {
      credentials: { max: 1_000, timeWindow: "1 minute" },
      email: { max: 1_000, timeWindow: "1 minute" },
    },
    loginThrottle: { maxFailures: 5, windowMs: 60_000, lockMs: 60_000 },
    sessionTouchIntervalMs: 0,
    globalRateLimit: 10_000,
    redis,
    jobs,
    ...depOverrides,
  });
  return {
    app,
    prisma,
    iam: fakeIam,
    redis,
    jobs,
    prefix,
    close: async () => {
      // Clean this app's keys first; app.close() then quits the client.
      await deleteRedisPrefix(redis, prefix).catch(() => undefined);
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export { truncateAll };

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Behaves like a browser tab on the web app: keeps a cookie jar, sends the
 * app's Origin, and attaches the CSRF token to state-changing requests.
 */
export class Agent {
  readonly jar = new Map<string, string>();

  constructor(
    private readonly app: FastifyInstance,
    private readonly origin = APP_ORIGIN,
    /** Browser user agent (inject's default when omitted). */
    private readonly userAgent?: string,
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  async request(
    method: Method,
    url: string,
    payload?: unknown,
    opts: { csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> {
    const unsafe = method !== "GET";
    if (unsafe && opts.csrf !== false && !this.csrfToken()) {
      await this.request("GET", "/api/v1/auth/csrf");
    }
    const headers: Record<string, string> = { origin: this.origin };
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    const cookieHeader = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookieHeader) headers.cookie = cookieHeader;
    const token = this.csrfToken();
    if (unsafe && opts.csrf !== false && token) headers[CSRF_HEADER] = token;

    const res = await this.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    for (const c of res.cookies as {
      name: string;
      value: string;
      maxAge?: number;
      expires?: Date;
    }[]) {
      const expired =
        c.value === "" || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now());
      if (expired) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    return res;
  }

  private csrfToken(): string | undefined {
    return this.jar.get("dm_csrf") ?? this.jar.get("__Host-dm_csrf");
  }

  get(url: string): Promise<LightMyRequestResponse> {
    return this.request("GET", url);
  }
  post(url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    return this.request("POST", url, payload ?? {});
  }
  patch(url: string, payload: unknown): Promise<LightMyRequestResponse> {
    return this.request("PATCH", url, payload);
  }
  delete(url: string): Promise<LightMyRequestResponse> {
    return this.request("DELETE", url);
  }
}

/** The single-use token the IAM emailed (stand-in for clicking the link). */
export function tokenFromIam(iam: FakeIam, email: string, kind: "verify" | "reset"): string {
  const token = (kind === "verify" ? iam.lastVerifyToken : iam.lastResetToken).get(email);
  if (!token) throw new Error(`No ${kind} token issued for ${email}`);
  return token;
}

/** Forces the next authenticated request to revalidate the IAM session. */
export async function expireIamAccessTokens(prisma: PrismaClient, userId?: string): Promise<void> {
  await prisma.userSession.updateMany({
    where: userId ? { userId } : {},
    data: { iamAccessTokenExpiresAt: new Date(Date.now() - 1_000) },
  });
}

/** Registers, verifies and signs in a user; returns their browser agent. */
export async function signUp(
  ctx: TestContext,
  email: string,
  opts: { name?: string; role?: "USER" | "ADMIN"; verify?: boolean } = {},
): Promise<{ agent: Agent; userId: string }> {
  const agent = new Agent(ctx.app);
  const reg = await agent.post("/api/v1/auth/register", {
    email,
    password: PASSWORD,
    name: opts.name ?? "Test User",
  });
  if (reg.statusCode !== 202) throw new Error(`register failed: ${reg.body}`);
  if (opts.verify !== false) {
    await agent.post("/api/v1/auth/verify-email", {
      token: tokenFromIam(ctx.iam, email, "verify"),
    });
  }
  const login = await agent.post("/api/v1/auth/login", { email, password: PASSWORD });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
  if (opts.role === "ADMIN") {
    await ctx.prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  }
  return { agent, userId: user.id };
}
