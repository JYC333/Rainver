import type { FastifyReply, FastifyRequest } from "fastify";
import { request as undiciRequest } from "undici";
import type { ServerConfig } from "../../config.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { resolveRequestId } from "../../gateway/requestContext.js";

const SUPPORTED_EVENT_TYPES = new Set(["proposal.pending"]);

export interface NotificationWebhookPolicy {
  enabled: boolean;
  allowed_targets: number;
  supported_event_types: string[];
  max_payload_bytes: number;
}

interface WebhookDispatchBody {
  target_url: string;
  event_type: string;
  payload: unknown;
}

export interface WebhookPolicyDecision {
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

function errKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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

function parseJsonBody(body: unknown): unknown {
  if (!(body instanceof Buffer)) return body;
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function asDispatchBody(value: unknown): WebhookDispatchBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.target_url !== "string") return undefined;
  if (typeof record.event_type !== "string") return undefined;
  return {
    target_url: record.target_url,
    event_type: record.event_type,
    payload: record.payload,
  };
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

export async function dispatchWebhookRoute(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const requestId = resolveRequestId(request);
  if (request.body instanceof Buffer && request.body.length > config.notificationMaxPayloadBytes) {
    return sendErrorEnvelope(
      reply,
      413,
      errorEnvelope(
        "notification_payload_too_large",
        "Notification webhook payload is too large",
        requestId,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(request.body);
  } catch {
    return sendErrorEnvelope(
      reply,
      400,
      errorEnvelope("invalid_json_body", "Request body must be valid JSON", requestId),
    );
  }

  const body = asDispatchBody(parsed);
  if (!body) {
    return sendErrorEnvelope(
      reply,
      400,
      errorEnvelope(
        "invalid_notification_webhook_request",
        "Request must include target_url and event_type",
        requestId,
      ),
    );
  }

  const decision = evaluateWebhookPolicy(config, body);
  if (!decision.allowed || !decision.normalizedTargetUrl || !decision.targetOrigin) {
    return sendErrorEnvelope(
      reply,
      decision.statusCode,
      errorEnvelope(
        decision.error ?? "notification_webhook_denied",
        decision.message ?? "Notification webhook denied",
        requestId,
      ),
    );
  }

  const outboundBody = JSON.stringify({
    event_type: body.event_type,
    payload: body.payload ?? null,
  });
  if (Buffer.byteLength(outboundBody, "utf8") > config.notificationMaxPayloadBytes) {
    return sendErrorEnvelope(
      reply,
      413,
      errorEnvelope(
        "notification_payload_too_large",
        "Notification webhook payload is too large",
        requestId,
      ),
    );
  }

  try {
    const upstream = await undiciRequest(decision.normalizedTargetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "rainver-server",
      },
      body: outboundBody,
      maxRedirections: 0,
      signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 30_000)),
    });
    await drainResponseBody(upstream.body);
    const delivered = upstream.statusCode >= 200 && upstream.statusCode < 300;
    return reply.code(delivered ? 202 : 502).send({
      delivered,
      target_origin: decision.targetOrigin,
      upstream_status: upstream.statusCode,
    });
  } catch (err) {
    request.log.warn(
      { target_origin: decision.targetOrigin, reason: errKind(err) },
      "notification webhook dispatch failed",
    );
    return sendErrorEnvelope(
      reply,
      502,
      errorEnvelope(
        "notification_webhook_unavailable",
        "Notification webhook target is unavailable",
        requestId,
      ),
    );
  }
}
