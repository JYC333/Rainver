import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { HostDaemonFrameSchema, HostHelloInfoSchema, type HostHelloInfo } from "@rainver/protocol";
import { scheduleAmbientSyncs } from "../importedSessions/syncScheduler.js";
import { authRepositoryFromConfig, sessionTokenFromRequest, introspectIdentity, type AuthFailure } from "../auth/identity.js";
import { hostRepositoryFromConfig, type HostFailure, type DaemonHelloInfo, type HostRow } from "./repository.js";
import { PgProjectFolderRepository } from "../projectFolders/repository.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { HttpError, dbPool } from "../routeUtils/common.js";
import type { Pool } from "../../db/pool.js";
import { sharedHostConnectionRegistry, type HostFrameSink } from "./connectionRegistry.js";
import { parseFolderReadResultFrame } from "./folderReadFrames.js";
import { PgHostThreadRepository } from "./threadRepository.js";
import {
  PgHostRuntimeProviderBindingRepository,
  type HostRuntimeProviderBinding,
} from "./runtimeProviderBindingRepository.js";
import { assertProviderUsable } from "./runtimeProviderBindingResolution.js";
import { hostProviderProxyBaseUrl } from "../runs/hostProviderProxyAddress.js";
import { resolveProvidersDbPort } from "../providers/dbReader.js";
import { providerProxyLeases } from "../providers/proxy/lease.js";
import { assertProjectWriter, assertProjectReadable } from "../projects/access.js";
import { getDbPool } from "../../db/pool.js";
import { getRuntimeAdapterSpec, listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";
import { acpRuntimeProbe, acpRuntimeProbes } from "./runtimeProbes.js";
import { hostInstallationIds, normalizeHostCapabilities } from "./capabilities.js";

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

/** The open login terminal per host × adapter × copy — one at a time, the newest wins. */
const activeLoginSessions = new Map<string, string>();
function loginSessionKey(hostId: string, adapterType: string, installation: string): string {
  return `${hostId}/${adapterType}/${installation}`;
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

/** Applies the process-local consequences shared by owner revoke and host self-revoke. */
function cutOffRevokedHost(hostId: string): void {
  sharedHostConnectionRegistry.closeConnection(hostId, 1008, "host_revoked");
  providerProxyLeases.revokeHost(hostId);
}

/**
 * What a daemon's hello/heartbeat frame contributes to its host row.
 *
 * The frame is already the contract's (`HostHelloFrameSchema`), so nothing is
 * read field by field here — which is how `server_url` once went missing:
 * every field of `DaemonHelloInfo` is optional, and a hand-written mapping
 * that forgot one compiled cleanly. The one transformation is the
 * capabilities blob, normalized into the shape every reader uses; its wire
 * format and history are `capabilities.ts`'s concern alone.
 */
function daemonHelloInfo(frame: HostHelloInfo): DaemonHelloInfo {
  const { capabilities_json, ...info } = frame;
  return {
    ...info,
    capabilities_json: capabilities_json
      ? (normalizeHostCapabilities(capabilities_json) as unknown as Record<string, unknown>)
      : null,
  };
}

async function reconcilePendingManagedWorkspaceArchives(pool: Pool, hostId: string): Promise<void> {
  const pending = await new PgHostThreadRepository(pool).listPendingManagedWorkspaceArchives(hostId);
  for (const item of pending) {
    const result = await sharedHostConnectionRegistry.requestManagedWorkspaceAction(
      hostId,
      "managed_workspace_archive",
      {
        agent_id: item.agent_id,
        container_kind: item.container_kind,
        container_id: item.container_id,
      },
    );
    if (result.ok) await new PgHostThreadRepository(pool).acknowledgeManagedWorkspaceArchive(item.id);
  }
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
    // The same hello info the daemon later sends over the socket, in the same shape.
    const info = HostHelloInfoSchema.safeParse(payload);
    if (!info.success) return reply.code(422).send({ detail: `Malformed host info: ${info.error.issues[0]?.path.join(".") ?? "body"}` });
    const result = await hosts.registerViaPairingCode(code, daemonHelloInfo(info.data));
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

  app.get("/api/v1/hosts/execution-targets", async (request, reply) => {
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
    const projectId = (request.query as Record<string, string | undefined>).project_id ?? null;
    if (projectId) {
      try {
        await assertProjectReadable(getDbPool(context.config.databaseUrl), identity.spaceId, projectId, identity.userId);
      } catch (error) {
        if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
        throw error;
      }
    }
    const targets = await new PgWorkspaceLocationRepository(getDbPool(context.config.databaseUrl))
      .listHostExecutionTargets(identity.spaceId, projectId, identity.userId);
    return reply.send({ targets });
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
        // A builtin adapter's managed copy comes from this ACP registry entry;
        // the registry picker hides it so the same agent is not offered twice.
        registry_id: spec.distribution && "registry_id" in spec.distribution ? spec.distribution.registry_id : null,
        // Whether a ModelProvider can be bound to it at all; a registry agent
        // runs on the copy's own login only.
        provider_binding: !spec.invocation?.remote_host_only,
        provider_api: spec.model.provider_api ?? null,
      }));
    return reply.send({ items });
  });

  // What a dispatch to this host can choose from, decided where dispatch is
  // validated: the runtime copies the host has and, for the chosen copy,
  // every backend with whether it is usable and why not. The composer
  // renders this rather than reconstructing it from bindings, providers and
  // capabilities — three sources that drifted apart in the browser.
  // Plan host-workspace-frontend-registration: the web UI's remote-directory
  // browser and workspace registration. Both are owner-only host actions the
  // daemon answers; the server forwards a request and never opens a path.
  app.post("/api/v1/hosts/:hostId/default-adapter", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const payload = body<{ adapter_type?: string | null }>(request);
    const adapterType = typeof payload.adapter_type === "string" && payload.adapter_type.trim()
      ? payload.adapter_type.trim()
      : null;
    if (adapterType) {
      const host = await resolved.pool.query<{ capabilities_json: unknown }>(`SELECT capabilities_json FROM hosts WHERE id = $1`, [resolved.hostId]);
      if (hostInstallationIds(host.rows[0]?.capabilities_json, adapterType).length === 0) {
        return reply.code(422).send({ detail: `This host reports no installation of '${adapterType}'` });
      }
    }
    const hosts = hostRepositoryFromConfig(context.config);
    const updated = hosts ? await hosts.setDefaultAdapter(resolved.hostId, adapterType) : false;
    if (!updated) return reply.code(404).send({ detail: "Host not found" });
    return reply.send({ host_id: resolved.hostId, default_adapter_type: adapterType });
  });

  app.post("/api/v1/hosts/:hostId/browse-directories", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const payload = body<{ path?: string }>(request);
    const listing = await sharedHostConnectionRegistry.listHostDirectories(resolved.hostId, payload.path ?? null);
    if (!listing.ok) {
      const offline = listing.error === "host_offline" || listing.error === "host_timeout";
      return reply.code(offline ? 409 : 422).send({ detail: offline ? "The host is offline or did not respond." : listing.error, code: offline ? listing.error : undefined });
    }
    return reply.send({ path: listing.path, parent: listing.parent, dirs: listing.dirs, truncated: listing.truncated });
  });

  app.post("/api/v1/hosts/:hostId/workspaces", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const payload = body<{ path?: string; project_id?: string; name?: string }>(request);
    if (!payload.project_id || typeof payload.project_id !== "string") return reply.code(422).send({ detail: "project_id is required" });
    if (!payload.path || typeof payload.path !== "string") return reply.code(422).send({ detail: "path is required" });
    if (!payload.name || typeof payload.name !== "string" || !payload.name.trim()) return reply.code(422).send({ detail: "name is required" });
    try {
      await assertProjectWriter(resolved.pool, resolved.spaceId, payload.project_id, resolved.userId);
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ detail: error.message });
      throw error;
    }
    const registration = await sharedHostConnectionRegistry.registerHostWorkspace(resolved.hostId, {
      path: payload.path,
      projectId: payload.project_id,
      name: payload.name.trim(),
    });
    if (!registration.ok) {
      const offline = registration.error === "host_offline" || registration.error === "host_timeout";
      return reply.code(offline ? 409 : 422).send({ detail: offline ? "The host is offline or did not respond." : registration.error, code: offline ? registration.error : undefined });
    }
    return reply.code(201).send({ workspace_id: registration.workspace_id, display_path: registration.display_path });
  });


  // A managed copy of a runtime on a host, installed and removed by its
  // daemon on the owner's request. Any ACP adapter with a distribution
  // qualifies — a builtin CLI as much as a registry agent — and each managed
  // copy keeps its own login state apart from the machine's own install.
  app.post("/api/v1/hosts/:hostId/installations/:adapterType", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const adapterType = params(request).adapterType ?? "";
    if (!remoteEligibleAdapterTypes().includes(adapterType)) {
      return reply.code(422).send({ detail: `Runtime adapter '${adapterType}' is not eligible for remote dispatch` });
    }
    const probe = acpRuntimeProbe(adapterType);
    if (!probe?.distribution) {
      return reply.code(422).send({ detail: `Runtime adapter '${adapterType}' has no distribution to install from` });
    }
    const result = await sharedHostConnectionRegistry.requestToolAction(resolved.hostId, "install_tool", {
      adapter_type: adapterType,
      version: probe.version ?? "latest",
      distribution: probe.distribution,
      login: probe.login,
    });
    return reply.code(result.ok ? 200 : 502).send({ host_id: resolved.hostId, adapter_type: adapterType, ...result });
  });

  app.delete("/api/v1/hosts/:hostId/installations/:adapterType/:installation", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const { adapterType, installation } = params(request);
    if (!adapterType || !installation?.startsWith("managed:")) {
      return reply.code(422).send({ detail: "Only a managed installation can be removed" });
    }
    const result = await sharedHostConnectionRegistry.requestToolAction(resolved.hostId, "uninstall_tool", {
      adapter_type: adapterType,
      version: installation.slice("managed:".length),
    });
    return reply.code(result.ok ? 200 : 502).send({ host_id: resolved.hostId, adapter_type: adapterType, ...result });
  });

  // An interactive login for one copy of a runtime on a host, as a terminal
  // stream: the daemon runs the copy's login command on a PTY and relays it;
  // the person reads it here and types through the input route. Host owner
  // only — it is their machine and their account.
  app.get("/api/v1/hosts/:hostId/installations/:adapterType/:installation/login/stream", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const { adapterType, installation } = params(request);
    if (!adapterType || !installation) return reply.code(400).send({ detail: "adapterType and installation are required" });
    if (!remoteEligibleAdapterTypes().includes(adapterType)) {
      return reply.code(422).send({ detail: `Runtime adapter '${adapterType}' is not eligible for remote dispatch` });
    }
    const probe = acpRuntimeProbe(adapterType);
    if (!probe) return reply.code(422).send({ detail: `Unknown runtime adapter '${adapterType}'` });
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    const emit = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const key = loginSessionKey(resolved.hostId, adapterType, installation);
    const previous = activeLoginSessions.get(key);
    if (previous) sharedHostConnectionRegistry.closeLoginSession(resolved.hostId, previous);
    const sessionId = sharedHostConnectionRegistry.openLoginSession(
      resolved.hostId,
      { adapter_type: adapterType, installation, login: probe.login },
      (event) => {
        emit(event);
        if (event.type === "exit") {
          if (activeLoginSessions.get(key) === sessionId) activeLoginSessions.delete(key);
          reply.raw.end();
        }
      },
    );
    if (!sessionId) {
      emit({ type: "error", message: "host_offline" });
      reply.raw.end();
      return reply;
    }
    activeLoginSessions.set(key, sessionId);
    if (probe.login?.hint) emit({ type: "hint", text: probe.login.hint });
    reply.raw.once("close", () => {
      if (activeLoginSessions.get(key) === sessionId) {
        activeLoginSessions.delete(key);
        sharedHostConnectionRegistry.closeLoginSession(resolved.hostId, sessionId);
      }
    });
    return reply;
  });

  app.post("/api/v1/hosts/:hostId/installations/:adapterType/:installation/login/input", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply);
    if (!resolved) return reply;
    const { adapterType, installation } = params(request);
    const data = body<{ data?: unknown }>(request).data;
    if (!adapterType || !installation || typeof data !== "string") return reply.code(400).send({ detail: "data is required" });
    const sessionId = activeLoginSessions.get(loginSessionKey(resolved.hostId, adapterType, installation));
    if (!sessionId || !sharedHostConnectionRegistry.sendLoginInput(resolved.hostId, sessionId, data)) {
      return reply.code(409).send({ detail: "No login session is open for this installation" });
    }
    return reply.code(204).send();
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
    // An ACP-registry agent runs on the machine's own login only: nothing
    // knows how to write a provider into its config.
    if (getRuntimeAdapterSpec(adapterType)?.invocation?.remote_host_only) {
      return reply.code(422).send({ detail: `Runtime adapter '${adapterType}' does not accept a ModelProvider` });
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
    // Cutting the socket stops new work; revoking leases also stops an
    // in-flight bound runtime from spending server-held provider credentials.
    cutOffRevokedHost(hostId);
    return reply.code(204).send();
  });

  // `workspace add/list/remove`: authenticated by the host's own bearer
  // token, never a user session — the daemon has no session to present.
  async function authenticateHost(request: FastifyRequest, hostsRepo: ReturnType<typeof hostRepositoryFromConfig>): Promise<HostRow | null> {
    const token = bearerToken(request);
    if (!token || !hostsRepo) return null;
    return hostsRepo.authenticate(token);
  }

  // Host-bearer self-revocation lets `rainver-host unregister` complete both
  // sides without borrowing a browser session. The token is valid for this
  // Host only, and revoke is terminal, so it cannot affect another row.
  app.post("/api/v1/hosts/me/revoke", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const hosts = hostRepositoryFromConfig(context.config);
    if (!hosts) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const host = await authenticateHost(request, hosts);
    if (!host) return reply.code(401).send({ detail: "Invalid host token" });
    if (!host.owner_user_id) return reply.code(403).send({ detail: "The server host cannot unregister through the daemon API" });
    const revoked = await hosts.revoke(host.owner_user_id, host.id);
    if (!revoked) return reply.code(401).send({ detail: "Invalid host token" });
    cutOffRevokedHost(host.id);
    return reply.code(204).send();
  });

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
        // Every frame from every paired host lands here, and each one awaits
        // the database. An unhandled rejection terminates the process under
        // Node's default, so a pool exhausted or a failover mid-heartbeat
        // would take the whole control plane down with it: the connection is
        // closed instead, and the daemon reconnects.
        void (async () => {
          if (!hosts) {
            socket.close(1011, "database_unavailable");
            return;
          }
          let raw_frame: unknown;
          try {
            raw_frame = JSON.parse(raw.toString("utf8"));
          } catch {
            frameSink.send({ type: "error", detail: "invalid_json" });
            return;
          }
          // One parse against the shared contract; every branch below reads
          // the typed frame and rebuilds nothing. A frame that does not parse
          // is answered, not dropped: the daemon logs the detail, and a
          // heartbeat that keeps failing shows up as the host going offline
          // rather than as a field quietly missing from its row.
          const parsed = HostDaemonFrameSchema.safeParse(raw_frame);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const rawType = raw_frame && typeof raw_frame === "object" && typeof (raw_frame as { type?: unknown }).type === "string"
              ? (raw_frame as { type: string }).type
              : "unknown";
            frameSink.send({ type: "error", detail: `invalid_frame ${rawType}: ${issue ? `${issue.path.join(".") || "frame"}: ${issue.message}` : "malformed"}` });
            return;
          }
          const frame = parsed.data;
          if (frame.type === "hello") {
            if (authenticatedHostId || helloInProgress) {
              frameSink.send({ type: "error", detail: "hello_already_processed" });
              socket.close(1008, "hello_already_processed");
              return;
            }
            helloInProgress = true;
            const token = frame.token || (bearerToken(request) ?? "");
            try {
              const host = await hosts.authenticate(token);
              if (!host) {
                frameSink.send({ type: "error", detail: "invalid_token" });
                socket.close(1008, "invalid_token");
                return;
              }
              authenticatedHostId = host.id;
              await hosts.recordHeartbeat(host.id, daemonHelloInfo(frame));
              sharedHostConnectionRegistry.registerConnection(host.id, frameSink);
              frameSink.send({ type: "hello_ack", host_id: host.id, runtime_probes: acpRuntimeProbes() });
              void reconcilePendingManagedWorkspaceArchives(getDbPool(context.config.databaseUrl!), host.id)
                .catch(() => undefined);
            } finally {
              helloInProgress = false;
            }
            return;
          }
          if (!authenticatedHostId) {
            frameSink.send({ type: "error", detail: "not_authenticated" });
            socket.close(1008, "not_authenticated");
            return;
          }
          switch (frame.type) {
            case "heartbeat": {
              await hosts.recordHeartbeat(authenticatedHostId, daemonHelloInfo(frame));
              frameSink.send({ type: "heartbeat_ack" });
              void reconcilePendingManagedWorkspaceArchives(getDbPool(context.config.databaseUrl!), authenticatedHostId)
                .catch(() => undefined);
              // Standing consent on a Location is what makes a new terminal
              // conversation arrive without anyone pressing a button, and a
              // heartbeat is when this host is known reachable. Deliberately not
              // awaited: an import replays sessions and takes minutes, while an
              // acknowledged heartbeat must not wait for anything.
              scheduleAmbientSyncs(dbPool(context.config), context.config, authenticatedHostId);
              return;
            }
            case "launched":
              sharedHostConnectionRegistry.receiveLaunched(authenticatedHostId, frame.run_id, frame.launch_id);
              return;
            case "output":
              sharedHostConnectionRegistry.receiveOutput(authenticatedHostId, frame.run_id, frame.chunk, frame.launch_id);
              return;
            // C5: the full stderr stream, not just the failure-tail the
            // `complete` frame already carries — diagnostic events for the UI.
            case "stderr":
              sharedHostConnectionRegistry.receiveStderr(authenticatedHostId, frame.run_id, frame.chunk, frame.launch_id);
              return;
            case "complete":
              sharedHostConnectionRegistry.receiveComplete(authenticatedHostId, frame.run_id, {
                exit_code: frame.exit_code,
                timed_out: frame.timed_out,
                error: frame.error,
              }, frame.launch_id);
              return;
            case "login_output":
              sharedHostConnectionRegistry.receiveLoginEvent(authenticatedHostId, frame.session_id, { type: "output", data: frame.data });
              return;
            case "login_exit":
              sharedHostConnectionRegistry.receiveLoginEvent(authenticatedHostId, frame.session_id, { type: "exit", exit_code: frame.exit_code, logged_in: frame.logged_in });
              return;
            case "ambient_import_session":
              sharedHostConnectionRegistry.receiveAmbientImportSession(authenticatedHostId, frame.request_id, frame.session);
              return;
            case "ambient_import_result":
              sharedHostConnectionRegistry.receiveAmbientImportResult(authenticatedHostId, frame.request_id, {
                ok: frame.ok,
                error: frame.error,
                session_count: frame.session_count,
                listed_session_ids: frame.listed_session_ids,
              });
              return;
            case "folder_read_result": {
              // The shape is the contract's; what the result *contains* is
              // checked against the folder-read limits and path policy here,
              // because that is policy, not wire shape. A result that fails
              // still settles its caller: leaving it pending would surface as
              // a timeout, hiding the real cause.
              const result = parseFolderReadResultFrame(frame)
                ?? { ok: false as const, error: "read_failed" as const, message: "The host returned a malformed folder_read_result frame." };
              sharedHostConnectionRegistry.receiveFolderReadResult(authenticatedHostId, frame.request_id, result);
              return;
            }
            case "list_dirs_result":
            case "workspace_register_result":
            case "workspace_forget_result": {
              const { type: _type, request_id, ...result } = frame;
              sharedHostConnectionRegistry.receiveHostActionResult(authenticatedHostId, request_id, result);
              return;
            }
            case "managed_workspace_result":
              sharedHostConnectionRegistry.receiveManagedWorkspaceResult(authenticatedHostId, frame.request_id, {
                ok: frame.ok,
                changed: frame.changed,
                error: frame.error,
              });
              return;
            case "tool_result":
              sharedHostConnectionRegistry.receiveToolResult(authenticatedHostId, frame.request_id, {
                ok: frame.ok,
                error: frame.error,
                installation: frame.installation,
              });
              return;
          }
        })().catch(() => {
          socket.close(1011, "host_frame_failed");
        });
      });

      socket.on("close", () => {
        if (!authenticatedHostId) return;
        sharedHostConnectionRegistry.unregisterConnection(authenticatedHostId, frameSink);
        const hostsOnClose = hostRepositoryFromConfig(context.config);
        // Caught, not just fired: this is the last write of a connection that
        // is already gone, and an unhandled rejection terminates the process
        // under Node's default. A database that cannot take the write leaves
        // the Host looking online until the next heartbeat sweep, which is
        // what that sweep is for.
        void hostsOnClose?.markOffline(authenticatedHostId).catch(() => undefined);
      });
    });
  });
}
