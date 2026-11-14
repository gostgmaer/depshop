import {
  changePasswordInput,
  forgotPasswordInput,
  loginInput,
  meResponse,
  messageResponse,
  registerInput,
  resetPasswordInput,
  sessionsResponse,
  verifyEmailInput,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ok } from "../../utils/http.js";
import { z } from "zod";
import { clientInfo, getAuth } from "../../plugins/auth.js";
import type { UserService } from "../users/user-service.js";
import { type AuthService, FORGOT_PASSWORD_MESSAGE, REGISTER_MESSAGE } from "./auth-service.js";
import type { SessionService } from "./session-service.js";

export interface RateLimitRule {
  max: number;
  timeWindow: string | number;
}

export interface AuthRateLimits {
  /** login, register, reset-password, change-password (per IP). */
  credentials: RateLimitRule;
  /** Endpoints that send email: forgot-password, resend-verification (per IP). */
  email: RateLimitRule;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  credentials: { max: 10, timeWindow: "1 minute" },
  email: { max: 5, timeWindow: "15 minutes" },
};

export interface AuthRoutesOptions {
  auth: AuthService;
  sessions: SessionService;
  users: UserService;
  rateLimits: AuthRateLimits;
}

const security = [{ sessionCookie: [] }];

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (
  app,
  { auth, sessions, users, rateLimits },
) => {
  const credentials = { rateLimit: rateLimits.credentials };
  const email = { rateLimit: rateLimits.email };

  app.get(
    "/csrf",
    {
      schema: {
        tags: ["auth"],
        summary: "Issue a CSRF token (also set as a cookie); send it as x-csrf-token",
        response: { 200: ok(z.object({ csrfToken: z.string() })) },
      },
    },
    async (_req, reply) => ({ csrfToken: app.issueCsrfToken(reply) }),
  );

  app.post(
    "/register",
    {
      config: credentials,
      schema: {
        tags: ["auth"],
        summary: "Create an account (responds identically whether or not the email exists)",
        body: registerInput,
        response: { 202: ok(messageResponse) },
      },
    },
    async (req, reply) => {
      await auth.register(req.body, clientInfo(req));
      return reply.status(202).send({ message: REGISTER_MESSAGE });
    },
  );

  app.post(
    "/login",
    {
      config: credentials,
      schema: {
        tags: ["auth"],
        summary: "Sign in; sets a new HttpOnly session cookie",
        body: loginInput,
        response: { 200: ok(meResponse) },
      },
    },
    async (req, reply) => {
      const presented = await app.optionalAuth(req);
      const { user, session } = await auth.login(req.body, clientInfo(req), presented);
      app.setSessionCookie(reply, session);
      // Fresh CSRF token for the new session.
      app.issueCsrfToken(reply);
      return { user };
    },
  );

  app.post(
    "/logout",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Sign out this session",
        security,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await auth.logout(getAuth(req));
      app.clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "The signed-in user",
        security,
        response: { 200: ok(meResponse) },
      },
    },
    async (req) => ({ user: await users.getMe(getAuth(req).userId) }),
  );

  app.post(
    "/verify-email",
    {
      config: credentials,
      schema: {
        tags: ["auth"],
        summary: "Confirm an email address with the token from the verification email",
        body: verifyEmailInput,
        response: { 200: ok(messageResponse) },
      },
    },
    async (req) => {
      await auth.verifyEmail(req.body.token, await app.optionalAuth(req));
      return { message: "Your email address is verified." };
    },
  );

  app.post(
    "/resend-verification",
    {
      config: email,
      preHandler: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Send a new verification email to the signed-in user",
        security,
        response: { 200: ok(messageResponse) },
      },
    },
    async (req) => {
      const result = await auth.resendVerification(getAuth(req));
      return {
        message:
          result === "already-verified"
            ? "Your email address is already verified."
            : "We've sent a new verification link.",
      };
    },
  );

  app.post(
    "/forgot-password",
    {
      config: email,
      schema: {
        tags: ["auth"],
        summary: "Request a password-reset email (responds identically for unknown emails)",
        body: forgotPasswordInput,
        response: { 202: ok(messageResponse) },
      },
    },
    async (req, reply) => {
      await auth.forgotPassword(req.body.email, clientInfo(req));
      return reply.status(202).send({ message: FORGOT_PASSWORD_MESSAGE });
    },
  );

  app.post(
    "/reset-password",
    {
      config: credentials,
      schema: {
        tags: ["auth"],
        summary: "Set a new password with a reset token; signs out all sessions",
        body: resetPasswordInput,
        response: { 200: ok(messageResponse) },
      },
    },
    async (req, reply) => {
      await auth.resetPassword(req.body.token, req.body.password);
      app.clearSessionCookie(reply);
      return { message: "Your password has been reset. Please sign in." };
    },
  );

  app.post(
    "/change-password",
    {
      config: credentials,
      preHandler: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Change password; signs out other sessions and rotates this one",
        security,
        body: changePasswordInput,
        response: { 200: ok(messageResponse) },
      },
    },
    async (req, reply) => {
      const rotated = await auth.changePassword(
        getAuth(req),
        req.body.currentPassword,
        req.body.newPassword,
        clientInfo(req),
      );
      app.setSessionCookie(reply, rotated);
      app.issueCsrfToken(reply);
      return { message: "Your password has been changed. Other sessions were signed out." };
    },
  );

  app.get(
    "/sessions",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "List your active sessions",
        security,
        response: { 200: ok(sessionsResponse) },
      },
    },
    async (req) => {
      const me = getAuth(req);
      const rows = await sessions.listActive(me.userId);
      return {
        sessions: rows.map((s) => ({
          id: s.id,
          current: s.id === me.sessionId,
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        })),
      };
    },
  );

  app.delete(
    "/sessions/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Revoke one of your sessions",
        security,
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const me = getAuth(req);
      // Scoped by the caller's userId: another user's session is "not found".
      await auth.revokeSession(me, req.params.id);
      if (req.params.id === me.sessionId) app.clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );
};
