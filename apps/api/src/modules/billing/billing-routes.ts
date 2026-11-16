/**
 * /api/v1/billing/*, /api/v1/usage and the payment-service webhook.
 * Every billing record belongs to the authenticated user.
 */
import {
  cancelSubscriptionInput,
  changePlanInput,
  checkoutInput,
  checkoutView,
  confirmCheckoutInput,
  invoiceView,
  paymentView,
  planView,
  subscriptionView,
  usageView,
} from "@dealmind/shared";
import { EASYDEV_SIGNATURE_HEADER } from "@dealmind/billing";
import type { FastifyPluginAsync } from "fastify";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok } from "../../utils/http.js";
import type { BillingService } from "./billing-service.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });
/** Checkout and plan changes: a handful per minute is plenty for a person. */
const paymentLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export const billingRoutes: FastifyPluginAsyncZod<{ billing: BillingService }> = async (
  app,
  { billing },
) => {
  app.get(
    "/plans",
    {
      schema: {
        tags: ["billing"],
        summary: "Plans, prices (paise), limits and features",
        response: { 200: ok(z.array(planView)) },
      },
    },
    async () => billing.plans(),
  );

  await app.register(async (plain) => {
    const authed = plain.withTypeProvider<ZodTypeProvider>();
    authed.addHook("preHandler", app.requireAuth);

    authed.get(
      "/subscription",
      {
        schema: {
          tags: ["billing"],
          summary: "Your subscription and the plan that applies now",
          security,
          response: { 200: ok(subscriptionView) },
        },
      },
      async (req) => billing.subscription(getAuth(req).userId),
    );

    authed.post(
      "/checkout",
      {
        config: paymentLimit,
        schema: {
          tags: ["billing"],
          summary: "Start buying a paid plan (amount computed by the server)",
          security,
          body: checkoutInput,
          response: { 201: ok(checkoutView) },
        },
      },
      async (req, reply) =>
        reply.status(201).send(await billing.startCheckout(getAuth(req).userId, req.body)),
    );

    authed.get(
      "/checkout/:id",
      {
        schema: {
          tags: ["billing"],
          summary: "A checkout's status",
          security,
          params: idParam,
          response: { 200: ok(checkoutView) },
        },
      },
      async (req) => billing.getCheckout(getAuth(req).userId, req.params.id),
    );

    authed.post(
      "/checkout/:id/confirm",
      {
        config: paymentLimit,
        schema: {
          tags: ["billing"],
          summary: "Verify the payment server-side; the plan is granted from the provider's state",
          security,
          params: idParam,
          body: confirmCheckoutInput,
          response: { 200: ok(checkoutView) },
        },
      },
      async (req) => billing.confirmCheckout(getAuth(req).userId, req.params.id, req.body),
    );

    authed.post(
      "/cancel",
      {
        config: paymentLimit,
        schema: {
          tags: ["billing"],
          summary: "Cancel at the end of the paid period",
          security,
          body: cancelSubscriptionInput,
          response: { 200: ok(subscriptionView) },
        },
      },
      async (req) => billing.cancel(getAuth(req).userId, req.body.reason),
    );

    authed.post(
      "/change-plan",
      {
        config: paymentLimit,
        schema: {
          tags: ["billing"],
          summary: "Upgrade or downgrade (FREE = cancel at period end)",
          security,
          body: changePlanInput,
          response: { 200: ok(subscriptionView) },
        },
      },
      async (req) => billing.changePlan(getAuth(req).userId, req.body),
    );

    authed.get(
      "/payments",
      {
        schema: {
          tags: ["billing"],
          summary: "Your DealMind payments",
          security,
          response: { 200: ok(z.array(paymentView)) },
        },
      },
      async (req) => billing.payments(getAuth(req).userId),
    );

    authed.get(
      "/invoices",
      {
        schema: {
          tags: ["billing"],
          summary: "Your DealMind invoices",
          security,
          response: { 200: ok(z.array(invoiceView)) },
        },
      },
      async (req) => billing.invoices(getAuth(req).userId),
    );
  });
};

export const usageRoutes: FastifyPluginAsyncZod<{ billing: BillingService }> = async (
  app,
  { billing },
) => {
  app.get(
    "/",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["billing"],
        summary: "Your usage against the plan that applies now",
        security,
        response: { 200: ok(usageView) },
      },
    },
    async (req) => billing.usage(getAuth(req).userId),
  );
};

/**
 * POST /webhooks/easydev-payments — the shared payment service's signed
 * webhook. Served outside /api (no browser CSRF; the HMAC signature is the
 * authentication) and parsed as a raw string so the signature covers the
 * exact bytes sent.
 */
export const billingWebhookRoutes: FastifyPluginAsync<{ billing: BillingService }> = async (
  app,
  { billing },
) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  app.post(
    "/easydev-payments",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const sig = req.headers[EASYDEV_SIGNATURE_HEADER];
      const r = await billing.handleWebhook(raw, typeof sig === "string" ? sig : undefined);
      return reply.status(r.status).send(r.body);
    },
  );
};
