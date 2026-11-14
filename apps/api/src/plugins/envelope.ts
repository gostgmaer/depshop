/**
 * Wraps every successful /api/v1 JSON response in the standard envelope:
 *   { success: true, data, meta: { requestId, pagination? } }
 * Runs before serialization, so route response schemas (built with ok()/page())
 * validate the enveloped body. Errors are enveloped by the error handler.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Paginated } from "../utils/http.js";

function isEnveloped(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "success" in payload && "meta" in payload;
}

export const envelopePlugin = fp(
  (app: FastifyInstance, _opts, done) => {
    app.addHook("preSerialization", async (request, reply, payload: unknown) => {
      if (!request.url.startsWith("/api/") || reply.statusCode === 204 || isEnveloped(payload)) {
        return payload;
      }
      if (payload instanceof Paginated) {
        return {
          success: true,
          data: payload.items,
          meta: { requestId: request.id, pagination: payload.pagination },
        };
      }
      return { success: true, data: payload, meta: { requestId: request.id } };
    });
    done();
  },
  { name: "envelope" },
);
