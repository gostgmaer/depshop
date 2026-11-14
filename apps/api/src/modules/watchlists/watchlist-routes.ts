import {
  addWatchlistItemInput,
  createWatchlistInput,
  pageQuery,
  renameWatchlistInput,
  watchlistDetail,
  watchlistView,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok, page } from "../../utils/http.js";
import type { WatchlistService } from "./watchlist-service.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });

export const watchlistRoutes: FastifyPluginAsyncZod<{ watchlists: WatchlistService }> = async (
  app,
  { watchlists },
) => {
  app.addHook("preHandler", app.requireAuth);

  app.post(
    "/",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Create a watchlist",
        security,
        body: createWatchlistInput,
        response: { 201: ok(watchlistView) },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await watchlists.create(getAuth(req).userId, req.body.name)),
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Your watchlists",
        security,
        querystring: pageQuery.strict(),
        response: { 200: page(watchlistView) },
      },
    },
    async (req) => watchlists.list(getAuth(req).userId, req.query),
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Watchlist with items and current lowest prices",
        security,
        params: idParam,
        response: { 200: ok(watchlistDetail) },
      },
    },
    async (req) => watchlists.get(getAuth(req).userId, req.params.id),
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Rename a watchlist",
        security,
        params: idParam,
        body: renameWatchlistInput,
        response: { 200: ok(watchlistView) },
      },
    },
    async (req) => watchlists.rename(getAuth(req).userId, req.params.id, req.body.name),
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Delete a watchlist",
        security,
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await watchlists.remove(getAuth(req).userId, req.params.id);
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/:id/items",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Add a product variant",
        security,
        params: idParam,
        body: addWatchlistItemInput,
        response: { 201: ok(watchlistDetail) },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await watchlists.addItem(
            getAuth(req).userId,
            req.params.id,
            req.body.variantId,
            req.body.note,
          ),
        ),
  );

  app.delete(
    "/:id/items/:itemId",
    {
      schema: {
        tags: ["watchlists"],
        summary: "Remove an item",
        security,
        params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await watchlists.removeItem(getAuth(req).userId, req.params.id, req.params.itemId);
      return reply.status(204).send(null);
    },
  );
};
