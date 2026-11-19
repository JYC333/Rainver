/**
 * Gmail HTTP surface: owner-only, `private, no-store`, `no-referrer`.
 *
 * - `GET  /api/v1/sources/gmail/connections` — the caller's connections in the active Space
 * - `POST /api/v1/sources/gmail/oauth/start` — a new single-use attempt; returns Google's URL
 * - `GET  /api/v1/sources/gmail/oauth/callback` — the fixed redirect URI; consumes the attempt once
 *   and redirects to `/sources?gmail=<fixed result code>` (no code, token or id in the URL)
 * - `POST /api/v1/sources/gmail/connections/:connectionId/disconnect` — `source.gmail.connection.disconnect`
 * - `DELETE /api/v1/sources/gmail/connections/:connectionId` — `source.gmail.connection.forget`
 *
 * - `DELETE /api/v1/sources/gmail/selections/:selectionId` — `source.gmail.selection.remove` (legacy references)
 * - `GET  /api/v1/sources/gmail/selections[?project_id=&connection_id=]` — the caller's own legacy selections
 * - `POST /api/v1/sources/gmail/selections/:selectionId/read` — one page of a legacy selected thread
 * - `GET  /api/v1/sources/gmail/read-audit` — the caller's own owner-read audit
 *
 * Gmail V2 monitoring:
 * - `GET  /api/v1/sources/gmail/monitors` — the caller's monitors, content-free sync status, recent match links
 * - `POST /api/v1/sources/gmail/monitors/:monitorId/status` — `source.gmail.monitor.set_status`
 * - `DELETE /api/v1/sources/gmail/monitors/:monitorId` — `source.gmail.monitor.delete`
 * - `GET  /api/v1/sources/gmail/digests` — the caller's scheduled digests (ADR 0033 phase B), content-free
 * - `POST /api/v1/sources/gmail/digests/:digestId/status` — `source.gmail.digest.set_status`
 * - `POST /api/v1/sources/gmail/digests/:digestId/end` — `source.gmail.digest.end`
 * - `POST /api/v1/sources/gmail/push` — Pub/Sub push intake (`gmailPush.ts`): OIDC-verified wake-up only
 *
 * The manual thread search and `POST /selections` (add) were retired with
 * Gmail V2; monitors are created only by the owner accepting a proposal.
 *
 * Operation adapters are plain: the operation itself (also reachable through
 * `POST /api/v1/actions/:opId`) owns the write, so every entry behaves the
 * same. Nothing here revokes a Google grant.
 *
 * The thread read is POST so cursors never sit in a URL (an exact transport
 * exemption: a core query cannot do external IO or write the audit, and a
 * retained command result would store mail). Its body is serialized only after
 * `gmailMailReads.ts` committed the audit row; errors carry a fixed `gmail_*`
 * code and never echo input, Google ids or upstream text. No route here is an
 * Agent tool; Rooms and Runs cannot reach mail.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GmailConnectionListSchema, GmailDigestListSchema, GmailMonitorListSchema, GmailOAuthStartInputSchema, GmailReadAuditListSchema, GmailThreadReadInputSchema,
  GmailThreadReadOutputSchema, GmailThreadSelectionListSchema, type GmailConnectionList,
} from "@rainver/protocol";
import { GMAIL_OAUTH_CALLBACK_PATH, GMAIL_PUSH_PATH } from "../../../config.js";
import { withQueryableTransaction } from "../../routeUtils/common.js";
import { listGmailMonitors, requestGmailMailboxSync } from "./gmailMonitors.js";
import { listGmailDigests } from "./gmailDigests.js";
import { GMAIL_PUSH_BODY_LIMIT, gmailPushMailbox, verifyGmailPushToken } from "./gmailPush.js";
import type { ModuleContext } from "../../../gateway/routeRegistry.js";
import { resolveRequestId } from "../../../gateway/requestContext.js";
import { introspectIdentity, introspectPersonIdentity } from "../../auth/identity.js";
import { dbPool, jsonBody } from "../../routeUtils/common.js";
import { OperationError } from "../../systemActions/operations/errors.js";
import { registerOperationAdapters } from "../../systemActions/operations/routeAdapter.js";
import { listGmailConnections } from "./gmailConnections.js";
import { GmailReadError } from "./gmailReadAuthority.js";
import { readGmailThread } from "./gmailMailReads.js";
import { listGmailReadAuditBounded, listGmailSelectionsBounded } from "./gmailSelections.js";
import { gmailPageScope } from "./gmailReadDeadline.js";
import { completeGmailOAuth, GmailLifecycleError, startGmailOAuth } from "./gmailOAuthFlow.js";

function noStore(reply: FastifyReply, requestId: string): FastifyReply {
  return reply.header("x-request-id", requestId).header("cache-control", "private, no-store").header("referrer-policy", "no-referrer");
}

const ID = /^[A-Za-z0-9-]{1,36}$/;

/** Aborts when the client goes away before the response is written. */
function clientSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => { if (!reply.raw.writableFinished) controller.abort(); });
  return controller.signal;
}

