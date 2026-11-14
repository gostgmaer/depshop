import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { CSRF_HEADER } from "@dealmind/shared";
import type { FastifyInstance } from "fastify";
import { type AppDeps, buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { MemoryEmailTransport } from "../modules/email/email-transport.js";

export const APP_ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct-horse-42";

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  mail: MemoryEmailTransport;
  close: () => Promise<void>;
}

/** Builds the real app against the dedicated *_api_test database. */
export async function createTestApp(
  envOverrides: Record<string, string> = {},
  depOverrides: Partial<AppDeps> = {},
): Promise<TestContext> {
  const url = resolveTestDatabaseUrl();
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: url,
    SESSION_SECRET: "test-session-secret-that-is-long-enough-123",
    APP_URL: APP_ORIGIN,
    API_DOCS_ENABLED: "false",
    ...envOverrides,
  });
  const prisma = createPrismaClient({ url });
  const mail = new MemoryEmailTransport();
  const app = await buildApp({
    env,
    prisma,
    emailTransport: mail,
    healthChecks: {},
    logger: false,
    // Generous limits so functional tests are not throttled; the rate-limit
    // tests build an app with the real defaults.
    rateLimits: {
      credentials: { max: 1_000, timeWindow: "1 minute" },
      email: { max: 1_000, timeWindow: "1 minute" },
    },
    loginThrottle: { maxFailures: 5, windowMs: 60_000, lockMs: 60_000 },
    sessionTouchIntervalMs: 0,
    ...depOverrides,
  });
  return {
    app,
    prisma,
    mail,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export { truncateAll };

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Behaves like a browser tab on the web app: keeps a cookie jar, sends the
 * app's Origin, and attaches the CSRF token to state-changing requests.
 */
export class Agent {
  readonly jar = new Map<string, string>();

  constructor(
    private readonly app: FastifyInstance,
    private readonly origin = APP_ORIGIN,
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  async request(method: Method, url: string, payload?: unknown, opts: { csrf?: boolean } = {}) {
    const unsafe = method !== "GET";
    if (unsafe && opts.csrf !== false && !this.csrfToken())
      await this.request("GET", "/api/v1/auth/csrf");
    const headers: Record<string, string> = { origin: this.origin };
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

  get(url: string) {
    return this.request("GET", url);
  }
  post(url: string, payload?: unknown) {
    return this.request("POST", url, payload ?? {});
  }
  patch(url: string, payload: unknown) {
    return this.request("PATCH", url, payload);
  }
  delete(url: string) {
    return this.request("DELETE", url);
  }
}

/** Extracts the single-use token from the most recent email to `to`. */
export function tokenFromEmail(mail: MemoryEmailTransport, to: string): string {
  const message = mail.to(to).at(-1);
  const match = message ? /token=([A-Za-z0-9_-]+)/.exec(message.text) : null;
  if (!match?.[1]) throw new Error(`No token email found for ${to}`);
  return match[1];
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
    name: opts.name ?? "Test",
  });
  if (reg.statusCode !== 202) throw new Error(`register failed: ${reg.body}`);
  if (opts.verify !== false) {
    await agent.post("/api/v1/auth/verify-email", { token: tokenFromEmail(ctx.mail, email) });
  }
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
  if (opts.role === "ADMIN")
    await ctx.prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  const login = await agent.post("/api/v1/auth/login", { email, password: PASSWORD });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  return { agent, userId: user.id };
}
