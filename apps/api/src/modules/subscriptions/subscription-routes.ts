import { planView, subscriptionView, usageView } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok } from "../../utils/http.js";
import type { PlanService } from "./plan-service.js";

const security = [{ sessionCookie: [] }];

export const subscriptionRoutes: FastifyPluginAsyncZod<{ plans: PlanService }> = async (app, { plans }) => {
  app.get(
    "/plans",
    {
      schema: { tags: ["subscriptions"], summary: "Available plans", response: { 200: ok(z.array(planView)) } },
    },
    async () => plans.listPlans(),
  );

  app.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["subscriptions"],
        summary: "Your subscription",
        security,
        response: { 200: ok(subscriptionView) },
      },
    },
    async (req) => plans.getSubscription(getAuth(req).userId),
  );

  app.get(
    "/me/usage",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["subscriptions"],
        summary: "Your usage against plan limits",
        security,
        response: { 200: ok(usageView) },
      },
    },
    async (req) => plans.usage(getAuth(req).userId),
  );
};
