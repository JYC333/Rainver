import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";

export const INTERNAL_TOKEN_HEADER = "x-agent-space-internal-token";

export function checkInternalToken(
  config: ServerConfig,
  request: FastifyRequest,
): boolean {
  const token = request.headers[INTERNAL_TOKEN_HEADER];
  if (typeof token !== "string" || token.length === 0 || !config.internalToken) return false;
  const presented = Buffer.from(token);
  const expected = Buffer.from(config.internalToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
