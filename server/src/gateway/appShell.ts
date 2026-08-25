/**
 * The Fastify instance and gateway conventions every server-owned route sits
 * behind, separated from the list of modules that get registered on it.
 *
 * `buildServer` composes the full application from these. Tests that exercise
 * one module's routes compose the same shell with only that module, so they
 * get identical body parsing, error envelopes, and request-id headers without
 * loading every module in the registry.
 */

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { ServerConfig } from "../config";
import { registerErrorEnvelopeHandler } from "./errorEnvelope";
import { buildLoggerOptions } from "./logging";
import {
  REQUEST_ID_HEADER,
  SERVER_MARKER_HEADER,
  SERVER_MARKER_VALUE,
  resolveRequestId,
} from "./requestContext";

const SERVER_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export interface ServerAppOptions {
  /** Override/disable the built-in logger options (tests pass `false`). */
  logger?: FastifyServerOptions["logger"];
  /** Inject a custom logger instance (advanced; bypasses the built-in serializers). */
  loggerInstance?: FastifyBaseLogger;
  /**
   * Redirect the *built-in* logger to a custom destination, keeping the default
   * serializers + redaction. Tests use this to assert secrets never reach logs.
   */
  logStream?: NodeJS.WritableStream;
}

/** A bare instance with the server's body handling and logger, no routes. */
export function createServerApp(config: ServerConfig, options: ServerAppOptions = {}): FastifyInstance {
  const base: FastifyServerOptions = {
    disableRequestLogging: false,
    bodyLimit: SERVER_BODY_LIMIT_BYTES,
    // The server sits behind the frontend proxy / browser; trust forwarded
    // info only for request-id continuity, not for auth decisions.
    requestIdHeader: REQUEST_ID_HEADER,
  };

  if (options.loggerInstance !== undefined) {
    base.loggerInstance = options.loggerInstance;
  } else if (options.logger !== undefined) {
    base.logger = options.logger;
  } else {
    base.logger = buildLoggerOptions(config, options.logStream);
  }

  const app = Fastify(base);

  // Treat every request body as an opaque buffer. Server-owned POST routes parse only
  // the bodies they explicitly own.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  return app;
}

/**
 * Cross-cutting gateway conventions: the error envelope for server-owned route
 * errors, and request-id continuity on every response.
 */
export function registerGatewayConventions(app: FastifyInstance): void {
  registerErrorEnvelopeHandler(app);
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, resolveRequestId(request));
    reply.header(SERVER_MARKER_HEADER, SERVER_MARKER_VALUE);
  });
}

/** Unknown API catch-all. Must be registered last so explicitly owned routes win. */
export function registerUnknownApiRoute(app: FastifyInstance): void {
  app.all("/api/v1/*", async (_request, reply) =>
    reply.code(404).send({ detail: "Route not found" }),
  );
}
