/**
 * Logger options for the server.
 *
 * Centralizes the secret-hygiene rules: the Fastify default `req` serializer
 * already omits headers and bodies; the redact paths below are defense in depth
 * so Authorization/Cookie values can never reach a log line even if a
 * serializer changes. Request and response bodies are never logged anywhere in
 * the server.
 */

import type { FastifyServerOptions } from "fastify";
import type { ServerConfig } from "../config.js";

/** Header paths that must never appear in logs. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
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
    ...(stream ? { stream } : {}),
  };
}
