import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stateChangingReadAllowed } from "../../gateway/csrfOrigin.js";
import websocketPlugin from "@fastify/websocket";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { HostDaemonFrameSchema, HostHelloInfoSchema, type HostHelloInfo, LOGIN_INPUT_MAX_CHARS } from "@rainver/protocol";
import { scheduleAmbientSyncs } from "../importedSessions/syncScheduler.js";
import { authRepositoryFromConfig, sessionTokenFromRequest, introspectIdentity, type AuthFailure } from "../auth/identity.js";
import { hostRepositoryFromConfig, type HostFailure, type DaemonHelloInfo, type HostRow } from "./repository.js";
import { PgProjectFolderRepository } from "../projectFolders/repository.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { HttpError, dbPool } from "../routeUtils/common.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { hostRegisterRateLimited } from "./pairingRateLimit.js";
import { MIN_HOST_DAEMON_VERSION, hostDaemonMeetsMinimumVersion } from "./daemonCompatibility.js";
import type { Pool } from "../../db/pool.js";
import { sharedHostConnectionRegistry, type HostFrameSink } from "./connectionRegistry.js";
import { parseFolderReadResultFrame } from "./folderReadFrames.js";
import { parseFolderWriteResultFrame } from "./folderWriteFrames.js";
import { PgHostThreadRepository } from "./threadRepository.js";
import { hostProviderProxyBaseUrl } from "../runs/hostProviderProxyAddress.js";
import { providerProxyLeases } from "../providers/proxy/lease.js";
import { assertProjectWriter, assertProjectReadable } from "../projects/access.js";
import { getDbPool } from "../../db/pool.js";
import { hasSubscriptionQuota, listHostRuntimeChanges, readHostUsage, recordHostRuntimeChange, refreshHostUsage } from "./usageService.js";
import { getAgentRuntimeDefinition, getRuntimeAdapterSpec, listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";
import { SERVER_OPENCODE_RELEASE } from "../runtimeAdapters/opencodeRelease.js";
import { acpRuntimeProbe, acpRuntimeProbes, type ProbeHostKind } from "./runtimeProbes.js";
import { hostInstallationAuthMethods, hostInstallationCliLoginAvailable, hostInstallationIds, normalizeHostCapabilities } from "./capabilities.js";
import { PgRuntimeProvisioningRepository } from "./runtimeProvisioningRepository.js";
import { serverOpenCodeProvisioningStatus, sharedServerOpenCodeProvisioner } from "./serverOpenCodeProvisioner.js";
import { sseResponseHeaders } from "../../gateway/sse.js";
import { managedHostEgressTransport, readInstanceOperationsPolicy } from "../settings/index.js";

function isFailure(value: unknown): value is AuthFailure | HostFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

/** The open login terminal per host × adapter × copy — one at a time, the newest wins. */
const activeLoginSessions = new Map<string, string>();
function loginSessionKey(hostId: string, runtimeKey: string, installation: string): string {
  return `${hostId}/${runtimeKey}/${installation}`;
}

function remoteInstallableRuntimeKeys(): string[] {
  return listRuntimeAdapterSpecs()
    .filter((spec) =>
      spec.runtime_kind === "local_cli"
      && spec.implementation_status === "implemented"
      && spec.invocation?.protocol === "acp")
    .map((spec) => spec.runtime_key);
}

function isRemoteDispatchEligible(runtimeKey: string): boolean {
  const spec = getRuntimeAdapterSpec(runtimeKey);
  return spec?.runtime_kind === "local_cli"
    && spec.implementation_status === "implemented"
    && spec.invocation?.protocol === "acp"
    // An unbound host run needs this contract to give each Agent a separate
    // state root without losing the managed installation's login.
    && spec.credentials?.login !== undefined;
}

/**
 * Space-scoped identity plus proof the caller may manage this host. For a
 * paired host that is ownership, because a paired host only ever serves its
 * owner (B63); the Space is what a ModelProvider grant is scoped to.
 *
 * The built-in host has no owner — it is the instance's own execution host,
 * serving every Space — so *managing* it (installing a runtime, logging a copy
 * in or out, choosing its default CLI) is instance-admin work rather than
 * anyone's ownership. `allowBuiltin` says a route is one of those; a route
 * that is meaningless for the built-in host, such as attaching an existing
 * directory on the machine (plan decision 12) or pointing it at a provider
 * proxy it reaches in-network, leaves it off and keeps answering 404.
 *
 * Returns null after having already answered the request.
 */
/** `managed:<version>` → the version; anything else (including `own`) is not a managed copy. */
function managedVersionOf(installation: string | null): string | null {
  return installation?.startsWith("managed:") ? installation.slice("managed:".length) : null;
}

/** The managed version a host currently reports for one adapter, for the change record. */
async function currentManagedVersion(pool: Pool, hostId: string, runtimeKey: string): Promise<string | null> {
  const row = await pool.query<{ capabilities_json: unknown }>(
    "SELECT capabilities_json FROM hosts WHERE id = $1",
    [hostId],
  );
  const installed = hostInstallationIds(row.rows[0]?.capabilities_json, runtimeKey);
  return installed.map(managedVersionOf).find((version): version is string => version !== null) ?? null;
}

async function resolveOwnedHost(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { allowBuiltin?: boolean } = {},
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
  const owned = await pool.query<{ kind: string }>(
    `SELECT kind FROM hosts
      WHERE id = $1 AND status <> 'revoked'
        AND ((kind = 'remote' AND owner_user_id = $2) OR (kind = 'server' AND $3))
      LIMIT 1`,
    [hostId, identity.userId, options.allowBuiltin === true],
  );
  if (owned.rowCount === 0) {
    // Not 403: an unowned host id should not be distinguishable from a
    // nonexistent one, matching `revoke`'s own 404-on-not-yours behavior.
    await reply.code(404).send({ detail: "Host not found" });
    return null;
  }
  // Deliberately after the row is known to exist and to be the built-in one:
  // a non-admin asking about a paired host they do not own still gets 404, and
  // only the built-in host — whose existence is not a secret, it is on every
  // member's host list — answers 403.
  if (owned.rows[0]?.kind === "server"
    && !(await requireInstanceAdmin(context.config, identity, reply, "Managing the built-in host requires instance admin"))) {
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

const wsUpgradeHosts = new WeakMap<FastifyRequest, string>();

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
        include_workspace: item.include_workspace,
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
    if (hostRegisterRateLimited(request.ip, Date.now(), context.config.rainverHome)) {
      return sendErrorEnvelope(
        reply,
        429,
        errorEnvelope("host_register_rate_limited", "Too many host registration attempts", requestId),
      );
    }
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
          ? hostProviderProxyBaseUrl(host, context.config)
          : null,
        // How many Runs the built-in host executes at once. bubblewrap has no
        // cgroups, so this and the container's own `cpus`/`mem_limit` are the
        // only levers there are, and both are sized per machine rather than
        // per Run. A paired machine is the owner's to size.
        max_concurrent_runs: host.kind === "server" ? context.config.builtinHostMaxConcurrentRuns : null,
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



  // Static catalog of ACP runtime definitions and their dispatch eligibility
  // (P3, C6):
  // the single source of truth the frontend reads instead of hardcoding the
  // same ACP-only eligibility rule the dispatch endpoint above already
  // enforces. No per-user or per-space data — session-authenticated only for
  // consistency with the rest of this module.
  app.get("/api/v1/hosts/runtime-definitions", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    if (!auth) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const latestManagedVersions = new Map(acpRuntimeProbes().map((probe) => [probe.runtime_key, probe.version]));
    const items = listRuntimeAdapterSpecs()
      .filter((spec) => spec.runtime_kind === "local_cli" && spec.executable?.command)
      .map((spec) => {
        const definition = getAgentRuntimeDefinition(spec.runtime_key);
        return {
          runtime_key: spec.runtime_key,
          display_name: spec.display_name,
          command: spec.executable!.command!,
          // What a host's capability probe actually reports when it differs
          // from the registry launch command.
          capability_probe: spec.invocation?.remote_capability_probe ?? spec.executable!.command!,
          remote_eligible: isRemoteDispatchEligible(spec.runtime_key),
          // A built-in runtime's managed copy comes from this ACP registry entry;
          // the registry picker hides it so the same agent is not offered twice.
          registry_id: spec.distribution && "registry_id" in spec.distribution ? spec.distribution.registry_id : null,
          /** Current ACP package version available to install from the registry. */
          latest_managed_version: latestManagedVersions.get(spec.runtime_key) ?? null,
          /** Release pin used only by the built-in Server Host lifecycle. */
          server_supported_version: spec.runtime_key === "opencode" ? SERVER_OPENCODE_RELEASE.version : null,
          /** Whether this runtime bundles a distinct CLI whose version the host reports. */
          reports_managed_cli_version: Boolean(spec.managed_runtime_version_command),
          // Which backend modes the runtime contract supports, read from the
          // same AgentRuntimeDefinition that Profile admission enforces
          // (`supportsRuntimeBackendMode`), so the composer cannot offer a mode
          // the server answers with 422.
          supports_runtime_native: definition?.supports_runtime_native ?? false,
          supports_model_provider: definition?.supports_model_provider ?? false,
          provider_api: spec.model.provider_api ?? null,
        };
      });
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
  app.post("/api/v1/hosts/:hostId/installations/:runtimeKey", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const runtimeKey = params(request).runtimeKey ?? "";
    if (!remoteInstallableRuntimeKeys().includes(runtimeKey)) {
      return reply.code(422).send({ detail: `Runtime adapter '${runtimeKey}' is not eligible for remote dispatch` });
    }
    const targetHost = await resolved.pool.query<{ kind: string }>(
      "SELECT kind FROM hosts WHERE id = $1 LIMIT 1",
      [resolved.hostId],
    );
    // The probe for *this* machine already resolved which copy it installs —
    // the release pin for the Server Host, the registry's answer for a paired
    // one. Deciding that again here is what made two sources of truth.
    const probe = acpRuntimeProbe(runtimeKey, targetHost.rows[0]?.kind === "server" ? "server" : "remote");
    const distribution = probe?.distribution;
    const version = probe?.version;
    if (!probe || !distribution || !version) {
      return reply.code(422).send({ detail: `Runtime adapter '${runtimeKey}' has no distribution to install from` });
    }
    const before = await currentManagedVersion(resolved.pool, resolved.hostId, runtimeKey);
    const egressTransport = targetHost.rows[0]?.kind === "server"
      ? managedHostEgressTransport(await readInstanceOperationsPolicy(context.config))
      : { mode: "direct" as const };
    const result = await sharedHostConnectionRegistry.requestToolAction(resolved.hostId, "install_tool", {
      runtime_key: runtimeKey,
      version,
      distribution,
      login: probe.login,
      runtime_version_command: getRuntimeAdapterSpec(runtimeKey)?.managed_runtime_version_command ?? null,
      health_check_protocol: getRuntimeAdapterSpec(runtimeKey)?.invocation?.protocol === "acp" ? "acp" : null,
      egress_transport: egressTransport,
    });
    if (result.ok) {
      await recordHostRuntimeChange(resolved.pool, {
        hostId: resolved.hostId,
        runtimeKey,
        action: before ? "upgrade" : "install",
        fromVersion: before,
        toVersion: managedVersionOf(result.installation),
        actorUserId: resolved.userId,
      });
    }
    // `detail` as well as `error`: the web client reads `detail`, and without
    // it a real reason from the host — "Runs are still using claude_code; try
    // again once they finish" — reached the person as "502 Bad Gateway".
    return reply.code(result.ok ? 200 : 502)
      .send({ host_id: resolved.hostId, runtime_key: runtimeKey, ...result, ...(result.ok ? {} : { detail: result.error }) });
  });

  app.get("/api/v1/hosts/:hostId/runtime-provisioning/opencode", async (request, reply) => {
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) {
      if (identity.reason === "denied") {
        reply.code(identity.statusCode);
        reply.header("content-type", "application/json");
        return reply.send(identity.body);
      }
      return reply.code(502).send({ detail: "Identity introspection failed" });
    }
    const hostId = params(request).hostId ?? "";
    const hosts = hostRepositoryFromConfig(context.config);
    const visible = hosts ? await hosts.listVisibleTo(identity.userId) : [];
    const host = visible.find((item) => item.id === hostId);
    if (!host || host.kind !== "server") return reply.code(404).send({ detail: "Host not found" });
    const state = context.config.databaseUrl
      ? await new PgRuntimeProvisioningRepository(getDbPool(context.config.databaseUrl)).get(hostId, "opencode")
      : null;
    const status = serverOpenCodeProvisioningStatus(hostId, state, host.capabilities_json);
    return reply.send(status);
  });

  app.post("/api/v1/hosts/:hostId/runtime-provisioning/opencode/retry", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const target = await resolved.pool.query<{ kind: string }>(
      "SELECT kind FROM hosts WHERE id = $1 LIMIT 1",
      [resolved.hostId],
    );
    if (target.rows[0]?.kind !== "server") return reply.code(404).send({ detail: "Host not found" });
    const state = await new PgRuntimeProvisioningRepository(resolved.pool)
      .retry(resolved.hostId, "opencode", SERVER_OPENCODE_RELEASE.version);
    if (!state) {
      return reply.code(409).send({ detail: "Only a failed Server OpenCode installation can be retried." });
    }
    // Wake the process-wide provisioner rather than building a one-shot one:
    // only the instance that owns a claim heartbeats it, so a throwaway
    // instance's install would be failed as interrupted by the scheduler's.
    void sharedServerOpenCodeProvisioner(resolved.pool, { config: context.config }).reconcile();
    return reply.code(202).send({
      host_id: resolved.hostId,
      runtime_key: "opencode",
      state: state.state,
      desired_version: state.desired_version,
    });
  });

  /**
   * Undoes the last upgrade of a managed copy by promoting the version the
   * host kept behind it; both versions use the adapter's stable managed HOME.
   */
  app.post("/api/v1/hosts/:hostId/installations/:runtimeKey/rollback", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const runtimeKey = params(request).runtimeKey ?? "";
    const before = await currentManagedVersion(resolved.pool, resolved.hostId, runtimeKey);
    const result = await sharedHostConnectionRegistry.requestToolAction(resolved.hostId, "rollback_tool", { runtime_key: runtimeKey });
    if (result.ok) {
      await recordHostRuntimeChange(resolved.pool, {
        hostId: resolved.hostId,
        runtimeKey,
        action: "rollback",
        fromVersion: before,
        toVersion: managedVersionOf(result.installation),
        actorUserId: resolved.userId,
      });
    }
    // `detail` as well as `error`: the web client reads `detail`, and without
    // it a real reason from the host — "Runs are still using claude_code; try
    // again once they finish" — reached the person as "502 Bad Gateway".
    return reply.code(result.ok ? 200 : 502)
      .send({ host_id: resolved.hostId, runtime_key: runtimeKey, ...result, ...(result.ok ? {} : { detail: result.error }) });
  });

  /** What has changed about the hosts this viewer can see, newest first; the Updates page reads it. */
  app.get("/api/v1/hosts/runtime-changes", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    if (!context.config.databaseUrl) {
      return sendErrorEnvelope(reply, 502, errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId));
    }
    const identity = await introspectIdentity(context.config, request);
    if (!identity.ok) return reply.code(identity.reason === "denied" ? identity.statusCode : 502).send({ detail: "Unauthorized" });
    return reply.send({ items: await listHostRuntimeChanges(getDbPool(context.config.databaseUrl), identity.userId) });
  });

  app.delete("/api/v1/hosts/:hostId/installations/:runtimeKey/:installation", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const { runtimeKey, installation } = params(request);
    if (!runtimeKey || !installation?.startsWith("managed:")) {
      return reply.code(422).send({ detail: "Only a managed installation can be removed" });
    }
    const result = await sharedHostConnectionRegistry.requestToolAction(resolved.hostId, "uninstall_tool", {
      runtime_key: runtimeKey,
      version: installation.slice("managed:".length),
    });
    if (result.ok) {
      await recordHostRuntimeChange(resolved.pool, {
        hostId: resolved.hostId,
        runtimeKey,
        action: "remove",
        fromVersion: installation.slice("managed:".length),
        toVersion: null,
        actorUserId: resolved.userId,
      });
    }
    // `detail` as well as `error`: the web client reads `detail`, and without
    // it a real reason from the host — "Runs are still using claude_code; try
    // again once they finish" — reached the person as "502 Bad Gateway".
    return reply.code(result.ok ? 200 : 502)
      .send({ host_id: resolved.hostId, runtime_key: runtimeKey, ...result, ...(result.ok ? {} : { detail: result.error }) });
  });

  /**
   * What each copy on this host has left of its subscription, from the cache.
   *
   * Reading is a cache read, never a probe: rendering a host card must not
   * wait on a CLI launch, and a card someone leaves open must not keep asking
   * the vendor.
   */
  app.get("/api/v1/hosts/:hostId/usage", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    return reply.send({ items: await readHostUsage(resolved.pool, resolved.hostId) });
  });

  /** Asks one copy now. Host owner only, like every other action on their machine. */
  app.post("/api/v1/hosts/:hostId/installations/:runtimeKey/:installation/usage", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const { runtimeKey, installation } = params(request);
    if (!runtimeKey || !installation) {
      return reply.code(400).send({ detail: "runtimeKey and installation are required" });
    }
    if (!hasSubscriptionQuota(runtimeKey)) {
      return reply.code(422).send({ detail: `Runtime adapter '${runtimeKey}' reports no subscription quota` });
    }
    // Checked against what the host reports, not taken on trust: an arbitrary
    // string would spend a probe timeout to learn nothing and leave a row
    // keyed by a copy that does not exist.
    const host = await resolved.pool.query<{ capabilities_json: unknown }>(
      "SELECT capabilities_json FROM hosts WHERE id = $1",
      [resolved.hostId],
    );
    if (!hostInstallationIds(host.rows[0]?.capabilities_json, runtimeKey).includes(installation)) {
      return reply.code(422).send({ detail: `Host does not report installation '${installation}' of '${runtimeKey}'` });
    }
    return reply.send(await refreshHostUsage(resolved.pool, resolved.hostId, runtimeKey, installation));
  });

  // An interactive login for one copy of a runtime on a host, as a terminal
  // stream: the daemon runs the copy's login command on a PTY and relays it;
  // the person reads it here and types through the input route. Host owner
  // only — it is their machine and their account.
  app.get("/api/v1/hosts/:hostId/installations/:runtimeKey/:installation/login/stream", async (request, reply) => {
    // A GET, because it is a long-lived stream the client reads through a
    // `ReadableStream`; a state change, because `login_action` starts a login
    // or a logout on the machine. `SameSite=Lax` sends the cookie on a
    // top-level cross-site GET, so this needs the check a POST gets. The web
    // client's own `fetch` also sets `X-Rainver-Space-Id`, which a cross-site
    // page cannot add without a preflight this server does not answer.
    if (!stateChangingReadAllowed(request, context.config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const { runtimeKey, installation } = params(request);
    if (!runtimeKey || !installation) return reply.code(400).send({ detail: "runtimeKey and installation are required" });
    if (!remoteInstallableRuntimeKeys().includes(runtimeKey)) {
      return reply.code(422).send({ detail: `Runtime adapter '${runtimeKey}' is not eligible for remote dispatch` });
    }
    const probe = acpRuntimeProbe(runtimeKey);
    if (!probe) return reply.code(422).send({ detail: `Unknown runtime adapter '${runtimeKey}'` });
    const authMethodId = typeof (request.query as Record<string, unknown>).auth_method_id === "string"
      ? String((request.query as Record<string, unknown>).auth_method_id)
      : null;
    const rawLoginAction = (request.query as Record<string, unknown>).login_action;
    const loginAction = rawLoginAction === "cli" ? "cli" as const : rawLoginAction === "logout" ? "logout" as const : null;
    if (rawLoginAction !== undefined && !loginAction) {
      return reply.code(400).send({ detail: "login_action must be 'cli' or 'logout'" });
    }
    if (authMethodId && loginAction) {
      return reply.code(400).send({ detail: "Choose either auth_method_id or login_action" });
    }
    const host = await resolved.pool.query<{ capabilities_json: unknown }>(`SELECT capabilities_json FROM hosts WHERE id = $1`, [resolved.hostId]);
    const authMethods = hostInstallationAuthMethods(host.rows[0]?.capabilities_json, runtimeKey, installation);
    const cliLoginAvailable = hostInstallationCliLoginAvailable(host.rows[0]?.capabilities_json, runtimeKey, installation);
    const authMethod = authMethodId ? authMethods.find((candidate) => candidate.id === authMethodId) ?? null : null;
    if (authMethodId && !authMethod) {
      return reply.code(422).send({ detail: `Authentication method '${authMethodId}' is not advertised by this installation` });
    }
    if (loginAction === "cli" && !cliLoginAvailable) {
      return reply.code(422).send({ detail: "CLI login is not available for this installation" });
    }
    // Logout is the vendor's own command from the login spec, or — for a
    // registry agent Rainver logs in through its fixed `login` — the same
    // entry's `logout`. Nothing else is ever run.
    if (loginAction === "logout" && !probe.login?.logout_command && !cliLoginAvailable) {
      return reply.code(422).send({ detail: "This installation does not declare a logout command" });
    }
    if (!probe.login && !authMethod && !loginAction) {
      let selectionDetail = "This installation does not advertise a supported login method";
      if (authMethods.length > 0 && cliLoginAvailable) selectionDetail = "auth_method_id or login_action is required for this installation";
      else if (authMethods.length > 0) selectionDetail = "auth_method_id is required for this installation";
      else if (cliLoginAvailable) selectionDetail = "login_action is required for this installation";
      return reply.code(422).send({
        detail: selectionDetail,
      });
    }
    reply.raw.writeHead(200, sseResponseHeaders());
    const emit = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const key = loginSessionKey(resolved.hostId, runtimeKey, installation);
    const previous = activeLoginSessions.get(key);
    if (previous) sharedHostConnectionRegistry.closeLoginSession(resolved.hostId, previous);
    const sessionId = sharedHostConnectionRegistry.openLoginSession(
      resolved.hostId,
      { runtime_key: runtimeKey, installation, login: probe.login, argv: probe.argv, auth_method: authMethod, login_action: loginAction },
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
    const hint = loginAction === "logout" ? null : authMethod?.description ?? probe.login?.hint;
    if (hint) emit({ type: "hint", text: hint });
    reply.raw.once("close", () => {
      if (activeLoginSessions.get(key) === sessionId) {
        activeLoginSessions.delete(key);
        sharedHostConnectionRegistry.closeLoginSession(resolved.hostId, sessionId);
      }
    });
    return reply;
  });

  app.post("/api/v1/hosts/:hostId/installations/:runtimeKey/:installation/login/input", async (request, reply) => {
    const resolved = await resolveOwnedHost(context, request, reply, { allowBuiltin: true });
    if (!resolved) return reply;
    const { runtimeKey, installation } = params(request);
    const data = body<{ data?: unknown }>(request).data;
    if (!runtimeKey || !installation || typeof data !== "string") return reply.code(400).send({ detail: "data is required" });
    if (data.length > LOGIN_INPUT_MAX_CHARS) {
      return reply.code(413).send({ detail: `Login input is limited to ${LOGIN_INPUT_MAX_CHARS} characters per message` });
    }
    const sessionId = activeLoginSessions.get(loginSessionKey(resolved.hostId, runtimeKey, installation));
    if (!sessionId || !sharedHostConnectionRegistry.sendLoginInput(resolved.hostId, sessionId, data)) {
      return reply.code(409).send({ detail: "No login session is open for this installation" });
    }
    return reply.code(204).send();
  });

  // The address this paired host should use to reach the provider proxy.
  // Normally the instance-wide setting or an address derived from
  // FRONTEND_URL, so this is only for a deployment neither covers: a reverse
  // proxy in front of the API, or the proxy published somewhere else.
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
    const result = await hosts.recordDiffArtifact(run, host.owner_user_id ?? run.owner_user_id, {
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
    const result = await hosts.recordOutputArtifacts(run, host.owner_user_id ?? run.owner_user_id, files);
    return reply.code(201).send(result);
  });






  // hello/heartbeat (phase 1) plus job dispatch/output/complete (phase 3,
  // ADR 0016 D9's RemoteHostExecutionAdapter). This handler stays dumb by
  // design: it authenticates, records liveness, and routes frames to/from
  // `sharedHostConnectionRegistry` — vendor stdout parsing, argv rendering,
  // and diff/artifact handling all live outside this file.
  app.register(async (scoped) => {
    scoped.get("/internal/hosts/ws", {
      websocket: true,
      preValidation: async (request, reply) => {
        const token = bearerToken(request);
        if (!token) return reply.code(401).send({ detail: "Unauthorized" });
        const hosts = hostRepositoryFromConfig(context.config);
        if (!hosts) return reply.code(503).send({ detail: "database_unavailable" });
        const host = await hosts.authenticate(token);
        if (!host) return reply.code(401).send({ detail: "Unauthorized" });
        wsUpgradeHosts.set(request, host.id);
      },
    }, (socket, request) => {
      const upgradeHostId = wsUpgradeHosts.get(request) ?? null;
      let helloCompleted = false;
      let helloInProgress = false;
      // Which machine this connection is, learned at hello and reused by every
      // later acknowledgement: the probe list a daemon is told to install from
      // differs for the built-in Server Host (the release pin) and a paired one
      // (the ACP registry). A heartbeat cannot arrive before hello, so this is
      // always the connected host's own kind by the time it is read.
      let probeHostKind: ProbeHostKind = "remote";
      const hosts = hostRepositoryFromConfig(context.config);
      const frameSink: HostFrameSink = {
        send: (frame) => socket.send(JSON.stringify(frame)),
        close: (code, reason) => socket.close(code, reason),
      };
      if (!upgradeHostId) {
        socket.close(1008, "unauthorized");
        return;
      }
      const hostId = upgradeHostId;

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
            if (helloCompleted || helloInProgress) {
              frameSink.send({ type: "error", detail: "hello_already_processed" });
              socket.close(1008, "hello_already_processed");
              return;
            }
            helloInProgress = true;
            const token = frame.token || (bearerToken(request) ?? "");
            try {
              const host = await hosts.authenticate(token);
              if (!host || host.id !== upgradeHostId) {
                frameSink.send({ type: "error", detail: "invalid_token" });
                socket.close(1008, "invalid_token");
                return;
              }
              // The wire is versioned by the daemon, not per frame: a daemon
              // older than the floor reads fields this release sends as
              // absent and fails each Run on its own, which reports the Run
              // broken rather than the host out of date. Refusing the hello
              // names the reason once and leaves the host offline.
              if (!hostDaemonMeetsMinimumVersion(frame.daemon_version)) {
                await hosts.recordIncompatibleDaemon(host.id, frame.daemon_version || null);
                frameSink.send({
                  type: "error",
                  detail: `daemon_outdated: rainver-host ${frame.daemon_version || "unknown"} is older than the required ${MIN_HOST_DAEMON_VERSION}; update this host before it can execute Runs`,
                });
                socket.close(1008, "daemon_outdated");
                return;
              }
              helloCompleted = true;
              probeHostKind = host.kind === "server" ? "server" : "remote";
              await hosts.recordHeartbeat(host.id, daemonHelloInfo(frame));
              sharedHostConnectionRegistry.registerConnection(host.id, frameSink);
              frameSink.send({ type: "hello_ack", host_id: host.id, runtime_probes: acpRuntimeProbes(probeHostKind) });
              void reconcilePendingManagedWorkspaceArchives(getDbPool(context.config.databaseUrl!), host.id)
                .catch(() => undefined);
            } finally {
              helloInProgress = false;
            }
            return;
          }
          if (!helloCompleted) {
            frameSink.send({ type: "error", detail: "not_authenticated" });
            socket.close(1008, "not_authenticated");
            return;
          }
          switch (frame.type) {
            case "heartbeat": {
              await hosts.recordHeartbeat(upgradeHostId, daemonHelloInfo(frame));
              frameSink.send({ type: "heartbeat_ack", runtime_probes: acpRuntimeProbes(probeHostKind) });
              void reconcilePendingManagedWorkspaceArchives(getDbPool(context.config.databaseUrl!), hostId)
                .catch(() => undefined);
              // Standing consent on a Location is what makes a new terminal
              // conversation arrive without anyone pressing a button, and a
              // heartbeat is when this host is known reachable. Deliberately not
              // awaited: an import replays sessions and takes minutes, while an
              // acknowledged heartbeat must not wait for anything.
              scheduleAmbientSyncs(dbPool(context.config), context.config, hostId);
              return;
            }
            case "launched":
              sharedHostConnectionRegistry.receiveLaunched(hostId, frame.run_id, frame.launch_id);
              return;
            case "output":
              sharedHostConnectionRegistry.receiveOutput(hostId, frame.run_id, frame.chunk, frame.launch_id);
              return;
            // C5: the full stderr stream, not just the failure-tail the
            // `complete` frame already carries — diagnostic events for the UI.
            case "stderr":
              sharedHostConnectionRegistry.receiveStderr(hostId, frame.run_id, frame.chunk, frame.launch_id);
              return;
            case "complete":
              sharedHostConnectionRegistry.receiveComplete(hostId, frame.run_id, {
                exit_code: frame.exit_code,
                timed_out: frame.timed_out,
                error: frame.error,
                egress: frame.egress,
              }, frame.launch_id);
              return;
            case "login_output":
              sharedHostConnectionRegistry.receiveLoginEvent(hostId, frame.session_id, { type: "output", data: frame.data });
              return;
            case "login_exit":
              sharedHostConnectionRegistry.receiveLoginEvent(hostId, frame.session_id, { type: "exit", exit_code: frame.exit_code, logged_in: frame.logged_in });
              return;
            case "ambient_import_session":
              sharedHostConnectionRegistry.receiveAmbientImportSession(hostId, frame.request_id, frame.session);
              return;
            case "ambient_import_result":
              sharedHostConnectionRegistry.receiveAmbientImportResult(hostId, frame.request_id, {
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
              sharedHostConnectionRegistry.receiveFolderReadResult(hostId, frame.request_id, result);
              return;
            }
            case "folder_write_result": {
              const result = parseFolderWriteResultFrame(frame)
                ?? { ok: false as const, error: "write_failed" as const, message: "The host returned a malformed folder_write_result frame." };
              sharedHostConnectionRegistry.receiveFolderWriteResult(hostId, frame.request_id, result);
              return;
            }
            case "usage_probe_result":
              sharedHostConnectionRegistry.receiveUsageProbeResult(hostId, frame.request_id, frame.quota);
              return;
            case "command_result": {
              sharedHostConnectionRegistry.receiveCommandResult(hostId, frame.request_id, {
                exit_code: frame.exit_code,
                stdout: frame.stdout,
                stderr: frame.stderr,
                timed_out: frame.timed_out,
                error: frame.error,
                // The workspace listing, when the request asked for one. Only
                // the host can see it, and the file-scope conformance probe is
                // entirely about what the runtime left there — dropping it here
                // made that check fail for every runtime on every host.
                ...(frame.entries ? { entries: frame.entries } : {}),
              });
              return;
            }
            case "list_dirs_result":
            case "workspace_register_result":
            case "workspace_forget_result": {
              const { type: _type, request_id, ...result } = frame;
              sharedHostConnectionRegistry.receiveHostActionResult(hostId, request_id, result);
              return;
            }
            case "managed_workspace_result":
              sharedHostConnectionRegistry.receiveManagedWorkspaceResult(hostId, frame.request_id, {
                ok: frame.ok,
                changed: frame.changed,
                error: frame.error,
              });
              return;
            case "tool_result":
              sharedHostConnectionRegistry.receiveToolResult(hostId, frame.request_id, {
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
        if (!helloCompleted) return;
        sharedHostConnectionRegistry.unregisterConnection(hostId, frameSink);
        const hostsOnClose = hostRepositoryFromConfig(context.config);
        // Caught, not just fired: this is the last write of a connection that
        // is already gone, and an unhandled rejection terminates the process
        // under Node's default. A database that cannot take the write leaves
        // the Host looking online until the next heartbeat sweep, which is
        // what that sweep is for.
        void hostsOnClose?.markOffline(hostId).catch(() => undefined);
      });
    });
  });
}
