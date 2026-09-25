import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "../../config.js";
import { authCookieHeader } from "./authCookie.js";

const COOKIE = "rainver.reauth";
const MAX_AGE_SECONDS = 10 * 60;

function cookieValue(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE || rest.length === 0) continue;
    return decodeURIComponent(rest.join("="));
  }
  return null;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function setReauthGrant(reply: FastifyReply, config: ServerConfig, userId: string): void {
  if (!config.betterAuthSecret) return;
  const payload = `${userId}.${Date.now() + MAX_AGE_SECONDS * 1000}.${randomBytes(12).toString("base64url")}`;
  const value = `${payload}.${signature(payload, config.betterAuthSecret)}`;
  reply.header("set-cookie", authCookieHeader(config, { name: COOKIE, value, maxAgeSeconds: MAX_AGE_SECONDS }));
}

export function recentReauthExpiresAt(request: FastifyRequest, config: ServerConfig, userId: string): number | null {
  if (!config.betterAuthSecret) return null;
  const value = cookieValue(Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie);
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [grantUserId, expiresAt, nonce, supplied] = parts;
  if (grantUserId !== userId || !nonce || Number(expiresAt) <= Date.now() || !Number.isFinite(Number(expiresAt))) return null;
  const expected = signature(`${grantUserId}.${expiresAt}.${nonce}`, config.betterAuthSecret);
  try { return timingSafeEqual(Buffer.from(supplied!), Buffer.from(expected)) ? Number(expiresAt) : null; } catch { return null; }
}

export function hasRecentReauth(request: FastifyRequest, config: ServerConfig, userId: string): boolean {
  return recentReauthExpiresAt(request, config, userId) !== null;
}

export function clearReauthGrant(reply: FastifyReply, config: ServerConfig): void {
  reply.header("set-cookie", authCookieHeader(config, { name: COOKIE, value: "", maxAgeSeconds: 0 }));
}
