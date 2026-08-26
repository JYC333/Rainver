import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { authRepositoryFromConfig, sessionTokenFromRequest, introspectIdentity, type AuthFailure } from "../auth/identity.js";
import { hostRepositoryFromConfig, type HostFailure, type DaemonHelloInfo, type HostRow } from "./repository.js";
import { PgProjectFolderRepository } from "../projectFolders/repository.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { HttpError, withDbTransaction } from "../routeUtils/common.js";
import type { Pool } from "../../db/pool.js";
import { sharedHostConnectionRegistry, type HostFrameSink } from "./connectionRegistry.js";
import { PgHostTaskThreadRepository } from "./taskThreadRepository.js";
import { PgHostThreadMessageRepository } from "./threadMessageRepository.js";
import {
  PgHostRuntimeProviderBindingRepository,
  type HostRuntimeProviderBinding,
} from "./runtimeProviderBindingRepository.js";
import { assertProviderUsable } from "./runtimeProviderBindingResolution.js";
import { hostProviderProxyBaseUrl } from "../runs/hostProviderProxyAddress.js";
import { resolveProvidersDbPort } from "../providers/dbReader.js";
import { providerProxyLeases } from "../providers/proxy/lease.js";
import { advanceThreadQueue, HOST_THREAD_QUEUE_LOCK_PREFIX } from "./queueAdvance.js";
import { assertProjectWriter, assertProjectReadable } from "../projects/access.js";
import { getDbPool } from "../../db/pool.js";
import { PgHostThreadEventRepository } from "./threadEventRepository.js";
import { commandServices } from "../runs/routes.js";
import { isHardTerminalRunStatus } from "../runs/orchestrationResults.js";
import { listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";
import { settleTaskAfterQueuedMessageWithdrawal } from "../tasks/taskRunStatusProjection.js";

function isFailure(value: unknown): value is AuthFailure | HostFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function bindingToOut(binding: HostRuntimeProviderBinding) {
  return {
    host_id: binding.host_id,
    adapter_type: binding.adapter_type,
    model_provider_id: binding.model_provider_id,
    model: binding.model,
    updated_at: binding.updated_at,
  };
}

function remoteEligibleAdapterTypes(): string[] {
  return listRuntimeAdapterSpecs()
    .filter((spec) =>
      spec.runtime_kind === "local_cli"
      && spec.implementation_status === "implemented"
      && spec.invocation?.protocol === "acp")
    .map((spec) => spec.adapter_type);
}

/**
 * Space-scoped identity plus proof the caller owns this host. Ownership is the
 * write gate for a binding because a host only ever serves its owner (B63);
 * the Space is what a ModelProvider grant is scoped to.
 *
 * Returns null after having already answered the request.
 */
async function resolveOwnedHost(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ pool: Pool; hostId: string; spaceId: string; userId: string } | null> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  if (!context.config.databaseUrl) {
    await sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    return null;
  }
  const identity = await introspectIdentity(context.config, request);
  if (!identity.ok) {
    if (identity.reason === "denied") {
      reply.code(identity.statusCode);
      reply.header("content-type", "application/json");
      await reply.send(identity.body);
      return null;
    }
    await sendErrorEnvelope(reply, 502, errorEnvelope("identity_unavailable", "Identity introspection failed", requestId));
    return null;
  }
  const hostId = params(request).hostId;
  if (!hostId) {
    await reply.code(400).send({ detail: "hostId is required" });
    return null;
  }
  const pool = getDbPool(context.config.databaseUrl);
  const owned = await pool.query(
    `SELECT 1 FROM hosts WHERE id = $1 AND owner_user_id = $2 AND kind = 'remote' AND status <> 'revoked' LIMIT 1`,
    [hostId, identity.userId],
  );
  if (owned.rowCount === 0) {
    // Not 403: an unowned host id should not be distinguishable from a
    // nonexistent one, matching `revoke`'s own 404-on-not-yours behavior.
    await reply.code(404).send({ detail: "Host not found" });
    return null;
  }
  return { pool, hostId, spaceId: identity.spaceId, userId: identity.userId };
}

