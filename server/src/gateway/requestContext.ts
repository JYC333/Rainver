/**
 * Per-request context helpers for the server gateway entry layer.
 *
 * The "gateway" is the permanent entry/routing layer of the server.
 * These helpers carry the cross-cutting request metadata — request id
 * continuity, safe header access, and the server marker header — that
 * every server path shares.
 *
 * This file is metadata only. Native auth resolution lives in modules/auth and
 * only publishes the resulting user/space identifiers into request context.
 */

import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

/** Standard correlation id header, preserved end-to-end. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Marker stamped on requests/responses that passed through the server. It
 * is trace metadata only — never a grant of trust.
 */
export const SERVER_MARKER_HEADER = "x-rainver-server";
export const SERVER_MARKER_VALUE = "server";

/**
 * Headers that carry secrets. `readHeader` refuses to return them so that
 * context/log helpers can never accidentally surface a credential.
 */
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Preserve an incoming `x-request-id`, or generate one if absent. */
export function resolveRequestId(request: FastifyRequest): string {
  const incoming = request.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value || randomUUID();
}

/**
 * Read a single non-sensitive header value. Returns `undefined` for absent
 * headers and for the sensitive set (Authorization, Cookie, …) — those must
 * never flow through context helpers, error bodies, or logs.
 */
export function readHeader(request: FastifyRequest, name: string): string | undefined {
  const key = name.toLowerCase();
  if (SENSITIVE_HEADERS.has(key)) return undefined;
  const value = request.headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Client-facing request metadata shared by server-owned routes. Auth modules may
 * attach authenticated identity after validating a session cookie; raw credentials
 * never belong in this object.
 */
export interface RequestContext {
  /** Preserved or generated correlation id for this request. */
  requestId: string;
  method: string;
  /** Raw path + query string as received. */
  path: string;
  /** Authenticated identity, populated only after auth resolution. */
  identity?: AuthenticatedIdentity;
}

export interface AuthenticatedIdentity {
  spaceId: string;
  userId: string;
}

/** Build the standard request context for a server-owned route handler. */
export function buildRequestContext(request: FastifyRequest): RequestContext {
  return {
    requestId: resolveRequestId(request),
    method: request.method,
    path: request.url,
  };
}
