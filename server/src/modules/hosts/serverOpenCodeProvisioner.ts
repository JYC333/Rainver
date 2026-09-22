import type { Pool } from "../../db/pool.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import { SERVER_OPENCODE_RELEASE } from "../runtimeAdapters/opencodeRelease.js";
import { normalizeHostCapabilities } from "./capabilities.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "./connectionRegistry.js";
import { PgHostRepository } from "./repository.js";
import {
  PgRuntimeProvisioningRepository,
  provisioningText,
  type RuntimeProvisioningRecord,
} from "./runtimeProvisioningRepository.js";

const RUNTIME_KEY = "opencode";
/**
 * How long a claim may go without a heartbeat before another process may
 * declare it interrupted. The owner refreshes it on every reconcile tick while
 * it waits on the daemon, so only a process that died leaves a stale claim —
 * an install that simply takes a long time never does.
 */
const INSTALL_HEARTBEAT_STALE_MS = 12 * 60_000;

export interface ServerOpenCodeProvisionerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Reconciles one release-pinned runtime on the one built-in Server Host.
 * Installation itself stays in the Host Daemon's managed install lifecycle.
 */
export class ServerOpenCodeProvisioner {
  private running = false;
  /** The claim this process owns while it waits on the daemon, if any. */
  private ownedInstall: { hostId: string; version: string } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly registry: HostConnectionRegistry = sharedHostConnectionRegistry,
    private readonly log?: ServerOpenCodeProvisionerLogger,
  ) {}

  async reconcile(): Promise<void> {
    if (this.running) {
      // The tick that finds this process busy is exactly when to prove its
      // claim is alive. Nothing else can tell a long install apart from an
      // abandoned one, and a second Server process would otherwise fail this
      // install out from under the owner still waiting on the daemon. The
      // admin retry route wakes this same instance, so its call lands here
      // too rather than taking a claim nobody heartbeats.
      await this.heartbeatOwnedInstall();
      return;
    }
    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      this.log?.error(`[hosts] Server OpenCode provisioning reconciliation failed: ${provisioningText(error, 300)}`);
    } finally {
      this.running = false;
    }
  }

  private async heartbeatOwnedInstall(): Promise<void> {
    const owned = this.ownedInstall;
    if (!owned) return;
    try {
      await new PgRuntimeProvisioningRepository(this.pool)
        .heartbeatInstall(owned.hostId, RUNTIME_KEY, owned.version);
    } catch (error) {
      this.log?.warn(`[hosts] Server OpenCode install heartbeat failed: ${provisioningText(error, 300)}`);
    }
  }

  private async reconcileOnce(): Promise<void> {
    // Resolve the built-in host by authority, never by enumerating paired Hosts,
    // and establish that it *is* the built-in host before writing desired state:
    // a row for anything else is exactly what this provisioner must not create.
    const hostId = await new PgHostRepository(this.pool).ensureServerHostId();
    const host = await this.pool.query<{ kind: string; capabilities_json: unknown }>(
      `SELECT kind, capabilities_json FROM hosts WHERE id = $1 LIMIT 1`,
      [hostId],
    );
    if (host.rows[0]?.kind !== "server") return;
    const provisioning = new PgRuntimeProvisioningRepository(this.pool);
    let state = await provisioning.ensureDesired(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);

    const copies = normalizeHostCapabilities(host.rows[0].capabilities_json).installations[RUNTIME_KEY] ?? [];
    const currentManaged = copies.find((copy) =>
      copy.id.startsWith("managed:") && copy.health_check_protocol === "acp") ?? null;
    const healthyTarget = copies.find((copy) =>
      copy.id === `managed:${SERVER_OPENCODE_RELEASE.version}`
      && copy.health_check_protocol === "acp") ?? null;

    if (healthyTarget) {
      await provisioning.complete(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);
      return;
    }
    await provisioning.rememberInstalledVersion(hostId, RUNTIME_KEY, currentManaged?.version ?? null);
    state = (await provisioning.get(hostId, RUNTIME_KEY)) ?? state;

    if (state.state === "installing") {
      const attemptedAt = state.last_attempt_at ? Date.parse(state.last_attempt_at) : Number.NaN;
      if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt >= INSTALL_HEARTBEAT_STALE_MS) {
        await provisioning.failInterrupted(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);
        this.log?.warn("[hosts] Server OpenCode installation was interrupted; an administrator must retry it explicitly");
      }
      return;
    }
    if (state.state === "failed") return;
    if (state.state === "ready") {
      await provisioning.queueForHealthCheck(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);
      state = (await provisioning.get(hostId, RUNTIME_KEY)) ?? state;
    }
    if (state.state !== "queued" || !this.registry.isOnline(hostId)) return;

    const claimed = await provisioning.claim(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);
    if (!claimed) return;
    const spec = getRuntimeAdapterSpec(RUNTIME_KEY);
    this.ownedInstall = { hostId, version: SERVER_OPENCODE_RELEASE.version };
    let result;
    try {
      result = await this.registry.requestToolAction(hostId, "install_tool", {
        runtime_key: RUNTIME_KEY,
        version: SERVER_OPENCODE_RELEASE.version,
        distribution: SERVER_OPENCODE_RELEASE.distribution,
        login: spec?.credentials.login ?? null,
        runtime_version_command: spec?.managed_runtime_version_command ?? null,
        health_check_protocol: "acp",
      });
    } finally {
      this.ownedInstall = null;
    }

    if (result.ok && result.installation === `managed:${SERVER_OPENCODE_RELEASE.version}`) {
      await provisioning.complete(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);
      this.log?.info(`[hosts] Server OpenCode ${SERVER_OPENCODE_RELEASE.version} is healthy and active`);
    } else if (result.error === "host_offline" || result.error === "host_disconnected") {
      await provisioning.queueAfterOffline(hostId, RUNTIME_KEY, SERVER_OPENCODE_RELEASE.version);
    } else {
      await provisioning.fail(
        hostId,
        RUNTIME_KEY,
        SERVER_OPENCODE_RELEASE.version,
        result.error ?? "Host Daemon did not confirm the requested OpenCode installation.",
      );
      this.log?.error(`[hosts] Server OpenCode installation failed: ${provisioningText(result.error, 300)}`);
    }
  }
}

