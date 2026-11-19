/**
 * First-run setup (public; see setup-service.ts):
 *   GET  /setup        { required }   whether the first administrator still has to be set up
 *   POST /setup/admin  token + name, e-mail, password: claims the first-admin slot (single use)
 */
import { setupAdminInput, setupStatus } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ok } from "../../utils/http.js";
import type { SetupService } from "./setup-service.js";

export const setupRoutes: FastifyPluginAsyncZod<{ setup: SetupService }> = async (
  app,
  { setup },
) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["setup"],
        summary: "Whether the first administrator still has to be set up",
        response: { 200: ok(setupStatus) },
      },
    },
    async () => ({ required: await setup.required() }),
  );

  app.post(
    "/admin",
    {
      // Guessing the token is the attack: very few attempts per IP.
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        tags: ["setup"],
        summary:
          "Create the first administrator (one-time setup token). The account becomes ADMIN at its first sign-in.",
        body: setupAdminInput,
        response: { 202: ok(z.object({ email: z.string(), existingAccount: z.boolean() })) },
      },
    },
    async (req, reply) => {
      const { token, ...account } = req.body;
      return reply.status(202).send(await setup.claim(token, account));
    },
  );
};
