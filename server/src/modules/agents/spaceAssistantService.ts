import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { ServerConfig } from "../../config.js";
import type { Pool, PoolClient } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { isVendorCliAdapter, listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";
import { resolveAgentSystemPrompt } from "./promptRegistry.js";
import { promptProvenanceOf } from "../prompts/provenance.js";
import { providerSupportsChat } from "../providers/vendors.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
} from "../providers/eligibility.js";
import { PgAgentRepository, type AgentCreateInput } from "./repository.js";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
import { isStale } from "../hosts/repository.js";

const MANAGED_ASSISTANT_NAME = "Space Assistant";
const MANAGED_ASSISTANT_PROMPT_KEY = "agent_template.personal_assistant.system";
// The server-host CLIs only: a remote-only adapter (ACP registry agent) has
// no runtime tool or credential profile on the server for this to provision.
//
// In preference order for the no-provider fallback (`model_api` still wins
// whenever a ModelProvider exists): OpenCode first, because it takes any
// OpenAI-compatible endpoint and so works where the vendor-locked CLIs'
// accounts are hard to obtain; Codex last for the same reason.
const CLI_FALLBACK_PREFERENCE = ["opencode", "claude_code", "codex_cli"];
const MANAGED_ASSISTANT_CLI_ADAPTERS = listRuntimeAdapterSpecs()
  .filter((spec) => isVendorCliAdapter(spec.adapter_type) && !spec.invocation?.remote_host_only)
  .map((spec) => spec.adapter_type)
  .sort((a, b) => rank(a) - rank(b));
function rank(adapterType: string): number {
  const index = CLI_FALLBACK_PREFERENCE.indexOf(adapterType);
  return index === -1 ? CLI_FALLBACK_PREFERENCE.length : index;
}
const ROOM_MANAGER_POLICY = `

When you are acting as a Room manager, follow the Room coordination policy:
answer ordinary conversation and simple work directly; honor explicit @Agent
mentions by routing to that specialist; delegate only when you can explain the
demonstrated need, visibly, to no more than two roster specialists and never
more than one delegation level. Do not delegate merely because a task is broad.
Room delegation is bounded by the server and remains auditable.

Project work is recorded, not described. Listing a decomposition in a reply
does not create anything: call task.create once per Task and report the count
you actually created, or the failure, in plain language. The same holds for the
rest of the Project surface — task.report is how you say what you did and
concluded, task.handoff is how you give a Task to someone else or release it,
task.advance_stage is how you move a Task through its Loop, task.complete is
how you say the work is finished, and task.request_review is how you stop and
hand a decision back. Reporting is not closing: a Task you finished but did not
complete sits on the board as unfinished work. Use
task.request_review when the next step turns on something only the person can
decide; saying so in a reply leaves the Task sitting in progress with nobody
told.`;

interface ProviderRow {
  id: string;
  name: string;
  provider_type: string;
  default_model: string | null;
}

interface ManagedAssistantSeed {
  name: string;
  description: string | null;
  modelConfigJson: Record<string, unknown>;
  contextPolicyJson: Record<string, unknown>;
  memoryPolicyJson: Record<string, unknown>;
  runtimePolicyJson: Record<string, unknown>;
  toolPolicyJson: Record<string, unknown>;
  outputPolicyJson: Record<string, unknown>;
  scheduleConfigJson: Record<string, unknown>;
  outputSchemaJson: Record<string, unknown>;
}

export interface ManagedAssistantPreparation {
  seed: ManagedAssistantSeed;
  /**
   * Every execution host this creator can reach that has a logged-in CLI: the
   * built-in host and their own paired machines. Since ADR 0016 a CLI runs
   * only on a host, so this is the whole CLI side of Assistant provisioning —
   * there is no server-side copy to fall back to.
   */
  hostBackends: Array<{ hostId: string; hostName: string; adapterType: string; installation: string }>;
}

/**
 * Where to send someone whose Space has no backend for its Assistant yet.
 *
 * Both destinations are real work: add a ModelProvider, or log a CLI in on an
 * execution host. The second used to be a server-side credential profile and
 * is now the Command Center's host card.
 */
export function setupTargetsForMissingBackend(): Array<"model_providers" | "execution_hosts"> {
  return ["model_providers", "execution_hosts"];
}

