import {
  alertEvaluationView,
  alertListQuery,
  alertView,
  createAlertInput,
  pageQuery,
  updateAlertInput,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok, page } from "../../utils/http.js";
import type { AlertService } from "./alert-service.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });

export const alertRoutes: FastifyPluginAsyncZod<{ alerts: AlertService }> = async (
  app,
  { alerts },
) => {
  app.addHook("preHandler", app.requireAuth);

  app.post(
    "/",
    {
      schema: {
        tags: ["alerts"],
        summary: "Create a price alert",
        security,
        body: createAlertInput,
        response: { 201: ok(alertView) },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await alerts.create(getAuth(req).userId, req.body)),
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["alerts"],
        summary: "Your alerts (optionally by status)",
        security,
        querystring: alertListQuery,
        response: { 200: page(alertView) },
      },
    },
    async (req) => alerts.list(getAuth(req).userId, req.query),
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["alerts"],
        summary: "One alert",
        security,
        params: idParam,
        response: { 200: ok(alertView) },
      },
    },
    async (req) => alerts.get(getAuth(req).userId, req.params.id),
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["alerts"],
        summary: "Update target price or source",
        security,
        params: idParam,
        body: updateAlertInput,
        response: { 200: ok(alertView) },
      },
    },
    async (req) => alerts.update(getAuth(req).userId, req.params.id, req.body),
  );

  app.post(
    "/:id/pause",
    {
      schema: {
        tags: ["alerts"],
        summary: "Pause an alert",
        security,
        params: idParam,
        response: { 200: ok(alertView) },
      },
    },
    async (req) => alerts.pause(getAuth(req).userId, req.params.id),
  );

  app.post(
    "/:id/resume",
    {
      schema: {
        tags: ["alerts"],
        summary: "Resume an alert",
        security,
        params: idParam,
        response: { 200: ok(alertView) },
      },
    },
    async (req) => alerts.resume(getAuth(req).userId, req.params.id),
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["alerts"],
        summary: "Delete an alert",
        security,
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await alerts.remove(getAuth(req).userId, req.params.id);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/:id/evaluations",
    {
      schema: {
        tags: ["alerts"],
        summary:
          "Evaluation history of one of your alerts (each global price check it was checked against)",
        security,
        params: idParam,
        querystring: pageQuery.strict(),
        response: { 200: page(alertEvaluationView) },
      },
    },
    async (req) => alerts.evaluations(getAuth(req).userId, req.params.id, req.query),
  );
};
