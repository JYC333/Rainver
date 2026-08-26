import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { ServerConfig } from "../../config.js";
import type { Pool, PoolClient } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { CliCredentialBroker } from "../providers/cli/credentialBroker.js";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter, isVendorCliAdapter, listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";
import { RuntimeToolRegistry } from "../runtimeTools/service.js";
import { resolveRuntimeToolVersionForSpace } from "../runtimeTools/policies.js";
import { resolveAgentSystemPrompt } from "./promptRegistry.js";
import { promptProvenanceOf } from "../prompts/provenance.js";
import { providerSupportsChat } from "../providers/vendors.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
} from "../providers/eligibility.js";
import { PgAgentRepository, type AgentCreateInput } from "./repository.js";

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
Room delegation is bounded by the server and remains auditable.`;

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

type ManagedCliAdapter = { adapterType: string; version: string };

export interface ManagedAssistantPreparation {
  seed: ManagedAssistantSeed;
  cliAdapters: ManagedCliAdapter[];
  loggedInCliCredentials: Array<{ id: string; runtime: string }>;
}

/**
 * Return setup destinations that can actually change Room admission state.
 * A CLI credential is useful only when at least one supported CLI runtime can
 * be provisioned into the managed Assistant; otherwise linking to credential
 * management is a dead end and the caller should only advertise API setup.
 */
export function setupTargetsForMissingBackend(
  preparation: Pick<ManagedAssistantPreparation, "cliAdapters">,
): Array<"model_providers" | "cli_credentials"> {
  return [
    "model_providers",
    ...(preparation.cliAdapters.length > 0 ? ["cli_credentials" as const] : []),
  ];
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
    const [seed, cliAdapters, availableCredentials] = await Promise.all([
      loadManagedAssistantSeed(config),
      listProvisionableCliAdapters(pool, config, identity.spaceId),
      new CliCredentialBroker(config).availableProfiles(identity.spaceId, identity.userId),
    ]);
    const supportedRuntimes = new Set(cliAdapters.map(({ adapterType }) => adapterType));
    return {
      seed,
      cliAdapters,
      loggedInCliCredentials: availableCredentials
        .filter((profile) => profile.logged_in === true)
        .filter((profile) => typeof profile.id === "string" && typeof profile.runtime === "string")
        .filter((profile) => supportedRuntimes.has(profile.runtime as string))
        .map((profile) => ({ id: profile.id as string, runtime: profile.runtime as string })),
    };
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
      const assistant = await client.query<{ id: string }>(
        `SELECT id
           FROM agents
          WHERE space_id = $1
            AND agent_kind = 'system_assistant'
            AND status = 'active'
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
        [spaceId],
      );
      const agentId = assistant.rows[0]?.id;
      if (!agentId) return;
      const providers = await listChatProviderDefinitions(client, spaceId);
      const service = new SpaceAssistantService(client, pool);
      await service.ensureModelApiProfiles(agentId, spaceId, providers);
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
    const cliAdapters = await listProvisionableCliAdapters(pool, config, spaceId);
    await withTransaction(pool, async (client) => {
      const space = await client.query<{ id: string }>(
        "SELECT id FROM spaces WHERE id = $1 FOR UPDATE",
        [spaceId],
      );
      if (!space.rows[0]) return;
      const assistant = await client.query<{ id: string }>(
        `SELECT id
           FROM agents
          WHERE space_id = $1
            AND agent_kind = 'system_assistant'
            AND status = 'active'
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
        [spaceId],
      );
      const agentId = assistant.rows[0]?.id;
      if (!agentId) return;
      const service = new SpaceAssistantService(client, pool);
      await service.disableUnavailableCliProfiles(spaceId, agentId, cliAdapters);
      await service.ensureCliProfiles(agentId, spaceId, cliAdapters);
    });
  }

  /** Runtime-tool binaries are process-wide, so activation/install changes
   * can affect every Space that already has a managed Assistant. */
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

  async ensureForRoomCreator(
    identity: { spaceId: string; userId: string },
    preparation: ManagedAssistantPreparation,
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

    const { seed, cliAdapters } = preparation;
    const providers = await this.listEligibleProviderDefinitions(identity.spaceId);
    // Admission must be decided before creating the managed identity. A fresh
    // Space has no runtime profile to inspect yet, and creating a model_api
    // version without a provider would fail with a generic validation error
    // before the caller could receive actionable setup targets.
    const eligibleProvider = await this.requireEligibleBackend(identity, preparation, providers);
    const defaultProvider = eligibleProvider;
    const defaultCli = cliAdapters[0] ?? null;
    // Admission has already established that at least one eligible provider
    // or CLI credential exists, so the canonical adapter follows the
    // provisioned backend candidates instead of manufacturing a placeholder.
    const defaultAdapter = defaultProvider ? "model_api" : defaultCli?.adapterType ?? "model_api";
    const runtimeToolVersion = defaultAdapter === "model_api" ? null : defaultCli?.version ?? null;
    const runtimePolicyJson = {
      ...seed.runtimePolicyJson,
      allowed_adapter_types: ["model_api", ...MANAGED_ASSISTANT_CLI_ADAPTERS],
      default_adapter_type: defaultAdapter,
    };
    const runtimeConfigJson = {
      risk_level: seed.runtimePolicyJson.risk_level ?? "low",
      max_run_time_seconds: seed.runtimePolicyJson.max_run_time_seconds ?? 120,
      adapter_type: defaultAdapter,
      ...(runtimeToolVersion ? { runtime_tool_version: runtimeToolVersion } : {}),
    };
    const canonical = {
      systemPrompt: `${resolved.system.trim()}${ROOM_MANAGER_POLICY}`,
      promptProvenanceJson: {
        ...promptProvenanceOf(resolved.resolveResult),
        room_manager_policy_version: "room-manager-policy.v1",
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
    );
    const managedName = space.rows[0]?.type === "personal" ? seed.name : MANAGED_ASSISTANT_NAME;
    if (existing) {
      const reconciled = await this.agents.reconcileSystemManagedAgentInTransaction(this.client, {
        spaceId: identity.spaceId,
        agentId: existing.id,
        name: managedName,
        description: seed.description,
        ...canonical,
      });
      await this.agents.ensureSystemAssistantActorInTransaction(
        this.client,
        identity.spaceId,
        reconciled.id,
        reconciled.name,
      );
      await this.ensureRuntimeProfiles(reconciled.id, identity, providers, cliAdapters);
      await this.agents.ensureAssistantSettingsPointerInTransaction(this.client, identity.spaceId, reconciled.id);
      await this.requireEligibleBackend(identity, preparation, providers);
      return reconciled;
    }

    const input: AgentCreateInput = {
      spaceId: identity.spaceId,
      projectId: null,
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
      runtimeToolVersion,
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
    await this.ensureRuntimeProfiles(created.id, identity, providers, cliAdapters);
    await this.agents.ensureAssistantSettingsPointerInTransaction(this.client, identity.spaceId, created.id);
    await this.requireEligibleBackend(identity, preparation, providers);
    return this.agents.getSystemAssistantInTransaction(this.client, identity.spaceId)
      .then((assistant) => assistant ?? created);
  }

  private async ensureRuntimeProfiles(
    agentId: string,
    identity: { spaceId: string; userId: string },
    providers: ProviderRow[],
    cliAdapters: ManagedCliAdapter[],
  ): Promise<void> {
    await this.disableUnavailableCliProfiles(identity.spaceId, agentId, cliAdapters);
    await this.ensureModelApiProfiles(agentId, identity.spaceId, providers);
    await this.ensureCliProfiles(agentId, identity.spaceId, cliAdapters);
  }

  private async ensureModelApiProfiles(
    agentId: string,
    spaceId: string,
    providers: ProviderRow[],
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
        // The Space grant ordering is the source of truth for the managed
        // assistant's initial backend. The repository clears any previous
        // runtime default when this first profile is reconciled.
        isDefault: index === 0,
      });
    }
  }

  private async ensureCliProfiles(
    agentId: string,
    spaceId: string,
    cliAdapters: ManagedCliAdapter[],
  ): Promise<void> {
    for (const { adapterType, version } of cliAdapters) {
      const spec = getRuntimeAdapterSpec(adapterType);
      if (!spec || !isLocalCliRuntimeAdapter(adapterType) || spec.implementation_status !== "implemented") continue;
      await this.agents.ensureRuntimeProfileInTransaction(this.client, spaceId, agentId, {
        name: spec.display_name,
        adapterType,
        runtimeConfigJson: { risk_level: "low", max_run_time_seconds: 120, runtime_tool_version: version },
        runtimePolicyJson: { default_adapter_type: adapterType, allowed_adapter_types: [adapterType] },
        isDefault: false,
        runtimeToolVersion: version,
      });
    }
  }

  private async disableUnavailableCliProfiles(
    spaceId: string,
    agentId: string,
    available: Array<{ adapterType: string; version: string }>,
  ): Promise<void> {
    const enabledAdapters = [...new Set(available.map(({ adapterType }) => adapterType))];
    await this.client.query(
      `UPDATE agent_runtime_profiles
          SET enabled = false, updated_at = now()
        WHERE space_id = $1
          AND agent_id = $2
          AND adapter_type = ANY($3::text[])
          AND NOT (adapter_type = ANY($4::text[]))`,
      [spaceId, agentId, [...MANAGED_ASSISTANT_CLI_ADAPTERS], enabledAdapters],
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

    const credentialIds = preparation.loggedInCliCredentials.map(({ id }) => id);
    const cli = preparation.cliAdapters.map(({ adapterType }) => adapterType);
    if (credentialIds.length > 0 && cli.length > 0) {
      const credential = await this.client.query<{ one: number }>(
        `SELECT 1 AS one
           FROM cli_credential_space_grants credential_grant
           JOIN cli_credential_profiles credential_profile
             ON credential_profile.id = credential_grant.profile_id
            AND credential_profile.owner_user_id = credential_grant.owner_user_id
            AND credential_profile.runtime = ANY($2::text[])
          WHERE credential_grant.space_id = $1
            AND credential_grant.enabled = true
            AND credential_grant.owner_user_id = $3
            AND credential_profile.id = ANY($4::varchar[])
          LIMIT 1`,
        [identity.spaceId, cli, identity.userId, credentialIds],
      );
      if (credential.rows[0]) return null;
    }
    throw new HttpError(409, "No eligible conversation backend is available for this user", {
      code: "conversation_backend_required",
      detail: "Configure an eligible Space API provider or grant a logged-in CLI credential before creating a Room.",
      setup_targets: setupTargetsForMissingBackend(preparation),
    });
  }
}

async function listProvisionableCliAdapters(
  db: Queryable,
  config: ServerConfig,
  spaceId: string,
): Promise<ManagedCliAdapter[]> {
  const rows: ManagedCliAdapter[] = [];
  for (const adapterType of MANAGED_ASSISTANT_CLI_ADAPTERS) {
    try {
      const version = await resolveRuntimeToolVersionForSpace(
        db,
        new RuntimeToolRegistry(config),
        spaceId,
        adapterType,
      );
      rows.push({ adapterType, version });
    } catch {
      // Missing/disabled/uninstalled CLIs are simply unavailable candidates;
      // the post-provisioning backend gate decides whether setup is required.
    }
  }
  return rows;
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
