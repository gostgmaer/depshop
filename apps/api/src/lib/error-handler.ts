import { Prisma } from "@dealmind/db";
import { AppError, ErrorCode, type ErrorResponseBody } from "@dealmind/shared";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ZodError } from "zod";

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ErrorResponseBody = {
    error: { code, message, requestId: request.id, ...(details === undefined ? {} : { details }) },
  };
  return reply.status(status).send(body);
}

/**
 * Centralized error handling. Every error leaves the API in the same envelope:
 * `{ error: { code, message, details?, requestId } }`. Internal error details
 * are logged but never returned to clients.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    send(
      reply,
      request,
      404,
      ErrorCode.NOT_FOUND,
      `Route ${request.method} ${request.url} not found`,
    ),
  );

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
      return send(reply, request, error.statusCode, error.code, error.message, error.details);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return send(reply, request, 422, ErrorCode.VALIDATION_FAILED, "Request validation failed", {
        issues: error.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
        })),
      });
    }

    if (error instanceof ZodError) {
      return send(reply, request, 422, ErrorCode.VALIDATION_FAILED, "Validation failed", {
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return send(reply, request, 409, ErrorCode.CONFLICT, "Resource already exists");
      }
      if (error.code === "P2025") {
        return send(reply, request, 404, ErrorCode.NOT_FOUND, "Resource not found");
      }
    }

    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    if (statusCode === 429) {
      return send(reply, request, 429, ErrorCode.RATE_LIMITED, "Too many requests");
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      // Fastify-native client errors (malformed JSON, payload too large, ...).
      return send(reply, request, statusCode, ErrorCode.BAD_REQUEST, error.message);
    }

    request.log.error({ err: error }, "Unhandled error");
    return send(reply, request, 500, ErrorCode.INTERNAL, "Internal server error");
  });
}