function body<T extends object>(request: FastifyRequest): Partial<T> {
  if (!(request.body instanceof Buffer) || request.body.length === 0) return {};
  try {
    const parsed = JSON.parse(request.body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/**
 * Shared guard for the thread-scoped queue/cancel endpoints (P2): resolves
 * a thread's Project via its Folder and requires write access — the same
 * bar dispatch itself requires, since withdraw/resume/cancel are all
 * consequential actions on someone's in-flight or queued work, not mere
 * reads (`GET .../events` only requires read access, deliberately weaker).
 */
async function requireThreadProjectWriter(
  pool: Pool,
  threadId: string,
  userId: string,
): Promise<{ spaceId: string; projectId: string } | { error: true; statusCode: number; detail: string }> {
  const row = await pool.query<{ space_id: string; project_id: string }>(
    `SELECT pf.space_id, pf.project_id
       FROM host_task_threads t
       JOIN workspace_locations wl ON wl.id = t.workspace_location_id
       JOIN project_folders pf ON pf.id = wl.project_folder_id
      WHERE t.id = $1
      LIMIT 1`,
    [threadId],
  );
  const found = row.rows[0];
  if (!found) return { error: true, statusCode: 404, detail: "Task thread not found" };
  try {
    await assertProjectWriter(pool, found.space_id, found.project_id, userId);
  } catch (error) {
    if (error instanceof HttpError) return { error: true, statusCode: error.statusCode, detail: error.message };
    throw error;
  }
  return { spaceId: found.space_id, projectId: found.project_id };
}

/**
 * The whole of what a daemon's hello/heartbeat frame contributes, validated
 * field by field because the frame is untrusted input.
 *
 * Every field of `DaemonHelloInfo` is optional, so a field the daemon sends
 * and this function forgets compiles cleanly and is dropped in silence —
 * that is exactly how `server_url` went missing, and it surfaced only as
 * every provider-bound run on the host failing dispatch. A field added to the
 * daemon's `helloInfo()` has to be added here, with coverage that a frame
 * carrying it reaches the host row.
 */
function daemonHelloInfo(payload: Record<string, unknown>): DaemonHelloInfo {
  const workspaceReports = Array.isArray(payload.workspace_reports)
    ? payload.workspace_reports.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const report = value as Record<string, unknown>;
        if (typeof report.location_id !== "string" || typeof report.execution_ready !== "boolean") return [];
        return [{
          location_id: report.location_id,
          branch: typeof report.branch === "string" ? report.branch : null,
          git_head: typeof report.git_head === "string" ? report.git_head : null,
          dirty: typeof report.dirty === "boolean" ? report.dirty : null,
          execution_ready: report.execution_ready,
        }];
      })
    : null;
  return {
    platform: typeof payload.platform === "string" ? payload.platform : null,
    arch: typeof payload.arch === "string" ? payload.arch : null,
    daemon_version: typeof payload.daemon_version === "string" ? payload.daemon_version : null,
    server_url: typeof payload.server_url === "string" ? payload.server_url : null,
    capabilities_json:
      payload.capabilities_json && typeof payload.capabilities_json === "object" && !Array.isArray(payload.capabilities_json)
        ? (payload.capabilities_json as Record<string, unknown>)
        : null,
    environment_kind: typeof payload.environment_kind === "string" ? payload.environment_kind : null,
    workspace_reports: workspaceReports,
  };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.register(websocketPlugin);

  app.post("/api/v1/hosts/pairing-codes", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!auth || !hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const payload = body<{ name: string }>(request);
    const result = await hosts.issuePairingCode(user.id, typeof payload.name === "string" ? payload.name : "");
    if (isFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.code(201).send(result);
  });

  // No session auth: the daemon presents the pairing code itself as its
  // one-time credential before it has any other identity with the control
  // plane. See ADR 0016 / hosts.ts schema doc comment.
  app.post("/api/v1/hosts/register", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const payload = body<{ pairing_code: string } & Record<string, unknown>>(request);
    const code = typeof payload.pairing_code === "string" ? payload.pairing_code : "";
    if (!code) return reply.code(422).send({ detail: "pairing_code is required" });
    const result = await hosts.registerViaPairingCode(code, daemonHelloInfo(payload));
    if (isFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.code(201).send(result);
  });

  app.get("/api/v1/hosts", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!auth || !hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const items = await hosts.listVisibleTo(user.id);
    return reply.send({
      // The address each host will actually be handed, resolved by the same
      // function a dispatched run uses — so the Command Center cannot show one
      // answer while runs get another.
      items: items.map((host) => ({
        ...host,
        provider_proxy_effective_url: host.kind === "remote"
          ? hostProviderProxyBaseUrl(host, context.config.providerProxyPort)
          : null,
      })),
    });
  });

  // Read side for the control center's work stream (grouped by thread, not
  // bare run — ADR 0016 §7). Space-scoped like every other Project-owned
  // read (introspectIdentity), unlike the rest of this module's user-scoped
  // host endpoints, because a thread's visibility follows Project read
  // access, not host ownership.
  app.get("/api/v1/hosts/threads", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    if (!context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) {
      if (identity.reason === "denied") {
        reply.code(identity.statusCode);
        reply.header("content-type", "application/json");
        return reply.send(identity.body);
      }
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_unavailable", "Identity introspection failed", requestId));
    }
    const projectId = (request.query as Record<string, string | undefined>).project_id;
    if (!projectId) return reply.code(422).send({ detail: "project_id is required" });
    const pool = getDbPool(context.config.databaseUrl);
    try {
      await assertProjectReadable(pool, identity.spaceId, projectId, identity.userId);
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
    const threads = new PgHostTaskThreadRepository(pool);
    return reply.send({ items: await threads.listForProject(identity.spaceId, projectId) });
  });

  // Cross-project landing read (P3, C10): every thread in the space,
  // most-recently-updated first — Project is a filter the caller applies by
  // calling `.../threads?project_id=` instead, never a precondition for
  // seeing anything here. Static path `recent` is matched ahead of the
  // `:threadId` param route above it (Fastify's router prioritizes static
  // segments), so route order here is documentation, not a correctness
  // requirement.
  app.get("/api/v1/hosts/threads/recent", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    if (!context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) {
      if (identity.reason === "denied") {
        reply.code(identity.statusCode);
        reply.header("content-type", "application/json");
        return reply.send(identity.body);
      }
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_unavailable", "Identity introspection failed", requestId));
    }
    const limitRaw = (request.query as Record<string, string | undefined>).limit;
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number.parseInt(limitRaw, 10), 100) : 20;
    const pool = getDbPool(context.config.databaseUrl);
    const threads = new PgHostTaskThreadRepository(pool);
    return reply.send({ items: await threads.listRecentForSpace(identity.spaceId, identity.userId, limit) });
  });

  // Static catalog of remote-dispatch-eligible runtime adapters (P3, C6):
  // the single source of truth the frontend reads instead of hardcoding the
  // same ACP-only eligibility rule the dispatch endpoint above already
  // enforces. No per-user or per-space data — session-authenticated only for
  // consistency with the rest of this module.
  app.get("/api/v1/hosts/runtime-adapters", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    if (!auth) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const items = listRuntimeAdapterSpecs()
      .filter((spec) => spec.runtime_kind === "local_cli" && spec.executable?.command)
      .map((spec) => ({
        adapter_type: spec.adapter_type,
        display_name: spec.display_name,
        command: spec.executable!.command!,
        // ACP runtime replatform P3: what a host's capability probe actually
        // reports for this adapter, when it differs from `command` (an ACP
        // adapter's own bundled executable vs. the vendor CLI it drives).
        capability_probe: spec.invocation?.remote_capability_probe ?? spec.executable!.command!,
        remote_eligible: spec.implementation_status === "implemented"
          && spec.invocation?.protocol === "acp",
      }));
    return reply.send({ items });
  });

  // Which model backend a host's runtime adapter runs against.
  // Space-scoped rather than
  // user-scoped like this module's other host endpoints, because validating a
  // ModelProvider needs the Space its grant lives in — but host **ownership**
  // is still the write gate (B63: a host serves only its owner).
  app.get("/api/v1/hosts/:hostId/runtime-provider-bindings", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const bindings = await new PgHostRuntimeProviderBindingRepository(resolved.pool).listForHost(resolved.hostId);
    return reply.send({ items: bindings.map(bindingToOut) });
  });

  app.put("/api/v1/hosts/:hostId/runtime-provider-bindings/:adapterType", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const adapterType = params(request).adapterType;
    if (!adapterType) return reply.code(400).send({ detail: "adapterType is required" });
    const payload = body<{ model_provider_id?: string; model?: string | null }>(request);
    const providerId = typeof payload.model_provider_id === "string" ? payload.model_provider_id.trim() : "";
    if (!providerId) return reply.code(422).send({ detail: "model_provider_id is required" });
    const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : null;

    if (!remoteEligibleAdapterTypes().includes(adapterType)) {
      return reply.code(422).send({ detail: `Runtime adapter '${adapterType}' is not eligible for remote dispatch` });
    }
    try {
      // Usable *from this Space*. Dispatch re-validates against whichever
      // Space actually dispatches, which is the authoritative check; this one
      // stops the UI saving a binding that could never work.
      await assertProviderUsable({
        providers: resolveProvidersDbPort(context.config),
        spaceId: resolved.spaceId,
        adapterType,
        providerId,
        // This route *is* the host default. Without saying so, the failure
        // tells the operator to choose another backend "for this message"
        // while they are sitting in the host's settings, where no message
        // exists.
        provenance: "host_default",
      });
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
    const binding = await new PgHostRuntimeProviderBindingRepository(resolved.pool).upsert({
      hostId: resolved.hostId,
      adapterType,
      modelProviderId: providerId,
      model,
      createdByUserId: resolved.userId,
    });
    return reply.send(bindingToOut(binding));
  });

  app.delete("/api/v1/hosts/:hostId/runtime-provider-bindings/:adapterType", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const adapterType = params(request).adapterType;
    if (!adapterType) return reply.code(400).send({ detail: "adapterType is required" });
    const cleared = await new PgHostRuntimeProviderBindingRepository(resolved.pool).clear(resolved.hostId, adapterType);
    if (!cleared) return reply.code(404).send({ detail: "Binding not found" });
    return reply.code(204).send();
  });

  // The address this host should use to reach the provider proxy. Normally
  // derived from what the daemon reports, so this is only for a deployment the
  // derivation cannot see: a reverse proxy in front of the API, or the proxy
  // published somewhere other than the API's host.
  app.put("/api/v1/hosts/:hostId/provider-proxy-url", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const payload = body<{ base_url?: string | null }>(request);
    const raw = typeof payload.base_url === "string" ? payload.base_url.trim() : "";
    let baseUrl: string | null = null;
    if (raw) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return reply.code(422).send({ detail: "base_url must be an absolute http(s) URL" });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return reply.code(422).send({ detail: "base_url must be http or https" });
      }
      baseUrl = raw.replace(/\/+$/, "");
    }
    await resolved.pool.query(
      `UPDATE hosts SET provider_proxy_base_url = $2, updated_at = now() WHERE id = $1`,
      [resolved.hostId, baseUrl],
    );
    return reply.send({ host_id: resolved.hostId, provider_proxy_base_url: baseUrl });
  });

  app.post("/api/v1/hosts/:hostId/revoke", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!auth || !hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const hostId = params(request).hostId;
    if (!hostId) return reply.code(400).send({ detail: "hostId is required" });
    const revoked = await hosts.revoke(user.id, hostId);
    if (!revoked) return reply.code(404).send({ detail: "Host not found" });
    // A daemon that was already connected when its token was revoked would
    // otherwise keep executing dispatched runs and heartbeating on its live
    // socket indefinitely — only a future reconnect would be blocked.
    sharedHostConnectionRegistry.closeConnection(hostId, 1008, "host_revoked");
    // Cutting the socket stops new work, but an in-flight provider lease is
    // reachable over plain HTTP and would keep spending this space's provider
    // credential from a machine that was just cut off.
    providerProxyLeases.revokeHost(hostId);
    return reply.code(204).send();
  });

  // `workspace add/list/remove`: authenticated by the host's own bearer
  // token, never a user session — the daemon has no session to present.
  async function authenticateHost(request: FastifyRequest, hostsRepo: ReturnType<typeof hostRepositoryFromConfig>): Promise<HostRow | null> {
    const token = bearerToken(request);
    if (!token || !hostsRepo) return null;
    return hostsRepo.authenticate(token);
  }

  app.post("/api/v1/hosts/me/workspaces", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    const folders = PgProjectFolderRepository.fromConfig(context.config);
    if (!hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const host = await authenticateHost(request, hosts);
    if (!host) return reply.code(401).send({ detail: "Invalid host token" });
    if (!host.owner_user_id) return reply.code(403).send({ detail: "The server host cannot register daemon workspaces" });
    const payload = body<{ project_id: string; name: string; display_path?: string | null }>(request);
    if (typeof payload.project_id !== "string" || !payload.project_id) {
      return reply.code(422).send({ detail: "project_id is required" });
    }
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      return reply.code(422).send({ detail: "name is required" });
    }
    try {
      const created = await folders.createRemoteWorkspace(payload.project_id, host.owner_user_id, host.id, {
        name: payload.name,
        displayPath: typeof payload.display_path === "string" ? payload.display_path : null,
      });
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
  });

  app.get("/api/v1/hosts/me/workspaces", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!hosts || !context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const host = await authenticateHost(request, hosts);
    if (!host) return reply.code(401).send({ detail: "Invalid host token" });
    const locations = new PgWorkspaceLocationRepository(getDbPool(context.config.databaseUrl));
    return reply.send({ items: await locations.listForHost(host.id) });
  });

  app.delete("/api/v1/hosts/me/workspaces/:folderId", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!hosts || !context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const host = await authenticateHost(request, hosts);
    if (!host) return reply.code(401).send({ detail: "Invalid host token" });
    const locationId = params(request).folderId;
    if (!locationId) return reply.code(400).send({ detail: "folderId is required" });
    const locations = new PgWorkspaceLocationRepository(getDbPool(context.config.databaseUrl));
    const removed = await locations.unregisterForHost(host.id, locationId);
    if (!removed) return reply.code(404).send({ detail: "Workspace not found" });
    return reply.code(204).send();
  });

  // Upload endpoints (D7): the daemon posts its diff/output-directory
  // contents here after a Run completes, bearer-token authenticated. A
  // remote diff is stored as a read-only artifact, never a code-patch
  // proposal — remote in-place execution's propose->apply governance is
  // explicitly deferred (D7 / "pit 3").
  app.post("/api/v1/hosts/me/runs/:runId/diff", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const host = await authenticateHost(request, hosts);
    if (!host) return reply.code(401).send({ detail: "Invalid host token" });
    const runId = params(request).runId;
    if (!runId) return reply.code(400).send({ detail: "runId is required" });
    const run = await hosts.runOwnedByHost(host.id, runId);
    if (!run) return reply.code(404).send({ detail: "Run not found for this host" });
    const payload = body<{ diff: string; truncated?: boolean }>(request);
    if (typeof payload.diff !== "string") return reply.code(422).send({ detail: "diff is required" });
    const result = await hosts.recordDiffArtifact(run, host.owner_user_id!, {
      diff: payload.diff,
      truncated: payload.truncated === true,
    });
    return reply.code(201).send(result);
  });

  app.post("/api/v1/hosts/me/runs/:runId/outputs", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const host = await authenticateHost(request, hosts);
    if (!host) return reply.code(401).send({ detail: "Invalid host token" });
    const runId = params(request).runId;
    if (!runId) return reply.code(400).send({ detail: "runId is required" });
    const run = await hosts.runOwnedByHost(host.id, runId);
    if (!run) return reply.code(404).send({ detail: "Run not found for this host" });
    const payload = body<{ files: Array<{ name: string; content: string }> }>(request);
    const files = Array.isArray(payload.files)
      ? payload.files.filter((f): f is { name: string; content: string } => typeof f?.name === "string" && typeof f?.content === "string")
      : [];
    const result = await hosts.recordOutputArtifacts(run, host.owner_user_id!, files);
    return reply.code(201).send(result);
  });

  // Withdraw a still-queued message before it is ever dispatched — a
  // message already turned into a Run cannot be pulled back (Cancel is the
  // only way to stop work already in flight).
  app.post("/api/v1/hosts/threads/:threadId/messages/:messageId/withdraw", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    if (!auth || !context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const threadId = params(request).threadId;
    const messageId = params(request).messageId;
    if (!threadId || !messageId) return reply.code(400).send({ detail: "threadId and messageId are required" });
    const pool = getDbPool(context.config.databaseUrl);
    const projectAccess = await requireThreadProjectWriter(pool, threadId, user.id);
    if ("error" in projectAccess) return reply.code(projectAccess.statusCode).send({ detail: projectAccess.detail });

    const result = await withDbTransaction(pool, async (client) => {
      // Keep withdrawal and Task settlement in the same serialization domain
      // as queue advancement. If advancement wins this lock, the message is
      // dispatched and correctly becomes non-withdrawable instead.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${HOST_THREAD_QUEUE_LOCK_PREFIX}${threadId}`]);
      const messages = new PgHostThreadMessageRepository(client);
      const withdrawn = await messages.withdraw(threadId, messageId);
      if (!withdrawn) return { withdrawn: null, existing: await messages.get(threadId, messageId) };
      await settleTaskAfterQueuedMessageWithdrawal(client, projectAccess.spaceId, threadId, messageId);
      return { withdrawn, existing: null };
    });
    if (!result.withdrawn) {
      const existing = result.existing;
      if (!existing) return reply.code(404).send({ detail: "Message not found" });
      return reply.code(409).send({ detail: `Message is already ${existing.status}, not withdrawable` });
    }
    return reply.send(result.withdrawn);
  });

  // Explicit resume after a pause (C4) — the only way a paused queue
  // clears. Immediately tries to advance in case something was queued
  // while paused.
  app.post("/api/v1/hosts/threads/:threadId/resume-queue", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    if (!auth || !context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const threadId = params(request).threadId;
    if (!threadId) return reply.code(400).send({ detail: "threadId is required" });
    const pool = getDbPool(context.config.databaseUrl);
    const projectAccess = await requireThreadProjectWriter(pool, threadId, user.id);
    if ("error" in projectAccess) return reply.code(projectAccess.statusCode).send({ detail: projectAccess.detail });

    const threads = new PgHostTaskThreadRepository(pool);
    await threads.resumeQueue(threadId);
    const advance = await advanceThreadQueue(pool, threadId);
    return reply.send({
      thread_id: threadId,
      run_id: advance.advanced ? advance.run_id : null,
      status: advance.advanced ? "dispatched" : "idle",
    });
  });

  // Cancel the thread's currently active Run (C4: an explicit action, never
  // coupled to sending — this never touches the queue directly; the Run's
  // own terminal-status handling (agentRunHandler.ts) pauses the queue once
  // the cancellation actually lands, the same way any other non-success
  // terminal status does).
  app.post("/api/v1/hosts/threads/:threadId/cancel", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    if (!auth || !context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const threadId = params(request).threadId;
    if (!threadId) return reply.code(400).send({ detail: "threadId is required" });
    const pool = getDbPool(context.config.databaseUrl);
    const projectAccess = await requireThreadProjectWriter(pool, threadId, user.id);
    if ("error" in projectAccess) return reply.code(projectAccess.statusCode).send({ detail: projectAccess.detail });

    // `isHardTerminalRunStatus` (not a hand-rolled SQL status list — see
    // queueAdvance.ts's identical reasoning, and the bug that list-drift
    // already caused there) — deliberately not `isTerminalRunStatus`:
    // `waiting_for_review` stays cancellable (orchestrationService
    // .cancelRun's own "queued, running, waiting_for_review, and
    // waiting_for_dependency runs are cancellable" contract), unlike
    // queue-advancement, where a review-pending run should pause the queue,
    // not be treated as still in flight.
    const latestRun = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM runs WHERE host_task_thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [threadId],
    );
    const runId = latestRun.rows[0] && !isHardTerminalRunStatus(latestRun.rows[0].status)
      ? latestRun.rows[0].id
      : undefined;
    if (!runId) return reply.code(409).send({ detail: "No active run on this thread" });

    const services = commandServices(context);
    const result = await services.orchestration.cancelRun({
      run_id: runId,
      space_id: projectAccess.spaceId,
      requested_by_user_id: user.id,
      reason: "Cancelled from the control center thread view.",
    });
    return reply.send({ run_id: runId, status: result.status });
  });

  // Cursor read for a thread's normalized conversation events (C2/C3):
  // everything after `after`, oldest first. Space-scoped like
  // `GET /api/v1/hosts/threads` — a thread's visibility follows Project read
  // access, not host ownership.
  app.get("/api/v1/hosts/threads/:threadId/events", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    if (!context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) {
      if (identity.reason === "denied") {
        reply.code(identity.statusCode);
        reply.header("content-type", "application/json");
        return reply.send(identity.body);
      }
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_unavailable", "Identity introspection failed", requestId));
    }
    const threadId = params(request).threadId;
    if (!threadId) return reply.code(400).send({ detail: "threadId is required" });
    const pool = getDbPool(context.config.databaseUrl);
    const projectRow = await pool.query<{ project_id: string }>(
      `SELECT pf.project_id
         FROM host_task_threads t
         JOIN workspace_locations wl ON wl.id = t.workspace_location_id
         JOIN project_folders pf ON pf.id = wl.project_folder_id
        WHERE t.id = $1 AND pf.space_id = $2
        LIMIT 1`,
      [threadId, identity.spaceId],
    );
    const projectId = projectRow.rows[0]?.project_id;
    if (!projectId) return reply.code(404).send({ detail: "Task thread not found" });
    try {
      await assertProjectReadable(pool, identity.spaceId, projectId, identity.userId);
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
    const afterRaw = (request.query as Record<string, string | undefined>).after;
    const after = afterRaw !== undefined && /^-?\d+$/.test(afterRaw) ? Number.parseInt(afterRaw, 10) : -1;
    const events = new PgHostThreadEventRepository(pool);
    return reply.send({ items: await events.listAfter(threadId, after) });
  });

  // Read side for `host_thread_messages` (P3 — deliberately deferred by P2,
  // "shaped by whatever its UI actually needs"): the durable per-thread
  // conversation record of what was said (`runs.prompt` is redacted on
  // read, so this is the only readable source). Same auth shape as the
  // events read above — space-scoped read access, not the write bar the
  // withdraw/resume/cancel actions require.
  app.get("/api/v1/hosts/threads/:threadId/messages", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    if (!context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) {
      if (identity.reason === "denied") {
        reply.code(identity.statusCode);
        reply.header("content-type", "application/json");
        return reply.send(identity.body);
      }
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_unavailable", "Identity introspection failed", requestId));
    }
    const threadId = params(request).threadId;
    if (!threadId) return reply.code(400).send({ detail: "threadId is required" });
    const pool = getDbPool(context.config.databaseUrl);
    const projectRow = await pool.query<{ project_id: string }>(
      `SELECT pf.project_id
         FROM host_task_threads t
         JOIN workspace_locations wl ON wl.id = t.workspace_location_id
         JOIN project_folders pf ON pf.id = wl.project_folder_id
        WHERE t.id = $1 AND pf.space_id = $2
        LIMIT 1`,
      [threadId, identity.spaceId],
    );
    const projectId = projectRow.rows[0]?.project_id;
    if (!projectId) return reply.code(404).send({ detail: "Task thread not found" });
    try {
      await assertProjectReadable(pool, identity.spaceId, projectId, identity.userId);
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
    const messages = new PgHostThreadMessageRepository(pool);
    return reply.send({ items: await messages.list(threadId) });
  });

  // hello/heartbeat (phase 1) plus job dispatch/output/complete (phase 3,
  // ADR 0016 D9's RemoteHostExecutionAdapter). This handler stays dumb by
  // design: it authenticates, records liveness, and routes frames to/from
  // `sharedHostConnectionRegistry` — vendor stdout parsing, argv rendering,
  // and diff/artifact handling all live outside this file.
  app.register(async (scoped) => {
    scoped.get("/internal/hosts/ws", { websocket: true }, (socket, request) => {
      let authenticatedHostId: string | null = null;
      let helloInProgress = false;
      const hosts = hostRepositoryFromConfig(context.config);
      const frameSink: HostFrameSink = {
        send: (frame) => socket.send(JSON.stringify(frame)),
        close: (code, reason) => socket.close(code, reason),
      };

      socket.on("message", (raw: Buffer) => {
        void (async () => {
          if (!hosts) {
            socket.close(1011, "database_unavailable");
            return;
          }
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(raw.toString("utf8"));
          } catch {
            socket.send(JSON.stringify({ type: "error", detail: "invalid_json" }));
            return;
          }
          if (frame.type === "hello") {
            if (authenticatedHostId || helloInProgress) {
              socket.send(JSON.stringify({ type: "error", detail: "hello_already_processed" }));
              socket.close(1008, "hello_already_processed");
              return;
            }
            helloInProgress = true;
            const token = typeof frame.token === "string" ? frame.token : bearerToken(request) ?? "";
            try {
              const host = await hosts.authenticate(token);
              if (!host) {
                socket.send(JSON.stringify({ type: "error", detail: "invalid_token" }));
                socket.close(1008, "invalid_token");
                return;
              }
              authenticatedHostId = host.id;
              await hosts.recordHeartbeat(host.id, daemonHelloInfo(frame));
              sharedHostConnectionRegistry.registerConnection(host.id, frameSink);
              socket.send(JSON.stringify({ type: "hello_ack", host_id: host.id }));
            } finally {
              helloInProgress = false;
            }
            return;
          }
          if (!authenticatedHostId) {
            socket.send(JSON.stringify({ type: "error", detail: "not_authenticated" }));
            socket.close(1008, "not_authenticated");
            return;
          }
          if (frame.type === "heartbeat") {
            await hosts.recordHeartbeat(authenticatedHostId, daemonHelloInfo(frame));
            socket.send(JSON.stringify({ type: "heartbeat_ack" }));
            return;
          }
          if (frame.type === "launched") {
            const runId = typeof frame.run_id === "string" ? frame.run_id : null;
            if (runId) sharedHostConnectionRegistry.receiveLaunched(authenticatedHostId, runId);
            return;
          }
          if (frame.type === "output") {
            const runId = typeof frame.run_id === "string" ? frame.run_id : null;
            const chunk = typeof frame.chunk === "string" ? frame.chunk : null;
            if (runId && chunk !== null) sharedHostConnectionRegistry.receiveOutput(authenticatedHostId, runId, chunk);
            return;
          }
          // C5: the full stderr stream, not just the failure-tail the
          // `complete` frame already carries — diagnostic events for the UI.
          if (frame.type === "stderr") {
            const runId = typeof frame.run_id === "string" ? frame.run_id : null;
            const chunk = typeof frame.chunk === "string" ? frame.chunk : null;
            if (runId && chunk !== null) sharedHostConnectionRegistry.receiveStderr(authenticatedHostId, runId, chunk);
            return;
          }
          if (frame.type === "complete") {
            const runId = typeof frame.run_id === "string" ? frame.run_id : null;
            if (runId) {
              sharedHostConnectionRegistry.receiveComplete(authenticatedHostId, runId, {
                exit_code: typeof frame.exit_code === "number" ? frame.exit_code : -1,
                timed_out: frame.timed_out === true,
                error: typeof frame.error === "string" ? frame.error : null,
              });
            }
            return;
          }
          socket.send(JSON.stringify({ type: "error", detail: "unknown_frame_type" }));
        })();
      });

      socket.on("close", () => {
        if (!authenticatedHostId) return;
        sharedHostConnectionRegistry.unregisterConnection(authenticatedHostId, frameSink);
        const hostsOnClose = hostRepositoryFromConfig(context.config);
        void hostsOnClose?.markOffline(authenticatedHostId);
      });
    });
  });
}
