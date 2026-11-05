import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  OrdinaryAccountFlowSchema,
  OrdinaryAccountToolIdSchema,
  type HostOrdinaryAccountResponse,
  type OrdinaryAccountResult,
  type OrdinaryAccountToolId,
} from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { stateChangingReadAllowed } from "../../gateway/csrfOrigin.js";
import { sseResponseHeaders } from "../../gateway/sse.js";
import { introspectIdentity } from "../auth/identity.js";
import { getDbPool } from "../../db/pool.js";
import { normalizeHostCapabilities } from "./capabilities.js";
import { sharedHostConnectionRegistry } from "./connectionRegistry.js";

/**
 * A person's own account for an ordinary CLI tool on a Host
 * (`ordinaryToolAccounts.ts`). This is not Host management: on the built-in
 * Host every member manages only their own account, without the instance-admin
 * authority installing the shared binary needs; a paired Host is its owner's
 * alone (B63). The account is always the signed-in user's — the daemon is
 * given a key derived from that user and nothing a client supplied — and its
 * sessions are bound to Host × user × tool, so no id can be guessed into
 * another person's login. Authorization links go only to the stream of the
 * person who opened it; nothing here is stored or logged.
 */

/** Per-process: the open session of each Host × user × tool. */
const activeSessions = new Map<string, string>();

export function ordinaryAccountKey(userId: string): string {
  return createHash("sha256").update(`rainver-ordinary-tool-account\0${userId}`).digest("hex").slice(0, 40);
}

interface AccountHost { hostId: string; userId: string; toolId: OrdinaryAccountToolId; capabilities: unknown }

async function accountHost(context: ModuleContext, request: FastifyRequest, reply: FastifyReply): Promise<AccountHost | null> {
  if (!context.config.databaseUrl) {
    await reply.code(502).send({ detail: "Identity database is unavailable" });
    return null;
  }
  const identity = await introspectIdentity(context.config, request);
  if (!identity.ok) {
    await reply.code(identity.reason === "denied" ? identity.statusCode : 502).send({ detail: "Unauthorized" });
    return null;
  }
  const params = request.params as Record<string, string | undefined>;
  const tool = OrdinaryAccountToolIdSchema.safeParse(params.toolId);
  if (!tool.success) {
    await reply.code(422).send({ detail: "This tool has no personal account" });
    return null;
  }
  const row = (await getDbPool(context.config.databaseUrl).query<{ id: string; capabilities_json: unknown }>(
    `SELECT id, capabilities_json FROM hosts
      WHERE id = $1 AND status <> 'revoked'
        AND (kind = 'server' OR (kind = 'remote' AND owner_user_id = $2))
      LIMIT 1`,
    [params.hostId ?? "", identity.userId],
  )).rows[0];
  if (!row) {
    await reply.code(404).send({ detail: "Host not found" });
    return null;
  }
  return { hostId: row.id, userId: identity.userId, toolId: tool.data, capabilities: row.capabilities_json };
}

/** Why nothing can be asked of this Host right now, or null when it can be. */
function unavailable(host: AccountHost): Pick<HostOrdinaryAccountResponse, "availability" | "reason"> | null {
  if (!sharedHostConnectionRegistry.isOnline(host.hostId)) return { availability: "offline", reason: "The Host is offline." };
  const capabilities = normalizeHostCapabilities(host.capabilities);
  const accounts = capabilities.ordinary_tool_accounts;
  if (!accounts) return { availability: "update_required", reason: "Update this Host's rainver-host to use personal CLI accounts." };
  if (!accounts.supported) return { availability: "unsupported", reason: accounts.reason };
  const tool = capabilities.ordinary_tools?.tools.find((entry) => entry.tool_id === host.toolId);
  if (tool?.status !== "available") return { availability: "tool_unavailable", reason: "The tool is not available on this Host." };
  return null;
}

const sessionKey = (host: AccountHost) => `${host.hostId}:${host.userId}:${host.toolId}`;

function view(host: AccountHost, result: OrdinaryAccountResult | null, blocked: ReturnType<typeof unavailable>): HostOrdinaryAccountResponse {
  const busy = result?.error === "account_busy";
  return {
    host_id: host.hostId,
    tool_id: host.toolId,
    availability: blocked?.availability
      ?? (busy ? "busy" : result?.ok ? "live" : result?.error === "host_offline" || result?.error === "host_disconnected" ? "offline" : "error"),
    status: result?.status ?? null,
    reason: blocked?.reason ?? (result && !result.ok && !busy ? result.error : null),
    session_active: activeSessions.has(sessionKey(host)),
    sandbox_status: "not_verified",
  };
}

export function registerOrdinaryToolAccountRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/hosts/:hostId/ordinary-tools/:toolId/account", async (request, reply) => {
    const host = await accountHost(context, request, reply);
    if (!host) return reply;
    const blocked = unavailable(host);
    if (blocked) return reply.send(view(host, null, blocked));
    const result = await sharedHostConnectionRegistry.requestOrdinaryAccount(host.hostId, {
      tool_id: host.toolId, account_key: ordinaryAccountKey(host.userId), action: "status",
    });
    return reply.send(view(host, result, null));
  });

  for (const action of ["verify", "logout"] as const) {
    app.post(`/api/v1/hosts/:hostId/ordinary-tools/:toolId/account/${action}`, async (request, reply) => {
      const host = await accountHost(context, request, reply);
      if (!host) return reply;
      const blocked = unavailable(host);
      if (blocked) return reply.code(409).send({ ...view(host, null, blocked), detail: blocked.reason });
      const result = await sharedHostConnectionRegistry.requestOrdinaryAccount(host.hostId, {
        tool_id: host.toolId, account_key: ordinaryAccountKey(host.userId), action,
      });
      const body = { ...view(host, result, null), ...(result.logout ? { logout: result.logout } : {}) };
      if (result.ok) return reply.send(body);
      return reply.code(result.error === "account_busy" ? 409 : 502).send({ ...body, detail: result.error });
    });
  }

  /**
   * The official setup (`flow=init`) or personal login (`flow=login`), as a
   * server-sent event stream to the person who opened it. Closing the stream
   * cancels it; opening another for the same account supersedes it.
   */
  app.get("/api/v1/hosts/:hostId/ordinary-tools/:toolId/account/session/stream", async (request, reply) => {
    // A GET that starts something on a machine: the same cross-site check
    // the Runtime login stream applies.
    if (!stateChangingReadAllowed(request, context.config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    const host = await accountHost(context, request, reply);
    if (!host) return reply;
    const flow = OrdinaryAccountFlowSchema.safeParse((request.query as Record<string, unknown> | undefined)?.flow);
    if (!flow.success) return reply.code(422).send({ detail: "flow must be 'init' or 'login'" });
    const blocked = unavailable(host);
    if (blocked) return reply.code(409).send({ ...view(host, null, blocked), detail: blocked.reason });

    reply.raw.writeHead(200, sseResponseHeaders());
    const emit = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const key = sessionKey(host);
    const previous = activeSessions.get(key);
    // The earlier stream (another tab, a reload) is told it was cancelled.
    if (previous) sharedHostConnectionRegistry.cancelOrdinaryAccountSession(host.hostId, previous);
    const sessionId = sharedHostConnectionRegistry.openOrdinaryAccountSession(
      host.hostId,
      { tool_id: host.toolId, account_key: ordinaryAccountKey(host.userId), flow: flow.data },
      (event) => {
        emit(event.kind === "authorization"
          ? { type: "authorization", url: event.url, user_code: event.user_code, expires_in: event.expires_in }
          : { type: "exit", outcome: event.outcome, error: event.error, status: event.status });
        if (event.kind === "exit") {
          if (activeSessions.get(key) === sessionId) activeSessions.delete(key);
          reply.raw.end();
        }
      },
    );
    if (!sessionId) {
      emit({ type: "exit", outcome: "failed", error: "host_offline", status: null });
      reply.raw.end();
      return reply;
    }
    activeSessions.set(key, sessionId);
    reply.raw.once("close", () => {
      if (activeSessions.get(key) === sessionId) {
        activeSessions.delete(key);
        sharedHostConnectionRegistry.closeOrdinaryAccountSession(host.hostId, sessionId);
      }
    });
    return reply;
  });

  /** Cancels the caller's own open session on this Host; there is no id to name. */
  app.post("/api/v1/hosts/:hostId/ordinary-tools/:toolId/account/session/cancel", async (request, reply) => {
    const host = await accountHost(context, request, reply);
    if (!host) return reply;
    const sessionId = activeSessions.get(sessionKey(host));
    if (!sessionId) return reply.code(404).send({ detail: "No session is open for your account on this Host" });
    // The stream that opened it receives the `cancelled` exit and ends.
    sharedHostConnectionRegistry.cancelOrdinaryAccountSession(host.hostId, sessionId);
    return reply.send({ cancelled: true });
  });
}
