/**
 * Authentication & authorization middleware.
 *
 *   app.requireAuth          any signed-in, ACTIVE user
 *   app.requireRole("ADMIN") a specific role
 *   app.requireAdmin         shorthand for requireRole("ADMIN")
 *
 * The principal is ALWAYS derived from the server-side session referenced by
 * the HttpOnly session cookie. Nothing in the body, query string or other
 * headers can influence who the caller is or what role they have. The role is
 * read from the database on every request, so demotions and suspensions take
 * effect immediately.
 */
import { AppError, type UserRole } from "@dealmind/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import fp from "fastify-plugin";
import { type CookieNames, sessionCookieOptions } from "../lib/cookies.js";
import { GUEST_COOKIE_DAYS, type GuestService } from "../modules/auth/guest-service.js";
import type {
  AuthContext,
  ClientInfo,
  IssuedSession,
  SessionService,
} from "../modules/auth/session-service.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth/requireRole; present on every protected route. */
    auth?: AuthContext;
  }
  interface FastifyInstance {
    requireAuth: preHandlerAsyncHookHandler;
    requireRole: (role: UserRole) => preHandlerAsyncHookHandler;
    requireAdmin: preHandlerAsyncHookHandler;
    /**
     * Guest search (opt-in per route; requireAuth NEVER accepts a guest):
     *  - allowGuest: a signed-in user, else the guest cookie's identity, else nothing (no throw);
     *  - requireAuthOrGuest: as allowGuest, but 401 when neither exists;
     *  - ensureGuest: as allowGuest, creating a guest (and its cookie) when neither exists.
     */
    allowGuest: preHandlerAsyncHookHandler;
    requireAuthOrGuest: preHandlerAsyncHookHandler;
    ensureGuest: preHandlerAsyncHookHandler;
    /** Resolves the session cookie if present (does not throw). */
    optionalAuth: (request: FastifyRequest) => Promise<AuthContext | null>;
    setSessionCookie: (reply: FastifyReply, session: IssuedSession) => void;
    clearSessionCookie: (reply: FastifyReply) => void;
  }
}

/** Returns the authenticated principal inside a protected handler. */
export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw AppError.unauthenticated();
  return request.auth;
}

export function clientInfo(request: FastifyRequest): ClientInfo {
  const ua = request.headers["user-agent"];
  return { userAgent: typeof ua === "string" ? ua : undefined, ipAddress: request.ip };
}

export interface AuthPluginOptions {
  sessions: SessionService;
  guests: GuestService;
  cookies: CookieNames;
  secureCookies: boolean;
}

export const authPlugin = fp<AuthPluginOptions>(
  (app: FastifyInstance, { sessions, guests, cookies, secureCookies }, done) => {
    app.decorateRequest("auth", undefined);

    const optionalAuth = async (request: FastifyRequest): Promise<AuthContext | null> => {
      if (request.auth) return request.auth;
      const auth = await sessions.resolve(request.cookies[cookies.session]);
      if (auth) request.auth = auth;
      return auth;
    };

    const requireAuth: preHandlerAsyncHookHandler = async function (request, reply) {
      if (!(await optionalAuth(request))) {
        // Drop a dead cookie so the browser stops sending it.
        if (request.cookies[cookies.session])
          reply.clearCookie(cookies.session, sessionCookieOptions(secureCookies, 0));
        throw AppError.unauthenticated();
      }
    };

    const requireRole = (role: UserRole): preHandlerAsyncHookHandler =>
      async function (request, reply) {
        await requireAuth.call(this, request, reply);
        if (request.auth?.role !== role) throw AppError.forbidden();
      };

    const resolveGuest = async (request: FastifyRequest): Promise<AuthContext | null> => {
      const auth =
        (await optionalAuth(request)) ?? (await guests.resolve(request.cookies[cookies.guest]));
      if (auth) request.auth = auth;
      return auth;
    };
    const allowGuest: preHandlerAsyncHookHandler = async function (request) {
      await resolveGuest(request);
    };
    const requireAuthOrGuest: preHandlerAsyncHookHandler = async function (request) {
      if (!(await resolveGuest(request))) throw AppError.unauthenticated();
    };
    const ensureGuest: preHandlerAsyncHookHandler = async function (request, reply) {
      if (await resolveGuest(request)) return;
      const { auth, token } = await guests.create();
      request.auth = auth;
      reply.setCookie(
        cookies.guest,
        token,
        sessionCookieOptions(secureCookies, GUEST_COOKIE_DAYS * 86_400),
      );
    };

    app.decorate("allowGuest", allowGuest);
    app.decorate("requireAuthOrGuest", requireAuthOrGuest);
    app.decorate("ensureGuest", ensureGuest);
    app.decorate("optionalAuth", optionalAuth);
    app.decorate("requireAuth", requireAuth);
    app.decorate("requireRole", requireRole);
    app.decorate("requireAdmin", requireRole("ADMIN"));
    app.decorate("setSessionCookie", (reply: FastifyReply, session: IssuedSession) => {
      reply.setCookie(
        cookies.session,
        session.token,
        sessionCookieOptions(secureCookies, session.maxAgeSeconds),
      );
    });
    app.decorate("clearSessionCookie", (reply: FastifyReply) => {
      reply.clearCookie(cookies.session, sessionCookieOptions(secureCookies, 0));
    });
    done();
  },
  { name: "auth", dependencies: ["@fastify/cookie"] },
);
