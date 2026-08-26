/**
 * Error envelope convention for server-owned routes.
 *
 * Every error a server-owned route returns uses one JSON shape:
 *
 *     { "error": "<machine_code>", "message": "<human text>", "request_id": "..." }
 *
 * Errors returned to clients must never leak upstream internals, stack traces,
 * headers, tokens, cookies, or request/response bodies. Server errors (5xx) get
 * a fixed generic message; client errors (4xx) keep their intentional,
 * client-safe message.
 *
 * Unknown API routes are handled separately by the gateway catch-all.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveRequestId } from "./requestContext.js";

export interface ErrorEnvelope {
  error: string;
  message: string;
  request_id?: string;
}

/** Build the standard envelope for a server-owned route error. */
export function errorEnvelope(
  error: string,
  message: string,
  requestId?: string,
): ErrorEnvelope {
  const body: ErrorEnvelope = { error, message };
  if (requestId !== undefined) body.request_id = requestId;
  return body;
}

/** Send an envelope from a server-owned route handler. */
export function sendErrorEnvelope(
  reply: FastifyReply,
  statusCode: number,
  body: ErrorEnvelope,
): FastifyReply {
  return reply.code(statusCode).send(body);
}

const INTERNAL_ERROR: Pick<ErrorEnvelope, "error" | "message"> = {
  error: "internal_error",
  message: "Internal server error",
};

interface ErrorLogFields {
  error_message?: string;
  error_code?: string;
  db_constraint?: string;
  db_table?: string;
  db_column?: string;
}

function boundedString(value: unknown, maxLength = 1000): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Keep the client-facing error generic while making uncaught failures useful
 * to the operator. PostgreSQL exposes the structured fields below on its
 * errors; recording them avoids the previous `reason: "Error"` dead end
 * without logging request bodies, headers, or credentials.
 */
function errorLogFields(error: unknown): ErrorLogFields {
  const known = error as {
    message?: unknown;
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
    column?: unknown;
  };
  return {
    error_message: boundedString(known.message),
    error_code: boundedString(known.code, 100),
    db_constraint: boundedString(known.constraint, 200),
    db_table: boundedString(known.table, 200),
    db_column: boundedString(known.column, 200),
  };
}

/**
 * Install the app-wide error handler that converts uncaught server-owned route
 * errors into the envelope.
 */
export function registerErrorEnvelopeHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request: FastifyRequest, reply: FastifyReply) => {
    const known = err as { statusCode?: unknown; name?: unknown; message?: unknown };
    const statusCode =
      typeof known.statusCode === "number" &&
      known.statusCode >= 400 &&
      known.statusCode < 600
        ? known.statusCode
        : 500;
    // Never echo internal error text (or anything a handler embedded in it) for
    // server errors; 4xx messages are intentional, client-safe text.
    const safe =
      statusCode >= 500
        ? INTERNAL_ERROR
        : {
            error: "request_error",
            message: typeof known.message === "string" ? known.message : "Bad request",
          };
    const requestId = resolveRequestId(request);
    // Keep the response generic, but log the server-side cause at error level.
    // The previous implementation put the useful error only at debug level,
    // which made production failures look indistinguishable from one another.
    request.log.error(
      {
        err,
        reason: typeof known.name === "string" ? known.name : "Error",
        statusCode,
        request_id: requestId,
        ...errorLogFields(err),
      },
      "server-owned route error",
    );
    return sendErrorEnvelope(
      reply,
      statusCode,
      errorEnvelope(safe.error, safe.message, requestId),
    );
  });
}
