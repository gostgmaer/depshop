/**
 * CSRF protection for every state-changing request (POST/PUT/PATCH/DELETE),
 * including login and registration (login-CSRF).
 *
 * Layers:
 *  1. Session cookie is SameSite=Lax: browsers don't attach it to cross-site
 *     subresource or form POSTs.
 *  2. Origin check: if the browser sent an Origin header, it must be on the
 *     allow-list; otherwise `Sec-Fetch-Site: cross-site` is rejected.
 *  3. Signed double-submit token: `x-csrf-token` must equal the CSRF cookie and
 *     carry a valid HMAC. Clients obtain it from GET /api/v1/auth/csrf.
 */
import { AppError, CSRF_HEADER, ErrorCode } from "@dealmind/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { type CookieNames, csrfCookieOptions } from "../lib/cookies.js";
import type { CsrfTokens } from "../lib/csrf.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfPluginOptions {
  csrf: CsrfTokens;
  cookies: CookieNames;
  secureCookies: boolean;
  allowedOrigins: string[];
}

declare module "fastify" {
  interface FastifyInstance {
    /** Issues a fresh CSRF token, sets its cookie and returns it. */
    issueCsrfToken: (reply: FastifyReply) => string;
  }
}

export const csrfPlugin = fp<CsrfPluginOptions>(
  (app: FastifyInstance, { csrf, cookies, secureCookies, allowedOrigins }, done) => {
    const allowed = new Set(allowedOrigins);

    app.decorate("issueCsrfToken", (reply) => {
      const token = csrf.issue();
      reply.setCookie(cookies.csrf, token, csrfCookieOptions(secureCookies));
      return token;
    });

    app.addHook("onRequest", async (request) => {
      if (SAFE_METHODS.has(request.method) || !request.url.startsWith("/api/")) return;

      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (!allowed.has(origin))
          throw new AppError(ErrorCode.CSRF_INVALID, "Cross-origin request blocked");
      } else if (request.headers["sec-fetch-site"] === "cross-site") {
        throw new AppError(ErrorCode.CSRF_INVALID, "Cross-site request blocked");
      }

      const header = request.headers[CSRF_HEADER];
      if (
        !csrf.verify(request.cookies[cookies.csrf], typeof header === "string" ? header : undefined)
      ) {
        throw new AppError(ErrorCode.CSRF_INVALID, "Missing or invalid CSRF token");
      }
    });
    done();
  },
  { name: "csrf", dependencies: ["@fastify/cookie"] },
);
