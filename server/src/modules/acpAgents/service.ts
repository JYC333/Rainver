import type { Queryable } from "../routeUtils/common.js";
import { ScopedSettingsStore } from "../settings/scopedSettings.js";
import { listRuntimeAdapterSpecs, setDynamicRuntimeAdapterSpecs, type RuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import { AcpRegistryError, fetchAcpRegistry, setResolvedRegistryEntries } from "./registry.js";
import { ACP_AGENTS_SCOPE_ID, ACP_AGENTS_SETTINGS, ACP_REGISTRY_CACHE_SETTINGS, type EnabledAcpAgent } from "./settings.js";

/** `acp_<registry id>`, in the same character set the id is validated to. */
export function acpAgentAdapterType(registryId: string): string {
  return `acp_${registryId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/**
 * What an enabled registry agent is to the rest of the server. The launch
 * half is the registry's; everything else is the most conservative reading
 * a runtime nobody here has audited can get: low trust, the machine's own
 * login only, no provider binding, nothing promised about subagents or
 * usage accounting. An operator who wants more for a particular agent writes
 * it a builtin spec.
 */
export function acpAgentRuntimeAdapterSpec(agent: EnabledAcpAgent): RuntimeAdapterSpec {
  // A registry agent has no machine-own install: its command *is* its
  // adapter type, which the daemon resolves to a managed installation.
  const command = acpAgentAdapterType(agent.id);
  return {
    adapter_type: command,
    display_name: agent.name,
    runtime_kind: "local_cli",
    executor_family: "local_cli",
    implementation_status: "implemented",
    enabled_by_default: false,
    subagent_support: "unknown",
    subagent_disable_mechanism: "unknown",
    delegation_controllability: "unknown",
    structured_output: "native_event_stream",
    checkpoint_resume: "runtime_session",
    cancellation_reliability: "best_effort",
    observability_level: "structured",
    side_effect_level: "workspace",
    data_exposure: "unknown",
    baseline_trust_level: "low",
    executable: { command, allow_path_override: false },
    invocation: {
      headless_command_template: ["{executable}"],
      protocol: "acp",
      remote_host_only: true,
    },
    distribution: agent.distribution,
    credentials: {
      credential_mode: "cli_profile",
      credential_runtime_name: command,
      supports_oauth_login_state: false,
    },
    sandbox: {
      requires_file_access: true,
      minimum_sandbox_level: "worktree",
      supports_worktree: true,
      supports_one_shot_docker: false,
      requires_workspace_for_execution: false,
    },
    model: {
      model_provider_mode: "none",
      supports_model_override: true,
      model_config_behavior: "uses_model",
    },
    permissions: { supports_permission_bypass: false },
    usage: { usage_accuracy: "unknown", supports_usage_probe: false },
    output: { patch_strategy: "git_diff", artifact_path_strategy: "none" },
    limits: { default_timeout_seconds: 300, max_timeout_seconds: 3600 },
  };
}

export class AcpAgentService {
  private readonly store: ScopedSettingsStore;

  constructor(private readonly db: Queryable) {
    this.store = new ScopedSettingsStore(db);
  }

  async listEnabled(): Promise<EnabledAcpAgent[]> {
    return (await this.store.get(ACP_AGENTS_SETTINGS, ACP_AGENTS_SCOPE_ID)).value.agents;
  }

  /** Enables (or re-snapshots) a registry agent and republishes the adapter catalog. */
  async enable(registryId: string, userId: string | null): Promise<EnabledAcpAgent> {
    const entry = (await fetchAcpRegistry()).find((candidate) => candidate.id === registryId);
    if (!entry) throw new AcpRegistryError("acp_agent_not_in_registry", `'${registryId}' is not in the ACP registry.`, 404);
    const agent: EnabledAcpAgent = { ...entry, enabled_at: new Date().toISOString(), enabled_by_user_id: userId };
    const current = await this.listEnabled();
    const agents = [...current.filter((existing) => existing.id !== registryId), agent];
    await this.store.upsert(ACP_AGENTS_SETTINGS, ACP_AGENTS_SCOPE_ID, { agents }, { updatedByUserId: userId });
    publish(agents);
    return agent;
  }

  /**
   * The hosts that report a copy of an agent — where a managed install still
   * exists. Disabling while one does would orphan files on someone's machine
   * and silently stall threads pinned to it, so it is refused until they are
   * removed.
   */
  async installedOn(registryId: string): Promise<Array<{ host_id: string; name: string }>> {
    const adapterType = acpAgentAdapterType(registryId);
    const result = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM hosts
        WHERE status <> 'revoked'
          AND jsonb_array_length(COALESCE(capabilities_json -> 'installations' -> $1, '[]'::jsonb)) > 0
        ORDER BY name`,
      [adapterType],
    );
    return result.rows.map((row) => ({ host_id: row.id, name: row.name }));
  }

  async disable(registryId: string, userId: string | null): Promise<boolean> {
    const current = await this.listEnabled();
    const agents = current.filter((existing) => existing.id !== registryId);
    if (agents.length === current.length) return false;
    const hosts = await this.installedOn(registryId);
    if (hosts.length > 0) {
      throw new AcpRegistryError(
        "acp_agent_installed",
        `'${registryId}' is still installed on ${hosts.map((host) => host.name).join(", ")}; remove it there first.`,
        409,
      );
    }
    await this.store.upsert(ACP_AGENTS_SETTINGS, ACP_AGENTS_SCOPE_ID, { agents }, { updatedByUserId: userId });
    publish(agents);
    return true;
  }

  /**
   * Makes the enabled agents visible as runtime adapters in this process.
   * Called at startup and on a timer, because the catalog is process memory
   * and the settings row is what every process agrees on.
   */
  async refreshRuntimeAdapterSpecs(): Promise<number> {
    const agents = await this.listEnabled();
    publish(agents);
    await this.refreshRegistryCache();
    return agents.length;
  }

  /**
   * Resolves the registry entries builtin adapters install from and keeps
   * them where `hello_ack` can read them without the network: in memory,
   * persisted so a restart without the CDN still has the last answer.
   */
  async refreshRegistryCache(): Promise<void> {
    const wanted = new Set(listRuntimeAdapterSpecs().flatMap((spec) =>
      spec.distribution && "registry_id" in spec.distribution ? [spec.distribution.registry_id] : []));
    const stored = (await this.store.get(ACP_REGISTRY_CACHE_SETTINGS, ACP_AGENTS_SCOPE_ID)).value;
    let entries = stored.entries;
    try {
      const fresh = (await fetchAcpRegistry()).filter((entry) => wanted.has(entry.id));
      const changed = JSON.stringify(fresh) !== JSON.stringify(stored.entries);
      entries = fresh;
      if (changed) {
        await this.store.upsert(ACP_REGISTRY_CACHE_SETTINGS, ACP_AGENTS_SCOPE_ID, { entries: fresh, fetched_at: new Date().toISOString() });
      }
    } catch {
      // Offline or the CDN is down: the last persisted answer stands.
    }
    setResolvedRegistryEntries(entries);
  }
}

function publish(agents: EnabledAcpAgent[]): void {
  setDynamicRuntimeAdapterSpecs(agents.map(acpAgentRuntimeAdapterSpec));
}
