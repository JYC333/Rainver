/**
 * Logger options for the server.
 *
 * Centralizes the secret-hygiene rules: the `req` serializer below reduces a
 * request to method, path and peer and omits headers, bodies and the query
 * string; the redact paths are defense in depth so Authorization/Cookie values
 * can never reach a log line even if a serializer changes. Request and response
 * bodies are never logged anywhere in the server.
 */

import type { FastifyRequest, FastifyServerOptions } from "fastify";
import type { ServerConfig } from "../config.js";

/**
 * Fastify's default `req` serializer logs `req.url` with its query string. An
 * OAuth callback carries its authorization code and state there, and a search
 * route carries what was searched for, so the line keeps the path only.
 */
export function logRequestPath(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: logRequestPath(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * Header paths that must never appear in logs.
 *
 * pino matches a path exactly — there is no substring rule here — so every
 * spelling a vendor uses has to be listed. `proxy-authorization` is a separate
 * header from `authorization`, and Google sends its key as `x-goog-api-key`;
 * both went to the log in full.
 */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers['proxy-authorization']",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['api-key']",
  "req.headers['x-goog-api-key']",
  "req.headers['anthropic-auth-token']",
  "req.headers['x-rainver-internal-token']",
  "res.headers['set-cookie']",
] as const;

/**
 * Build the built-in logger options (level + redaction). `stream` lets tests
 * capture exactly what the production logger would emit.
 */
export function buildLoggerOptions(
  config: ServerConfig,
  stream?: NodeJS.WritableStream,
): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    level: config.logLevel,
    redact: { paths: [...LOG_REDACT_PATHS], remove: true },
    serializers: { req: serializeRequestForLog },
    ...(stream ? { stream } : {}),
  };
}
