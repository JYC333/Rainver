import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, optionalString } from "../routeUtils/common.js";
import { PgAgentRepository } from "../agents/repository.js";
import { providerSupportsStructuredOutput } from "../providers/structuredOutputCapabilities.js";

const RESEARCH_AGENT_KIND = "system_research";
const RESEARCH_AGENT_NAME = "Auto Research";
const RESEARCH_RUNTIME_KEY = "opencode" as const;
export interface ResearchExecutionSelection {
  modelProviderId?: string | null;
  modelName?: string | null;
}

interface ResolvedResearchExecution {
  agentId: string;
  runtimeProfileId: string;
  runtimeKey: typeof RESEARCH_RUNTIME_KEY;
  modelProviderId: string;
  modelName: string | null;
}

/** What a bounded ProviderTask stage needs: a provider and a model, and no
 * Agent or Runtime Profile at all. */
interface ResolvedResearchProvider {
  modelProviderId: string;
  modelName: string | null;
}

/**
 * Project Research owns a managed execution profile. Users choose the model
 * provider and optional model; they do not choose a runtime implementation or
 * a CLI credential profile for this workflow.
 */
export class ProjectResearchExecutionProfileService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async resolve(
    identity: SpaceUserIdentity,
    selection: ResearchExecutionSelection,
  ): Promise<ResolvedResearchExecution> {
    const provider = await this.resolveProvider(identity, selection);
    const managedAgent = await this.ensureManagedAgent(identity, provider.modelProviderId, provider.modelName);
    return this.ensureProfile(identity, managedAgent.id, provider.modelProviderId, provider.modelName);
  }

  /**
   * Provider/model selection for a bounded ProviderTask stage. It performs the
   * same space-grant and structured-output checks as `resolve`, but creates no
   * managed Agent and no Runtime Profile: a `provider_task` Run carries neither
   * (ADR 0022 §3).
   */
  async resolveProvider(
    identity: SpaceUserIdentity,
    selection: ResearchExecutionSelection,
  ): Promise<ResolvedResearchProvider> {
    const provider = selection.modelProviderId
      ? await this.getProvider(identity.spaceId, selection.modelProviderId)
      : await this.getDefaultProvider(identity.spaceId);
    if (!provider) {
      throw new HttpError(422, "Select a model provider or configure a space default provider for Auto Research");
    }
    if (!providerSupportsStructuredOutput(provider.provider_type)) {
      throw new HttpError(422, `Model provider type '${provider.provider_type}' does not support Auto Research structured output`);
    }
    return {
      modelProviderId: provider.id,
      modelName: optionalString(selection.modelName)
        ?? provider.default_model
        ?? firstModel(provider.capabilities_json),
    };
  }

  private async ensureManagedAgent(
    identity: SpaceUserIdentity,
    modelProviderId: string,
    modelName: string | null,
  ): Promise<{ id: string }> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM agents
        WHERE space_id=$1 AND agent_kind=$2 AND status='active'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [identity.spaceId, RESEARCH_AGENT_KIND],
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }

    try {
      const agent = await PgAgentRepository.fromConfig(this.config).create({
        spaceId: identity.spaceId,
        userId: identity.userId,
        ownerUserId: null,
        name: RESEARCH_AGENT_NAME,
        description: "System-managed execution agent for Project Research workflows.",
        visibility: "space_shared",
        roleInstruction: "Execute bounded Project Research stages and preserve source/evidence references.",
        systemPrompt: "You are the Project Research execution agent. Work only on the supplied research corpus and preserve source and evidence references in every research output.",
        agentKind: RESEARCH_AGENT_KIND,
        capabilitiesJson: [],
        outputSchemaJson: {
          required_artifact_schemas: [
            "research_report.archive.v1",
          ],
        },
      });
      return { id: agent.id };
    } catch (error) {
      const raced = await this.db.query<{ id: string }>(
        `SELECT id FROM agents
          WHERE space_id=$1 AND agent_kind=$2 AND status='active'
          ORDER BY created_at ASC, id ASC LIMIT 1`,
        [identity.spaceId, RESEARCH_AGENT_KIND],
      );
      if (raced.rows[0]) return raced.rows[0];
      throw error;
    }
  }

  private async ensureProfile(
    identity: SpaceUserIdentity,
    agentId: string,
    modelProviderId: string,
    modelName: string | null,
  ): Promise<ResolvedResearchExecution> {
    const profiles = await this.db.query<{
      id: string;
      model_provider_id: string | null;
      model_name: string | null;
    }>(
      `SELECT id, model_provider_id, model_name
        FROM agent_runtime_profiles
        WHERE space_id=$1 AND agent_id=$2 AND runtime_key=$3
          AND backend_mode='model_provider'
          AND model_provider_id=$4 AND enabled=true
        ORDER BY is_default DESC, created_at ASC, id ASC`,
      [identity.spaceId, agentId, RESEARCH_RUNTIME_KEY, modelProviderId],
    );
    const exact = profiles.rows.find((profile) => profile.model_name === modelName);
    if (exact) {
      return {
        agentId,
        runtimeProfileId: exact.id,
        runtimeKey: RESEARCH_RUNTIME_KEY,
        modelProviderId,
        modelName,
      };
    }

    const binding = await this.db.query<{
      execution_host_id: string | null;
      workspace_mode: "location" | "managed" | null;
      runtime_installation: string | null;
      runtime_config_json: unknown;
    }>(
      `SELECT execution_host_id, workspace_mode, runtime_installation, runtime_config_json
         FROM agent_runtime_profiles
        WHERE space_id=$1 AND agent_id=$2 AND runtime_key=$3
          AND enabled=true AND is_default=true
        LIMIT 1`,
      [identity.spaceId, agentId, RESEARCH_RUNTIME_KEY],
    );
    const defaultProfile = binding.rows[0];
    if (
      !defaultProfile?.execution_host_id
      || defaultProfile.workspace_mode !== "managed"
      || !defaultProfile.runtime_installation
    ) {
      throw new HttpError(409, "The managed Research Agent has no Server Runtime Profile binding");
    }
    const runtimeConfig = defaultProfile.runtime_config_json
      && typeof defaultProfile.runtime_config_json === "object"
      && !Array.isArray(defaultProfile.runtime_config_json)
      ? defaultProfile.runtime_config_json as Record<string, unknown>
      : {};
    const created = await PgAgentRepository.fromConfig(this.config).createRuntimeProfile(
      identity.spaceId,
      agentId,
      {
        name: "Research · OpenCode",
        runtimeKey: RESEARCH_RUNTIME_KEY,
        backendMode: "model_provider",
        modelProviderId,
        modelName,
        executionHostId: defaultProfile.execution_host_id,
        workspaceMode: defaultProfile.workspace_mode,
        runtimeInstallation: defaultProfile.runtime_installation,
        runtimeConfigJson: { ...runtimeConfig, purpose: "project_research" },
        actorUserId: identity.userId,
        allowPendingServerInstallation: defaultProfile.runtime_installation === "managed:pending",
        isDefault: false,
      },
    );
    return {
      agentId,
      runtimeProfileId: created.id,
      runtimeKey: RESEARCH_RUNTIME_KEY,
      modelProviderId,
      modelName,
    };
  }

  private async getProvider(spaceId: string, providerId: string): Promise<ProviderRow | null> {
    const result = await this.db.query<ProviderRow>(
      `SELECT p.id, p.provider_type, p.default_model, p.capabilities_json
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id=g.provider_id
        WHERE g.space_id=$1 AND g.provider_id=$2 AND g.enabled=true AND p.enabled=true LIMIT 1`,
      [spaceId, providerId],
    );
    if (!result.rows[0]) throw new HttpError(422, "Model provider is not selectable in this space");
    return result.rows[0];
  }

  private async getDefaultProvider(spaceId: string): Promise<ProviderRow | null> {
    const result = await this.db.query<ProviderRow>(
      `SELECT p.id, p.provider_type, p.default_model, p.capabilities_json
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id=g.provider_id
        WHERE g.space_id=$1 AND g.enabled=true AND p.enabled=true
        ORDER BY g.is_default DESC, p.updated_at DESC, p.id ASC
        LIMIT 1`,
      [spaceId],
    );
    return result.rows[0] ?? null;
  }
}

interface ProviderRow {
  id: string;
  provider_type: string;
  default_model: string | null;
  capabilities_json: unknown;
}

function firstModel(value: unknown): string | null {
  const models = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as Record<string, unknown>).models ?? (value as Record<string, unknown>).available_models
      : null;
  if (!Array.isArray(models)) return null;
  return models.find((model): model is string => typeof model === "string" && model.trim().length > 0) ?? null;
}
