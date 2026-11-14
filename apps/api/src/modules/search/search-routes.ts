import {
  createSearchInput,
  pageQuery,
  searchDetail,
  searchResultView,
  searchSourceRunView,
  searchView,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok, page } from "../../utils/http.js";
import type { SearchService } from "./search-service.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });

export const searchRoutes: FastifyPluginAsyncZod<{ search: SearchService }> = async (
  app,
  { search },
) => {
  app.addHook("preHandler", app.requireAuth);

  app.post(
    "/",
    {
      // Searches are expensive downstream: stricter per-IP limit on submission.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      schema: {
        tags: ["search"],
        summary: "Your recent searches",
        security,
        querystring: pageQuery.strict(),
        response: { 200: page(searchView) },
      },
    },
    async (req) => search.list(getAuth(req).userId, req.query),
  );

  app.get(
    "/:id",
    {
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
      schema: {
        tags: ["search"],
        summary: "Ranked results (final or partial)",
        security,
        params: idParam,
        querystring: pageQuery.strict(),
        response: { 200: page(searchResultView) },
      },
    },
    async (req) => search.results(getAuth(req).userId, req.params.id, req.query),
  );

  app.get(
    "/:id/sources",
    {
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
};