export class SpaceAssistantService {
  private readonly agents: PgAgentRepository;

  constructor(
    private readonly client: PoolClient,
    pool: Pool,
  ) {
    this.agents = new PgAgentRepository(pool);
  }

  static async prepareForRoomCreator(
    pool: Pool,
    config: ServerConfig,
    identity: { spaceId: string; userId: string },
  ): Promise<ManagedAssistantPreparation> {
    const [seed, hostBackends] = await Promise.all([
      loadManagedAssistantSeed(config),
      listHostBackends(pool, identity.userId),
    ]);
    return { seed, hostBackends };
  }

  /**
   * Keep an already-provisioned Assistant's persisted model profiles aligned
   * with provider/grant mutations. This path is deliberately model-only:
   * provider changes do not require filesystem or CLI discovery, so the
   * reconciliation remains a short database transaction.
   */
  static async reconcileModelApiProfiles(
    pool: Pool,
    spaceId: string,
  ): Promise<void> {
    await withTransaction(pool, async (client) => {
      const space = await client.query<{ id: string }>(
        "SELECT id FROM spaces WHERE id = $1 FOR UPDATE",
        [spaceId],
      );
      if (!space.rows[0]) return;
      // Every managed Assistant in the Space. `model_api` is the default
      // adapter for a provisioned instance, so reconciling only the oldest
      // would leave every other Project's Assistant bound to a provider that
      // is no longer granted.
      const assistants = await client.query<{ id: string }>(
        `SELECT id
           FROM agents
          WHERE space_id = $1
            AND agent_kind = 'system_assistant'
            AND status = 'active'
          ORDER BY created_at ASC, id ASC`,
        [spaceId],
      );
      if (assistants.rows.length === 0) return;
      const providers = await listChatProviderDefinitions(client, spaceId);
      const service = new SpaceAssistantService(client, pool);
      for (const { id: agentId } of assistants.rows) {
        await service.ensureModelApiProfiles(agentId, spaceId, providers, false);
      }
    });
  }

  /**
   * Reconcile the managed Assistant's CLI profiles after runtime-tool
   * installation, activation, or Space-policy changes. Runtime-tool
   * discovery is intentionally performed before the transaction because it
   * reads the host runtime-tool registry; the transaction only persists the
   * resulting profile state.
   */
  static async reconcileCliProfiles(
    pool: Pool,
    config: ServerConfig,
    spaceId: string,
  ): Promise<void> {
    await withTransaction(pool, async (client) => {
      const space = await client.query<{ id: string }>(
        "SELECT id FROM spaces WHERE id = $1 FOR UPDATE",
        [spaceId],
      );
      if (!space.rows[0]) return;
      // Every managed Assistant in the Space, not the oldest one: since each
      // Project has its own instance, reconciling a single row would leave the
      // rest bound to a runtime profile that no longer resolves.
      const assistants = await client.query<{ id: string }>(
        `SELECT id
           FROM agents
          WHERE space_id = $1
            AND agent_kind = 'system_assistant'
            AND status = 'active'
          ORDER BY created_at ASC, id ASC`,
        [spaceId],
      );
      const service = new SpaceAssistantService(client, pool);
      for (const { id: agentId } of assistants.rows) {
        // No CLI runtime is provisionable on the server any more, so every
        // server-CLI profile a past release created is now unrunnable.
        await service.disableUnavailableCliProfiles(spaceId, agentId);
      }
    });
  }