export function registerGmailRoutes(app: FastifyInstance, context: ModuleContext): void {
  const { config } = context;
  const identityOr = async (request: FastifyRequest, reply: FastifyReply, requestId: string) => {
    const identity = await introspectIdentity(config, request, reply);
    if (identity.ok) return identity;
    const error = identity.reason === "denied" ? new OperationError(identity.statusCode === 401 ? "authentication_required" : "operation_not_found", identity.statusCode === 401 ? 401 : 404) : new OperationError("operation_temporarily_unavailable", 503, true);
    void reply.code(error.httpStatus).send(error.body(requestId));
    return null;
  };
  const readFailure = (reply: FastifyReply, requestId: string, error: unknown) => {
    const known = error instanceof GmailReadError ? error : new GmailReadError(503, "gmail_upstream_error");
    return reply.code(known.status).send({ error: { code: known.code, request_id: requestId, ...known.retryAt ? { retry_at: known.retryAt } : {} } });
  };
  const invalid = (reply: FastifyReply, requestId: string) => reply.code(422).send(new OperationError("operation_invalid_input", 422).body(requestId));

  app.get("/api/v1/sources/gmail/selections", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await identityOr(request, reply, requestId);
    if (!identity) return reply;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const pick = (value: unknown) => typeof value === "string" && ID.test(value) ? value : undefined;
    if ((query.project_id !== undefined && !pick(query.project_id)) || (query.connection_id !== undefined && !pick(query.connection_id))) return invalid(reply, requestId);
    try {
      const selections = await listGmailSelectionsBounded(gmailPageScope(config, dbPool(config), clientSignal(reply)), identity, { projectId: pick(query.project_id), connectionId: pick(query.connection_id) });
      return reply.send(GmailThreadSelectionListSchema.parse({ selections }));
    } catch (error) { return readFailure(reply, requestId, error); }
  });

  app.get("/api/v1/sources/gmail/read-audit", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await identityOr(request, reply, requestId);
    if (!identity) return reply;
    try {
      return reply.send(GmailReadAuditListSchema.parse({ events: await listGmailReadAuditBounded(gmailPageScope(config, dbPool(config), clientSignal(reply)), identity) }));
    } catch (error) { return readFailure(reply, requestId, error); }
  });

  app.get("/api/v1/sources/gmail/monitors", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await identityOr(request, reply, requestId);
    if (!identity) return reply;
    return reply.send(GmailMonitorListSchema.parse(await listGmailMonitors(dbPool(config), config, identity)));
  });

  app.get("/api/v1/sources/gmail/digests", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await identityOr(request, reply, requestId);
    if (!identity) return reply;
    return reply.send(GmailDigestListSchema.parse(await listGmailDigests(dbPool(config), identity)));
  });

  // Pub/Sub push: a Google-signed wake-up for the named mailbox, never content and never a cursor.
  app.post(GMAIL_PUSH_PATH, { bodyLimit: GMAIL_PUSH_BODY_LIMIT }, async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const push = config.gmailPush;
    if (!push) return reply.code(404).send(new OperationError("operation_not_found", 404).body(requestId));
    if (!(await verifyGmailPushToken(push, request.headers.authorization))) {
      return reply.code(401).send({ error: { code: "gmail_push_unauthenticated", request_id: requestId } });
    }
    let mailbox: string | null = null;
    try { mailbox = gmailPushMailbox(push, request.body === undefined ? null : jsonBody(request)); } catch { mailbox = null; }
    if (mailbox) {
      const pool = dbPool(config);
      const targets = (await pool.query<{ id: string }>(
        `SELECT c.id FROM gmail_connections c JOIN gmail_mailbox_sync_states s ON s.gmail_connection_id=c.id
          WHERE lower(c.mailbox_email)=$1 AND c.status='active'
            AND EXISTS (SELECT 1 FROM gmail_monitor_rules r WHERE r.gmail_connection_id=c.id AND r.status='active')
          ORDER BY c.id LIMIT 20`, [mailbox])).rows;
      for (const target of targets) await withQueryableTransaction(pool, (tx) => requestGmailMailboxSync(tx, target.id, "push"));
    }
    // Acknowledged whatever it named: a redelivery could only repeat the same wake-up.
    return reply.code(204).send();
  });

  app.post("/api/v1/sources/gmail/selections/:selectionId/read", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await identityOr(request, reply, requestId);
    if (!identity) return reply;
    const selectionId = (request.params as { selectionId?: string }).selectionId ?? "";
    let parsed;
    try { parsed = GmailThreadReadInputSchema.safeParse(request.body === undefined ? {} : jsonBody(request)); } catch { return invalid(reply, requestId); }
    if (!parsed.success || !ID.test(selectionId)) return invalid(reply, requestId);
    try {
      const out = await readGmailThread(config, dbPool(config), {
        spaceId: identity.spaceId, userId: identity.userId, selectionId, cursor: parsed.data.cursor, requestId, signal: clientSignal(reply),
      });
      return reply.send(GmailThreadReadOutputSchema.parse(out));
    } catch (error) { return readFailure(reply, requestId, error); }
  });

  app.get("/api/v1/sources/gmail/connections", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await introspectIdentity(config, request, reply);
    if (!identity.ok) {
      const error = identity.reason === "denied" ? new OperationError(identity.statusCode === 401 ? "authentication_required" : "operation_not_found", identity.statusCode === 401 ? 401 : 404) : new OperationError("operation_temporarily_unavailable", 503, true);
      return reply.code(error.httpStatus).send(error.body(requestId));
    }
    const body: GmailConnectionList = { configured: config.gmailOAuth !== null, connections: await listGmailConnections(dbPool(config), identity) };
    return reply.send(GmailConnectionListSchema.parse(body));
  });

  app.post("/api/v1/sources/gmail/oauth/start", async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const identity = await introspectIdentity(config, request, reply);
    if (!identity.ok) {
      const error = identity.reason === "denied" ? new OperationError(identity.statusCode === 401 ? "authentication_required" : "operation_not_found", identity.statusCode === 401 ? 401 : 404) : new OperationError("operation_temporarily_unavailable", 503, true);
      return reply.code(error.httpStatus).send(error.body(requestId));
    }
    let input: { reconnect_connection_id?: string };
    try {
      const parsed = GmailOAuthStartInputSchema.safeParse(request.body === undefined ? {} : jsonBody(request));
      if (!parsed.success) throw new Error("invalid");
      input = parsed.data;
    } catch {
      const error = new OperationError("operation_invalid_input", 422);
      return reply.code(422).send(error.body(requestId));
    }
    try {
      return reply.send(await startGmailOAuth(config, dbPool(config), { spaceId: identity.spaceId, userId: identity.userId, reconnectConnectionId: input.reconnect_connection_id ?? null }));
    } catch (error) {
      if (error instanceof GmailLifecycleError) return reply.code(error.statusCode).send({ error: { code: error.code, request_id: requestId } });
      const known = error instanceof OperationError ? error : new OperationError("operation_temporarily_unavailable", 503, true);
      return reply.code(known.httpStatus).send(known.body(requestId));
    }
  });

  app.get(GMAIL_OAUTH_CALLBACK_PATH, async (request, reply) => {
    const requestId = resolveRequestId(request);
    noStore(reply, requestId);
    const query = (request.query ?? {}) as Record<string, unknown>;
    let userId: string | null = null;
    try {
      const identity = await introspectPersonIdentity(config, request, reply);
      userId = identity.ok ? identity.userId : null;
    } catch { userId = null; }
    let result: string;
    try {
      result = await completeGmailOAuth(config, dbPool(config), { userId, state: query.state, code: query.code, error: query.error });
    } catch {
      // Never echo the query (code/state) or an upstream message.
      result = "gmail_connection_unavailable";
    }
    const target = new URL("/sources", config.frontendUrl);
    target.searchParams.set("gmail", result);
    return reply.redirect(target.toString(), 303);
  });

  registerOperationAdapters(app, config, [
    { method: "POST", url: "/api/v1/sources/gmail/connections/:connectionId/disconnect", operation: "source.gmail.connection.disconnect",
      params: { connectionId: "connection_id" } },
    { method: "DELETE", url: "/api/v1/sources/gmail/connections/:connectionId", operation: "source.gmail.connection.forget",
      params: { connectionId: "connection_id" } },
    { method: "DELETE", url: "/api/v1/sources/gmail/selections/:selectionId", operation: "source.gmail.selection.remove",
      params: { selectionId: "selection_id" } },
    { method: "POST", url: "/api/v1/sources/gmail/monitors/:monitorId/status", operation: "source.gmail.monitor.set_status",
      params: { monitorId: "monitor_id" } },
    { method: "DELETE", url: "/api/v1/sources/gmail/monitors/:monitorId", operation: "source.gmail.monitor.delete",
      params: { monitorId: "monitor_id" } },
    { method: "POST", url: "/api/v1/sources/gmail/digests/:digestId/status", operation: "source.gmail.digest.set_status",
      params: { digestId: "digest_id" } },
    { method: "POST", url: "/api/v1/sources/gmail/digests/:digestId/end", operation: "source.gmail.digest.end",
      params: { digestId: "digest_id" } },
  ]);
}
