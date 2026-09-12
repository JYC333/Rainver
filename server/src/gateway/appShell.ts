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
import type { ServerConfig } from "../config.js";
import { NO_STORE_CACHE_CONTROL } from "./cacheControl.js";
import { registerErrorEnvelopeHandler } from "./errorEnvelope.js";
import { buildLoggerOptions } from "./logging.js";
import {
  REQUEST_ID_HEADER,
  SERVER_MARKER_HEADER,
  SERVER_MARKER_VALUE,
  resolveRequestId,
} from "./requestContext.js";
import { csrfOriginAllowed } from "./csrfOrigin.js";
import { TrustedProxyAddresses } from "./trustedProxy.js";

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
  const trustedProxy = config.trustedProxyHost ? new TrustedProxyAddresses(config.trustedProxyHost) : null;
  const base: FastifyServerOptions = {
    disableRequestLogging: false,
    bodyLimit: SERVER_BODY_LIMIT_BYTES,
    requestIdHeader: REQUEST_ID_HEADER,
    // Forwarded headers are believed from the frontend proxy's address only,
    // and only for its own hop: `request.ip` is the client that proxy saw, and
    // nothing a direct peer (a Run, the deployer) or the client itself claims.
    trustProxy: trustedProxy
      ? (address: string, hop: number) => hop === 0 && trustedProxy.trusts(address)
      : false,
  };

  if (options.loggerInstance !== undefined) {
    base.loggerInstance = options.loggerInstance;
  } else if (options.logger !== undefined) {
    base.logger = options.logger;
  } else {
    base.logger = buildLoggerOptions(config, options.logStream);
  }

  const app = Fastify(base);
  if (trustedProxy) {
    app.addHook("onReady", async () => {
      await trustedProxy.refresh();
      trustedProxy.start();
    });
    app.addHook("onClose", async () => {
      trustedProxy.stop();
    });
  }

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
export function registerGatewayConventions(app: FastifyInstance, config: ServerConfig): void {
  registerErrorEnvelopeHandler(app);
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, resolveRequestId(request));
    reply.header(SERVER_MARKER_HEADER, SERVER_MARKER_VALUE);
    if (!csrfOriginAllowed(request, config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-origin request blocked" });
    }
  });
  app.addHook("onSend", async (request, reply) => {
    // Every API response is somebody's private content answered against their
    // session cookie. Without an explicit directive a shared proxy, or the
    // browser's own back/forward cache, may keep it and hand it to whoever
    // asks next on that machine — which is the residue logout is trying to
    // clear. One hook rather than per-route headers, because the rule is about
    // the whole surface and a route that forgot it would be invisible.
    //
    // Set here rather than with an nginx `add_header` on the API location:
    // nginx *replaces* the inherited `add_header` set in a location that uses
    // one, so adding it there would silently drop every security header from
    // API responses.
    //
    // A stream that writes its own header block with `reply.raw.writeHead` has
    // already flushed it by the time this runs, so setting a header here would
    // do nothing; those use `sseResponseHeaders`, which carries the same
    // directive.
    if (request.url.startsWith("/api/")) reply.header("cache-control", NO_STORE_CACHE_CONTROL);
  });
}

/** Unknown API catch-all. Must be registered last so explicitly owned routes win. */
export function registerUnknownApiRoute(app: FastifyInstance): void {
  app.all("/api/v1/*", async (_request, reply) =>
    reply.code(404).send({ detail: "Route not found" }),
  );
}
