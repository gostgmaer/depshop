import {
  alertEvaluationView,
  alertListQuery,
  alertView,
  createAlertInput,
  alertHistoryQuery,
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
        summary:
          "Update the condition, channels, cooldown, expiry or marketplace (ACTIVE, PAUSED or TRIGGERED alerts)",
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
        summary: "Pause an active alert (409 from other statuses)",
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
        summary: "Resume a paused alert or re-arm a triggered one (409 if expired or cancelled)",
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
        summary: "Delete an alert and its history (any status)",
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

  app.post(
    "/:id/cancel",
    {
      schema: {
        tags: ["alerts"],
        summary: "Cancel an alert (kept with its history; final)",
        security,
        params: idParam,
        response: { 200: ok(alertView) },
      },
    },
    async (req) => alerts.cancel(getAuth(req).userId, req.params.id),
  );

  // "/history" (spec) and "/evaluations" (Phase 5.1 clients) are the same list.
  for (const path of ["/:id/history", "/:id/evaluations"]) {
    app.get(
      path,
      {
        schema: {
          tags: ["alerts"],
          summary:
            "Evaluation history of one of your alerts (outcome=TRIGGERED: previous triggers)",
          security,
          params: idParam,
          querystring: alertHistoryQuery,
          response: { 200: page(alertEvaluationView) },
        },
      },
      async (req) => alerts.history(getAuth(req).userId, req.params.id, req.query),
    );
  }
};
