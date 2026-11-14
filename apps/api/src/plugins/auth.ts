import { AppError, type UserRole } from "@dealmind/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { TokenService } from "../lib/tokens.js";

export interface AuthContext {
  userId: string;
  role: UserRole;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `app.authenticate`; present on every authenticated route. */
    auth?: AuthContext;
  }
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    requireRole: (role: UserRole) => preHandlerHookHandler;
  }
}

/** Returns the authenticated principal or throws 401. Use inside handlers. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw AppError.unauthenticated();
  return request.auth;
}

export const authPlugin = fp<{ tokens: TokenService }>(
  (app: FastifyInstance, { tokens }, done) => {
    app.decorateRequest("auth", undefined);

    async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw AppError.unauthenticated();
      const claims = await tokens.verifyAccessToken(header.slice("Bearer ".length).trim());
      if (!claims) throw AppError.unauthenticated("Invalid or expired access token");
      request.auth = claims;
    }

    app.decorate("authenticate", authenticate);
    app.decorate("requireRole", (role: UserRole) => {
      return async function requireRole(request: FastifyRequest, reply: FastifyReply) {
        if (!request.auth) await authenticate(request, reply);
        if (request.auth?.role !== role) throw AppError.forbidden();
      };
    });
    done();
  },
  { name: "auth" },
);
