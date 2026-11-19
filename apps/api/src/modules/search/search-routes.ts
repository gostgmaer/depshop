import {
  createSearchInput,
  pageQuery,
  searchDetail,
  searchResultView,
  searchResultsQuery,
  searchSourceRunView,
  searchView,
  AppError,
  ErrorCode,
  TERMINAL_SEARCH_STATUSES,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok, page } from "../../utils/http.js";
import type { Redis } from "ioredis";
import { searchEventsChannel, searchEventsLog } from "../internal/internal-routes.js";
import type { SearchService } from "./search-service.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });

export interface SearchRouteDeps {
  search: SearchService;
  /**
   * Live marketplace search. Off: submitting is refused (shoppers search the stored deals at
   * /deals?q=…); existing searches stay readable.
   */
  liveSearch?: boolean;
  /** Redis for the progress stream (a dedicated subscriber per connection). */
  redis?: Redis;
  redisPrefix?: string;
}

const STREAM_MAX_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;

export const searchRoutes: FastifyPluginAsyncZod<SearchRouteDeps> = async (
  app,
  { search, liveSearch = true, redis, redisPrefix },
) => {
  // Guest search: no account needed. Submitting creates a guest identity (signed cookie)
  // when there is neither a session nor a guest; reading needs one or the other, and a
  // guest only ever sees its own searches (every query is scoped by userId).

  app.post(
    "/",
    {
      // Searches are expensive downstream: stricter per-IP limit on submission.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      // Checked first, so a refused submission never creates a guest identity.
      preHandler: [
        async () => {
          if (!liveSearch)
            throw AppError.forbidden(
              "Live store search is turned off. Search the current deals instead.",
            );
        },
        app.ensureGuest,
      ],
      schema: {
        tags: ["search"],
        summary: "Submit a shopping search (asynchronous; returns PENDING)",
        security,
        body: createSearchInput,
        response: { 202: ok(searchView) },
      },
    },
    async (req, reply) =>
      reply.status(202).send(await search.create(getAuth(req).userId, req.body)),
  );

  app.get(
    "/",
    {
      preHandler: app.allowGuest,
      schema: {
        tags: ["search"],
        summary: "Your recent searches",
        security,
        querystring: pageQuery.strict(),
        response: { 200: page(searchView) },
      },
    },
    async (req) =>
      req.auth ? search.list(req.auth.userId, req.query) : search.emptyList(req.query),
  );

  app.get(
    "/:id",
    {
      preHandler: app.requireAuthOrGuest,
      schema: {
        tags: ["search"],
        summary: "Search status and per-source progress",
        security,
        params: idParam,
        response: { 200: ok(searchDetail) },
      },
    },
    async (req) => search.get(getAuth(req).userId, req.params.id),
  );

  app.get(
    "/:id/results",
    {
      preHandler: app.requireAuthOrGuest,
      schema: {
        tags: ["search"],
        summary: "Ranked results (final or partial); sort re-orders without re-ranking",
        security,
        params: idParam,
        querystring: searchResultsQuery,
        response: { 200: page(searchResultView) },
      },
    },
    async (req) => search.results(getAuth(req).userId, req.params.id, req.query),
  );

  app.get(
    "/:id/sources",
    {
      preHandler: app.requireAuthOrGuest,
      schema: {
        tags: ["search"],
        summary: "Source-level execution status",
        security,
        params: idParam,
        response: { 200: ok(z.array(searchSourceRunView)) },
      },
    },
    async (req) => search.sourceRuns(getAuth(req).userId, req.params.id),
  );

  app.post(
    "/:id/cancel",
    {
      preHandler: app.requireAuthOrGuest,
      schema: {
        tags: ["search"],
        summary: "Cancel a pending or running search (no effect once finished)",
        security,
        params: idParam,
        response: { 202: ok(searchView) },
      },
    },
    async (req, reply) =>
      reply.status(202).send(await search.cancel(getAuth(req).userId, req.params.id)),
  );

  /**
   * Server-Sent Events: replays recent progress, then streams live events
   * until the search finishes (or 5 minutes). Owner only.
   */
  app.get(
    "/:id/events",
    {
      preHandler: app.requireAuthOrGuest,
      schema: {
        tags: ["search"],
        summary: "Live progress (text/event-stream)",
        security,
        params: idParam,
      },
    },
    async (req, reply) => {
      const userId = getAuth(req).userId;
      const current = await search.assertOwned(userId, req.params.id);
      if (!redis || !redisPrefix)
        throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Progress stream unavailable");
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (data: string) => res.write(`data: ${data}\n\n`);
      const sub = redis.duplicate();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(maxTimer);
        void sub.quit().catch(() => undefined);
        res.end();
      };
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
      const maxTimer = setTimeout(close, STREAM_MAX_MS);
      req.raw.on("close", close);
      for (const e of await redis.lrange(searchEventsLog(redisPrefix, req.params.id), 0, -1))
        send(e);
      if (TERMINAL_SEARCH_STATUSES.includes(current.status as never)) {
        send(
          JSON.stringify({ type: "status", status: current.status, at: new Date().toISOString() }),
        );
        return close();
      }
      sub.on("message", (_channel, message) => {
        send(message);
        try {
          const event = JSON.parse(message) as { type?: string; status?: string };
          if (event.type === "status" && TERMINAL_SEARCH_STATUSES.includes(event.status as never))
            close();
        } catch {
          /* ignore malformed events */
        }
      });
      await sub.subscribe(searchEventsChannel(redisPrefix, req.params.id));
    },
  );
};
