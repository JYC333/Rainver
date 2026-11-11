import { request as undiciRequest } from "undici";
import type { ServerConfig } from "../../config.js";

const SUPPORTED_EVENT_TYPES = new Set(["proposal.pending"]);

export interface NotificationWebhookPolicy {
  enabled: boolean;
  allowed_targets: number;
  supported_event_types: string[];
  max_payload_bytes: number;
}

export interface WebhookDispatchBody {
  target_url: string;
  event_type: string;
  payload: unknown;
}

interface WebhookPolicyDecision {
  allowed: boolean;
  statusCode: number;
  error?: string;
  message?: string;
  normalizedTargetUrl?: string;
  targetOrigin?: string;
}

export function notificationWebhookPolicy(
  config: ServerConfig,
): NotificationWebhookPolicy {
  return {
    enabled: config.enableNotificationWebhookEgress,
    allowed_targets: config.notificationWebhookAllowlist.length,
    supported_event_types: [...SUPPORTED_EVENT_TYPES].sort(),
    max_payload_bytes: config.notificationMaxPayloadBytes,
  };
}

function isLocalHttpWebhookHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function normalizeNotificationWebhookUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.protocol === "http:" && !isLocalHttpWebhookHost(url.hostname)) {
      return undefined;
    }
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function evaluateWebhookPolicy(
  config: ServerConfig,
  body: WebhookDispatchBody,
): WebhookPolicyDecision {
  if (!config.enableNotificationWebhookEgress) {
    return {
      allowed: false,
      statusCode: 403,
      error: "notification_webhook_egress_disabled",
      message: "Notification webhook egress is disabled",
    };
  }
  if (!SUPPORTED_EVENT_TYPES.has(body.event_type)) {
    return {
      allowed: false,
      statusCode: 422,
      error: "unsupported_notification_event_type",
      message: "Unsupported notification event type",
    };
  }
  const normalized = normalizeNotificationWebhookUrl(body.target_url);
  if (!normalized || !config.notificationWebhookAllowlist.includes(normalized)) {
    return {
      allowed: false,
      statusCode: 403,
      error: "notification_webhook_target_denied",
      message: "Notification webhook target is not allowed",
    };
  }
  return {
    allowed: true,
    statusCode: 202,
    normalizedTargetUrl: normalized,
    targetOrigin: new URL(normalized).origin,
  };
}

async function drainResponseBody(body: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of body) {
    // Drain without retaining the upstream body.
  }
}

/**
 * `notification_webhook` system command effect (`operations.ts`): one POST of
 * `{event_type, payload}` to an allowlisted target, no redirects, bounded
 * timeout, response body drained and discarded. The policy is evaluated again
 * here, just before the send. `transport` is the test seam (a fake target).
 */
export type WebhookTransport = (url: string, body: string, timeoutMs: number) => Promise<{ statusCode: number }>;
let transportOverride: WebhookTransport | null = null;
export function __setNotificationWebhookTransportForTests(transport: WebhookTransport | null): void {
  transportOverride = transport;
}
export async function sendNotificationWebhook(
  config: ServerConfig,
  body: WebhookDispatchBody,
): Promise<{ ok: true; result: { delivered: boolean; target_origin: string; upstream_status: number } } | { ok: false; code: string; detail: string }> {
  const decision = evaluateWebhookPolicy(config, body);
  if (!decision.allowed || !decision.normalizedTargetUrl || !decision.targetOrigin) {
    return { ok: false, code: decision.error ?? "notification_webhook_denied", detail: decision.message ?? "Notification webhook denied" };
  }
  const outboundBody = JSON.stringify({ event_type: body.event_type, payload: body.payload ?? null });
  if (Buffer.byteLength(outboundBody, "utf8") > config.notificationMaxPayloadBytes) {
    return { ok: false, code: "notification_payload_too_large", detail: "Notification webhook payload is too large" };
  }
  const timeoutMs = Math.min(config.requestTimeoutMs, 30_000);
  const send: WebhookTransport = transportOverride ?? (async (url, outbound, timeout) => {
    const upstream = await undiciRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "rainver-server" },
      body: outbound,
      maxRedirections: 0,
      signal: AbortSignal.timeout(timeout),
    });
    await drainResponseBody(upstream.body);
    return { statusCode: upstream.statusCode };
  });
  const upstream = await send(decision.normalizedTargetUrl, outboundBody, timeoutMs);
  return { ok: true, result: { delivered: upstream.statusCode >= 200 && upstream.statusCode < 300, target_origin: decision.targetOrigin, upstream_status: upstream.statusCode } };
}
