/**
 * Service-to-service authentication for /internal/v1 (Python agent → API).
 *
 *  - `Authorization: Bearer <INTERNAL_API_TOKEN>` compared in constant time
 *    (SHA-256 digests, so token length isn't leaked either);
 *  - no cookies, no CSRF (not a browser surface), no user session: the user
 *    context comes from the signed job the worker forwarded, and every
 *    private record is re-checked for ownership by these routes;
 *  - the reverse proxy must never route /internal (see docs/AGENT.md).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { AppError, ErrorCode } from "@dealmind/shared";
import type { FastifyRequest } from "fastify";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function bearerMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m?.[1]) return false;
  return timingSafeEqual(digest(m[1]), digest(expected));
}

export function serviceAuth(expectedToken: string) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!bearerMatches(request.headers.authorization, expectedToken)) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, "Service authentication required");
    }
  };
}

export { signUserContext, verifyUserContext, type UserContext } from "@dealmind/queue";