let shared: ServerOpenCodeProvisioner | null = null;

/**
 * The one provisioner in this process, as `sharedHostConnectionRegistry` is
 * the one host registry.
 *
 * A claim is owned by the instance that took it: `running` and `ownedInstall`
 * are per-instance, and only the owner refreshes the claim's heartbeat. A
 * second, one-shot instance built for a single request would therefore take a
 * claim nothing heartbeats, and the scheduler's instance — seeing an
 * `installing` row it does not own — would fail it as interrupted once
 * `INSTALL_HEARTBEAT_STALE_MS` elapsed. So the admin retry route wakes this
 * instance instead of building its own.
 *
 * The first caller supplies the registry and logger; later callers pass only
 * the pool they already hold, which is the same cached `getDbPool` handle.
 */
export function sharedServerOpenCodeProvisioner(
  pool: Pool,
  options: {
    registry?: HostConnectionRegistry;
    log?: ServerOpenCodeProvisionerLogger;
  } = {},
): ServerOpenCodeProvisioner {
  shared ??= new ServerOpenCodeProvisioner(
    pool,
    options.registry ?? sharedHostConnectionRegistry,
    options.log,
  );
  return shared;
}

/** Tests own the process; a fresh instance per test keeps claims independent. */
export function __resetSharedServerOpenCodeProvisionerForTests(): void {
  shared = null;
}

export function serverOpenCodeProvisioningStatus(
  hostId: string,
  state: RuntimeProvisioningRecord | null,
  capabilities: unknown,
) {
  const copies = normalizeHostCapabilities(capabilities).installations[RUNTIME_KEY] ?? [];
  const active = state?.installed_version
    ? copies.find((copy) => copy.id === `managed:${state.installed_version}`) ?? null
    : null;
  return {
    host_id: hostId,
    runtime_key: "opencode" as const,
    installation: {
      state: state?.state ?? "queued" as const,
      desired_version: state?.desired_version ?? SERVER_OPENCODE_RELEASE.version,
      installed_version: state?.installed_version ?? null,
      active_version: active?.version ?? null,
      error: state?.error ?? null,
      attempts: state?.attempts ?? 0,
    },
    native_account: {
      installation_id: active?.id ?? null,
      logged_in: active?.logged_in ?? null,
      accounts: active?.accounts ?? null,
    },
  };
}