  /**
   * Bring every seed-following Assistant up to the current seed.
   *
   * Without this a seed change reached a Project's Assistant only when someone
   * next created a Room there — so a prompt shipped in one release stayed
   * unapplied on every Assistant that already existed. Runs at boot, once;
   * it is idempotent (an instance already at the seed produces no version) and
   * it skips, rather than fails on, an instance whose Project has no eligible
   * backend for its owner. A detached instance is left alone by the same rule
   * reconciliation always applies.
   */
  static async reconcileSeedFollowersForAllSpaces(
    pool: Pool,
    config: ServerConfig,
    log?: { info(message: string): void; warn(message: string): void },
  ): Promise<{ reconciled: number; skipped: number }> {
    const followers = await pool.query<{ space_id: string; project_id: string; owner_user_id: string }>(
      `SELECT a.space_id, a.project_id, p.owner_user_id
         FROM agents a
         JOIN agent_versions v ON v.id = a.current_version_id
         JOIN projects p ON p.id = a.project_id AND p.space_id = a.space_id
        WHERE a.agent_kind = 'system_assistant' AND a.status = 'active'
          AND a.project_id IS NOT NULL
          AND v.follows_seed_key = $1
          AND p.owner_user_id IS NOT NULL AND p.deleted_at IS NULL
        ORDER BY a.space_id, a.created_at`,
      [MANAGED_ASSISTANT_PROMPT_KEY],
    );
    let reconciled = 0;
    let skipped = 0;
    for (const row of followers.rows) {
      const identity = { spaceId: row.space_id, userId: row.owner_user_id };
      try {
        const preparation = await SpaceAssistantService.prepareForRoomCreator(pool, config, identity);
        await withTransaction(pool, async (client) => {
          await new SpaceAssistantService(client, pool)
            .ensureForRoomCreator(identity, preparation, row.project_id);
        });
        reconciled += 1;
      } catch (error) {
        skipped += 1;
        log?.warn(`[assistant] seed reconcile skipped project=${row.project_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (followers.rows.length > 0) {
      log?.info(`[assistant] seed reconcile: ${reconciled} reconciled, ${skipped} skipped`);
    }
    return { reconciled, skipped };
  }

  /** Runtime-tool binaries are process-wide, so activation/install changes can
   * affect every Space that already has a managed Assistant. Per-Space
   * reconciliation covers every instance in it. */
  static async reconcileCliProfilesForAllSpaces(
    pool: Pool,
    config: ServerConfig,
  ): Promise<void> {
    const spaces = await pool.query<{ space_id: string }>(
      `SELECT DISTINCT space_id
         FROM agents
        WHERE agent_kind = 'system_assistant'
          AND status = 'active'`,
    );
    for (const { space_id: spaceId } of spaces.rows) {
      await SpaceAssistantService.reconcileCliProfiles(pool, config, spaceId);
    }
  }

  /**
   * The Assistant a Room talks to.
   *
   * One instance per Project, so two Projects get two Agents that start
   * identical and diverge as each is worked with — a Project's Assistant
   * accumulates that Project's memory, its token usage is attributable to that
   * Project, and evolving one does not change the other. `projectId` null
   * provisions the Space's own instance, which is what `/home` chat uses.
   *
   * Every instance is materialized from the same seed and re-materialized when
   * the seed changes, unless it has been given a version of its own — see
   * `followsSeedKey`.
   */
  async ensureForRoomCreator(
    identity: { spaceId: string; userId: string },
    preparation: ManagedAssistantPreparation,
    projectId: string | null = null,
  ) {
    // Serializing on the Space row makes first-use provisioning deterministic
    // and avoids relying on a unique-violation retry inside an aborted tx.
    const space = await this.client.query<{ id: string; type: string }>(
      "SELECT id, type FROM spaces WHERE id = $1 FOR UPDATE",
      [identity.spaceId],
    );
    if (!space.rows[0]) throw new HttpError(404, "Space not found");

    const resolved = await resolveAgentSystemPrompt(this.client, {
      spaceId: identity.spaceId,
      userId: identity.userId,
      assetKey: MANAGED_ASSISTANT_PROMPT_KEY,
    });
    if (!resolved) {
      throw new HttpError(500, "Managed Space Assistant system prompt is not resolvable");
    }

    const { seed } = preparation;
    const providers = await this.listEligibleProviderDefinitions(identity.spaceId);
    // Admission must be decided before creating the managed identity. A fresh
    // Space has no runtime profile to inspect yet, and creating a model_api
    // version without a provider would fail with a generic validation error
    // before the caller could receive actionable setup targets.
    const defaultProvider = await this.requireEligibleBackend(identity, preparation, providers);
    // Admission has already established that at least one eligible provider or
    // execution-host backend exists, so the canonical adapter follows the
    // provisioned backend candidates instead of manufacturing a placeholder.
    const defaultHostBackend = defaultProvider ? null : preparation.hostBackends[0] ?? null;
    const defaultAdapter = defaultProvider ? "model_api" : defaultHostBackend?.adapterType ?? "model_api";
    const runtimePolicyJson = {
      ...seed.runtimePolicyJson,
      allowed_adapter_types: ["model_api", ...MANAGED_ASSISTANT_CLI_ADAPTERS],
      default_adapter_type: defaultAdapter,
    };
    const runtimeConfigJson = {
      risk_level: seed.runtimePolicyJson.risk_level ?? "low",
      max_run_time_seconds: seed.runtimePolicyJson.max_run_time_seconds ?? 120,
      adapter_type: defaultAdapter,
    };
    const canonical = {
      systemPrompt: `${resolved.system.trim()}${ROOM_MANAGER_POLICY}`,
      promptProvenanceJson: {
        ...promptProvenanceOf(resolved.resolveResult),
        room_manager_policy_version: "room-manager-policy.v2",
      },
      modelProviderId: defaultAdapter === "model_api" ? defaultProvider?.id ?? null : null,
      modelName: defaultAdapter === "model_api" ? defaultProvider?.default_model ?? null : null,
      modelConfigJson: seed.modelConfigJson,
      runtimeConfigJson,
      contextPolicyJson: seed.contextPolicyJson,
      memoryPolicyJson: seed.memoryPolicyJson,
      capabilitiesJson: [] as unknown[],
      toolPermissionsJson: {},
      runtimePolicyJson,
      toolPolicyJson: seed.toolPolicyJson,
      outputPolicyJson: seed.outputPolicyJson,
      scheduleConfigJson: seed.scheduleConfigJson,
      outputSchemaJson: seed.outputSchemaJson,
    };
    const existing = await this.agents.getSystemAssistantInTransaction(
      this.client,
      identity.spaceId,
      projectId,
    );
    const managedName = await this.managedNameFor(space.rows[0]?.type ?? null, seed.name, projectId);
    if (existing) {
      const reconciled = await this.agents.reconcileSystemManagedAgentInTransaction(this.client, {
        spaceId: identity.spaceId,
        agentId: existing.id,
        name: managedName,
        description: seed.description,
        projectId,
        followsSeedKey: MANAGED_ASSISTANT_PROMPT_KEY,
        ...canonical,
      });
      await this.agents.ensureSystemAssistantActorInTransaction(
        this.client,
        identity.spaceId,
        reconciled.id,
        reconciled.name,
      );
      await this.ensureRuntimeProfiles(reconciled.id, identity, providers, preparation.hostBackends, false);
      // The pointer names the Space's Assistant, which backs personal
      // preferences and `/home` chat. Repointing it at whichever Project a
      // Room happened to be created in would silently move the Space's chat.
      if (!projectId) {
        await this.agents.ensureAssistantSettingsPointerInTransaction(this.client, identity.spaceId, reconciled.id);
      }
      await this.requireEligibleBackend(identity, preparation, providers);
      return reconciled;
    }

    const input: AgentCreateInput = {
      spaceId: identity.spaceId,
      projectId,
      userId: identity.userId,
      ownerUserId: null,
      name: managedName,
      description: seed.description,
      visibility: "space_shared",
      agentKind: "system_assistant",
      systemPrompt: canonical.systemPrompt,
      promptProvenanceJson: canonical.promptProvenanceJson,
      defaultModelProviderId: canonical.modelProviderId,
      defaultModel: canonical.modelName,
      adapterType: defaultAdapter,
      // A host-only Assistant must be born on the host profile it was
      // admitted with: a CLI adapter names no runnable copy on its own.
      ...(defaultHostBackend ? {
        executionHostId: defaultHostBackend.hostId,
        workspaceLocationId: null,
        workspaceMode: "managed" as const,
        runtimeInstallation: defaultHostBackend.installation,
      } : {}),
      modelConfigJson: canonical.modelConfigJson,
      runtimeConfigJson: canonical.runtimeConfigJson,
      contextPolicyJson: canonical.contextPolicyJson,
      memoryPolicyJson: canonical.memoryPolicyJson,
      capabilitiesJson: canonical.capabilitiesJson,
      toolPermissionsJson: canonical.toolPermissionsJson,
      runtimePolicyJson: canonical.runtimePolicyJson,
      toolPolicyJson: canonical.toolPolicyJson,
      outputPolicyJson: canonical.outputPolicyJson,
      scheduleConfigJson: canonical.scheduleConfigJson,
      outputSchemaJson: canonical.outputSchemaJson,
    };
    const created = await this.agents.createInTransaction(this.client, input);
    await this.agents.ensureSystemAssistantActorInTransaction(
      this.client,
      identity.spaceId,
      created.id,
      created.name,
    );
    await this.ensureRuntimeProfiles(created.id, identity, providers, preparation.hostBackends, true, defaultHostBackend !== null);
    if (!projectId) {
      await this.agents.ensureAssistantSettingsPointerInTransaction(this.client, identity.spaceId, created.id);
    }
    await this.requireEligibleBackend(identity, preparation, providers);
    // The first version materializes the seed, so it follows it until somebody
    // authors one of their own.
    await this.agents.markCurrentVersionFollowsSeedInTransaction(
      this.client,
      identity.spaceId,
      created.id,
      MANAGED_ASSISTANT_PROMPT_KEY,
    );
    return this.agents.getSystemAssistantInTransaction(this.client, identity.spaceId, projectId)
      .then((assistant) => assistant ?? created);
  }

  /** `<Project name> Assistant`, so two of them are told apart by what they
   * are for rather than by an id. */
  private async managedNameFor(
    spaceType: string | null,
    seedName: string,
    projectId: string | null,
  ): Promise<string> {
    if (projectId) {
      const project = await this.client.query<{ name: string }>(
        "SELECT name FROM projects WHERE id = $1",
        [projectId],
      );
      const name = project.rows[0]?.name?.trim();
      if (name) return `${name.slice(0, 96)} Assistant`;
    }
    return spaceType === "personal" ? seedName : MANAGED_ASSISTANT_NAME;
  }

  private async ensureRuntimeProfiles(
    agentId: string,
    identity: { spaceId: string; userId: string },
    providers: ProviderRow[],
    hostBackends: ManagedAssistantPreparation["hostBackends"] = [],
    initializeDefaults = false,
    makeHostDefault = false,
  ): Promise<void> {
    await this.ensureModelApiProfiles(agentId, identity.spaceId, providers, initializeDefaults);
    const orderedHostBackends = await this.prioritizeCurrentHostBackend(
      agentId,
      identity.spaceId,
      hostBackends,
    );
    await this.ensureHostProfiles(agentId, identity.spaceId, identity.userId, orderedHostBackends, {
      makeFirstDefault: makeHostDefault,
    });
  }

  private async prioritizeCurrentHostBackend(
    agentId: string,
    spaceId: string,
    hostBackends: ManagedAssistantPreparation["hostBackends"],
  ): Promise<ManagedAssistantPreparation["hostBackends"]> {
    const current = await this.client.query<{
      execution_host_id: string;
      adapter_type: string;
      runtime_installation: string;
    }>(
      `SELECT execution_host_id, adapter_type, runtime_installation
         FROM agent_runtime_profiles
        WHERE space_id = $1 AND agent_id = $2
          AND enabled = true AND is_default = true
          AND execution_host_id IS NOT NULL
        LIMIT 1`,
      [spaceId, agentId],
    );
    const binding = current.rows[0];
    if (!binding) return hostBackends;
    const preferredIndex = hostBackends.findIndex((backend) =>
      backend.hostId === binding.execution_host_id
      && backend.adapterType === binding.adapter_type
      && backend.installation === binding.runtime_installation);
    if (preferredIndex <= 0) return hostBackends;
    return [hostBackends[preferredIndex]!, ...hostBackends.filter((_, index) => index !== preferredIndex)];
  }

  /** One managed-workspace profile per paired-host backend; default only when nothing server-side exists. */
  private async ensureHostProfiles(
    agentId: string,
    spaceId: string,
    actorUserId: string,
    hostBackends: ManagedAssistantPreparation["hostBackends"],
    options: { makeFirstDefault: boolean },
  ): Promise<void> {
    for (const [index, backend] of hostBackends.entries()) {
      await this.agents.ensureRuntimeProfileInTransaction(this.client, spaceId, agentId, {
        name: `On ${backend.hostName} · ${backend.adapterType}`,
        adapterType: backend.adapterType,
        executionHostId: backend.hostId,
        workspaceMode: "managed",
        runtimeInstallation: backend.installation,
        runtimeConfigJson: { risk_level: "low", max_run_time_seconds: 120 },
        runtimePolicyJson: { default_adapter_type: backend.adapterType, allowed_adapter_types: [backend.adapterType] },
        isDefault: options.makeFirstDefault && index === 0 ? true : undefined,
        actorUserId,
      });
    }
  }

  private async ensureModelApiProfiles(
    agentId: string,
    spaceId: string,
    providers: ProviderRow[],
    initializeDefault: boolean,
  ): Promise<void> {
    const providerIds = providers.map((provider) => provider.id);
    await this.client.query(
      `UPDATE agent_runtime_profiles
          SET enabled = false,
              is_default = false,
              updated_at = now()
        WHERE space_id = $1
          AND agent_id = $2
          AND adapter_type = 'model_api'
          AND model_provider_id IS NOT NULL
          AND NOT (model_provider_id = ANY($3::varchar[]))`,
      [spaceId, agentId, providerIds],
    );
    for (const [index, provider] of providers.entries()) {
      await this.agents.ensureRuntimeProfileInTransaction(this.client, spaceId, agentId, {
        name: `Model API · ${provider.id}`,
        adapterType: "model_api",
        modelProviderId: provider.id,
        modelName: provider.default_model,
        runtimeConfigJson: { risk_level: "low", max_run_time_seconds: 120 },
        runtimePolicyJson: { default_adapter_type: "model_api", allowed_adapter_types: ["model_api"] },
        // The Space grant ordering is the source of truth only while the
        // Assistant is being created. Reconciliation leaves an existing
        // user's runtime default untouched.
        isDefault: initializeDefault && index === 0 ? true : undefined,
      });
    }
  }

  /**
   * Retires a CLI runtime profile that names no execution host.
   *
   * Such a profile ran a copy the *server* had installed. There are none, so
   * the profile can only fail at dispatch; disabling it lets the Assistant
   * fall through to a profile that can actually run.
   */
  private async disableUnavailableCliProfiles(spaceId: string, agentId: string): Promise<void> {
    await this.client.query(
      `UPDATE agent_runtime_profiles
          SET enabled = false, updated_at = now()
        WHERE space_id = $1
          AND agent_id = $2
          AND adapter_type = ANY($3::text[])
          AND execution_host_id IS NULL
          AND enabled = true`,
      [spaceId, agentId, [...MANAGED_ASSISTANT_CLI_ADAPTERS]],
    );
  }

  private async listEligibleProviderDefinitions(spaceId: string): Promise<ProviderRow[]> {
    return listChatProviderDefinitions(this.client, spaceId);
  }

  private async requireEligibleBackend(
    identity: { spaceId: string; userId: string },
    preparation: ManagedAssistantPreparation,
    providers: ProviderRow[],
  ): Promise<ProviderRow | null> {
    const provider = await this.client.query<{
      id: string;
      provider_type: string;
      provider_enabled: boolean | null;
      provider_grant_enabled: boolean | null;
      provider_owner_user_id: string | null;
      provider_credential_type: string | null;
      provider_has_eligible_credential: boolean | null;
    }>(
      `SELECT provider.id,
              provider.provider_type,
              provider.enabled AS provider_enabled,
              provider_grant.enabled AS provider_grant_enabled,
              provider.owner_user_id AS provider_owner_user_id,
              provider_credential.credential_type AS provider_credential_type,
              ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")}
                AS provider_has_eligible_credential
         FROM model_providers provider
         JOIN model_provider_space_grants provider_grant
           ON provider_grant.provider_id = provider.id
          AND provider_grant.space_id = $1
         LEFT JOIN credentials provider_credential
           ON provider_credential.id = provider.credential_id
        WHERE provider.enabled = true
          AND provider_grant.enabled = true
        `,
      [identity.spaceId],
    );
    const eligibleProviderIds = new Set(
      provider.rows
        .filter((row) => isProviderEligibleForUser(row, identity.userId))
        .map((row) => row.id),
    );
    const eligibleProvider = providers.find(({ id }) => eligibleProviderIds.has(id)) ?? null;
    if (eligibleProvider) return eligibleProvider;

    // An execution host with a logged-in CLI is the other eligible backend:
    // the Assistant provisions with a host-bound managed-workspace profile, so
    // a Space with no provider still gets a working Room instead of a refusal.
    if (preparation.hostBackends.length > 0) return null;
    throw new HttpError(409, "No eligible conversation backend is available for this user", {
      code: "conversation_backend_required",
      detail: "Configure an eligible Space API provider, or log a CLI in on an execution host, before creating a Room.",
      setup_targets: setupTargetsForMissingBackend(),
    });
  }

}

/**
 * Every online execution host this creator can dispatch to with a logged-in
 * CLI, one entry per (host, adapter), preferred adapters first.
 *
 * The instance's built-in host is included alongside the creator's own paired
 * machines: it has no owner and serves every Space (B63), and it is the only
 * backend a member who has paired nothing at all can reach.
 */
async function listHostBackends(
  db: Queryable,
  userId: string,
): Promise<ManagedAssistantPreparation["hostBackends"]> {
  const hosts = await db.query<{ id: string; name: string; capabilities_json: unknown; last_heartbeat_at: string | null; default_adapter_type: string | null }>(
    `SELECT id, name, capabilities_json, last_heartbeat_at, default_adapter_type
       FROM hosts
      WHERE (owner_user_id = $1 OR kind = 'server') AND status = 'online'
      ORDER BY name ASC, id ASC`,
    [userId],
  );
  const backends: ManagedAssistantPreparation["hostBackends"] = [];
  for (const host of hosts.rows) {
    if (isStale(host.last_heartbeat_at)) continue;
    const capabilities = normalizeHostCapabilities(host.capabilities_json);
    // The host's own configured default CLI leads; the built-in preference
    // ordering is only the tiebreak for hosts that never chose one.
    const adapterTypes = Object.keys(capabilities.installations).sort((a, b) =>
      Number(b === host.default_adapter_type) - Number(a === host.default_adapter_type) || rank(a) - rank(b));
    for (const adapterType of adapterTypes) {
      const installation = capabilities.installations[adapterType]?.find((copy) => copy.logged_in === true);
      if (!installation) continue;
      backends.push({ hostId: host.id, hostName: host.name, adapterType, installation: installation.id });
    }
  }
  return backends;
}

async function listChatProviderDefinitions(
  db: Queryable,
  spaceId: string,
): Promise<ProviderRow[]> {
  const result = await db.query<ProviderRow>(
    `SELECT provider.id, provider.name, provider.provider_type, provider.default_model
       FROM model_provider_space_grants grant_row
       JOIN model_providers provider ON provider.id = grant_row.provider_id
      WHERE grant_row.space_id = $1
        AND grant_row.enabled = true
        AND provider.enabled = true
      ORDER BY grant_row.is_default DESC,
               provider.updated_at DESC, provider.id ASC`,
    [spaceId],
  );
  return result.rows.filter((provider) => providerSupportsChat(provider.provider_type));
}

async function loadManagedAssistantSeed(config: ServerConfig): Promise<ManagedAssistantSeed> {
  const path = join(config.catalogRoot, "agent_templates", "personal_assistant", "template.yaml");
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new HttpError(500, "Managed Space Assistant seed is unavailable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const document = objectRecord(parsed);
  if (!document || document.key !== "personal_assistant" || document.visibility !== "system_internal") {
    throw new HttpError(500, "Managed Space Assistant seed is invalid");
  }
  return {
    name: stringField(document.name) ?? "Personal Assistant",
    description: stringField(document.description),
    modelConfigJson: objectRecord(document.model_config) ?? {},
    contextPolicyJson: objectRecord(document.context_policy) ?? {},
    memoryPolicyJson: objectRecord(document.memory_policy) ?? {},
    runtimePolicyJson: objectRecord(document.runtime_policy) ?? {},
    toolPolicyJson: objectRecord(document.tool_policy) ?? {},
    outputPolicyJson: objectRecord(document.output_policy) ?? {},
    scheduleConfigJson: objectRecord(document.schedule_defaults) ?? {},
    outputSchemaJson: objectRecord(document.output_schema) ?? {},
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
