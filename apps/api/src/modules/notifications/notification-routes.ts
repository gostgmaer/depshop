/**
 * The caller's notifications (in-app), notification preferences, browser push
 * subscriptions and one-click email unsubscribe. Every query is scoped by the
 * authenticated userId; another user's records are "not found".
 */
import {
  AppError,
  ErrorCode,
  NOTIFICATION_CATEGORIES,
  notificationListQuery,
  notificationPreferences,
  notificationView,
  pushConfigView,
  pushSubscribeInput,
  pushUnsubscribeInput,
  unsubscribeInput,
  unsubscribeView,
  updateNotificationPreferencesInput,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok, page, paginated } from "../../utils/http.js";
import type { NotificationService } from "./notification-service.js";
import type { RealtimeHub } from "./realtime-hub.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });
const HEARTBEAT_MS = 25_000;
const STREAM_MAX_MS = 30 * 60_000;
const MAX_STREAMS_PER_USER = 5;

export const notificationRoutes: FastifyPluginAsyncZod<{
  notifications: NotificationService;
  hub: RealtimeHub | null;
}> = async (app, { notifications, hub }) => {
  app.addHook("preHandler", app.requireAuth);

  app.get(
    "/",
    {
      schema: {
        tags: ["notifications"],
        summary: "Your in-app notifications, newest first",
        security,
        querystring: notificationListQuery,
        response: { 200: page(notificationView) },
      },
    },
    async (req) => {
      const r = await notifications.list(getAuth(req).userId, req.query);
      return paginated(r.items, r.pagination);
    },
  );

  app.get(
    "/unread-count",
    {
      schema: {
        tags: ["notifications"],
        summary: "Number of unread notifications",
        security,
        response: { 200: ok(z.object({ unread: z.number().int() })) },
      },
    },
    async (req) => ({ unread: await notifications.unreadCount(getAuth(req).userId) }),
  );

  const readOpts = {
    schema: {
      tags: ["notifications"],
      summary: "Mark one notification as read",
      security,
      params: idParam,
      response: { 200: ok(notificationView) },
    },
  };
  app.patch("/:id/read", readOpts, async (req) =>
    notifications.markRead(getAuth(req).userId, req.params.id),
  );
  /** Kept for clients built before Phase 5.3. */
  app.post("/:id/read", readOpts, async (req) =>
    notifications.markRead(getAuth(req).userId, req.params.id),
  );

  app.post(
    "/read-all",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark all (or one category's) notifications as read",
        security,
        querystring: z.object({ category: z.enum(NOTIFICATION_CATEGORIES).optional() }).strict(),
        response: { 200: ok(z.object({ updated: z.number().int() })) },
      },
    },
    async (req) => notifications.readAll(getAuth(req).userId, req.query.category),
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["notifications"],
        summary: "Delete one notification",
        security,
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await notifications.remove(getAuth(req).userId, req.params.id);
      return reply.status(204).send(null);
    },
  );

  /**
   * Server-Sent Events: `ready` with the unread count, then one `change`
   * event per new/read/deleted notification of the caller (ids only, plus the
   * fresh unread count). Closes after 30 minutes; EventSource reconnects.
   */
  app.get(
    "/stream",
    {
      schema: {
        tags: ["notifications"],
        summary: "Live notification updates (text/event-stream)",
        security,
      },
    },
    async (req, reply) => {
      const userId = getAuth(req).userId;
      if (!hub) throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Live updates unavailable");
      if (hub.count(userId) >= MAX_STREAMS_PER_USER)
        throw new AppError(ErrorCode.RATE_LIMITED, "Too many open notification streams");
      const unread = await notifications.unreadCount(userId);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("ready", { unread });
      let closed = false;
      let remove: (() => Promise<void>) | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(maxTimer);
        void remove?.();
        res.end();
      };
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
      const maxTimer = setTimeout(close, STREAM_MAX_MS);
      req.raw.on("close", close);
      try {
        remove = await hub.add(userId, (message) => {
          let signal: unknown;
          try {
            signal = JSON.parse(message);
          } catch {
            return;
          }
          void notifications
            .unreadCount(userId)
            .then((count) => {
              if (!closed) send("change", { signal, unread: count });
            })
            .catch(() => undefined);
        });
      } catch {
        return close();
      }
      if (closed) await remove();
    },
  );
};

/** GET/PATCH /users/me/notification-preferences */
export const notificationPreferenceRoutes: FastifyPluginAsyncZod<{
  notifications: NotificationService;
}> = async (app, { notifications }) => {
  app.addHook("preHandler", app.requireAuth);
  app.get(
    "/",
    {
      schema: {
        tags: ["notifications"],
        summary: "Your notification preferences",
        security,
        response: { 200: ok(notificationPreferences) },
      },
    },
    async (req) => notifications.preferences(getAuth(req).userId),
  );
  app.patch(
    "/",
    {
      schema: {
        tags: ["notifications"],
        summary: "Update your notification preferences",
        security,
        body: updateNotificationPreferencesInput,
        response: { 200: ok(notificationPreferences) },
      },
    },
    async (req) => notifications.updatePreferences(getAuth(req).userId, req.body),
  );
};

/** /push: VAPID public key, subscribe and unsubscribe this browser. */
export const pushRoutes: FastifyPluginAsyncZod<{
  notifications: NotificationService;
  vapidPublicKey: string | null;
}> = async (app, { notifications, vapidPublicKey }) => {
  app.get(
    "/config",
    {
      schema: {
        tags: ["notifications"],
        summary: "Web push configuration (VAPID public key, or null when unavailable)",
        response: { 200: ok(pushConfigView) },
      },
    },
    async () => ({ publicKey: vapidPublicKey }),
  );
  app.post(
    "/subscribe",
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["notifications"],
        summary: "Store this browser's push subscription for you",
        security,
        body: pushSubscribeInput,
        response: { 201: ok(z.object({ id: z.string().uuid(), createdAt: z.string() })) },
      },
    },
    async (req, reply) => {
      if (!vapidPublicKey)
        throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Browser notifications unavailable");
      const ua = req.headers["user-agent"];
      return reply
        .status(201)
        .send(await notifications.subscribePush(getAuth(req).userId, req.body, ua));
    },
  );
  app.delete(
    "/subscribe",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["notifications"],
        summary: "Stop push notifications on this browser",
        security,
        body: pushUnsubscribeInput,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await notifications.unsubscribePush(getAuth(req).userId, req.body.endpoint);
      return reply.status(204).send(null);
    },
  );
};

/** POST /notifications/unsubscribe: one-click email unsubscribe (signed token, no session). */
export const unsubscribeRoutes: FastifyPluginAsyncZod<{
  notifications: NotificationService;
}> = async (app, { notifications }) => {
  app.post(
    "/",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["notifications"],
        summary: "Turn off one category's emails from an unsubscribe link",
        body: unsubscribeInput,
        response: { 200: ok(unsubscribeView) },
      },
    },
    async (req) => notifications.unsubscribe(req.body.token),
  );
};
